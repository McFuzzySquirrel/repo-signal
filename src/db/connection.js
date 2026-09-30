import { DatabaseSync } from 'node:sqlite';
import { resolveHomePaths } from '../paths.js';

/**
 * Open the single archive with foreign keys, WAL and SQLite defensive mode.
 * Unsupported node:sqlite APIs fail closed; a PRAGMA is not a substitute for
 * SQLITE_DBCONFIG_DEFENSIVE. Path ownership stays with src/paths.js.
 * Node 22's flag-free sqlite availability does not imply defensive API support;
 * callers on that runtime must upgrade rather than open an unguarded archive.
 * @param {string} [databasePath] Defaults to the resolved home archive.
 * @returns {DatabaseSync} The caller owns closing this connection.
 */
export function openDatabase(databasePath) {
  if (typeof DatabaseSync.prototype.enableDefensive !== 'function') {
    throw new Error(
      `node:sqlite API drift: Node ${process.versions.node} lacks enableDefensive; ` +
      'use Node 24.12.0 or newer with defensive-mode support before opening the archive',
    );
  }
  const db = new DatabaseSync(databasePath ?? resolveHomePaths().databasePath, {
    enableForeignKeyConstraints: true,
    defensive: true,
    allowExtension: false,
  });
  try {
    db.enableDefensive(true);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
        db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') {
      throw new Error('Archive requires foreign_keys=1 and journal_mode=wal; use a writable file-backed database');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
