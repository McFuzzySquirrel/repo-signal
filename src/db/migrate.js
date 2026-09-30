import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url));
const BOOKKEEPING_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT`;

/**
 * @typedef {object} Migration
 * @property {number} version
 * @property {string} file
 * @property {string} checksum SHA-256 of the complete UTF-8 source text.
 */
/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {{directory?: string}} MigrationOptions */

/**
 * Discover numbered ESM modules in lexical order; absent default directory is
 * version zero, until the separately owned core-schema migration is supplied.
 * @param {string} directory
 * @returns {Promise<Migration[]>}
 */
async function discover(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (directory === DEFAULT_DIRECTORY &&
        /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name).sort();
  /** @type {Migration[]} */
  const migrations = [];
  for (const name of files) {
    const match = /^(\d{3})-[a-z0-9-]+\.js$/.exec(name);
    if (!match || Number(match[1]) <= 0) {
      throw new Error(`Invalid migration filename ${name}; use NNN-description.js with a positive version`);
    }
    const version = Number(match[1]);
    if (migrations.some((migration) => migration.version === version)) {
      throw new Error(`Duplicate migration version ${version}; assign a new forward-only version`);
    }
    const file = path.resolve(directory, name);
    const source = await readFile(file, 'utf8');
    migrations.push({ version, file, checksum: createHash('sha256').update(source).digest('hex') });
  }
  return migrations;
}

/**
 * Validate all recorded checksums before any write. Never silently ignore a
 * missing applied file or insert an older migration behind the on-disk version.
 * @param {Database} db
 * @param {Migration[]} migrations
 */
function inspect(db, migrations) {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get();
  const rows = exists ? db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() : [];
  const onDiskVersion = rows.length ? Number(rows[rows.length - 1].version) : 0;
  const codeVersion = migrations.at(-1)?.version ?? 0;
  for (const row of rows) {
    const migration = migrations.find((item) => item.version === row.version);
    if (!migration) {
      throw new Error(`Applied migration ${row.version} is missing from code (on-disk version ${onDiskVersion}, ` +
        `code version ${codeVersion}); restore the original migration files or use matching newer code`);
    }
    if (migration.checksum !== row.checksum) {
      throw new Error(`Migration ${row.version} checksum mismatch: expected ${row.checksum}, actual ${migration.checksum}; ` +
        'restore the original source and add a new numbered migration for changes');
    }
  }
  const pending = migrations.filter((item) => !rows.some((row) => row.version === item.version));
  for (const migration of pending) {
    if (migration.version <= onDiskVersion) {
      throw new Error(`Migration ${migration.version} is behind on-disk version ${onDiskVersion} (code version ${codeVersion}); ` +
        'add a new version after the latest applied migration instead');
    }
  }
  return { onDiskVersion, codeVersion, pendingVersions: pending.map((item) => item.version) };
}

/**
 * Read versions and pending work without creating bookkeeping or writing rows.
 * A changed applied source aborts even when there are no pending versions.
 * @param {Database} db
 * @param {MigrationOptions} [options]
 */
export async function migrationStatus(db, options = {}) {
  return inspect(db, await discover(options.directory ?? DEFAULT_DIRECTORY));
}

/**
 * Return only unapplied versions, preserving lexical migration order and making
 * no writes. Callers can report pending work before deciding to migrate.
 * @param {Database} db
 * @param {MigrationOptions} [options]
 * @returns {Promise<number[]>}
 */
export async function pendingVersions(db, options = {}) {
  return (await migrationStatus(db, options)).pendingVersions;
}

/**
 * Apply forward-only ESM migrations exporting synchronous up(db): void.
 * Source SHA-256, schema changes and bookkeeping commit atomically; re-apply
 * does not invoke up or write anything. No core archive tables are defined here.
 * @param {Database} db
 * @param {MigrationOptions} [options]
 * @returns {Promise<number[]>} Versions applied by this invocation.
 */
export async function migrate(db, options = {}) {
  const migrations = await discover(options.directory ?? DEFAULT_DIRECTORY);
  const status = inspect(db, migrations);
  /** @type {Map<number, (db: Database) => void>} */
  const apply = new Map();
  for (const migration of migrations.filter((item) => status.pendingVersions.includes(item.version))) {
    const url = pathToFileURL(migration.file);
    url.searchParams.set('checksum', migration.checksum);
    const module = await import(url.href);
    if (typeof module.up !== 'function' || module.up.constructor.name === 'AsyncFunction') {
      throw new Error(`Migration ${migration.version} must export synchronous up(db); correct the unapplied module`);
    }
    apply.set(migration.version, module.up);
  }
  if (status.pendingVersions.length === 0 &&
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migrations'").get()) return [];
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check after obtaining the writer lock, in case another process migrated.
    const current = inspect(db, migrations);
    db.exec(BOOKKEEPING_SQL);
    for (const version of current.pendingVersions) {
      const migration = migrations.find((item) => item.version === version);
      const up = apply.get(version);
      if (!migration || !up) throw new Error(`Migration ${version} was not loaded; retry with matching code`);
      const result = /** @type {unknown} */ (up(db));
      if (result && typeof /** @type {{then?: unknown}} */ (result).then === 'function') {
        throw new Error(`Migration ${version} returned a promise; migrations must be synchronous`);
      }
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
        .run(version, migration.checksum, new Date().toISOString());
    }
    db.exec('COMMIT');
    return current.pendingVersions;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
