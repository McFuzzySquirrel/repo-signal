/**
 * The `setup` command, driven the way an operator reaches it.
 *
 * Every test here spawns `node src/cli.js`, because importing the command module would prove the
 * function while leaving dispatch, global flag parsing and the exit code unproven (`RS-TUI-FR-01`).
 * The home is a temporary directory, the GitHub stub is the loopback server behind
 * `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT`, and the token is an obviously fake token-shaped string, so an
 * assertion that no fragment of it reached the transcript means something.
 *
 * The assertions that matter are the ones a transcript cannot hide. `setup` has to appear in the
 * generated command list like every other command, its two flags have to print and exit 0 while
 * leaving no directory behind, a standard input with nothing on it has to exit 1 and name the command
 * to run instead, and a standard input carrying answers has to be able to complete a first run that
 * the existing loader reads back. A returning visit has to reach both menus the feature places behind
 * the setup menu, and a step that failed has to end the visit with the operational-failure code rather
 * than as a success.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config/load.js';
import { CONFIG_MANAGER_MENU } from '../src/tui/config-manager.js';
import { RUN_ACTIONS_MENU } from '../src/tui/run-actions.js';
import { FIRST_RUN_STEPS } from '../src/tui/setup-wizard.js';
import { SETUP_MENU } from '../src/commands/setup.js';
import { createStubGitHub } from './helpers/stub-github-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
const TOKEN = 'ghp_' + 'OBVIOUSLY_FAKE_SETUP_COMMAND_TOKEN';
const TOKEN_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/u;
const ESCAPE = /\u001b/u;

/** Rows of the setup menu, counted from one. */
const CHANGE = '1';
const RUN = '2';
const LEAVE = '3';

/** The listing the discovery command reads during a first run. */
const LISTING = [
  { full_name: 'owner/alpha', visibility: 'private', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/beta', visibility: 'public', permissions: { admin: true, push: true, pull: true } },
];

/**
 * @param {string} value
 * @returns {string} The value with every regular-expression metacharacter escaped.
 */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** @type {string[]} */
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {string} home
 * @returns {string} A home that does not exist yet, so a run that creates it is caught.
 */
function unusedHome(home) {
  const directory = mkdtempSync('/tmp/opencode/repo-signal-setup-');
  temporaryDirectories.push(directory);
  return path.join(directory, home);
}

/**
 * A directory removed after the test. `unlock` runs first, because a test that made a directory
 * unreadable or unwritable has to hand it back before anything can remove it.
 * @param {import('node:test').TestContext} t
 * @param {() => void} [unlock]
 * @returns {string}
 */
function temporaryDirectory(t, unlock = () => {}) {
  const directory = mkdtempSync('/tmp/opencode/repo-signal-setup-');
  t.after(() => {
    unlock();
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/**
 * @typedef {object} SpawnResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {NodeJS.Signals | null} signal
 */

/**
 * Drive the real entry point. Standard input is a pipe carrying `answers` when any are given, and a
 * pipe that ends immediately when they are not: that is the pair of cases the command has to tell
 * apart, so the test drives both rather than simulating either.
 * @param {string[]} args Arguments after the entry-point path.
 * @param {{ answers?: string[], home?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {SpawnResult}
 */
function runCli(args, options = {}) {
  const answers = options.answers;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    ...(answers === undefined ? {} : { input: answers.map((answer) => `${answer}\n`).join('') }),
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      ...(options.env ?? {}),
      REPO_SIGNAL_HOME: options.home ?? unusedHome('home'),
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
  };
}

/**
 * Drive the real entry point without blocking this process, which a run that talks to the loopback
 * stub requires: the stub is served by this process, so a synchronous spawn would starve the very
 * server the run is waiting on.
 * @param {string[]} args Arguments after the entry-point path.
 * @param {{ answers: string[], home: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<SpawnResult>}
 */
function runCliAsync(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: '', ...(options.env ?? {}), REPO_SIGNAL_HOME: options.home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(options.answers.map((answer) => `${answer}\n`).join(''));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.on('close', (status, signal) => { resolve({ status, stdout, stderr, signal }); });
  });
}

/**
 * A home that already has a configuration, so the command has to choose the returning visit rather
 * than the first run.
 * @param {import('node:test').TestContext} t
 * @returns {{ home: string, configPath: string, document: string }}
 */
function configuredHome(t) {
  const home = path.join(temporaryDirectory(t), 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, 'config.json');
  const document = `${JSON.stringify({ enrolled: ['owner/alpha'], collectionHourUtc: 0 }, null, 2)}\n`;
  writeFileSync(configPath, document, { mode: 0o600 });
  return { home, configPath, document };
}

/**
 * A loopback GitHub stub scripted for the one request a first run that declines its collection makes.
 * The assertion that the first run asked for exactly this one request is what proves the flow added
 * no request of its own to the discovery command's (`RS-TUI-C03`).
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ stub: import('./helpers/stub-github-server.mjs').StubGitHub, baseUrl: string }>}
 */
async function discoveryStub(t) {
  const previousGate = process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  t.after(() => {
    if (previousGate === undefined) delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
    else process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = previousGate;
  });
  process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = '1';
  const stub = createStubGitHub({ token: TOKEN });
  t.after(() => stub.stop());
  stub.route('GET /user/repos*', { json: LISTING });
  return { stub, baseUrl: await stub.start() };
}

/**
 * Every six-character fragment of a secret that reached a transcript.
 * @param {string} secret
 * @param {string} written
 * @returns {string[]}
 */
function leakedFragments(secret, written) {
  /** @type {string[]} */
  const leaked = [];
  for (let start = 0; start + 6 <= secret.length; start += 1) {
    const fragment = secret.slice(start, start + 6);
    if (written.includes(fragment)) leaked.push(fragment);
  }
  return leaked;
}

test('the generated command list names setup with its summary', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', '--help wrote to standard error');
  const rows = result.stdout.split('\n')
    .filter((line) => /^ {2}setup\b/u.test(line));
  assert.equal(rows.length, 1, `setup appears exactly once in the command list:\n${result.stdout}`);
  assert.match(result.stdout, /^ {2}setup \[--help\] \[--non-interactive\] {2,}\S.*\.$/mu);
  assert.doesNotMatch(result.stdout, ESCAPE, 'the generated listing carries no escape sequence');
});

test('setup --help prints the steps of both visits, exits 0 and writes nothing', () => {
  const home = unusedHome('home');

  const result = runCli(['setup', '--help'], { home });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', 'setup --help wrote to standard error');
  for (const step of FIRST_RUN_STEPS) {
    assert.ok(result.stdout.includes(step), `the help prints the first-run step: ${step}`);
  }
  for (const row of SETUP_MENU) {
    assert.ok(result.stdout.includes(row), `the help prints the setup row: ${row}`);
  }
  for (const row of CONFIG_MANAGER_MENU) {
    assert.ok(result.stdout.includes(row), `the help prints the configuration-manager row: ${row}`);
  }
  for (const row of RUN_ACTIONS_MENU) {
    assert.ok(result.stdout.includes(row), `the help prints the run-actions row: ${row}`);
  }
  assert.match(result.stdout, /^A first run, on a home with no configuration file:$/mu);
  assert.match(result.stdout, /^A returning visit, on a home that already has a configuration file, opens this menu:$/mu);
  assert.doesNotMatch(result.stdout, ESCAPE, 'the help carries no escape sequence');
  assert.equal(existsSync(home), false, 'setup --help created the home directory');
});

test('setup --non-interactive prints the scriptable equivalent of every step, exits 0 and writes nothing', () => {
  const home = unusedHome('home');

  const result = runCli(['setup', '--non-interactive'], { home });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', 'setup --non-interactive wrote to standard error');
  const lines = result.stdout.split('\n');
  // Every step of every list is answered by a command beside it, so a step an operator cannot
  // script cannot be printed as though it were one.
  for (const list of [FIRST_RUN_STEPS, SETUP_MENU, CONFIG_MANAGER_MENU, RUN_ACTIONS_MENU]) {
    for (const step of list) {
      const printed = lines.findIndex((line) => line.includes(step));
      assert.notEqual(printed, -1, `the script prints the step: ${step}`);
      assert.match(
        lines[printed + 1] ?? '',
        /^ {5}script: \S/u,
        `the step is followed by what to run instead: ${step}`,
      );
    }
  }
  // The commands named are the ones this build registers, and the token is not one of them.
  for (const command of [
    'node src/cli.js config check', 'node src/cli.js config init', 'node src/cli.js discover',
    'node src/cli.js collect', 'node src/cli.js report', 'node src/cli.js serve',
  ]) {
    assert.ok(result.stdout.includes(command), `the script names ${command}`);
  }
  assert.match(result.stdout, /^ {5}script: No command takes a token on the command line/mu);
  assert.match(result.stdout, /never accepted on a command line/u);
  // No schedule is claimed anywhere, and no prompt is described as installing one.
  assert.doesNotMatch(result.stdout, /installs a schedule|schedule installed|timer installed/u);
  assert.doesNotMatch(result.stdout, ESCAPE, 'the script carries no escape sequence');
  assert.equal(existsSync(home), false, 'setup --non-interactive created the home directory');
});

test('a standard input with nothing on it exits 1 and names the command to run instead', () => {
  const home = unusedHome('home');

  const result = runCli(['setup'], { home });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^setup: standard input is not a terminal and carried nothing to answer with/mu);
  assert.match(result.stderr, /node src\/cli\.js setup --non-interactive/u);
  assert.match(result.stderr, /node src\/cli\.js setup from a/u);
  // The same instructions are printed, so a refused run leaves the operator with the whole surface.
  for (const step of FIRST_RUN_STEPS) {
    assert.ok(result.stdout.includes(step), `the refusal printed the step: ${step}`);
  }
  assert.doesNotMatch(result.stderr, /\n\s+at /u, 'no stack trace is printed');
  assert.doesNotMatch(result.stdout, ESCAPE);
  assert.equal(existsSync(home), false, 'the refusal created the home directory');
});

test('an argument setup does not know exits 2 with the usage', () => {
  for (const argument of ['stray', '--wat', '--repo owner/alpha']) {
    const home = unusedHome('home');

    const result = runCli(['setup', argument], { home });

    assert.equal(result.status, 2, `expected exit 2 for ${argument}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(`setup does not know "${escapeForRegExp(argument)}"`, 'u'));
    assert.match(result.stderr, /^Usage:$/mu);
    assert.match(result.stderr, /^ {2}2 {2}the command line was a usage error$/mu);
    assert.equal(result.stdout, '', 'a usage error printed output');
    assert.equal(existsSync(home), false, `the refusal for ${argument} created the home directory`);
  }
});

test('the whole first run is completable by writing answers to standard input', async (t) => {
  const { stub, baseUrl } = await discoveryStub(t);
  const home = unusedHome('home');

  const result = await runCliAsync(['setup'], {
    home,
    // Colour is off and the terminal is dumb for this run, so the transcript has to state every
    // option, state and selection in words on its own (`RS-TUI-C05`).
    env: { NO_COLOR: '1', TERM: 'dumb', REPO_SIGNAL_GITHUB_BASE_URL: baseUrl, REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: '1' },
    // Agree to the templates, type the token, toggle row 2, take the default hour, decline the first
    // collection: the answers a person types, in the order the flow asks for them.
    answers: ['y', TOKEN, '2 ', '', '6', 'n'],
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.signal, null, `the process was killed by ${String(result.signal)}`);
  // What it wrote is read back through the loader that owns it, not through anything this task wrote.
  assert.deepEqual(loadConfig({ env: { ...process.env, REPO_SIGNAL_HOME: home }, cwd: ROOT }).enrolled, ['owner/beta']);
  const credentialMode = statSync(path.join(home, 'credentials.json')).mode & 0o777;
  assert.equal(credentialMode, 0o600, 'the credential file is mode 0600');
  assert.match(readFileSync(path.join(home, 'credentials.json'), 'utf8'), new RegExp(TOKEN, 'u'));
  assert.match(result.stdout, /^setup: the first run is complete with 1 enrolled; /mu);
  // The flow added no request of its own to the one the discovery command makes.
  assert.deepEqual(stub.paths(), ['/user/repos']);
  // The token never reached a printed line, an escape sequence never did either, and no stack trace did.
  assert.deepEqual(leakedFragments(TOKEN, result.stdout + result.stderr), []);
  assert.doesNotMatch(result.stdout, TOKEN_SHAPE, 'no printed line carries a token-shaped value');
  assert.doesNotMatch(result.stdout, ESCAPE, 'the transcript carries no escape sequence');
  assert.doesNotMatch(result.stderr, /\n\s+at /u, 'no stack trace is printed');
  assert.ok(home.startsWith('/tmp/opencode/'), `the run used a temporary home: ${home}`);
});

test('a first run the operator cancels ends the visit with exit 1 and writes no file', () => {
  const home = unusedHome('home');

  // q at the first question: the flow is cancelled before it has written anything, and the command
  // reports that as the operational failure it is rather than as a completed visit.
  const result = runCli(['setup'], { home, answers: ['q'] });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^setup: the first run was cancelled: .*; this visit ends with the operational-failure code$/mu);
  assert.doesNotMatch(result.stdout, /^configuration template created/mu, 'no template was written');
  assert.deepEqual(readdirSync(home), [], 'the cancelled first run wrote nothing into the home');
  assert.doesNotMatch(result.stderr, /\n\s+at /u);
});

test('a returning visit mounts the configuration manager, and the visit ends when it returns', (t) => {
  const { home, configPath, document } = configuredHome(t);

  const result = runCli(['setup'], { home, answers: [CHANGE, String(CONFIG_MANAGER_MENU.length)] });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, new RegExp(`^setup: the home at ${escapeForRegExp(home)} already has a configuration`, 'mu'));
  assert.match(result.stdout, /^configuration manager: /mu);
  assert.match(result.stdout, /^configuration manager: left the menu; /mu);
  // The mounted flow owns the input it read, so the visit ends with it rather than asking a question
  // the answers for were consumed with its session.
  assert.match(result.stdout, /^setup: the configuration manager returned; this visit ends here /mu);
  assert.equal(result.stdout.match(/What would you like to do\?/gu)?.length, 1, 'the setup menu was asked once');
  assert.equal(readFileSync(configPath, 'utf8'), document, 'leaving the manager changed no file');
  assert.deepEqual(readdirSync(home).sort(), ['config.json'], 'the visit wrote no file');
  assert.doesNotMatch(result.stdout, ESCAPE);
  assert.doesNotMatch(result.stderr, /\n\s+at /u);
});

test('a returning visit mounts the run actions, and the visit ends when they return', (t) => {
  const { home, configPath, document } = configuredHome(t);

  const result = runCli(['setup'], { home, answers: [RUN, String(RUN_ACTIONS_MENU.length)] });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^run actions: /mu);
  assert.match(result.stdout, /^enrolled set \(1\): owner\/alpha$/mu);
  assert.match(result.stdout, /^run actions: left the menu; no action was run$/mu);
  assert.match(result.stdout, /^setup: the run-actions menu returned; this visit ends here /mu);
  assert.equal(readFileSync(configPath, 'utf8'), document, 'leaving the run menu changed no file');
  assert.deepEqual(readdirSync(home).sort(), ['config.json'], 'the run actions wrote no file');
  assert.doesNotMatch(result.stdout, ESCAPE);
});

test('leaving the setup menu exits 0 and writes nothing', (t) => {
  const { home, configPath, document } = configuredHome(t);

  const result = runCli(['setup'], { home, answers: [LEAVE] });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^setup: left; leaving wrote nothing$/mu);
  assert.equal(readFileSync(configPath, 'utf8'), document, 'leaving changed no file');
  assert.doesNotMatch(result.stdout, ESCAPE);
});

test('a standard input that answers q at the setup menu exits 1 and changes no file', (t) => {
  const { home, configPath, document } = configuredHome(t);

  const result = runCli(['setup'], { home, answers: ['q'] });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^setup: stopped: /mu);
  assert.doesNotMatch(result.stdout, /^configuration manager: /mu, 'a cancelled menu opened no sub-menu');
  assert.equal(readFileSync(configPath, 'utf8'), document, 'cancelling changed no file');
  assert.doesNotMatch(result.stderr, /\n\s+at /u);
});

test('a mounted flow the operator cancels ends the visit with exit 1', (t) => {
  const { home, configPath, document } = configuredHome(t);

  const result = runCli(['setup'], { home, answers: [CHANGE, 'q'] });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^cancelled: /mu);
  assert.match(result.stderr, /^setup: the configuration manager was cancelled: .*; nothing further was written$/mu);
  assert.equal(readFileSync(configPath, 'utf8'), document, 'a cancelled manager changed no file');
  assert.doesNotMatch(result.stderr, /\n\s+at /u);
});

test('an edit that could not be saved ends the visit with exit 1', (t) => {
  // A home the current user cannot write to: the manager's own refusal is what ends the visit.
  const directory = temporaryDirectory(t, () => chmodSync(path.join(directory, 'home'), 0o700));
  const home = path.join(directory, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, 'config.json');
  const document = `${JSON.stringify({ enrolled: ['owner/alpha'], collectionHourUtc: 0 }, null, 2)}\n`;
  writeFileSync(configPath, document, { mode: 0o600 });
  chmodSync(home, 0o500);

  const result = runCli(['setup'], {
    home,
    answers: [CHANGE, '5', '6', String(CONFIG_MANAGER_MENU.length)],
  });

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^configuration: not saved: /mu);
  assert.match(result.stderr, /^setup: the configuration manager reported a failure above \(.+\), /mu);
  assert.match(result.stderr, /so this visit ends with the operational-failure code$/mu);
  assert.equal(readFileSync(configPath, 'utf8'), document, 'the refused edit left the file unchanged');
  assert.doesNotMatch(result.stderr, /\n\s+at /u);
});

test('a configuration the loader refuses is a returning visit, and the manager reports it', (t) => {
  const { home, configPath } = configuredHome(t);
  const broken = '{ this is not a configuration\n';
  writeFileSync(configPath, broken, { mode: 0o600 });

  // The visit is chosen by looking at the home, so a file that is there but broken is not a first run:
  // the flow that would replace it is never opened, and nothing is written to replace it.
  const leaving = runCli(['setup'], { home, answers: [LEAVE] });
  assert.equal(leaving.status, 0, `${leaving.stdout}${leaving.stderr}`);
  assert.match(leaving.stdout, /^setup: the home at .* already has a configuration, so this is a returning visit$/mu);
  assert.doesNotMatch(leaving.stdout, /^home: /mu, 'the first-run flow opened on a home that has a configuration file');
  assert.doesNotMatch(leaving.stdout, /^first run/mu);
  assert.equal(readFileSync(configPath, 'utf8'), broken, 'the file is byte-identical to what it was');

  const opening = runCli(['setup'], { home, answers: [CHANGE] });
  assert.equal(opening.status, 1, `${opening.stdout}${opening.stderr}`);
  assert.match(opening.stdout, /^configuration manager: the existing loader refused the configuration at /mu);
  assert.match(opening.stderr, /^setup: the configuration manager reported a failure above \(.+\), /mu);
  assert.equal(readFileSync(configPath, 'utf8'), broken, 'the refused configuration is unchanged');
});

test('the setup menu has three rows and the dispatch reads the last as the row that leaves', () => {
  // The dispatch treats the only remaining row as the one that leaves, which is only safe while the
  // prompt returns a row it printed and this menu still holds exactly these three.
  assert.equal(SETUP_MENU.length, 3);
  assert.match(SETUP_MENU[0] ?? '', /configuration manager/u);
  assert.match(SETUP_MENU[1] ?? '', /^Run an action/u);
  assert.match(SETUP_MENU[2] ?? '', /^Leave setup\.$/u);
});

test('no dependency, no alternate screen and no cursor addressing is introduced', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'commands', 'setup.js'), 'utf8');
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  for (const [, specifier = ''] of source.matchAll(/\bfrom\s+'([^']+)'/gu)) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
      `src/commands/setup.js imports ${specifier}, which is not a node: builtin or a relative path`,
    );
  }
  assert.doesNotMatch(source, /\u001b\[|\\e\[|\\u001b\[/u, 'no cursor addressing is written');
  assert.equal(manifest.dependencies, undefined, 'package.json declares no runtime dependency');
});
