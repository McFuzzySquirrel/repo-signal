import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  assertNoCredentialMaterial, createCollectHome, outputLines as lines, plainRows as plain, rowCount as rows,
} from './helpers/collect-home.js';

// Every assertion here drives the real entry point, `node src/cli.js collect`,
// against the local GitHub stub over a temporary home. No test reaches
// api.github.com and no test uses a real token; the credential is an obviously
// fake token-shaped string, so its absence from the output means something.
const WINDOW_DAYS = 14;

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
const FIRST_DAY = /** @type {string} */ (WINDOW[0]);

const REFERRERS = [
  { referrer: 'example.org', count: 12, uniques: 7 },
  { referrer: 'news.example', count: 4, uniques: 3 },
];
const POPULAR_PATHS = [{ path: '/', title: 'RepoSignal', count: 30, uniques: 18 }];
const SNAPSHOT_ROWS = REFERRERS.length + POPULAR_PATHS.length;
// Clones and unique cloners, views and unique visitors: four metric keys a day.
const TRAFFIC_ROWS = WINDOW_DAYS * 4;
const BACKFILL_ROWS = 6;

const STARGAZERS = [
  { starred_at: '2026-09-01T10:00:00Z' },
  { starred_at: '2026-09-01T12:00:00Z' },
  { starred_at: '2026-09-20T09:00:00Z' },
];
const WEEK_STARTS = ['2026-09-14T00:00:00Z', '2026-09-21T00:00:00Z'].map((week) => Date.parse(week) / 1000);
const COMMIT_ACTIVITY = WEEK_STARTS.map((week, index) => ({
  week, total: 4 + index, days: [1, 2, 0, 1, 0, 0, 0],
}));
const PARTICIPATION = { all: [10, 12], owner: [3, 4] };

/**
 * The repository record the collection step resolves before it writes anything.
 * GitHub serves the identity it currently holds for a repository, so a rename or
 * a transfer shows up here as a different owner or name.
 * @param {string} owner
 * @param {string} name
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
function repositoryRecord(owner, name, extra = {}) {
  return {
    id: 1000 + name.length,
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner, type: 'User' },
    stargazers_count: 3,
    forks_count: 1,
    watchers_count: 3,
    ...extra,
  };
}

/**
 * Script the lifecycle resolution every repository is confirmed through before a
 * single fact is written. A repository GitHub no longer serves is listed in
 * `vanished` and answers 404; a repository it renamed or transferred answers with
 * the identity it now holds under the entry for the name it is requested by.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 * @param {{ moved?: Record<string, {owner: string, name: string}>, vanished?: string[] }} [options]
 */
function scriptResolution(stub, options = {}) {
  const moved = options.moved ?? {};
  const vanished = new Set((options.vanished ?? []).map((repo) => repo.toLowerCase()));
  stub.route('GET /repos/:owner/:name', (request) => {
    const requested = request.path.slice('/repos/'.length);
    if (vanished.has(requested.toLowerCase())) {
      return { status: 404, json: { message: 'Not Found' } };
    }
    const [owner, name] = requested.split('/');
    const target = moved[requested] ?? moved[requested.toLowerCase()] ?? null;
    return { json: repositoryRecord(target?.owner ?? owner, target?.name ?? name) };
  });
}

/**
 * Script the traffic endpoints for every repository, optionally failing one of
 * them. A later call with a different `offset` is GitHub revising its window.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 * @param {{ offset?: number, failing?: string|null }} [options] `failing` is an owner/name pair.
 */
function scriptTraffic(stub, options = {}) {
  const offset = options.offset ?? 0;
  const failing = options.failing ?? null;
  const entries = WINDOW.map((day, index) => ({
    day, count: index + offset, uniques: 1 + index, views: index + offset + 30,
  }));
  const total = (/** @type {'count'|'uniques'|'views'} */ which) =>
    entries.reduce((sum, entry) => sum + entry[which], 0);
  const isFailing = (/** @type {{path: string}} */ request) =>
    failing !== null && request.path.startsWith(`/repos/${failing}/`);
  const day = (/** @type {{day: string}} */ entry) => ({ timestamp: `${entry.day}T00:00:00Z` });
  stub.route('GET /repos/:owner/:name/traffic/clones', (request) => (isFailing(request)
    ? { status: 403, json: { message: 'Requires Administration repository permission (read)' } }
    : {
        json: {
          count: total('count'),
          uniques: total('uniques'),
          clones: entries.map((entry) => ({ ...day(entry), count: entry.count, uniques: entry.uniques })),
        },
      }));
  stub.route('GET /repos/:owner/:name/traffic/views', () => ({
    json: {
      count: total('views'),
      uniques: total('uniques'),
      views: entries.map((entry) => ({ ...day(entry), count: entry.views, uniques: entry.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/popular/referrers', () => ({ json: REFERRERS }));
  stub.route('GET /repos/:owner/:name/traffic/popular/paths', () => ({ json: POPULAR_PATHS }));
}

/**
 * Script the first-connect backfill endpoints.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 */
function scriptBackfill(stub) {
  stub.route('GET /repos/:owner/:name/stargazers*', () => ({ json: STARGAZERS }));
  stub.route('GET /repos/:owner/:name/stats/commit_activity', () => ({ json: COMMIT_ACTIVITY }));
  stub.route('GET /repos/:owner/:name/stats/participation', () => ({ json: PARTICIPATION }));
}

/**
 * @param {string} stdout
 * @returns {string} the run identifier the summary line printed.
 */
function printedRunId(stdout) {
  const match = /summary run=(collect-\S+)/.exec(stdout);
  assert.ok(match !== null, `the summary names the run it wrote; got ${JSON.stringify(stdout)}`);
  return /** @type {string} */ (match[1]);
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a dry run prints one planned line per repository and makes no call and no write', async (t) => {
  const f = await createCollectHome(t);
  scriptResolution(f.stub);
  scriptTraffic(f.stub);
  scriptBackfill(f.stub);

  const result = await f.run(['collect', '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assertNoCredentialMaterial(result, 'dry run');
  // One planned line per enrolled repository and a summary. Nothing else.
  assert.deepEqual(lines(result.stdout), [
    'owner/alpha planned backfill=first-connect requests>=8',
    'owner/beta planned backfill=first-connect requests>=8',
    'summary mode=dry-run run=none planned=2 backfill=2 requests=0 duration_ms=0 status=planned',
  ]);
  assert.equal(f.stub.requests().length, 0, 'a dry run must not contact GitHub at all');

  f.archive((db) => {
    assert.equal(rows(db, 'repositories'), 0, 'a dry run registers nothing');
    for (const table of ['day_series', 'snapshots', 'runs', 'heartbeats', 'backfill_records', 'repository_errors']) {
      assert.equal(rows(db, table), 0, `a dry run writes no ${table} row`);
    }
  });
});

test('a dry run reports the backfill step it would skip for an already backfilled repository', async (t) => {
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptResolution(f.stub);
  scriptTraffic(f.stub);
  scriptBackfill(f.stub);
  assert.equal((await f.run(['collect'])).status, 0);
  assert.ok(f.stub.requests().length > 0, 'the first run contacted GitHub');

  const planned = await f.run(['collect', '--dry-run', '--repo', 'owner/alpha']);

  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(lines(planned.stdout), [
    'owner/alpha planned backfill=skipped requests=5',
    'summary mode=dry-run run=none planned=1 backfill=0 requests=0 duration_ms=0 status=planned',
  ]);
  assertNoCredentialMaterial(planned, 'dry run after backfill');
});

test('--repo collects only that repository, exits 0 and prints the run it wrote', async (t) => {
  const f = await createCollectHome(t);
  scriptResolution(f.stub);
  scriptTraffic(f.stub);
  scriptBackfill(f.stub);

  const result = await f.run(['collect', '--repo', 'owner/alpha']);

  assert.equal(result.status, 0, result.stderr);
  assertNoCredentialMaterial(result, 'filtered run');
  const printed = lines(result.stdout);
  assert.equal(printed.length, 2, 'one repository line and one summary line');
  assert.match(printed[0], /^owner\/alpha ok 14 days written 56 revised 0 unchanged 0 snapshots 3 backfill first-connect$/);
  const runId = printedRunId(result.stdout);
  assert.match(printed[1], new RegExp(`^summary run=${runId} repositories=1 ok=1 failed=0 unavailable=0 skipped=0 ` +
    'days=14 rows=56 written=56 revised=0 unchanged=0 snapshots=3 backfilled=1 requests=8 duration_ms=\\d+ status=completed$'));

  f.archive((db) => {
    // The printed identifier is the run row: started, closed, counted, no other run.
    const run = /** @type {Record<string, unknown>} */ (db.prepare(
      `SELECT started_at AS startedAt, closed_at AS closedAt, status, success_count AS successCount,
        failure_count AS failureCount, request_count AS requestCount, duration_ms AS durationMs
        FROM runs WHERE id=?`).get(runId));
    assert.notEqual(run.closedAt, null, 'the run closed');
    assert.equal(typeof run.closedAt, 'string');
    assert.equal(run.status, 'completed');
    assert.equal(run.successCount, 1);
    assert.equal(run.failureCount, 0);
    assert.equal(run.requestCount, 8, 'one resolution, three backfill reads and four traffic reads');
    assert.equal(typeof run.durationMs, 'number');
    assert.equal(rows(db, 'runs'), 1, 'exactly one run row exists');

    // One repository row for the filtered repository, and nothing for the other.
    assert.deepEqual(plain(db.prepare(
      'SELECT id, owner, name, lifecycle, enrolled FROM repositories ORDER BY id').all()), [
      { id: 1, owner: 'owner', name: 'alpha', lifecycle: 'active', enrolled: 1 },
    ]);
    assert.equal(rows(db, 'day_series', "WHERE source='collected'"), TRAFFIC_ROWS);
    assert.equal(rows(db, 'day_series', "WHERE source='backfill'"), BACKFILL_ROWS);
    assert.equal(rows(db, 'snapshots'), SNAPSHOT_ROWS);
    assert.equal(rows(db, 'snapshots', `WHERE run_id='${runId}'`), SNAPSHOT_ROWS);
  });
  // Only the filtered repository was asked about, and every request carried the credential.
  assert.ok(f.stub.paths().every((observed) => observed.startsWith('/repos/owner/alpha')),
    `only alpha may be requested, got ${f.stub.paths().join(', ')}`);
  assert.ok(f.stub.requests().every((request) => request.tokenMatched && request.authorized),
    'every request presented the configured credential');
});

test('one failing repository does not stop the others, and the run record is still complete', async (t) => {
  const f = await createCollectHome(t);
  scriptResolution(f.stub);
  scriptTraffic(f.stub, { failing: 'owner/beta' });
  scriptBackfill(f.stub);

  const result = await f.run(['collect']);

  assert.equal(result.status, 1, 'a run where a repository failed exits 1');
  assertNoCredentialMaterial(result, 'degraded run');
  const printed = lines(result.stdout);
  assert.equal(printed.length, 3, 'one line per repository and one summary');
  assert.match(printed[0], /^owner\/alpha ok 14 days written 56 revised 0 unchanged 0 snapshots 3 backfill first-connect$/);
  assert.match(printed[1], /^owner\/beta failed permission-missing backfill first-connect GitHub HTTP 403: /);
  assert.match(printed[1], /Administration repository permission \(read\)/);
  const runId = printedRunId(result.stdout);
  assert.match(printed[2], new RegExp(`^summary run=${runId} repositories=2 ok=1 failed=1 unavailable=0 skipped=0 ` +
    'days=14 rows=56 written=56 revised=0 unchanged=0 snapshots=3 backfilled=2 requests=13 duration_ms=\\d+ status=degraded$'));

  f.archive((db) => {
    const run = /** @type {Record<string, unknown>} */ (db.prepare(
      `SELECT closed_at AS closedAt, status, success_count AS successCount, failure_count AS failureCount,
        request_count AS requestCount FROM runs WHERE id=?`).get(runId));
    assert.notEqual(run.closedAt, null, 'the run closed even though a repository failed');
    assert.equal(run.status, 'degraded');
    assert.equal(run.successCount, 1);
    assert.equal(run.failureCount, 1);
    assert.equal(run.requestCount, 13);
    assert.equal(rows(db, 'runs'), 1);

    const alpha = /** @type {{id: number}} */ (db.prepare(`SELECT id FROM repositories WHERE name='alpha'`).get());
    const beta = /** @type {{id: number}} */ (db.prepare(`SELECT id FROM repositories WHERE name='beta'`).get());
    assert.equal(rows(db, 'day_series', `WHERE repository_id=${alpha.id} AND source='collected'`), TRAFFIC_ROWS);
    assert.equal(rows(db, 'snapshots', `WHERE repository_id=${alpha.id}`), SNAPSHOT_ROWS);
    assert.equal(rows(db, 'day_series', `WHERE repository_id=${beta.id} AND source='collected'`), 0,
      'a repository whose traffic failed stores no collected fact');
    assert.equal(rows(db, 'snapshots', `WHERE repository_id=${beta.id}`), 0);
    assert.equal(rows(db, 'backfill_records', `WHERE repository_id=${beta.id} AND kind='first-collected'`), 0,
      'a failed collection never stamps a first collected day');
  });
});

test('a repository with no backfill record is backfilled and collected in one run', async (t) => {
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptResolution(f.stub);
  scriptTraffic(f.stub);
  scriptBackfill(f.stub);

  const result = await f.run(['collect']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(lines(result.stdout)[0], /backfill first-connect$/);
  const paths = f.stub.paths();
  assert.ok(paths.includes('/repos/owner/alpha/stargazers'), 'the star history was read');
  assert.ok(paths.includes('/repos/owner/alpha/stats/commit_activity'), 'weekly commit activity was read');
  assert.ok(paths.includes('/repos/owner/alpha/stats/participation'), 'owner participation was read');

  f.archive((db) => {
    const id = /** @type {{id: number}} */ (db.prepare('SELECT id FROM repositories').get()).id;
    // Reconstructed history is labelled as backfill, at the granularity it came in.
    assert.deepEqual(plain(db.prepare(`SELECT metric, granularity, value FROM day_series
        WHERE repository_id=? AND source='backfill' ORDER BY metric, day`).all(id)), [
      { metric: 'commit-activity', granularity: 'week', value: 4 },
      { metric: 'commit-activity', granularity: 'week', value: 5 },
      { metric: 'owner-participation', granularity: 'week', value: 3 },
      { metric: 'owner-participation', granularity: 'week', value: 4 },
      { metric: 'stars', granularity: 'day', value: 2 },
      { metric: 'stars', granularity: 'day', value: 3 },
    ]);
    assert.equal(rows(db, 'day_series', `WHERE repository_id=${id} AND metric='stars' AND source='collected'`), 0);
    // The backfill records the window it actually observed, and the provenance
    // boundary is the first day collected data exists.
    assert.deepEqual(plain(db.prepare(`SELECT kind, window_from AS windowFrom, truncated FROM backfill_records
      WHERE repository_id=? ORDER BY kind`).all(id)), [
      { kind: 'development', windowFrom: '2026-09-14', truncated: 1 },
      { kind: 'first-collected', windowFrom: FIRST_DAY, truncated: 0 },
    ]);
    assert.equal(rows(db, 'day_series', `WHERE repository_id=${id} AND source='collected'`), TRAFFIC_ROWS);
  });
});

test('a second run skips the backfill, revises the same days in place and appends a second capture', async (t) => {
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptResolution(f.stub);
  scriptTraffic(f.stub, { offset: 0 });
  scriptBackfill(f.stub);
  const first = await f.run(['collect']);
  assert.equal(first.status, 0, first.stderr);
  const before = f.archive((db) => ({
    rows: rows(db, 'day_series'),
    snapshots: rows(db, 'snapshots'),
    records: rows(db, 'backfill_records'),
    collectedAt: String(db.prepare(
      `SELECT max(collected_at) AS t FROM day_series WHERE source='collected'`).get()?.t),
  }));
  assert.equal(before.rows, TRAFFIC_ROWS + BACKFILL_ROWS, 'the first run stored both kinds of evidence');

  // GitHub re-serves the same rolling window with revised counts.
  scriptTraffic(f.stub, { offset: 7 });
  f.stub.reset();
  await delay();
  const second = await f.run(['collect']);

  assert.equal(second.status, 0, second.stderr);
  assert.match(lines(second.stdout)[0], /^owner\/alpha ok 14 days written 0 revised 56 unchanged 0 snapshots 3 backfill skipped$/);
  assert.match(lines(second.stdout)[1], /repositories=1 ok=1 failed=0 unavailable=0 skipped=0 .*backfilled=0 requests=5 .*status=completed$/);
  // The second run resolves the repository and reads only the traffic endpoints:
  // backfill is a connect step.
  assert.deepEqual(f.stub.paths(), [
    '/repos/owner/alpha',
    '/repos/owner/alpha/traffic/clones',
    '/repos/owner/alpha/traffic/views',
    '/repos/owner/alpha/traffic/popular/referrers',
    '/repos/owner/alpha/traffic/popular/paths',
  ]);

  f.archive((db) => {
    const id = /** @type {{id: number}} */ (db.prepare('SELECT id FROM repositories').get()).id;
    assert.equal(rows(db, 'day_series'), before.rows, 'an overlapping window adds no day row');
    assert.equal(rows(db, 'snapshots'), before.snapshots * 2, 'two runs append two captures, never one merge');
    assert.equal(rows(db, 'backfill_records'), before.records, 'the backfill step did not run again');
    const collectedAt = String(db.prepare(
      `SELECT max(collected_at) AS t FROM day_series WHERE source='collected'`).get()?.t);
    assert.ok(collectedAt > before.collectedAt, 'the correction carries a newer collection time');
    // The revised value is visible in place, under the same key.
    assert.deepEqual(plain(db.prepare(
      `SELECT value, source FROM day_series WHERE repository_id=? AND metric='clones' AND day=?`).all(id, FIRST_DAY)), [
      { value: 7, source: 'collected' },
    ]);
    // Two captures of the same referrers, side by side, never merged.
    assert.deepEqual(plain(db.prepare(
      `SELECT count, position FROM snapshots WHERE repository_id=? AND kind='referrers' ORDER BY id`).all(id)), [
      { count: 12, position: 0 },
      { count: 4, position: 1 },
      { count: 12, position: 0 },
      { count: 4, position: 1 },
    ]);
    // Both captures survive with their own capture time, and neither was rewritten.
    const captures = /** @type {Array<{collectedAt: string, runId: string}>} */ (
      /** @type {unknown} */ (db.prepare(
        `SELECT DISTINCT collected_at AS collectedAt, run_id AS runId FROM snapshots
          WHERE repository_id=? ORDER BY collected_at`).all(id)));
    assert.equal(captures.length, 2, 'two captures, each naming the run that observed it');
    assert.ok(captures[0].collectedAt < captures[1].collectedAt, 'the captures have distinct capture times');
    assert.notEqual(captures[0].runId, captures[1].runId);
  });
});

test('an empty enrolled set writes a complete run record over no repositories and exits 0', async (t) => {
  const f = await createCollectHome(t, { enrolled: [] });
  scriptResolution(f.stub);
  scriptTraffic(f.stub);
  scriptBackfill(f.stub);

  const result = await f.run(['collect']);

  assert.equal(result.status, 0, result.stderr);
  const printed = lines(result.stdout);
  assert.equal(printed.length, 1, 'only the summary is printed');
  const runId = printedRunId(result.stdout);
  assert.match(printed[0], new RegExp(`^summary run=${runId} repositories=0 ok=0 failed=0 unavailable=0 skipped=0 ` +
    'days=0 rows=0 written=0 revised=0 unchanged=0 snapshots=0 backfilled=0 requests=0 duration_ms=\\d+ status=completed$'));
  assert.equal(f.stub.requests().length, 0, 'nothing is enrolled, so nothing is requested');
  f.archive((db) => {
    assert.equal(rows(db, 'repositories'), 0);
    assert.equal(rows(db, 'runs'), 1);
    assert.notEqual(db.prepare('SELECT closed_at AS closedAt FROM runs').get()?.closedAt, null);
  });
});

test('a mistyped flag, a repeated flag and a malformed or unenrolled filter exit 2 without collecting', async (t) => {
  const f = await createCollectHome(t);
  scriptResolution(f.stub);
  scriptTraffic(f.stub);
  scriptBackfill(f.stub);

  for (const args of [
    ['collect', '--bogus'],
    ['collect', '--repo'],
    ['collect', '--repo', 'nonsense'],
    ['collect', '--repo', 'owner/nope'],
    ['collect', '--repo', 'stranger/repo'],
    ['collect', '--repo', 'owner/alpha', '--repo', 'owner/beta'],
    ['collect', '--dry-run', '--dry-run'],
  ]) {
    const result = await f.run(args);
    assert.equal(result.status, 2, `${args.join(' ')} is a usage error`);
    assert.match(result.stderr, /Usage:/, `${args.join(' ')} prints the usage`);
    assertNoCredentialMaterial(result, args.join(' '));
  }
  const unenrolled = await f.run(['collect', '--repo', 'stranger/repo']);
  assert.match(unenrolled.stderr, /is not an enrolled repository/);
  assert.match(unenrolled.stderr, /owner\/alpha, owner\/beta/, 'the refusal names the enrolled set');
  assert.equal(f.stub.requests().length, 0, 'a usage error collects nothing');
  assert.equal(existsSync(f.databasePath), false, 'a usage error never opens the archive');
});

test('an unconfigured home explains config init, stops and reaches no host', async (t) => {
  const f = await createCollectHome(t, { enrolled: null });
  scriptTraffic(f.stub);

  const result = await f.run(['collect']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no configuration file at/);
  assert.match(result.stderr, /node src\/cli\.js config init/);
  assertNoCredentialMaterial(result, 'unconfigured home');
  assert.equal(f.stub.requests().length, 0);
  assert.equal(existsSync(f.databasePath), false, 'nothing is collected, so no archive is opened');
});
