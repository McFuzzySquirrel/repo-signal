import { backupArchive, checkArchiveIntegrity, restoreArchive, tableRowCounts } from '../db/backup.js';
import { openDatabase } from '../db/connection.js';
import { migrate, migrationStatus } from '../db/migrate.js';
import { resolveHomePaths } from '../paths.js';
import { redact } from '../credentials/redact.js';
import { UsageError } from './index.js';

/** @param {unknown} error @returns {string} */
function safeMessage(error) {
  return redact(error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * @param {import('./index.js').CommandContext} context
 * @returns {{ databasePath: string }}
 */
function archivePath(context) {
  const paths = resolveHomePaths({ env: context.env, cwd: context.cwd });
  return { databasePath: paths.databasePath };
}

/** @param {import('./index.js').CommandContext} context @returns {Promise<number>} */
export async function dbMigrate(context) {
  if (context.args.length !== 0) {
    throw new UsageError(redact('db migrate accepts no arguments; run node src/cli.js db migrate'));
  }
  const { databasePath } = archivePath(context);
  const db = openDatabase(databasePath);
  try {
    const applied = await migrate(db);
    context.print(redact(`database: ${databasePath}`));
    context.print(applied.length === 0
      ? 'migrated: no pending migrations'
      : `migrated: applied ${applied.join(', ')}`);
    return 0;
  } catch (error) {
    context.printError(`db migrate failed: ${safeMessage(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

/** @param {import('./index.js').CommandContext} context @returns {Promise<number>} */
export async function dbStatus(context) {
  if (context.args.length !== 0) {
    throw new UsageError(redact('db status accepts no arguments; run node src/cli.js db status'));
  }
  const { databasePath } = archivePath(context);
  const db = openDatabase(databasePath);
  try {
    const status = await migrationStatus(db);
    context.print(redact(`database: ${databasePath}`));
    context.print(`schema version (code): ${status.codeVersion}`);
    context.print(`schema version (on disk): ${status.onDiskVersion}`);
    context.print(`migration pending: ${status.pendingVersions.length === 0 ? 'no' : `yes (${status.pendingVersions.join(', ')})`}`);
    return 0;
  } catch (error) {
    context.printError(`db status failed: ${safeMessage(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

/** @param {import('./index.js').CommandContext} context @returns {number} */
export function dbVerify(context) {
  if (context.args.length !== 0) {
    throw new UsageError(redact('db verify accepts no arguments; run node src/cli.js db verify'));
  }
  const { databasePath } = archivePath(context);
  const lines = checkArchiveIntegrity(databasePath);
  if (lines.length === 1 && lines[0] === 'ok') {
    context.print(redact(`database: ${databasePath}`));
    context.print('integrity check: ok');
    return 0;
  }
  context.print(redact(`database: ${databasePath}`));
  for (const line of lines) context.printError(`integrity check failed: ${safeMessage(line)}`);
  return 1;
}

/** @param {import('./index.js').CommandContext} context @returns {Promise<number>} */
export async function dbBackup(context) {
  if (context.args.length !== 1) {
    throw new UsageError(redact('db backup needs a destination path; run node src/cli.js db backup <path>'));
  }
  const destination = context.args[0];
  const { databasePath } = archivePath(context);
  try {
    await backupArchive(databasePath, destination);
    context.print(redact(`backup written: ${destination}`));
    for (const { table, count } of tableRowCounts(databasePath)) {
      context.print(`${table}: ${count}`);
    }
    return 0;
  } catch (error) {
    context.printError(`db backup failed: ${safeMessage(error)}`);
    return 1;
  }
}

/** @param {import('./index.js').CommandContext} context @returns {number} */
export function dbRestore(context) {
  if (context.args.length !== 1) {
    throw new UsageError(redact('db restore needs a backup path; run node src/cli.js db restore <path>'));
  }
  const source = context.args[0];
  const { databasePath } = archivePath(context);
  try {
    const counts = restoreArchive(source, databasePath);
    context.print(redact(`restored: ${source}`));
    context.print('integrity check: ok');
    for (const { table, count } of counts) {
      context.print(`${table}: ${count}`);
    }
    return 0;
  } catch (error) {
    context.printError(`db restore failed: ${safeMessage(error)}`);
    return 1;
  }
}
