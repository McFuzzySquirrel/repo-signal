import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { backup } from 'node:sqlite';
import { openDatabase } from './connection.js';

/**
 * @typedef {import('node:sqlite').DatabaseSync} Database
 */

/**
 * @typedef {object} TableCount
 * @property {string} table Table name from sqlite_schema.
 * @property {number} count Stored row count; a count never invents a row.
 */

/**
 * Every PRAGMA integrity_check line. 'ok' alone means the check passed;
 * anything else is the failing message the operator and the exit code need.
 * @param {Database} db
 * @returns {string[]}
 */
export function integrityCheckLines(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  return rows.map((row) => {
    const record = /** @type {Record<string, unknown>} */ (row);
    const key = Object.keys(record)[0] ?? 'integrity_check';
    return String(record[key]);
  });
}

/**
 * Open the archive, run SQLite's integrity check, and report whether it is
 * sound. A corrupt file throws here rather than at open time, so the message
 * ('database disk image is malformed', 'file is not a database') is the
 * operator's reason to refuse the copy.
 * @param {string} databasePath
 * @returns {string[]} The integrity-check lines, 'ok' on success.
 */
export function checkArchiveIntegrity(databasePath) {
  let db;
  try {
    db = openDatabase(databasePath);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  try {
    try {
      return integrityCheckLines(db);
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  } finally {
    db.close();
  }
}

/**
 * Row counts per user table, ordered by table name. Counts are the only
 * cross-command comparison surface; they never carry row values, repository
 * names or observation data.
 * @param {string} databasePath
 * @returns {TableCount[]}
 */
export function tableRowCounts(databasePath) {
  const db = openDatabase(databasePath);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    return tables.map((row) => {
      const name = String(/** @type {{name: string}} */ (row).name);
      const count = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get();
      return { table: name, count: Number(/** @type {{n: number | bigint}} */ (count).n) };
    });
  } finally {
    db.close();
  }
}

/**
 * Write a consistent copy of the archive with the node:sqlite backup facility.
 * The destination is a single self-contained file; WAL state is folded in, so
 * a later file copy of the backup is complete and verifiable on its own.
 * @param {string} databasePath Source archive.
 * @param {string} destinationPath Where the consistent copy lands.
 * @returns {Promise<void>}
 */
export async function backupArchive(databasePath, destinationPath) {
  const db = openDatabase(databasePath);
  try {
    await backup(db, destinationPath);
  } finally {
    db.close();
  }
}

/**
 * Load a backup copy over the current archive, refusing a broken copy.
 * The source is verified BEFORE anything replaces the current archive:
 * a truncated or non-database file exits non-zero and the live archive is
 * never touched. After the copy lands, the restored archive is re-checked and
 * its per-table counts returned so the operator can compare them with the
 * backup's listing.
 * @param {string} sourcePath Backup file to load.
 * @param {string} databasePath Archive to replace.
 * @returns {TableCount[]} Per-table row counts in the restored archive.
 * @throws {Error} When the source fails verification or the restore re-check fails.
 */
export function restoreArchive(sourcePath, databasePath) {
  const sourceCheck = checkArchiveIntegrity(sourcePath);
  if (!(sourceCheck.length === 1 && sourceCheck[0] === 'ok')) {
    throw new Error(`integrity check failed: ${sourceCheck.join('; ')}`);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const stale = `${databasePath}${suffix}`;
    if (existsSync(stale)) rmSync(stale);
  }
  copyFileSync(sourcePath, databasePath);
  const restoredCheck = checkArchiveIntegrity(databasePath);
  if (!(restoredCheck.length === 1 && restoredCheck[0] === 'ok')) {
    throw new Error(`integrity check after restore failed: ${restoredCheck.join('; ')}`);
  }
  return tableRowCounts(databasePath);
}
