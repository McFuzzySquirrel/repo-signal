#!/usr/bin/env node
/**
 * The backup and restore drill.
 *
 * This script proves the procedure the runbook documents, on scratch directories
 * that live outside every work tree and are deleted afterwards, so the archive
 * restore path is exercised by a human and by continuous integration without
 * touching a maintainer's real archive.
 *
 * Two modes:
 *
 *   node scripts/backup-drill.mjs                the whole drill: a scratch home is
 *                                                 created, a small known dataset is
 *                                                 written through the repositories, a
 *                                                 backup copy is taken with the database
 *                                                 command, the copy is restored into a
 *                                                 second scratch home, the integrity
 *                                                 check runs there, and the per-table
 *                                                 row counts of the two homes are
 *                                                 compared. Any difference exits
 *                                                 non-zero.
 *   node scripts/backup-drill.mjs <copy>          rehearse one backup copy that
 *                                                 already exists: it is restored into a
 *                                                 fresh scratch home and its per-table
 *                                                 counts are compared with the copy's
 *                                                 own. A copy that fails its integrity
 *                                                 check is reported and the drill exits
 *                                                 non-zero.
 *
 * `--keep` leaves the scratch directories in place and prints where they are.
 *
 * What it prints is deliberately narrow: scratch paths, table names, row counts
 * and the refusal a command printed. No observation value, no repository name and
 * no credential material is ever printed; every line passes through the credential
 * redactor before it is written.
 *
 * It makes no network request: it imports storage modules and spawns the `db`
 * subcommands, none of which contact a remote host.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { redact } from '../src/credentials/redact.js';
import { tableRowCounts } from '../src/db/backup.js';
import { upsertDayFact } from '../src/db/day-series-repo.js';
import {
  appendBackfillRecord,
  appendError,
  openArchive,
  upsertAlias,
  upsertRepository,
  withTransaction,
} from '../src/db/ops-repo.js';
import { appendSnapshot } from '../src/db/snapshot-repo.js';
import {
  CONFIG_FILE_NAME,
  CREDENTIALS_FILE_NAME,
  DATABASE_FILE_NAME,
  HOME_DIRECTORY_MODE,
  resolveHomePaths,
} from '../src/paths.js';
import { createRunJournal } from '../src/supervision/journal.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');
const SCRATCH_PREFIX = 'repo-signal-backup-drill-';
const KEEP_FLAG = '--keep';
const COPIES_DIRECTORY_NAME = 'copies';
const ORIGINAL_HOME_NAME = 'home-original';
const RESTORED_HOME_NAME = 'home-restored';
const COMMAND_TIMEOUT_MS = 30_000;
const ALL_PERMISSION_BITS = 0o777;

/**
 * One table's name and the number of rows stored in it, as the `db backup`
 * and `db restore` listings report them. Counts are the only cross-command
 * comparison surface: they carry no repository name and no observation value.
 * @typedef {[string, number]} TableCountPair
 */

/**
 * Identity of the known dataset the drill writes, and the instant it writes it
 * under. The names and the values are distinctive so a test can assert they never
 * reach the drill's output; none of them is ever printed by it.
 */
const SEED_REPOSITORY_ID = 1001;
const SEED_OWNER = 'drill-owner';
const SEED_NAME = 'drill-repo';
const SEED_ALIAS_NAME = 'drill-archive-name';
const SEED_RUN_ID = 'drill-run-0001';
const SEED_ERROR_MESSAGE = 'drill synthetic failure, never printed';
const SEED_INSTANT_MS = Date.parse('2026-09-29T01:00:00.000Z');

/**
 * What each table holds once the known dataset is written, in the order
 * `tableRowCounts` reports. The drill compares the original home against this,
 * so a write that silently failed cannot make the round trip pass by being absent
 * from both sides.
 * @type {TableCountPair[]}
 */
const KNOWN_ROW_COUNTS = [
  ['backfill_records', 1],
  ['day_series', 3],
  ['heartbeats', 1],
  ['repositories', 1],
  ['repository_aliases', 1],
  ['repository_errors', 1],
  ['runs', 1],
  ['schema_migrations', 1],
  ['snapshots', 2],
];

/**
 * @param {string} line
 * @returns {void}
 */
function print(line) {
  process.stdout.write(`${redact(line)}\n`);
}

/**
 * @param {string} line
 * @returns {void}
 */
function printError(line) {
  process.stderr.write(`backup-drill: ${redact(line)}\n`);
}

/**
 * @param {number} epochMs
 * @returns {string} Canonical UTC ISO instant, the form the archive stores.
 */
function isoAt(epochMs) {
  return new Date(epochMs).toISOString();
}

/**
 * Run one `db` subcommand the way an operator runs it: the real entry point, in a
 * child process, against one resolved home.
 * @param {string[]} args Command words after `node src/cli.js`.
 * @param {string} home Absolute home the command resolves.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCommand(args, home) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, REPO_SIGNAL_HOME: home, NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    const reason = /** @type {NodeJS.ErrnoException} */ (result.error).code ?? result.error.message;
    return { status: 1, stdout: '', stderr: `could not run node src/cli.js ${args.join(' ')} (${reason})` };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * The per-table row counts a `db backup` or `db restore` listing prints. Only a
 * `table: count` line is read, so a message can never be mistaken for a count.
 * @param {string} output
 * @returns {TableCountPair[]}
 */
function parseCounts(output) {
  /** @type {TableCountPair[]} */
  const counts = [];
  for (const line of output.split('\n')) {
    const match = /^([a-z_]+): (\d+)$/.exec(line.trim());
    if (match !== null) counts.push([match[1] ?? '', Number(match[2])]);
  }
  return counts;
}

/**
 * @param {string} label Prefix that names which home a count belongs to.
 * @param {TableCountPair[]} counts
 * @returns {void}
 */
function printCounts(label, counts) {
  for (const [table, count] of counts) print(`${label} ${table}: ${count}`);
}

/**
 * @param {TableCountPair[]} counts
 * @param {TableCountPair[]} expected
 * @returns {string[]} One line per table whose stored count is not the known one.
 */
function differencesFromKnown(counts, expected) {
  /** @type {string[]} */
  const problems = [];
  const stored = new Map(counts);
  for (const [table, count] of expected) {
    const actual = stored.get(table);
    if (actual === undefined) problems.push(`${table}: no row count was reported, expected ${count}`);
    else if (actual !== count) problems.push(`${table}: ${actual} rows stored, expected ${count}`);
    stored.delete(table);
  }
  for (const table of stored.keys()) problems.push(`${table}: reported a row count the known dataset does not define`);
  return problems;
}

/**
 * Both listings describe an archive, so a pair of empty listings means there was
 * no schema to compare - a mistyped path, or a home that was never migrated - and
 * agreement between nothing is not a passing drill.
 * @param {TableCountPair[]} left
 * @param {TableCountPair[]} right
 * @returns {string[]} One line per difference; empty when the two listings agree.
 */
function differences(left, right) {
  /** @type {string[]} */
  const problems = [];
  if (left.length === 0 || right.length === 0) {
    return [
      `no table was counted (${left.length} in the first listing, ${right.length} in the second); ` +
      'a home with no schema has nothing to compare, so migrate it before treating it as a backup',
    ];
  }
  const leftCounts = new Map(left);
  const rightCounts = new Map(right);
  for (const [table, count] of left) {
    const other = rightCounts.get(table);
    if (other === undefined) problems.push(`${table}: ${count} rows in the first listing, no count in the second`);
    else if (other !== count) problems.push(`${table}: ${count} rows in the first listing, ${other} in the second`);
  }
  for (const [table, count] of right) {
    if (!leftCounts.has(table)) problems.push(`${table}: no count in the first listing, ${count} rows in the second`);
  }
  return problems;
}

/**
 * Write the known dataset into a scratch home through the repositories, so the
 * drill exercises the same writes the collector makes rather than raw SQL.
 * @param {string} home Absolute scratch home.
 * @returns {Promise<void>}
 */
async function seedKnownDataset(home) {
  const { databasePath } = resolveHomePaths({ env: { ...process.env, REPO_SIGNAL_HOME: home }, cwd: ROOT });
  const db = await openArchive(databasePath);
  try {
    let tickMs = SEED_INSTANT_MS;
    // The journal takes its instants from an injected clock, and a heartbeat only
    // accepts a strictly newer tick, so the drill's clock advances by one second.
    const clock = () => {
      tickMs += 1000;
      return tickMs;
    };
    withTransaction(db, () => {
      upsertRepository(db, {
        id: SEED_REPOSITORY_ID,
        owner: SEED_OWNER,
        name: SEED_NAME,
        lifecycle: 'active',
        enrolled: 1,
        lastSeenAt: isoAt(SEED_INSTANT_MS),
        lastSuccessAt: isoAt(SEED_INSTANT_MS + 10_000),
      });
      upsertAlias(db, {
        repositoryId: SEED_REPOSITORY_ID,
        owner: SEED_OWNER,
        name: SEED_ALIAS_NAME,
        recordedAt: isoAt(SEED_INSTANT_MS),
      });
      const dayFacts = /** @type {const} */ ([
        { metric: 'clones', day: '2026-09-27', value: 4101, source: 'backfill' },
        { metric: 'clones', day: '2026-09-28', value: 4102, source: 'collected' },
        { metric: 'views', day: '2026-09-28', value: 4103, source: 'collected' },
      ]);
      for (const fact of dayFacts) {
        upsertDayFact(db, {
          repositoryId: SEED_REPOSITORY_ID,
          metric: fact.metric,
          granularity: 'day',
          day: fact.day,
          value: fact.value,
          source: fact.source,
          collectedAt: isoAt(SEED_INSTANT_MS + 20_000),
        });
      }
    });
    const journal = createRunJournal({ db, runId: SEED_RUN_ID, clock });
    journal.start();
    journal.progress({ completedRepositories: 1 });
    journal.close({
      status: 'completed',
      successCount: 1,
      failureCount: 0,
      requestCount: 3,
      completedRepositories: 1,
    });
    withTransaction(db, () => {
      appendSnapshot(db, {
        repositoryId: SEED_REPOSITORY_ID,
        runId: SEED_RUN_ID,
        kind: 'referrers',
        label: 'github.com',
        count: 5101,
        uniques: 5102,
        position: 1,
        collectedAt: isoAt(SEED_INSTANT_MS + 30_000),
      });
      appendSnapshot(db, {
        repositoryId: SEED_REPOSITORY_ID,
        runId: SEED_RUN_ID,
        kind: 'referrers',
        label: 'example.invalid',
        count: 5103,
        uniques: 5104,
        position: 2,
        collectedAt: isoAt(SEED_INSTANT_MS + 30_000),
      });
      appendError(db, {
        repositoryId: SEED_REPOSITORY_ID,
        runId: SEED_RUN_ID,
        kind: 'drill',
        message: SEED_ERROR_MESSAGE,
        collectedAt: isoAt(SEED_INSTANT_MS + 40_000),
      });
      appendBackfillRecord(db, {
        repositoryId: SEED_REPOSITORY_ID,
        kind: 'traffic',
        windowFrom: '2026-09-15',
        windowTo: '2026-09-28',
        truncated: false,
        collectedAt: isoAt(SEED_INSTANT_MS + 40_000),
      });
    });
  } finally {
    db.close();
  }
}

/**
 * A restored home must hold the archive and nothing else: the backup carries the
 * archive only, so the credential file and the configuration never travel with a
 * copy. The home also keeps the mode it was created with.
 * @param {string} home Absolute restored home.
 * @returns {string[]} One line per problem; empty when the home is as expected.
 */
function restoredHomeProblems(home) {
  /** @type {string[]} */
  const problems = [];
  /** @type {import('node:fs').Stats} */
  let stats;
  try {
    stats = statSync(home);
  } catch (error) {
    return [`${home} is not a readable directory (${error instanceof Error ? error.message : String(error)})`];
  }
  const mode = stats.mode & ALL_PERMISSION_BITS;
  if (mode !== HOME_DIRECTORY_MODE) {
    problems.push(`${home} is mode ${mode.toString(8).padStart(3, '0')}, not ${HOME_DIRECTORY_MODE.toString(8).padStart(3, '0')}`);
  }
  const present = readdirSync(home);
  for (const forbidden of [CREDENTIALS_FILE_NAME, CONFIG_FILE_NAME]) {
    if (present.includes(forbidden)) problems.push(`${home} holds ${forbidden}; a backup copy must never carry one`);
  }
  if (!present.includes(DATABASE_FILE_NAME)) {
    problems.push(`no archive file was written to ${home}`);
  }
  return problems;
}

/**
 * @param {{ status: number, stdout: string, stderr: string }} result
 * @returns {void}
 */
function reportRefusal(result) {
  for (const line of result.stderr.split('\n')) {
    if (line.trim() !== '') printError(line.trim());
  }
}

/**
 * The whole drill: seed a scratch home, back it up with the database command,
 * restore the copy into a second scratch home, verify it there, and compare the
 * per-table row counts.
 * @param {string} scratch The drill's scratch root.
 * @returns {Promise<number>} Exit code: 0 when every step agrees.
 */
async function runRoundTrip(scratch) {
  const originalHome = path.join(scratch, ORIGINAL_HOME_NAME);
  const restoredHome = path.join(scratch, RESTORED_HOME_NAME);
  const copiesDirectory = path.join(scratch, COPIES_DIRECTORY_NAME);
  mkdirSync(copiesDirectory, { recursive: true, mode: 0o700 });
  print(`drill: scratch root ${scratch}`);
  print(`drill: original home ${originalHome}`);
  print(`drill: restored home ${restoredHome}`);

  await seedKnownDataset(originalHome);

  const backupPath = path.join(copiesDirectory, `archive-${new Date().toISOString().slice(0, 10)}.sqlite3`);
  const backup = runCommand(['db', 'backup', backupPath], originalHome);
  if (backup.status !== 0) {
    printError(`db backup failed against the scratch home (exit ${backup.status})`);
    reportRefusal(backup);
    return 1;
  }
  print(`drill: backup copy ${backupPath}`);
  const original = parseCounts(backup.stdout);
  printCounts('original', original);
  const seedProblems = differencesFromKnown(original, KNOWN_ROW_COUNTS);
  if (seedProblems.length > 0) {
    for (const problem of seedProblems) printError(`known dataset: ${problem}`);
    return 1;
  }
  print(`known dataset: ${KNOWN_ROW_COUNTS.length} tables hold the rows the drill wrote`);

  const restore = runCommand(['db', 'restore', backupPath], restoredHome);
  if (restore.status !== 0) {
    printError(`db restore failed against the backup copy (exit ${restore.status})`);
    reportRefusal(restore);
    return 1;
  }
  const restored = parseCounts(restore.stdout);
  printCounts('restored', restored);

  const verify = runCommand(['db', 'verify'], restoredHome);
  if (verify.status !== 0) {
    printError(`db verify failed in the restored home (exit ${verify.status})`);
    reportRefusal(verify);
    return 1;
  }
  print('restored home: integrity check ok');

  const problems = [...differences(original, restored), ...restoredHomeProblems(restoredHome)];
  if (problems.length > 0) {
    for (const problem of problems) printError(`mismatch: ${problem}`);
    return 1;
  }
  print(`row counts: identical across ${original.length} tables`);
  print('drill: passed');
  return 0;
}

/**
 * Rehearse a copy the operator already has: restore it into a fresh scratch home,
 * verify it, and compare its per-table counts with the counts the copy itself
 * reports. A copy that fails its integrity check is detected and the drill exits
 * non-zero without the restored archive being written.
 * @param {string} scratch The drill's scratch root.
 * @param {string} copyPath Backup copy to rehearse.
 * @returns {Promise<number>} Exit code: 0 when the copy restores and agrees.
 */
async function rehearseCopy(scratch, copyPath) {
  const resolvedCopy = path.resolve(ROOT, copyPath);
  print(`drill: copy under rehearsal ${resolvedCopy}`);
  /** @type {import('node:fs').Stats} */
  let stats;
  try {
    stats = statSync(resolvedCopy);
  } catch (error) {
    printError(`${resolvedCopy} could not be read (${error instanceof Error ? error.message : String(error)}); ` +
      'pass the path of a backup copy this machine can read');
    return 1;
  }
  if (!stats.isFile()) {
    printError(`${resolvedCopy} is not a regular file, so it cannot be a backup copy`);
    return 1;
  }

  const rehearsalHome = path.join(scratch, RESTORED_HOME_NAME);
  const restore = runCommand(['db', 'restore', resolvedCopy], rehearsalHome);
  if (restore.status !== 0) {
    printError(`db restore refused the copy (exit ${restore.status}); the copy is truncated, not a database, or corrupt`);
    reportRefusal(restore);
    const problems = restoredHomeProblems(rehearsalHome);
    for (const problem of problems) printError(`refused copy: ${problem}`);
    return 1;
  }
  const restored = parseCounts(restore.stdout);
  printCounts('restored', restored);

  const verify = runCommand(['db', 'verify'], rehearsalHome);
  if (verify.status !== 0) {
    printError(`db verify failed after restoring the copy (exit ${verify.status})`);
    reportRefusal(verify);
    return 1;
  }
  print('restored home: integrity check ok');

  /** @type {TableCountPair[]} */
  let copyCounts;
  try {
    copyCounts = tableRowCounts(resolvedCopy).map(({ table, count }) => [table, count]);
  } catch (error) {
    printError(`${resolvedCopy} could not be counted (${error instanceof Error ? error.message : String(error)})`);
    return 1;
  }
  printCounts('copy', copyCounts);
  const problems = [...differences(copyCounts, restored), ...restoredHomeProblems(rehearsalHome)];
  if (problems.length > 0) {
    for (const problem of problems) printError(`mismatch: ${problem}`);
    return 1;
  }
  print(`row counts: identical across ${restored.length} tables`);
  print('drill: passed');
  return 0;
}

/** @returns {void} */
function printUsage() {
  print('Usage:');
  print('  node scripts/backup-drill.mjs            run the whole drill on a scratch home');
  print('  node scripts/backup-drill.mjs <copy>      rehearse one backup copy that already exists');
  print('  node scripts/backup-drill.mjs --keep      leave the scratch directories for inspection');
}

process.exitCode = await (async () => {
  const argv = process.argv.slice(2);
  const keep = argv.includes(KEEP_FLAG);
  const operands = argv.filter((token) => !token.startsWith('-'));
  const unknown = argv.filter((token) => token.startsWith('-') && token !== KEEP_FLAG);
  if (unknown.length > 0) {
    printError(`${unknown.join(' ')} is not a flag of this drill; the only flag is ${KEEP_FLAG}`);
    printUsage();
    return 2;
  }
  if (operands.length > 1) {
    printError(`expected at most one backup copy path, got ${operands.length}: ${operands.join(' ')}`);
    printUsage();
    return 2;
  }
  const scratch = mkdtempSync(path.join(tmpdir(), SCRATCH_PREFIX));
  let exitCode;
  try {
    exitCode = operands.length === 1 ? await rehearseCopy(scratch, /** @type {string} */ (operands[0])) : await runRoundTrip(scratch);
  } catch (error) {
    printError(`the drill itself failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  if (keep) {
    print(`drill: scratch root kept at ${scratch}`);
  } else {
    rmSync(scratch, { recursive: true, force: true });
  }
  return exitCode;
})();