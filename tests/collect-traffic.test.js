import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  collectTraffic, CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../src/collect/traffic.js';
import { calendarDays, readDaySeries } from '../src/db/day-series-repo.js';
import { openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';

// Traffic response shapes follow https://docs.github.com/en/rest/metrics/traffic as
// mapped by src/github/traffic-client.js. The client is injected, so no test opens
// a socket or reaches api.github.com.
const first = '2026-10-01T00:00:00.000Z';
const second = '2026-10-02T00:00:00.000Z';
const repo = 'owner/archive';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-collect-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'owner', name: 'archive', lastSeenAt: first, enrolled: 1 });
  upsertRepository(db, { id: 2, owner: 'owner', name: 'other', lastSeenAt: first });
  return db;
}

/**
 * Build day records the way the traffic client returns them.
 * @param {Array<[string, number, number]>} days
 * @returns {import('../src/github/traffic-client.js').TrafficRecord[]}
 */
function breakdown(days) {
  return days.map(([day, count, uniques]) => ({
    timestamp: `${day}T00:00:00Z`, day, count, uniques, granularity: 'day',
  }));
}

/**
 * @param {{clones?: import('../src/github/traffic-client.js').TrafficRecord[], views?: import('../src/github/traffic-client.js').TrafficRecord[]}} payload
 */
function fakeTrafficClient(payload) {
  /** @type {string[]} */
  const calls = [];
  /**
   * @param {'clones'|'views'} metric
   * @returns {(name: string, per?: import('../src/github/traffic-client.js').TrafficGranularity) => Promise<import('../src/github/traffic-client.js').TrafficRecord[]>}
   */
  const read = (metric) => async (name, per) => {
    calls.push(`${name} ${metric}?per=${per ?? 'day'}`);
    return payload[metric] ?? [];
  };
  /** @type {import('../src/collect/traffic.js').TrafficClient} */
  const trafficClient = { clones: read('clones'), views: read('views') };
  return { calls, trafficClient };
}

/** @param {import('node:sqlite').DatabaseSync} db */
function storedRows(db) {
  return /** @type {number} */ (db.prepare('SELECT count(*) AS n FROM day_series').get()?.n);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} metric
 * @returns {import('../src/db/day-series-repo.js').DayFact[]}
 */
function series(db, metric) {
  return readDaySeries(db, { repositoryId: 1, metric, granularity: /** @type {const} */ ('day'),
    from: '2026-09-01', to: '2026-10-31' });
}

const firstClones = breakdown([['2026-09-27', 4, 2], ['2026-09-28', 0, 0], ['2026-09-29', 7, 5]]);
const firstViews = breakdown([['2026-09-28', 30, 11], ['2026-09-29', 25, 9]]);

test('first collection writes one collected row per returned day for clones and views', async (t) => {
  const db = await fixture(t);
  const { calls, trafficClient } = fakeTrafficClient({ clones: firstClones, views: firstViews });
  const summary = await collectTraffic({ db, repositoryId: 1, repo, trafficClient, collectedAt: first });

  assert.deepEqual(calls, [`${repo} clones?per=day`, `${repo} views?per=day`]);
  assert.deepEqual(summary, { days: 3, rows: 10, written: 10, revised: 0, unchanged: 0 });
  assert.equal(storedRows(db), 10);

  assert.deepEqual(series(db, CLONES_METRIC).map((row) => [row.day, row.value]), [
    ['2026-09-27', 4], ['2026-09-28', 0], ['2026-09-29', 7],
  ]);
  assert.deepEqual(series(db, UNIQUE_CLONERS_METRIC).map((row) => [row.day, row.value]), [
    ['2026-09-27', 2], ['2026-09-28', 0], ['2026-09-29', 5],
  ]);
  assert.deepEqual(series(db, VIEWS_METRIC).map((row) => [row.day, row.value]), [
    ['2026-09-28', 30], ['2026-09-29', 25],
  ]);
  assert.deepEqual(series(db, UNIQUE_VISITORS_METRIC).map((row) => [row.day, row.value]), [
    ['2026-09-28', 11], ['2026-09-29', 9],
  ]);
  const rows = db.prepare('SELECT metric, source, collected_at AS collectedAt, granularity FROM day_series').all();
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.equal(row.source, 'collected');
    assert.equal(row.collectedAt, first);
    assert.equal(row.granularity, 'day');
  }
  // The returned zero is an observed zero; the days GitHub left out stay gaps.
  assert.deepEqual(calendarDays('2026-09-25', '2026-09-29'),
    ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']);
  for (const day of ['2026-09-25', '2026-09-26']) {
    assert.equal(db.prepare('SELECT count(*) AS n FROM day_series WHERE day=?').get(day)?.n, 0);
  }
  // Another repository is untouched by this repository's collection.
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series WHERE repository_id=2').get()?.n, 0);
});

test('a second collection over the same rolling window revises in place and adds no row', async (t) => {
  const db = await fixture(t);
  const before = fakeTrafficClient({ clones: firstClones, views: firstViews });
  await collectTraffic({ db, repositoryId: 1, repo, trafficClient: before.trafficClient, collectedAt: first });
  const rowsBefore = storedRows(db);

  const { trafficClient } = fakeTrafficClient({
    clones: breakdown([['2026-09-27', 4, 2], ['2026-09-28', 1, 1], ['2026-09-29', 9, 6], ['2026-09-30', 3, 3]]),
    views: breakdown([['2026-09-28', 30, 11], ['2026-09-29', 25, 9]]),
  });
  const summary = await collectTraffic({ db, repositoryId: 1, repo, trafficClient, collectedAt: second });

  assert.deepEqual(summary, { days: 4, rows: 12, written: 2, revised: 10, unchanged: 0 });
  assert.equal(storedRows(db), rowsBefore + 2);
  assert.deepEqual(series(db, CLONES_METRIC).map((row) => [row.day, row.value, row.collectedAt]), [
    ['2026-09-27', 4, second], ['2026-09-28', 1, second], ['2026-09-29', 9, second], ['2026-09-30', 3, second],
  ]);
  assert.deepEqual(series(db, UNIQUE_CLONERS_METRIC).map((row) => [row.day, row.value]), [
    ['2026-09-27', 2], ['2026-09-28', 1], ['2026-09-29', 6], ['2026-09-30', 3],
  ]);
  assert.deepEqual(series(db, VIEWS_METRIC).map((row) => [row.day, row.value]), [
    ['2026-09-28', 30], ['2026-09-29', 25],
  ]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series WHERE source=?').get('collected')?.n, 12);
});

test('a replay stamped older or equal keeps the newest stored value and reports nothing applied', async (t) => {
  const db = await fixture(t);
  const { trafficClient: firstRun } = fakeTrafficClient({ clones: firstClones, views: firstViews });
  await collectTraffic({ db, repositoryId: 1, repo, trafficClient: firstRun, collectedAt: first });
  const { trafficClient: secondRun } = fakeTrafficClient({
    clones: breakdown([['2026-09-27', 40, 20], ['2026-09-28', 10, 10], ['2026-09-29', 70, 50]]),
    views: breakdown([['2026-09-28', 300, 110], ['2026-09-29', 250, 90]]),
  });
  await collectTraffic({ db, repositoryId: 1, repo, trafficClient: secondRun, collectedAt: second });
  const rowsBefore = storedRows(db);

  for (const collectedAt of [first, second]) {
    const { trafficClient } = fakeTrafficClient({
      clones: breakdown([['2026-09-27', 999, 999], ['2026-09-28', 999, 999], ['2026-09-29', 999, 999]]),
      views: breakdown([['2026-09-28', 999, 999], ['2026-09-29', 999, 999]]),
    });
    const summary = await collectTraffic({ db, repositoryId: 1, repo, trafficClient, collectedAt });
    assert.deepEqual(summary, { days: 3, rows: 10, written: 0, revised: 0, unchanged: 10 });
  }
  assert.equal(storedRows(db), rowsBefore);
  assert.deepEqual(series(db, CLONES_METRIC).map((row) => [row.day, row.value, row.collectedAt]), [
    ['2026-09-27', 40, second], ['2026-09-28', 10, second], ['2026-09-29', 70, second],
  ]);
  assert.deepEqual(series(db, VIEWS_METRIC).map((row) => [row.day, row.value, row.collectedAt]), [
    ['2026-09-28', 300, second], ['2026-09-29', 250, second],
  ]);
});

test('a repository with an empty window writes no row, reports zero and still collects next time', async (t) => {
  const db = await fixture(t);
  const { calls, trafficClient } = fakeTrafficClient({ clones: [], views: [] });
  const summary = await collectTraffic({ db, repositoryId: 1, repo, trafficClient, collectedAt: first });

  assert.deepEqual(calls, [`${repo} clones?per=day`, `${repo} views?per=day`]);
  assert.deepEqual(summary, { days: 0, rows: 0, written: 0, revised: 0, unchanged: 0 });
  assert.equal(storedRows(db), 0);

  const { trafficClient: retry } = fakeTrafficClient({ clones: firstClones, views: firstViews });
  const collected = await collectTraffic({ db, repositoryId: 1, repo, trafficClient: retry, collectedAt: second });
  assert.deepEqual(collected, { days: 3, rows: 10, written: 10, revised: 0, unchanged: 0 });
  assert.equal(storedRows(db), 10);
});

test('a failure injected between writes leaves no partial repository write', async (t) => {
  const cases = /** @type {Array<[string, import('../src/github/traffic-client.js').TrafficRecord, RegExp]>} */ ([
    ['a fractional count', { timestamp: '2026-09-29T00:00:00Z', day: '2026-09-29', count: 1.5,
      uniques: 1, granularity: 'day' }, /Traffic views entry 2026-09-29 must carry a non-negative integer count/],
    ['a week bucket', { timestamp: '2026-09-22T00:00:00Z', day: '2026-09-22', count: 2, uniques: 1,
      granularity: 'week' }, /must carry granularity day/],
    ['a missing day', { timestamp: '2026-09-29T00:00:00Z', count: 2, uniques: 1, granularity: 'day' },
      /must carry the UTC day/],
    ['an impossible calendar day', { timestamp: '2026-02-30T00:00:00Z', day: '2026-02-30', count: 2,
      uniques: 1, granularity: 'day' }, /Invalid calendar day/],
    ['a negative count', { timestamp: '2026-09-29T00:00:00Z', day: '2026-09-29', count: -1, uniques: 1,
      granularity: 'day' }, /must carry a non-negative integer count/],
  ]);
  for (const [label, malformed, message] of cases) {
    const db = await fixture(t);
    const { trafficClient } = fakeTrafficClient({
      clones: firstClones,
      views: [...firstViews, malformed],
    });
    // The clone days and the first view day are written before the failure lands.
    await assert.rejects(
      collectTraffic({ db, repositoryId: 1, repo, trafficClient, collectedAt: first }),
      message,
      `${label} must abort the repository write`,
    );
    assert.equal(storedRows(db), 0, `${label} must leave no half-written repository`);

    const { trafficClient: retry } = fakeTrafficClient({ clones: firstClones, views: firstViews });
    const summary = await collectTraffic({ db, repositoryId: 1, repo, trafficClient: retry, collectedAt: second });
    assert.deepEqual(summary, { days: 3, rows: 10, written: 10, revised: 0, unchanged: 0 });
    assert.equal(storedRows(db), 10, 'a retried run converges on the same archive');
  }
});

test('an unknown repository and a noncanonical collection time are refused before any request', async (t) => {
  const db = await fixture(t);
  const { calls, trafficClient } = fakeTrafficClient({ clones: firstClones, views: firstViews });
  await assert.rejects(
    collectTraffic({ db, repositoryId: 999, repo, trafficClient, collectedAt: first }),
    /Unknown repository 999/,
  );
  for (const collectedAt of ['2026-10-01T00:00:00Z', '2026-10-01T01:00:00.000+01:00', 'not a timestamp']) {
    await assert.rejects(
      collectTraffic({ db, repositoryId: 1, repo, trafficClient, collectedAt }),
      /Invalid collection timestamp/,
    );
  }
  assert.deepEqual(calls, []);
  assert.equal(storedRows(db), 0);
});