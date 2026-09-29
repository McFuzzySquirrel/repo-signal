import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FILE_NAME,
  CREDENTIALS_FILE_NAME,
  DATABASE_FILE_NAME,
  HOME_DIRECTORY_MODE,
  HomeDirectoryError,
  ensureHomeDirectory,
  resolveHomeDirectory,
  resolveHomePaths,
} from '../src/paths.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE_SOURCE = fileURLToPath(new URL('../src/paths.js', import.meta.url));
const OTHER_VARIABLES = { XDG_DATA_HOME: undefined, REPO_SIGNAL_HOME: undefined, HOME: undefined };

/** @type {string[]} */
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {string} prefix
 * @returns {string} A temporary directory that is removed after the suite.
 */
function makeTemporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), `repo-signal-${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * @param {string} target
 * @returns {number} The permission bits of an existing entry.
 */
function modeOf(target) {
  return statSync(target).mode & 0o777;
}

/**
 * @param {unknown} error
 * @returns {HomeDirectoryError} The error narrowed to the class paths.js throws.
 */
function asHomeDirectoryError(error) {
  assert.ok(error instanceof HomeDirectoryError, `expected a HomeDirectoryError, got ${String(error)}`);
  return error;
}

/**
 * `assert.throws` reports but does not return, so the refusal is captured here
 * and its message inspected.
 * @param {() => unknown} call
 * @returns {HomeDirectoryError} The refusal the call produced.
 */
function captureRefusal(call) {
  try {
    call();
  } catch (error) {
    return asHomeDirectoryError(error);
  }
  assert.fail('the call was expected to be refused, but it returned');
}

test('REPO_SIGNAL_HOME wins over XDG_DATA_HOME', () => {
  const root = makeTemporaryDirectory('precedence');
  const explicit = path.join(root, 'explicit-home');
  const xdg = path.join(root, 'xdg-home');
  const paths = resolveHomePaths({
    env: { ...OTHER_VARIABLES, HOME: path.join(root, 'user-home'), XDG_DATA_HOME: xdg, REPO_SIGNAL_HOME: explicit },
    cwd: root,
  });

  assert.equal(paths.home, explicit);
  assert.notEqual(paths.home, path.join(xdg, 'repo-signal'));
  assert.equal(existsSync(explicit), true, 'the explicit home directory was not created');
  assert.equal(existsSync(xdg), false, 'the XDG path was used even though REPO_SIGNAL_HOME was set');
});

test('XDG_DATA_HOME/repo-signal is used when REPO_SIGNAL_HOME is unset', () => {
  const root = makeTemporaryDirectory('xdg');
  const xdg = path.join(root, 'xdg-data');
  const paths = resolveHomePaths({
    env: { ...OTHER_VARIABLES, HOME: path.join(root, 'user-home'), XDG_DATA_HOME: xdg },
    cwd: root,
  });

  assert.equal(paths.home, path.join(xdg, 'repo-signal'));
  assert.equal(existsSync(paths.home), true, 'the XDG home directory was not created');
  assert.equal(existsSync(path.join(root, 'user-home')), false, 'HOME was used even though XDG_DATA_HOME was set');
});

test('~/.local/share/repo-signal is used when neither variable is set', () => {
  const root = makeTemporaryDirectory('fallback');
  const userHome = path.join(root, 'user-home');
  const paths = resolveHomePaths({ env: { ...OTHER_VARIABLES, HOME: userHome }, cwd: root });

  assert.equal(paths.home, path.join(userHome, '.local', 'share', 'repo-signal'));
  assert.equal(existsSync(paths.home), true, 'the default home directory was not created');
});

test('resolution falls back to the operating-system home when HOME is also unset', () => {
  const resolved = resolveHomeDirectory({ env: { ...OTHER_VARIABLES }, cwd: makeTemporaryDirectory('no-home') });

  assert.equal(resolved, path.join(homedir(), '.local', 'share', 'repo-signal'));
  assert.equal(path.isAbsolute(resolved), true);
});

test('a blank REPO_SIGNAL_HOME is treated as unset rather than as the current directory', () => {
  const root = makeTemporaryDirectory('blank');
  const xdg = path.join(root, 'xdg-data');
  const resolved = resolveHomeDirectory({
    env: { ...OTHER_VARIABLES, HOME: path.join(root, 'user-home'), XDG_DATA_HOME: xdg, REPO_SIGNAL_HOME: '   ' },
    cwd: root,
  });

  assert.equal(resolved, path.join(xdg, 'repo-signal'));
});

test('a created home directory is mode 0700', () => {
  const root = makeTemporaryDirectory('mode');
  const home = path.join(root, 'home');
  const paths = resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: home }, cwd: root });

  assert.equal(paths.home, home);
  assert.equal(existsSync(home), true, 'the home directory was not created');
  assert.equal(modeOf(home), HOME_DIRECTORY_MODE);
  assert.equal(modeOf(home), 0o700);
  assert.equal(HOME_DIRECTORY_MODE, 0o700);
});

test('a home directory containing a .git entry is refused with the resolved path named', () => {
  const root = makeTemporaryDirectory('git-root');
  const home = path.join(root, 'worktree');
  mkdirSync(path.join(home, '.git'), { recursive: true, mode: 0o700 });

  const error = captureRefusal(() =>
    resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: home }, cwd: root }),
  );

  assert.equal(error.code, 'ERR_REPO_SIGNAL_HOME_IN_GIT');
  assert.ok(error.message.includes(home), `the message did not name ${home}: ${error.message}`);
  assert.match(error.message, /\.git/);
  assert.match(error.message, /REPO_SIGNAL_HOME/);
  assert.deepEqual(readdirSync(home), ['.git'], 'a refused home directory was written to');
});

test('a .git file is refused as well as a .git directory', () => {
  const root = makeTemporaryDirectory('git-file');
  const home = path.join(root, 'worktree');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const gitFile = path.join(home, '.git');
  writeFileSync(gitFile, 'gitdir: ../.git/worktrees/linked\n', { encoding: 'utf8', mode: 0o600 });

  const error = captureRefusal(() =>
    resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: home }, cwd: root }),
  );

  assert.equal(error.code, 'ERR_REPO_SIGNAL_HOME_IN_GIT');
  assert.ok(error.message.includes(home));
});

test('paths are absolute and normalized when the environment supplies a relative value', () => {
  const root = makeTemporaryDirectory('relative');
  const relative = path.join('nested', '..', 'state', '.');
  const fromExplicitVariable = resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: relative }, cwd: root });

  assert.equal(fromExplicitVariable.home, path.join(root, 'state'));
  assert.equal(path.isAbsolute(fromExplicitVariable.home), true);
  assert.equal(existsSync(path.join(root, 'state')), true, 'the relative home was not created under the cwd');

  const relativeXdg = resolveHomePaths({
    env: { ...OTHER_VARIABLES, XDG_DATA_HOME: path.join('..', 'xdg', 'data') },
    cwd: path.join(root, 'cwd'),
  });

  assert.equal(relativeXdg.home, path.resolve(root, 'xdg', 'data', 'repo-signal'));
  assert.equal(path.isAbsolute(relativeXdg.home), true);
  assert.ok(!relativeXdg.home.includes('..'), `the resolved path was not normalized: ${relativeXdg.home}`);
});

test('every derived path is an absolute file inside the home directory', () => {
  const root = makeTemporaryDirectory('derived');
  const home = path.join(root, 'home');
  const paths = resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: home }, cwd: root });

  assert.equal(paths.configPath, path.join(home, CONFIG_FILE_NAME));
  assert.equal(paths.credentialsPath, path.join(home, CREDENTIALS_FILE_NAME));
  assert.equal(paths.databasePath, path.join(home, DATABASE_FILE_NAME));
  assert.equal(path.dirname(paths.configPath), home);
  assert.equal(path.dirname(paths.credentialsPath), home);
  assert.equal(path.dirname(paths.databasePath), home);
  for (const derived of [paths.configPath, paths.credentialsPath, paths.databasePath]) {
    assert.equal(path.isAbsolute(derived), true, `${derived} is not absolute`);
  }
  assert.equal(path.extname(paths.databasePath), '.sqlite3');
  assert.equal(new Set(Object.values(paths)).size, 4, 'the four paths are not distinct');
  assert.deepEqual(readdirSync(home), [], 'resolving the paths wrote a file into the home directory');
});

test('resolving twice is idempotent and leaves a 0700 home in place', () => {
  const root = makeTemporaryDirectory('idempotent');
  const home = path.join(root, 'home');
  const first = resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: home }, cwd: root });
  const second = resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: home }, cwd: root });

  assert.deepEqual(second, first);
  assert.equal(modeOf(home), 0o700);
  assert.deepEqual(readdirSync(home), []);
});

test('a pre-existing home with group or other access is tightened to 0700', () => {
  const root = makeTemporaryDirectory('tighten');
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true, mode: 0o755 });
  chmodSync(home, 0o755);

  resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: home }, cwd: root });

  assert.equal(modeOf(home), 0o700);
});

test('a pre-existing home that is stricter than 0700 keeps its owner permissions', () => {
  const root = makeTemporaryDirectory('strict');
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true, mode: 0o500 });
  chmodSync(home, 0o500);

  ensureHomeDirectory(home);

  assert.equal(modeOf(home), 0o500);
});

test('a home path that already exists as a file is refused with the path named', () => {
  const root = makeTemporaryDirectory('not-a-directory');
  const home = path.join(root, 'home');
  writeFileSync(home, 'this path is a file, not a directory\n', { encoding: 'utf8', mode: 0o600 });

  const error = captureRefusal(() =>
    resolveHomePaths({ env: { ...OTHER_VARIABLES, REPO_SIGNAL_HOME: home }, cwd: root }),
  );

  assert.equal(error.code, 'ERR_REPO_SIGNAL_HOME_NOT_A_DIRECTORY');
  assert.ok(error.message.includes(home), `the message did not name ${home}: ${error.message}`);
  assert.equal(existsSync(path.join(home, CONFIG_FILE_NAME)), false);
});

test('the refusal suggests a concrete home outside the work tree', () => {
  const root = makeTemporaryDirectory('suggestion');
  const home = path.join(root, 'worktree');
  const suggested = path.join(root, 'elsewhere');
  mkdirSync(path.join(home, '.git'), { recursive: true, mode: 0o700 });

  const error = captureRefusal(() =>
    resolveHomePaths({
      env: { ...OTHER_VARIABLES, HOME: path.join(root, 'user-home'), REPO_SIGNAL_HOME: home, XDG_DATA_HOME: suggested },
      cwd: root,
    }),
  );

  assert.ok(error.message.includes(suggested), `the message did not suggest ${suggested}: ${error.message}`);
});

test('src/paths.js imports only node: builtins and relative paths', () => {
  const source = readFileSync(MODULE_SOURCE, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? '');

  assert.ok(specifiers.length >= 4, `expected several imports, found ${specifiers.length}`);
  for (const specifier of specifiers) {
    const allowed = specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../');
    assert.ok(allowed, `${specifier} is not a node: builtin or a relative path`);
  }
});
