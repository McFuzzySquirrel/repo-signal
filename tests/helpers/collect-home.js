import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { redact } from '../../src/credentials/redact.js';
import { createStubGitHub } from './stub-github-server.mjs';

/**
 * A collection fixture: a temporary home holding a configuration and a 0600
 * credential file, a running local GitHub stub, and a `run` that spawns the real
 * entry point against them.
 *
 * The home is temporary, the credential is an obviously fake token-shaped string,
 * and `REPO_SIGNAL_GITHUB_BASE_URL` points at a loopback stub behind
 * `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT`, so no test built on this fixture can reach
 * api.github.com and an assertion about the absence of a token means something.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
export const FIXTURE_TOKEN = 'ghp_' + 'OBVIOUSLY_FAKE_LIFECYCLE_TOKEN';
export const TOKEN_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/;

/**
 * @typedef {object} SpawnResult
 * @property {number|null} status Exit code, or null when a signal ended the child.
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {object} CollectHome
 * @property {string} directory Working directory the command was spawned from.
 * @property {string} home
 * @property {string} databasePath
 * @property {import('./stub-github-server.mjs').StubGitHub} stub
 * @property {(args: string[]) => Promise<SpawnResult>} run
 * @property {<T>(body: (db: DatabaseSync) => T) => T} archive Read the archive a spawned command left behind.
 */

/**
 * @param {import('node:test').TestContext} t
 * @param {{ enrolled?: string[]|null }} [options] `null` writes no configuration file at all.
 * @returns {Promise<CollectHome>}
 */
export async function createCollectHome(t, options = {}) {
  const enrolled = options.enrolled === undefined ? ['owner/alpha', 'owner/beta'] : options.enrolled;
  const directory = mkdtempSync('/tmp/opencode/repo-signal-collect-home-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (enrolled !== null) {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enrolled }, null, 2), { mode: 0o600 });
  }
  writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ token: FIXTURE_TOKEN }), { mode: 0o600 });

  const stub = createStubGitHub({ token: FIXTURE_TOKEN });
  t.after(() => stub.stop());
  const baseUrl = await stub.start();

  /**
   * @param {string[]} args
   * @returns {Promise<SpawnResult>}
   */
  const run = async (args) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        REPO_SIGNAL_HOME: home,
        REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: '1',
        REPO_SIGNAL_GITHUB_BASE_URL: baseUrl,
        NODE_OPTIONS: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve) => child.on('close', resolve));
    return { status, stdout, stderr };
  };

  /**
   * Read the archive the spawned command left behind.
   * @template T
   * @param {(db: DatabaseSync) => T} body
   * @returns {T}
   */
  const archive = (body) => {
    const db = new DatabaseSync(path.join(home, 'archive.sqlite3'));
    try {
      return body(db);
    } finally {
      db.close();
    }
  };

  return { directory, home, databasePath: path.join(home, 'archive.sqlite3'), stub, run, archive };
}

/**
 * @param {string} output
 * @returns {string[]}
 */
export function outputLines(output) {
  return output.split('\n').filter((line) => line !== '');
}

/**
 * node:sqlite hands back null-prototype rows, so copy them into plain objects
 * before comparing them with `deepEqual`.
 * @param {object[]} list
 * @returns {Record<string, unknown>[]}
 */
export function plainRows(list) {
  return list.map((entry) => ({ ...entry }));
}

/**
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string} [where]
 * @returns {number}
 */
export function rowCount(db, table, where = '') {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get()?.n);
}

/**
 * Every printed line of a spawned command, from both streams, is free of any
 * token-shaped value and is exactly what the redaction helper would print.
 * @param {SpawnResult} result
 * @param {string} label
 */
export function assertNoCredentialMaterial(result, label) {
  for (const line of [...outputLines(result.stdout), ...outputLines(result.stderr)]) {
    assert.doesNotMatch(line, TOKEN_SHAPE, `${label}: no printed line carries a token-shaped value`);
    assert.equal(redact(line), line, `${label}: every printed line passes the redaction helper unchanged`);
  }
}