/**
 * The first-run setup flow, driven the way a person drives it.
 *
 * Every test here writes its answers to a stream the test owns and reads back
 * everything the flow wrote, so no test needs a terminal and no test can pass on a
 * transcript nobody read. The home is temporary, the GitHub stub is a loopback
 * server behind `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT`, and the token is an obviously
 * fake token-shaped string, so an assertion that no part of it reached the output
 * means something.
 *
 * The assertions that matter are the ones a transcript cannot hide: that the written
 * configuration loads through the existing loader rather than through anything the
 * flow wrote itself, that an empty selection is refused instead of saved as an empty
 * enrolment, that the token exists only in the 0600 credential file, that a home that
 * already holds something is detected before the first write, and that the offered
 * collection prints the summary line the collect command prints for the same home.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig, parseConfig } from '../src/config/load.js';
import { redact } from '../src/credentials/redact.js';
import { TRAFFIC_PERMISSION } from '../src/supervision/errors.js';
import { FIRST_RUN_STEPS, runFirstRun } from '../src/tui/setup-wizard.js';
import { createStubGitHub } from './helpers/stub-github-server.mjs';
import { starHistory } from './helpers/star-history.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
const TOKEN = 'ghp_' + 'OBVIOUSLY_FAKE_FIRST_RUN_TOKEN';
const TOKEN_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/u;
const ESCAPE = /\u001b/u;
const PLACEHOLDER = 'REPLACE_WITH_YOUR_GITHUB_TOKEN';

const LISTING = [
  { full_name: 'owner/alpha', visibility: 'private', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/beta', visibility: 'public', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/gamma', visibility: 'public', permissions: { admin: false, push: false, pull: true } },
];

const WINDOW = Array.from({ length: 14 }, (_entry, index) => {
  const day = Date.parse('2026-09-19T00:00:00Z') + index * 86_400_000;
  return new Date(day).toISOString().slice(0, 10);
});

/**
 * Script every endpoint a first run can reach: the discovery listing, and the
 * resolution, traffic and backfill endpoints the collect command needs for the
 * repository the flow enrolls.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 */
function scriptGitHub(stub) {
  stub.route('GET /user/repos*', { json: LISTING });
  stub.route('GET /repos/:owner/:name', (request) => {
    const [owner, name] = request.path.slice('/repos/'.length).split('/');
    return {
      json: {
        id: 4242,
        name,
        full_name: `${owner}/${name}`,
        owner: { login: owner, type: 'User' },
        stargazers_count: 3,
        forks_count: 1,
        watchers_count: 3,
      },
    };
  });
  const entries = WINDOW.map((day, index) => ({ day, count: index + 1, uniques: 1, views: index + 20 }));
  /** @param {string} timestamp */
  const day = (timestamp) => ({ timestamp: `${timestamp}T00:00:00Z` });
  stub.route('GET /repos/:owner/:name/traffic/clones', () => ({
    json: {
      count: entries.reduce((sum, entry) => sum + entry.count, 0),
      uniques: entries.reduce((sum, entry) => sum + entry.uniques, 0),
      clones: entries.map((entry) => ({ ...day(entry.day), count: entry.count, uniques: entry.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/views', () => ({
    json: {
      count: entries.reduce((sum, entry) => sum + entry.views, 0),
      uniques: entries.reduce((sum, entry) => sum + entry.uniques, 0),
      views: entries.map((entry) => ({ ...day(entry.day), count: entry.views, uniques: entry.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/popular/referrers', () => ({ json: [] }));
  stub.route('GET /repos/:owner/:name/traffic/popular/paths', () => ({ json: [] }));
  stub.route('GET /repos/:owner/:name/stargazers/history*', () => ({ json: starHistory(6) }));
  stub.route('GET /repos/:owner/:name/stats/commit_activity', () => ({
    json: [{ week: 1_789_000_000, total: 3, days: [0, 0, 0, 3, 0, 0, 0] }],
  }));
  stub.route('GET /repos/:owner/:name/stats/participation', () => ({ json: { all: [4, 2], owner: [3, 1] } }));
}

/**
 * @typedef {object} FirstRunFixture
 * @property {string} directory Working directory handed to the flow.
 * @property {string} home
 * @property {string} configPath
 * @property {string} credentialsPath
 * @property {NodeJS.ProcessEnv} env The environment the existing modules read.
 * @property {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 * @property {(answers: string[], options?: { saveCredentials?: (request: { credentialsPath: string, token: string }) => void, env?: NodeJS.ProcessEnv }) => Promise<{ outcome: import('../src/tui/setup-wizard.js').FirstRunOutcome, output: string }>} drive
 */

/**
 * A temporary empty home, a loopback GitHub stub and a `drive` that runs the flow
 * with scripted answers. The local-transport gate is set on the real process
 * environment because that is the gate the transport reads; it is restored after.
 * @param {import('node:test').TestContext} t
 * @param {{ configuration?: string|null, credentials?: string|null }} [existing] Files the home already holds.
 * @returns {Promise<FirstRunFixture>}
 */
async function fixture(t, existing = {}) {
  const previousGate = process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  t.after(() => {
    if (previousGate === undefined) delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
    else process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = previousGate;
  });
  process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = '1';

  const directory = mkdtempSync('/tmp/opencode/repo-signal-first-run-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, 'config.json');
  const credentialsPath = path.join(home, 'credentials.json');
  if (existing.configuration !== undefined && existing.configuration !== null) {
    writeFileSync(configPath, existing.configuration, { mode: 0o600 });
  }
  if (existing.credentials !== undefined && existing.credentials !== null) {
    writeFileSync(credentialsPath, existing.credentials, { mode: 0o600 });
  }

  const stub = createStubGitHub({ token: TOKEN });
  t.after(() => stub.stop());
  scriptGitHub(stub);
  const baseUrl = await stub.start();
  const env = {
    ...process.env,
    REPO_SIGNAL_HOME: home,
    REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: '1',
    REPO_SIGNAL_GITHUB_BASE_URL: baseUrl,
  };

  /**
   * @param {string[]} answers
   * @param {{ saveCredentials?: (request: { credentialsPath: string, token: string }) => void, env?: NodeJS.ProcessEnv }} [options]
   * @returns {Promise<{ outcome: import('../src/tui/setup-wizard.js').FirstRunOutcome, output: string }>}
   */
  const drive = async (answers, options = {}) => {
    /** @type {string[]} */
    const chunks = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const outcome = await runFirstRun({
      input: Readable.from([answers.map((answer) => `${answer}\n`).join('')]),
      output,
      env: options.env ?? env,
      cwd: directory,
      ...(options.saveCredentials === undefined ? {} : { saveCredentials: options.saveCredentials }),
    });
    return { outcome, output: chunks.join('') };
  };

  return { directory, home, configPath, credentialsPath, env, stub, drive };
}

/**
 * The answers for a complete first run: agree to the templates, type the token,
 * toggle row 2 and accept the selection, set the hour, then accept or decline the
 * first collection. Every question after the selection has to be answered, because a
 * cancellation is the one answer that ends the run.
 * @param {{ collect?: boolean, hour?: string }} [options]
 * @returns {string[]}
 */
function completingAnswers(options = {}) {
  return ['y', TOKEN, '2 ', '', options.hour ?? '6', options.collect === true ? 'y' : 'n'];
}

/**
 * Every six-character fragment of a secret that reached the output.
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
 * The summary line a collection printed, with the two fields that are per-run facts
 * by design replaced, so two runs of the same home can be compared field by field.
 * @param {string} output
 * @returns {string}
 */
function summaryLine(output) {
  const line = output.split('\n').find((candidate) => candidate.startsWith('summary '));
  assert.ok(line !== undefined, `a summary line is printed:\n${output}`);
  return line
    .replace(/run=\S+/u, 'run=<identifier>')
    .replace(/duration_ms=\d+/u, 'duration_ms=<duration>');
}

/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {string} [against] A second home carrying the same configuration and credential, so the
 *   command collects over an archive nothing has written yet rather than revising the flow's run.
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string }>}
 */
async function spawnCollect(home, env, cwd, against = home) {
  const child = spawn(process.execPath, [CLI, 'collect'], {
    cwd,
    env: { ...env, REPO_SIGNAL_HOME: against, NODE_OPTIONS: '' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.on('close', resolve));
  return { status, stdout, stderr };
}

test('the whole first run writes a configuration the existing loader reads back', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(completingAnswers());

  assert.deepEqual(outcome, {
    status: 'completed', exitCode: 0, message: 'the first run completed', enrolled: ['owner/beta'],
  });
  // The flow's own report of the resolved home comes before anything was written.
  assert.match(output, new RegExp(`home: ${f.home.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
  assert.match(output, /configuration: not present at/);
  // The saved document is read by the loader that owns it, not by the flow.
  assert.deepEqual(parseConfig(readFileSync(f.configPath, 'utf8')).enrolled, ['owner/beta']);
  const loaded = loadConfig({ env: f.env, cwd: f.directory });
  assert.deepEqual(loaded.enrolled, ['owner/beta']);
  assert.equal(loaded.collectionHourUtc, 6);
  assert.deepEqual(loaded.denyList, []);
  assert.deepEqual(loaded.enabled, { 'owner/beta': true });
  assert.equal(statSync(f.configPath).mode & 0o777, 0o600, 'the configuration is written at mode 0600');
  // The states the flow reports are words: the discovery count, the selection and the
  // configuration check's own lines are all there to be read.
  assert.match(output, /discovery: 3 repositories reachable with this token/u);
  // Each repository is stated in discovery's own words before it becomes a numbered row.
  assert.match(output, /^owner\/gamma visibility=public enrolled=no administration-read=no$/mu);
  assert.match(output, /^  1\) owner\/alpha - not selected$/mu);
  assert.match(output, /^  3\) owner\/gamma - not selected$/mu);
  assert.match(output, /row 2 \(owner\/beta\) is now selected/u);
  assert.match(output, /accepted 1 of 3: owner\/beta/u);
  assert.match(output, /configuration: read back through the existing loader with 1 enrolled/u);
  assert.match(output, /^configuration ok: /mu);
  assert.match(output, /^credentials ok: /mu);
  assert.match(output, /^config check: ok$/mu);
  // Declining the first collection is a stated choice, not a silent end.
  assert.match(output, /first collection: skipped; nothing was collected, and the collection made no request/u);
  // The flow claims no schedule: it set a value in a file and says who owns the schedule.
  assert.match(output, /This flow installs no schedule/u);
  assert.doesNotMatch(output, /installed a schedule|scheduled for|schedule created/u);
  assert.doesNotMatch(output, ESCAPE, 'no line the flow wrote carries an escape sequence');
});

test('the token reaches the credential file at mode 0600 and no captured output holds any part of it', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(completingAnswers());

  assert.equal(outcome.status, 'completed');
  assert.equal(statSync(f.credentialsPath).mode & 0o777, 0o600, 'the credential file is written at mode 0600');
  assert.deepEqual(JSON.parse(readFileSync(f.credentialsPath, 'utf8')), { token: TOKEN });
  assert.deepEqual(leakedFragments(TOKEN, output), [], `no fragment of the token reached the transcript:\n${output}`);
  assert.doesNotMatch(output, TOKEN_SHAPE);
  for (const line of output.split('\n').filter((candidate) => candidate !== '')) {
    assert.equal(redact(line), line, `every written line passes the redaction helper unchanged: ${line}`);
  }
  // What the transcript says is that a token was stored, never what it was.
  assert.match(output, /credential: a token was stored at .*credentials\.json \(mode 0600\)/u);
  assert.match(output, /Nothing typed here is echoed/u);
  // The permission the token needs is named in the prompt itself, in the words the
  // supervision module already uses for it rather than a second spelling.
  assert.ok(
    output.includes(TRAFFIC_PERMISSION),
    `the token prompt names ${TRAFFIC_PERMISSION}:\n${output}`,
  );
  assert.match(output, /^GitHub token: paste a fine-grained personal access token/mu);
});

test('a selection with nothing chosen is refused and no configuration is written', async (t) => {
  const f = await fixture(t);
  // 'n' clears the whole list, an empty line then tries to accept nothing, and the
  // operator cancels the question the refusal sent them back to.
  const { outcome, output } = await f.drive(['y', TOKEN, 'n', '', 'q']);

  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.exitCode, 1);
  assert.match(output, /refused: nothing is chosen/u);
  assert.match(output, /no configuration was written/u);
  assert.doesNotMatch(output, /configuration: written at/u);
  // The refused selection was not saved as an empty enrolment. The only configuration
  // on disk is the template the initialiser wrote, which the loader reads as empty.
  assert.deepEqual(parseConfig(readFileSync(f.configPath, 'utf8')).enrolled, []);
  assert.deepEqual(loadConfig({ env: f.env, cwd: f.directory }).enrolled, []);
  // The templates the operator agreed to are the only files the run left behind.
  assert.deepEqual(readdirSync(f.home).sort(), ['config.json', 'credentials.json']);
  assert.equal(JSON.parse(readFileSync(f.credentialsPath, 'utf8')).token, TOKEN);
});

test('declining the templates on a home with no configuration leaves nothing behind at all', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(['n']);

  assert.equal(outcome.status, 'failed');
  assert.match(output, /discovery reads the deny list from config\.json/u);
  assert.match(output, /first run: nothing was written/u);
  assert.deepEqual(readdirSync(f.home), [], 'the home is exactly as empty as it was');
});

test('cancelling the token entry leaves the template credential in place and no archive', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(['y', 'q']);

  assert.equal(outcome.status, 'cancelled');
  assert.match(output, /cancelled: no value was entered, because q cancels/u);
  assert.match(output, /nothing further was written/u);
  // The template the initialiser wrote is untouched: no half-written credential.
  assert.deepEqual(JSON.parse(readFileSync(f.credentialsPath, 'utf8')), { token: PLACEHOLDER });
  assert.deepEqual(readdirSync(f.home).sort(), ['config.json', 'credentials.json']);
  assert.equal(existsSync(path.join(f.home, 'archive.sqlite3')), false);
});

test('an existing home is detected before any write and both templates are preflighted together', async (t) => {
  const credentials = JSON.stringify({ token: 'ghp_' + 'ALREADY_IN_THIS_HOME' });
  const f = await fixture(t, { credentials });
  const before = readFileSync(f.credentialsPath, 'utf8');
  const { outcome, output } = await f.drive(['y']);

  // The report names what was already there, before a single prompt was asked.
  assert.match(output, /credential file: present at .*credentials\.json/u);
  assert.match(output, /configuration: not present at/u);
  assert.ok(
    output.indexOf('credential file: present') < output.indexOf('Write both private templates'),
    'the existing home is reported before the first question',
  );
  // The initialiser refuses because one of the two templates is there, and it had
  // already checked both before writing either: config.json is still absent.
  assert.equal(outcome.status, 'failed');
  assert.match(output, /credentials\.json already exists/u);
  assert.match(output, /nothing further was written/u);
  assert.equal(existsSync(f.configPath), false, 'the absent template was not written after the refusal');
  assert.equal(readFileSync(f.credentialsPath, 'utf8'), before, 'the existing credential file is byte-identical');
  assert.deepEqual(readdirSync(f.home).sort(), ['credentials.json']);
});

test('a home that already has a configuration is reported and left byte-identical', async (t) => {
  const configuration = `${JSON.stringify({ enrolled: ['owner/kept'] }, null, 2)}\n`;
  const f = await fixture(t, { configuration });
  const { outcome, output } = await f.drive(completingAnswers());

  assert.equal(outcome.status, 'failed');
  assert.match(output, /the existing loader accepted it with 1 enrolled/u);
  assert.match(output, /this flow writes nothing/u);
  assert.equal(readFileSync(f.configPath, 'utf8'), configuration, 'the enrolment that was already there is intact');
  assert.equal(existsSync(f.credentialsPath), false);
  assert.deepEqual(readdirSync(f.home), ['config.json']);
});

test('the offered first collection prints the summary line the collect command prints for the same home', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(completingAnswers({ hour: '0', collect: true }));

  assert.equal(outcome.status, 'completed');
  assert.match(output, /owner\/beta ok \d+ days written/u, 'the collected repository line is the command\'s own');
  assert.match(output, /first run: the collection reported success/u);

  // The same configuration and credential, collected by the command the flow delegated
  // to and run as the real entry point, over a home whose archive is still empty. Both
  // runs therefore collect the same data for the first time, which is what makes the
  // two summary lines comparable field by field rather than one being a revision.
  const twin = path.join(f.directory, 'twin-home');
  mkdirSync(twin, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(twin, 'config.json'), readFileSync(f.configPath), { mode: 0o600 });
  writeFileSync(path.join(twin, 'credentials.json'), readFileSync(f.credentialsPath), { mode: 0o600 });
  const direct = await spawnCollect(f.home, f.env, f.directory, twin);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(
    summaryLine(output),
    summaryLine(direct.stdout),
    'the offered collection prints the same summary line the collect command prints for this home',
  );
  assert.match(
    summaryLine(output),
    /repositories=1 ok=1 failed=0 unavailable=0 skipped=0 days=14 rows=56 written=56 revised=0 unchanged=0 snapshots=0 backfilled=1 requests=8/u,
    'the summary is the first-connect one: the days are written and the backfill ran',
  );
  assert.match(summaryLine(output), /status=completed$/u);
  // The flow added no request of its own: the listing happened once, for discovery.
  const listings = f.stub.paths().filter((entry) => entry.startsWith('/user/repos'));
  assert.equal(listings.length, 1, 'the flow listed the repositories once, for discovery');
});

test('a run that declines the collection makes no request beyond the discovery listing', async (t) => {
  const f = await fixture(t);
  const { outcome } = await f.drive(completingAnswers());

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(
    f.stub.paths().filter((entry) => !entry.startsWith('/user/repos')),
    [],
    'no collection endpoint was contacted when the first collection was declined',
  );
  assert.equal(f.stub.requests().filter((request) => request.tokenMatched).length, 1,
    'the single listing request presented the stored credential');
});

test('colour disabled and a dumb terminal change nothing the operator reads', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(completingAnswers(), {
    // NO_COLOR and a dumb terminal are read by the environment the flow hands to the
    // modules it composes, so this is the same run with both set.
    env: { ...f.env, NO_COLOR: '1', TERM: 'dumb' },
  });

  assert.equal(outcome.status, 'completed');
  assert.doesNotMatch(output, ESCAPE, 'no escape sequence is written when colour is disabled');
  assert.doesNotMatch(output, ESCAPE, 'no escape sequence is written on a dumb terminal');
  // Every state the flow reports is a word rather than a colour: the selection, the
  // saved enrolment and the check all read without colour.
  assert.match(output, /row 2 \(owner\/beta\) is now selected/u);
  assert.match(output, /1 enrolled \(owner\/beta\), collection hour 6 UTC/u);
  assert.match(output, /^config check: ok$/mu);
});

test('the hour prompt refuses with the configuration schema its own words and then saves an accepted hour', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(['y', TOKEN, 'a', '', '24', '7', 'n']);

  assert.equal(outcome.status, 'completed');
  // The range belongs to the schema every command reads through, not to the prompt.
  assert.match(output, /refused: Configuration key collectionHourUtc: expected an integer UTC hour from 0 through 23/u);
  assert.match(output, /type a whole hour from 0 through 23, or press Enter for 0/u);
  assert.match(output, /accepted\./u);
  assert.equal(loadConfig({ env: f.env, cwd: f.directory }).collectionHourUtc, 7);
  assert.match(output, /collection hour 7 UTC/u);
});

test('an empty answer to the hour question takes the stated default', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(['y', TOKEN, 'a', '', '', 'n']);

  assert.equal(outcome.status, 'completed');
  assert.deepEqual(loadConfig({ env: f.env, cwd: f.directory }).enrolled, ['owner/alpha', 'owner/beta', 'owner/gamma']);
  assert.equal(loadConfig({ env: f.env, cwd: f.directory }).collectionHourUtc, 0);
  assert.match(output, /accepted 3 of 3: owner\/alpha, owner\/beta, owner\/gamma/u);
  assert.match(output, /collection hour 0 UTC/u);
});

test('cancelling the first-collection question leaves the saved configuration in place', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(['y', TOKEN, '2 ', '', '0', 'q']);

  // The write already happened and the check already passed, so a cancellation at the
  // last question reports both facts rather than pretending nothing was done.
  assert.deepEqual(outcome, {
    status: 'cancelled', exitCode: 1, message: 'q cancels, so the default was not taken either.', enrolled: ['owner/beta'],
  });
  assert.match(output, /^config check: ok$/mu);
  assert.match(output, /the configuration is saved and checked/u);
  assert.deepEqual(loadConfig({ env: f.env, cwd: f.directory }).enrolled, ['owner/beta']);
  assert.deepEqual(f.stub.paths().filter((entry) => !entry.startsWith('/user/repos')), []);
});

test('a credential writer that fails does not put the token on any surface', async (t) => {
  const f = await fixture(t);
  const { outcome, output } = await f.drive(['y', TOKEN], {
    saveCredentials: ({ credentialsPath, token }) => {
      // A writer that fails the way a full disk would, with the token inside the
      // failure, is the case that must still reach the operator as a redacted line.
      assert.equal(credentialsPath, f.credentialsPath);
      throw new Error(`the disk refused ${token}`);
    },
  });

  assert.equal(outcome.status, 'failed');
  assert.match(output, /credential: not written: the disk refused \[REDACTED\]/u);
  assert.deepEqual(leakedFragments(TOKEN, output), [], `the failed writer leaked the token:\n${output}`);
  // No enrolment was saved and no listing was made: the credential never reached the
  // file discovery reads, so the flow stopped before it could ask GitHub anything.
  assert.deepEqual(parseConfig(readFileSync(f.configPath, 'utf8')).enrolled, []);
  assert.deepEqual(f.stub.paths(), []);
});

test('the module names the steps it runs so the command help cannot drift from them', () => {
  assert.ok(FIRST_RUN_STEPS.length >= 8, 'the flow states at least the eight steps it asks');
  assert.deepEqual(
    FIRST_RUN_STEPS.filter((step) => step === ''),
    [],
    'no step is blank',
  );
  assert.equal(new Set(FIRST_RUN_STEPS).size, FIRST_RUN_STEPS.length, 'no step is stated twice');
  assert.match(FIRST_RUN_STEPS[0], /State the resolved home/u);
  assert.match(FIRST_RUN_STEPS.at(-1) ?? '', /collect command/u);
});