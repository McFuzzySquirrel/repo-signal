import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { backupArchive, restoreArchive, tableRowCounts } from '../src/db/backup.js';
import { openDatabase } from '../src/db/connection.js';
import { migrate, migrationStatus } from '../src/db/migrate.js';
import {
  CONFIG_FILE_NAME,
  CREDENTIALS_FILE_NAME,
  DATABASE_FILE_NAME,
  HOME_DIRECTORY_MODE,
  resolveHomePaths,
} from '../src/paths.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRILL = path.join(ROOT, 'scripts', 'backup-drill.mjs');
const README = path.join(ROOT, 'README.md');
const RUNBOOK = path.join(ROOT, 'docs', 'operations', 'backup-and-migrate.md');
const FEATURE = path.join(ROOT, 'docs', 'features', 'archive-storage.md');

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../src/paths.js').HomePaths} HomePaths */

const ALL_PERMISSION_BITS = 0o777;

/**
 * The suffixes SQLite gives the two write-ahead side files it keeps beside an
 * open WAL archive. The names are derived from the archive file name the path
 * module owns, so a change to that name cannot leave the documents behind.
 */
const SIDE_FILE_SUFFIXES = ['-wal', '-shm'];

/** A backtick, spelled this way so a template literal can interpolate one. */
const TICK = String.fromCharCode(96);

/** @param {number} mode @returns {string} Four octal digits, the form an operator reads. */
function octal(mode) {
  return mode.toString(8).padStart(4, '0');
}

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Flatten a document's line wrapping, so an assertion about a sentence does not
 * depend on where the prose happens to wrap.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One `##` section of a document, flattened. A heading that is not there fails
 * the test rather than matching the whole document by accident.
 * @param {string} file
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function section(file, heading) {
  return flatten(sectionText(file, heading));
}

/**
 * One `##` section of a document with its line structure intact, for a document
 * whose claim is carried by a table row rather than by a sentence.
 * @param {string} file
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function sectionText(file, heading) {
  const text = read(file);
  const marker = `## ${heading}\n`;
  assert.ok(text.includes(marker), `${path.basename(file)} has no "## ${heading}" section`);
  const body = text.slice(text.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * A scratch home this suite owns, outside every work tree. Nothing here touches
 * a maintainer's real home, and the directory is removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {HomePaths}
 */
function scratchHome(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-signal-contract-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { ...process.env, REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(
    statSync(paths.home).mode & ALL_PERMISSION_BITS,
    HOME_DIRECTORY_MODE,
    `the scratch home is not mode ${octal(HOME_DIRECTORY_MODE)}, which the documented inventory names`,
  );
  return paths;
}

/**
 * Write one repository row, so the archive has content the write-ahead log has
 * to carry rather than a log with nothing in it.
 * @param {Database} db
 * @returns {void}
 */
function writeRepository(db) {
  db.prepare(
    'INSERT INTO repositories (id, owner, name, enrolled, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  ).run(1, 'contract-owner', 'contract-archive', 1, '2026-09-29T01:00:00.000Z');
}

/**
 * The tables the schema actually creates, read from the migrated archive rather
 * than copied out of a document or a migration.
 * @param {Database} db
 * @returns {string[]}
 */
function schemaTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(/** @type {{name: string}} */ (row).name));
}

/**
 * The table names the backup drill's `KNOWN_ROW_COUNTS` literal names. The drill
 * does not export the constant, so it is read from the script's own source: the
 * comparison this suite exists to make is between the schema and the drill.
 * @returns {Map<string, number>}
 */
function drillKnownRowCounts() {
  const source = read(DRILL);
  const declaration = /const KNOWN_ROW_COUNTS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(declaration !== null, 'scripts/backup-drill.mjs declares no KNOWN_ROW_COUNTS literal');
  const literal = declaration[1] ?? '';
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const match of literal.matchAll(/\[\s*'([a-z_]+)'\s*,\s*(\d+)\s*\]/g)) {
    counts.set(match[1] ?? '', Number(match[2]));
  }
  assert.ok(counts.size > 0, 'the drill names no known row count, so the comparison would be vacuous');
  return counts;
}

/**
 * The table names the storage feature document's schema section publishes, read
 * from the first cell of each row of its table.
 * @returns {string[]}
 */
function documentedSchemaTables() {
  const section4 = sectionText(FEATURE, '4. Schema');
  const names = [];
  for (const row of section4.split('\n')) {
    const match = /^\|\s*`([a-z_]+)`\s*\|/.exec(row);
    if (match !== null) names.push(match[1] ?? '');
  }
  return names.sort();
}

// RS-STO-C01: the connection sets both pragmas and reads them back, and refuses
// to continue when either read-back is not what the archive requires. The
// documents publish a home inventory that is only true because WAL is on.
test('the opened archive reads back foreign_keys=1 and journal_mode=wal, not the options it was asked for', async (t) => {
  const { databasePath } = scratchHome(t);
  const db = openDatabase(databasePath);
  t.after(() => db.close());
  // Both values are read from the handle rather than from the options object the
  // caller passed, because a PRAGMA that failed to take effect would otherwise
  // leave the archive running undefended while looking protected.
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1, 'foreign_keys is not 1 on the opened archive');
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal', 'journal_mode is not wal on the opened archive');
});

test('the connection refuses to continue when it cannot read journal_mode=wal back', () => {
  // A database that cannot hold a write-ahead log is the refusal this check
  // exists for: the archive would otherwise run without the side files the
  // documented inventory promises.
  assert.throws(
    () => openDatabase(':memory:'),
    /foreign_keys=1 and journal_mode=wal/,
    'an archive that cannot journal in WAL mode was opened anyway',
  );
});

test('opening fails closed without the defensive option, naming the running Node version and the declared floor', (t) => {
  const { databasePath } = scratchHome(t);
  const engines = JSON.parse(read(path.join(ROOT, 'package.json')));
  const range = String(/** @type {{engines?: {node?: string}}} */ (engines).engines?.node ?? '');
  const declaredFloor = /^>=(\d+\.\d+\.\d+)$/.exec(range)?.[1] ?? '';
  assert.notEqual(declaredFloor, '', `package.json declares engines.node=${range}, which the test cannot read as a floor`);
  const original = DatabaseSync.prototype.enableDefensive;
  assert.equal(typeof original, 'function', 'this runtime has no enableDefensive, so the refusal cannot be exercised');
  try {
    // The refusal has to be the first thing the connection does, before any
    // handle exists, so a runtime without the option never opens an archive.
    delete /** @type {{enableDefensive?: unknown}} */ (DatabaseSync.prototype).enableDefensive;
    assert.throws(
      () => openDatabase(databasePath),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(`Node ${process.versions.node.replaceAll('.', '\\.')} lacks enableDefensive`),
          'the refusal does not name the running Node version');
        assert.ok(message.includes(declaredFloor), `the refusal does not name the declared floor ${declaredFloor}`);
        return true;
      },
      'an archive was opened on a runtime without the defensive option',
    );
  } finally {
    DatabaseSync.prototype.enableDefensive = original;
  }
  assert.equal(existsSync(databasePath), false, 'the refused open still created an archive file');
});

// RS-STO-C04 and the home inventory: the side files belong to the open archive,
// so the documents have to name the exact names the connection creates. A restore
// deletes them, which is why a copy is taken through the driver's own backup.
test('an open archive creates exactly the two side files both documents name, and a clean close takes them away', async (t) => {
  const { databasePath, home } = scratchHome(t);
  const db = openDatabase(databasePath);
  await migrate(db);
  writeRepository(db);
  const expected = [DATABASE_FILE_NAME, ...SIDE_FILE_SUFFIXES.map((suffix) => `${DATABASE_FILE_NAME}${suffix}`)];
  assert.deepEqual(
    readdirSync(home).sort(),
    [...expected].sort(),
    `the open archive holds something the documented inventory does not name; it should hold ${expected.join(', ')}`,
  );
  db.close();
  // A clean shutdown folds the log into the archive, so the side files are not
  // left behind as a second copy of anything.
  assert.deepEqual(readdirSync(home), [DATABASE_FILE_NAME], 'a clean close left a write-ahead side file behind');
});

test('the README and the backup runbook both name the side files, their owner and what a restore does with them', () => {
  const inventories = [
    { name: 'README.md', section: section(README, 'Where everything lives') },
    { name: 'docs/operations/backup-and-migrate.md', section: section(RUNBOOK, 'Where the archive lives') },
  ];
  for (const { name, section: inventory } of inventories) {
    for (const suffix of SIDE_FILE_SUFFIXES) {
      const sideFile = `${DATABASE_FILE_NAME}${suffix}`;
      assert.ok(
        inventory.includes(`${TICK}${sideFile}${TICK}`),
        `${name} does not name ${sideFile}, which the connection creates beside the archive`,
      );
    }
    // The three files the home owns keep their own rows: the side files are an
    // addition to that inventory, never a replacement of it.
    for (const own of [CONFIG_FILE_NAME, CREDENTIALS_FILE_NAME, DATABASE_FILE_NAME]) {
      assert.ok(inventory.includes(`${TICK}${own}${TICK}`), `${name} no longer names ${own} in its home inventory`);
    }
    assert.ok(
      inventory.includes(`mode ${TICK}${octal(HOME_DIRECTORY_MODE)}${TICK}`),
      `${name} does not name the home directory mode ${octal(HOME_DIRECTORY_MODE)}`,
    );
    // The sentence that stops a reader copying three files and calling it a backup.
    assert.match(inventory, /belong to the open archive/, `${name} does not say the side files belong to the open archive`);
    assert.match(inventory, /not to a separate copy|rather than to a separate copy/,
      `${name} does not say the side files are not a separate copy`);
    assert.match(inventory, /`node src\/cli\.js db restore` removes them|A restore removes them/,
      `${name} does not say a restore removes the side files`);
  }
  // The restore warning in the runbook already said it; the inventory names the
  // same two files, so the two cannot drift apart.
  const warning = section(RUNBOOK, 'A restore replaces the current archive');
  for (const suffix of SIDE_FILE_SUFFIXES) {
    assert.ok(
      warning.includes(`${TICK}${DATABASE_FILE_NAME}${suffix}${TICK}`),
      `the restore warning no longer names ${DATABASE_FILE_NAME}${suffix}`,
    );
  }
});

test('a backup copy carries the open archive whole and a restore removes the side files beside it', async (t) => {
  const { databasePath, home } = scratchHome(t);
  const db = openDatabase(databasePath);
  await migrate(db);
  writeRepository(db);
  const copyDirectory = path.join(path.dirname(home), 'copies');
  // `db backup` writes the file it is given and creates no directory, which is
  // what the runbook says it does, so the directory is made here.
  mkdirSync(copyDirectory, { mode: HOME_DIRECTORY_MODE });
  const copy = path.join(copyDirectory, 'archive-copy.sqlite3');
  // The copy is taken while the source archive is open, so the log still holds
  // writes: a copy that missed them would prove the side files were not folded in.
  await backupArchive(databasePath, copy);
  const openCounts = tableRowCounts(databasePath);
  assert.deepEqual(readdirSync(copyDirectory), ['archive-copy.sqlite3'], 'a copy was written with a side file beside it');
  assert.deepEqual(
    tableRowCounts(copy),
    openCounts,
    'the copy does not carry what the open archive holds, so the write-ahead log was not folded into it',
  );
  db.close();

  // A restore replaces the archive the log belonged to, so the side files beside
  // the target go with it. They are created here as files rather than by an open
  // handle so the assertion is about the removal and nothing else.
  const restoredDirectory = path.join(path.dirname(home), 'restored');
  mkdirSync(restoredDirectory, { mode: HOME_DIRECTORY_MODE });
  const restored = path.join(restoredDirectory, DATABASE_FILE_NAME);
  for (const suffix of SIDE_FILE_SUFFIXES) writeFileSync(`${restored}${suffix}`, 'stale side file');
  const counts = restoreArchive(copy, restored);
  assert.deepEqual(
    readdirSync(path.dirname(restored)),
    [DATABASE_FILE_NAME],
    'the restore left a write-ahead side file beside the archive it replaced',
  );
  assert.deepEqual(counts, openCounts, 'the restored archive does not report the counts of the archive it replaced');
});

// RS-C12: the per-table comparison a backup is validated by is the drill's known
// row counts, so every table the schema creates has to be named there. A table
// missing from that listing is a table the round trip cannot prove.
test('every table the schema creates is named in the backup drill\'s expected row counts', async (t) => {
  const { databasePath } = scratchHome(t);
  const db = openDatabase(databasePath);
  const applied = await migrate(db);
  const status = await migrationStatus(db);
  const tables = schemaTables(db);
  // The one count that belongs to code rather than to the seeded dataset: one row
  // per applied migration, which is what the archive really records.
  const recorded = Number(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n ?? 0);
  db.close();
  assert.ok(tables.length > 0, 'the migrated archive created no table, so the comparison would be vacuous');
  assert.deepEqual(applied, [1, 2], 'the migrations the code applies are not the ones this build recorded');
  assert.deepEqual(status.pendingVersions, [], 'a freshly migrated archive still has pending migrations');

  const known = drillKnownRowCounts();
  for (const table of tables) {
    assert.ok(
      known.has(table),
      `the schema creates ${table}, which scripts/backup-drill.mjs names no expected row count for; ` +
        `it names ${[...known.keys()].join(', ')}`,
    );
  }
  for (const table of known.keys()) {
    assert.ok(
      tables.includes(table),
      `scripts/backup-drill.mjs expects a row count for ${table}, which the schema no longer creates`,
    );
  }
  assert.equal(recorded, status.codeVersion, 'the archive recorded a different migration count from the code');
  assert.equal(known.get('schema_migrations'), recorded,
    `the drill expects ${String(known.get('schema_migrations'))} rows in schema_migrations, the archive records ${recorded}`);
});

test('the storage feature document\'s schema section names exactly the tables the schema creates', async (t) => {
  const { databasePath } = scratchHome(t);
  const db = openDatabase(databasePath);
  await migrate(db);
  const tables = schemaTables(db);
  db.close();
  const documented = documentedSchemaTables();
  assert.ok(documented.length > 0, 'the schema section of docs/features/archive-storage.md lists no table');
  assert.deepEqual(
    documented,
    [...tables].sort(),
    'docs/features/archive-storage.md section 4 and the schema disagree about which tables the archive has',
  );
});