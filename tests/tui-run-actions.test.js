/**
 * The run-actions menu, driven the way a maintainer drives it.
 *
 * Every test writes its answers to a stream the test owns and reads back everything the menu
 * and the commands it delegated to wrote, so no test needs a terminal and no test can pass on
 * a transcript nobody read. The home is temporary and the GitHub stub is the loopback server
 * behind `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT`, so the only request this menu can make is the one
 * the collect command makes, and every assertion about the absence of a request means something.
 *
 * The assertions that matter are the ones a transcript cannot hide. The collect action has to
 * print the same summary the collect command prints for the same home, which means the archive
 * is put back between the two runs rather than accepting a difference the data explains. Each
 * other action has to print exactly what its command prints and has to make no request at all.
 * The dashboard has to print the address the server reported, and that address has to have
 * answered while the menu was waiting for an answer, because a printed address the server was
 * not listening on is the one lie an operator cannot see through. And a failed action has to
 * return to the menu carrying the command's own message rather than ending the session.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RUN_ACTIONS_MENU, runActions } from '../src/tui/run-actions.js';
import { starHistory } from './helpers/star-history.js';
import { createStubGitHub } from './helpers/stub-github-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
const TOKEN = 'ghp_' + 'OBVIOUSLY_FAKE_RUN_ACTIONS_TOKEN';
const TOKEN_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/;
const ESCAPE = /\u001b/u;

/** Menu rows the module prints, counted from one. */
const COLLECT = '1';
const REPORT = '2';
const HEALTH = '3';
const DASHBOARD = '4';
const LEAVE = '5';

const WINDOW = (() => {
  const last = Date.parse('2026-10-02T00:00:00Z');
  return Array.from({ length: 14 }, (_entry, index) =>
    new Date(last - (13 - index) * 86_400_000).toISOString().slice(0, 10));
})();
const STAR_HISTORY = starHistory(3);
const WEEK_STARTS = [Date.parse('2026-09-14T00:00:00Z') / 1000, Date.parse('2026-09-21T00:00:00Z') / 1000];
const COMMIT_ACTIVITY = WEEK_STARTS.map((week, index) => ({
  week, total: 4 + index, days: [1, 2, 0, 1, 0, 0, 0],
}));
const PARTICIPATION = { all: [10, 12], owner: [3, 4] };
const REFERRERS = [{ referrer: 'example.org', count: 12, uniques: 7 }];
const POPULAR_PATHS = [{ path: '/', title: 'RepoSignal', count: 30, uniques: 18 }];

/**
 * Script the endpoints a collection needs: the lifecycle resolution, the four traffic reads
 * and the three first-connect backfill reads. Every route answers the same fixed payload, so
 * two runs of the same command against the same home make the same requests and see the same
 * answers.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 * @returns {void}
 */
function scriptCollect(stub) {
  stub.route('GET /repos/:owner/:name', (request) => {
    const requested = request.path.slice('/repos/'.length);
    const [owner, name] = requested.split('/');
    return {
      json: {
        id: 1000 + String(name).length,
        name,
        full_name: `${owner}/${name}`,
        owner: { login: owner, type: 'User' },
        stargazers_count: 3,
        forks_count: 1,
        watchers_count: 3,
      },
    };
  });
  const entries = WINDOW.map((day, index) => ({ day, count: index, uniques: 1 + index, views: index + 30 }));
  const total = (/** @type {'count'|'uniques'|'views'} */ which) =>
    entries.reduce((sum, entry) => sum + entry[which], 0);
  const stamp = (/** @type {{day: string}} */ entry) => ({ timestamp: `${entry.day}T00:00:00Z` });
  stub.route('GET /repos/:owner/:name/traffic/clones', () => ({
    json: {
      count: total('count'),
      uniques: total('uniques'),
      clones: entries.map((entry) => ({ ...stamp(entry), count: entry.count, uniques: entry.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/views', () => ({
    json: {
      count: total('views'),
      uniques: total('uniques'),
      views: entries.map((entry) => ({ ...stamp(entry), count: entry.views, uniques: entry.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/popular/referrers', () => ({ json: REFERRERS }));
  stub.route('GET /repos/:owner/:name/traffic/popular/paths', () => ({ json: POPULAR_PATHS }));
  stub.route('GET /repos/:owner/:name/stargazers/history*', () => ({ json: STAR_HISTORY }));
  stub.route('GET /repos/:owner/:name/stats/commit_activity', () => ({ json: COMMIT_ACTIVITY }));
  stub.route('GET /repos/:owner/:name/stats/participation', () => ({ json: PARTICIPATION }));
}

/**
 * @typedef {object} SpawnResult
 * @property {number|null} status
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {object} RunActionsFixture
 * @property {string} directory
 * @property {string} home
 * @property {string} configPath
 * @property {string} databasePath
 * @property {NodeJS.ProcessEnv} env
 * @property {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 * @property {(args: string[]) => Promise<SpawnResult>} runCli Spawn the real entry point against this home.
 * @property {(answers: string[]|NodeJS.ReadableStream, env?: NodeJS.ProcessEnv) => Promise<{outcome: import('../src/tui/run-actions.js').RunActionsOutcome, output: string}>} drive
 * @property {() => () => void} captureArchive Buffer every archive file, returning a function that puts them back.
 */

/**
 * A temporary home, a loopback GitHub stub and two ways to run the same work: the menu driven
 * from a stream of answers, and the real entry point spawned. The local-transport gate is set
 * on the real process environment because that is where the transport reads it on every
 * request, and it is restored afterwards.
 * @param {import('node:test').TestContext} t
 * @param {{ configuration?: string | null }} [existing] What the home holds; `null` writes no configuration at all.
 * @returns {Promise<RunActionsFixture>}
 */
async function fixture(t, existing = {}) {
  const previousGate = process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  t.after(() => {
    if (previousGate === undefined) delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
    else process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = previousGate;
  });
  process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = '1';

  const directory = mkdtempSync('/tmp/opencode/repo-signal-run-actions-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, 'config.json');
  if (existing.configuration !== null) {
    writeFileSync(
      configPath,
      existing.configuration ?? `${JSON.stringify({ enrolled: ['owner/alpha'] }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  writeFileSync(home + '/credentials.json', `${JSON.stringify({ token: TOKEN }, null, 2)}\n`, { mode: 0o600 });

  const stub = createStubGitHub({ token: TOKEN });
  t.after(() => stub.stop());
  scriptCollect(stub);
  const baseUrl = await stub.start();
  const env = {
    ...process.env,
    REPO_SIGNAL_HOME: home,
    REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: '1',
    REPO_SIGNAL_GITHUB_BASE_URL: baseUrl,
  };

  /**
   * @param {string[]} args
   * @returns {Promise<SpawnResult>}
   */
  const runCli = async (args) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: directory,
      env: { ...env, NODE_OPTIONS: '' },
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
   * @param {string[]|NodeJS.ReadableStream} answers One answer per line, or a stream the test
   *   writes to by hand when the timing of an answer matters.
   * @param {NodeJS.ProcessEnv} [driveEnv] Environment to run against, defaulting to this home's.
   * @returns {Promise<{outcome: import('../src/tui/run-actions.js').RunActionsOutcome, output: string}>}
   */
  const drive = async (answers, driveEnv) => {
    /** @type {string[]} */
    const chunks = [];
    const input = Array.isArray(answers)
      ? Readable.from([answers.map((answer) => `${answer}\n`).join('')])
      : answers;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const outcome = await runActions({ input, output, env: driveEnv ?? env, cwd: directory });
    return { outcome, output: chunks.join('') };
  };

  const captureArchive = () => {
    const buffered = readdirSync(home)
      .filter((name) => name.startsWith('archive.sqlite3'))
      .map((name) => ({ name, bytes: readFileSync(path.join(home, name)) }));
    return () => {
      for (const name of readdirSync(home)) {
        if (name.startsWith('archive.sqlite3')) rmSync(path.join(home, name));
      }
      for (const file of buffered) writeFileSync(path.join(home, file.name), file.bytes);
    };
  };

  return { directory, home, configPath, databasePath: path.join(home, 'archive.sqlite3'), env, stub, runCli, drive, captureArchive };
}

/**
 * Wait until text the module is writing has appeared, so a test can act on the moment the
 * server reported its address rather than sleeping and hoping.
 * @param {() => string} read
 * @param {string} expected
 * @param {string} label
 * @returns {Promise<void>}
 */
async function waitForText(read, expected, label) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (read().includes(expected)) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.fail(`${label}: ${JSON.stringify(expected)} never appeared in ${JSON.stringify(read())}`);
}

/**
 * The lines a command printed, with the figures that differ between two readings of one
 * archive named rather than compared: the run identifier, the run's duration and the moment a
 * report was read are different every time, so comparing them would compare nothing.
 * @param {string} text
 * @returns {string[]}
 */
function comparableLines(text) {
  return text.split('\n')
    .filter((line) => line !== '')
    .map((line) => line
      .replace(/^read at \S+/u, 'read at <read-at>')
      .replace(/run=\S+/gu, 'run=<run>')
      .replace(/duration_ms=\d+/gu, 'duration_ms=<duration>'));
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {string} The single summary line a collection printed.
 */
function summaryLine(text, label) {
  const found = text.split('\n').filter((line) => line.startsWith('summary '));
  assert.equal(found.length, 1, `${label}: exactly one summary line; got ${JSON.stringify(text)}`);
  return /** @type {string} */ (found[0])
    .replace(/run=\S+/u, 'run=<run>')
    .replace(/duration_ms=\d+/u, 'duration_ms=<duration>');
}

test('the menu states what it is over, offers the four actions and writes no file', async (t) => {
  const f = await fixture(t);
  const before = readdirSync(f.home).sort();

  const { outcome, output } = await f.drive(['q']);

  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(outcome.actions, 0);
  assert.ok(output.includes(`run actions: ${f.home}\n`), `the menu names the home it is over: ${f.home}`);
  assert.match(output, /^enrolled set \(1\): owner\/alpha$/mu);
  assert.match(output, /^run actions stopped: .*; no action was run$/mu);
  // Every row is printed as text, and every row names the command it runs, so an operator can
  // reproduce an action by hand rather than trusting the menu.
  assert.equal(RUN_ACTIONS_MENU.length, 5);
  for (const label of RUN_ACTIONS_MENU) assert.ok(output.includes(label), `the menu printed: ${label}`);
  assert.ok(output.includes('node src/cli.js collect'), 'the collect action names the command it runs');
  assert.ok(output.includes('node src/cli.js report --repo owner/name'), 'the report action names its command');
  assert.ok(output.includes('node src/cli.js serve'), 'the dashboard action names its command');
  // Which actions can reach the network is stated rather than implied.
  assert.match(output, /^Collect now is the only action that contacts GitHub/mu);
  assert.doesNotMatch(output, ESCAPE, 'no escape sequence reaches the transcript');
  for (const line of comparableLines(output)) {
    assert.doesNotMatch(line, TOKEN_SHAPE, 'no printed line carries a token-shaped value');
  }
  assert.deepEqual(readdirSync(f.home).sort(), before, 'the menu wrote no file');
});

test('leaving the menu with the last row ends the visit with exit 0', async (t) => {
  const f = await fixture(t);

  const { outcome, output } = await f.drive([LEAVE]);

  assert.deepEqual(outcome, {
    status: 'completed',
    exitCode: 0,
    message: 'the run-actions menu returned to the previous menu',
    actions: 0,
    failures: 0,
  });
  assert.match(output, /^run actions: left the menu; no action was run$/mu);
});

test('the collect action prints the same summary the collect command prints for the same home', async (t) => {
  const f = await fixture(t);
  // Arrange: one collection through the entry point, so the archive holds a completed run
  // with its backfill already done, and a copy of the files it left.
  const warm = await f.runCli(['collect']);
  assert.equal(warm.status, 0, warm.stderr);
  const restore = f.captureArchive();

  // Act: the same command from the entry point, then the same command through the menu. The
  // archive is put back between them, because two collections in a row over one home are not
  // two readings of one home: the second finds the first run's facts already written.
  f.stub.reset();
  const direct = await f.runCli(['collect']);
  assert.equal(direct.status, 0, direct.stderr);
  const directRequests = f.stub.paths();

  restore();
  f.stub.reset();
  const { outcome, output } = await f.drive([COLLECT, LEAVE]);

  // Assert: the summary is the command's own, line for line, and the requests are its own too.
  assert.deepEqual(summaryLine(output, 'the menu'), summaryLine(direct.stdout, 'the entry point'));
  assert.deepEqual(f.stub.paths(), directRequests, 'the menu made exactly the requests the command makes');
  assert.match(output, /^owner\/alpha ok 14 days written /mu);
  assert.match(output, /^collect: exited 0; the lines above are the lines node src\/cli\.js collect printed$/mu);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.actions, 1);
  assert.equal(outcome.failures, 0);
  assert.doesNotMatch(output, ESCAPE);
});

test('the report actions print exactly what the report command prints and contact nothing', async (t) => {
  const f = await fixture(t);
  const warm = await f.runCli(['collect']);
  assert.equal(warm.status, 0, warm.stderr);
  f.stub.reset();

  // Arrange: what each report action must reproduce, read from the entry point on this home.
  const directHealth = await f.runCli(['report']);
  const directReport = await f.runCli(['report', '--repo', 'owner/alpha']);
  assert.equal(directHealth.status, 0, directHealth.stderr);
  assert.equal(directReport.status, 0, directReport.stderr);
  f.stub.reset();

  // Act: both report actions through the menu.
  const { outcome, output } = await f.drive([HEALTH, REPORT, '1', LEAVE]);
  const printed = comparableLines(output);

  // Assert: every line each command printed reached the transcript, and neither action asked
  // GitHub for anything - a report reads the archive.
  for (const line of comparableLines(directHealth.stdout)) {
    assert.ok(printed.includes(line), `the health summary printed the report command's line: ${line}`);
  }
  for (const line of comparableLines(directReport.stdout)) {
    assert.ok(printed.includes(line), `the report printed the report command's line: ${line}`);
  }
  assert.equal(f.stub.paths().length, 0, 'neither report action made a request');
  assert.match(output, /^report: exited 0; the lines above are the lines node src\/cli\.js report printed$/mu);
  assert.match(output, /^report: exited 0; the lines above are the lines node src\/cli\.js report --repo owner\/alpha printed$/mu);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.actions, 2);
  assert.doesNotMatch(output, ESCAPE);
});

test('starting the dashboard prints the address the server reported, and stops it to return to the menu', async (t) => {
  const f = await fixture(t);

  // Act: start the dashboard, and hold the answer back so the address is probed while the
  // dashboard is the thing serving. This is the shape of the interaction itself: the operator
  // reads the address, opens it, and only then answers.
  /** @type {string[]} */
  const chunks = [];
  const input = new PassThrough();
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const finished = runActions({ input, output, env: f.env, cwd: f.directory });
  const transcript = () => chunks.join('');
  input.write(`${DASHBOARD}\n`);
  await waitForText(transcript, 'serve listening on', 'the dashboard');

  const url = /serve listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(transcript())?.[1];
  assert.ok(url !== undefined, `the transcript names the address the server reported: ${transcript()}`);

  // The address the menu printed is answering right now, while the menu waits for an answer.
  const probe = await fetch(`${url}/repos`);
  const body = await probe.text();
  assert.equal(probe.status, 200, `the printed address served the list page: ${body.slice(0, 200)}`);
  assert.match(body, /<h1>Enrolled repositories<\/h1>/u);
  assert.match(transcript(), new RegExp(`repository list: ${url}/repos`, 'u'), 'the server\'s own lines are on the record');

  // Answer, and the menu stops the server through the stop path the command owns. The answer
  // to leave the menu follows only once the menu has asked again, because a piped answer that
  // arrives early is consumed by the wrong question.
  input.write('\n');
  await waitForText(transcript, 'What would you like to run?', 'the menu after the dashboard stopped');
  input.write(`${LEAVE}\n`);
  input.end();
  const outcome = await finished;

  // Assert: the port is closed once the menu returned, so the menu did not leave a server
  // behind or claim an address that was never listening.
  assert.match(transcript(), /^dashboard: stopping it and returning to the run menu$/mu);
  assert.match(transcript(), /^serve: exited 0; /mu);
  assert.equal(outcome.status, 'completed');
  assert.equal(f.stub.paths().length, 0, 'the dashboard made no request');
  await assert.rejects(() => fetch(`${url}/repos`), 'the dashboard was stopped before the menu returned');
});

test('a failing action returns to the menu with the command\'s own message and does not end the session', async (t) => {
  // Arrange: a home with no configuration file, so both commands refuse and each says why.
  const f = await fixture(t, { configuration: null });

  // Act: two failing actions and then the row that leaves the menu deliberately.
  const { outcome, output } = await f.drive([COLLECT, HEALTH, LEAVE]);

  // Assert: each refusal is the command's own words, the exit code is the command's own, the
  // menu was offered again after each one, and the visit ended on the operator's own decision.
  assert.match(output, /^collect: no configuration file at .*config\.json$/mu);
  assert.match(output, /^collect: run node src\/cli\.js config init, enroll repositories, then run collect again$/mu);
  assert.match(output, /^collect: exited 1, which is an operational failure; the lines above are the command's own, and this menu is unchanged\. Returning to the run menu\.$/mu);
  assert.match(output, /^report: no configuration file at .*config\.json$/mu);
  assert.match(output, /^report: exited 1, which is an operational failure/mu);
  assert.equal(output.match(/What would you like to run\?/gu)?.length, 3, 'the menu was offered again after each failure');
  assert.deepEqual(outcome, {
    status: 'failed',
    exitCode: 1,
    message: '2 actions reported a failure',
    actions: 2,
    failures: 2,
  });
  assert.doesNotMatch(output, /at Object\.|at Module\.|Error: /u, 'no stack trace reached the transcript');
  assert.doesNotMatch(output, ESCAPE);
  assert.equal(existsSync(f.databasePath), false, 'no archive was created by a refused action');
});

test('a home the resolver refuses is reported before the first prompt is asked', async (t) => {
  const f = await fixture(t);
  // A git work tree root, which the home resolver refuses because the product keeps its
  // archive outside any work tree.
  const worktree = path.join(f.directory, 'worktree');
  mkdirSync(worktree, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(worktree, '.git'));

  const { outcome, output } = await f.drive([LEAVE], { ...f.env, REPO_SIGNAL_HOME: worktree });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exitCode, 1);
  assert.match(output, /^run actions: the home directory could not be resolved: .*\.git entry, so it is a git repository root; /mu);
  assert.match(output, /; no action was run and nothing was written$/mu);
  assert.doesNotMatch(output, /What would you like to run\?/u, 'no question was asked of an unresolvable home');
  assert.deepEqual(readdirSync(worktree), ['.git'], 'nothing was written to the refused home');
});

test('the report action refuses a repository it cannot name, in words', async (t) => {
  const f = await fixture(t, { configuration: `${JSON.stringify({ enrolled: [] }, null, 2)}\n` });

  const empty = await f.drive([REPORT, LEAVE]);
  assert.match(empty.output, /^report: nothing is enrolled, so there is no repository to report on; the health summary reports on an empty enrolled set$/mu);
  assert.equal(empty.outcome.actions, 0, 'a refusal is not an action that ran');

  // A configuration the loader refuses is a different state from an empty enrolment, and the
  // refusal says which module to ask rather than reporting an empty set that is not there.
  const broken = await fixture(t, { configuration: '{ this is not a configuration\n' });
  const refusal = await broken.drive([REPORT, LEAVE]);
  assert.match(
    refusal.output,
    /^report: the configuration could not be read, so no repository was offered and no report was printed; run node src\/cli\.js config check to see what the loader made of it$/mu,
  );
  // The health summary still runs, and reports the same failure the command reports.
  const health = await broken.drive([HEALTH, LEAVE]);
  assert.match(health.output, /^report failed: /mu);
  assert.match(health.output, /^report: exited 1, which is an operational failure/mu);
  assert.equal(health.outcome.failures, 1);
});