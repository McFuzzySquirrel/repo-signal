import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appendSnapshot, readLatestCapture, readSnapshotHistory } from '../src/db/snapshot-repo.js';
import { appendRun, openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';

const earlier = '2026-09-30T01:00:00.000Z';
const later = '2026-09-30T02:00:00.000Z';
/** @type {import('../src/db/snapshot-repo.js').SnapshotInput} */
const entry = { repositoryId: 1, runId: 'run-1', kind: 'referrers', label: 'example.org',
  count: 3, uniques: 2, position: 0, collectedAt: earlier };

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-snapshots-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700);
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  for (const id of [1, 2]) upsertRepository(db, { id, owner: 'owner', name: `repo-${id}`, lastSeenAt: earlier });
  appendRun(db, { id: 'run-1', startedAt: earlier });
  appendRun(db, { id: 'run-2', startedAt: later });
  return db;
}

test('two runs accumulate the same referrer label with both capture times and no day dimension', async (t) => {
  const db = await fixture(t);
  appendSnapshot(db, entry);
  appendSnapshot(db, { ...entry, runId: 'run-2', count: 8, collectedAt: later });
  const history = readSnapshotHistory(db, 1, 'referrers');
  assert.deepEqual(history.map((row) => [row.runId, row.label, row.count, row.collectedAt]), [
    ['run-1', entry.label, 3, earlier], ['run-2', entry.label, 8, later],
  ]);
  assert.notEqual(history[0].id, history[1].id);
  assert.equal(history[0].title, null);
  assert.ok(history.every((row) => !('day' in row)));
  assert.ok(!db.prepare('PRAGMA table_info(snapshots)').all().some((row) => row.name === 'day'));
});

test('latest capture returns the full short list in vendor order without mixing old lists or kinds', async (t) => {
  const db = await fixture(t);
  appendSnapshot(db, entry);
  appendSnapshot(db, { ...entry, repositoryId: 2, collectedAt: later });
  appendSnapshot(db, { ...entry, kind: 'popular_paths', label: '/guide', title: 'Guide', collectedAt: later });
  withTransaction(db, () => {
    for (const position of [2, 0, 1]) appendSnapshot(db, { ...entry, runId: 'run-2',
      label: `referrer-${position}`, position, collectedAt: later });
  });
  const latest = readLatestCapture(db, 1, 'referrers');
  assert.equal(latest.length, 3);
  assert.deepEqual(latest.map((row) => row.position), [0, 1, 2]);
  assert.ok(latest.every((row) => row.runId === 'run-2' && row.collectedAt === later));
  assert.equal(readSnapshotHistory(db, 1, 'referrers').length, 4);
  assert.equal(readLatestCapture(db, 1, 'popular_paths')[0].title, 'Guide');
});

test('latest is ordered by collection time, not arrival order, and tied runs do not merge', async (t) => {
  const db = await fixture(t);
  appendSnapshot(db, { ...entry, runId: 'run-2', collectedAt: later });
  appendSnapshot(db, entry);
  assert.equal(readLatestCapture(db, 1, 'referrers')[0].runId, 'run-2');
  appendSnapshot(db, { ...entry, runId: 'run-1', collectedAt: later });
  assert.deepEqual(readLatestCapture(db, 1, 'referrers').map((row) => row.runId), ['run-1']);
  appendSnapshot(db, { ...entry, runId: 'run-1', collectedAt: later });
  assert.equal(readLatestCapture(db, 1, 'referrers').length, 2);
  assert.equal(readSnapshotHistory(db, 1, 'referrers').length, 4);
});

test('missing stored captures are empty but unknown repository reads fail explicitly', async (t) => {
  const db = await fixture(t);
  assert.deepEqual(readLatestCapture(db, 1, 'referrers'), []);
  assert.deepEqual(readSnapshotHistory(db, 1, 'popular_paths'), []);
  assert.throws(() => readSnapshotHistory(db, 999, 'referrers'), /Unknown repository/);
  assert.throws(() => readLatestCapture(db, 999, 'referrers'), /Unknown repository/);
});

test('SQL guards snapshot provenance and append-only evidence independently of the repository', async (t) => {
  const db = await fixture(t);
  const insert = db.prepare(`INSERT INTO snapshots
    (repository_id, run_id, kind, label, count, uniques, position, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  assert.throws(() => insert.run(1, 'run-1', 'referrers', 'x', 1, 1, 0, null), /NOT NULL constraint/);
  assert.throws(() => insert.run(1, 'missing', 'referrers', 'x', 1, 1, 0, earlier), /FOREIGN KEY constraint/);
  assert.throws(() => insert.run(999, 'run-1', 'referrers', 'x', 1, 1, 0, earlier), /FOREIGN KEY constraint/);
  assert.throws(() => insert.run(1, 'run-1', 'unknown', 'x', 1, 1, 0, earlier), /CHECK constraint/);
  appendSnapshot(db, entry);
  assert.throws(() => db.exec('UPDATE snapshots SET count=99'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM snapshots'), /cannot be deleted/);
  assert.equal(readSnapshotHistory(db, 1, 'referrers')[0].count, 3);
});

test('partial capture rolls back as one transaction and preserves earlier captures', async (t) => {
  const db = await fixture(t);
  appendSnapshot(db, entry);
  assert.throws(() => withTransaction(db, () => {
    appendSnapshot(db, { ...entry, runId: 'run-2', collectedAt: later });
    appendSnapshot(db, { ...entry, runId: 'missing', collectedAt: later });
  }), /FOREIGN KEY constraint/);
  assert.equal(readSnapshotHistory(db, 1, 'referrers').length, 1);
  assert.equal(readLatestCapture(db, 1, 'referrers')[0].collectedAt, earlier);
});
