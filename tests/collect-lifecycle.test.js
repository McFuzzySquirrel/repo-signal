import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  LifecycleContractError, confirmRepository, findRepositoryByName, isUnavailable, markUnavailable,
  recordIdentity, splitRepository, unavailableReason,
} from '../src/collect/lifecycle.js';
import { planCollect } from '../src/collect/run.js';
import { validateConfig } from '../src/config/schema.js';
import { upsertDayFact } from '../src/db/day-series-repo.js';
import { getRepository, openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { GitHubTransportError } from '../src/github/http.js';
import { GitHubRequestError } from '../src/github/retry.js';
import { resolveHomePaths } from '../src/paths.js';
import {
  assertNoCredentialMaterial, createCollectHome, outputLines as lines, plainRows as plain, rowCount as rows,
} from './helpers/collect-home.js';

// Lifecycle is exercised at two levels: the module itself against an open archive
// with an injected repository client, and the whole command through
// `node src/cli.js collect` against the local GitHub stub over a temporary home.
// No test reaches api.github.com and no test uses a real token.

const first = '2026-10-01T00:00:00.000Z';
const second = '2026-10-02T00:00:00.000Z';
const REPO_ID = 7;

/**
 * An archive holding one enrolled repository under a deliberately non-sequential
 * identity, with a day of collected history already stored under it, so a test can
 * prove that a rename or a transfer keeps both.
 * @param {import('node:test').TestContext} t
 * @param {{ owner?: string, name?: string, lifecycle?: 'active'|'unavailable', unavailableReason?: string|null }} [stored]
 * @returns {Promise<import('node:sqlite').DatabaseSync>}
 */
async function archiveWith(t, stored = {}) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-collect-lifecycle-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, {
    id: REPO_ID,
    owner: stored.owner ?? 'owner',
    name: stored.name ?? 'alpha',
    lastSeenAt: first,
    enrolled: 1,
    ...(stored.lifecycle === undefined ? {} : { lifecycle: stored.lifecycle }),
    unavailableReason: stored.unavailableReason ?? null,
  });
  withTransaction(db, () => {
    for (const metric of ['clones', 'views']) {
      upsertDayFact(db, {
        repositoryId: REPO_ID, metric, granularity: 'day', day: '2026-09-30', value: metric === 'clones' ? 4 : 30,
        source: 'collected', collectedAt: first,
      });
    }
  });
  return db;
}

/**
 * A repository client that answers with a scripted payload, so the comparison and
 * the alias it records can be asserted without a socket. The payload is passed
 * through untyped on purpose: a test has to be able to hand this step a payload
 * GitHub would never send.
 * @param {unknown} record
 * @returns {{ repository: (repo: string) => Promise<import('../src/github/repo-client.js').RepositoryRecord>, asked: string[] }}
 */
function fakeRepoClient(record) {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    repository: async (repo) => {
      asked.push(repo);
      return /** @type {import('../src/github/repo-client.js').RepositoryRecord} */ (record);
    },
  };
}

/**
 * The record GitHub serves for a repository, as the repository client returns it.
 * @param {string} owner
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function remoteRecord(owner, name) {
  return {
    id: 4242, name, full_name: `${owner}/${name}`, owner: { login: owner, type: 'User' },
    stargazers_count: 3, forks_count: 1, watchers_count: 3,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<Record<string, unknown>>}
 */
function aliasRows(db) {
  return plain(db.prepare(`SELECT repository_id AS repositoryId, owner, name, recorded_at AS recordedAt
    FROM repository_aliases ORDER BY owner, name`).all());
}

/**
 * The stored day facts of the fixture repository, which every lifecycle change
 * must leave untouched.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
function storedDays(db) {
  return rows(db, 'day_series', `WHERE repository_id=${REPO_ID}`);
}

test('a renamed repository keeps its identity, gains an alias row and is collected under the new name', async (t) => {
  const db = await archiveWith(t);
  const client = fakeRepoClient(remoteRecord('owner', 'alpha-next'));

  const remote = await confirmRepository({ repo: 'owner/alpha', repoClient: client });
  assert.deepEqual(client.asked, ['owner/alpha'], 'the repository is resolved before anything is written');
  assert.equal(remote.repo, 'owner/alpha-next');

  const change = withTransaction(db, () =>
    recordIdentity({ db, repositoryId: REPO_ID, remote, collectedAt: second }));

  assert.deepEqual(change, {
    renamed: true, transferred: false, previousOwner: 'owner', previousName: 'alpha',
    owner: 'owner', name: 'alpha-next', repo: 'owner/alpha-next', aliasRecorded: true,
  });
  const stored = getRepository(db, REPO_ID);
  assert.equal(stored.id, REPO_ID, 'the stored identity is the one the archive already gave it');
  assert.equal(stored.owner, 'owner');
  assert.equal(stored.name, 'alpha-next', 'the canonical name is what GitHub serves now');
  assert.equal(stored.lifecycle, 'active');
  assert.equal(stored.enrolled, 1);
  assert.equal(stored.lastSeenAt, second);
  assert.deepEqual(aliasRows(db), [
    { repositoryId: REPO_ID, owner: 'owner', name: 'alpha', recordedAt: second },
  ]);
  assert.equal(storedDays(db), 2, 'the history stored under the identity survives the rename');

  // The configuration still names the repository the way it was written before the
  // rename, so the next run has to find this history through the alias.
  assert.equal(findRepositoryByName(db, 'owner/alpha')?.id, REPO_ID);
  assert.equal(findRepositoryByName(db, 'owner/Alpha')?.id, REPO_ID);
  assert.equal(findRepositoryByName(db, 'owner/alpha-next')?.id, REPO_ID);
  assert.equal(findRepositoryByName(db, 'owner/beta'), null);

  // A second run that sees the same name changes nothing and appends no second alias.
  const repeat = withTransaction(db, () =>
    recordIdentity({ db, repositoryId: REPO_ID, remote, collectedAt: '2026-10-03T00:00:00.000Z' }));
  assert.equal(repeat.aliasRecorded, false);
  assert.deepEqual(aliasRows(db), [
    { repositoryId: REPO_ID, owner: 'owner', name: 'alpha', recordedAt: second },
  ], 'a repeated rename never rewrites the time the alias was first recorded');
});

test('a transferred repository updates its owner while keeping its identity and history', async (t) => {
  const db = await archiveWith(t);
  const remote = await confirmRepository({ repo: 'owner/alpha', repoClient: fakeRepoClient(remoteRecord('newowner', 'alpha')) });

  const change = withTransaction(db, () => recordIdentity({ db, repositoryId: REPO_ID, remote, collectedAt: second }));

  assert.equal(change.renamed, false);
  assert.equal(change.transferred, true);
  const stored = getRepository(db, REPO_ID);
  assert.equal(stored.id, REPO_ID);
  assert.equal(stored.owner, 'newowner', 'the owner follows the transfer');
  assert.equal(stored.name, 'alpha');
  assert.deepEqual(aliasRows(db), [
    { repositoryId: REPO_ID, owner: 'owner', name: 'alpha', recordedAt: second },
  ]);
  assert.equal(storedDays(db), 2, 'the history stored under the identity survives the transfer');

  // A transfer that also renames records both names and moves both fields.
  const moved = await confirmRepository({ repo: 'newowner/alpha', repoClient: fakeRepoClient(remoteRecord('newowner', 'renamed')) });
  const secondChange = withTransaction(db, () => recordIdentity({ db, repositoryId: REPO_ID, remote: moved, collectedAt: second }));
  assert.equal(secondChange.renamed, true);
  assert.equal(secondChange.transferred, false);
  const after = getRepository(db, REPO_ID);
  assert.equal(`${after.owner}/${after.name}`, 'newowner/renamed');
  assert.deepEqual(aliasRows(db), [
    { repositoryId: REPO_ID, owner: 'newowner', name: 'alpha', recordedAt: second },
    { repositoryId: REPO_ID, owner: 'owner', name: 'alpha', recordedAt: second },
  ], 'every name the repository answered to stays readable');
  assert.equal(storedDays(db), 2);
});

test('a repository GitHub respells is not renamed, and a partial payload is refused', async (t) => {
  const db = await archiveWith(t);
  const respelled = await confirmRepository({ repo: 'owner/alpha', repoClient: fakeRepoClient(remoteRecord('owner', 'Alpha')) });

  const change = withTransaction(db, () => recordIdentity({ db, repositoryId: REPO_ID, remote: respelled, collectedAt: second }));

  assert.equal(change.renamed, false);
  assert.equal(change.aliasRecorded, false, 'a difference in case is not a rename');
  assert.equal(getRepository(db, REPO_ID).name, 'Alpha', 'the archive keeps GitHub\'s own spelling');
  assert.deepEqual(aliasRows(db), []);

  for (const payload of [{ name: 'alpha' }, { owner: {}, name: 'alpha' }, { owner: { login: ' ' }, name: 'alpha' },
    { owner: { login: 'owner' } }, [], 'not-a-record']) {
    await assert.rejects(
      confirmRepository({ repo: 'owner/alpha', repoClient: fakeRepoClient(payload) }),
      LifecycleContractError,
      `a payload without a complete identity is refused: ${JSON.stringify(payload)}`,
    );
  }
  // No identity was invented from any of those payloads.
  assert.equal(getRepository(db, REPO_ID).name, 'Alpha');
  assert.deepEqual(aliasRows(db), []);
});

test('a not-found response marks the repository unavailable with the reason, and later plans exclude it', async (t) => {
  const db = await archiveWith(t);
  const repo = 'owner/alpha';
  // The failure the transport policy types for a 404, as the run receives it.
  const notFound = new GitHubRequestError('repository-missing', 404, '/repos/owner/alpha',
    'Check the repository name, whether it still exists, and token access', 1);
  const reason = unavailableReason(notFound, repo);
  assert.equal(reason, 'GitHub answered HTTP 404 for owner/alpha: ' +
    'Check the repository name, whether it still exists, and token access');

  withTransaction(db, () => markUnavailable({ db, repositoryId: REPO_ID, reason, collectedAt: second }));

  const stored = getRepository(db, REPO_ID);
  assert.equal(stored.lifecycle, 'unavailable');
  assert.equal(stored.unavailableReason, reason);
  assert.equal(stored.enrolled, 1, 'the row stays enrolled: it is unavailable, not unenrolled');
  assert.equal(storedDays(db), 2, 'marking a repository unavailable deletes none of its history');
  assert.ok(isUnavailable(stored));
  assert.equal(findRepositoryByName(db, repo)?.id, REPO_ID, 'the identity is still reachable by its name');

  // A later run plans no request for it, and the reason travels with the plan.
  const config = validateConfig({ enrolled: ['owner/alpha'] });
  const [planned] = planCollect({ db, config });
  assert.equal(planned.repo, repo);
  assert.equal(planned.repositoryId, REPO_ID);
  assert.equal(planned.skipped, true);
  assert.equal(planned.requests, 0);
  assert.equal(planned.exactRequests, true);
  assert.equal(planned.backfill, false);
  assert.equal(planned.unavailableReason, reason);

  // Marking it again keeps the reason it was first given rather than replacing it.
  withTransaction(db, () => markUnavailable({ db, repositoryId: REPO_ID, reason: 'something else entirely', collectedAt: second }));
  assert.equal(getRepository(db, REPO_ID).unavailableReason, reason);
  assert.throws(
    () => markUnavailable({ db, repositoryId: REPO_ID, reason: '   ', collectedAt: second }),
    /needs a reason/,
  );
  // The row is never renumbered, and a rename of an unavailable repository is not
  // something this step performs: the identity is already decided.
  assert.throws(() => db.exec('DELETE FROM repositories'), /cannot be deleted/);
  assert.throws(() => db.exec(`UPDATE repositories SET id=99`), /FOREIGN KEY constraint/);
});

test('only a repository GitHub no longer serves is treated as unavailable', () => {
  const repo = 'owner/alpha';
  const typed = (/** @type {import('../src/github/retry.js').ErrorKind} */ kind, /** @type {number} */ status) =>
    new GitHubRequestError(kind, status, '/repos/owner/alpha', 'do the thing', 1);

  assert.equal(unavailableReason(typed('repository-missing', 404), repo)?.includes('HTTP 404'), true);
  // A rejected token, a missing permission, a rate limit and a transport failure
  // say nothing about whether the repository exists.
  /** @type {Array<[import('../src/github/retry.js').ErrorKind, number]>} */
  const otherFailures = [
    ['authentication-rejected', 401],
    ['permission-missing', 403],
    ['rate-limited', 429],
    ['transient', 502],
    ['unexpected', 500],
  ];
  for (const [kind, status] of otherFailures) {
    assert.equal(unavailableReason(typed(kind, status), repo), null, `${kind} is not a disappearance`);
  }
  assert.equal(unavailableReason(new GitHubTransportError('ERR_TRANSPORT_TIMEOUT', 'timed out', '/repos/owner/alpha', null), repo), null);
  assert.equal(unavailableReason(new Error('plain failure'), repo), null);
  assert.equal(unavailableReason(undefined, repo), null);
  // A reason always names the status, the repository and the action, and never an
  // exception message: a message could carry anything the thrown error held.
  assert.equal(String(unavailableReason(typed('repository-missing', 404), repo)),
    'GitHub answered HTTP 404 for owner/alpha: do the thing');
  assert.match(String(unavailableReason(typed('repository-missing', 404), repo)),
    /^GitHub answered HTTP 404 for owner\/alpha: .+/);
  // An error with no status still yields a reason, but one that reports no status
  // it does not actually carry, and it still names a next step.
  const bare = /** @type {{kind: string}} */ ({ kind: 'repository-missing' });
  assert.equal(String(unavailableReason(bare, repo)),
    'GitHub answered no such repository for owner/alpha: ' +
    'Check whether the repository still exists and whether the token can still see it');
  const silent = /** @type {{action: string}} */ ({ action: '' });
  assert.equal(unavailableReason(silent, repo), null, 'no typed status is not evidence of a disappearance');
});

test('the identity pair is validated the way the GitHub clients validate it', () => {
  assert.deepEqual(splitRepository('owner/alpha'), ['owner', 'alpha']);
  for (const invalid of ['', 'alpha', 'owner/', '/alpha', 'a/b/c', 'owner/..', 'owner/ ', 42, null]) {
    assert.throws(() => splitRepository(/** @type {string} */ (invalid)), TypeError, `${JSON.stringify(invalid)} is not a pair`);
  }
});

test('a run mixing a healthy and a vanished repository collects the healthy one and reports the marking', async (t) => {
  const f = await createCollectHome(t, { enrolled: ['owner/alpha', 'owner/beta'] });
  scriptRepository(f.stub, { moved: { 'owner/alpha': { owner: 'owner', name: 'alpha-next' } } });
  scriptCollection(f.stub);
  // A first run so both repositories own some history before the disappearance.
  assert.equal((await f.run(['collect'])).status, 0);
  const before = f.archive((db) => ({
    days: rows(db, 'day_series', 'WHERE repository_id=2'),
    snapshots: rows(db, 'snapshots', 'WHERE repository_id=2'),
  }));
  assert.ok(before.days > 0, 'the vanished repository owned history before it vanished');
  assert.ok(before.snapshots > 0);
  f.stub.reset();

  scriptRepository(f.stub, { moved: { 'owner/alpha': { owner: 'owner', name: 'alpha-next' } }, vanished: ['owner/beta'] });
  const result = await f.run(['collect']);

  assert.equal(result.status, 1, 'a run that marked a repository unavailable exits 1');
  assertNoCredentialMaterial(result, 'mixed run');
  const printed = lines(result.stdout);
  assert.equal(printed.length, 3, 'one line per repository and one summary');
  assert.match(printed[0], new RegExp('^owner/alpha ok 14 days written 0 revised \\d+ unchanged \\d+ snapshots 2 ' +
    'backfill skipped renamed owner/alpha -> owner/alpha-next$'));
  assert.match(printed[1], /^owner\/beta unavailable GitHub answered HTTP 404 for owner\/beta: /);
  assert.match(printed[1], /Check the repository name, whether it still exists, and token access$/);
  assert.match(printed[2], /repositories=2 ok=1 failed=0 unavailable=1 skipped=0 .*status=degraded$/);

  f.archive((db) => {
    // The healthy repository kept its identity, gained the alias and moved its name.
    assert.deepEqual(plain(db.prepare(`SELECT id, owner, name, lifecycle, enrolled FROM repositories
        WHERE name='alpha-next'`).all()), [
      { id: 1, owner: 'owner', name: 'alpha-next', lifecycle: 'active', enrolled: 1 },
    ]);
    const aliases = aliasRows(db);
    assert.deepEqual(aliases.map((row) => [row.repositoryId, row.owner, row.name]), [[1, 'owner', 'alpha']]);
    assert.match(String(aliases[0].recordedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The vanished repository is marked, keeps its identity and keeps its history.
    assert.deepEqual(plain(db.prepare(`SELECT id, owner, name, lifecycle, unavailable_reason AS reason, enrolled
        FROM repositories WHERE id=2`).all()), [
      {
        id: 2, owner: 'owner', name: 'beta', lifecycle: 'unavailable', enrolled: 1,
        reason: 'GitHub answered HTTP 404 for owner/beta: ' +
          'Check the repository name, whether it still exists, and token access',
      },
    ]);
    assert.equal(rows(db, 'day_series', 'WHERE repository_id=2'), before.days,
      'marking a repository unavailable deletes none of its history');
    assert.equal(rows(db, 'day_series', "WHERE repository_id=1 AND source='collected'"), 56);
    assert.equal(rows(db, 'snapshots', 'WHERE repository_id=2'), before.snapshots,
      'a repository that vanished wrote no capture in the run that marked it');
    // The run closed over both repositories, one collected and one marked.
    const run = /** @type {Record<string, unknown>} */ (db.prepare(
      `SELECT closed_at AS closedAt, status, success_count AS successCount, failure_count AS failureCount
        FROM runs ORDER BY id DESC LIMIT 1`).get());
    assert.notEqual(run.closedAt, null);
    assert.equal(run.status, 'degraded');
    assert.equal(run.successCount, 1);
    assert.equal(run.failureCount, 1);
  });

  // Nothing was requested for the vanished repository beyond the one resolution.
  assert.deepEqual(f.stub.paths().filter((observed) => observed.startsWith('/repos/owner/beta')), [
    '/repos/owner/beta',
  ]);
});

test('a later run skips the vanished repository without asking about it again', async (t) => {
  const f = await createCollectHome(t, { enrolled: ['owner/alpha', 'owner/beta'] });
  scriptRepository(f.stub, { vanished: ['owner/beta'] });
  scriptCollection(f.stub);

  const marked = await f.run(['collect']);
  assert.equal(marked.status, 1);
  f.stub.reset();

  const planned = await f.run(['collect', '--dry-run']);
  assert.equal(planned.status, 0, planned.stderr);
  assertNoCredentialMaterial(planned, 'dry run with an unavailable repository');
  assert.deepEqual(lines(planned.stdout), [
    'owner/alpha planned backfill=skipped requests=5',
    'owner/beta skipped lifecycle=unavailable requests=0 GitHub answered HTTP 404 for owner/beta: ' +
      'Check the repository name, whether it still exists, and token access',
    'summary mode=dry-run run=none planned=2 backfill=0 requests=0 duration_ms=0 status=planned',
  ]);
  assert.equal(f.stub.requests().length, 0, 'a dry run contacts nothing, not even to re-confirm the marking');
  f.archive((db) => {
    assert.equal(rows(db, 'runs'), 1, 'a dry run wrote no second run row');
  });

  const later = await f.run(['collect']);
  assert.equal(later.status, 0, 'a repository already marked unavailable does not degrade every later run');
  assertNoCredentialMaterial(later, 'run after the marking');
  const printed = lines(later.stdout);
  assert.equal(printed.length, 3);
  assert.match(printed[0], /^owner\/alpha ok 14 days /);
  assert.match(printed[1], /^owner\/beta skipped lifecycle=unavailable GitHub answered HTTP 404 /);
  assert.match(printed[2], /repositories=2 ok=1 failed=0 unavailable=0 skipped=1 .*requests=5 .*status=completed$/);
  assert.ok(!f.stub.paths().some((observed) => observed.startsWith('/repos/owner/beta')),
    `the unavailable repository is never requested again, got ${f.stub.paths().join(', ')}`);
  f.archive((db) => {
    assert.equal(rows(db, 'runs'), 2);
    assert.equal(rows(db, 'day_series', 'WHERE repository_id=2'), 0,
      'a repository that vanished before it was ever collected stores nothing');
    assert.equal(rows(db, 'repositories'), 2, 'both rows survive: neither was ever deleted');
  });
});

test('a renamed repository is found again on the next run and collected under its new name', async (t) => {
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptRepository(f.stub);
  scriptCollection(f.stub);
  assert.equal((await f.run(['collect'])).status, 0);
  const daysBefore = f.archive((db) => rows(db, 'day_series'));

  // GitHub renamed it, and the configuration still names it the way it was written.
  scriptRepository(f.stub, { moved: { 'owner/alpha': { owner: 'owner', name: 'alpha-next' } } });
  scriptCollection(f.stub);
  f.stub.reset();
  const renamed = await f.run(['collect']);

  assert.equal(renamed.status, 0, renamed.stderr);
  assertNoCredentialMaterial(renamed, 'run after a rename');
  assert.match(lines(renamed.stdout)[0], /^owner\/alpha ok 14 days .* backfill skipped renamed owner\/alpha -> owner\/alpha-next$/);
  // The configuration still names the repository the way it was written, so that
  // is the pair resolved; every read that follows uses the name GitHub serves.
  assert.deepEqual(f.stub.paths(), [
    '/repos/owner/alpha',
    '/repos/owner/alpha-next/traffic/clones',
    '/repos/owner/alpha-next/traffic/views',
    '/repos/owner/alpha-next/traffic/popular/referrers',
    '/repos/owner/alpha-next/traffic/popular/paths',
  ]);

  f.archive((db) => {
    assert.equal(rows(db, 'repositories'), 1, 'a renamed repository never gains a second identity');
    assert.equal(rows(db, 'day_series'), daysBefore, 'the same days are revised in place under the same identity');
    assert.deepEqual(aliasRows(db).map((row) => [row.repositoryId, row.owner, row.name]),
      [[1, 'owner', 'alpha']]);
    assert.equal(rows(db, 'repositories', "WHERE lifecycle='active'"), 1);
  });
});

/**
 * Script the first-connect backfill and the traffic endpoints. Repository identity
 * is scripted separately by `scriptRepository`, because it is what changes when a
 * repository is renamed, transferred or disappears.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 */
function scriptCollection(stub) {
  const days = Array.from({ length: 14 }, (unused, index) => {
    const day = new Date(Date.parse('2026-09-19T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10);
    return { day, count: index, uniques: 1, views: index + 30 };
  });
  const total = (/** @type {'count'|'uniques'|'views'} */ which) => days.reduce((sum, day) => sum + day[which], 0);
  stub.route('GET /repos/:owner/:name/traffic/clones', () => ({
    json: {
      count: total('count'), uniques: total('uniques'),
      clones: days.map((day) => ({ timestamp: `${day.day}T00:00:00Z`, count: day.count, uniques: day.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/views', () => ({
    json: {
      count: total('views'), uniques: total('uniques'),
      views: days.map((day) => ({ timestamp: `${day.day}T00:00:00Z`, count: day.views, uniques: day.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/popular/referrers', () => ({
    json: [{ referrer: 'example.org', count: 12, uniques: 7 }],
  }));
  stub.route('GET /repos/:owner/:name/traffic/popular/paths', () => ({
    json: [{ path: '/', title: 'RepoSignal', count: 30, uniques: 18 }],
  }));
  stub.route('GET /repos/:owner/:name/stargazers*', () => ({ json: [{ starred_at: '2026-09-01T10:00:00Z' }] }));
  stub.route('GET /repos/:owner/:name/stats/commit_activity', () => ({ json: [] }));
  stub.route('GET /repos/:owner/:name/stats/participation', () => ({ json: { all: [1, 2], owner: [1, 1] } }));
}

/**
 * Script the repository resolution every collection is confirmed through. A
 * repository named in `vanished` answers 404, and one named in `moved` answers with
 * the identity GitHub now holds it under.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 * @param {{ moved?: Record<string, {owner: string, name: string}>, vanished?: string[] }} [options]
 */
function scriptRepository(stub, options = {}) {
  const moved = options.moved ?? {};
  const vanished = new Set((options.vanished ?? []).map((repo) => repo.toLowerCase()));
  stub.route('GET /repos/:owner/:name', (request) => {
    const requested = request.path.slice('/repos/'.length);
    if (vanished.has(requested.toLowerCase())) {
      return { status: 404, json: { message: 'Not Found' } };
    }
    const [owner, name] = requested.split('/');
    const target = moved[requested] ?? moved[requested.toLowerCase()] ?? null;
    const resolvedOwner = target?.owner ?? owner;
    const resolvedName = target?.name ?? name;
    return {
      json: {
        id: 4242, name: resolvedName, full_name: `${resolvedOwner}/${resolvedName}`,
        owner: { login: resolvedOwner, type: 'User' },
        stargazers_count: 3, forks_count: 1, watchers_count: 3,
      },
    };
  });
}

