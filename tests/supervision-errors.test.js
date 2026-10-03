import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { appendRun, getRepository, openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { listCommands } from '../src/commands/index.js';
import { createHttpTransport, GitHubTransportError } from '../src/github/http.js';
import { createRetryPolicy } from '../src/github/retry.js';
import { resolveHomePaths } from '../src/paths.js';
import { classifyFailure, FAILURE_KINDS, isFailureKind, needsReauthentication,
  safeFailureMessage, TRAFFIC_PERMISSION } from '../src/supervision/errors.js';
import { createRepoStateReporter, latestFailure, needsReauthenticationFor } from '../src/supervision/repo-state-reporter.js';

/** Obviously fake, and only ever handed to an injected fetch or an injected credential file. */
const token = `github_pat_${'FAKE_TEST_ONLY_'.repeat(4)}`;
const opaqueSecret = 'opaque-value-no-prefix';
const repo = 'example/archive';
const trafficEndpoint = `/repos/${repo}/traffic/clones?per=day`;
const repositoryEndpoint = `/repos/${repo}`;

const firstAttempt = '2026-09-29T01:00:00.000Z';
const secondAttempt = '2026-09-29T02:00:00.000Z';
const thirdAttempt = '2026-09-30T01:00:00.000Z';

/**
 * One outbound attempt is refused by this guard for the whole suite, so a test
 * that reaches the network fails loudly instead of quietly succeeding. The
 * representative failures below inject their own fetch, so they never touch it.
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
 * A failure as the shared transport actually produces it: the real HTTP
 * transport and the real retry policy over an injected fetch, with an injected
 * clock and an injected sleep so no request is retried over real time.
 * @param {number} status
 * @param {{endpointType?: 'repository'|'traffic'|'statistics'|'stargazers', endpoint?: string, rejectWith?: unknown}} [options]
 * @returns {Promise<unknown>} The thrown value, exactly as a client would receive it.
 */
async function httpFailure(status, { endpointType = 'traffic', endpoint = trafficEndpoint, rejectWith } = {}) {
  const transport = createHttpTransport({
    credentialProvider: { getToken: async () => token },
    fetch: async () => {
      if (rejectWith !== undefined) throw rejectWith;
      return new Response('{"message":"scripted by the test"}', { status });
    },
  });
  const policy = createRetryPolicy({
    transport, clock: () => 100_000, sleep: async () => {}, random: () => 0, maxAttempts: 1,
  });
  try {
    await policy.get(endpoint, { endpointType });
  } catch (error) {
    return error;
  }
  throw new Error(`HTTP ${status} did not fail, so it cannot be a representative failure`);
}

/**
 * A temporary home, a migrated archive, one run row and one enrolled repository.
 * @param {import('node:test').TestContext} t
 * @param {{runId?: string, repositories?: {id: number, owner: string, name: string}[]}} [options]
 */
async function archive(t, { runId = 'collect-test-run', repositories = [{ id: 1, owner: 'example', name: 'archive' }] } = {}) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-supervision-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700, 'the home directory is held at 0700');
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  appendRun(db, { id: runId, startedAt: firstAttempt });
  for (const entry of repositories) {
    upsertRepository(db, { ...entry, lastSeenAt: firstAttempt, enrolled: 1 });
  }
  return { db, paths, runId, reporter: createRepoStateReporter({ db }) };
}

/** @param {{kind: string, message: string}} failure */
function assertSingleLine(failure) {
  assert.equal(failure.message.includes('\n'), false, 'a recorded message is one line');
  assert.equal(failure.message.trim(), failure.message);
  assert.ok(failure.message.length > 0);
}

test('a rejected credential is authentication-rejected and names the re-authentication step', async () => {
  const failure = await httpFailure(401);
  const classified = classifyFailure(failure, { repo });
  assert.equal(classified.kind, 'authentication-rejected');
  assert.equal(classified.status, 401);
  assert.equal(classified.endpointType, 'traffic');
  assert.equal(classified.needsReauthentication, true);
  assert.equal(needsReauthentication('authentication-rejected'), true);
  assert.match(classified.message, /HTTP 401 for example\/archive/);
  assert.match(classified.action, /^Replace the token in the home credential file/);
  assert.match(classified.message, /Replace the token in the home credential file/);
  assert.match(classified.message, new RegExp(TRAFFIC_PERMISSION.replace(/[()]/g, '\\$&')));
  assertSingleLine(classified);
});

test('a traffic 403 is permission-missing and names the Administration read permission and its action', async () => {
  const failure = await httpFailure(403);
  const classified = classifyFailure(failure, { repo, endpointType: 'traffic' });
  assert.equal(classified.kind, 'permission-missing');
  assert.equal(classified.status, 403);
  assert.equal(classified.endpointType, 'traffic');
  assert.equal(classified.needsReauthentication, true);
  assert.equal(needsReauthentication('permission-missing'), true);
  assert.match(classified.action, /^Grant the Administration repository permission \(read\) to the token/);
  assert.match(classified.action, /run node src\/cli\.js collect$/);
  assert.match(classified.message, /missing the Administration repository permission \(read\)/);
  // The permission is named once, not doubled into "permission (read) permission".
  assert.equal(/permission\s+permission/.test(classified.message), false);
  // A repository-endpoint 403 is a different permission problem, so it must not
  // claim the traffic permission is the one missing.
  const repositoryFailure = await httpFailure(403, { endpointType: 'repository', endpoint: repositoryEndpoint });
  const fromRepository = classifyFailure(repositoryFailure, { repo, endpointType: 'repository' });
  assert.equal(fromRepository.kind, 'permission-missing');
  assert.equal(fromRepository.endpointType, 'repository');
  assert.match(fromRepository.message, /required by the traffic endpoints only/);
  assert.equal(fromRepository.action.includes('Grant the Administration'), false);
});

test('a star-history 403 names the refusal, never a permission to grant', async () => {
  // The `/stargazers` listing is restricted to admins and collaborators from July
  // 2026, so a 403 on the star family is an access restriction, not a permission the
  // maintainer can grant. Granting everything this tool uses still leaves it refused.
  const endpoint = '/repos/owner/repo/stargazers/history?per_page=30&page=1';
  const failure = await httpFailure(403, { endpointType: 'stargazers', endpoint });
  const classified = classifyFailure(failure, { repo, endpointType: 'stargazers' });
  assert.equal(classified.kind, 'permission-missing', 'it stays one of the six known kinds');
  assert.equal(classified.status, 403);
  assert.equal(classified.endpointType, 'stargazers');
  assert.match(classified.message, /refused the star history for this token/);
  assert.match(classified.message, /traffic endpoints this repository needs are unaffected/);
  assert.equal(/grant the required token permissions/i.test(classified.action), false);
  assert.equal(/Grant the Administration/.test(classified.action), false);
  // The same failure is recognised from its path when no caller says which family it was.
  const fromPath = classifyFailure(await httpFailure(403, { endpoint }));
  assert.equal(fromPath.endpointType, 'stargazers');
  assert.match(fromPath.message, /refused the star history/);
});

test('a repository GitHub does not serve is repository-missing and is never a permission state', async () => {
  const failure = await httpFailure(404, { endpointType: 'repository', endpoint: repositoryEndpoint });
  const classified = classifyFailure(failure, { repo, endpointType: 'repository' });
  assert.equal(classified.kind, 'repository-missing');
  assert.equal(classified.status, 404);
  assert.equal(classified.needsReauthentication, false);
  assert.match(classified.action, /Check the owner and name spelling/);
  assert.equal(classified.message.includes(TRAFFIC_PERMISSION), false);
});

test('an exhausted rate limit is rate-limited and never mistaken for a rejected token', async () => {
  const failure = await httpFailure(429);
  const classified = classifyFailure(failure, { repo });
  assert.equal(classified.kind, 'rate-limited');
  assert.equal(classified.status, 429);
  assert.equal(classified.needsReauthentication, false);
  assert.equal(needsReauthentication('rate-limited'), false);
  assert.match(classified.action, /Wait for GitHub to reset the rate limit/);
});

test('a service failure and an aborted request are both transient', async () => {
  const serviceFailure = await httpFailure(500);
  const service = classifyFailure(serviceFailure, { repo });
  assert.equal(service.kind, 'transient');
  assert.equal(service.status, 500);
  assert.equal(service.needsReauthentication, false);
  assert.match(service.message, /temporary service failure/);

  const aborted = await httpFailure(0, { rejectWith: new DOMException('The operation was aborted.', 'AbortError') });
  const transportFailure = classifyFailure(aborted, { repo });
  assert.equal(transportFailure.kind, 'transient');
  assert.equal(transportFailure.status, null);
  assert.match(transportFailure.message, /GitHub never answered it/);
});

test('a failure that matches no known kind is unexpected and keeps its own cause', async () => {
  const contractFailure = new TypeError('Check the traffic response contract: response must be valid JSON');
  const classified = classifyFailure(contractFailure, { repo });
  assert.equal(classified.kind, 'unexpected');
  assert.equal(classified.status, null);
  assert.equal(classified.needsReauthentication, false);
  assert.match(classified.message, /response must be valid JSON/);
  assert.equal(isFailureKind('retired'), false);
  // A thrown value that is not an error at all is still exactly one kind.
  assert.equal(classifyFailure('collection blew up', { repo }).kind, 'unexpected');
  assert.equal(classifyFailure(undefined, { repo }).kind, 'unexpected');
});

test('exactly one kind is produced per failure and the typed set is six', async () => {
  assert.deepEqual([...FAILURE_KINDS], ['authentication-rejected', 'permission-missing',
    'repository-missing', 'rate-limited', 'transient', 'unexpected']);
  const representatives = {
    'authentication-rejected': await httpFailure(401),
    'permission-missing': await httpFailure(403),
    'repository-missing': await httpFailure(404),
    'rate-limited': await httpFailure(429),
    transient: await httpFailure(503),
    unexpected: new Error('Check the traffic response contract: counts must be non-negative safe integers'),
  };
  for (const kind of FAILURE_KINDS) {
    const classified = classifyFailure(representatives[kind], { repo });
    assert.equal(classified.kind, kind, `${kind} classified from its representative failure`);
    // Classification is pure: no clock, no request, so a second answer is identical.
    assert.deepEqual(classifyFailure(representatives[kind], { repo }), classified);
  }
});

test('a failure that carries only a status is placed by that status and agrees with the typed kind', async () => {
  const byStatus = {
    401: 'authentication-rejected',
    403: 'permission-missing',
    404: 'repository-missing',
    429: 'rate-limited',
    500: 'transient',
    503: 'transient',
    202: 'transient',
    418: 'unexpected',
  };
  for (const [status, kind] of Object.entries(byStatus)) {
    // The traffic path proves the endpoint family the classifier reads for itself,
    // so an untyped 403 still names the traffic permission rather than a guess.
    const untyped = classifyFailure({ status: Number(status), endpoint: trafficEndpoint }, { repo });
    assert.equal(untyped.kind, kind, `an untyped HTTP ${status} is ${kind}`);
    // The typed kind the transport policy already assigned must not disagree.
    // A 202 only becomes a failure at a statistics endpoint: the policy hands a
    // 202 from anywhere else back to the client untouched, which is its contract.
    const typed = await httpFailure(Number(status), Number(status) === 202 ? { endpointType: 'statistics' } : {});
    assert.equal(classifyFailure(typed, { repo }).kind, kind, `a typed HTTP ${status} is ${kind}`);
  }
  // A request that never completed carries no status, only the transport's code.
  assert.equal(classifyFailure({ code: 'ERR_TRANSPORT_TIMEOUT' }, { repo }).kind, 'transient');
  assert.equal(classifyFailure({ code: 'ERR_TRANSPORT_CONFIGURATION' }, { repo }).kind, 'unexpected');
  assert.equal(classifyFailure({ status: 403 }, { repo }).kind, 'permission-missing');
  assert.equal(classifyFailure({ status: 403, endpoint: repositoryEndpoint }, { repo }).endpointType, 'repository');
});

test('every action a classification records names a command the CLI registers', async () => {
  // Longest name first, so `config check` is tried before `config`.
  const names = listCommands().map((command) => command.name).sort((left, right) => right.length - left.length);
  const invocation = 'node src/cli.js ';
  const failures = [
    await httpFailure(401), await httpFailure(403), await httpFailure(404), await httpFailure(429),
    await httpFailure(500),
    // A refused redirect is the one transport code that names its own next step.
    new GitHubTransportError('ERR_TRANSPORT_REDIRECT',
      'Redirect refused: request the canonical allowlisted endpoint directly', repositoryEndpoint, 301, [token]),
  ];
  for (const error of failures) {
    const { action } = classifyFailure(error, { repo });
    let at = action.indexOf(invocation);
    assert.notEqual(at, -1, `the action names a command to run: ${action}`);
    while (at !== -1) {
      const rest = action.slice(at + invocation.length);
      const named = names.find((name) => {
        const after = rest.slice(name.length);
        return rest.startsWith(name) && (after === '' || !/[a-z-]/.test(after[0]));
      });
      assert.ok(named !== undefined, `"${rest}" after the invocation is a registered command name: ${action}`);
      at = action.indexOf(invocation, at + invocation.length);
    }
  }
  // An unexpected failure has no known next step, so it names no command and
  // keeps the cause instead of inventing one.
  const unexplained = classifyFailure(new Error('Check the snapshot response contract'), { repo });
  assert.equal(unexplained.kind, 'unexpected');
  assert.equal(unexplained.action.includes(invocation), false);
  assert.match(unexplained.message, /snapshot response contract/);
});

test('every kind is recorded against its repository with the run, the time and one append-only row', async (t) => {
  const { db, runId, reporter } = await archive(t);
  const representatives = [
    { kind: 'authentication-rejected', at: firstAttempt, error: await httpFailure(401) },
    { kind: 'permission-missing', at: secondAttempt, error: await httpFailure(403) },
    { kind: 'repository-missing', at: '2026-09-29T03:00:00.000Z', error: await httpFailure(404) },
    { kind: 'rate-limited', at: '2026-09-29T04:00:00.000Z', error: await httpFailure(429) },
    { kind: 'transient', at: '2026-09-29T05:00:00.000Z', error: await httpFailure(500) },
    { kind: 'unexpected', at: '2026-09-29T06:00:00.000Z',
      error: new Error('Check the traffic response contract: entry 3 requires string label fields') },
  ];
  for (const entry of representatives) {
    const recorded = reporter.recordFailure({
      repositoryId: 1, runId, error: entry.error, collectedAt: entry.at, repo,
    });
    assert.equal(recorded.kind, entry.kind);
    assert.equal(recorded.recordedAt, entry.at);
    assert.equal(recorded.consecutiveFailures, representatives.indexOf(entry) + 1);
    assertSingleLine(recorded);
  }
  const rows = db.prepare(`SELECT repository_id AS repositoryId, run_id AS runId, kind, collected_at AS collectedAt
    FROM repository_errors ORDER BY id`).all();
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.kind), representatives.map((entry) => entry.kind));
  assert.equal(rows.every((row) => row.repositoryId === 1 && row.runId === runId), true);
  assert.deepEqual(rows.map((row) => row.collectedAt), representatives.map((entry) => entry.at));
  assert.equal(getRepository(db, 1).consecutiveFailures, 6);
  // Evidence is retained, never rewritten or removed, by any write in this task.
  assert.throws(() => db.exec('DELETE FROM repository_errors'), /cannot be deleted/);
  assert.throws(() => db.exec("UPDATE repository_errors SET message='gone'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM repositories'), /cannot be deleted/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repository_errors').get()?.n, 6);
});

test('a recorded permission failure names the missing permission, its action and the repository', async (t) => {
  const { db, runId, reporter } = await archive(t);
  const failure = await httpFailure(403);
  const recorded = reporter.recordFailure({ repositoryId: 1, runId, error: failure, collectedAt: firstAttempt, repo });
  assert.equal(recorded.kind, 'permission-missing');
  assert.equal(recorded.needsReauthentication, true);
  assert.match(recorded.message, /Administration repository permission \(read\)/);
  assert.match(recorded.action, /^Grant the Administration repository permission \(read\)/);
  assert.match(recorded.message, /Next step: Grant the Administration repository permission \(read\)/);
  const stored = db.prepare('SELECT kind, message FROM repository_errors').get();
  assert.equal(stored?.kind, 'permission-missing');
  assert.equal(stored?.message, recorded.message);
  // RS-SP-02: the state is an action for the maintainer, not a generic error.
  assert.match(/** @type {{message: string}} */ (stored).message, /run node src\/cli\.js collect/);
  assert.equal(needsReauthenticationFor(db, 1), true);
});

test('two consecutive failures report a count of two and a success resets it to zero', async (t) => {
  const { db, runId, reporter } = await archive(t);
  const failure = await httpFailure(503);
  const first = reporter.recordFailure({ repositoryId: 1, runId, error: failure, collectedAt: firstAttempt, repo });
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(getRepository(db, 1).consecutiveFailures, 1);
  const second = reporter.recordFailure({ repositoryId: 1, runId, error: failure, collectedAt: secondAttempt, repo });
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(getRepository(db, 1).consecutiveFailures, 2);
  assert.equal(getRepository(db, 1).lastSuccessAt, null, 'a failing repository has no recorded success');

  const success = reporter.recordSuccess({ repositoryId: 1, collectedAt: thirdAttempt });
  assert.equal(success.consecutiveFailures, 0);
  const stored = getRepository(db, 1);
  assert.equal(stored.consecutiveFailures, 0);
  assert.equal(stored.lastSuccessAt, thirdAttempt);
  assert.equal(stored.lifecycle, 'active', 'a recorded failure never marks a repository unavailable');
  assert.equal(stored.enrolled, 1, 'a recorded failure never unenrols a repository');

  const third = reporter.recordFailure({ repositoryId: 1, runId, error: failure, collectedAt: thirdAttempt, repo });
  assert.equal(third.consecutiveFailures, 1, 'the counter starts a new streak after a success');
});

test('the most recent failure message is retained and earlier evidence is kept after a success', async (t) => {
  const { db, runId, reporter } = await archive(t);
  const rejected = await httpFailure(401);
  reporter.recordFailure({ repositoryId: 1, runId, error: rejected, collectedAt: firstAttempt, repo });
  reporter.recordFailure({ repositoryId: 1, runId, error: rejected, collectedAt: secondAttempt, repo });
  const storedFailure = latestFailure(db, 1);
  assert.equal(storedFailure?.kind, 'authentication-rejected');
  assert.equal(storedFailure?.recordedAt, secondAttempt);
  assert.equal(storedFailure?.runId, runId);
  assert.match(/** @type {{message: string}} */ (storedFailure).message, /Replace the token/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repository_errors').get()?.n, 2);

  // A success clears the counter but never the record of why the token was rejected.
  reporter.recordSuccess({ repositoryId: 1, collectedAt: thirdAttempt });
  assert.equal(getRepository(db, 1).consecutiveFailures, 0);
  assert.equal(latestFailure(db, 1)?.recordedAt, secondAttempt);
  assert.match(/** @type {{message: string}} */ (latestFailure(db, 1)).message, /Replace the token/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repository_errors').get()?.n, 2);
});

test('a repository with no recorded failure is quiet, not broken', async (t) => {
  const { db, runId, reporter } = await archive(t);
  assert.equal(getRepository(db, 1).consecutiveFailures, 0);
  assert.equal(latestFailure(db, 1), null);
  assert.equal(needsReauthenticationFor(db, 1), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repository_errors').get()?.n, 0);
  // A rate-limited failure is recorded, but it is not a re-authentication state.
  reporter.recordFailure({
    repositoryId: 1, runId, error: await httpFailure(429), collectedAt: firstAttempt, repo,
  });
  assert.equal(latestFailure(db, 1)?.kind, 'rate-limited');
  assert.equal(needsReauthenticationFor(db, 1), false);
});

test('the recorded message and the returned action are free of credential material', async (t) => {
  const { db, runId, reporter } = await archive(t);
  const leaky = new Error(`collection failed while sending ${token} and ${opaqueSecret} to GitHub`);
  const recorded = reporter.recordFailure({
    repositoryId: 1, runId, error: leaky, collectedAt: firstAttempt, repo, secrets: [opaqueSecret],
  });
  assert.equal(recorded.message.includes(token), false);
  assert.equal(recorded.message.includes(opaqueSecret), false);
  assert.equal(recorded.action.includes(token), false);
  assert.match(recorded.message, /\[REDACTED\]/);
  const stored = /** @type {{message: string}} */ (db.prepare('SELECT message FROM repository_errors').get());
  assert.equal(stored.message, recorded.message);
  assert.equal(stored.message.includes(token), false);
  assert.equal(stored.message.includes(opaqueSecret), false);
  assert.equal(safeFailureMessage(`line one\nline two\ttabbed ${token}`).includes('\n'), false);
});

test('the reporter joins the caller transaction so a counter cannot advance without its evidence', async (t) => {
  const { db, runId, reporter } = await archive(t);
  const failure = await httpFailure(500);
  assert.throws(() => withTransaction(db, () => {
    reporter.recordFailure({ repositoryId: 1, runId, error: failure, collectedAt: firstAttempt, repo });
    reporter.recordSuccess({ repositoryId: 1, collectedAt: firstAttempt });
    throw new Error('the repository write failed after the state was recorded');
  }), /the repository write failed/);
  assert.equal(getRepository(db, 1).consecutiveFailures, 0, 'the rolled-back failure left no counter behind');
  assert.equal(getRepository(db, 1).lastSuccessAt, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repository_errors').get()?.n, 0,
    'the rolled-back failure left no evidence behind');

  // Committed together, the same two calls leave evidence and a reset streak.
  withTransaction(db, () => {
    reporter.recordFailure({ repositoryId: 1, runId, error: failure, collectedAt: firstAttempt, repo });
  });
  assert.equal(getRepository(db, 1).consecutiveFailures, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repository_errors').get()?.n, 1);
  // Outside a transaction the same call commits on its own.
  reporter.recordFailure({ repositoryId: 1, runId, error: failure, collectedAt: secondAttempt, repo });
  assert.equal(getRepository(db, 1).consecutiveFailures, 2);
});

test('recording a failure never throws and never decides that the run continues', async (t) => {
  const { db, runId, reporter } = await archive(t);
  for (const error of [await httpFailure(401), await httpFailure(403), await httpFailure(404),
    await httpFailure(429), await httpFailure(500), new Error('a client contract refusal')]) {
    const recorded = reporter.recordFailure({
      repositoryId: 1, runId, error, collectedAt: firstAttempt, repo,
    });
    assert.ok(isFailureKind(recorded.kind));
    assertSingleLine(recorded);
  }
  assert.equal(getRepository(db, 1).consecutiveFailures, 6);
  assert.equal(getRepository(db, 1).lifecycle, 'active');
  // An identity the archive does not hold is a caller error, not a recorded failure.
  assert.throws(() => reporter.recordFailure({
    repositoryId: 999, runId, error: new Error('x'), collectedAt: firstAttempt, repo,
  }), /Unknown repository 999/);
  // A collection instant is required; no wall clock is ever invented for it.
  assert.throws(() => reporter.recordFailure({
    repositoryId: 1, runId, error: new Error('x'), collectedAt: 'yesterday', repo,
  }), /canonical UTC ISO timestamp/);
});

test('the collector reaches classification through the reporter, not through the classifier internals', () => {
  const run = readFileSync(new URL('../src/collect/run.js', import.meta.url), 'utf8');
  assert.equal(/supervision[\\/]errors\.js/.test(run), false,
    'the run reports a failure through the reporter instead of importing the classifier itself');
  const reporter = readFileSync(new URL('../src/supervision/repo-state-reporter.js', import.meta.url), 'utf8');
  assert.match(reporter, /import \{ classifyFailure, needsReauthentication \} from '\.\/errors\.js';/,
    'the reporter is the single place the classifier is called from');
});

test('no request in this suite reached the network', () => {
  assert.deepEqual(refusedHosts, [], 'the armed fetch guard refused nothing because nothing called it');
});
