import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CONNECTED, FIRST_COLLECTED_KIND, NOT_CONNECTED, readProvenance, stampFirstCollected } from '../src/backfill/provenance.js';
import { upsertDayFact } from '../src/db/day-series-repo.js';
import { appendBackfillRecord, openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';

const firstCollection = '2026-10-02T09:15:00.000Z';
const firstDay = '2026-10-02';
const moduleSource = readFileSync(new URL('../src/backfill/provenance.js', import.meta.url), 'utf8');

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-provenance-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'maintainer', name: 'archive',
    lastSeenAt: '2026-10-02T09:15:00.000Z', enrolled: 1 });
  return db;
}

/**
 * Record the two first-connect backfills so the read has real evidence to report.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function recordBackfills(db) {
  appendBackfillRecord(db, { repositoryId: 1, kind: 'stars', truncated: false,
    collectedAt: '2026-10-02T09:10:00.000Z' });
  appendBackfillRecord(db, { repositoryId: 1, kind: 'development', windowFrom: '2025-10-06',
    windowTo: '2026-09-28', truncated: true, collectedAt: '2026-10-02T09:12:00.000Z' });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
function countRows(db, table) {
  return db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
}

test('a repository with no collected data reports not-connected and no first collected day', async (t) => {
  const db = await fixture(t);
  recordBackfills(db);
  const provenance = readProvenance(db, 1, { today: firstDay });
  assert.equal(provenance.state, NOT_CONNECTED);
  assert.equal(provenance.firstCollectedDay, null);
  assert.equal(provenance.firstCollectedAt, null);
  assert.equal(provenance.connectedToday, false);
  assert.deepEqual(provenance.backfillKinds, ['development', 'stars']);
});

test('a repository with no records at all reports not-connected, no first day and no backfill', async (t) => {
  const db = await fixture(t);
  assert.deepEqual(readProvenance(db, 1, { today: firstDay }), {
    state: NOT_CONNECTED,
    firstCollectedDay: null,
    firstCollectedAt: null,
    connectedToday: false,
    backfillCompleted: false,
    backfillKinds: [],
    backfillCompletedAt: null,
    backfills: [],
  });
});

test('the first collection stamps the day once and a second call leaves the original day unchanged', async (t) => {
  const db = await fixture(t);
  recordBackfills(db);
  assert.deepEqual(stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection }),
    { day: firstDay, stamped: true });
  assert.deepEqual(readProvenance(db, 1, { today: firstDay }), {
    state: CONNECTED,
    firstCollectedDay: firstDay,
    firstCollectedAt: firstCollection,
    connectedToday: true,
    backfillCompleted: true,
    backfillKinds: ['development', 'stars'],
    backfillCompletedAt: '2026-10-02T09:12:00.000Z',
    backfills: [
      { kind: 'development', windowFrom: '2025-10-06', windowTo: '2026-09-28', truncated: true,
        collectedAt: '2026-10-02T09:12:00.000Z' },
      { kind: 'stars', windowFrom: null, windowTo: null, truncated: false,
        collectedAt: '2026-10-02T09:10:00.000Z' },
    ],
  });

  assert.deepEqual(stampFirstCollected(db, 1, { day: '2026-10-09', collectedAt: '2026-10-09T09:15:00.000Z' }),
    { day: firstDay, stamped: false });
  const after = readProvenance(db, 1, { today: firstDay });
  assert.equal(after.firstCollectedDay, firstDay);
  assert.equal(after.firstCollectedAt, firstCollection);
  assert.deepEqual(after.backfillKinds, ['development', 'stars']);
  assert.equal(countRows(db, 'backfill_records'), 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM backfill_records WHERE kind=?')
    .get(FIRST_COLLECTED_KIND)?.n, 1);
  const stamp = db.prepare('SELECT window_from AS dayFrom, window_to AS dayTo, collected_at AS collectedAt FROM backfill_records WHERE kind=?')
    .get(FIRST_COLLECTED_KIND);
  assert.deepEqual({ ...stamp }, { dayFrom: firstDay, dayTo: firstDay, collectedAt: firstCollection });
});

test('the stamped boundary cannot be rewritten or removed by a later run', async (t) => {
  const db = await fixture(t);
  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  assert.throws(() => db.prepare('UPDATE backfill_records SET window_from=? WHERE kind=?')
    .run('2020-01-01', FIRST_COLLECTED_KIND), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM backfill_records WHERE kind=?').run(FIRST_COLLECTED_KIND),
    /cannot be deleted/);
  assert.equal(readProvenance(db, 1, { today: firstDay }).firstCollectedDay, firstDay);
});

test('a repository whose first collected day is today is reported as connected today', async (t) => {
  const db = await fixture(t);
  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  const sameDay = readProvenance(db, 1, { today: firstDay });
  assert.equal(sameDay.state, CONNECTED);
  assert.equal(sameDay.connectedToday, true);
  assert.equal(sameDay.firstCollectedDay, firstDay);
  const laterDay = readProvenance(db, 1, { today: '2026-10-09' });
  assert.equal(laterDay.state, CONNECTED);
  assert.equal(laterDay.connectedToday, false);
  assert.equal(laterDay.firstCollectedDay, firstDay);
});

test('a boundary from an earlier day is not today without an injected reference day', async (t) => {
  const db = await fixture(t);
  stampFirstCollected(db, 1, { day: '2024-03-01', collectedAt: '2024-03-01T09:15:00.000Z' });
  const provenance = readProvenance(db, 1);
  assert.equal(provenance.state, CONNECTED);
  assert.equal(provenance.firstCollectedDay, '2024-03-01');
  assert.equal(provenance.connectedToday, false);
});

test('the provenance read lists which backfill kinds have completed', async (t) => {
  const db = await fixture(t);
  recordBackfills(db);
  appendBackfillRecord(db, { repositoryId: 1, kind: 'stars', windowFrom: '2019-01-02',
    windowTo: '2026-10-02', truncated: false, collectedAt: '2026-10-02T09:14:00.000Z' });
  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  const provenance = readProvenance(db, 1, { today: firstDay });
  assert.equal(provenance.backfillCompleted, true);
  assert.deepEqual(provenance.backfillKinds, ['development', 'stars']);
  assert.equal(provenance.backfillCompletedAt, '2026-10-02T09:14:00.000Z');
  assert.deepEqual(provenance.backfills.map((backfill) => [backfill.kind, backfill.windowFrom,
    backfill.windowTo, backfill.truncated]), [
    ['development', '2025-10-06', '2026-09-28', true],
    ['stars', '2019-01-02', '2026-10-02', false],
  ]);
  assert.equal(provenance.backfillKinds.includes(FIRST_COLLECTED_KIND), false);
});

test('the first collected day comes from the stamp and never from a stored metric row', async (t) => {
  const db = await fixture(t);
  // A backfilled star curve and a collected traffic window that both predate any stamp.
  for (const day of ['2019-04-01', '2019-04-03']) {
    upsertDayFact(db, { repositoryId: 1, metric: 'stars', granularity: /** @type {const} */ ('day'),
      day, value: 12, source: /** @type {const} */ ('backfill'), collectedAt: '2026-10-02T09:10:00.000Z' });
  }
  for (const metric of ['clones', 'views']) {
    upsertDayFact(db, { repositoryId: 1, metric, granularity: /** @type {const} */ ('day'),
      day: '2026-09-20', value: 3, source: /** @type {const} */ ('collected'), collectedAt: firstCollection });
  }
  const uncollected = readProvenance(db, 1, { today: firstDay });
  assert.equal(uncollected.state, NOT_CONNECTED);
  assert.equal(uncollected.firstCollectedDay, null);

  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  const collected = readProvenance(db, 1, { today: firstDay });
  assert.equal(collected.firstCollectedDay, firstDay);
  assert.equal(collected.connectedToday, true);
  assert.equal(moduleSource.includes('day_series'), false);
});

test('provenance records facts only: no metric rows, no snapshots and no view import', async (t) => {
  const db = await fixture(t);
  recordBackfills(db);
  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  const before = readProvenance(db, 1, { today: firstDay });
  assert.equal(countRows(db, 'day_series'), 0);
  assert.equal(countRows(db, 'snapshots'), 0);
  assert.deepEqual(readProvenance(db, 1, { today: firstDay }), before);
  for (const forbidden of ['server/', 'views/', 'node:fs', 'node:http']) {
    assert.equal(moduleSource.includes(forbidden), false, `provenance must not import ${forbidden}`);
  }
  assert.equal(moduleSource.includes('clones'), false);
  assert.equal(moduleSource.includes('views'), false);
});

test('an invalid boundary or an unknown repository is rejected instead of recorded', async (t) => {
  const db = await fixture(t);
  for (const day of ['2026-02-30', '2026-10-2', '2026-10-02T00:00:00.000Z', '', 'tomorrow']) {
    assert.throws(() => stampFirstCollected(db, 1, { day, collectedAt: firstCollection }),
      /Invalid boundary day/, `day ${JSON.stringify(day)} must be refused`);
  }
  assert.throws(() => stampFirstCollected(db, 1, { day: firstDay, collectedAt: '2026-10-02 09:15' }),
    /Invalid collection timestamp/);
  assert.throws(() => stampFirstCollected(db, 404, { day: firstDay, collectedAt: firstCollection }),
    /Unknown repository 404/);
  assert.throws(() => readProvenance(db, 404), /Unknown repository 404/);
  assert.throws(() => readProvenance(db, 1, { today: 'not-a-day' }), /Invalid boundary day/);
  assert.equal(countRows(db, 'backfill_records'), 0);
  assert.equal(readProvenance(db, 1, { today: firstDay }).state, NOT_CONNECTED);
});