import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { backfillDevelopment, COMMIT_ACTIVITY_METRIC, OWNER_PARTICIPATION_METRIC } from '../src/backfill/development.js';
import { readDaySeries } from '../src/db/day-series-repo.js';
import { openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';

const collectedAt = '2026-10-01T00:00:00.000Z';
// The stats-client test fixture's first week: a GitHub week-start Unix time.
const firstWeek = 1758326400;
const firstWeekDay = new Date(firstWeek * 1000).toISOString().slice(0, 10);

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-backfill-dev-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'owner', name: 'archive', lastSeenAt: collectedAt, enrolled: 1 });
  return db;
}

/** @param {number} weeks */
function weekPayload(weeks) {
  return Array.from({ length: weeks }, (_, i) => ({
    days: [1, 0, 2, 0, 0, 3, 1], total: i + 1, week: firstWeek + i * 604800,
  }));
}

/** @param {number} weeks @param {{retryable?: boolean}} [options] */
function fakeStatsClient(weeks, options = {}) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    statsClient: {
      /** @param {string} repo */
      async commitActivity(repo) {
        calls.push(`commit_activity:${repo}`);
        if (options.retryable) return { kind: /** @type {const} */ ('retryable'), status: 202, reason: 'statistics-cache-compiling' };
        if (weeks === 0) return { kind: /** @type {const} */ ('no-statistics-yet') };
        return { kind: /** @type {const} */ ('data'), weeks: weekPayload(weeks) };
      },
      /** @param {string} repo */
      async participation(repo) {
        calls.push(`participation:${repo}`);
        if (options.retryable) return { kind: /** @type {const} */ ('retryable'), status: 202, reason: 'statistics-cache-compiling' };
        if (weeks === 0) return { kind: /** @type {const} */ ('no-statistics-yet') };
        return { kind: /** @type {const} */ ('data'),
          all: Array.from({ length: weeks }, (_, i) => i + 2),
          owner: Array.from({ length: weeks }, (_, i) => i + 1) };
      },
    },
  };
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} metric */
function weekRows(db, metric) {
  return readDaySeries(db, { repositoryId: 1, metric, granularity: /** @type {const} */ ('week'),
    from: '2020-01-01', to: '2030-01-01' });
}

test('a 52-week response produces 52 rows at week granularity whose first day is a week start', async (t) => {
  const db = await fixture(t);
  const { statsClient, calls } = fakeStatsClient(52);
  const summary = await backfillDevelopment({ db, repositoryId: 1, repo: 'owner/archive', statsClient, collectedAt });
  assert.deepEqual(calls, ['commit_activity:owner/archive', 'participation:owner/archive']);
  assert.equal(summary.kind, 'data');
  assert.equal(summary.weeks, 52);
  assert.equal(summary.truncated, false);
  const commits = weekRows(db, COMMIT_ACTIVITY_METRIC);
  assert.equal(commits.length, 52);
  assert.equal(commits[0].day, firstWeekDay);
  assert.equal(commits[0].value, 1);
  assert.equal(commits[51].value, 52);
  for (const row of commits) {
    assert.equal(row.granularity, 'week');
    assert.equal(row.source, 'backfill');
    assert.equal(row.collectedAt, collectedAt);
  }
  const owner = weekRows(db, OWNER_PARTICIPATION_METRIC);
  assert.equal(owner.length, 52);
  assert.equal(owner[0].day, firstWeekDay);
  assert.equal(owner[0].value, 1);
  const record = db.prepare('SELECT window_from AS windowFrom, window_to AS windowTo, truncated FROM backfill_records').get();
  assert.deepEqual({ ...record }, { windowFrom: firstWeekDay,
    windowTo: new Date((firstWeek + 51 * 604800) * 1000).toISOString().slice(0, 10), truncated: 0 });
});

test('a 20-week response produces 20 rows and a backfill record whose stored window is 20 weeks with the truncated flag set', async (t) => {
  const db = await fixture(t);
  const { statsClient } = fakeStatsClient(20);
  const summary = await backfillDevelopment({ db, repositoryId: 1, repo: 'owner/archive', statsClient, collectedAt });
  assert.equal(summary.kind, 'data');
  assert.equal(summary.weeks, 20);
  assert.equal(summary.truncated, true);
  const commits = weekRows(db, COMMIT_ACTIVITY_METRIC);
  assert.equal(commits.length, 20);
  assert.equal(weekRows(db, OWNER_PARTICIPATION_METRIC).length, 20);
  const record = db.prepare('SELECT kind, window_from AS windowFrom, window_to AS windowTo, truncated, collected_at AS collectedAt FROM backfill_records').get();
  const expectedTo = new Date((firstWeek + 19 * 604800) * 1000).toISOString().slice(0, 10);
  assert.deepEqual({ ...record }, { kind: 'development', windowFrom: firstWeekDay, windowTo: expectedTo, truncated: 1, collectedAt });
  const spanWeeks = (Date.parse(`${expectedTo}T00:00:00.000Z`) - Date.parse(`${firstWeekDay}T00:00:00.000Z`)) / (7 * 86400000) + 1;
  assert.equal(spanWeeks, 20);
});

test('an empty response produces no rows and still records a backfill entry', async (t) => {
  const db = await fixture(t);
  const { statsClient } = fakeStatsClient(0);
  const summary = await backfillDevelopment({ db, repositoryId: 1, repo: 'owner/archive', statsClient, collectedAt });
  assert.equal(summary.kind, 'empty');
  assert.equal(summary.rows, 0);
  assert.equal(weekRows(db, COMMIT_ACTIVITY_METRIC).length, 0);
  assert.equal(weekRows(db, OWNER_PARTICIPATION_METRIC).length, 0);
  const record = db.prepare('SELECT kind, window_from AS windowFrom, window_to AS windowTo, truncated FROM backfill_records').get();
  assert.deepEqual({ ...record }, { kind: 'development', windowFrom: null, windowTo: null, truncated: 1 });
});

test('no development row is written at day granularity', async (t) => {
  const db = await fixture(t);
  const { statsClient } = fakeStatsClient(6);
  await backfillDevelopment({ db, repositoryId: 1, repo: 'owner/archive', statsClient, collectedAt });
  const dayRows = db.prepare(
    "SELECT count(*) AS n FROM day_series WHERE granularity = 'day' AND metric IN (?, ?)",
  ).get(COMMIT_ACTIVITY_METRIC, OWNER_PARTICIPATION_METRIC);
  assert.equal(dayRows?.n, 0);
  const weekRowsTotal = db.prepare(
    "SELECT count(*) AS n FROM day_series WHERE granularity = 'week'",
  ).get();
  assert.equal(weekRowsTotal?.n, 12);
});

test('a 202 that never resolved is a retryable outcome: no rows, no record, no error', async (t) => {
  const db = await fixture(t);
  const { statsClient } = fakeStatsClient(0, { retryable: true });
  const summary = await backfillDevelopment({ db, repositoryId: 1, repo: 'owner/archive', statsClient, collectedAt });
  assert.deepEqual(summary, { kind: 'retryable', weeks: 0, rows: 0, truncated: false, windowFrom: null, windowTo: null });
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series').get()?.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM backfill_records').get()?.n, 0);
});

test('re-running over the same input converges and the window record stays honest', async (t) => {
  const db = await fixture(t);
  const first = fakeStatsClient(20);
  await backfillDevelopment({ db, repositoryId: 1, repo: 'owner/archive', statsClient: first.statsClient, collectedAt });
  const second = fakeStatsClient(20);
  await backfillDevelopment({ db, repositoryId: 1, repo: 'owner/archive', statsClient: second.statsClient, collectedAt });
  assert.equal(weekRows(db, COMMIT_ACTIVITY_METRIC).length, 20);
  assert.equal(db.prepare('SELECT count(*) AS n FROM backfill_records').get()?.n, 2);
});
