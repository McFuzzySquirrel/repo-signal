import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.js';
import { migrate, migrationStatus } from '../src/db/migrate.js';
import { resolveHomePaths } from '../src/paths.js';

const earlier = '2026-09-29T01:00:00.000Z';
const later = '2026-09-30T01:00:00.000Z';
const tables = ['backfill_records', 'day_series', 'heartbeats', 'repositories',
  'repository_aliases', 'repository_errors', 'runs', 'schema_migrations', 'snapshots'];

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-schema-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700);
  const db = openDatabase(paths.databasePath);
  t.after(() => db.close());
  assert.deepEqual(await migrate(db), [1]);
  db.prepare('INSERT INTO repositories (id, owner, name, enrolled, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'maintainer', 'archive', 1, earlier);
  db.prepare('INSERT INTO runs (id, started_at) VALUES (?, ?)').run('run-1', earlier);
  db.prepare('INSERT INTO runs (id, started_at) VALUES (?, ?)').run('run-2', later);
  return db;
}

const dayInsert = `INSERT INTO day_series
  (repository_id, metric, granularity, day, value, source, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const snapshotInsert = `INSERT INTO snapshots
  (repository_id, run_id, kind, label, title, count, uniques, position, collected_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

test('initial migration creates every archive table and reapplication is a read-only no-op', async (t) => {
  const db = await fixture(t);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all().map((row) => row.name), tables);
  assert.deepEqual(await migrationStatus(db), { onDiskVersion: 1, codeVersion: 1, pendingVersions: [] });
  const before = db.prepare('SELECT * FROM schema_migrations').all();
  db.exec('PRAGMA query_only = ON');
  assert.deepEqual(await migrate(db), []);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(), before);
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
});

test('duplicate day key upserts to one row carrying the later value, source and collection time', async (t) => {
  const db = await fixture(t);
  const insert = db.prepare(`${dayInsert}
    ON CONFLICT(repository_id, metric, granularity, day) DO UPDATE SET
      value=excluded.value, source=excluded.source, collected_at=excluded.collected_at
    WHERE excluded.collected_at > day_series.collected_at`);
  insert.run(1, 'stars', 'day', '2026-09-28', 0, 'backfill', earlier);
  insert.run(1, 'stars', 'day', '2026-09-28', 7, 'collected', later);
  const rows = db.prepare('SELECT value, source, collected_at FROM day_series').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { value: 7, source: 'collected', collected_at: later });
  insert.run(1, 'stars', 'day', '2026-09-28', 999, 'backfill', earlier);
  assert.deepEqual(db.prepare('SELECT value, source, collected_at FROM day_series').all(), rows);
});

test('all four day key dimensions are independent and duplicate plain inserts are rejected', async (t) => {
  const db = await fixture(t);
  db.prepare('INSERT INTO repositories (id, owner, name, last_seen_at) VALUES (2, ?, ?, ?)')
    .run('maintainer', 'other', earlier);
  const insert = db.prepare(dayInsert);
  insert.run(1, 'stars', 'day', '2026-09-28', 0, 'collected', earlier);
  assert.throws(() => insert.run(1, 'stars', 'day', '2026-09-28', 1, 'collected', later), /UNIQUE constraint failed/);
  insert.run(2, 'stars', 'day', '2026-09-28', 2, 'collected', earlier);
  insert.run(1, 'clones', 'day', '2026-09-28', 3, 'collected', earlier);
  insert.run(1, 'stars', 'week', '2026-09-28', 4, 'backfill', earlier);
  insert.run(1, 'stars', 'day', '2026-09-30', 5, 'collected', earlier);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series').get()?.n, 5);
  assert.equal(db.prepare("SELECT count(*) AS n FROM day_series WHERE day='2026-09-29'").get()?.n, 0);
});

test('unknown day source, unknown granularity and missing collection timestamp fail in SQL', async (t) => {
  const db = await fixture(t);
  const insert = db.prepare(dayInsert);
  assert.throws(() => insert.run(1, 'stars', 'day', '2026-09-28', 1, 'estimated', earlier), /CHECK constraint failed/);
  assert.throws(() => insert.run(1, 'stars', 'month', '2026-09-28', 1, 'collected', earlier), /CHECK constraint failed/);
  assert.throws(() => insert.run(1, 'stars', 'day', '2026-09-28', 1, 'collected', null), /NOT NULL constraint failed/);
  assert.throws(() => db.exec(`INSERT INTO day_series
    (repository_id, metric, granularity, day, value, source)
    VALUES (1, 'stars', 'day', '2026-09-28', 1, 'collected')`), /NOT NULL constraint failed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_series').get()?.n, 0);
});

test('day updates require the same key and a strictly newer collection time', async (t) => {
  const db = await fixture(t);
  db.prepare(dayInsert).run(1, 'stars', 'day', '2026-09-28', 1, 'collected', later);
  for (const timestamp of [earlier, later]) {
    assert.throws(() => db.prepare('UPDATE day_series SET value=99, collected_at=?').run(timestamp), /newer collection time/);
  }
  for (const assignment of ["repository_id=2", "metric='clones'", "granularity='week'", "day='2026-09-29'"]) {
    assert.throws(() => db.exec(`UPDATE day_series SET ${assignment}, collected_at='2026-10-01T01:00:00.000Z'`), /same key/);
  }
  assert.equal(db.prepare('SELECT value FROM day_series').get()?.value, 1);
});

test('same referrer captures coexist across times and runs, without any label or capture uniqueness', async (t) => {
  const db = await fixture(t);
  const insert = db.prepare(snapshotInsert);
  insert.run(1, 'run-1', 'referrers', 'example.org', null, 3, 2, 0, earlier);
  insert.run(1, 'run-2', 'referrers', 'example.org', null, 4, 3, 0, later);
  const rows = db.prepare('SELECT run_id, collected_at FROM snapshots ORDER BY collected_at').all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { run_id: 'run-1', collected_at: earlier }, { run_id: 'run-2', collected_at: later },
  ]);
  insert.run(1, 'run-2', 'referrers', 'example.org', null, 4, 3, 0, later);
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get()?.n, 3);
  assert.ok(!db.prepare('PRAGMA table_info(snapshots)').all().some((column) => column.name === 'day'));
});

test('popular paths preserve title, counts and list position and cannot be updated', async (t) => {
  const db = await fixture(t);
  db.prepare(snapshotInsert).run(1, 'run-1', 'popular_paths', '/guide', 'Guide <intro>', 7, 4, 2, earlier);
  db.prepare(snapshotInsert).run(1, 'run-2', 'popular_paths', '/guide', 'Guide <intro>', 9, 5, 2, later);
  const rows = db.prepare('SELECT label, title, count, uniques, position FROM snapshots ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, { label: '/guide', title: 'Guide <intro>', count: 7, uniques: 4, position: 2 });
  assert.throws(() => db.exec('UPDATE snapshots SET count=100'), /append-only/);
  assert.deepEqual(db.prepare('SELECT label, title, count, uniques, position FROM snapshots ORDER BY id').all(), rows);
});

test('snapshot kind, position, run and collection time constraints are database-enforced', async (t) => {
  const db = await fixture(t);
  const insert = db.prepare(snapshotInsert);
  assert.throws(() => insert.run(1, 'run-1', 'unknown', 'label', null, 1, 1, 0, earlier), /CHECK constraint failed/);
  assert.throws(() => insert.run(1, 'run-1', 'referrers', 'label', null, 1, 1, -1, earlier), /CHECK constraint failed/);
  assert.throws(() => insert.run(1, null, 'referrers', 'label', null, 1, 1, 0, earlier), /NOT NULL constraint failed/);
  assert.throws(() => insert.run(1, 'absent', 'referrers', 'label', null, 1, 1, 0, earlier), /FOREIGN KEY constraint failed/);
  assert.throws(() => insert.run(1, 'run-1', 'referrers', 'label', null, 1, 1, 0, null), /NOT NULL constraint failed/);
  assert.throws(() => db.exec(`INSERT INTO snapshots (repository_id, run_id, kind, label, count, uniques, position)
    VALUES (1, 'run-1', 'referrers', 'label', 1, 1, 0)`), /NOT NULL constraint failed/);
});

test('repository lifecycle changes retain identity, aliases and observations', async (t) => {
  const db = await fixture(t);
  const insert = db.prepare('INSERT INTO repository_aliases (repository_id, owner, name, recorded_at) VALUES (?, ?, ?, ?)');
  insert.run(1, 'maintainer', 'archive', earlier);
  assert.throws(() => insert.run(1, 'maintainer', 'archive', later), /UNIQUE constraint failed/);
  db.prepare(dayInsert).run(1, 'clones', 'day', '2026-09-28', 0, 'collected', earlier);
  db.exec("UPDATE repositories SET owner='new-owner', name='renamed', lifecycle='unavailable', unavailable_reason='not found', enrolled=0 WHERE id=1");
  const row = db.prepare('SELECT id, lifecycle, unavailable_reason, enrolled FROM repositories').get();
  assert.deepEqual({ ...row }, { id: 1, lifecycle: 'unavailable', unavailable_reason: 'not found', enrolled: 0 });
  assert.equal(db.prepare('SELECT repository_id FROM day_series').get()?.repository_id, 1);
  assert.equal(db.prepare('SELECT name FROM repository_aliases').get()?.name, 'archive');
  assert.throws(() => db.exec("UPDATE repositories SET lifecycle='deleted'"), /CHECK constraint failed/);
  assert.throws(() => db.exec('UPDATE repositories SET enrolled=2'), /CHECK constraint failed/);
  assert.throws(() => db.exec('UPDATE repositories SET consecutive_failures=-1'), /CHECK constraint failed/);
  assert.throws(() => db.exec('INSERT INTO repositories (id, owner, name, last_seen_at) VALUES (1, \'x\', \'y\', \'time\')'), /UNIQUE constraint failed/);
});

test('run and heartbeat keys preserve one journal row while allowing progress and closure', async (t) => {
  const db = await fixture(t);
  assert.throws(() => db.prepare('INSERT INTO runs (id, started_at) VALUES (?, ?)').run('run-1', later), /UNIQUE constraint failed/);
  assert.throws(() => db.exec("INSERT INTO runs (id) VALUES ('missing-start')"), /NOT NULL constraint failed/);
  db.prepare('INSERT INTO heartbeats (run_id, started_at, collected_at) VALUES (?, ?, ?)').run('run-1', earlier, earlier);
  assert.throws(() => db.prepare('INSERT INTO heartbeats (run_id, started_at, collected_at) VALUES (?, ?, ?)')
    .run('run-1', earlier, later), /UNIQUE constraint failed/);
  db.prepare('UPDATE runs SET closed_at=?, status=?, success_count=1, duration_ms=1000, request_count=4 WHERE id=?')
    .run(later, 'completed', 'run-1');
  db.prepare('UPDATE heartbeats SET closed_at=?, collected_at=?, completed_repositories=1 WHERE run_id=?')
    .run(later, later, 'run-1');
  assert.equal(db.prepare("SELECT started_at FROM runs WHERE id='run-1'").get()?.started_at, earlier);
  assert.equal(db.prepare("SELECT closed_at FROM heartbeats WHERE run_id='run-1'").get()?.closed_at, later);
  for (const column of ['success_count', 'failure_count', 'request_count', 'duration_ms']) {
    assert.throws(() => db.exec(`UPDATE runs SET ${column}=-1 WHERE id='run-1'`), /CHECK constraint failed/);
  }
  assert.throws(() => db.exec('UPDATE heartbeats SET completed_repositories=-1'), /CHECK constraint failed/);
});

const evidenceInserts = [
  ['repository_aliases', "INSERT INTO repository_aliases (repository_id, owner, name, recorded_at) VALUES (1, 'old', 'name', ?)", 'recorded_at'],
  ['repository_errors', "INSERT INTO repository_errors (repository_id, run_id, kind, message, collected_at) VALUES (1, 'run-1', 'transient', 'retry later', ?)", 'collected_at'],
  ['heartbeats', "INSERT INTO heartbeats (run_id, started_at, collected_at) VALUES ('run-1', '2026-09-29T01:00:00.000Z', ?)", 'collected_at'],
  ['backfill_records', "INSERT INTO backfill_records (repository_id, kind, window_from, window_to, truncated, collected_at) VALUES (1, 'participation', '2026-05-01', '2026-09-28', 1, ?)", 'collected_at'],
];

for (const [table, sql, timestamp] of evidenceInserts) {
  test(`${table} requires provenance and retains evidence without deletion`, async (t) => {
    const db = await fixture(t);
    assert.throws(() => db.prepare(sql).run(null), /NOT NULL constraint failed/);
    const withoutTimestamp = sql.replace(`, ${timestamp}`, '').replace(', ?)', ')');
    assert.throws(() => db.exec(withoutTimestamp), /NOT NULL constraint failed/);
    db.prepare(sql).run(earlier);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /evidence cannot be deleted/);
    if (table !== 'heartbeats') {
      assert.throws(() => db.prepare(`UPDATE ${table} SET ${timestamp}=?`).run(later), /append-only/);
    }
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 1);
  });
}

test('all repository and run foreign keys reject orphaned evidence', async (t) => {
  const db = await fixture(t);
  const orphanInserts = [
    "INSERT INTO repository_aliases VALUES (999, 'owner', 'name', 'time')",
    "INSERT INTO repository_errors (repository_id, run_id, kind, message, collected_at) VALUES (999, 'run-1', 'transient', 'message', 'time')",
    "INSERT INTO repository_errors (repository_id, run_id, kind, message, collected_at) VALUES (1, 'absent', 'transient', 'message', 'time')",
    "INSERT INTO heartbeats (run_id, started_at, collected_at) VALUES ('absent', 'time', 'time')",
    "INSERT INTO backfill_records (repository_id, kind, collected_at) VALUES (999, 'stars', 'time')",
  ];
  // Day and snapshot inserts use bound values to keep every other constraint valid.
  assert.throws(() => db.prepare(dayInsert).run(999, 'stars', 'day', '2026-09-28', 1, 'collected', earlier), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.prepare(snapshotInsert).run(999, 'run-1', 'referrers', 'label', null, 1, 1, 0, earlier), /FOREIGN KEY constraint failed/);
  for (const sql of orphanInserts) {
    assert.throws(() => db.exec(sql), /FOREIGN KEY constraint failed/);
  }
});

test('backfill records retain repeated completions and enforce the truncated flag', async (t) => {
  const db = await fixture(t);
  const insert = db.prepare('INSERT INTO backfill_records (repository_id, kind, truncated, collected_at) VALUES (1, ?, ?, ?)');
  insert.run('stars', 0, earlier);
  insert.run('stars', 1, later);
  assert.equal(db.prepare('SELECT count(*) AS n FROM backfill_records').get()?.n, 2);
  assert.throws(() => insert.run('stars', 2, later), /CHECK constraint failed/);
});

test('snapshot, error and backfill surrogate keys reject explicit duplicate identifiers', async (t) => {
  const db = await fixture(t);
  const inserts = [
    `INSERT INTO snapshots (id, repository_id, run_id, kind, label, count, uniques, position, collected_at)
      VALUES (42, 1, 'run-1', 'referrers', 'label', 1, 1, 0, '${earlier}')`,
    `INSERT INTO repository_errors (id, repository_id, run_id, kind, message, collected_at)
      VALUES (42, 1, 'run-1', 'transient', 'retry later', '${earlier}')`,
    `INSERT INTO backfill_records (id, repository_id, kind, collected_at)
      VALUES (42, 1, 'stars', '${earlier}')`,
  ];
  for (const sql of inserts) {
    db.exec(sql);
    assert.throws(() => db.exec(sql), /UNIQUE constraint failed/);
  }
});

test('repositories, runs, day facts and snapshots cannot be deleted', async (t) => {
  const db = await fixture(t);
  db.prepare(dayInsert).run(1, 'stars', 'day', '2026-09-28', 0, 'collected', earlier);
  db.prepare(snapshotInsert).run(1, 'run-1', 'referrers', 'label', null, 1, 1, 0, earlier);
  for (const table of ['repositories', 'runs', 'day_series', 'snapshots']) {
    const count = db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /evidence cannot be deleted/);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, count);
  }
});
