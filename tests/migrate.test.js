import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.js';
import { migrate, migrationStatus, pendingVersions } from '../src/db/migrate.js';
import { resolveHomePaths } from '../src/paths.js';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-migrate-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700);
  const directory = path.join(root, 'migrations');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
  const db = openDatabase(paths.databasePath);
  t.after(() => db.close());
  return { db, directory, options: { directory }, paths };
}

/** @param {string} source */
const checksum = (source) => createHash('sha256').update(source).digest('hex');
const first = "export function up(db) { if (db.prepare('PRAGMA user_version').get().user_version !== 0) " +
  "throw new Error('first migration reapplied or out of order'); db.exec('PRAGMA user_version = 1'); }\n";
const second = "export function up(db) { db.exec('PRAGMA user_version = 2'); }\n";

test('connection enforces foreign keys, WAL and actual defensive behavior', (t) => {
  const { db } = fixture(t);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  // SQLite has no defensive readback PRAGMA. writable_schema is forced off by
  // the real DBCONFIG flag; the negative control proves this is not a vacuous check.
  db.exec('PRAGMA writable_schema = ON');
  assert.equal(db.prepare('PRAGMA writable_schema').get()?.writable_schema, 0);
  db.enableDefensive(false);
  db.exec('PRAGMA writable_schema = ON');
  assert.equal(db.prepare('PRAGMA writable_schema').get()?.writable_schema, 1);
  db.exec('PRAGMA writable_schema = OFF');
  db.enableDefensive(true);
});

test('unsupported node:sqlite fails closed before creating an archive', (t) => {
  const root = mkdtempSync('/tmp/opencode/repo-signal-api-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'enableDefensive');
  Object.defineProperty(DatabaseSync.prototype, 'enableDefensive', { value: undefined, configurable: true });
  try {
    const file = path.join(root, 'archive.sqlite3');
    assert.throws(() => openDatabase(file), /API drift.*lacks enableDefensive.*use Node 24\.12\.0/);
    assert.equal(existsSync(file), false);
  } finally {
    if (original) Object.defineProperty(DatabaseSync.prototype, 'enableDefensive', original);
    else Reflect.deleteProperty(DatabaseSync.prototype, 'enableDefensive');
  }
});

test('empty database reports pending versions without writing, then migrates in lexical order', async (t) => {
  const { db, directory, options } = fixture(t);
  writeFileSync(path.join(directory, '002-second.js'), second);
  writeFileSync(path.join(directory, '001-first.js'), first);
  assert.deepEqual(await pendingVersions(db, options), [1, 2]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get()?.n, 0);
  assert.deepEqual(await migrate(db, options), [1, 2]);
  assert.deepEqual(await migrationStatus(db, options), { onDiskVersion: 2, codeVersion: 2, pendingVersions: [] });
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
  const rows = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(rows.map(({ version, checksum }) => ({ version, checksum })),
    [{ version: 1, checksum: checksum(first) }, { version: 2, checksum: checksum(second) }]);
  for (const row of rows) assert.equal(new Date(String(row.applied_at)).toISOString(), row.applied_at);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name),
    ['schema_migrations']);
});

test('re-applying performs no writes and preserves checksum and timestamp across reopen', async (t) => {
  const { db, directory, options, paths } = fixture(t);
  writeFileSync(path.join(directory, '001-first.js'), first);
  await migrate(db, options);
  const before = db.prepare('SELECT * FROM schema_migrations').all();
  const changes = db.prepare('SELECT total_changes() AS n').get()?.n;
  const schema = db.prepare('PRAGMA schema_version').get()?.schema_version;
  // A genuine no-op must also succeed when SQLite forbids every write, not
  // merely leave total_changes() unchanged (which does not count schema writes).
  db.exec('PRAGMA query_only = ON');
  try {
    assert.deepEqual(await migrate(db, options), []);
  } finally {
    db.exec('PRAGMA query_only = OFF');
  }
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n, changes);
  assert.equal(db.prepare('PRAGMA schema_version').get()?.schema_version, schema);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(), before);
  const reopened = openDatabase(paths.databasePath);
  try {
    assert.deepEqual(await migrate(reopened, options), []);
    assert.deepEqual(reopened.prepare('SELECT * FROM schema_migrations').all(), before);
    assert.equal(reopened.prepare('SELECT total_changes() AS n').get()?.n, 0);
  } finally { reopened.close(); }
});

test('tampered checksum aborts with expected and actual hashes before pending writes', async (t) => {
  const { db, directory, options } = fixture(t);
  const file = path.join(directory, '001-first.js');
  writeFileSync(file, first);
  await migrate(db, options);
  const tampered = `${first}// altered source\n`;
  writeFileSync(file, tampered);
  writeFileSync(path.join(directory, '002-second.js'), second);
  const before = db.prepare('SELECT * FROM schema_migrations').all();
  const changes = db.prepare('SELECT total_changes() AS n').get()?.n;
  for (const read of [migrate, migrationStatus, pendingVersions]) {
    await assert.rejects(read(db, options), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`expected ${checksum(first)}`));
      assert.ok(error.message.includes(`actual ${checksum(tampered)}`));
      assert.match(error.message, /Migration 1.*restore the original source/);
      return true;
    });
  }
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(), before);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n, changes);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
});

test('failed migration rolls back schema work and bookkeeping together', async (t) => {
  const { db, directory, options } = fixture(t);
  writeFileSync(path.join(directory, '001-first.js'), first);
  writeFileSync(path.join(directory, '002-failure.js'),
    "export function up(db) { db.exec('PRAGMA user_version = 99'); throw new Error('fixture failure'); }\n");
  await assert.rejects(migrate(db, options), /fixture failure/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get()?.n, 0);
  assert.deepEqual(await pendingVersions(db, options), [1, 2]);
});

test('a synchronous migration returning a promise rolls back instead of recording success', async (t) => {
  const { db, directory, options } = fixture(t);
  writeFileSync(path.join(directory, '001-promise.js'),
    "export function up(db) { db.exec('PRAGMA user_version = 99'); return Promise.resolve(); }\n");
  await assert.rejects(migrate(db, options), /returned a promise.*must be synchronous/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get()?.n, 0);
  assert.deepEqual(await pendingVersions(db, options), [1]);
});

test('missing applied files and retroactive versions are rejected rather than silently skipped', async (t) => {
  const { db, directory, options } = fixture(t);
  const file = path.join(directory, '002-second.js');
  writeFileSync(file, second);
  await migrate(db, options);
  writeFileSync(path.join(directory, '001-first.js'), first);
  await assert.rejects(migrate(db, options), /behind on-disk version 2.*add a new version/);
  rmSync(file);
  await assert.rejects(migrate(db, options), /Applied migration 2 is missing.*on-disk version 2, code version 1/);
});

test('migration module contract and duplicate versions fail before bookkeeping is created', async (t) => {
  const { db, directory, options } = fixture(t);
  const file = path.join(directory, '001-invalid.js');
  writeFileSync(file, 'export async function up() {}\n');
  await assert.rejects(migrate(db, options), /must export synchronous up/);
  writeFileSync(path.join(directory, '001-duplicate.js'), first);
  await assert.rejects(migrate(db, options), /Duplicate migration version 1/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get()?.n, 0);
});

test('framework with no migration modules creates bookkeeping only and becomes a no-op', async (t) => {
  const { db, options } = fixture(t);
  assert.deepEqual(await migrationStatus(db, options), { onDiskVersion: 0, codeVersion: 0, pendingVersions: [] });
  assert.deepEqual(await migrate(db, options), []);
  const schema = db.prepare('PRAGMA schema_version').get()?.schema_version;
  assert.deepEqual(await migrate(db, options), []);
  assert.equal(db.prepare('PRAGMA schema_version').get()?.schema_version, schema);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(), []);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name),
    ['schema_migrations']);
});

test('bookkeeping enforces version uniqueness, positive versions and non-null provenance in SQL', async (t) => {
  const { db, options } = fixture(t);
  await migrate(db, options);
  const insert = db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)');
  const hash = checksum(first);
  const timestamp = '2026-09-30T00:00:00.000Z';
  insert.run(1, hash, timestamp);
  assert.throws(() => insert.run(1, hash, timestamp), /UNIQUE constraint failed/);
  assert.throws(() => insert.run(0, hash, timestamp), /CHECK constraint failed/);
  assert.throws(() => insert.run(2, 'short', timestamp), /CHECK constraint failed/);
  assert.throws(() => insert.run(2, null, timestamp), /NOT NULL constraint failed/);
  assert.throws(() => insert.run(2, hash, null), /NOT NULL constraint failed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 1);
});
