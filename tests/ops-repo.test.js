import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appendBackfillRecord, appendError, appendHeartbeat, appendRun, completeRun,
  getRepository, getRun, listEnrolledRepositories, openArchive, updateHeartbeat,
  upsertAlias, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { readDaySeries, upsertDayFact } from '../src/db/day-series-repo.js';
import { appendSnapshot, readSnapshotHistory } from '../src/db/snapshot-repo.js';
import { resolveHomePaths } from '../src/paths.js';

const earlier = '2026-09-29T01:00:00.000Z';
const later = '2026-09-30T01:00:00.000Z';
const repository = { id: 1, owner: 'owner', name: 'archive', lastSeenAt: earlier, enrolled: 1 };
const completion = { closedAt: later, status: 'completed', successCount: 1,
  failureCount: 0, requestCount: 4, durationMs: 1000 };
/** @type {import('../src/db/day-series-repo.js').DayFact} */
const fact = { repositoryId: 1, metric: 'clones', granularity: 'day', day: '2026-09-29',
  value: 0, source: 'collected', collectedAt: earlier };
const range = { repositoryId: 1, metric: 'clones', granularity: /** @type {const} */ ('day'),
  from: fact.day, to: fact.day };

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-ops-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700);
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  return { db, paths };
}

test('archive opens through the guarded connection, migrates and persists across reopens', async (t) => {
  const { db, paths } = await fixture(t);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.equal(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()?.version, 1);
  upsertRepository(db, repository);
  upsertDayFact(db, fact);
  const reopened = await openArchive(paths.databasePath);
  try {
    assert.equal(getRepository(reopened, 1).name, 'archive');
    assert.equal(readDaySeries(reopened, range)[0].value, 0);
    assert.equal(reopened.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 1);
  } finally {
    reopened.close();
  }
});

test('repository upsert preserves stable identity, omitted health and observations across lifecycle changes', async (t) => {
  const { db } = await fixture(t);
  upsertRepository(db, { ...repository, lastSuccessAt: earlier, consecutiveFailures: 2 });
  upsertDayFact(db, fact);
  upsertRepository(db, { ...repository, owner: 'new-owner', name: 'renamed', lastSeenAt: later,
    lifecycle: 'unavailable', unavailableReason: 'not found' });
  assert.deepEqual({ ...getRepository(db, 1) }, { ...repository, owner: 'new-owner', name: 'renamed',
    lastSeenAt: later, lifecycle: 'unavailable', unavailableReason: 'not found',
    lastSuccessAt: earlier, consecutiveFailures: 2 });
  assert.equal(readDaySeries(db, range).length, 1);
  upsertRepository(db, { ...repository, lastSeenAt: later, lifecycle: 'active', unavailableReason: null,
    lastSuccessAt: later, consecutiveFailures: 0 });
  assert.equal(getRepository(db, 1).unavailableReason, null);
  assert.equal(getRepository(db, 1).consecutiveFailures, 0);
  assert.throws(() => getRepository(db, 999), /Unknown repository/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repositories').get()?.n, 1);
});

test('enrolled list includes only opt-in rows in stable order and exposes recorded health even when unavailable', async (t) => {
  const { db } = await fixture(t);
  assert.deepEqual(listEnrolledRepositories(db), []);
  upsertRepository(db, { ...repository, id: 3, lifecycle: 'unavailable', unavailableReason: 'token rejected',
    lastSuccessAt: earlier, consecutiveFailures: 4 });
  upsertRepository(db, { ...repository, id: 2, enrolled: 0 });
  upsertRepository(db, repository);
  const rows = listEnrolledRepositories(db);
  assert.deepEqual(rows.map((row) => row.id), [1, 3]);
  assert.equal(rows[1].lastSuccessAt, earlier);
  assert.equal(rows[1].consecutiveFailures, 4);
  assert.equal(rows[1].unavailableReason, 'token rejected');
  upsertRepository(db, { ...repository, enrolled: 0 });
  assert.deepEqual(listEnrolledRepositories(db).map((row) => row.id), [3]);
});

test('alias upsert appends each old name once and never rewrites its first recorded time', async (t) => {
  const { db } = await fixture(t);
  upsertRepository(db, repository);
  const alias = { repositoryId: 1, owner: 'owner', name: 'archive', recordedAt: earlier };
  assert.equal(upsertAlias(db, alias).changes, 1);
  assert.equal(upsertAlias(db, { ...alias, recordedAt: later }).changes, 0);
  upsertAlias(db, { ...alias, owner: 'new-owner', name: 'renamed', recordedAt: later });
  const rows = db.prepare('SELECT owner, name, recorded_at FROM repository_aliases ORDER BY recorded_at').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].recorded_at, earlier);
  assert.throws(() => upsertAlias(db, { ...alias, repositoryId: 999 }), /FOREIGN KEY constraint/);
  assert.throws(() => db.exec('UPDATE repository_aliases SET name=\'other\''), /append-only/);
  assert.throws(() => db.exec('DELETE FROM repository_aliases'), /cannot be deleted/);
});

test('run is appended at start then updated at completion without deleting its start time', async (t) => {
  const { db } = await fixture(t);
  appendRun(db, { id: 'run-1', startedAt: earlier });
  assert.deepEqual({ ...getRun(db, 'run-1') }, { id: 'run-1', startedAt: earlier, closedAt: null,
    status: 'running', successCount: 0, failureCount: 0, requestCount: 0, durationMs: null });
  assert.throws(() => appendRun(db, { id: 'run-1', startedAt: later }), /UNIQUE constraint/);
  completeRun(db, 'run-1', completion);
  assert.deepEqual({ ...getRun(db, 'run-1') }, { id: 'run-1', startedAt: earlier, ...completion });
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get()?.n, 1);
  assert.throws(() => completeRun(db, 'run-1', completion), /already closed/);
  assert.throws(() => completeRun(db, 'missing', completion), /missing/);
  assert.equal(getRun(db, 'missing'), undefined);
  assert.throws(() => db.exec('DELETE FROM runs'), /cannot be deleted/);
});

test('errors and backfill completions append repeatedly without guessing absent windows or modifying health', async (t) => {
  const { db } = await fixture(t);
  upsertRepository(db, repository);
  appendRun(db, { id: 'run-1', startedAt: earlier });
  for (const collectedAt of [earlier, later]) {
    appendError(db, { repositoryId: 1, runId: 'run-1', kind: 'authentication',
      message: 'reauthentication required', collectedAt });
    appendBackfillRecord(db, { repositoryId: 1, kind: 'stars', truncated: false, collectedAt });
  }
  appendBackfillRecord(db, { repositoryId: 1, kind: 'participation', truncated: true,
    windowFrom: '2026-03-01', windowTo: '2026-09-28', collectedAt: later });
  const errors = db.prepare('SELECT collected_at FROM repository_errors ORDER BY id').all();
  assert.deepEqual(errors.map((row) => row.collected_at), [earlier, later]);
  const records = db.prepare('SELECT * FROM backfill_records ORDER BY id').all();
  assert.equal(records.length, 3);
  assert.equal(records[0].window_from, null);
  assert.equal(records[0].window_to, null);
  assert.equal(records[2].truncated, 1);
  assert.equal(records[2].window_from, '2026-03-01');
  assert.equal(getRepository(db, 1).consecutiveFailures, 0);
  assert.equal(getRepository(db, 1).lastSuccessAt, null);
  for (const table of ['repository_errors', 'backfill_records']) {
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /cannot be deleted/);
    assert.throws(() => db.exec(`UPDATE ${table} SET collected_at='new'`), /append-only/);
  }
});

test('heartbeat start and closure preserve original start and reject stale or duplicate evidence', async (t) => {
  const { db } = await fixture(t);
  appendRun(db, { id: 'run-1', startedAt: earlier });
  const heartbeat = { runId: 'run-1', startedAt: earlier, collectedAt: earlier };
  appendHeartbeat(db, heartbeat);
  assert.throws(() => appendHeartbeat(db, heartbeat), /UNIQUE constraint/);
  const tick = '2026-09-29T02:00:00.000Z';
  updateHeartbeat(db, 'run-1', { collectedAt: tick, completedRepositories: 1 });
  assert.equal(db.prepare('SELECT closed_at FROM heartbeats').get()?.closed_at, null);
  assert.throws(() => updateHeartbeat(db, 'run-1', { collectedAt: earlier, completedRepositories: 0 }), /not older/);
  updateHeartbeat(db, 'run-1', { collectedAt: later, completedRepositories: 2, closedAt: later });
  const row = db.prepare('SELECT * FROM heartbeats').get();
  assert.equal(row?.started_at, earlier);
  assert.equal(row?.closed_at, later);
  assert.equal(row?.collected_at, later);
  assert.equal(row?.completed_repositories, 2);
  assert.throws(() => updateHeartbeat(db, 'missing', { collectedAt: later, completedRepositories: 1 }), /missing/);
  assert.throws(() => db.exec('DELETE FROM heartbeats'), /cannot be deleted/);
});

test('schema independently rejects negative health/counts, missing timestamps and orphan operations', async (t) => {
  const { db } = await fixture(t);
  upsertRepository(db, repository);
  appendRun(db, { id: 'run-1', startedAt: earlier });
  assert.throws(() => db.exec('UPDATE repositories SET consecutive_failures=-1'), /CHECK constraint/);
  assert.throws(() => completeRun(db, 'run-1', { ...completion, requestCount: -1 }), /CHECK constraint/);
  assert.equal(getRun(db, 'run-1')?.closedAt, null);
  const errorInsert = db.prepare(`INSERT INTO repository_errors
    (repository_id, run_id, kind, message, collected_at) VALUES (?, ?, 'transient', 'failure', ?)`);
  assert.throws(() => errorInsert.run(1, 'run-1', null), /NOT NULL constraint/);
  assert.throws(() => errorInsert.run(1, 'missing', earlier), /FOREIGN KEY constraint/);
  assert.throws(() => errorInsert.run(999, 'run-1', earlier), /FOREIGN KEY constraint/);
  assert.throws(() => db.exec("INSERT INTO heartbeats (run_id, started_at) VALUES ('run-1', 'time')"), /NOT NULL constraint/);
  assert.throws(() => db.exec("INSERT INTO backfill_records (repository_id, kind) VALUES (1, 'stars')"), /NOT NULL constraint/);
  assert.throws(() => appendHeartbeat(db, { runId: 'missing', startedAt: earlier, collectedAt: earlier }), /FOREIGN KEY constraint/);
  assert.throws(() => appendBackfillRecord(db, { repositoryId: 999, kind: 'stars', truncated: false, collectedAt: earlier }), /FOREIGN KEY constraint/);
});

test('caller-selected transaction commits all evidence or rolls it back without affecting another repository', async (t) => {
  const { db } = await fixture(t);
  upsertRepository(db, repository);
  appendRun(db, { id: 'run-1', startedAt: earlier });
  const result = withTransaction(db, () => {
    upsertDayFact(db, fact);
    appendSnapshot(db, { repositoryId: 1, runId: 'run-1', kind: 'referrers', label: 'example.org',
      count: 1, uniques: 1, position: 0, collectedAt: earlier });
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.throws(() => withTransaction(db, () => {
    upsertRepository(db, { ...repository, id: 2, name: 'other' });
    upsertDayFact(db, { ...fact, repositoryId: 2 });
    appendBackfillRecord(db, { repositoryId: 2, kind: 'stars', truncated: false, collectedAt: later });
    throw new Error('repository failed');
  }), /repository failed/);
  assert.throws(() => getRepository(db, 2), /Unknown repository/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM backfill_records').get()?.n, 0);
  assert.equal(readDaySeries(db, range).length, 1);
  assert.equal(readSnapshotHistory(db, 1, 'referrers').length, 1);
  assert.throws(() => withTransaction(db, () => {
    upsertDayFact(db, { ...fact, value: 99, collectedAt: later });
    throw new Error('correction failed');
  }), /correction failed/);
  assert.equal(readDaySeries(db, range)[0].value, 0);
  // Writer remains usable after rollback.
  withTransaction(db, () => upsertRepository(db, { ...repository, id: 3 }));
  assert.equal(getRepository(db, 3).id, 3);
});

test('transaction rejects async bodies before invocation and rolls back thenable returns', async (t) => {
  const { db } = await fixture(t);
  let invoked = false;
  assert.throws(() => withTransaction(db, async () => { invoked = true; }), /must be synchronous/);
  assert.equal(invoked, false);
  assert.throws(() => withTransaction(db, () => {
    upsertRepository(db, repository);
    return Promise.resolve();
  }), /returned a promise/);
  assert.deepEqual(listEnrolledRepositories(db), []);
  withTransaction(db, () => upsertRepository(db, repository));
  assert.equal(listEnrolledRepositories(db).length, 1);
});
