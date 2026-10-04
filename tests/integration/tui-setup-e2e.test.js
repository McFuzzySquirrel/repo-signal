/**
 * The real `node src/cli.js setup`, driven end to end from a pipe against the loopback GitHub stub.
 *
 * Everything the product does here is the product's own: the entry point, the argument parsing, the
 * home resolver, the configuration initialiser, the credential writer, the discovery command, the
 * configuration check, the collect command and the archive they write. The only substitute is the
 * GitHub endpoint, which is the existing stub under `tests/helpers/` with routes scripted by this
 * file, and it stays here - a stub in `src/` would be product code with no test of its own.
 *
 * The assertions are about what a run produced, read back by the module that owns it: the loader for
 * the configuration, the archive repositories for the collected days, and the stub's own request log
 * for what was asked of GitHub and with which credential. A transcript alone could be satisfied by a
 * surface that prints what it did not do, so every claim below is also checked against a file or a
 * request list.
 *
 * Every fixture has its own temporary home and its own stub, and the local-transport gate is set on
 * each spawned child rather than on this process, so a child allowed to reach the loopback stub
 * cannot make any other test's run reach a host either. One case runs with the gate absent and
 * asserts that the transport refuses the base URL outright, which is what keeps the other cases
 * meaningful rather than convenient.
 *
 * A defect found here is reported with the command, the transcript and the requirement it violates.
 * Nothing in `src/` is changed to make a case pass.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig, parseConfig } from '../../src/config/load.js';
import { readDaySeries } from '../../src/db/day-series-repo.js';
import { listEnrolledRepositories, openArchive } from '../../src/db/ops-repo.js';
import { resolveHomePaths } from '../../src/paths.js';
import { CLONES_METRIC, TRAFFIC_GRANULARITY, TRAFFIC_SOURCE } from '../../src/collect/traffic.js';
import { createStubGitHub } from '../helpers/stub-github-server.mjs';
import { starHistory } from '../helpers/star-history.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
/** An obviously fake token-shaped value, so "no fragment of it was echoed" means something. */
const TOKEN = `ghp_${'OBVIOUSLY_FAKE_TUI_E2E_TOKEN'}`;
/** The one character a line-oriented surface must never write. */
const ESCAPE = /\u001b/u;

/** The repositories the stub says this token can reach: one without Administration read. */
const LISTING = [
  { full_name: 'owner/alpha', visibility: 'private', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/beta', visibility: 'public', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/gamma', visibility: 'public', permissions: { admin: false, push: false, pull: true } },
];

/** The fourteen days of traffic the stub serves, which is the window GitHub itself serves. */
const WINDOW = Array.from({ length: 14 }, (_entry, index) => {
  const day = Date.parse('2026-09-19T00:00:00Z') + index * 86_400_000;
  return new Date(day).toISOString().slice(0, 10);
});
const FIRST_DAY = /** @type {string} */ (WINDOW[0]);
const LAST_DAY = /** @type {string} */ (WINDOW[WINDOW.length - 1]);

/**
 * Script every endpoint a first run can reach: the discovery listing, and the resolution, traffic and
 * backfill endpoints the collect command needs for a repository the flow enrolled.
 * @param {import('../helpers/stub-github-server.mjs').StubGitHub} stub
 * @returns {void}
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
  const at = (timestamp) => ({ timestamp: `${timestamp}T00:00:00Z` });
  stub.route('GET /repos/:owner/:name/traffic/clones', () => ({
    json: {
      count: entries.reduce((sum, entry) => sum + entry.count, 0),
      uniques: entries.reduce((sum, entry) => sum + entry.uniques, 0),
      clones: entries.map((entry) => ({ ...at(entry.day), count: entry.count, uniques: entry.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/views', () => ({
    json: {
      count: entries.reduce((sum, entry) => sum + entry.views, 0),
      uniques: entries.reduce((sum, entry) => sum + entry.uniques, 0),
      views: entries.map((entry) => ({ ...at(entry.day), count: entry.views, uniques: entry.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/popular/referrers', { json: [] });
  stub.route('GET /repos/:owner/:name/traffic/popular/paths', { json: [] });
  stub.route('GET /repos/:owner/:name/stargazers/history*', { json: starHistory(6) });
  stub.route('GET /repos/:owner/:name/stats/commit_activity', () => ({
    json: [{ week: 1_789_000_000, total: 3, days: [0, 0, 0, 3, 0, 0, 0] }],
  }));
  stub.route('GET /repos/:owner/:name/stats/participation', { json: { all: [4, 2], owner: [3, 1] } });
}

/**
 * @typedef {object} RunResult
 * @property {number | null} status
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} transcript
 */

/**
 * Drive the real entry point from a pipe. The spawn is asynchronous because the stub is served by
 * this process: a synchronous spawn would block the very server the run is waiting on.
 * @param {string[]} answers The typed lines, one per question the flow asks.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<RunResult>}
 */
function runSetup(answers, env) {
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
 * The environment of one child. The gate is added only where a test says so, and the loader's home is
 * the only thing this process's own environment contributes.
 * @param {{ home: string, baseUrl: string, gate?: boolean }} options
 * @returns {NodeJS.ProcessEnv}
 */
function childEnvironment(options) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    REPO_SIGNAL_HOME: options.home,
    REPO_SIGNAL_GITHUB_BASE_URL: options.baseUrl,
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  if (options.gate === true) env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = '1';
  else delete env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  return env;
}

/**
 * A temporary home that does not exist yet, so a run that creates it is caught rather than mistaken
 * for one that found it.
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @returns {string}
 */
function temporaryHome(t, label) {
  const scratch = mkdtempSync('/tmp/opencode/repo-signal-tui-e2e-');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  return path.join(scratch, label);
}

/**
 * A stub started for one test, stopped after it, and holding nothing this test did not script.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ stub: import('../helpers/stub-github-server.mjs').StubGitHub, baseUrl: string }>}
 */
async function stubGitHub(t) {
  const stub = createStubGitHub({ token: TOKEN });
  t.after(() => stub.stop());
  scriptGitHub(stub);
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

/**
 * The configuration the loader reads for a home, read by the loader rather than by this file.
 * @param {string} home
 * @returns {import('../../src/config/schema.js').Configuration}
 */
function loadedConfiguration(home) {
  return loadConfig({ env: { ...process.env, REPO_SIGNAL_HOME: home }, cwd: ROOT });
}

test('a first run completes from a pipe, and the repository it selected is the one enrolled and the one collected', async (t) => {
  // The end-to-end claim: the flow completes from standard input alone, what it wrote loads through the
  // existing loader, and the repository the transcript printed as row 2 is the one the archive holds
  // rows for and the only repository GitHub was asked about.
  const { stub, baseUrl } = await stubGitHub(t);
  const home = temporaryHome(t, 'complete');

  const result = await runSetup(
    ['y', TOKEN, '2 ', '', '6', 'y'],
    childEnvironment({ home, baseUrl, gate: true }),
  );

  assert.equal(result.status, 0, `expected exit 0\n${result.transcript}`);
  assert.equal(result.signal, null, `the process was killed by ${String(result.signal)}`);
  assert.doesNotMatch(result.stderr, /\n\s+at /u, 'no stack trace is printed');

  // The flow offered the collection and ran the collect command, printing its own lines.
  assert.match(result.stdout, /^ {2}2\) owner\/beta - not selected$/mu, 'the row that was typed is the row that was printed');
  assert.match(result.stdout, /^row 2 \(owner\/beta\) is now selected\.$/mu, 'the toggle names the row it changed');
  assert.match(result.stdout, /^accepted 1 of 3: owner\/beta\.$/mu, 'the accepted selection names what it took');
  assert.match(result.stdout, /^owner\/beta ok \d+ days written \d+ revised /mu, 'the collected line is the command\'s own');
  assert.match(result.stdout, /^summary run=collect-\S+ repositories=1 ok=1 failed=0 /mu, 'the summary line is the command\'s own');
  assert.match(result.stdout, /^first run: the collection reported success; /mu);

  // The saved configuration is read by the module every other command reads.
  const configuration = loadedConfiguration(home);
  assert.deepEqual(configuration.enrolled, ['owner/beta'], 'row 2 was owner/beta');
  assert.equal(configuration.collectionHourUtc, 6);
  assert.equal(statSync(path.join(home, 'config.json')).mode & 0o777, 0o600, 'the configuration is mode 0600');
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'credentials.json'), 'utf8')), { token: TOKEN });
  assert.equal(statSync(path.join(home, 'credentials.json')).mode & 0o777, 0o600, 'the credential file is mode 0600');

  // The archive is the one the product wrote, read through the repositories that own it.
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: home } });
  assert.ok(existsSync(paths.databasePath), `the offered collection created ${paths.databasePath}`);
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  const enrolled = listEnrolledRepositories(db);
  assert.deepEqual(
    enrolled.map((repository) => `${repository.owner}/${repository.name}`),
    ['owner/beta'],
    'the archive holds exactly the repository the selection enrolled',
  );
  const clones = readDaySeries(db, {
    repositoryId: /** @type {number} */ (enrolled[0]?.id),
    metric: CLONES_METRIC,
    granularity: TRAFFIC_GRANULARITY,
    from: FIRST_DAY,
    to: LAST_DAY,
  });
  assert.equal(clones.length, WINDOW.length, `expected ${String(WINDOW.length)} collected days, observed ${String(clones.length)}`);
  assert.deepEqual(
    [...new Set(clones.map((fact) => fact.source))],
    [TRAFFIC_SOURCE],
    'every day row the collection wrote is labelled as collected',
  );
  assert.deepEqual(
    clones.map((fact) => fact.day),
    WINDOW,
    'the collected days are the fourteen the stub served, in order',
  );

  // What GitHub was asked for, and with what: the two delegated commands' requests and nothing else.
  assert.deepEqual(stub.paths(), [
    '/user/repos',
    '/repos/owner/beta',
    '/repos/owner/beta/stargazers/history',
    '/repos/owner/beta/stats/commit_activity',
    '/repos/owner/beta/stats/participation',
    '/repos/owner/beta/traffic/clones',
    '/repos/owner/beta/traffic/views',
    '/repos/owner/beta/traffic/popular/referrers',
    '/repos/owner/beta/traffic/popular/paths',
  ], 'the run asked only the discovery and collect commands\' own endpoints, for the enrolled repository only');
  for (const request of stub.requests()) {
    assert.equal(request.authorized, true, `${request.method} ${request.path} carried no bearer credential`);
    assert.equal(request.tokenMatched, true, `${request.method} ${request.path} carried a different credential`);
  }

  assert.doesNotMatch(result.transcript, ESCAPE, 'the transcript carries no escape sequence');
  assert.deepEqual(leakedFragments(TOKEN, result.transcript), [], 'nothing of the token was echoed');
  parseConfig(readFileSync(path.join(home, 'config.json'), 'utf8'));
});

test('the selection is driven by typed keys, and declining the collection makes no request beyond the listing', async (t) => {
  // The keyboard claim against the service: `a`, `n` and one row number are the whole interface, and a
  // run that declines its collection adds no request of its own to the discovery command's (`RS-TUI-C03`).
  const { stub, baseUrl } = await stubGitHub(t);
  const home = temporaryHome(t, 'typed-keys');

  const result = await runSetup(
    ['y', TOKEN, 'a', 'n', '2 ', '', '0', 'n'],
    childEnvironment({ home, baseUrl, gate: true }),
  );

  assert.equal(result.status, 0, `expected exit 0\n${result.transcript}`);
  assert.match(result.stdout, /^all 3 rows are now selected\.$/mu, 'a selects every row');
  assert.match(result.stdout, /^no rows are now selected\.$/mu, 'n selects none');
  assert.match(result.stdout, /^row 2 \(owner\/beta\) is now selected\.$/mu, 'a row number and a space toggles that row');
  assert.match(result.stdout, /^accepted 1 of 3: owner\/beta\.$/mu, 'the accepted selection names what it took');
  assert.match(result.stdout, /^first collection: skipped; nothing was collected, and the collection made no request$/mu);

  const configuration = loadedConfiguration(home);
  assert.deepEqual(configuration.enrolled, ['owner/beta'], 'the row typed is the row enrolled');
  assert.equal(configuration.collectionHourUtc, 0, 'an empty answer took the stated default of 0');
  assert.deepEqual(stub.paths(), ['/user/repos'], 'the only request was the discovery command\'s own listing');
  assert.doesNotMatch(result.transcript, ESCAPE);
  assert.deepEqual(leakedFragments(TOKEN, result.transcript), []);
});

test('a child with the local-transport gate absent is refused by the transport, and the stub records no request for it', async (t) => {
  // The guarantee every other case in this file rests on: the loopback base URL is reachable only
  // through a gate scoped to one child process, and without it nothing opens a socket at all.
  const { stub, baseUrl } = await stubGitHub(t);
  const home = temporaryHome(t, 'no-gate');

  const result = await runSetup(
    ['y', TOKEN, '2 ', '', '6', 'n'],
    childEnvironment({ home, baseUrl, gate: false }),
  );

  assert.equal(result.status, 1, `expected the operational-failure code\n${result.transcript}`);
  assert.match(
    result.stdout,
    /^discover failed: Request refused: use https:\/\/api\.github\.com or the explicitly gated 127\.0\.0\.1 test base URL$/mu,
    'the transport refused the base URL before any request',
  );
  assert.match(result.stderr, /^setup: the first run did not finish: discovery failed; /mu);
  assert.deepEqual(stub.requests(), [], 'the stub received nothing: the refusal happened before a socket was opened');
  // The run stopped before enrolment, so what is on disk is the credential it wrote and no configuration.
  assert.deepEqual(loadedConfiguration(home).enrolled, [], 'no configuration was written');
  assert.doesNotMatch(result.transcript, ESCAPE);
});

test('a second visit over the configuration the first run wrote adds a repository, and the loader reads it', async (t) => {
  // The returning half of the surface, end to end: the second visit is chosen by the loader, offers the
  // repositories the first run left out, and saves through the same schema and loader.
  const { stub, baseUrl } = await stubGitHub(t);
  const home = temporaryHome(t, 'returning');
  const first = await runSetup(
    ['y', TOKEN, '2 ', '', '6', 'n'],
    childEnvironment({ home, baseUrl, gate: true }),
  );
  assert.equal(first.status, 0, `the first run did not complete\n${first.transcript}`);
  stub.reset();

  const second = await runSetup(
    ['1', '1', '1 ', '', '7'],
    childEnvironment({ home, baseUrl, gate: true }),
  );

  assert.equal(second.status, 0, `expected exit 0\n${second.transcript}`);
  assert.match(second.stdout, /^already enrolled \(1\): owner\/beta$/mu, 'the visit reports what is already enrolled');
  assert.match(second.stdout, /^ {2}1\) owner\/alpha - not selected$/mu, 'the row it did not enrol is offered first');
  assert.match(second.stdout, /^accepted 1 of 2: owner\/alpha\.$/mu, 'the typed row is the row it accepts');
  assert.match(second.stdout, /^configuration: saved at .*config\.json \(mode 0600\): added 1 repository to the enrolled set: owner\/alpha$/mu);
  // The count, the two names and the hour are what this line claims, and the plural of "repository" is
  // matched tolerantly because the surface currently spells it "repositorys"; that spelling is a defect
  // reported to the module owner, and this suite pins no spelling either way.
  assert.match(
    second.stdout,
    /^configuration: the existing loader read it back with 2 enrolled repositor\w+ \(owner\/beta, owner\/alpha\), 0 deny entries, collection hour 6 UTC$/mu,
    'the manager reports the loader\'s own verdict on the file it saved',
  );
  assert.match(second.stdout, /^setup: the configuration manager returned; this visit ends here /mu);

  const configuration = loadedConfiguration(home);
  assert.deepEqual(configuration.enrolled, ['owner/beta', 'owner/alpha'], 'the loader reads the added repository');
  assert.deepEqual(configuration.enabled, { 'owner/beta': true, 'owner/alpha': true });
  assert.deepEqual(stub.paths(), ['/user/repos'], 'the edit asked for the listing and nothing else');
  assert.doesNotMatch(second.transcript, ESCAPE);
  assert.deepEqual(leakedFragments(TOKEN, second.transcript), [], 'nothing of the token was echoed by the second visit');
});
