import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { collectRun } from '../src/collect/run.js';
import { validateConfig } from '../src/config/schema.js';
import { getRepository, openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { GitHubRequestError } from '../src/github/retry.js';
import { resolveHomePaths } from '../src/paths.js';
import {
  RUN_STATUS_RUNNING, STALL_THRESHOLD_HOURS, STALL_THRESHOLD_MS, TICK_NOT_RECORDED_CLOCK, createRunJournal,
  isRepositoryStalled, isStalledSince, listRuns, listUnclosedRuns, readRunJournal, repositoryStallState,
} from '../src/supervision/journal.js';
import {
  assertNoCredentialMaterial, createCollectHome, outputLines as lines, plainRows as plain,
  rowCount as rows,
} from './helpers/collect-home.js';

// The run journal and the stall rule, at three levels: the journal module against an
// open archive with an injected clock, a whole run driven through `collectRun` over a
// scripted policy, and the `collect` command itself through `node src/cli.js` over a
// temporary home. No test here reaches api.github.com: the in-process runs never build
// a transport, and the spawned command points at the loopback stub.

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.parse('2026-10-03T04:05:06.000Z');
const WINDOW_DAYS = 14;
/** Clones, unique cloners, views and unique visitors: four metric keys a day. */
const TRAFFIC_ROWS_PER_REPOSITORY = WINDOW_DAYS * 4;

/**
 * One outbound attempt is refused by this guard for the whole file, so a test that
 * reaches the network fails loudly instead of quietly succeeding. Every in-process run
 * below is handed a scripted policy and never constructs a transport.
 * @type {typeof globalThis.fetch|null}
 */
let realFetch = null;
/** @type {string[]} */
const refusedHosts = [];
const refuseNetwork = () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    /** @param {string|URL|Request} url */
    (url) => {
      refusedHosts.push(String(url));
      throw new Error(`this test must not reach the network: ${String(url)}`);
    });
};
refuseNetwork();
after(() => {
  if (realFetch !== null) globalThis.fetch = realFetch;
});

/**
 * @param {string} lastDay
 * @param {number} count
 * @returns {string[]} Ascending UTC days ending at `lastDay`.
 */
function dayWindow(lastDay, count) {
  const last = Date.parse(`${lastDay}T00:00:00Z`);
  const days = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    days.push(new Date(last - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

const WINDOW = dayWindow('2026-10-02', WINDOW_DAYS);
const REFERRERS = [{ referrer: 'example.org', count: 12, uniques: 7 }];
const POPULAR_PATHS = [{ path: '/', title: 'RepoSignal', count: 30, uniques: 18 }];
const STARGAZERS = [{ starred_at: '2026-09-01T10:00:00Z' }, { starred_at: '2026-09-20T09:00:00Z' }];
const COMMIT_ACTIVITY = [{
  week: Date.parse('2026-09-21T00:00:00Z') / 1000, total: 4, days: [1, 2, 0, 1, 0, 0, 0],
}];
const PARTICIPATION = { all: [10, 12], owner: [3, 4] };

/**
 * @param {string} endpoint
 * @returns {string} The `owner/name` an endpoint addresses, or '' for none.
 */
function repoOf(endpoint) {
  return /^\/repos\/([^/]+\/[^/]+)/.exec(endpoint.split('?')[0] ?? '')?.[1] ?? '';
}

/**
 * The payload GitHub serves for one endpoint. Counts differ per repository, so a fact
 * written under the wrong identity would be visible rather than masked.
 * @param {string} endpoint Path with or without its query.
 * @returns {unknown}
 */
function payloadFor(endpoint) {
  const path = endpoint.split('?')[0] ?? '';
  const repo = repoOf(endpoint);
  const [owner, name = ''] = repo.split('/');
  const offset = name.length;
  /** @param {number} count @param {number} uniques */
  const day = (count, uniques) => WINDOW.map((entry) => ({
    timestamp: `${entry}T00:00:00Z`, count, uniques,
  }));
  if (path === `/repos/${repo}`) {
    return {
      id: 1000 + offset, name, full_name: repo, owner: { login: owner, type: 'User' },
      stargazers_count: 2, forks_count: 1, watchers_count: 2,
    };
  }
  if (path.endsWith('/traffic/clones')) return { count: 91, uniques: 40, clones: day(2 + offset, 1 + offset) };
  if (path.endsWith('/traffic/views')) return { count: 400, uniques: 90, views: day(30 + offset, 3 + offset) };
  if (path.endsWith('/traffic/popular/referrers')) return REFERRERS;
  if (path.endsWith('/traffic/popular/paths')) return POPULAR_PATHS;
  if (path.endsWith('/stargazers')) return STARGAZERS;
  if (path.endsWith('/stats/commit_activity')) return COMMIT_ACTIVITY;
  if (path.endsWith('/stats/participation')) return PARTICIPATION;
  throw new Error(`this fixture has no payload scripted for ${endpoint}`);
}

/**
 * A request policy that answers from that table instead of a socket, so a whole run can
 * be driven without a transport. One repository can be made to fail its traffic read the
 * way the shared policy fails it, and every request is offered to `observe` so a test can
 * read the archive at a chosen moment of the run.
 * @param {{ failing?: string|null, observe?: (endpoint: string) => void }} [options]
 * @returns {Parameters<typeof collectRun>[0]['policy']}
 */
function scriptedPolicy({ failing = null, observe = () => {} } = {}) {
  return {
    get: async (endpoint) => {
      observe(endpoint);
      if (repoOf(endpoint) === failing && endpoint.includes('/traffic/clones')) {
        throw new GitHubRequestError('permission-missing', 403, endpoint,
          'Grant Administration repository permission (read), accept the permission upgrade, and reconnect', 1);
      }
      return { status: 200, headers: new Headers(), body: JSON.stringify(payloadFor(endpoint)) };
    },
  };
}

/**
 * Script the loopback stub a spawned `node src/cli.js collect` will read, from the same
 * payload table the in-process policy uses.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 */
function scriptStub(stub) {
  for (const pattern of [
    'GET /repos/:owner/:name',
    'GET /repos/:owner/:name/traffic/clones',
    'GET /repos/:owner/:name/traffic/views',
    'GET /repos/:owner/:name/traffic/popular/referrers',
    'GET /repos/:owner/:name/traffic/popular/paths',
    'GET /repos/:owner/:name/stargazers*',
    'GET /repos/:owner/:name/stats/commit_activity',
    'GET /repos/:owner/:name/stats/participation',
  ]) {
    stub.route(pattern, (request) => ({ json: payloadFor(request.path) }));
  }
}

/**
 * A clock that advances a fixed step on every read, so every instant a run records is
 * distinct and ordered without any real time passing.
 * @param {number} startMs
 * @param {number} [stepMs]
 * @returns {() => number}
 */
function steppingClock(startMs, stepMs = 1000) {
  let now = startMs;
  return () => {
    const read = now;
    now += stepMs;
    return read;
  };
}

/**
 * A temporary home with a migrated archive, plus a validated configuration naming the
 * repositories a run would collect.
 * @param {import('node:test').TestContext} t
 * @param {{ enrolled?: string[] }} [options]
 * @returns {Promise<{db: import('node:sqlite').DatabaseSync,
 *   config: import('../src/config/schema.js').Configuration}>}
 */
async function fixture(t, { enrolled = ['owner/alpha', 'owner/beta'] } = {}) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-journal-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700, 'the home directory is held at 0700');
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  return { db, config: validateConfig({ enrolled }) };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @returns {number}
 */
function repositoryIdOf(db, name) {
  const row = /** @type {{id: number}|undefined} */ (/** @type {unknown} */ (db.prepare(
    'SELECT id FROM repositories WHERE name=?').get(name)));
  assert.ok(row !== undefined, `the archive must hold a repository named ${name}`);
  return row.id;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string} The identifier the journal holds for the run in this archive.
 */
function onlyRunId(db) {
  const row = /** @type {{id: string}|undefined} */ (/** @type {unknown} */ (
    db.prepare('SELECT id FROM runs').get()));
  assert.ok(row !== undefined, 'the archive must hold exactly one run row');
  return row.id;
}

/**
 * @param {string} stdout
 * @returns {string} The run identifier the summary line printed.
 */
function printedRunId(stdout) {
  const match = /summary run=(collect-\S+)/.exec(stdout);
  assert.ok(match !== null, `the summary must name the run it wrote; got ${JSON.stringify(stdout)}`);
  return /** @type {string} */ (match[1]);
}

test('a completed run leaves exactly one closed run row carrying status, counts, duration and request count', async (t) => {
  const { db, config } = await fixture(t);

  const summary = await collectRun({ db, config, policy: scriptedPolicy(), clock: steppingClock(START_MS) });

  const runId = /** @type {string} */ (summary.runId);
  assert.match(runId, /^collect-\d{8}T\d{9}Z-[0-9a-f]{8}$/);
  assert.equal(summary.status, 'completed');
  assert.equal(rows(db, 'runs'), 1, 'one run row covers the whole run');
  assert.equal(rows(db, 'heartbeats'), 1, 'the run wrote exactly one heartbeat');

  const entry = readRunJournal(db, runId);
  assert.notEqual(entry, null);
  assert.equal(entry?.runId, runId, 'the identifier the summary reports is the journalled one');
  assert.equal(entry?.open, false, 'a completed run is closed');
  assert.equal(entry?.status, 'completed');
  assert.equal(entry?.successCount, 2);
  assert.equal(entry?.failureCount, 0);
  assert.equal(entry?.requestCount, 16, 'eight per repository: identity, three backfill reads, four traffic reads');
  assert.equal(entry?.durationMs,
    Date.parse(/** @type {string} */ (entry?.closedAt)) - Date.parse(/** @type {string} */ (entry?.startedAt)));
  assert.ok((entry?.durationMs ?? 0) > 0, 'the run took a measurable amount of time');
  assert.equal(summary.totals.durationMs, entry?.durationMs, 'the printed duration is the recorded duration');
  assert.equal(summary.totals.requests, entry?.requestCount);

  // The heartbeat is closed beside the run row and counted what the run finished.
  assert.equal(entry?.completedRepositories, 2);
  assert.equal(entry?.heartbeatClosedAt, entry?.closedAt);
  assert.equal(listUnclosedRuns(db).length, 0, 'a closed run is never reported as abandoned');
  assert.equal(listRuns(db).length, 1);
});

test('the run row and its heartbeat are written before the first request', async (t) => {
  const { db, config } = await fixture(t);
  // The observation is captured as data and asserted after the run, never from inside
  // the request: an assertion raised inside a repository's failure boundary would be
  // swallowed by the very boundary this test exists to observe.
  /** @type {{runs: Record<string, unknown>[], beats: Record<string, unknown>[]}|null} */
  let duringFirstRequest = null;

  await collectRun({
    db,
    config,
    clock: steppingClock(START_MS),
    policy: scriptedPolicy({
      observe: () => {
        if (duringFirstRequest !== null) return;
        duringFirstRequest = {
          runs: plain(db.prepare('SELECT id, status, closed_at AS closedAt FROM runs').all()),
          beats: plain(db.prepare('SELECT closed_at AS closedAt, completed_repositories AS done'
            + ' FROM heartbeats').all()),
        };
      },
    }),
  });

  assert.notEqual(duringFirstRequest, null, 'the archive was read while the first request was in flight');
  const observed = /** @type {{runs: Record<string, unknown>[], beats: Record<string, unknown>[]}} */ (
    /** @type {unknown} */ (duringFirstRequest));
  assert.equal(observed.runs.length, 1, 'the run row exists before the first request is answered');
  assert.equal(observed.runs[0].closedAt, null, 'the run row is still open');
  assert.equal(observed.runs[0].status, RUN_STATUS_RUNNING);
  assert.equal(observed.beats.length, 1, 'the heartbeat exists before the first request is answered');
  assert.equal(observed.beats[0].closedAt, null, 'the heartbeat is still open');
  assert.equal(observed.beats[0].done, 0, 'no repository has finished yet');
  assert.equal(readRunJournal(db, onlyRunId(db))?.open, false, 'and the run closed at the end');
});

test('the heartbeat records progress as each repository finishes', async (t) => {
  const { db, config } = await fixture(t);
  /** @type {Map<string, number>} */
  const asked = new Map();
  /** @type {number|null} Completed repositories the heartbeat held when beta was first asked about. */
  let progressWhenBetaStarted = null;

  await collectRun({
    db,
    config,
    clock: steppingClock(START_MS),
    policy: scriptedPolicy({
      observe: (endpoint) => {
        const repo = repoOf(endpoint);
        const seen = (asked.get(repo) ?? 0) + 1;
        asked.set(repo, seen);
        if (repo !== 'owner/beta' || seen !== 1 || progressWhenBetaStarted !== null) return;
        // Beta is being asked about, so alpha is finished; the archive says how many.
        const beat = /** @type {{done: number}|undefined} */ (/** @type {unknown} */ (db.prepare(
          'SELECT completed_repositories AS done FROM heartbeats').get()));
        progressWhenBetaStarted = beat?.done ?? null;
      },
    }),
  });

  assert.ok((asked.get('owner/alpha') ?? 0) > 0 && (asked.get('owner/beta') ?? 0) > 0);
  assert.equal(progressWhenBetaStarted, 1,
    'the heartbeat counted the repository that finished before this request');
  const entry = readRunJournal(db, onlyRunId(db));
  assert.equal(entry?.completedRepositories, 2, 'the closed heartbeat counted every repository the run finished');
  assert.equal(entry?.lastProgressAt, entry?.closedAt, 'the last tick is the one that closed the heartbeat');
});

test('a run where one repository fails still collects the others and closes a complete run record', async (t) => {
  const { db, config } = await fixture(t);

  const summary = await collectRun({
    db, config, clock: steppingClock(START_MS), policy: scriptedPolicy({ failing: 'owner/beta' }),
  });

  assert.equal(summary.status, 'degraded');
  const runId = /** @type {string} */ (summary.runId);
  const entry = readRunJournal(db, runId);
  assert.equal(entry?.open, false, 'a degraded run still closes');
  assert.equal(entry?.status, 'degraded');
  assert.equal(entry?.successCount, 1, 'the repository that collected is counted');
  assert.equal(entry?.failureCount, 1, 'the repository that failed is counted');
  assert.equal(entry?.requestCount, 13,
    'eight for the collected repository, five for the one whose traffic read was refused');
  assert.equal(entry?.completedRepositories, 2, 'the heartbeat counted the failure as progress too');
  assert.equal(listUnclosedRuns(db).length, 0);

  // The failing repository produced no fact, and recorded the failure as evidence.
  const alpha = repositoryIdOf(db, 'alpha');
  const beta = repositoryIdOf(db, 'beta');
  assert.equal(rows(db, 'day_series', `WHERE repository_id=${alpha} AND source='collected'`),
    TRAFFIC_ROWS_PER_REPOSITORY);
  assert.equal(rows(db, 'day_series', `WHERE repository_id=${beta} AND source='collected'`), 0);
  assert.equal(getRepository(db, alpha).lastSuccessAt, entry?.startedAt, 'a collected repository recorded its success');
  assert.equal(getRepository(db, beta).lastSuccessAt, null, 'a repository that failed recorded no success');
  assert.equal(getRepository(db, beta).consecutiveFailures, 1);
  assert.equal(getRepository(db, beta).lifecycle, 'active', 'a refused permission is not a disappearance');
  const evidence = /** @type {{kind: string, message: string, runId: string}} */ (/** @type {unknown} */ (
    db.prepare('SELECT kind, message, run_id AS runId FROM repository_errors').get()));
  assert.equal(evidence.kind, 'permission-missing');
  assert.equal(evidence.runId, runId, 'the failure belongs to the run that recorded it');
  assert.match(evidence.message, /Administration repository permission \(read\)/);

  // The run still reported that repository, and reported it as the same kind.
  const reported = summary.outcomes.find((outcome) => outcome.repo === 'owner/beta');
  assert.equal(reported?.state, 'failed');
  assert.equal(reported?.failure?.kind, 'permission-missing');
});

test('a run abandoned before closing is reported as unclosed by a later read', async (t) => {
  const { db, config } = await fixture(t);

  // A run that opened its journal, recorded one repository and was then killed.
  const abandoned = createRunJournal({ db, clock: steppingClock(START_MS) });
  const opened = abandoned.start();
  const tick = abandoned.progress({ completedRepositories: 1 });

  assert.equal(tick.recorded, true);
  const stuck = readRunJournal(db, opened.runId);
  assert.equal(stuck?.open, true, 'a run that never closed is reported as open');
  assert.equal(stuck?.closedAt, null);
  assert.equal(stuck?.status, RUN_STATUS_RUNNING, 'an open run still carries the running word');
  assert.equal(stuck?.durationMs, null, 'an open run has no duration to report');
  assert.equal(stuck?.completedRepositories, 1, 'the progress the abandoned run did record is still readable');
  assert.deepEqual(listUnclosedRuns(db).map((entry) => entry.runId), [opened.runId]);

  // A later run that does finish does not hide the one that did not.
  const later = createRunJournal({ db, clock: steppingClock(START_MS + HOUR_MS) });
  const finished = later.start();
  later.progress({ completedRepositories: 2 });
  later.close({
    status: 'completed', successCount: 2, failureCount: 0, requestCount: 16, completedRepositories: 2,
  });

  assert.deepEqual(listUnclosedRuns(db).map((entry) => entry.runId), [opened.runId],
    'only the abandoned run is reported as unclosed');
  assert.equal(readRunJournal(db, finished.runId)?.open, false);
  assert.equal(listRuns(db).length, 2, 'both runs are journalled; neither is deleted');

  // The same thing through a run that died inside collectRun: its row was already there.
  const reads = [];
  const dying = () => {
    reads.push(reads.length);
    if (reads.length > 1) throw new Error('the process was killed mid-run');
    return START_MS + 2 * HOUR_MS;
  };
  await assert.rejects(() => collectRun({ db, config, policy: scriptedPolicy(), clock: dying }), /killed mid-run/);
  const unclosed = listUnclosedRuns(db);
  assert.equal(unclosed.length, 2, 'the killed run left an open row of its own');
  assert.ok(unclosed.some((entry) => entry.runId === opened.runId), 'the earlier abandoned run is still reported');
  const killedRun = unclosed.find((entry) => entry.runId !== opened.runId);
  assert.equal(killedRun?.status, RUN_STATUS_RUNNING);
  assert.equal(killedRun?.completedRepositories, 0, 'it died before any repository finished');
  assert.equal(killedRun?.closedAt, null);
});

test('a repository last collected 25 hours ago is healthy and one collected 27 hours ago is stalled', async (t) => {
  const { db, config } = await fixture(t);
  assert.equal(STALL_THRESHOLD_HOURS, 26);
  assert.equal(STALL_THRESHOLD_MS, 26 * HOUR_MS);

  // The success is recorded by a real run, so the rule is read against state the
  // product recorded rather than against a value this test invented.
  const summary = await collectRun({
    db, config, policy: scriptedPolicy(), clock: steppingClock(START_MS), filter: 'owner/alpha',
  });
  const runId = /** @type {string} */ (summary.runId);
  const entry = readRunJournal(db, runId);
  const alpha = repositoryIdOf(db, 'alpha');
  assert.equal(getRepository(db, alpha).lastSuccessAt, entry?.startedAt,
    'the run recorded the success the stall rule is later read against');

  const healthy = repositoryStallState(db, alpha, START_MS + 25 * HOUR_MS);
  assert.equal(healthy.state, 'healthy');
  assert.equal(healthy.stalled, false, '25 hours is inside the threshold');
  assert.equal(healthy.elapsedMs, 25 * HOUR_MS);
  assert.equal(isRepositoryStalled(db, alpha, START_MS + 25 * HOUR_MS), false);

  const boundary = repositoryStallState(db, alpha, START_MS + 26 * HOUR_MS);
  assert.equal(boundary.state, 'healthy', 'the threshold is strict: exactly 26 hours has not passed it');
  assert.equal(boundary.stalled, false);

  const stalled = repositoryStallState(db, alpha, START_MS + 27 * HOUR_MS);
  assert.equal(stalled.state, 'stalled', '27 hours past the last success is stalled, not healthy');
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.lastSuccessAt, entry?.startedAt, 'the state names the recorded success it was read from');
  assert.equal(isRepositoryStalled(db, alpha, START_MS + 27 * HOUR_MS), true);

  // The rule itself, on both sides of the boundary and on the state it cannot judge.
  const lastSuccess = new Date(START_MS).toISOString();
  assert.equal(isStalledSince(lastSuccess, START_MS + 26 * HOUR_MS - 1), false);
  assert.equal(isStalledSince(lastSuccess, START_MS + 26 * HOUR_MS), false);
  assert.equal(isStalledSince(lastSuccess, START_MS + 26 * HOUR_MS + 1), true);
  assert.equal(isStalledSince(null, START_MS + 99 * HOUR_MS), false,
    'a repository with no recorded success is never stalled');

  // A first-connect install is not alarmed at: an enrolled repository that has never
  // been collected reports never-collected, not stalled.
  upsertRepository(db, {
    id: 99, owner: 'owner', name: 'fresh', lastSeenAt: lastSuccess, enrolled: 1,
  });
  const never = repositoryStallState(db, 99, START_MS + 99 * HOUR_MS);
  assert.equal(never.state, 'never-collected');
  assert.equal(never.stalled, false, 'never collected is its own state, not a stall');
  assert.equal(never.lastSuccessAt, null);
  assert.equal(isRepositoryStalled(db, 99, START_MS + 99 * HOUR_MS), false);

  // A recorded success time this build cannot read is an unknown state, not a stall.
  db.prepare('UPDATE repositories SET last_success_at=? WHERE id=99').run('the day before yesterday');
  const unreadable = repositoryStallState(db, 99, START_MS + 99 * HOUR_MS);
  assert.equal(unreadable.state, 'unreadable');
  assert.equal(unreadable.stalled, false, 'an unreadable time is not evidence that collection stopped');
});

test('a dry run writes no run row and no heartbeat', async (t) => {
  const { db, config } = await fixture(t);

  const summary = await collectRun({ db, config, dryRun: true, clock: steppingClock(START_MS) });

  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.runId, null, 'a dry run has no run to name');
  assert.equal(summary.plan.length, 2, 'a dry run still reports the plan it would carry out');
  assert.equal(summary.totals.durationMs, 0);
  for (const table of ['runs', 'heartbeats', 'repositories', 'day_series', 'snapshots']) {
    assert.equal(rows(db, table), 0, `a dry run writes no ${table} row`);
  }
  assert.deepEqual(listRuns(db), []);
  assert.deepEqual(listUnclosedRuns(db), []);
});

test('the collect command closes one run and one heartbeat, and a dry run writes neither', async (t) => {
  const f = await createCollectHome(t);
  scriptStub(f.stub);

  const planned = await f.run(['collect', '--dry-run']);

  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(lines(planned.stdout).at(-1),
    'summary mode=dry-run run=none planned=2 backfill=2 requests=0 duration_ms=0 status=planned');
  assert.equal(f.stub.requests().length, 0, 'a dry run contacts no host at all');
  f.archive((db) => {
    assert.equal(rows(db, 'runs'), 0, 'the command wrote no run row');
    assert.equal(rows(db, 'heartbeats'), 0, 'the command wrote no heartbeat');
  });
  assertNoCredentialMaterial(planned, 'dry run');

  const collected = await f.run(['collect']);

  assert.equal(collected.status, 0, collected.stderr);
  assertNoCredentialMaterial(collected, 'collected run');
  const runId = printedRunId(collected.stdout);
  f.archive((db) => {
    assert.equal(rows(db, 'runs'), 1, 'the command journalled exactly one run');
    assert.equal(rows(db, 'heartbeats'), 1, 'the command wrote exactly one heartbeat');
    const entry = readRunJournal(db, runId);
    assert.equal(entry?.runId, runId, 'the printed identifier is the journalled one');
    assert.equal(entry?.open, false);
    assert.equal(entry?.status, 'completed');
    assert.equal(entry?.successCount, 2);
    assert.equal(entry?.failureCount, 0);
    assert.equal(entry?.requestCount, 16);
    assert.equal(entry?.completedRepositories, 2);
    assert.equal(entry?.heartbeatClosedAt, entry?.closedAt);
    assert.deepEqual(listUnclosedRuns(db), []);
  });
});

test('the journal refuses to be opened twice or to record progress for a run it never opened', async (t) => {
  const { db } = await fixture(t);
  const journal = createRunJournal({ db, runId: 'collect-fixed-run', clock: steppingClock(START_MS) });

  assert.equal(journal.runId, 'collect-fixed-run');
  assert.throws(() => journal.progress({ completedRepositories: 1 }), /must be opened/);
  assert.throws(() => journal.close({
    status: 'completed', successCount: 0, failureCount: 0, requestCount: 0, completedRepositories: 0,
  }), /must be opened/);

  const opened = journal.start();
  assert.equal(opened.runId, 'collect-fixed-run', 'an explicit identifier is written as given');
  assert.throws(() => journal.start(), /already journalled/);
  assert.throws(() => journal.progress({ completedRepositories: -1 }), /non-negative/);
  assert.throws(() => journal.close({
    status: '  ', successCount: 0, failureCount: 0, requestCount: 0, completedRepositories: 0,
  }), /status word/);

  // A second journal under the same identifier cannot replace the first one's journal.
  const other = createRunJournal({ db, runId: 'collect-fixed-run', clock: steppingClock(START_MS) });
  assert.throws(() => other.start(), /UNIQUE constraint/);
  assert.equal(readRunJournal(db, 'collect-fixed-run')?.completedRepositories, 0,
    'the refused second start left the first run untouched');
});

test('a clock that does not advance records no tick and reports that it recorded none', async (t) => {
  const { db } = await fixture(t);
  const journal = createRunJournal({ db, clock: () => START_MS });

  const opened = journal.start();
  const first = journal.progress({ completedRepositories: 1 });
  assert.equal(first.recorded, false, 'the archive cannot hold two ticks at one instant, so none was invented');
  assert.equal(first.reason, TICK_NOT_RECORDED_CLOCK);
  assert.equal(first.at, opened.startedAt, 'the tick carries the instant the clock reported');

  const closed = journal.close({
    status: 'completed', successCount: 1, failureCount: 0, requestCount: 5, completedRepositories: 1,
  });
  assert.equal(closed.durationMs, 0, 'a run that finished inside one instant took no measurable time');
  assert.equal(closed.heartbeat.recorded, false);
  assert.equal(closed.heartbeat.reason, TICK_NOT_RECORDED_CLOCK);

  const entry = readRunJournal(db, opened.runId);
  assert.equal(entry?.open, false, 'the run row closes whatever the heartbeat could record');
  assert.equal(entry?.status, 'completed');
  assert.equal(entry?.completedRepositories, 0, 'no progress was recorded, so none is claimed');
  assert.equal(entry?.lastProgressAt, entry?.startedAt, 'the heartbeat still carries the start it was given');
  assert.equal(entry?.heartbeatClosedAt, null);
  assert.equal(listUnclosedRuns(db).length, 0, 'a run that closed is never reported as abandoned');
});

test('no request in this file reached the network', () => {
  assert.deepEqual(refusedHosts, [], 'the armed fetch guard refused nothing because nothing called it');
});