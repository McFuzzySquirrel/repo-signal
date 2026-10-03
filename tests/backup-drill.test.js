import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRILL = path.join(ROOT, 'scripts', 'backup-drill.mjs');
const CLI = path.join(ROOT, 'src', 'cli.js');
const RUNBOOK = path.join(ROOT, 'docs', 'operations', 'backup-and-migrate.md');

/** The per-table row counts the drill's known dataset must produce. */
const KNOWN_ROW_COUNTS = new Map([
  ['backfill_records', 1],
  ['day_series', 3],
  ['heartbeats', 1],
  ['repositories', 1],
  ['repository_aliases', 1],
  ['repository_errors', 1],
  ['runs', 1],
  ['schema_migrations', 2],
  ['snapshots', 2],
]);

/**
 * Values the drill stores but must never print: repository names, an alias, a run
 * identifier, an error message and every stored observation value.
 */
const STORED_BUT_NEVER_PRINTED = [
  'drill-owner',
  'drill-repo',
  'drill-archive-name',
  'drill-run-0001',
  'drill synthetic failure',
  '4101',
  '4102',
  '4103',
  '5101',
  '5102',
  '5103',
  '5104',
];

/** @type {string[]} */
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

/**
 * @param {string} prefix
 * @returns {string}
 */
function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), `repo-signal-${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Drive a process the way an operator does: spawn it, never import it.
 * @param {string[]} command Executable and its arguments.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(command, env = {}) {
  const result = spawnSync(command[0] ?? '', command.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: '', ...env },
  });
  assert.equal(result.error, undefined, `spawning failed: ${String(result.error)}`);
  assert.equal(result.signal, null, `the process was killed by ${String(result.signal)}`);
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * @param {{status: number, stdout: string, stderr: string}} result
 * @param {number} status
 * @returns {void}
 */
function expectStatus(result, status) {
  assert.equal(result.status, status, `stdout:\n${result.stdout}stderr:\n${result.stderr}`);
}

/**
 * Read one listing of `table: count` lines, such as `original repositories: 1`.
 * @param {string} output
 * @param {string} label The prefix that names which home the listing belongs to.
 * @returns {Map<string, number>}
 */
function parseListing(output, label) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of output.split('\n')) {
    const match = new RegExp(`^${label} ([a-z_]+): (\\d+)$`).exec(line.trim());
    if (match !== null) counts.set(match[1] ?? '', Number(match[2]));
  }
  return counts;
}

/**
 * @param {string} output
 * @param {string} prefix `key: value` line whose value is a path.
 * @returns {string}
 */
function parsePathLine(output, prefix) {
  const line = output.split('\n').find((candidate) => candidate.startsWith(prefix));
  assert.ok(line !== undefined, `no ${prefix} line in:\n${output}`);
  return line.slice(prefix.length).trim();
}

/**
 * A scratch root the drill was asked to keep, registered for removal so a test run
 * leaves the temporary directory as it found it.
 * @param {string} output
 * @returns {string}
 */
function keptScratchRoot(output) {
  const root = parsePathLine(output, 'drill: scratch root kept at ');
  temporaryDirectories.push(root);
  return root;
}

test('the drill exits zero and reports identical per-table row counts for the original and the restored home', () => {
  const callerHome = temporaryDirectory('caller-home');
  const result = run([process.execPath, DRILL], { REPO_SIGNAL_HOME: callerHome });
  expectStatus(result, 0);
  assert.equal(result.stderr, '', `a passing drill writes nothing to stderr:\n${result.stderr}`);

  const original = parseListing(result.stdout, 'original');
  const restored = parseListing(result.stdout, 'restored');
  assert.ok(original.size > 0, `the drill reported no original listing:\n${result.stdout}`);
  assert.deepEqual([...restored.entries()], [...original.entries()]);
  assert.deepEqual([...original.entries()], [...KNOWN_ROW_COUNTS.entries()]);
  assert.match(result.stdout, /^row counts: identical across \d+ tables$/m);
  assert.match(result.stdout, /^drill: passed$/m);
  assert.match(result.stdout, /^known dataset: \d+ tables hold the rows the drill wrote$/m);
  assert.match(result.stdout, /^restored home: integrity check ok$/m);

  // The drill keeps its own state in scratch homes, so the caller's home is untouched.
  assert.deepEqual(readdirSync(callerHome), [], 'the drill wrote into the home it was given');
});

test('the drill prints no observation value, repository name or token', () => {
  const result = run([process.execPath, DRILL]);
  expectStatus(result, 0);
  const printed = `${result.stdout}${result.stderr}`;
  for (const value of STORED_BUT_NEVER_PRINTED) {
    assert.equal(printed.includes(value), false, `the drill printed the stored value ${value}`);
  }
  assert.doesNotMatch(printed, /(github_pat_|gh[pousr]_)[A-Za-z0-9_]+/);
});

test('the drill detects a deliberately truncated backup and exits non-zero', () => {
  const kept = run([process.execPath, DRILL, '--keep']);
  expectStatus(kept, 0);
  const scratch = keptScratchRoot(kept.stdout);
  const copy = parsePathLine(kept.stdout, 'drill: backup copy ');
  assert.equal(existsSync(copy), true);

  // The intact copy rehearses successfully, so a non-zero exit below is caused by the
  // truncation and not by the extra argument.
  const intact = run([process.execPath, DRILL, copy]);
  expectStatus(intact, 0);
  assert.match(intact.stdout, /^drill: passed$/m);

  const truncated = path.join(temporaryDirectory('truncated'), 'archive-truncated.sqlite3');
  copyFileSync(copy, truncated);
  assert.ok(statSync(truncated).size > 4096, 'the drill produced a copy too small to truncate meaningfully');
  truncateSync(truncated, 4096);

  const damaged = run([process.execPath, DRILL, '--keep', truncated]);
  assert.notEqual(damaged.status, 0, `a truncated copy was accepted:\n${damaged.stdout}${damaged.stderr}`);
  assert.match(damaged.stderr, /refused the copy/);
  assert.match(damaged.stderr, /integrity check failed/);
  assert.match(damaged.stderr, /malformed|not a database|corrupt/i);
  assert.doesNotMatch(damaged.stdout, /^drill: passed$/m);

  // The refused copy wrote no archive into the rehearsal home it was offered to.
  const rehearsalScratch = keptScratchRoot(damaged.stdout);
  assert.deepEqual(
    readdirSync(path.join(rehearsalScratch, 'home-restored')).filter((entry) => entry.startsWith('archive.sqlite3')),
    [],
    'a refused copy still wrote an archive into the rehearsal home',
  );

  // A path the drill cannot read is refused too, so a mistyped path cannot pass.
  const missing = run([process.execPath, DRILL, path.join(scratch, 'no-such-copy.sqlite3')]);
  assert.notEqual(missing.status, 0, `a missing copy was accepted:\n${missing.stdout}${missing.stderr}`);
  assert.match(missing.stderr, /could not be read/);
});

test('the drill refuses a copy that restores to an archive holding no table', () => {
  // `db restore` on a path that does not exist creates an empty archive and reports a
  // successful restore, so the drill must not treat agreement between two empty
  // listings as a passing drill.
  const empty = path.join(temporaryDirectory('empty'), 'archive-empty.sqlite3');
  writeFileSync(empty, '');
  const result = run([process.execPath, DRILL, empty]);
  assert.notEqual(result.status, 0, `an empty copy passed the rehearsal:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /no table was counted/);
  assert.doesNotMatch(result.stdout, /^drill: passed$/m);
});

test('the drill refuses a copy that is not a database at all', () => {
  const text = path.join(temporaryDirectory('text'), 'archive-text.sqlite3');
  writeFileSync(text, 'this file is text, not a database, and padding padding padding\n');
  const result = run([process.execPath, DRILL, text]);
  assert.notEqual(result.status, 0, `a text file passed the rehearsal:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /refused the copy/);
  assert.match(result.stderr, /not a database/);
});

test('the drill refuses an argument it does not understand with a usage error', () => {
  const result = run([process.execPath, DRILL, '--drill-harder']);
  expectStatus(result, 2);
  assert.match(result.stderr, /is not a flag of this drill/);
});

/**
 * Every command name this build registers, read from the usage listing the real
 * entry point generates from the registry. A runbook naming a command that is not
 * in this set names something the repository does not provide.
 * @returns {Set<string>}
 */
function registeredCommands() {
  const usage = run([process.execPath, CLI, '--help']);
  expectStatus(usage, 0);
  const lines = usage.stdout.split('\n');
  const start = lines.indexOf('Commands:');
  assert.notEqual(start, -1, `no Commands section in:\n${usage.stdout}`);
  /** @type {Set<string>} */
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const match = /^ {2}([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)/.exec(line);
    if (match !== null) names.add(match[1] ?? '');
  }
  assert.ok(names.size > 0, 'the usage listing named no command');
  return names;
}

test('the runbook names the backup, restore, verify and schema-version commands this repository provides', () => {
  const registered = registeredCommands();
  const runbook = readFileSync(RUNBOOK, 'utf8');
  for (const command of ['db backup', 'db restore', 'db verify', 'db status']) {
    assert.equal(registered.has(command), true, `${command} is not a registered command`);
    assert.ok(
      runbook.includes(`node src/cli.js ${command}`),
      `the runbook does not name the ${command} command`,
    );
  }
  assert.ok(
    registered.has('db migrate') && runbook.includes('node src/cli.js db migrate'),
    'the runbook must also name db migrate, the forward-only command',
  );
});

test('every command the runbook names is a command this repository registers', () => {
  const registered = registeredCommands();
  const runbook = readFileSync(RUNBOOK, 'utf8');
  /** @type {string[][]} */
  const invocations = [];
  for (const match of runbook.matchAll(/src\/cli\.js((?:\s+[a-z][a-z0-9-]*)+)/g)) {
    invocations.push((match[1] ?? '').trim().split(/\s+/));
  }
  assert.ok(invocations.length >= 4, `the runbook names only ${invocations.length} command invocations`);
  for (const words of invocations) {
    const resolved = words
      .slice(0, Math.max(...words.map((_, index) => index + 1)))
      .map((_, index) => words.slice(0, words.length - index).join(' '))
      .find((candidate) => registered.has(candidate));
    assert.ok(
      resolved !== undefined,
      `the runbook names "${words.join(' ')}", which resolves to no registered command; ` +
        `this build registers ${[...registered].sort().join(', ')}`,
    );
  }
});

test('every script the runbook names exists in this repository', () => {
  const runbook = readFileSync(RUNBOOK, 'utf8');
  /** @type {Set<string>} */
  const scripts = new Set();
  for (const match of runbook.matchAll(/scripts\/[A-Za-z0-9._-]+\.mjs/g)) scripts.add(match[0]);
  assert.ok(scripts.size > 0, 'the runbook names no script');
  for (const script of scripts) {
    assert.equal(existsSync(path.join(ROOT, script)), true, `the runbook names ${script}, which is not in this repository`);
  }
});

/**
 * The runbook with its line wrapping flattened, so an assertion about a sentence
 * does not depend on where the prose happens to wrap. Blockquote markers go too:
 * the warning box is prose like any other.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text
    .replace(/^\s*>\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One `##` section of the runbook, flattened. A heading that is not there fails
 * the test rather than silently matching the whole page.
 * @param {string} heading The heading text, without its `## `.
 * @returns {string}
 */
function section(heading) {
  const runbook = readFileSync(RUNBOOK, 'utf8');
  assert.ok(runbook.includes(`## ${heading}\n`), `the runbook has no "## ${heading}" section`);
  const body = runbook.slice(runbook.indexOf(`## ${heading}\n`) + heading.length + 4);
  const next = body.search(/^## /m);
  return flatten(next === -1 ? body : body.slice(0, next));
}

test('the runbook states that a restore replaces the current archive', () => {
  assert.match(readFileSync(RUNBOOK, 'utf8'), /^## A restore replaces the current archive$/m);
  const warning = section('A restore replaces the current archive');
  assert.match(warning, /overwrites `<home>\/archive\.sqlite3`/);
  assert.match(warning, /deletes the sibling `archive\.sqlite3-wal` and `archive\.sqlite3-shm` files/);
  assert.match(warning, /There is no undo, no timestamped previous version kept for you and no confirmation prompt/);
  assert.match(warning, /gone from that home/);
  assert.match(warning, /Take a `db backup` first/);
});

test('the runbook states where copies should be kept', () => {
  const copies = section('Where copies should live');
  assert.match(copies, /Outside the home directory/);
  assert.match(copies, /Outside every git work tree/);
  assert.match(copies, /On a different medium from the machine/);
  assert.match(copies, /At least one copy you control/);
  assert.match(copies, /Named for when it was taken/);
  assert.match(copies, /never contains `config\.json` or `credentials\.json`/);
  assert.match(copies, /`db backup` writes the file path you name and does not create directories/);
});

test('the runbook states how to restore into a fresh home', () => {
  const restored = section('Restore into a fresh home');
  assert.match(restored, /node src\/cli\.js db restore/);
  assert.match(restored, /node src\/cli\.js db verify/);
  assert.match(restored, /node src\/cli\.js db status/);
  assert.match(restored, /node src\/cli\.js db migrate/);
  assert.match(restored, /node src\/cli\.js config init/);
  assert.match(restored, /node src\/cli\.js config check/);
  assert.match(restored, /mode `0700`/);
  assert.match(restored, /mode is `0600` exactly/);
  assert.match(restored, /outside every work tree/i);
  assert.match(restored, /A backup copy carries the archive only/);
});

test("the runbook states what to do when the code's schema version is ahead of the archive", () => {
  const ahead = section("When the code's schema version is ahead of the archive");
  assert.match(ahead, /migration pending: yes/);
  assert.match(ahead, /Migrations in this repository are forward-only/);
  assert.match(ahead, /node src\/cli\.js db backup/);
  assert.match(ahead, /node src\/cli\.js db migrate/);
  assert.match(ahead, /node src\/cli\.js db verify/);
  assert.match(ahead, /day-series, snapshot, error and heartbeat counts must not change/);
  assert.match(ahead, /The other direction\./);
  assert.match(ahead, /Applied migration \d+ is missing from code/);
  assert.match(ahead, /never the answer/);
});

test('the runbook states how to move an archive to another machine', () => {
  const moved = section('Move an archive to another machine');
  assert.match(moved, /node src\/cli\.js db backup/);
  assert.match(moved, /node scripts\/backup-drill\.mjs/);
  assert.match(moved, /node src\/cli\.js db restore/);
  assert.match(moved, /node src\/cli\.js db verify/);
  assert.match(moved, /node src\/cli\.js config check/);
  assert.match(moved, /The archive is self-contained, so nothing else in the home has to travel with it/);
  assert.match(moved, /Do not transfer\s+`credentials\.json`/);
  assert.match(moved, /last-write-wins/);
});

test('the runbook claims no test result, no approval and no compliance claim', () => {
  const runbook = readFileSync(RUNBOOK, 'utf8');
  for (const claim of [
    /\ball tests pass/i,
    /\bthe (?:ci|pipeline|build) (?:passed|is green|succeeded)/i,
    /\bapproved by\b/i,
    /\bsigned off\b/i,
    /\bwe (?:ran|verified|confirmed)\b/i,
    /\bthis (?:complies|is compliant|is certified)/i,
  ]) {
    assert.doesNotMatch(runbook, claim);
  }
});

test('the drill cannot make an outbound request and reads no credential file', () => {
  const source = readFileSync(DRILL, 'utf8');
  for (const forbidden of [
    /from ['"]node:(?:http|https|net|tls|dgram)['"]/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /credentials\/store\.js/,
    /\bprocess\.env\.[A-Z_]*TOKEN\b/,
  ]) {
    assert.doesNotMatch(source, forbidden, `the drill must not contain ${String(forbidden)}`);
  }
  /** @type {string[]} */
  const specifiers = [];
  for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) specifiers.push(match[1] ?? '');
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1] ?? '');
  assert.ok(specifiers.length > 0, 'the drill imports nothing');
  for (const specifier of specifiers) {
    const allowed = specifier.startsWith('node:') || specifier.startsWith('../');
    assert.equal(allowed, true, `the drill imports ${specifier}, which is not a node: builtin or a relative path`);
  }
});