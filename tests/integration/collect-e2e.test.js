import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { redact } from '../../src/credentials/redact.js';
import { createStubGitHub } from '../helpers/stub-github-server.mjs';

// The whole collection pipeline, driven through the real entry point
// (`node src/cli.js collect`) over a temporary home and a real migrated archive,
// with the local GitHub stub standing in for api.github.com.
//
// What only a full run can show is asserted here, always against the archive and
// never against a returned summary: how many day rows a returned window
// produces, what a second run over the same window does and does not touch, that
// a statistics endpoint answering 202 and then 200 is survived rather than
// stored, and that a run mixing a failing and a succeeding repository still
// closes one complete run record.
//
// No test in this file uses a real token and no test in this file may reach any
// host: each spawned process runs with a fetch recorder preloaded, which writes
// every URL the process asks for to a log and refuses anything outside the
// loopback stub. An assertion over that log is what makes the guarantee
// mechanical rather than assumed.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
/** Obviously fake, token-shaped, and never a real credential. */
const FIXTURE_TOKEN = 'ghp_' + 'OBVIOUSLY_FAKE_COLLECTION_E2E_TOKEN';
const TOKEN_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/;
/** RS-PR-01: a collect run over six repositories completes in under 60 s. */
const RUN_BUDGET_MS = 60_000;

/** One day row per metric per returned day: clones, unique cloners, views, unique visitors. */
const TRAFFIC_METRICS = ['clones', 'unique-cloners', 'views', 'unique-visitors'];
const REFERRERS = [
  { referrer: 'example.org', count: 12, uniques: 7 },
  { referrer: 'news.example', count: 4, uniques: 3 },
];
const POPULAR_PATHS = [{ path: '/', title: 'RepoSignal', count: 30, uniques: 18 }];
const SNAPSHOT_ROWS_PER_RUN = REFERRERS.length + POPULAR_PATHS.length;
const STARGAZERS = [
  { starred_at: '2026-08-01T10:00:00Z' },
  { starred_at: '2026-08-01T12:00:00Z' },
  { starred_at: '2026-08-20T09:00:00Z' },
];
/** Week-start Unix seconds for two weeks, as the commit-activity endpoint stamps them. */
const COMMIT_ACTIVITY = ['2026-09-14T00:00:00Z', '2026-09-21T00:00:00Z'].map((week, index) => ({
  week: Date.parse(week) / 1000, total: 4 + index, days: [1, 2, 0, 1, 0, 0, 0],
}));
const PARTICIPATION = { all: [10, 12], owner: [3, 4] };
/** The 202 GitHub sends while its statistics cache is compiling: no weekly shape at all. */
const STATISTICS_COMPILING = { status: 202, json: { message: 'Statistics are being compiled' } };

/**
 * @param {string} lastDay
 * @param {number} count
 * @returns {string[]} Ascending UTC days ending at `lastDay`, the shape GitHub serves for `per=day`.
 */
function dayWindow(lastDay, count) {
  const last = Date.parse(`${lastDay}T00:00:00Z`);
  const days = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    days.push(new Date(last - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

/** The rolling 14-day window every run in this file is scripted with. */
const WINDOW = dayWindow('2026-10-02', 14);
const FIRST_DAY = /** @type {string} */ (WINDOW[0]);

/**
 * Each repository is scripted with its own counts, derived from the digits its
 * name ends in, so a fact written under the wrong identity is visible instead of
 * being averaged away between two repositories that returned the same numbers.
 * @param {string} pathname Request path, which carries the owner and name.
 * @returns {number}
 */
function seedOf(pathname) {
  const match = /(\d+)$/.exec(pathname.split('/')[3] ?? '');
  return match === null ? 0 : Number(match[1]);
}

/**
 * The exact clones count the stub served one repository for one day, so the
 * archive is compared with what GitHub returned rather than with a summary line.
 * A run that serves fewer days numbers them from the first day it did return, so
 * the served list is part of the expectation.
 * @param {string} repo owner/name pair
 * @param {string} day
 * @param {number} offset
 * @param {string[]} [days] the days the stub served for that request.
 * @returns {number}
 */
function servedClones(repo, day, offset, days = WINDOW) {
  const index = days.indexOf(day);
  assert.notEqual(index, -1, `${day} must be one of the days the stub served`);
  return index + offset + seedOf(`/repos/${repo}`) * 10;
}

/** @param {string} repo @param {string} day @param {number} offset @param {string[]} [days] @returns {number} */
function servedViews(repo, day, offset, days = WINDOW) {
  return 30 + servedClones(repo, day, offset, days);
}

/**
 * @param {string} day
 * @param {string[]} [days] the days the stub served for that request.
 * @returns {number}
 */
function servedUniques(day, days = WINDOW) {
  return 1 + days.indexOf(day);
}

/**
 * The source of a preload module for the spawned process. It records every URL
 * the process asks `fetch` for and refuses anything that is not the loopback
 * stub, so "no test reaches any host" is an assertion over a file rather than a
 * promise. The recorder is test-local and lives only in the temporary directory
 * a run is given; nothing under src/ knows it exists.
 */
const FETCH_RECORDER_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  'const allowed = process.env.REPO_SIGNAL_TEST_ALLOWED_ORIGIN ?? "";',
  'const log = process.env.REPO_SIGNAL_TEST_FETCH_LOG ?? "";',
  'const real = globalThis.fetch;',
  'globalThis.fetch = function recordingFetch(input, init) {',
  '  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);',
  '  if (log !== "") appendFileSync(log, url + "\\n");',
  '  if (!url.startsWith(allowed)) return Promise.reject(new Error("blocked by the test: " + url));',
  '  return real(input, init);',
  '};',
  '',
].join('\n');

/**
 * Write the recorder into a scratch directory and return its path, so it can be
 * preloaded with `node --import` rather than shipped as another test file.
 * @param {string} directory
 * @returns {string}
 */
function writeFetchRecorder(directory) {
  const recorder = path.join(directory, 'fetch-recorder.mjs');
  writeFileSync(recorder, FETCH_RECORDER_SOURCE, { mode: 0o600 });
  return recorder;
}

/**
 * @typedef {object} SpawnResult
 * @property {number|null} status Exit code, or null when a signal ended the child.
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {object} CollectionFixture
 * @property {string} home Temporary home the command ran against.
 * @property {string} databasePath
 * @property {import('../helpers/stub-github-server.mjs').StubGitHub} stub
 * @property {(args: string[]) => Promise<SpawnResult>} run
 * @property {<T>(body: (db: DatabaseSync) => T) => T} archive Read the archive a spawned command left behind.
 * @property {() => string[]} fetchTargets Every URL a spawned process asked `fetch` for.
 */

/**
 * A temporary home with a configuration and a 0600 credential file, the local
 * GitHub stub, and a `run` that spawns the real entry point against both. Every
 * test gets its own home and its own stub, so parallel files cannot collide and
 * the developer's own archive is never opened.
 * @param {import('node:test').TestContext} t
 * @param {string[]} enrolled owner/name pairs, in enrolled order
 * @returns {Promise<CollectionFixture>}
 */
async function createCollectionHome(t, enrolled) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-collect-e2e-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enrolled }, null, 2), { mode: 0o600 });
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ token: FIXTURE_TOKEN }), { mode: 0o600 });

  const recorder = writeFetchRecorder(root);
  const fetchLog = path.join(root, 'fetch-targets.log');

  const stub = createStubGitHub({ token: FIXTURE_TOKEN });
  t.after(() => stub.stop());
  const baseUrl = await stub.start();

  /**
   * @param {string[]} args
   * @returns {Promise<SpawnResult>}
   */
  const run = async (args) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: {
        ...process.env,
        REPO_SIGNAL_HOME: home,
        // The only network path this file permits, and only because it points at loopback.
        REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: '1',
        REPO_SIGNAL_GITHUB_BASE_URL: baseUrl,
        REPO_SIGNAL_TEST_ALLOWED_ORIGIN: baseUrl,
        REPO_SIGNAL_TEST_FETCH_LOG: fetchLog,
        NODE_OPTIONS: `--import ${pathToFileURL(recorder).href}`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve) => child.on('close', resolve));
    return { status, stdout, stderr };
  };

  /**
   * Read the archive the spawned commands left behind.
   * @template T
   * @param {(db: DatabaseSync) => T} body
   * @returns {T}
   */
  const archive = (body) => {
    const db = new DatabaseSync(path.join(home, 'archive.sqlite3'));
    try {
      return body(db);
    } finally {
      db.close();
    }
  };

  const fetchTargets = () => (existsSync(fetchLog)
    ? readFileSync(fetchLog, 'utf8').split('\n').filter((line) => line !== '')
    : []);

  return { home, databasePath: path.join(home, 'archive.sqlite3'), stub, run, archive, fetchTargets };
}

/**
 * Script the identity resolution every repository is confirmed through before a
 * single fact is written. GitHub answers with the identity it currently holds.
 * @param {import('../helpers/stub-github-server.mjs').StubGitHub} stub
 */
function scriptResolution(stub) {
  stub.route('GET /repos/:owner/:name', (request) => {
    const requested = request.path.slice('/repos/'.length);
    const [owner, name] = requested.split('/');
    return {
      json: {
        id: 1000 + seedOf(request.path), name, full_name: `${owner}/${name}`,
        owner: { login: owner, type: 'User' },
        stargazers_count: 3, forks_count: 1, watchers_count: 3,
      },
    };
  });
}

/**
 * Script the traffic endpoints. `days` is exactly what the stub serves, so a day
 * left out of it is a day GitHub never observed, and `offset` makes a later run
 * revise the same window instead of repeating it. One repository's endpoints can
 * be made to fail with the permission the transport reports as missing.
 * @param {import('../helpers/stub-github-server.mjs').StubGitHub} stub
 * @param {object} options
 * @param {string[]} options.days
 * @param {number} [options.offset]
 * @param {string|null} [options.failing] owner/name pair whose traffic endpoints answer 403.
 */
function scriptTraffic(stub, options) {
  const { days, offset = 0, failing = null } = options;
  /** @param {{path: string}} request @param {string} repo */
  const owned = (request, repo) => request.path.startsWith(`/repos/${repo}/`);
  /** @param {{path: string}} request @returns {boolean} */
  const refused = (request) => failing !== null && owned(request, failing);
  /**
   * @param {{path: string}} request
   * @returns {Array<{day: string, count: number, uniques: number, views: number}>}
   */
  const entriesFor = (request) => {
    const seed = seedOf(request.path);
    return days.map((day, index) => ({
      day, count: index + offset + seed * 10, uniques: 1 + index, views: 30 + index + offset + seed * 10,
    }));
  };
  /** @param {Array<{count: number, uniques: number, views: number}>} entries @param {'count'|'uniques'|'views'} which */
  const sum = (entries, which) => entries.reduce((total, entry) => total + entry[which], 0);
  stub.route('GET /repos/:owner/:name/traffic/clones', (request) => {
    if (refused(request)) {
      return { status: 403, json: { message: 'Requires Administration repository permission (read)' } };
    }
    const entries = entriesFor(request);
    return {
      json: {
        count: sum(entries, 'count'), uniques: sum(entries, 'uniques'),
        clones: entries.map((entry) => ({ timestamp: `${entry.day}T00:00:00Z`, count: entry.count, uniques: entry.uniques })),
      },
    };
  });
  stub.route('GET /repos/:owner/:name/traffic/views', (request) => {
    const entries = entriesFor(request);
    return {
      json: {
        count: sum(entries, 'views'), uniques: sum(entries, 'uniques'),
        views: entries.map((entry) => ({ timestamp: `${entry.day}T00:00:00Z`, count: entry.views, uniques: entry.uniques })),
      },
    };
  });
  stub.route('GET /repos/:owner/:name/traffic/popular/referrers', () => ({ json: REFERRERS }));
  stub.route('GET /repos/:owner/:name/traffic/popular/paths', () => ({ json: POPULAR_PATHS }));
}

/**
 * Script the first-connect backfill endpoints. A statistics endpoint may be
 * scripted as a sequence, which is how "202 once and 200 afterwards" is served.
 * @param {import('../helpers/stub-github-server.mjs').StubGitHub} stub
 * @param {{ commitActivity?: import('../helpers/stub-github-server.mjs').StubReply,
 *   participation?: import('../helpers/stub-github-server.mjs').StubReply }} [options]
 */
function scriptBackfill(stub, options = {}) {
  stub.route('GET /repos/:owner/:name/stargazers*', () => ({ json: STARGAZERS }));
  stub.route('GET /repos/:owner/:name/stats/commit_activity', options.commitActivity ?? { json: COMMIT_ACTIVITY });
  stub.route('GET /repos/:owner/:name/stats/participation', options.participation ?? { json: PARTICIPATION });
}

/** @param {string} output @returns {string[]} */
function lines(output) {
  return output.split('\n').filter((line) => line !== '');
}

/** @param {SpawnResult} result @param {string} label */
function assertNoCredentialMaterial(result, label) {
  for (const line of [...lines(result.stdout), ...lines(result.stderr)]) {
    assert.doesNotMatch(line, TOKEN_SHAPE, `${label}: no printed line carries a token-shaped value`);
    assert.equal(redact(line), line, `${label}: every printed line passes the redaction helper unchanged`);
  }
}

/**
 * @param {string} stdout
 * @returns {string} the run identifier the summary line printed.
 */
function runIdOf(stdout) {
  const match = /summary run=(collect-\S+)/.exec(stdout);
  assert.ok(match !== null, `the summary must name the run it wrote; got ${JSON.stringify(stdout)}`);
  return /** @type {string} */ (match[1]);
}

/** @param {DatabaseSync} db @param {string} table @param {string} [where] @returns {number} */
function count(db, table, where = '') {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get()?.n);
}

/**
 * @param {DatabaseSync} db
 * @param {string} repo owner/name pair
 * @returns {number} the identity the archive allocated for it.
 */
function repositoryId(db, repo) {
  const [owner, name] = repo.split('/');
  const row = db.prepare('SELECT id FROM repositories WHERE owner=? AND name=?').get(owner, name);
  assert.ok(row !== undefined, `${repo} must be registered before the archive can be read for it`);
  return Number(row.id);
}

/**
 * The days a repository's collected traffic covers. Backfill evidence has its own
 * granularity and its own source, so it is not part of a returned window.
 * @param {DatabaseSync} db
 * @param {number} id
 * @param {string|null} [metric] Restrict to one metric key.
 * @returns {string[]} the distinct stored days, ascending. A missing day is absent here, never zero.
 */
function collectedDays(db, id, metric = null) {
  const observed = metric === null
    ? db.prepare(`SELECT DISTINCT day FROM day_series WHERE repository_id=? AND source='collected'
        AND granularity='day' ORDER BY day`).all(id)
    : db.prepare(`SELECT DISTINCT day FROM day_series WHERE repository_id=? AND metric=?
        AND source='collected' AND granularity='day' ORDER BY day`).all(id, metric);
  return observed.map((row) => String(row.day));
}

/**
 * @param {DatabaseSync} db
 * @param {number} id
 * @param {string} metric
 * @param {string} day
 * @returns {number|null} null when the archive holds no row for that key at all.
 */
function dayValue(db, id, metric, day) {
  const row = db.prepare(`SELECT value FROM day_series
    WHERE repository_id=? AND metric=? AND granularity='day' AND day=?`).get(id, metric, day);
  return row === undefined ? null : Number(row.value);
}

/**
 * One entry per capture: which run observed it and when. A second run over the
 * same list adds a second entry; it never merges into the first.
 * @param {DatabaseSync} db
 * @param {number} id
 * @returns {Array<{runId: string, collectedAt: string}>}
 */
function captures(db, id) {
  return db.prepare(`SELECT DISTINCT run_id AS runId, collected_at AS collectedAt FROM snapshots
    WHERE repository_id=? ORDER BY collected_at, id`).all(id)
    .map((row) => ({ runId: String(row.runId), collectedAt: String(row.collectedAt) }));
}

/**
 * @param {DatabaseSync} db
 * @param {string} runId
 * @returns {{id: string, startedAt: string, closedAt: string|null, status: string,
 *   successCount: number, failureCount: number, requestCount: number, durationMs: number|null}}
 */
function runRow(db, runId) {
  const row = db.prepare(`SELECT id, started_at AS startedAt, closed_at AS closedAt, status,
    success_count AS successCount, failure_count AS failureCount, request_count AS requestCount,
    duration_ms AS durationMs FROM runs WHERE id=?`).get(runId);
  assert.ok(row !== undefined, `the run row ${runId} must exist in the journal`);
  return {
    id: String(row.id),
    startedAt: String(row.startedAt),
    closedAt: row.closedAt === null ? null : String(row.closedAt),
    status: String(row.status),
    successCount: Number(row.successCount),
    failureCount: Number(row.failureCount),
    requestCount: Number(row.requestCount),
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
  };
}

/**
 * Prove that the whole file stayed off the network: every URL any spawned process
 * asked for belongs to the loopback stub, the stub received exactly as many
 * requests as the recorder logged, and the run journal never counts more requests
 * than were actually made. A request to any other host would appear in the log
 * before the recorder refused it.
 *
 * The journal counts the requests the run asked the policy for, so a retried
 * endpoint is one counted request and two HTTP attempts; the attempt count is
 * therefore asserted where a retry is scripted rather than here.
 * @param {CollectionFixture} f
 * @param {string} label
 */
function assertOnlyStubTraffic(f, label) {
  const origin = f.stub.baseUrl();
  const targets = f.fetchTargets();
  const outside = targets.filter((target) => !target.startsWith(origin));
  assert.deepEqual(outside, [],
    `${label}: every outbound request must stay on the local stub ${origin}; these left it: ${outside.join(', ')}`);
  assert.equal(targets.length, f.stub.requests().length,
    `${label}: the stub must have received every request the recorder logged, and nothing reached it unlogged`);
  const journalled = f.archive((db) => Number(db.prepare('SELECT coalesce(sum(request_count), 0) AS n FROM runs').get()?.n));
  assert.ok(journalled > 0 && journalled <= targets.length,
    `${label}: the run journal counts ${journalled} requests, which is not within the ${targets.length} the recorder logged`);
}

/** A 202 is only retried, never stored, so a later run needs a later collection time than the first. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });

test('the fetch recorder refuses every host but the local stub, so this file cannot reach one', async (t) => {
  // Arrange: the same guard every other test in this file installs, probed
  // directly so the guarantee below is verified rather than assumed.
  const root = mkdtempSync('/tmp/opencode/repo-signal-collect-e2e-recorder-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = writeFetchRecorder(root);
  const fetchLog = path.join(root, 'targets.log');
  const probe = path.join(root, 'probe.mjs');
  writeFileSync(probe, [
    'const allowed = await fetch(process.env.REPO_SIGNAL_TEST_ALLOWED_ORIGIN + "probe");',
    'process.stdout.write("stub=" + allowed.status);',
    'try {',
    '  const escaped = await fetch("https://api.github.com/");',
    '  process.stdout.write(" escaped=" + escaped.status);',
    '} catch (error) {',
    '  process.stdout.write(" refused=" + error.message);',
    '}',
  ].join('\n'));

  const stub = createStubGitHub({ token: FIXTURE_TOKEN });
  t.after(() => stub.stop());
  const baseUrl = await stub.start();

  const child = spawn(process.execPath, [probe], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${pathToFileURL(recorder).href}`,
      REPO_SIGNAL_TEST_ALLOWED_ORIGIN: baseUrl,
      REPO_SIGNAL_TEST_FETCH_LOG: fetchLog,
    },
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const status = await new Promise((resolve) => child.on('close', resolve));

  // The stub answered the allowed origin and refused the GitHub host, before any
  // socket for it could be opened.
  assert.equal(status, 0);
  assert.equal(stdout, 'stub=404 refused=blocked by the test: https://api.github.com/',
    `the recorder must allow the stub and refuse api.github.com; got ${JSON.stringify(stdout)}`);
  assert.deepEqual(readFileSync(fetchLog, 'utf8').split('\n').filter((line) => line !== ''),
    [`${baseUrl}probe`, 'https://api.github.com/'],
    'both attempts are recorded, so a run that reached a host could not hide it');
});

test('two runs over the same window leave every day row in place and double the captures', async (t) => {
  // Arrange: two enrolled repositories, each served its own counts, over a
  // fourteen-day window. Nothing exists yet but the home.
  const enrolled = ['owner/alpha-1', 'owner/beta-2'];
  const f = await createCollectionHome(t, enrolled);
  scriptResolution(f.stub);
  scriptTraffic(f.stub, { days: WINDOW, offset: 0 });
  scriptBackfill(f.stub);

  // Act: the first run against an archive that does not exist yet.
  const first = await f.run(['collect']);

  // Assert: the run succeeded, reported each repository once, and wrote nothing
  // to the error stream.
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '', 'a completed run prints no error line');
  assertNoCredentialMaterial(first, 'first run');
  const printed = lines(first.stdout);
  assert.equal(printed.length, 3, `one line per repository and one summary; got ${JSON.stringify(printed)}`);
  const firstRunId = runIdOf(first.stdout);
  assert.match(printed[0], new RegExp(`^${enrolled[0]} ok ${WINDOW.length} days written `));
  assert.match(printed[1], new RegExp(`^${enrolled[1]} ok ${WINDOW.length} days written `));
  assert.match(printed[2], new RegExp(`^summary run=${firstRunId} repositories=2 ok=2 failed=0 unavailable=0 ` +
    'skipped=0 .* status=completed$'));

  // The day-row count equals the days the stub returned, read from the archive
  // rather than from the summary the command printed.
  f.archive((db) => {
    assert.equal(count(db, 'repositories'), 2);
    for (const repo of enrolled) {
      const id = repositoryId(db, repo);
      const collected = count(db, 'day_series', `WHERE repository_id=${id} AND source='collected'`);
      assert.equal(collected, WINDOW.length * TRAFFIC_METRICS.length,
        `${repo}: expected ${WINDOW.length} returned days x ${TRAFFIC_METRICS.length} traffic metrics = ` +
        `${WINDOW.length * TRAFFIC_METRICS.length} day rows, found ${collected}`);
      assert.deepEqual(collectedDays(db, id), WINDOW,
        `${repo}: the stored days must be exactly the days GitHub returned, with no day added and none dropped`);
      assert.deepEqual(collectedDays(db, id, 'unique-visitors'), WINDOW,
        `${repo}: every traffic metric key covers the same returned window`);
      // The values are the ones the stub served, not a summary of them.
      assert.equal(dayValue(db, id, 'clones', FIRST_DAY), servedClones(repo, FIRST_DAY, 0));
      assert.equal(dayValue(db, id, 'views', FIRST_DAY), servedViews(repo, FIRST_DAY, 0));
      assert.equal(dayValue(db, id, 'unique-cloners', FIRST_DAY), servedUniques(FIRST_DAY));
      // One snapshot capture per repository, carrying every entry it returned.
      assert.equal(count(db, 'snapshots', `WHERE repository_id=${id}`), SNAPSHOT_ROWS_PER_RUN);
      assert.deepEqual(captures(db, id), [{ runId: firstRunId, collectedAt: runRow(db, firstRunId).startedAt }],
        `${repo}: the capture names the run that observed it`);
    }
    assert.notEqual(dayValue(db, repositoryId(db, enrolled[0]), 'clones', FIRST_DAY),
      dayValue(db, repositoryId(db, enrolled[1]), 'clones', FIRST_DAY),
      'one repository\'s traffic must never be stored under another repository\'s identity');

    // One complete run row, journalled once for the whole run.
    const run = runRow(db, firstRunId);
    assert.notEqual(run.closedAt, null, 'the run closed');
    assert.equal(run.status, 'completed');
    assert.equal(run.successCount, 2);
    assert.equal(run.failureCount, 0);
    // Per repository: one identity resolution, one stargazer page, the two
    // statistics endpoints and the four traffic endpoints.
    assert.equal(run.requestCount, 2 * 8);
    assert.equal(typeof run.durationMs, 'number');
    assert.equal(count(db, 'runs'), 1, 'the journal holds the one run this command wrote');
    assert.equal(count(db, 'repository_errors'), 0, 'a run that collected everything records no failure evidence');
    // The first-connect backfill ran once per repository and was labelled as backfill.
    assert.equal(count(db, 'backfill_records', "WHERE kind='development'"), 2);
    assert.equal(count(db, 'backfill_records', "WHERE kind='first-collected'"), 2);
    assert.equal(count(db, 'backfill_records', `WHERE kind='first-collected' AND window_from='${FIRST_DAY}'`), 2,
      'the provenance boundary is the first day collected data exists');
  });

  const before = f.archive((db) => ({
    days: count(db, 'day_series'),
    snapshots: count(db, 'snapshots'),
    collectedAt: String(db.prepare('SELECT max(collected_at) AS t FROM day_series').get()?.t),
  }));

  // Act again: GitHub re-serves the same rolling window with revised counts. The
  // stub keeps its first run's requests, so the second run's requests are the ones
  // after them rather than a reset history.
  const firstRequests = f.stub.paths();
  assert.equal(firstRequests.length, 2 * 8, 'the first run asked for eight endpoints per repository');
  scriptTraffic(f.stub, { days: WINDOW, offset: 5 });
  await settle();
  const second = await f.run(['collect']);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '', 'a completed second run prints no error line');
  assertNoCredentialMaterial(second, 'second run');
  const secondRunId = runIdOf(second.stdout);
  assert.notEqual(secondRunId, firstRunId, 'each run is journalled under its own identifier');

  // The second run changes no row identity and adds a second capture.
  f.archive((db) => {
    assert.equal(count(db, 'day_series'), before.days,
      `the second run over the same window must leave the day-row count at ${before.days}, found ${count(db, 'day_series')}`);
    assert.equal(count(db, 'day_series', "WHERE source='collected'"), 2 * WINDOW.length * TRAFFIC_METRICS.length);
    assert.equal(count(db, 'snapshots'), before.snapshots * 2,
      `two runs must append two captures, so ${before.snapshots * 2} rows were expected and ${count(db, 'snapshots')} were found`);
    assert.equal(count(db, 'backfill_records'), 4, 'the first-connect backfill is a connect step and did not run again');
    assert.equal(count(db, 'repository_errors'), 0);
    for (const [index, repo] of enrolled.entries()) {
      const id = repositoryId(db, repo);
      assert.equal(count(db, 'day_series', `WHERE repository_id=${id}`),
        WINDOW.length * TRAFFIC_METRICS.length + 6,
        `${repo}: no day row was added, removed or renumbered`);
      assert.deepEqual(collectedDays(db, id), WINDOW, `${repo}: the same keys, under the same identity`);
      assert.equal(dayValue(db, id, 'clones', FIRST_DAY), servedClones(repo, FIRST_DAY, 5),
        `${repo}: the same key was corrected in place with the value the second run returned`);
      // Two captures, side by side, each naming the run that observed it.
      assert.deepEqual(captures(db, id), [
        { runId: firstRunId, collectedAt: runRow(db, firstRunId).startedAt },
        { runId: secondRunId, collectedAt: runRow(db, secondRunId).startedAt },
      ], `${repo}: both captures survive with their own capture time and run`);
    }
    assert.ok(String(db.prepare('SELECT max(collected_at) AS t FROM day_series').get()?.t) > before.collectedAt,
      'the correction carries a newer collection time than the row it replaced');
    const run = runRow(db, secondRunId);
    assert.notEqual(run.closedAt, null);
    assert.equal(run.status, 'completed');
    assert.equal(run.successCount, 2);
    assert.equal(run.failureCount, 0);
    assert.equal(run.requestCount, 10, 'a second run asks for the identity and the four traffic endpoints per repository');
    assert.equal(count(db, 'runs'), 2);
  });

  // The second run asked for no star or statistics page: those belong to connect.
  const secondRequests = f.stub.paths().slice(firstRequests.length);
  assert.deepEqual(secondRequests.filter((observed) => observed.includes('/stargazers')
    || observed.includes('/stats/')), [], 'the backfill must not repeat on a second run');
  assert.deepEqual(secondRequests, enrolled.flatMap((repo) => [
    `/repos/${repo}`,
    `/repos/${repo}/traffic/clones`,
    `/repos/${repo}/traffic/views`,
    `/repos/${repo}/traffic/popular/referrers`,
    `/repos/${repo}/traffic/popular/paths`,
  ]), 'the second run reads only the identity and the four traffic endpoints per repository');
  assertOnlyStubTraffic(f, 'two runs over one window');
});

test('a day the stub never returns stays absent, and appears only once GitHub returns it', async (t) => {
  // Arrange: a hole in the middle of the window, so the first run observes a gap
  // between two days it did observe.
  const repo = 'owner/alpha-1';
  const hole = /** @type {string} */ (WINDOW[5]);
  const returned = WINDOW.filter((day) => day !== hole);
  const f = await createCollectionHome(t, [repo]);
  scriptResolution(f.stub);
  scriptTraffic(f.stub, { days: returned, offset: 0 });
  scriptBackfill(f.stub);

  // Act: the first run only ever sees the window without the hole.
  const first = await f.run(['collect']);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '', 'a completed run prints no error line');
  assertNoCredentialMaterial(first, 'run that observed a gap');
  const firstRunId = runIdOf(first.stdout);
  f.archive((db) => {
    const id = repositoryId(db, repo);
    assert.equal(count(db, 'day_series', `WHERE repository_id=${id} AND day='${hole}'`), 0,
      `the day ${hole} was never returned, so no row exists for it: not a zero, not a carried-forward value`);
    assert.equal(count(db, 'day_series', `WHERE repository_id=${id} AND day='${hole}' AND value=0`), 0,
      'an unobserved day is never written as a zero');
    assert.equal(count(db, 'day_series', `WHERE repository_id=${id} AND source='collected'`),
      returned.length * TRAFFIC_METRICS.length,
      `the first run wrote one row per returned day: ${returned.length} days were served`);
    assert.deepEqual(collectedDays(db, id), returned,
      'the stored days are exactly the days GitHub returned, with the hole left as a gap');
    // Neither neighbour was interpolated, padded or carried forward to cover the gap.
    assert.equal(dayValue(db, id, 'clones', WINDOW[4]), servedClones(repo, WINDOW[4], 0, returned));
    assert.equal(dayValue(db, id, 'clones', WINDOW[6]), servedClones(repo, WINDOW[6], 0, returned));
    assert.equal(dayValue(db, id, 'unique-visitors', WINDOW[6]), servedUniques(WINDOW[6], returned));
  });
  assertOnlyStubTraffic(f, 'the run that observed a gap');

  // Act again: GitHub now serves the whole window, hole included.
  scriptTraffic(f.stub, { days: WINDOW, offset: 0 });
  await settle();
  const second = await f.run(['collect']);

  assert.equal(second.status, 0, second.stderr);
  f.archive((db) => {
    const id = repositoryId(db, repo);
    assert.deepEqual(collectedDays(db, id), WINDOW, 'the newly returned day fills the gap by being observed, not by being invented');
    assert.equal(dayValue(db, id, 'clones', hole), servedClones(repo, hole, 0),
      'the gap holds the value GitHub returned for it, not a value carried from a neighbouring day');
    assert.equal(count(db, 'day_series', `WHERE repository_id=${id} AND source='collected'`),
      WINDOW.length * TRAFFIC_METRICS.length);
    assert.equal(count(db, 'repositories'), 1);
    // The boundary still belongs to the run that first collected data: filling the
    // gap did not move the day or restamp the provenance.
    assert.deepEqual(plainRows(db.prepare(`SELECT window_from AS day, collected_at AS collectedAt
      FROM backfill_records WHERE kind='first-collected'`).all()), [
      { day: FIRST_DAY, collectedAt: runRow(db, firstRunId).startedAt },
    ], 'the first collected boundary was stamped once, by the first run, and never moved');
  });
  assertOnlyStubTraffic(f, 'the run that filled the gap');
});

test('a statistics endpoint answering 202 then 200 is retried, stored as data, and is no error', async (t) => {
  // Arrange: the commit-activity endpoint answers the 202 GitHub sends while its
  // statistics cache is compiling, and the weekly series on the retry.
  const repo = 'owner/alpha-1';
  const f = await createCollectionHome(t, [repo]);
  scriptResolution(f.stub);
  scriptTraffic(f.stub, { days: WINDOW, offset: 0 });
  scriptBackfill(f.stub, { commitActivity: [STATISTICS_COMPILING, { json: COMMIT_ACTIVITY }] });

  // Act: one collection run over that endpoint.
  const result = await f.run(['collect']);

  // Assert: the 202 was survived rather than stored, and the run completed.
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'a statistics 202 that resolves is not an error');
  assertNoCredentialMaterial(result, 'run over a compiling statistics cache');
  const printed = lines(result.stdout);
  assert.equal(printed.length, 2, `one repository line and one summary; got ${JSON.stringify(printed)}`);
  assert.match(printed[0], new RegExp(`^${repo} ok ${WINDOW.length} days written `));
  const runId = runIdOf(result.stdout);
  assert.match(printed[1], new RegExp(`^summary run=${runId} repositories=1 ok=1 failed=0 unavailable=0 skipped=0 ` +
    '.* backfilled=1 requests=\\d+ .* status=completed$'));
  // The endpoint really did answer 202 first, and it was asked again.
  assert.deepEqual(f.stub.paths().filter((observed) => observed.endsWith('/stats/commit_activity')),
    [`/repos/${repo}/stats/commit_activity`, `/repos/${repo}/stats/commit_activity`],
    'the 202 must be retried by the shared policy, not stored as data');

  f.archive((db) => {
    // The stored weekly rows are the ones the 200 returned, labelled as backfill.
    assert.deepEqual(plainWeeklyRows(db), [
      { metric: 'commit-activity', granularity: 'week', day: '2026-09-14', value: 4, source: 'backfill' },
      { metric: 'commit-activity', granularity: 'week', day: '2026-09-21', value: 5, source: 'backfill' },
      { metric: 'owner-participation', granularity: 'week', day: '2026-09-14', value: 3, source: 'backfill' },
      { metric: 'owner-participation', granularity: 'week', day: '2026-09-21', value: 4, source: 'backfill' },
    ]);
    // Nothing was stored from the 202 itself, and no second development record
    // was appended for it.
    assert.equal(count(db, 'day_series', "WHERE granularity='week' AND source='collected'"), 0,
      'weekly rows are backfill evidence only; a collected run never writes a week bucket');
    assert.deepEqual(plainRows(db.prepare(`SELECT kind, window_from AS windowFrom, window_to AS windowTo, truncated
      FROM backfill_records WHERE kind<>'first-collected' ORDER BY kind`).all()), [
      { kind: 'development', windowFrom: '2026-09-14', windowTo: '2026-09-21', truncated: 1 },
    ], 'the development record names the window the 200 actually returned');
    assert.equal(count(db, 'day_series', "WHERE source='collected'"), WINDOW.length * TRAFFIC_METRICS.length,
      'the traffic window was still collected in full');
    assert.equal(count(db, 'repository_errors'), 0, 'a retried statistics 202 records no failure evidence');

    const run = runRow(db, runId);
    assert.notEqual(run.closedAt, null, 'the run closed');
    assert.equal(run.status, 'completed');
    assert.equal(run.successCount, 1);
    assert.equal(run.failureCount, 0);
    // The journal counts the requests the run asked the policy for: one identity,
    // one stargazer page, one commit activity, one participation and four traffic
    // endpoints. The retried 202 was one of those requests, made twice.
    assert.equal(run.requestCount, 8);
    assert.ok(run.durationMs !== null && run.durationMs >= 0);
  });
  // Nine HTTP attempts were made, all of them on the loopback stub: the eight the
  // journal counts plus the one retry the policy performed inside the 202.
  assert.equal(f.stub.requests().length, 9, 'the 202 cost exactly one extra HTTP attempt');
  assert.equal(f.fetchTargets().length, 9);
  assertOnlyStubTraffic(f, 'run over a compiling statistics cache');
});

test('a run mixing a failing and a succeeding repository records a complete run and no half-written fact', async (t) => {
  // Arrange: one repository is collected normally, the next one's traffic
  // endpoints answer the 403 GitHub returns without administration permission.
  const healthy = 'owner/alpha-1';
  const failing = 'owner/gamma-3';
  const f = await createCollectionHome(t, [healthy, failing]);
  scriptResolution(f.stub);
  scriptTraffic(f.stub, { days: WINDOW, offset: 0, failing });
  scriptBackfill(f.stub);

  // Act: one run over both repositories.
  const result = await f.run(['collect']);

  // Assert: the failure is reported per repository, the run exits 1, and the run
  // record is still complete with both counts.
  assert.equal(result.status, 1, 'a run where a repository failed exits 1');
  assert.equal(result.stderr, '', 'a degraded run reports the repository on stdout, never as a crash');
  assertNoCredentialMaterial(result, 'mixed run');
  const printed = lines(result.stdout);
  assert.equal(printed.length, 3, `one line per repository and one summary; got ${JSON.stringify(printed)}`);
  assert.match(printed[0], new RegExp(`^${healthy} ok ${WINDOW.length} days written `));
  assert.match(printed[1], new RegExp(`^${failing} failed permission-missing backfill first-connect `));
  const runId = runIdOf(result.stdout);
  assert.match(printed[2], new RegExp(`^summary run=${runId} repositories=2 ok=1 failed=1 unavailable=0 ` +
    'skipped=0 .* status=degraded$'));

  f.archive((db) => {
    const run = runRow(db, runId);
    assert.notEqual(run.closedAt, null, 'the run closed even though one repository failed');
    assert.equal(run.status, 'degraded');
    assert.equal(run.successCount, 1, 'the run records the repository that succeeded');
    assert.equal(run.failureCount, 1, 'the run records the repository that failed');
    // Eight requests for the repository that collected, five for the one whose
    // first traffic read was refused: a permission failure is not retried.
    assert.equal(run.requestCount, 13, 'the run accounts for every request it made, including the one that failed');
    assert.equal(count(db, 'runs'), 1, 'one run row covers the whole run, not one per repository');

    const collected = repositoryId(db, healthy);
    assert.equal(count(db, 'day_series', `WHERE repository_id=${collected} AND source='collected'`),
      WINDOW.length * TRAFFIC_METRICS.length, 'the succeeding repository kept every day it returned');
    assert.equal(count(db, 'snapshots', `WHERE repository_id=${collected}`), SNAPSHOT_ROWS_PER_RUN);
    assert.deepEqual(captures(db, collected), [{ runId, collectedAt: run.startedAt }]);
    assert.equal(count(db, 'backfill_records', `WHERE repository_id=${collected} AND kind='first-collected'`), 1);

    // The failing repository wrote no collected fact and no capture: its boundary
    // is its own, so a failure leaves no half-written repository behind.
    const broken = repositoryId(db, failing);
    assert.equal(count(db, 'day_series', `WHERE repository_id=${broken} AND source='collected'`), 0,
      'a repository whose traffic failed stores no collected fact');
    assert.equal(count(db, 'snapshots', `WHERE repository_id=${broken}`), 0,
      'a repository whose traffic failed appends no snapshot capture');
    assert.equal(count(db, 'backfill_records', `WHERE repository_id=${broken} AND kind='first-collected'`), 0,
      'a failed collection never stamps a first collected day');
    // It is not marked unavailable: a missing permission is not a disappearance.
    assert.deepEqual(plainRows(db.prepare(`SELECT lifecycle, unavailable_reason AS reason, enrolled
      FROM repositories WHERE id=?`).all(broken)), [{ lifecycle: 'active', reason: null, enrolled: 1 }]);
    // It keeps the row it was given and the backfill it did observe.
    assert.equal(count(db, 'repositories'), 2);
    assert.equal(count(db, 'day_series', `WHERE repository_id=${broken} AND source='backfill'`), 6,
      'what the repository did return before it failed is kept, not discarded');
    assert.equal(count(db, 'runs'), 1);
  });
  assertOnlyStubTraffic(f, 'mixed run');
});

test('a run over six repositories stays inside the sixty-second budget and stores every repository separately', async (t) => {
  // Arrange: the six repositories the performance requirement names, each served
  // its own counts.
  const enrolled = Array.from({ length: 6 }, (unused, index) => `owner/repo-${index + 1}`);
  const f = await createCollectionHome(t, enrolled);
  scriptResolution(f.stub);
  scriptTraffic(f.stub, { days: WINDOW, offset: 0 });
  scriptBackfill(f.stub);

  // Act: one collection run over all six.
  const startedAt = Date.now();
  const result = await f.run(['collect']);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 0, result.stderr);
  assertNoCredentialMaterial(result, 'six repository run');
  const printed = lines(result.stdout);
  assert.equal(printed.length, 7, `one line per repository and one summary; got ${JSON.stringify(printed)}`);
  for (const [index, repo] of enrolled.entries()) {
    assert.match(printed[index], new RegExp(`^${repo} ok ${WINDOW.length} days written `),
      `${repo} must report its own collected window; got ${JSON.stringify(printed[index])}`);
  }
  const runId = runIdOf(result.stdout);
  assert.match(printed[6], new RegExp(`^summary run=${runId} repositories=6 ok=6 failed=0 unavailable=0 ` +
    'skipped=0 .* status=completed$'));

  f.archive((db) => {
    assert.equal(count(db, 'repositories'), 6);
    assert.equal(count(db, 'day_series', "WHERE source='collected'"), 6 * WINDOW.length * TRAFFIC_METRICS.length,
      'each of the six repositories stored one row per returned day per traffic metric');
    assert.equal(count(db, 'snapshots'), 6 * SNAPSHOT_ROWS_PER_RUN, 'each repository appended its own capture');
    assert.equal(count(db, 'backfill_records', "WHERE kind='first-collected'"), 6);
    // Each repository stored the window and the values its own endpoints returned.
    assert.deepEqual(collectedDays(db, repositoryId(db, enrolled[0])), WINDOW);
    const firstDayClones = enrolled.map((repo) => dayValue(db, repositoryId(db, repo), 'clones', FIRST_DAY));
    assert.deepEqual(firstDayClones, enrolled.map((repo) => servedClones(repo, FIRST_DAY, 0)),
      'every repository stored the counts its own endpoint returned');
    assert.equal(new Set(firstDayClones).size, 6, 'no two repositories share a stored value by accident of scripting');

    const run = runRow(db, runId);
    assert.notEqual(run.closedAt, null);
    assert.equal(run.status, 'completed');
    assert.equal(run.successCount, 6);
    assert.equal(run.failureCount, 0);
    assert.equal(run.requestCount, 6 * 8, 'eight requests per repository: identity, stargazers, two statistics and four traffic endpoints');
    assert.ok(run.durationMs !== null && run.durationMs >= 0);
    assert.ok(run.durationMs < RUN_BUDGET_MS,
      `the recorded run duration ${String(run.durationMs)} ms must stay inside the ${RUN_BUDGET_MS} ms budget`);
  });
  assert.ok(elapsedMs < RUN_BUDGET_MS,
    `six repositories took ${elapsedMs} ms of wall clock, over the ${RUN_BUDGET_MS} ms budget`);
  assertOnlyStubTraffic(f, 'six repository run');
});

/**
 * node:sqlite hands back null-prototype rows, so copy them into plain objects
 * before comparing them with `deepEqual`.
 * @param {Record<string, unknown>[]} list
 * @returns {Record<string, unknown>[]}
 */
function plainRows(list) {
  return list.map((entry) => ({ ...entry }));
}

/**
 * @param {DatabaseSync} db
 * @returns {Array<Record<string, unknown>>} every weekly day row, whatever wrote it.
 */
function plainWeeklyRows(db) {
  return plainRows(db.prepare(`SELECT metric, granularity, day, value, source FROM day_series
    WHERE granularity='week' ORDER BY metric, day`).all());
}