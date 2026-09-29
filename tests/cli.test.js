import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.js');
const REGISTRY_ENTRY = path.join(REPO_ROOT, 'src', 'commands', 'index.js');

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
 * @param {string} home Absolute path of the home directory the run is given.
 * @returns {string} A home path that does not exist yet, so a run that creates it is caught.
 */
function makeUnusedHome(home) {
  return path.join(makeTemporaryDirectory('home'), home);
}

/**
 * @param {string} value
 * @returns {string} The value with every regular-expression metacharacter escaped.
 */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Write the stub commands as an ESM module that registers them in the real
 * registry, then preload it into the spawned process. A stub committed to
 * `src/commands/` would be one more file to delete once a real subcommand
 * arrives, and this task adds no real subcommand.
 * @returns {string} Absolute path of the module to preload.
 */
function writeStubModule() {
  const file = path.join(makeTemporaryDirectory('stubs'), 'register-stubs.mjs');
  const registryUrl = JSON.stringify(pathToFileURL(REGISTRY_ENTRY).href);
  writeFileSync(
    file,
    [
      'import process from \'node:process\';',
      `import { UsageError, registerCommand } from ${registryUrl};`,
      '',
      'registerCommand(\'stub ok\', {',
      '  summary: \'Stub that succeeds and reports the command line it received.\',',
      '  usage: \'[value ...]\',',
      '  run(context) {',
      '    context.print(\'entry \' + process.argv[1]);',
      '    context.print(\'args \' + JSON.stringify(context.args));',
      '    context.print(\'home \' + (context.env.REPO_SIGNAL_HOME ?? \'\'));',
      '    context.print(\'cwd \' + context.cwd);',
      '    return 0;',
      '  },',
      '});',
      '',
      'registerCommand(\'stub silent\', {',
      '  summary: \'Stub that returns nothing at all.\',',
      '  run() {},',
      '});',
      '',
      'registerCommand(\'stub group\', {',
      '  summary: \'Stub subcommand of the stub group.\',',
      '  run(context) {',
      '    context.print(\'stub group ran\');',
      '    return 0;',
      '  },',
      '});',
      '',
      'registerCommand(\'stub group deep\', {',
      '  summary: \'Deepest stub subcommand, so the longest registered name can win.\',',
      '  run(context) {',
      '    context.print(\'stub group deep ran\');',
      '    context.print(\'leftover \' + JSON.stringify(context.args));',
      '    return 0;',
      '  },',
      '});',
      '',
      'registerCommand(\'stub fail\', {',
      '  summary: \'Stub that reports an operational failure.\',',
      '  run(context) {',
      '    context.print(\'stub fail ran\');',
      '    context.printError(\'stub fail could not reach the archive\');',
      '    return 1;',
      '  },',
      '});',
      '',
      'registerCommand(\'stub crash\', {',
      '  summary: \'Stub that throws an unexpected error.\',',
      '  run() {',
      '    throw new Error(\'the archive database is locked by another process\');',
      '  },',
      '});',
      '',
      'registerCommand(\'stub refuse\', {',
      '  summary: \'Stub that refuses its own command line.\',',
      '  run() {',
      '    throw new UsageError(\'stub refuse needs a value for --repo\');',
      '  },',
      '});',
      '',
      'registerCommand(\'stub odd\', {',
      '  summary: \'Stub that returns something that is not an exit code.\',',
      '  run() {',
      '    return \'collected\';',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return file;
}

const STUB_MODULE = writeStubModule();

/**
 * Drive the composition root the way an operator does, by spawning the process
 * entry point. An import would prove the function but not the wiring, so every
 * assertion here goes through `node src/cli.js`.
 * @param {string[]} args Command-line arguments after the entry-point path.
 * @param {{ preload?: string, home?: string }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(args, options = {}) {
  const preload = options.preload === undefined ? [] : ['--import', options.preload];
  const result = spawnSync(process.execPath, [...preload, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, REPO_SIGNAL_HOME: options.home ?? makeUnusedHome('state') },
  });
  assert.equal(result.error, undefined, `spawning the composition root failed: ${String(result.error)}`);
  assert.equal(result.signal, null, `the composition root was killed by ${String(result.signal)}`);
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test('an unknown command exits 2 and prints the usage', () => {
  const result = runCli(['collectt']);

  assert.equal(result.status, 2, `expected exit 2\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /unknown command "collectt"/);
  assert.match(result.stderr, /^Usage:$/m);
  assert.match(result.stderr, /^ {2}0 {2}the command succeeded$/m);
  assert.match(result.stderr, /^ {2}1 {2}the command failed operationally$/m);
  assert.match(result.stderr, /^ {2}2 {2}the command line was a usage error$/m);
});

test('no subcommand at all exits 2 and prints the usage', () => {
  const result = runCli([]);

  assert.equal(result.status, 2, `expected exit 2\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /no subcommand was named/);
  assert.match(result.stderr, /^Usage:$/m);
});

test('an unknown global flag exits 2 and prints the usage', () => {
  const result = runCli(['--json', 'stub', 'ok']);

  assert.equal(result.status, 2, `expected exit 2\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /--json is not a global flag/);
  assert.match(result.stderr, /^Usage:$/m);
});

test('--help and -h exit 0 and print the usage on standard output', () => {
  for (const flag of ['--help', '-h']) {
    const result = runCli([flag]);

    assert.equal(result.status, 0, `expected exit 0 for ${flag}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^Usage:$/m);
    assert.match(result.stdout, /^Commands:$/m);
    assert.match(result.stdout, /^ {2}none is registered in this build$/m);
    assert.equal(result.stderr, '', `${flag} wrote to standard error`);
  }
});

test('a registered stub subcommand is reachable through node src/cli.js and exits 0', () => {
  const home = makeUnusedHome('state');
  const result = runCli(['stub', 'ok', '--value', 'one', 'two'], { preload: STUB_MODULE, home });

  assert.equal(result.status, 0, `expected exit 0\n${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, new RegExp(`entry ${escapeForRegExp(CLI_ENTRY)}`));
  assert.match(result.stdout, /^args \["--value","one","two"\]$/m);
  assert.match(result.stdout, new RegExp(`home ${escapeForRegExp(home)}`));
  assert.match(result.stdout, /^cwd /m);
});

test('a flag after the subcommand name is the subcommand argument, not a global flag', () => {
  const result = runCli(['stub', 'ok', '--help'], { preload: STUB_MODULE });

  assert.equal(result.status, 0, `expected exit 0\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^args \["--help"\]$/m);
  assert.doesNotMatch(result.stdout, /^Usage:$/m);
});

test('a command that returns nothing exits 0', () => {
  const result = runCli(['stub', 'silent'], { preload: STUB_MODULE });

  assert.equal(result.status, 0, `expected exit 0\n${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, '');
});

test('a command that reports an operational failure exits 1', () => {
  const result = runCli(['stub', 'fail'], { preload: STUB_MODULE });

  assert.equal(result.status, 1, `expected exit 1\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^stub fail ran$/m);
  assert.match(result.stderr, /^stub fail could not reach the archive$/m);
  assert.doesNotMatch(result.stderr, /^Usage:$/m, 'an operational failure is not a usage error');
});

test('a command that throws an unexpected error exits 1 without a stack trace', () => {
  const result = runCli(['stub', 'crash'], { preload: STUB_MODULE });

  assert.equal(result.status, 1, `expected exit 1\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^error: stub crash failed: the archive database is locked by another process$/m);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'a stack trace is not an operator-facing line');
});

test('a command that throws a usage error exits 2 and prints the usage', () => {
  const result = runCli(['stub', 'refuse'], { preload: STUB_MODULE });

  assert.equal(result.status, 2, `expected exit 2\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /stub refuse needs a value for --repo/);
  assert.match(result.stderr, /^Usage:$/m);
});

test('a command that returns a value which is not an exit code exits 1', () => {
  const result = runCli(['stub', 'odd'], { preload: STUB_MODULE });

  assert.equal(result.status, 1, `expected exit 1\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /returned a string instead of an exit code/);
});

test('the longest registered name wins and the trailing tokens reach that command', () => {
  const result = runCli(['stub', 'group', 'deep', '--leftover'], { preload: STUB_MODULE });

  assert.equal(result.status, 0, `expected exit 0\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^stub group deep ran$/m);
  assert.match(result.stdout, /^leftover \["--leftover"\]$/m);
  assert.doesNotMatch(result.stdout, /^stub group ran$/m);
});

test('a group with no subcommand of its own exits 2 and names the commands it holds', () => {
  const result = runCli(['stub'], { preload: STUB_MODULE });

  assert.equal(result.status, 2, `expected exit 2\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /unknown command "stub"/);
  assert.match(result.stderr, /the commands it holds are [^;]*stub group, stub group deep/);
});

test('the usage listing is generated from the registry', () => {
  const result = runCli(['--help'], { preload: STUB_MODULE });

  assert.equal(result.status, 0, `expected exit 0\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^ {2}stub ok \[value \.\.\.\]\s{2}Stub that succeeds/m);
  assert.match(result.stdout, /^ {2}stub fail\s{2,}Stub that reports an operational failure\.$/m);
  assert.doesNotMatch(
    result.stdout,
    /none is registered/,
    'the registry holds stub commands, so that line would be false',
  );
});

test('src/commands/index.js is the only module a subcommand is registered in', () => {
  const source = readFileSync(CLI_ENTRY, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? '');

  assert.deepEqual(
    specifiers.filter((specifier) => specifier.includes('commands/')),
    ['./commands/index.js'],
    'the composition root must resolve commands through the registry and import no other command module',
  );
  const registered = runCli(['--help'], { preload: STUB_MODULE });
  assert.equal(registered.status, 0, `expected exit 0\n${registered.stdout}${registered.stderr}`);
  assert.match(
    registered.stdout,
    /^ {2}stub ok /m,
    'a command registered in src/commands/index.js did not reach the composition root',
  );
});

test('the composition root and the registry import only node: builtins and relative paths', () => {
  for (const file of [CLI_ENTRY, REGISTRY_ENTRY]) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier = ''] of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
      const allowed = specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../');
      assert.ok(
        allowed,
        `${path.relative(REPO_ROOT, file)} imports ${specifier}, which is not a node: builtin or a relative path`,
      );
    }
  }
});

test('the composition root writes no state, not even into the home directory it was given', () => {
  const home = makeUnusedHome('state');

  const unknown = runCli(['collectt'], { home });
  const help = runCli(['--help'], { home });
  const stub = runCli(['stub', 'ok'], { home, preload: STUB_MODULE });

  assert.equal(unknown.status, 2);
  assert.equal(help.status, 0);
  assert.equal(stub.status, 0);
  assert.equal(existsSync(home), false, 'a dispatch created the home directory, which only a command may resolve');
});
