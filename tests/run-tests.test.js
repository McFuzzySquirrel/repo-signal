import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRAPPER = path.join(REPO_ROOT, 'scripts', 'run-tests.mjs');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

/** @type {string[]} */
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {string} prefix
 * @returns {string}
 */
function makeTemporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), `repo-signal-${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Drive the wrapper as a process, the way `npm test` does, never by importing
 * it. Every run gets its own REPO_SIGNAL_HOME so a later task can never let a
 * test write into the real home directory.
 * @param {string[]} targets Arguments passed after the wrapper path.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runWrapper(targets) {
  const result = spawnSync(process.execPath, [WRAPPER, ...targets], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, REPO_SIGNAL_HOME: makeTemporaryDirectory('home') },
  });
  assert.equal(result.error, undefined, `spawning the wrapper failed: ${String(result.error)}`);
  assert.equal(result.signal, null, `the wrapper was killed by ${String(result.signal)}`);
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test('the wrapper fails a path that selects no test file', () => {
  const result = runWrapper(['scripts/fixtures/empty-suite']);
  assert.notEqual(result.status, 0, `expected a non-zero exit, got 0\n${result.stdout}`);
  assert.match(result.stderr, /no tests were selected/);
  assert.match(result.stderr, /scripts\/fixtures\/empty-suite/);
});

test('the wrapper passes a suite whose single test passes', () => {
  const result = runWrapper(['scripts/fixtures/passing-suite']);
  assert.equal(result.status, 0, `expected exit 0\n${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^# tests 1$/m);
  assert.match(result.stdout, /^# fail 0$/m);
});

test('the wrapper fails a suite whose test fails', () => {
  const directory = makeTemporaryDirectory('failing-suite');
  writeFileSync(
    path.join(directory, 'failing.test.js'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      '',
      "test('this fixture always fails', () => {",
      "  assert.equal(1, 2);",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  const result = runWrapper([directory]);
  assert.notEqual(result.status, 0, `expected a non-zero exit, got 0\n${result.stdout}`);
  assert.match(result.stdout, /^# tests 1$/m);
  assert.match(result.stdout, /^# fail 1$/m);
  assert.match(result.stderr, /1 of 1 selected tests failed/);
});

test('the wrapper fails a test file that declares no test', () => {
  const directory = makeTemporaryDirectory('silent-suite');
  writeFileSync(
    path.join(directory, 'silent.test.js'),
    "export const NOTHING_TO_RUN = 'this file matches a test name but declares no test';\n",
    'utf8',
  );
  const result = runWrapper([directory]);
  assert.notEqual(result.status, 0, `expected a non-zero exit, got 0\n${result.stdout}`);
  assert.match(result.stderr, /declares no test/);
  assert.match(result.stderr, /silent\.test\.js/);
});

test('the wrapper names a path that does not exist', () => {
  const result = runWrapper(['scripts/fixtures/no-such-directory']);
  assert.notEqual(result.status, 0, `expected a non-zero exit, got 0\n${result.stdout}`);
  assert.match(result.stderr, /cannot use scripts\/fixtures\/no-such-directory \(ENOENT\)/);
});

test('the package declares an ESM, dependency-free runtime contract', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  assert.equal(manifest.name, 'repo-signal');
  assert.equal(manifest.type, 'module');
  // Node 24.12.0 is the floor because src/db/connection.js requires
  // `node:sqlite`'s `enableDefensive`, which earlier lines do not expose. The
  // 22.13.0 release only marks where `node:sqlite` shed its --experimental-sqlite
  // flag, so naming it as the floor let a runtime the storage layer cannot use
  // satisfy the manifest.
  assert.equal(manifest.engines.node, '>=24.12.0');
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.bundledDependencies, undefined);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}).sort(), ['@types/node', 'typescript']);
  assert.equal(manifest.scripts.typecheck, 'tsc --noEmit');
  assert.equal(manifest.scripts.test, 'node scripts/run-tests.mjs');
});
