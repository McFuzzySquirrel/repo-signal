import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, truncateSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');

/** @param {import('node:test').TestContext} t @param {string} label */
function fixture(t, label) {
  const directory = mkdtempSync(`/tmp/opencode/repo-signal-db-command-${label}-`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  /** @param {string[]} args @param {string} [homeOverride] */
  const run = (args, homeOverride = home) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: directory,
    env: { ...process.env, REPO_SIGNAL_HOME: homeOverride, NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { directory, home, run };
}

/** @param {ReturnType<typeof spawnSync>} result @param {number} status */
function outcome(result, status) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, String(result.stderr));
}

/** @param {string} output @returns {Array<[string, number]>} */
function counts(output) {
  return String(output).split('\n')
    .filter((line) => /^[a-z_]+: \d+$/.test(line))
    .map((line) => {
      const blank = line.lastIndexOf(': ');
      return /** @type {[string, number]} */ ([line.slice(0, blank), Number(line.slice(blank + 2))]);
    });
}

/** @param {string} databasePath */
function seedKnownRows(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const repository = db.prepare(
      "INSERT INTO repositories (owner, name, lifecycle, enrolled, last_seen_at) VALUES ('seed-owner', ?, 'active', 1, '2026-09-29T01:00:00.000Z')",
    );
    repository.run('seed-one');
    repository.run('seed-two');
    db.prepare("INSERT INTO runs (id, started_at, status) VALUES ('seed-run', '2026-09-29T00:00:00.000Z', 'completed')").run();
    const fact = db.prepare(
      "INSERT INTO day_series (repository_id, metric, granularity, day, value, source, collected_at) VALUES (?, 'clones', 'day', ?, ?, 'collected', '2026-09-29T01:00:00.000Z')",
    );
    fact.run(1, '2026-09-27', 4);
    fact.run(1, '2026-09-28', 0);
    fact.run(2, '2026-09-28', 7);
  } finally {
    db.close();
  }
}

test('db migrate, status, verify, backup and restore each exit 0 on a temporary home', (t) => {
  const f = fixture(t, 'group');
  const migrate = f.run(['db', 'migrate']);
  outcome(migrate, 0);
  assert.match(migrate.stdout, /migrated: applied 1, 2/);
  const status = f.run(['db', 'status']);
  outcome(status, 0);
  assert.match(status.stdout, /database: .*archive\.sqlite3/);
  assert.match(status.stdout, /schema version \(code\): 2/);
  assert.match(status.stdout, /schema version \(on disk\): 2/);
  assert.match(status.stdout, /migration pending: no/);
  const verify = f.run(['db', 'verify']);
  outcome(verify, 0);
  assert.match(verify.stdout, /integrity check: ok/);
  const backupPath = path.join(f.directory, 'copy.sqlite3');
  const backup = f.run(['db', 'backup', backupPath]);
  outcome(backup, 0);
  assert.match(backup.stdout, /backup written: /);
  assert.equal(existsSync(backupPath), true);
  const restore = f.run(['db', 'restore', backupPath]);
  outcome(restore, 0);
  assert.match(restore.stdout, /restored: /);
  assert.match(restore.stdout, /integrity check: ok/);
});

test('db status reports a pending migration when the on-disk version is behind the code version', (t) => {
  const f = fixture(t, 'pending');
  const before = f.run(['db', 'status']);
  outcome(before, 0);
  assert.match(before.stdout, /schema version \(code\): 2/);
  assert.match(before.stdout, /schema version \(on disk\): 0/);
  assert.match(before.stdout, /migration pending: yes \(1, 2\)/);
  outcome(f.run(['db', 'migrate']), 0);
  const after = f.run(['db', 'status']);
  outcome(after, 0);
  assert.match(after.stdout, /schema version \(on disk\): 2/);
  assert.match(after.stdout, /migration pending: no/);
});

test('a backup taken after inserting known rows restores into a fresh home with matching counts', (t) => {
  const f = fixture(t, 'roundtrip');
  outcome(f.run(['db', 'migrate']), 0);
  const databasePath = path.join(f.home, 'archive.sqlite3');
  seedKnownRows(databasePath);
  const backupPath = path.join(f.directory, 'known.sqlite3');
  const backup = f.run(['db', 'backup', backupPath]);
  outcome(backup, 0);
  const original = counts(backup.stdout);
  assert.ok(original.length > 0);
  const repositories = original.find(([table]) => table === 'repositories');
  assert.deepEqual(repositories, ['repositories', 2]);
  assert.deepEqual(original.find(([table]) => table === 'day_series'), ['day_series', 3]);
  const freshHome = path.join(f.directory, 'fresh-home');
  const restore = f.run(['db', 'restore', backupPath], freshHome);
  outcome(restore, 0);
  assert.match(restore.stdout, /integrity check: ok/);
  assert.deepEqual(counts(restore.stdout), original);
  const verify = f.run(['db', 'verify'], freshHome);
  outcome(verify, 0);
  assert.match(verify.stdout, /integrity check: ok/);
});

test('restoring a truncated backup is detected and exits non-zero with the integrity-check message', (t) => {
  const f = fixture(t, 'truncated');
  outcome(f.run(['db', 'migrate']), 0);
  const good = path.join(f.directory, 'good.sqlite3');
  outcome(f.run(['db', 'backup', good]), 0);
  const broken = path.join(f.directory, 'broken.sqlite3');
  copyFileSync(good, broken);
  truncateSync(broken, 4096);
  const freshHome = path.join(f.directory, 'fresh-home');
  const restore = f.run(['db', 'restore', broken], freshHome);
  outcome(restore, 1);
  assert.match(restore.stderr, /db restore failed: integrity check failed: /);
  assert.match(restore.stderr, /malformed|not a database|corrupt/i);
  assert.equal(existsSync(path.join(freshHome, 'archive.sqlite3')), false);
});

test('backup and restore never print repository names or observation values', (t) => {
  const f = fixture(t, 'redaction');
  outcome(f.run(['db', 'migrate']), 0);
  seedKnownRows(path.join(f.home, 'archive.sqlite3'));
  const backupPath = path.join(f.directory, 'known.sqlite3');
  const backup = f.run(['db', 'backup', backupPath]);
  outcome(backup, 0);
  assert.equal(backup.stdout.includes('seed-owner'), false);
  assert.equal(backup.stdout.includes('seed-one'), false);
  const freshHome = path.join(f.directory, 'fresh-home');
  const restore = f.run(['db', 'restore', backupPath], freshHome);
  outcome(restore, 0);
  assert.equal(restore.stdout.includes('seed-owner'), false);
  assert.equal(restore.stdout.includes('seed-run'), false);
});
