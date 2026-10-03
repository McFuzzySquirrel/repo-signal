import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { collectRun } from '../src/collect/run.js';
import { validateConfig } from '../src/config/schema.js';
import { getRepository, openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { GitHubRequestError } from '../src/github/retry.js';
import { resolveHomePaths } from '../src/paths.js';
import {
  REPOSITORY_STATE_DEGRADED, REPOSITORY_STATE_HEALTHY, REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
  REPOSITORY_STATE_NEVER_COLLECTED, REPOSITORY_STATE_PRECEDENCE, REPOSITORY_STATE_STALLED,
  REPOSITORY_STATE_UNAVAILABLE, REPOSITORY_STATE_UNREADABLE, RUN_STATE_COMPLETED, RUN_STATE_DEGRADED,
  RUN_STATE_NEVER_RUN, RUN_STATE_UNCLOSED, SUMMARY_STATE_EMPTY, collectionHealth, healthForHome,
  repositoryHealth, runHealth, statePhrase, summariseHealth,
} from '../src/supervision/health.js';
import { createRunJournal } from '../src/supervision/journal.js';
import { rowCount as rows } from './helpers/collect-home.js';
import { starHistory } from './helpers/star-history.js';

// The health read is exercised against real archives: every state below was recorded
// by the collection run and the journal the product actually ships, never written as
// a fixture value, and every instant comes from an injected clock. No test here
// reaches api.github.com: the in-process runs are handed a scripted policy that
// answers from a table, `globalThis.fetch` is refused for the whole file, and the
// read itself is additionally asserted to import no client at all.

const HOUR_MS = 60 * 60 * 1000;

/** The instant every health read in this file is taken at. */
const READ_AT_MS = Date.parse('2026-10-05T12:00:00.000Z');
/** A success older than the 26-hour threshold, so its repository reads as stalled. */
const STALE_AT = Date.parse('2026-10-04T06:00:00.000Z');
/** A success inside the threshold, so its repository reads as healthy. */
const RECENT_AT = Date.parse('2026-10-05T07:00:00.000Z');
/** The attempt that fails, refused or vanishes, an hour before the read. */
const ATTEMPT_AT = Date.parse('2026-10-05T11:00:00.000Z');

/**
 * @param {number} ms
 * @returns {string} The canonical UTC instant the archive accepts.
 */
function iso(ms) {
  return new Date(ms).toISOString();
}

const ENROLLED = ['owner/quiet', 'owner/alpha', 'owner/beta', 'owner/gamma', 'owner/delta', 'owner/fresh'];

/**
 * One outbound attempt is refused by this guard for the whole file, so a test that
 * reaches the network fails loudly instead of quietly succeeding.
 * @type {typeof globalThis.fetch|null}
 */
let realFetch = null;
/** @type {string[]} */
const attemptedHosts = [];
refuseNetwork();
function refuseNetwork() {
  realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    /** @param {string|URL|Request} url */
    (url) => {
      attemptedHosts.push(String(url));
      throw new Error(`this test must not reach the network: ${String(url)}`);
    });
}
after(() => {
  if (realFetch !== null) globalThis.fetch = realFetch;
});

/**
 * @param {string} endpoint
 * @returns {string} The `owner/name` an endpoint addresses, or '' for none.
 */
function repoOf(endpoint) {
  return /^\/repos\/([^/]+\/[^/]+)/.exec(endpoint.split('?')[0] ?? '')?.[1] ?? '';
}

/**
 * The payload GitHub serves for one endpoint. Counts differ per repository, so a
 * fact written under the wrong identity would be visible rather than masked.
 * @param {string} endpoint
 * @returns {unknown}
 */
function payloadFor(endpoint) {
  const path = endpoint.split('?')[0] ?? '';
  const repo = repoOf(endpoint);
  const [owner, name = ''] = repo.split('/');
  const offset = name.length;
  // The 14 days GitHub's rolling window serves, counted from a base day so every
  // entry is a real calendar date rather than a number that only looks like one.
  /** @param {number} count @param {number} uniques */
  const day = (count, uniques) => Array.from({ length: 14 }, (_ignored, index) => ({
    timestamp: `${iso(Date.parse('2026-09-19T00:00:00.000Z') + index * 86_400_000).slice(0, 10)}T00:00:00Z`,
    count, uniques,
  }));
  if (path === `/repos/${repo}`) {
    return {
      id: 1000 + offset, name, full_name: repo, owner: { login: owner, type: 'User' },
      stargazers_count: 2, forks_count: 1, watchers_count: 2,
    };
  }
  if (path.endsWith('/traffic/clones')) return { count: 91, uniques: 40, clones: day(2 + offset, 1 + offset) };
  if (path.endsWith('/traffic/views')) return { count: 400, uniques: 90, views: day(30 + offset, 3 + offset) };
  if (path.endsWith('/traffic/popular/referrers')) return [];
  if (path.endsWith('/traffic/popular/paths')) return [];
  if (path.endsWith('/stargazers/history')) return starHistory(2);
  if (path.endsWith('/stats/commit_activity')) {
    return [{ week: Date.parse('2026-09-21T00:00:00Z') / 1000, total: 4, days: [1, 2, 0, 1, 0, 0, 0] }];
  }
  if (path.endsWith('/stats/participation')) return { all: [10, 12], owner: [3, 4] };
  throw new Error(`this fixture has no payload scripted for ${endpoint}`);
}

/**
 * A request policy answering from that table instead of a socket. One repository
 * can be made to fail its traffic read the way the shared policy fails it, and one
 * can be made to answer 404 for its identity, which is how a repository GitHub no
 * longer serves reaches the archive's unavailable marking.
 * @param {{ failing?: {repo: string, kind: 'permission-missing'|'rate-limited'}|null, vanished?: string|null }} [options]
 * @returns {Parameters<typeof collectRun>[0]['policy']}
 */
function scriptedPolicy({ failing = null, vanished = null } = {}) {
  return {
    get: async (endpoint) => {
      const repo = repoOf(endpoint);
      const resolved = endpoint.split('?')[0] ?? '';
      if (vanished !== null && repo === vanished && resolved === `/repos/${repo}`) {
        throw new GitHubRequestError('repository-missing', 404, resolved,
          'Check the repository name, whether it still exists, and token access', 1);
      }
      if (failing !== null && repo === failing.repo && resolved.endsWith('/traffic/clones')) {
        throw new GitHubRequestError(failing.kind, failing.kind === 'rate-limited' ? 429 : 403, resolved,
          failing.kind === 'rate-limited'
            ? 'Wait for GitHub to reset the rate limit for this token'
            : 'Grant Administration repository permission (read), accept the permission upgrade, and reconnect',
          1);
      }
      return { status: 200, headers: new Headers(), body: JSON.stringify(payloadFor(endpoint)) };
    },
  };
}

/**
 * A temporary home with a migrated archive.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{db: import('node:sqlite').DatabaseSync, home: string}>}
 */
async function archiveOf(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-health-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700, 'the home directory is held at 0700');
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  return { db, home: paths.home };
}

/**
 * Collect one enrolled repository at one instant, so every state in the archive is
 * something a real run recorded at the time the test needs it recorded.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} options
 * @param {string} options.repo
 * @param {number} options.at Epoch milliseconds for the whole run.
 * @param {{repo: string, kind: 'permission-missing'|'rate-limited'}|null} [options.failing]
 * @param {string|null} [options.vanished]
 * @returns {Promise<import('../src/collect/run.js').CollectSummary>}
 */
function collectOne(db, { repo, at, failing = null, vanished = null }) {
  return collectRun({
    db,
    config: validateConfig({ enrolled: ENROLLED }),
    filter: repo,
    clock: () => at,
    policy: scriptedPolicy({ failing, vanished }),
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @returns {number} The stored identity the archive gave that repository.
 */
function idOf(db, name) {
  const row = /** @type {{id: number}|undefined} */ (/** @type {unknown} */ (db.prepare(
    'SELECT id FROM repositories WHERE name=?').get(name)));
  assert.ok(row !== undefined, `the archive must hold a repository named ${name}`);
  return row.id;
}

/**
 * @param {import('../src/supervision/health.js').CollectionHealth} health
 * @param {string} repo
 * @returns {import('../src/supervision/health.js').RepositoryHealth}
 */
function entryFor(health, repo) {
  const found = health.repositories.find((entry) => entry.repo === repo);
  assert.ok(found !== undefined, `the read must report ${repo}`);
  return /** @type {import('../src/supervision/health.js').RepositoryHealth} */ (found);
}

/**
 * The archive holding all six repository states at once: a success recorded thirty
 * hours ago, a success recorded five hours ago, a repository failing after that
 * success, a repository whose token is refused on its first attempt, a repository
 * that vanished after its history was written, and an enrolled repository no run has
 * ever touched. Each run is driven through `collectRun`, so every recorded instant
 * is the instant a real run recorded.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{db: import('node:sqlite').DatabaseSync, home: string,
 *   health: import('../src/supervision/health.js').CollectionHealth}>}
 */
async function everyState(t) {
  const { db, home } = await archiveOf(t);
  // The stalled repository: one successful run, thirty hours before the read.
  await collectOne(db, { repo: 'owner/quiet', at: STALE_AT });
  // The healthy repository and the repository that will fail: both succeed five
  // hours before the read, so neither is stale enough to read as stalled.
  await collectOne(db, { repo: 'owner/alpha', at: RECENT_AT });
  await collectOne(db, { repo: 'owner/beta', at: RECENT_AT });
  await collectOne(db, { repo: 'owner/delta', at: RECENT_AT });
  // An hour before the read: beta is rate limited, gamma's token is refused on the
  // traffic endpoint, and delta no longer resolves.
  await collectOne(db, { repo: 'owner/beta', at: ATTEMPT_AT, failing: { repo: 'owner/beta', kind: 'rate-limited' } });
  await collectOne(db, {
    repo: 'owner/gamma', at: ATTEMPT_AT, failing: { repo: 'owner/gamma', kind: 'permission-missing' },
  });
  await collectOne(db, { repo: 'owner/delta', at: ATTEMPT_AT, vanished: 'owner/delta' });
  // A repository the configuration enrolls that no run has ever registered.
  upsertRepository(db, { id: 60, owner: 'owner', name: 'fresh', lastSeenAt: iso(RECENT_AT), enrolled: 1 });
  return { db, home, health: collectionHealth({ db, clock: () => READ_AT_MS }) };
}

test('one archive holding every state reports each state with its own text reason', async (t) => {
  const { health } = await everyState(t);

  // The archive's own order, which is stable identity order rather than the order
  // the state happened to be recorded in.
  assert.deepEqual(health.repositories.map((entry) => [entry.repo, entry.state]), [
    ['owner/quiet', REPOSITORY_STATE_STALLED],
    ['owner/alpha', REPOSITORY_STATE_HEALTHY],
    ['owner/beta', REPOSITORY_STATE_DEGRADED],
    ['owner/delta', REPOSITORY_STATE_UNAVAILABLE],
    ['owner/gamma', REPOSITORY_STATE_NEEDS_REAUTHENTICATION],
    ['owner/fresh', REPOSITORY_STATE_NEVER_COLLECTED],
  ], 'each recorded repository state is reported under its own name, in the archive order');

  // RS-AX-07 in this layer: every state travels as text that names itself, so no
  // surface has to invent a word and no meaning exists only in a colour or a badge.
  for (const entry of health.repositories) {
    assert.ok(entry.reason.startsWith(`${statePhrase(entry.state)}: `),
      `the reason for ${entry.repo} announces its own state word, got ${JSON.stringify(entry.reason)}`);
    assert.ok(entry.reason.length > entry.state.length + 2,
      `${entry.repo} carries a reason beyond the state word itself`);
    assert.ok(REPOSITORY_STATE_PRECEDENCE.includes(entry.state),
      `${entry.state} is one of the seven named states`);
  }
  assert.ok(health.summary.reason.startsWith(`${statePhrase(health.summary.state)}: `));
  assert.ok(health.run.reason.startsWith(`${statePhrase(health.run.state)}: `));

  // The roll-up counts every repository once and adds up.
  assert.equal(health.summary.enrolled, 6);
  assert.equal(health.summary.healthy + health.summary.neverCollected + health.summary.degraded
    + health.summary.needsReauthentication + health.summary.stalled + health.summary.unavailable
    + health.summary.unreadable, 6, 'every enrolled repository is counted in exactly one state');
  assert.equal(health.summary.healthy, 1);
  assert.equal(health.summary.neverCollected, 1);
  assert.equal(health.summary.degraded, 1);
  assert.equal(health.summary.needsReauthentication, 1);
  assert.equal(health.summary.stalled, 1);
  assert.equal(health.summary.unavailable, 1);
  assert.equal(health.summary.unreadable, 0);
});

test('a repository with a recent success reports healthy with its last success time', async (t) => {
  const { db, health } = await everyState(t);
  const alpha = entryFor(health, 'owner/alpha');
  const recorded = getRepository(db, idOf(db, 'alpha')).lastSuccessAt;

  assert.equal(alpha.state, REPOSITORY_STATE_HEALTHY);
  assert.equal(alpha.lifecycle, 'active');
  assert.equal(alpha.lastSuccessAt, recorded, 'the reported success is the one the run recorded');
  assert.equal(new Date(/** @type {string} */ (alpha.lastSuccessAt)).toISOString(), '2026-10-05T07:00:00.000Z');
  assert.equal(alpha.sinceLastSuccessMs, READ_AT_MS - RECENT_AT, 'five hours elapsed between the success and the read');
  assert.equal(alpha.consecutiveFailures, 0, 'a repository nobody failed reports the recorded zero');
  assert.equal(alpha.lastFailure, null, 'nothing has ever failed here, and that is recorded as nothing');
  assert.equal(alpha.stalled, false);
  assert.equal(alpha.collectionState, 'healthy');
  assert.equal(alpha.reason,
    'healthy: the last collection succeeded 5 hours ago, inside the 26-hour threshold, '
    + 'and no failure is outstanding');
});

test('a repository with no success ever reports never-collected and is not reported as stalled', async (t) => {
  const { db, health } = await everyState(t);
  const fresh = entryFor(health, 'owner/fresh');

  assert.equal(getRepository(db, 60).lastSuccessAt, null, 'the archive records no success for it');
  assert.equal(fresh.state, REPOSITORY_STATE_NEVER_COLLECTED);
  assert.equal(fresh.collectionState, 'never-collected');
  assert.equal(fresh.stalled, false, 'never collected is its own state, not a stall');
  assert.equal(fresh.lastSuccessAt, null, 'no missing success is defaulted to a time');
  assert.equal(fresh.sinceLastSuccessMs, null);
  assert.equal(fresh.consecutiveFailures, 0);
  assert.match(fresh.reason, /^never collected: /);
  assert.match(fresh.reason, /not reported as stalled/,
    'the reason says why it is not a stall, so a first-connect install reads as not alarmed');

  // A repository whose first attempt was refused still reports the refusal, never
  // "never collected": the refusal is the more actionable recorded fact.
  const gamma = entryFor(health, 'owner/gamma');
  assert.equal(gamma.lastSuccessAt, null, 'gamma never collected successfully either');
  assert.equal(gamma.state, REPOSITORY_STATE_NEEDS_REAUTHENTICATION);
  assert.equal(gamma.stalled, false);

  // The roll-up of a set whose only non-healthy member was never collected is that
  // word, and it is not a call for attention.
  const onlyFresh = summariseHealth([fresh]);
  assert.equal(onlyFresh.state, REPOSITORY_STATE_NEVER_COLLECTED);
  assert.equal(onlyFresh.needsAttention, false);
});

test('a repository whose credential was refused reports needs-re-authentication with the reason', async (t) => {
  const { db, health } = await everyState(t);
  const gamma = entryFor(health, 'owner/gamma');

  assert.equal(gamma.state, REPOSITORY_STATE_NEEDS_REAUTHENTICATION);
  assert.equal(gamma.needsReauthentication, true, 'the explicit re-authentication state is exposed as its own flag');
  assert.ok(gamma.lastFailure !== null, 'the recorded failure is carried, not summarised away');
  assert.equal(gamma.lastFailure?.kind, 'permission-missing');
  assert.match(String(gamma.lastFailure?.message), /Administration repository permission \(read\)/,
    'the reason names the permission the traffic endpoints require');
  assert.equal(gamma.lastFailure?.recordedAt, '2026-10-05T11:00:00.000Z');
  assert.equal(gamma.consecutiveFailures, 1);
  assert.ok(gamma.reason.startsWith('needs re-authentication: '));
  assert.match(gamma.reason, /permission-missing/,
    'the sentence carries the recorded kind, so the page announces why it is asking for a token');

  // The same repository read on its own carries the same word and the same sentence.
  const alone = repositoryHealth(db, idOf(db, 'gamma'), READ_AT_MS);
  assert.equal(alone.state, gamma.state);
  assert.equal(alone.reason, gamma.reason, 'one repository and the whole read cannot disagree');
  // The named run is a row this archive actually holds, and its identifier is the
  // one on the run row rather than a string the read composed.
  const named = /** @type {{id: string}|undefined} */ (/** @type {unknown} */ (db.prepare(
    'SELECT id FROM runs WHERE id=?').get(String(gamma.lastFailure?.runId))));
  assert.equal(named?.id, gamma.lastFailure?.runId, 'the failure names the journalled run that recorded it');
  assert.match(String(gamma.lastFailure?.runId), /^collect-\d{8}T\d{9}Z-[0-9a-f]{8}$/);
});

test('a repository whose last failure is rate limited is degraded, and the recorded message is carried', async (t) => {
  const { health } = await everyState(t);
  const beta = entryFor(health, 'owner/beta');

  assert.equal(beta.state, REPOSITORY_STATE_DEGRADED);
  assert.equal(beta.needsReauthentication, false, 'a rate limit is not a refused credential');
  assert.equal(beta.stalled, false, 'its last success is inside the threshold');
  assert.equal(beta.consecutiveFailures, 1);
  assert.equal(beta.lastSuccessAt, new Date(RECENT_AT).toISOString(),
    'a degraded repository still reports the last success it had');
  assert.equal(beta.lastFailure?.kind, 'rate-limited');
  assert.ok(beta.reason.startsWith('degraded: '));
  assert.match(beta.reason, /1 collection failed in a row/);
  assert.match(beta.reason, /rate-limited/, 'the recorded kind travels with the state');
});

test('a repository GitHub no longer serves is reported unavailable with the reason it gave', async (t) => {
  const { db, health } = await everyState(t);
  const delta = entryFor(health, 'owner/delta');

  assert.equal(delta.unavailable, true);
  assert.equal(delta.state, REPOSITORY_STATE_UNAVAILABLE);
  assert.equal(delta.lifecycle, 'unavailable');
  assert.match(String(delta.unavailableReason), /^GitHub answered HTTP 404 for owner\/delta: /,
    'the reason the run recorded is the reason reported');
  assert.ok(delta.reason.startsWith('unavailable: '));
  assert.ok(delta.reason.includes('HTTP 404'), 'the sentence announces the recorded reason, not just a badge');
  assert.equal(getRepository(db, idOf(db, 'delta')).enrolled, 1, 'a vanished repository keeps its enrolment');
});

test('the stalled boundary is 26 hours, read from the recorded success against an injected clock', async (t) => {
  const { db } = await everyState(t);
  const quiet = idOf(db, 'quiet');
  const recorded = getRepository(db, quiet).lastSuccessAt;
  assert.equal(recorded, new Date(STALE_AT).toISOString(), 'the success was recorded thirty hours before the read');

  /** @param {number} nowMs @returns {import('../src/supervision/health.js').RepositoryHealth} */
  const at = (nowMs) => repositoryHealth(db, quiet, nowMs);

  // The stored success is the only input; the clock is the only other one.
  const healthy = at(Date.parse(recorded) + 25 * HOUR_MS);
  assert.equal(healthy.state, REPOSITORY_STATE_HEALTHY, '25 hours is inside the threshold');
  assert.equal(healthy.stalled, false);
  assert.equal(healthy.sinceLastSuccessMs, 25 * HOUR_MS);
  assert.match(healthy.reason, /^healthy: /);

  const boundary = at(Date.parse(recorded) + 26 * HOUR_MS);
  assert.equal(boundary.state, REPOSITORY_STATE_HEALTHY, 'the threshold is strict: exactly 26 hours has not passed it');

  const stalled = at(Date.parse(recorded) + 27 * HOUR_MS);
  assert.equal(stalled.state, REPOSITORY_STATE_STALLED, '27 hours past the last success is stalled');
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.lastSuccessAt, recorded);
  assert.equal(stalled.sinceLastSuccessMs, 27 * HOUR_MS);
  assert.equal(stalled.reason,
    'stalled: the last successful collection was 1 day ago, past the 26-hour threshold, so scheduled collection '
    + 'has stopped');

  // A clock behind the recorded success reads as zero elapsed rather than negative.
  const behind = at(Date.parse(recorded) - 5 * HOUR_MS);
  assert.equal(behind.sinceLastSuccessMs, 0);
  assert.equal(behind.stalled, false);
});

test('a repository that is both unavailable and stalled reports unavailable without hiding the stall', async (t) => {
  const { db } = await archiveOf(t);
  await collectOne(db, { repo: 'owner/alpha', at: STALE_AT });
  const alpha = idOf(db, 'alpha');
  await collectOne(db, { repo: 'owner/alpha', at: ATTEMPT_AT, vanished: 'owner/alpha' });

  const entry = repositoryHealth(db, alpha, READ_AT_MS);
  assert.equal(entry.unavailable, true);
  assert.equal(entry.stalled, true, 'the stall is still reported beside the top word');
  assert.equal(entry.state, REPOSITORY_STATE_UNAVAILABLE,
    'the single named state is the most actionable one in the documented order');
  assert.ok(entry.reason.startsWith('unavailable: '), 'and the sentence announces the state it carries');
  // The roll-up counts the stall too, so collapsing the two into one word would lose it.
  const rolled = summariseHealth([entry]);
  assert.equal(rolled.state, REPOSITORY_STATE_UNAVAILABLE);
  assert.equal(rolled.unavailable, 1);
  assert.equal(rolled.stalled, 0,
    'a repository is counted once, under the state that won; the stalled reading stays on the entry');
});

test('a recorded success time this build cannot read is unreadable, never a stall', async (t) => {
  const { db } = await archiveOf(t);
  upsertRepository(db, {
    id: 70, owner: 'owner', name: 'odd', lastSeenAt: iso(RECENT_AT), lastSuccessAt: iso(RECENT_AT), enrolled: 1,
  });
  db.prepare('UPDATE repositories SET last_success_at=? WHERE id=70').run('the day before yesterday');

  const entry = repositoryHealth(db, 70, READ_AT_MS + 99 * HOUR_MS);
  assert.equal(entry.state, REPOSITORY_STATE_UNREADABLE);
  assert.equal(entry.collectionState, 'unreadable');
  assert.equal(entry.stalled, false, 'an unreadable time is not evidence that collection stopped');
  assert.equal(entry.sinceLastSuccessMs, null);
  assert.ok(entry.reason.startsWith('unreadable: '));
  assert.equal(summariseHealth([entry]).state, REPOSITORY_STATE_UNREADABLE);
});

test('a home with no run rows returns an empty repository list and a run summary of never run', async (t) => {
  const { db } = await archiveOf(t);
  assert.equal(rows(db, 'runs'), 0, 'the archive holds no run row');
  assert.equal(rows(db, 'repositories'), 0, 'and no repository has been registered');

  const health = collectionHealth({ db, clock: () => READ_AT_MS });

  assert.deepEqual(health.repositories, [], 'an empty repository list, not an error');
  assert.equal(health.run.state, RUN_STATE_NEVER_RUN);
  assert.equal(health.run.runId, null);
  assert.equal(health.run.status, null);
  assert.equal(health.run.startedAt, null);
  assert.equal(health.run.closedAt, null);
  assert.equal(health.run.durationMs, null);
  assert.equal(health.run.successCount, 0);
  assert.equal(health.run.failureCount, 0);
  assert.equal(health.run.requestCount, 0);
  assert.equal(health.run.open, false, 'no run is open because no run began');
  assert.equal(health.run.unclosedRuns, 0);
  assert.equal(health.run.unclosedRunId, null);
  assert.ok(health.run.reason.startsWith('never run: '),
    'RS-AX-07: the empty case is announced as text, not left as an absence of rows');
  assert.equal(health.summary.state, SUMMARY_STATE_EMPTY);
  assert.ok(health.summary.reason.startsWith('empty: '));
  assert.equal(health.summary.enrolled, 0);
  assert.equal(health.summary.needsAttention, false, 'nothing enrolled is not something to act on');
  assert.equal(health.readAt, new Date(READ_AT_MS).toISOString());

  // The same shape comes back from the home wrapper, which creates and migrates the
  // archive itself, so a first-connect install gets an answer instead of a failure.
  const { home } = await archiveOf(t);
  const wrapped = await healthForHome({ home, clock: () => READ_AT_MS });
  assert.deepEqual(Object.keys(wrapped).sort(), Object.keys(health).sort());
  assert.deepEqual(wrapped.repositories, []);
  assert.equal(wrapped.run.state, RUN_STATE_NEVER_RUN);
  assert.equal(wrapped.summary.state, SUMMARY_STATE_EMPTY);
});

test('the run summary reports the last run, an unclosed run, and a run where every repository failed', async (t) => {
  const { db } = await archiveOf(t);

  // A run that began, recorded one repository and was then killed.
  const killed = createRunJournal({ db, clock: () => STALE_AT });
  const opened = killed.start();
  killed.progress({ completedRepositories: 1 });

  const abandoned = runHealth(db);
  assert.equal(abandoned.state, RUN_STATE_UNCLOSED,
    'the archive cannot tell a run in progress from a killed one, so it says unclosed');
  assert.equal(abandoned.open, true);
  assert.equal(abandoned.runId, opened.runId);
  assert.equal(abandoned.unclosedRuns, 1);
  assert.equal(abandoned.unclosedRunId, opened.runId, 'a dead run can be named rather than merely counted');
  assert.equal(abandoned.durationMs, null, 'a run that never closed has no duration to report');
  assert.ok(abandoned.reason.startsWith('unclosed: '));

  // A later run that did finish, and finished badly.
  const later = createRunJournal({ db, clock: () => READ_AT_MS - 1000 });
  const finished = later.start();
  later.progress({ completedRepositories: 2 });
  later.close({
    status: 'degraded', successCount: 0, failureCount: 2, requestCount: 6, completedRepositories: 2,
  });

  const reported = runHealth(db);
  assert.equal(reported.state, RUN_STATE_DEGRADED, 'a closed run that recorded failures is degraded');
  assert.equal(reported.runId, finished.runId, 'the summary names the most recent run');
  assert.equal(reported.status, 'degraded', "the run's own status word travels with it");
  assert.equal(reported.successCount, 0);
  assert.equal(reported.failureCount, 2);
  assert.equal(reported.requestCount, 6);
  assert.ok(reported.durationMs !== null);
  assert.equal(reported.open, false);
  assert.equal(reported.unclosedRuns, 1, 'the abandoned run is still reported beside the finished one');
  assert.ok(reported.reason.startsWith('degraded: '));

  // A run every repository failed is still a complete run record, and reads as such.
  const summary = await collectRun({
    db,
    config: validateConfig({ enrolled: ENROLLED }),
    filter: 'owner/alpha',
    clock: () => READ_AT_MS,
    policy: scriptedPolicy({ failing: { repo: 'owner/alpha', kind: 'permission-missing' } }),
  });
  assert.equal(summary.status, 'degraded');
  const after = runHealth(db);
  assert.equal(after.state, RUN_STATE_DEGRADED);
  assert.equal(after.runId, summary.runId, 'the identifier the run printed is the one the read reports');
  assert.equal(after.failureCount, 1);
  assert.equal(entryFor(collectionHealth({ db, clock: () => READ_AT_MS }), 'owner/alpha').state,
    REPOSITORY_STATE_NEEDS_REAUTHENTICATION);
});

test('a completed run is reported as completed with its recorded counts', async (t) => {
  const { db } = await archiveOf(t);
  const summary = await collectOne(db, { repo: 'owner/alpha', at: RECENT_AT });

  assert.equal(summary.status, 'completed');
  const health = collectionHealth({ db, clock: () => READ_AT_MS });

  assert.equal(health.run.state, RUN_STATE_COMPLETED);
  assert.equal(health.run.status, 'completed', 'the recorded status word travels with the state');
  assert.equal(health.run.runId, summary.runId);
  assert.equal(health.run.startedAt, iso(RECENT_AT));
  assert.equal(health.run.closedAt, iso(RECENT_AT), 'the whole run happened at the one instant its clock gave it');
  assert.equal(health.run.durationMs, 0);
  assert.equal(health.run.successCount, 1);
  assert.equal(health.run.failureCount, 0);
  assert.equal(health.run.requestCount, summary.totals.requests);
  assert.equal(health.run.open, false);
  assert.equal(health.run.unclosedRuns, 0);
  assert.equal(health.run.unclosedRunId, null);
  assert.ok(health.run.reason.startsWith('completed: '));
  assert.match(health.run.reason, /no failure recorded/);
  assert.equal(health.summary.state, REPOSITORY_STATE_HEALTHY,
    'a single successfully collected repository is a healthy set');

  // The read is repeatable and does not move the run it reports.
  assert.equal(collectionHealth({ db, clock: () => READ_AT_MS }).run.runId, health.run.runId);
});

test('the read is a pure query: it repeats exactly and writes nothing', async (t) => {
  const { db } = await everyState(t);
  const before = ['repositories', 'runs', 'heartbeats', 'repository_errors', 'day_series', 'snapshots', 'backfill_records']
    .map((table) => rows(db, table));

  const first = collectionHealth({ db, clock: () => READ_AT_MS });
  const second = collectionHealth({ db, clock: () => READ_AT_MS });

  assert.deepEqual(second, first, 'two reads over unchanged state agree exactly');
  assert.deepEqual(['repositories', 'runs', 'heartbeats', 'repository_errors', 'day_series', 'snapshots',
    'backfill_records'].map((table) => rows(db, table)), before,
  'the read wrote no row in any table it could have written');
});

test('the read makes no network call with the transport disabled', async (t) => {
  const { home } = await archiveOf(t);
  attemptedHosts.length = 0;

  // The transport is disabled three ways at once: the local-transport gate is off,
  // no base URL override is set, and `globalThis.fetch` is refused for this whole
  // file. A read that reached for a socket would throw rather than pass quietly.
  const previousGate = process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  const previousBase = process.env.REPO_SIGNAL_GITHUB_BASE_URL;
  delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  delete process.env.REPO_SIGNAL_GITHUB_BASE_URL;
  t.after(() => {
    if (previousGate === undefined) delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
    else process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = previousGate;
    if (previousBase === undefined) delete process.env.REPO_SIGNAL_GITHUB_BASE_URL;
    else process.env.REPO_SIGNAL_GITHUB_BASE_URL = previousBase;
  });

  const health = await healthForHome({ home, clock: () => READ_AT_MS });

  assert.deepEqual(attemptedHosts, [], 'the read attempted no outbound request at all');
  assert.deepEqual(health.repositories, []);
  assert.equal(health.run.state, RUN_STATE_NEVER_RUN);

  // And the module cannot reach a socket by construction: it imports no client, no
  // transport and no credential, so there is no transport to disable in the first place.
  const source = readFileSync(new URL('../src/supervision/health.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\s[^;]*from\s'([^']+)';/gm)].map((match) => match[1]);
  for (const specifier of imports) {
    assert.doesNotMatch(specifier, /\/github\//, `the health read must not import a client (found ${specifier})`);
    assert.doesNotMatch(specifier, /\/credentials\//, `the health read must not import credentials (${specifier})`);
    assert.doesNotMatch(specifier, /\/commands\//, `the health read must not import a command (${specifier})`);
  }
  assert.ok(imports.length >= 4, 'the read composes the recorded-state modules rather than re-implementing them');
});

test('the read refuses a clock that cannot tell it the time', async (t) => {
  const { db } = await archiveOf(t);
  upsertRepository(db, { id: 80, owner: 'owner', name: 'timed', lastSeenAt: iso(RECENT_AT), enrolled: 1 });

  assert.throws(() => collectionHealth({ db, clock: () => Number.NaN }), /epoch milliseconds/);
  assert.throws(() => collectionHealth({ db, clock: /** @type {any} */ ('now') }), /clock/);
  assert.throws(() => repositoryHealth(db, 80, Number.NaN), /clock/,
    'elapsed time is measured against an injected clock, never assumed');
});

test('the state precedence is the exported order, so a surface cannot invent its own', () => {
  assert.deepEqual([...REPOSITORY_STATE_PRECEDENCE], [
    'unavailable', 'needs-re-authentication', 'unreadable', 'stalled', 'degraded', 'never-collected', 'healthy',
  ]);
  assert.deepEqual([...new Set(REPOSITORY_STATE_PRECEDENCE)], [...REPOSITORY_STATE_PRECEDENCE],
    'no state appears twice in the precedence order');
  assert.equal(REPOSITORY_STATE_PRECEDENCE.at(-1), REPOSITORY_STATE_HEALTHY,
    'the state that only reports progress comes last, so no other word is hidden behind it');
});