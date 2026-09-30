import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { calendarDays, readDaySeries, upsertDayFact } from '../src/db/day-series-repo.js';
import { openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';

const earlier = '2026-09-29T01:00:00.000Z';
const later = '2026-09-30T01:00:00.000Z';
/** @type {import('../src/db/day-series-repo.js').DayFact} */
const fact = { repositoryId: 1, metric: 'clones', granularity: 'day', day: '2026-09-28',
  value: 0, source: 'backfill', collectedAt: earlier };
const range = { repositoryId: 1, metric: 'clones', granularity: /** @type {const} */ ('day'),
  from: '2026-09-28', to: '2026-09-30' };

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-days-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700);
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'owner', name: 'archive', lastSeenAt: earlier, enrolled: 1 });
  upsertRepository(db, { id: 2, owner: 'owner', name: 'other', lastSeenAt: earlier });
  return db;
}

test('re-collected window corrects one key with the second value, source and collection time', async (t) => {
  const db = await fixture(t);
  upsertDayFact(db, fact);
  upsertDayFact(db, { ...fact, day: '2026-09-30', value: 8 });
  assert.equal(upsertDayFact(db, { ...fact, value: 7, source: 'collected', collectedAt: later }).changes, 1);
  const rows = readDaySeries(db, range);
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { ...fact, value: 7, source: 'collected', collectedAt: later },
    { ...fact, day: '2026-09-30', value: 8 },
  ]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series WHERE day=?').get(fact.day)?.n, 1);
  for (const collectedAt of [earlier, later]) {
    assert.equal(upsertDayFact(db, { ...fact, value: 999, collectedAt }).changes, 0);
  }
  assert.deepEqual(readDaySeries(db, range), rows);
});

test('inclusive range returns a stored zero and no hole while calendarDays includes the hole', async (t) => {
  const db = await fixture(t);
  // Reverse insertion order must not determine read order.
  upsertDayFact(db, { ...fact, day: range.to, value: 5, source: 'collected', collectedAt: later });
  upsertDayFact(db, fact);
  const rows = readDaySeries(db, range);
  const days = calendarDays(range.from, range.to);
  assert.deepEqual(days, ['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.deepEqual(rows.map((row) => row.day), [range.from, range.to]);
  assert.equal(rows[0].value, 0);
  assert.equal(rows[0].source, 'backfill');
  assert.equal(rows[1].source, 'collected');
  assert.ok(rows.every((row) => days.includes(row.day)));
  assert.deepEqual(days.filter((day) => !rows.some((row) => row.day === day)), ['2026-09-29']);
  assert.deepEqual(readDaySeries(db, { ...range, from: '2026-09-29', to: '2026-09-29' }), []);
  assert.deepEqual(readDaySeries(db, { ...range, from: range.to }), [rows[1]]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series').get()?.n, 2);
});

test('range never fills from a different metric, repository, granularity or outside its bounds', async (t) => {
  const db = await fixture(t);
  upsertDayFact(db, fact);
  for (const extra of [
    { repositoryId: 2, day: '2026-09-29' }, { metric: 'views', day: '2026-09-29' },
    { granularity: /** @type {const} */ ('week'), day: '2026-09-29' },
    { day: '2026-09-27' }, { day: '2026-10-01' },
  ]) upsertDayFact(db, { ...fact, ...extra, value: 99 });
  assert.deepEqual(readDaySeries(db, range).map((row) => row.day), [fact.day]);
  assert.deepEqual(readDaySeries(db, { ...range, metric: 'stars' }), []);
  assert.throws(() => readDaySeries(db, { ...range, repositoryId: 999 }), /Unknown repository/);
});

test('calendarDays handles leap days, year boundaries and single days in UTC', () => {
  assert.deepEqual(calendarDays('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(calendarDays('2025-12-31', '2026-01-01'), ['2025-12-31', '2026-01-01']);
  assert.deepEqual(calendarDays('2026-03-08', '2026-03-10'), ['2026-03-08', '2026-03-09', '2026-03-10']);
  assert.deepEqual(calendarDays('2026-09-30', '2026-09-30'), ['2026-09-30']);
  for (const day of ['2026-02-29', '2026-04-31', '2026-9-1', 'not-a-day', '2026-09-30T00:00:00Z']) {
    assert.throws(() => calendarDays(day, '2026-12-31'), /Invalid calendar day/);
    assert.throws(() => calendarDays('2026-01-01', day), /Invalid calendar day/);
  }
  assert.throws(() => calendarDays('2026-09-30', '2026-09-28'), /Reversed day range/);
});

test('bad dates and noncanonical timestamps fail without writing facts', async (t) => {
  const db = await fixture(t);
  assert.throws(() => upsertDayFact(db, { ...fact, day: '2026-02-30' }), /Invalid calendar day/);
  for (const collectedAt of ['2026-09-29T01:00:00Z', '2026-09-29T02:00:00.000+01:00',
    '2026-02-30T01:00:00.000Z', 'invalid']) {
    assert.throws(() => upsertDayFact(db, { ...fact, collectedAt }), /Invalid collection timestamp/);
  }
  assert.throws(() => readDaySeries(db, { ...range, from: range.to, to: range.from }), /Reversed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series').get()?.n, 0);
});

test('SQL independently rejects invalid source, missing provenance, orphan facts and deletes', async (t) => {
  const db = await fixture(t);
  const insert = db.prepare(`INSERT INTO day_series
    (repository_id, metric, granularity, day, value, source, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  assert.throws(() => insert.run(1, 'clones', 'day', fact.day, 0, 'estimated', earlier), /CHECK constraint/);
  assert.throws(() => insert.run(1, 'clones', 'day', fact.day, 0, 'collected', null), /NOT NULL constraint/);
  assert.throws(() => insert.run(999, 'clones', 'day', fact.day, 0, 'collected', earlier), /FOREIGN KEY constraint/);
  upsertDayFact(db, fact);
  assert.throws(() => db.exec('DELETE FROM day_series'), /cannot be deleted/);
  assert.equal(readDaySeries(db, range).length, 1);
});
