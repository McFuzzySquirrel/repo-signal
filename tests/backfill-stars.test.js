import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { backfillStars, cumulativeStarDays, utcWeekStart } from '../src/backfill/stars.js';
import { readDaySeries } from '../src/db/day-series-repo.js';
import { openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';

const collectedAt = '2026-10-01T00:00:00.000Z';
const range = { repositoryId: 1, metric: 'stars', granularity: /** @type {const} */ ('day'),
  from: '2020-01-01', to: '2030-01-01' };

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-backfill-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'owner', name: 'archive', lastSeenAt: collectedAt, enrolled: 1 });
  return db;
}

/**
 * A UTC midnight Sunday, `weeksAgo` weeks back from 2026-10-04.
 * @param {number} weeksAgo
 * @returns {number}
 */
function weekStart(weeksAgo) {
  return Math.floor(Date.parse('2026-10-04T00:00:00.000Z') / 1000) - weeksAgo * 604_800;
}

/**
 * A week with `days` counts, Sunday first, and the total the vendor would send.
 * @param {number} weeksAgo
 * @param {number[]} days
 * @returns {{week: number, total: number, days: number[]}}
 */
function week(weeksAgo, days) {
  return { week: weekStart(weeksAgo), total: days.reduce((sum, day) => sum + day, 0), days };
}

/**
 * @param {Array<Array<{week: number, total: number, days: number[]}>>} pages
 *   One inner array per page, each holding that page's weeks newest first, as GitHub serves them.
 * @param {{truncated?: boolean}} [options]
 */
function fakeClient(pages, { truncated = false } = {}) {
  /** @type {Array<{repo: string, page: number, size: number}>} */
  const calls = [];
  return {
    calls,
    starsClient: {
      /** @param {string} repo @param {(weeks: Array<{week: number, total: number, days: number[]}>, page: number, endpoint: string) => void} onPage */
      async starHistory(repo, onPage) {
        let weeks = 0;
        let page = 0;
        for (const batch of pages) {
          page += 1;
          weeks += batch.length;
          calls.push({ repo, page, size: batch.length });
          onPage(batch, page, `/repos/owner/archive/stargazers/history?page=${page}`);
        }
        return { pages: page, weeks, truncated };
      },
    },
  };
}

test('stars on two days in one week produce one row per day whose values are the running total', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([[week(1, [0, 0, 0, 2, 1, 0, 0])]]);
  const summary = await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  // 2026-09-27 is the Sunday; index 3 is Wednesday 2026-09-30 and index 4 is Thursday.
  assert.deepEqual(summary, { pages: 1, weeks: 1, rows: 2, truncated: false, unalignedWeeks: 0 });
  assert.deepEqual(readDaySeries(db, range).map((row) => [row.day, row.value]), [
    ['2026-09-30', 2],
    ['2026-10-01', 3],
  ]);
});

test('weeks arriving newest first are accumulated forwards from the first star', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([
    [week(0, [0, 0, 0, 1, 0, 0, 0])],
    [week(2, [0, 1, 0, 0, 0, 0, 0])],
    [week(1, [0, 0, 0, 0, 2, 0, 0])],
  ]);
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  // Sorted forwards: the week of 2026-09-20, then 2026-09-27, then 2026-10-04.
  assert.deepEqual(readDaySeries(db, range).map((row) => [row.day, row.value]), [
    ['2026-09-21', 1],
    ['2026-10-01', 3],
    ['2026-10-07', 4],
  ]);
});

test('no row is written for a week with no stars and a multi-week gap is not filled', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([
    [week(6, [0, 0, 0, 0, 0, 0, 0])],
    [week(0, [0, 0, 0, 0, 0, 0, 0])],
    [week(3, [0, 0, 0, 1, 0, 0, 0])],
  ]);
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  const rows = readDaySeries(db, range);
  assert.deepEqual(rows.map((row) => row.day), ['2026-09-16']);
  assert.equal(rows[0].value, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM day_series WHERE day < '2026-09-16'").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM day_series WHERE day = '2026-09-25'").get()?.n, 0);
});

test('a repository with no stars produces no rows and no error', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([[week(0, [0, 0, 0, 0, 0, 0, 0])]]);
  const summary = await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  assert.deepEqual(summary, { pages: 1, weeks: 1, rows: 0, truncated: false, unalignedWeeks: 0 });
  assert.deepEqual(readDaySeries(db, range), []);
});

test('running the backfill twice over the same input leaves the row count unchanged', async (t) => {
  const db = await fixture(t);
  const pages = [[week(1, [0, 0, 0, 2, 1, 0, 0])]];
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive',
    starsClient: fakeClient(pages).starsClient, collectedAt });
  const countAfterFirst = db.prepare('SELECT count(*) AS n FROM day_series').get()?.n;
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive',
    starsClient: fakeClient(pages).starsClient, collectedAt });
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series').get()?.n, countAfterFirst);
  assert.deepEqual(readDaySeries(db, range).map((row) => [row.day, row.value]), [
    ['2026-09-30', 2],
    ['2026-10-01', 3],
  ]);
});

test('every written row carries source backfill and a collection timestamp', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([[week(1, [0, 0, 0, 2, 0, 0, 0])]]);
  await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  const rows = readDaySeries(db, range);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'backfill');
  assert.equal(rows[0].collectedAt, collectedAt);
  assert.equal(rows[0].granularity, 'day');
  assert.equal(rows[0].metric, 'stars');
});

test('every history page is consumed and reported, not a fixed page count', async (t) => {
  const db = await fixture(t);
  const { starsClient, calls } = fakeClient([
    [week(0, [0, 0, 0, 1, 0, 0, 0])],
    [week(1, [0, 0, 0, 1, 0, 0, 0])],
    [week(2, [0, 0, 0, 1, 0, 0, 0])],
  ]);
  const summary = await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  assert.deepEqual(calls.map((call) => [call.repo, call.page, call.size]), [
    ['owner/archive', 1, 1],
    ['owner/archive', 2, 1],
    ['owner/archive', 3, 1],
  ]);
  assert.deepEqual(summary, { pages: 3, weeks: 3, rows: 3, truncated: false, unalignedWeeks: 0 });
});

test('a truncated series is reported and does not read as a whole history', async (t) => {
  const db = await fixture(t);
  const { starsClient } = fakeClient([[week(0, [0, 0, 0, 1, 0, 0, 0])]], { truncated: true });
  const summary = await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  assert.equal(summary.truncated, true, 'a series the page cap cut short is reported as truncated');
  assert.equal(readDaySeries(db, range).length, 1, 'the weeks that were served are still stored');
});

test('a week GitHub did not align to UTC is reported and never placed on a calendar day', async (t) => {
  // GitHub documents that day boundaries are not guaranteed to align with UTC. A week
  // that starts at 17:00 UTC carries buckets this archive cannot name, so it is
  // counted and skipped rather than shifted onto days that never held those stars.
  const db = await fixture(t);
  const misaligned = { week: weekStart(1) + 17 * 3600, total: 3, days: [0, 0, 0, 3, 0, 0, 0] };
  const { starsClient } = fakeClient([[week(0, [0, 0, 0, 1, 0, 0, 0])], [misaligned]]);
  const summary = await backfillStars({ db, repositoryId: 1, repo: 'owner/archive', starsClient, collectedAt });
  assert.equal(summary.unalignedWeeks, 1);
  assert.deepEqual(readDaySeries(db, range).map((row) => row.day), ['2026-10-07'],
    'no day is invented for a bucket that is not a UTC day');
});

test('utcWeekStart accepts only a real UTC midnight', () => {
  assert.equal(utcWeekStart(weekStart(0)), '2026-10-04');
  assert.equal(utcWeekStart(weekStart(1)), '2026-09-27');
  // Not a midnight, not an instant, not a value at all.
  assert.equal(utcWeekStart(weekStart(0) + 3600), null);
  assert.equal(utcWeekStart(weekStart(0) + 1), null);
  assert.equal(utcWeekStart(0), null);
  assert.equal(utcWeekStart(-1), null);
  assert.equal(utcWeekStart(1.5), null);
});

test('a repeated week is a contract failure rather than a second reading of it', () => {
  assert.throws(() => cumulativeStarDays([week(1, [0, 0, 0, 1, 0, 0, 0]), week(1, [0, 0, 0, 1, 0, 0, 0])]),
    /repeats the week/);
});

test('the cumulative series sums to the level the vendor reports for the repository', () => {
  // What skill-forge actually serves: two stars, on the Wednesday and Thursday of
  // its oldest reported week, summing to its stargazers/count of 2. That week began
  // 2026-09-20, so index 3 is the 23rd and index 4 the 24th.
  const { days } = cumulativeStarDays([week(2, [0, 0, 0, 1, 1, 0, 0])]);
  assert.deepEqual(days, [{ day: '2026-09-23', value: 1 }, { day: '2026-09-24', value: 2 }]);
  assert.equal(days.at(-1)?.value, 2);
});