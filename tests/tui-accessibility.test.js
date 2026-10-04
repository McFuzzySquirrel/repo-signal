/**
 * The setup surface operated the way a person operates it: with the keyboard, without colour, with
 * a pipe on standard input, and interrupted at a chosen step (`RS-TUI-FR-06`, `RS-A11Y-06`).
 *
 * Every test here drives the real entry point. A pipe carries the answers, because a pipe has no
 * pointer, no colour and no cursor - so a run that completes through one is a run nobody needed a
 * mouse for. Where the question under test is about a terminal itself - the mask on the token
 * field, the raw mode a Ctrl-C arrives through, the terminal's own echo after an interruption - the
 * command is run on a pseudo-terminal allocated by `script(1)` from util-linux, with one keystroke
 * sent per prompt line the way a person types, and `stty -a` read back out of that same terminal
 * afterwards. Nothing is imported in order to avoid the terminal: the argument parsing, the stream
 * handling and the exit code are part of what has to hold, so `node src/cli.js setup` is what runs.
 *
 * The step lists and menu rows are imported so that an assertion names the step the transcript was
 * required to print instead of a copy of the sentence, which is what lets these tests fail for the
 * right reason when a flow and its own description drift apart.
 *
 * What these tests deliberately do not do: they do not edit a prompt, weaken an assertion or import
 * a module to reach around a surface that a person cannot reach. An interaction that cannot be
 * driven from a pipe is a finding for `cli-engineer` and is reported as one, not patched here. Each
 * run gets its own temporary home and its own stub, and the local-transport gate is set only on the
 * child processes a test names, so one case's reachability cannot become another's (`RS-SEC-05`).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SETUP_MENU } from '../src/commands/setup.js';
import { loadConfig, parseConfig } from '../src/config/load.js';
import { CONFIG_MANAGER_MENU } from '../src/tui/config-manager.js';
import { FIRST_RUN_STEPS } from '../src/tui/setup-wizard.js';
import { createStubGitHub } from './helpers/stub-github-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
/** An obviously fake token-shaped value, so an assertion that none of it was echoed means something. */
const TOKEN = `ghp_${'OBVIOUSLY_FAKE_ACCESSIBILITY_TOKEN'}`;
/** The non-secret value the configuration initialiser writes into a fresh credential template. */
const PLACEHOLDER = 'REPLACE_WITH_YOUR_GITHUB_TOKEN';

/** The one character this surface must never write: the start of every escape sequence. */
const ESCAPE = /\u001b/u;
/** A carriage return the terminal did not turn into a line ending, which a line-oriented surface has no reason to write. */
const STRAY_CARRIAGE_RETURN = /\r(?!\n)/u;
/** Words a prompt would use only if a pointer were required. */
const POINTER_WORDS = /\b(?:mouse|click|clicks|tap|touch|scroll|drag|hover|cursor|trackpad)\b/iu;
/** Ctrl-C as the byte a terminal's line discipline delivers while readline holds raw mode. */
const CTRL_C = '\u0003';
/** The line the pseudo-terminal command appends so the child process's own exit code is readable. */
const EXIT_MARKER = 'setup child exit';
/** How long one prompt may take to arrive before a pseudo-terminal run is treated as stalled. */
const MARKER_TIMEOUT_MS = 20_000;
/** How long a pseudo-terminal run may take before it is killed and reported as stalled. A run of this surface takes under a second. */
const RUN_TIMEOUT_MS = 45_000;

/** The listing the discovery command reads during a first run: two reachable, one without Administration read. */
const LISTING = [
  { full_name: 'owner/alpha', visibility: 'private', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/beta', visibility: 'public', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/gamma', visibility: 'public', permissions: { admin: false, push: false, pull: true } },
];

/** Every prompt in a first run states how to answer it, and each answer is stated back in words. */
const FIRST_RUN_INSTRUCTIONS = [
  'Answer y or n.',
  'Press Enter for the default: yes.',
  'Nothing typed here is echoed. Press Enter when the value is complete.',
  'Type q on its own to cancel.',
  'On one line: a row number then a space toggles that row; a selects all, n selects none, i inverts.',
  'Press Enter on an empty line to accept. Type q to cancel.',
  'Type a value and press Enter.',
  'Press Enter for the default: no.',
];

/**
 * The three questions of a first run that can be interrupted before anything is enrolled, with what
 * each one leaves behind and how a person reaches it. `credential` says what the credential file
 * must hold afterwards: nothing at all where the run was interrupted before the templates were
 * agreed to, the untouched template where it was interrupted at the masked field, and the token that
 * step completed where the run got as far as choosing repositories. `steps` is the same
 * interruption typed at a terminal: one keystroke per prompt, each after the line that prompts for it.
 * @type {ReadonlyArray<{
 *   step: string,
 *   answers: string[],
 *   credential: 'absent' | 'placeholder' | 'typed',
 *   needsDiscovery: boolean,
 *   cancellation: RegExp,
 *   stopped: RegExp,
 *   steps: PtyStep[],
 * }>}
 */
const INTERRUPTIONS = [
  {
    step: 'the first question, which offers the private templates',
    answers: ['q'],
    credential: 'absent',
    needsDiscovery: false,
    cancellation: /^cancelled: q cancels, so the default was not taken either\.$/mu,
    stopped: /^first run stopped: q cancels, so the default was not taken either\.; nothing further was written$/mu,
    steps: [{ wait: 'Type q to cancel.', keys: CTRL_C }],
  },
  {
    step: 'the masked token field',
    answers: ['y', 'q'],
    credential: 'placeholder',
    needsDiscovery: false,
    cancellation: /^cancelled: no value was entered, because q cancels\.$/mu,
    stopped: /^first run stopped: no value was entered, because q cancels\.; nothing further was written$/mu,
    steps: [
      { wait: 'Type q to cancel.', keys: 'y\n' },
      { wait: 'Type q on its own to cancel.', keys: CTRL_C },
    ],
  },
  {
    step: 'the repository selection',
    answers: ['y', TOKEN, 'q'],
    credential: 'typed',
    needsDiscovery: true,
    cancellation: /^cancelled: the selection was left as it was, because q cancels\.$/mu,
    stopped: /^first run stopped: the selection was left as it was, because q cancels\.; no configuration was written$/mu,
    steps: [
      { wait: 'Type q to cancel.', keys: 'y\n' },
      { wait: 'Type q on its own to cancel.', keys: `${TOKEN}\n` },
      { wait: 'Chosen 0 of 3', keys: CTRL_C },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The environment of one child process.
 *
 * `NO_COLOR`, `TERM` and `FORCE_COLOR` are stated rather than inherited, so what a run was asked for
 * is visible in the test that ran it. The local-transport gate is added only where a test says so
 * and deleted everywhere else: a gate set for the whole suite would make every other case in the
 * repository able to reach any host, and the refusal assertion below would prove nothing.
 * @param {{
 *   home: string,
 *   baseUrl?: string,
 *   gate?: boolean,
 *   noColour?: boolean,
 *   term?: string,
 *   forceColour?: boolean,
 * }} options
 * @returns {NodeJS.ProcessEnv}
 */
function childEnvironment(options) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, NODE_OPTIONS: '', REPO_SIGNAL_HOME: options.home };
  if (options.baseUrl === undefined) delete env.REPO_SIGNAL_GITHUB_BASE_URL;
  else env.REPO_SIGNAL_GITHUB_BASE_URL = options.baseUrl;
  if (options.gate === true) env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = '1';
  else delete env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  if (options.noColour === true) env.NO_COLOR = '1';
  else delete env.NO_COLOR;
  if (options.forceColour === true) env.FORCE_COLOR = '3';
  else delete env.FORCE_COLOR;
  env.TERM = options.term ?? 'dumb';
  return env;
}

/**
 * A scratch directory removed when the test ends, and a home inside it that does not exist yet, so a
 * run that creates the home directory is caught rather than mistaken for one that found it.
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @returns {{ scratch: string, home: string }}
 */
function scratchHome(t, label) {
  const scratch = mkdtempSync('/tmp/opencode/repo-signal-tui-a11y-');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  return { scratch, home: path.join(scratch, label) };
}

/**
 * A home that already holds a configuration and its credential, so the command has to open the
 * returning visit. The document is written through the loader's own parser first, so the fixture is
 * one the product could have written itself.
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @param {{ enrolled: string[], collectionHourUtc: number }} configuration
 * @returns {{ scratch: string, home: string }}
 */
function configuredHome(t, label, configuration) {
  const { scratch, home } = scratchHome(t, label);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(home, 'config.json'),
    `${JSON.stringify(configuration, null, 2)}\n`,
    { mode: 0o600 },
  );
  parseConfig(readFileSync(path.join(home, 'config.json'), 'utf8'));
  return { scratch, home };
}

/**
 * The loopback GitHub stub every first run needs, started for one test and stopped after it. The
 * gate is not set here: it is set on each child that is allowed to talk to it, and nowhere else.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ stub: import('./helpers/stub-github-server.mjs').StubGitHub, baseUrl: string }>}
 */
async function discoveryStub(t) {
  const stub = createStubGitHub({ token: TOKEN });
  t.after(() => stub.stop());
  stub.route('GET /user/repos*', { json: LISTING });
  return { stub, baseUrl: await stub.start() };
}

/**
 * @typedef {object} RunResult
 * @property {number | null} status
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} transcript Everything the operator could read, in the order it arrived.
 */

/**
 * Drive the real entry point from a pipe.
 *
 * Used for the runs that contact nothing, so a synchronous spawn cannot starve a stub this process
 * is serving. `answers` are the typed lines, one per question; an empty list is a pipe that ends at
 * once, which is the run with nothing to answer with.
 * @param {string[]} answers
 * @param {NodeJS.ProcessEnv} env
 * @returns {RunResult}
 */
function runSetup(answers, env) {
  const result = spawnSync(process.execPath, [CLI, 'setup'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    input: answers.map((answer) => `${answer}\n`).join(''),
    env,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    transcript: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/**
 * Drive the real entry point from a pipe without blocking this process, which a run that talks to the
 * loopback stub requires: the stub is served here, so a synchronous spawn would starve the very
 * server the run is waiting on.
 * @param {string[]} answers
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<RunResult>}
 */
function runSetupAsync(answers, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'setup'], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(answers.map((answer) => `${answer}\n`).join(''));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr, transcript: `${stdout}${stderr}` });
    });
  });
}

/**
 * @typedef {object} PtyStep
 * @property {string} wait A line the transcript must hold before this keystroke is typed.
 * @property {string} keys The keystrokes themselves: one typed line, or the Ctrl-C character.
 */

/**
 * @typedef {object} PtyResult
 * @property {number | null} status `script`'s own exit status.
 * @property {number | null} exitCode What `node src/cli.js setup` returned, read out of the transcript.
 * @property {string} transcript Everything the terminal showed, with the terminal's own CRLF endings normalised to LF.
 * @property {string | null} stty The line of `stty -a` that reports the terminal's echo and line mode.
 * @property {number} typed How many keystrokes were sent.
 * @property {number | null} stalledAt The step whose prompt never arrived, or null when every step was typed.
 */

/** `script(1)` from util-linux, when this machine has it: the only dependency-free way to give a child a real terminal. */
const SCRIPT_TOOL = (() => {
  const probe = spawnSync('script', ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && probe.error === undefined ? 'script' : null;
})();

/**
 * The terminal's own CRLF endings become LF, and nothing else changes: a CR that is not part of a
 * line ending survives this, and is asserted against separately.
 * @param {string} text
 * @returns {string}
 */
function terminalText(text) {
  return text.split('\r\n').join('\n');
}

/**
 * Drive the real entry point on a pseudo-terminal, one keystroke per prompt line, the way a person
 * types. Each keystroke waits for the line that prompts for it, so the run is paced by the surface
 * rather than raced against it. `stty -a` runs in that same terminal once the command returns, which
 * is the only way from outside a process to read the terminal's own echo and line-mode flags back.
 * @param {PtyStep[]} steps
 * @param {{ home: string, baseUrl: string }} options
 * @returns {Promise<PtyResult>}
 */
function ptySetup(steps, options) {
  assert.notEqual(SCRIPT_TOOL, null, 'script(1) is required to run these tests');
  return new Promise((resolve, reject) => {
    const child = spawn(
      /** @type {string} */ (SCRIPT_TOOL),
      ['-q', '-e', '-c', `node src/cli.js setup; echo ${EXIT_MARKER}=$?; stty -a`, '/dev/null'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          REPO_SIGNAL_HOME: options.home,
          REPO_SIGNAL_GITHUB_BASE_URL: options.baseUrl,
          REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: '1',
          TERM: 'xterm-256color',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    /** @type {string} */
    let raw = '';
    /** @type {number} */
    let typed = 0;
    /** @type {number|null} */
    let stalledAt = null;
    /** @type {NodeJS.Timeout|null} */
    let waiting = null;
    const giveUp = setTimeout(() => { child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
    /** Send every keystroke whose prompt has arrived, then arm the timeout for the next one. */
    const pump = () => {
      const transcript = terminalText(raw);
      while (typed < steps.length && transcript.includes(/** @type {PtyStep} */ (steps[typed]).wait)) {
        child.stdin.write(/** @type {PtyStep} */ (steps[typed]).keys);
        typed += 1;
      }
      if (typed >= steps.length) {
        if (waiting !== null) clearTimeout(waiting);
        waiting = null;
        return;
      }
      if (waiting === null) {
        waiting = setTimeout(() => {
          stalledAt = typed;
          child.kill('SIGKILL');
        }, MARKER_TIMEOUT_MS);
      }
    };
    /** @param {Buffer | string} chunk @returns {void} */
    const onData = (chunk) => {
      raw += String(chunk);
      pump();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', reject);
    child.on('close', (status) => {
      clearTimeout(giveUp);
      if (waiting !== null) clearTimeout(waiting);
      const transcript = terminalText(raw);
      const reported = new RegExp(`${EXIT_MARKER}=(\\d+)`, 'u').exec(transcript);
      const stty = /^[^\n]*\bicanon\b[^\n]*$/mu.exec(transcript)?.[0] ?? null;
      resolve({
        status,
        exitCode: reported === null ? null : Number(reported[1]),
        transcript,
        stty,
        typed,
        stalledAt,
      });
    });
  });
}

/**
 * Assert that nothing this surface wrote can move a cursor, change a colour or start an escape
 * sequence, naming the offset so a red run says where to look.
 * @param {string} text
 * @param {string} what Which stream or transcript is being checked.
 * @returns {void}
 */
function assertPlainText(text, what) {
  const index = text.search(ESCAPE);
  assert.equal(
    index,
    -1,
    `${what} carries an escape sequence at offset ${String(index)}: `
      + `${JSON.stringify(text.slice(Math.max(0, index - 40), index + 40))}`,
  );
  const carriage = text.search(STRAY_CARRIAGE_RETURN);
  assert.equal(
    carriage,
    -1,
    `${what} writes a carriage return that is not a line ending, at offset ${String(carriage)}`,
  );
}

/**
 * Assert that an interrupted run left nothing half-written (`RS-TUI-C04`).
 *
 * A write that goes through a temporary file and a rename leaves one of two traces when it is cut
 * short: the temporary file is still there, or the document that reached the name is not a document.
 * Both are checked, along with the two files a first run can have written by the time the operator
 * reached the interrupted step.
 * @param {string} home
 * @param {{ step: string, credential: 'absent' | 'placeholder' | 'typed' }} expectation
 * @returns {void}
 */
function assertNothingPartial(home, expectation) {
  const entries = readdirSync(home).sort();
  const temporary = entries.filter((entry) => entry.startsWith('.') || entry.endsWith('.new'));
  assert.deepEqual(temporary, [], `${expectation.step}: a temporary file was left behind in ${home}: `
    + `${JSON.stringify(temporary)}`);

  const configPath = path.join(home, 'config.json');
  const credentialsPath = path.join(home, 'credentials.json');
  if (expectation.credential === 'absent') {
    assert.deepEqual(entries, [], `${expectation.step}: the interrupted run wrote into ${home}: `
      + `${JSON.stringify(entries)}`);
    return;
  }

  assert.ok(existsSync(configPath), `${expectation.step}: the templates were written before this step`);
  // The parser is the loader's own: a document it refuses is one that was cut short.
  const configuration = parseConfig(readFileSync(configPath, 'utf8'));
  assert.deepEqual(
    configuration.enrolled,
    [],
    `${expectation.step}: no repository was enrolled, because the selection was never accepted`,
  );
  assert.equal(
    statSync(configPath).mode & 0o777,
    0o600,
    `${expectation.step}: the configuration file is mode 0600, expected 0600`,
  );

  assert.ok(existsSync(credentialsPath), `${expectation.step}: the credential template was written`);
  const credential = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  assert.deepEqual(
    credential,
    expectation.credential === 'placeholder' ? { token: PLACEHOLDER } : { token: TOKEN },
    `${expectation.step}: the credential file holds ${JSON.stringify(credential)}, expected the `
      + `${expectation.credential === 'placeholder' ? 'untouched placeholder' : 'whole typed token'}`,
  );
  assert.equal(
    statSync(credentialsPath).mode & 0o777,
    0o600,
    `${expectation.step}: the credential file is mode 0600`,
  );
  assert.equal(
    existsSync(path.join(home, 'archive.sqlite3')),
    false,
    `${expectation.step}: the interrupted run collected nothing, so there is no archive`,
  );
}

/**
 * The transcript with the temporary home's own path removed, so two runs over two different homes can
 * be compared word for word.
 * @param {string} text
 * @param {{ scratch: string, home: string }} where
 * @returns {string}
 */
function withoutHome(text, where) {
  return text.split(where.home).join('<home>').split(where.scratch).join('<scratch>');
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

/**
 * Assert that a transcript offers every row of a menu as a numbered row, which is what lets an
 * operator choose by typing the number that was printed.
 * @param {string} transcript
 * @param {readonly string[]} rows
 * @param {string} what The menu's own name, used in the failure message.
 * @returns {void}
 */
function assertNumberedRows(transcript, rows, what) {
  rows.forEach((row, index) => {
    assert.ok(
      transcript.includes(`  ${String(index + 1)}) ${row}`),
      `${what} prints row ${String(index + 1)} as text: ${JSON.stringify(row)}`,
    );
  });
}

/**
 * Assert that the terminal a run ended on has its own echo and line mode back. `stty` reports a
 * disabled flag with a leading `-`, so an assertion on the token alone is what distinguishes a restored
 * terminal from one left in raw mode.
 * @param {PtyResult} result
 * @param {string} step Which step was interrupted.
 * @returns {void}
 */
function assertTerminalModeRestored(result, step) {
  assert.notEqual(result.stty, null, `${step}: stty reported the terminal mode:\n${result.transcript}`);
  const line = /** @type {string} */ (result.stty);
  for (const flag of ['isig', 'icanon', 'echo', 'echoe', 'echok']) {
    assert.match(line, new RegExp(`(?:^|\\s)${flag}(?:\\s|$)`, 'u'), `${step}: ${flag} is on, expected it on: ${line}`);
    assert.doesNotMatch(line, new RegExp(`(?:^|\\s)-${flag}(?:\\s|$)`, 'u'), `${step}: ${flag} is not disabled: ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the whole first run is completed by writing answers to standard input, and the loader reads what the transcript said', async (t) => {
  // RS-TUI-FR-06: every prompt and the whole flow are answerable from standard input alone. A pipe
  // has no pointer and no colour, so a run that finishes through one is a run nobody needed either for.
  const { baseUrl } = await discoveryStub(t);
  const { home } = scratchHome(t, 'first-run');

  const result = await runSetupAsync(
    ['y', TOKEN, '2 ', '', '6', 'n'],
    childEnvironment({ home, baseUrl, gate: true }),
  );

  assert.equal(result.status, 0, `expected exit 0\n${result.transcript}`);
  assert.equal(result.signal, null, `the process was killed by ${String(result.signal)}`);
  assert.doesNotMatch(result.stderr, /\n\s+at /u, 'no stack trace is printed');

  // The number typed is the number printed: the transcript offered owner/beta as row 2, and typing
  // "2 " enrolled exactly that repository.
  assert.match(result.stdout, /^ {2}1\) owner\/alpha - not selected$/mu, 'row 1 is printed as a row');
  assert.match(result.stdout, /^ {2}2\) owner\/beta - not selected$/mu, 'row 2 is printed as a row');
  assert.match(result.stdout, /^ {2}3\) owner\/gamma - not selected$/mu, 'row 3 is printed as a row');
  assert.match(result.stdout, /^row 2 \(owner\/beta\) is now selected\.$/mu, 'the toggle is stated in words');
  assert.match(result.stdout, /^accepted 1 of 3: owner\/beta\.$/mu, 'the accepted selection names the row');

  // Every prompt said how to answer it, and every answer is stated back in words rather than by a
  // colour or a highlighted row, which is what a screen reader has to work from (`RS-TUI-C05`).
  for (const instruction of FIRST_RUN_INSTRUCTIONS) {
    assert.ok(result.stdout.includes(instruction), `the transcript states: ${instruction}\n${result.stdout}`);
  }
  for (const acceptance of [
    'answered yes.', 'accepted; nothing was echoed.', 'Chosen 1 of 3 (rows 2).',
    'accepted 1 of 3: owner/beta.', 'accepted.', 'answered no.',
  ]) {
    assert.ok(result.stdout.includes(acceptance), `the transcript states the answer: ${acceptance}\n${result.stdout}`);
  }

  // What was saved is read back through the loader every other command reads, not through the flow.
  const loaded = loadConfig({ env: { ...process.env, REPO_SIGNAL_HOME: home }, cwd: ROOT });
  assert.deepEqual(loaded.enrolled, ['owner/beta'], 'the enrolled set is the row that was selected');
  assert.equal(loaded.collectionHourUtc, 6, 'the collection hour is the one that was typed');
  assert.deepEqual(loaded.denyList, []);
  assert.deepEqual(loaded.enabled, { 'owner/beta': true });
  assert.equal(statSync(path.join(home, 'config.json')).mode & 0o777, 0o600, 'the configuration is mode 0600');
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'credentials.json'), 'utf8')), { token: TOKEN });

  assertPlainText(result.transcript, 'the transcript of a first run driven from a pipe');
  assert.deepEqual(
    leakedFragments(TOKEN, result.transcript),
    [],
    `nothing of the token was echoed to a transcript a person reads\n${result.transcript}`,
  );
});

test('every menu of a returning visit is answered by typing the number it printed, and the saved hour is what the loader reads', (t) => {
  // RS-TUI-FR-06 again, on the second visit: the menus are the other half of the surface, and a
  // numbered row printed as text is what makes them operable with nothing but typing.
  const { home } = configuredHome(t, 'returning', { enrolled: ['owner/alpha'], collectionHourUtc: 4 });

  const result = runSetup(['1', '5', '9', '7'], childEnvironment({ home }));

  assert.equal(result.status, 0, `expected exit 0\n${result.transcript}`);
  assert.equal(result.signal, null, `the process was killed by ${String(result.signal)}`);
  assertPlainText(result.transcript, 'the transcript of a returning visit driven from a pipe');

  assertNumberedRows(result.stdout, SETUP_MENU, 'the setup menu');
  assert.match(result.stdout, /^Answer with the number of one choice, 1 to 3\.$/mu);
  assert.ok(result.stdout.includes(`chosen 1: ${SETUP_MENU[0]}`), 'row 1 is confirmed by the row it printed');
  assertNumberedRows(result.stdout, CONFIG_MANAGER_MENU, 'the configuration-manager menu');
  assert.match(result.stdout, /^Answer with the number of one choice, 1 to 7\.$/mu);
  assert.ok(
    result.stdout.includes(`chosen 5: ${CONFIG_MANAGER_MENU[4]}`),
    'row 5 is confirmed by the row it printed',
  );
  // The default the field offered is the hour the file already held, stated in words.
  assert.ok(result.stdout.includes('An empty answer keeps 4.'), 'the hour field states its default');
  assert.ok(result.stdout.includes(`chosen 7: ${CONFIG_MANAGER_MENU[6]}`), 'row 7 is confirmed by the row it printed');

  const loaded = loadConfig({ env: { ...process.env, REPO_SIGNAL_HOME: home }, cwd: ROOT });
  assert.equal(loaded.collectionHourUtc, 9, 'the hour the flow saved is the hour that was typed');
  assert.deepEqual(loaded.enrolled, ['owner/alpha'], 'the enrolment was not disturbed by the hour edit');
  assert.equal(statSync(path.join(home, 'config.json')).mode & 0o777, 0o600, 'the saved file is mode 0600');
  assert.deepEqual(readdirSync(home), ['config.json'], 'the visit wrote no file the manager did not say it wrote');
});

test('with NO_COLOR set and TERM=dumb the transcript is the transcript a colour terminal gets, and neither carries an escape', async (t) => {
  // RS-TUI-C05: a colour is only ever decoration. The proof is not that no escape appears, it is that
  // asking for colour and refusing it produce the same words, so nothing can be carried by colour.
  const { baseUrl } = await discoveryStub(t);
  const answers = ['y', TOKEN, '2 ', '', '6', 'n'];
  const plain = scratchHome(t, 'no-colour');
  const bright = scratchHome(t, 'forced-colour');

  const dumb = await runSetupAsync(
    answers,
    childEnvironment({ home: plain.home, baseUrl, gate: true, noColour: true, term: 'dumb' }),
  );
  const colourful = await runSetupAsync(
    answers,
    childEnvironment({
      home: bright.home, baseUrl, gate: true, noColour: false, term: 'xterm-256color', forceColour: true,
    }),
  );

  assert.equal(dumb.status, 0, `the NO_COLOR run exited ${String(dumb.status)}\n${dumb.transcript}`);
  assert.equal(colourful.status, 0, `the FORCE_COLOR run exited ${String(colourful.status)}\n${colourful.transcript}`);
  assert.equal(
    withoutHome(colourful.transcript, bright),
    withoutHome(dumb.transcript, plain),
    'the two transcripts differ somewhere other than the temporary home path',
  );
  assertPlainText(dumb.transcript, 'the transcript under NO_COLOR=1 with TERM=dumb');
  assertPlainText(colourful.transcript, 'the transcript with FORCE_COLOR=3 and TERM=xterm-256color');

  // Every state a reader would otherwise get from a colour is present as a word.
  for (const state of [
    'not selected', 'is now selected.', 'Chosen 1 of 3 (rows 2).', 'accepted 1 of 3: owner/beta.',
    'answered yes.', 'answered no.', 'enrolled=no administration-read=yes',
  ]) {
    assert.ok(dumb.stdout.includes(state), `the dumb-terminal transcript states "${state}" as a word:\n${dumb.stdout}`);
  }
});

for (const interruption of INTERRUPTIONS) {
  test(`q at ${interruption.step} ends the visit with the operational-failure code and leaves no partial file`, async (t) => {
    // RS-TUI-FR-06: an interruption at any prompt leaves no partially written file, and the cancel
    // escape is the one every prompt shares.
    const fixture = interruption.needsDiscovery ? await discoveryStub(t) : null;
    const { home } = scratchHome(t, 'interrupted');

    const result = interruption.needsDiscovery
      ? await runSetupAsync(
        interruption.answers,
        childEnvironment({ home, baseUrl: /** @type {string} */ (fixture?.baseUrl), gate: true }),
      )
      : runSetup(interruption.answers, childEnvironment({ home }));

    assert.equal(result.status, 1, `expected the operational-failure code\n${result.transcript}`);
    assert.equal(result.signal, null, `the process was killed by ${String(result.signal)}`);
    assert.match(result.stdout, interruption.cancellation, 'the prompt states that the step was cancelled');
    assert.match(result.stdout, interruption.stopped, 'the flow states which step stopped it');
    assert.match(
      result.stderr,
      /^setup: the first run was cancelled: .*; this visit ends with the operational-failure code$/mu,
      'the command reports the cancellation as an operational failure, with no stack trace',
    );
    assert.doesNotMatch(result.stderr, /\n\s+at /u, 'no stack trace is printed');
    assertPlainText(result.transcript, 'the transcript of an interrupted first run');
    assertNothingPartial(home, { step: interruption.step, credential: interruption.credential });
  });
}

test('a standard input that is not a terminal and carries nothing exits 1, asks nothing and names the command to run', (t) => {
  // RS-TUI-FR-06: printed instructions and a next command, with nothing asked and nothing written. The
  // whole surface has to be in the transcript, because there is no question to scroll back from.
  const { home } = scratchHome(t, 'refused');

  const result = runSetup([], childEnvironment({ home }));

  assert.equal(result.status, 1, `expected exit 1\n${result.transcript}`);
  assert.equal(result.signal, null, `the process was killed by ${String(result.signal)}`);
  assert.equal(
    result.stdout.split('\n').filter((line) => /^Answer |^Type a value|^What would you|^Which repositories/u.test(line)).length,
    0,
    `no question was asked:\n${result.stdout}`,
  );
  assert.match(result.stderr, /^setup: standard input is not a terminal and carried nothing to answer with/mu);
  assert.match(result.stderr, /^was asked, nothing was read and nothing was written$/mu);
  assert.match(result.stderr, /node src\/cli\.js setup --non-interactive/u, 'the scriptable equivalent is named');
  assert.match(result.stderr, /node src\/cli\.js setup from a/mu, 'the terminal run is named');
  assert.doesNotMatch(result.stderr, /\n\s+at /u, 'no stack trace is printed');
  for (const step of FIRST_RUN_STEPS) {
    assert.ok(result.stdout.includes(step), `the refusal prints the first-run step: ${step}`);
  }
  assertNumberedRows(result.stdout, SETUP_MENU, 'the refusal');
  assertNumberedRows(result.stdout, CONFIG_MANAGER_MENU, 'the refusal');
  assertPlainText(result.transcript, 'the transcript of a refused run');
  assert.equal(existsSync(home), false, 'the refusal created the home directory before it was asked anything');
});

test('no step asks for a pointer, and the surface cannot draw over what was already written', async (t) => {
  // RS-A11Y-06 and RS-TUI-C01 together: what a question asks for is what it printed, and nothing in the
  // modules that draw it can move a cursor, take a mouse or take over the screen.
  const { baseUrl } = await discoveryStub(t);
  const { home } = scratchHome(t, 'no-pointer');

  const result = await runSetupAsync(
    ['y', TOKEN, '2 ', '', '6', 'n'],
    childEnvironment({ home, baseUrl, gate: true }),
  );
  const refused = runSetup([], childEnvironment({ home: path.join(path.dirname(home), 'never-created') }));

  assert.equal(result.status, 0, `expected exit 0\n${result.transcript}`);
  const pointer = POINTER_WORDS.exec(result.transcript) ?? POINTER_WORDS.exec(refused.transcript);
  assert.equal(
    pointer?.[0] ?? null,
    null,
    `a transcript asks for the pointer: ${JSON.stringify(pointer?.[0] ?? null)}`,
  );
  assert.doesNotMatch(result.stdout, /\u001b\[/u, 'the transcript carries no control sequence introducer');

  // Every module the surface is built from, so a module added later is covered by this assertion too.
  const modules = [
    ...readdirSync(path.join(ROOT, 'src', 'tui')).filter((entry) => entry.endsWith('.js'))
      .map((entry) => path.join(ROOT, 'src', 'tui', entry)),
    path.join(ROOT, 'src', 'commands', 'setup.js'),
  ];
  assert.ok(modules.length >= 5, `the surface is at least these modules: ${JSON.stringify(modules)}`);
  for (const module of modules) {
    const source = readFileSync(module, 'utf8');
    const name = path.relative(ROOT, module);
    for (const [, specifier = ''] of source.matchAll(/\bfrom\s+'([^']+)'/gu)) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${name} imports ${specifier}, which is not a node: builtin or a relative path (RS-TUI-C01)`,
      );
    }
    assert.doesNotMatch(source, /\u001b|\\e\[|\\033|\\x1b/u, `${name} writes no escape sequence of its own`);
    assert.doesNotMatch(source, /1049|\?100[0236]|1000;|mouse/u, `${name} names no alternate screen or mouse report`);
  }
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies, undefined, 'package.json declares no runtime dependency (RS-TUI-C01)');
});

for (const interruption of INTERRUPTIONS) {
  test(`Ctrl-C at ${interruption.step} on a real terminal ends the run, restores the terminal and leaves no partial file`, async (t) => {
    // RS-TUI-FR-06 names the terminal mode, and a pipe has none: this is the only case that can show a
    // Ctrl-C arriving through raw mode and the terminal's own echo being handed back afterwards.
    if (SCRIPT_TOOL === null) {
      t.skip('script(1) from util-linux is not installed, so no pseudo-terminal could be allocated');
      return;
    }
    const { baseUrl } = await discoveryStub(t);
    const { home } = scratchHome(t, 'ctrl-c');

    const result = await ptySetup(interruption.steps, { home, baseUrl });

    assert.equal(result.stalledAt, null, `the run stalled before a prompt arrived\n${result.transcript}`);
    assert.equal(result.exitCode, 1, `expected exit 1 from the command itself\n${result.transcript}`);
    assert.match(
      result.transcript,
      /^cancelled: Ctrl-C ended /mu,
      'the prompt reports the interruption in words',
    );
    assert.match(
      result.transcript,
      /^setup: the first run was cancelled: Ctrl-C ended /mu,
      'the command reports the interruption as an operational failure',
    );
    assertPlainText(result.transcript, 'the transcript of an interrupted run on a terminal');
    assert.deepEqual(
      leakedFragments(TOKEN, result.transcript),
      [],
      `the terminal echoed nothing of the token\n${result.transcript}`,
    );
    assertTerminalModeRestored(result, interruption.step);
    assertNothingPartial(home, { step: interruption.step, credential: interruption.credential });
  });
}

test('a first run typed at a real terminal completes with the configuration the loader reads', async (t) => {
  // The masked field's promise is only checkable where a terminal could echo: this types a real token
  // into a real pty and asserts that nothing of it came back, and that the run finished on it.
  if (SCRIPT_TOOL === null) {
    t.skip('script(1) from util-linux is not installed, so no pseudo-terminal could be allocated');
    return;
  }
  const { baseUrl } = await discoveryStub(t);
  const { home } = scratchHome(t, 'typed-at-a-terminal');

  const result = await ptySetup([
    { wait: 'Type q to cancel.', keys: 'y\n' },
    { wait: 'Type q on its own to cancel.', keys: `${TOKEN}\n` },
    { wait: 'Chosen 0 of 3', keys: '2 \n' },
    { wait: 'Chosen 1 of 3', keys: '\n' },
    { wait: 'Collection hour (UTC)', keys: '6\n' },
    { wait: 'Press Enter for the default: no.', keys: 'n\n' },
  ], { home, baseUrl });

  assert.equal(result.stalledAt, null, `the run stalled before a prompt arrived\n${result.transcript}`);
  assert.equal(result.exitCode, 0, `expected exit 0\n${result.transcript}`);
  assert.match(result.transcript, /^accepted 1 of 3: owner\/beta\.$/mu, 'the typed row was the row printed');
  assert.match(result.transcript, /^setup: the first run is complete with 1 enrolled; /mu);
  assert.deepEqual(
    leakedFragments(TOKEN, result.transcript),
    [],
    `a real terminal echoed part of the token\n${result.transcript}`,
  );
  assertPlainText(result.transcript, 'the transcript of a first run typed at a terminal');
  assertTerminalModeRestored(result, 'a completed first run');

  const loaded = loadConfig({ env: { ...process.env, REPO_SIGNAL_HOME: home }, cwd: ROOT });
  assert.deepEqual(loaded.enrolled, ['owner/beta'], 'the row typed at the terminal is the one enrolled');
  assert.equal(loaded.collectionHourUtc, 6);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'credentials.json'), 'utf8')), { token: TOKEN });
  assert.equal(statSync(path.join(home, 'credentials.json')).mode & 0o777, 0o600, 'the credential file is mode 0600');
});
