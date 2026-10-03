import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../src/collect/traffic.js';
import { calendarDays, upsertDayFact } from '../src/db/day-series-repo.js';
import { appendRun, openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';
import { escapeText } from '../src/server/html.js';
import { recordSuccess } from '../src/supervision/repo-state-reporter.js';

/**
 * The `serve` command, driven the way a maintainer reaches it: by spawning the
 * process entry point. An import would prove the function; only a spawn proves the
 * registry entry, the flag parsing, the usage path, the exit codes and the URL the
 * command reports.
 *
 * Every fixture gets its own temporary home outside the work tree, its own migrated
 * archive written through the product's own writes, and a child process that is
 * always signalled at the end of the test. The only host any of these processes
 * listens on is its own loopback server; the only request this file makes is to the
 * URL the command printed.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');

const OWNER = 'maintainer';
const NAME = 'archive';
const DAY_MS = 86_400_000;
/** The number of traffic days the seed writes, ending on the day the command resolves to. */
const SEEDED_DAYS = 5;
const RUN_ONE = '2026-09-20T06:00:00.000Z';

/** A token-shaped string nobody could mistake for a real credential. */
const TOKEN_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/;

/**
 * @typedef {object} SpawnResult
 * @property {number|null} status Exit code, or null when a signal ended the child.
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * A temporary home, outside every work tree, at mode 0700 exactly as the product
 * creates it.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ home: string, databasePath: string, root: string }}
 */
function temporaryHome(t) {
  const { root } = unusedHome(t);
  const home = path.join(root, 'home');
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: home } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700, 'the home directory is held at 0700');
  assert.notEqual(path.dirname(paths.home), ROOT, 'the home is outside the work tree');
  return { home: paths.home, databasePath: paths.databasePath, root };
}

/**
 * A temporary root that holds no home yet, for asserting that a run which never
 * reaches the command body creates nothing.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ root: string, home: string }}
 */
function unusedHome(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-serve-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home: path.join(root, 'home') };
}

/**
 * The UTC day the command resolves a bound-less route to. It is read the same way
 * the command reads it, so the seeded days fall inside the window the page states.
 *
 * @returns {string}
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The stored traffic days ending today, oldest first.
 * @param {string} last
 * @param {number} count
 * @returns {string[]}
 */
function seededDays(last, count) {
  const end = Date.parse(`${last}T00:00:00.000Z`);
  return Array.from({ length: count }, (unused, index) =>
    new Date(end - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10));
}

/**
 * Seed one enrolled repository with collected traffic over the days ending today,
 * through the product's own writes: the identity through the repository upsert, the
 * day facts through the day-series upsert, and the collection state through the
 * supervision recorder.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ home: string, databasePath: string, root: string }} f
 * @returns {Promise<void>}
 */
async function seedOneRepository(t, f) {
  const db = await openArchive(f.databasePath);
  t.after(() => db.close());
  const days = seededDays(today(), SEEDED_DAYS);
  const collectedAt = new Date().toISOString();
  upsertRepository(db, { id: 1, owner: OWNER, name: NAME, lastSeenAt: collectedAt, enrolled: 1 });
  appendRun(db, { id: 'run-1', startedAt: RUN_ONE });
  withTransaction(db, () => {
    days.forEach((day, index) => {
      for (const [metric, value] of /** @type {Array<[string, number]>} */ ([
        [CLONES_METRIC, 10 + index],
        [UNIQUE_CLONERS_METRIC, 1 + (index % 3)],
        [VIEWS_METRIC, 100 + index],
        [UNIQUE_VISITORS_METRIC, 20 + index],
      ])) {
        upsertDayFact(db, {
          repositoryId: 1, metric, granularity: 'day', day, value, source: 'collected', collectedAt,
        });
      }
    });
  });
  recordSuccess({ db, repositoryId: 1, collectedAt });
}

/**
 * Run the entry point and wait for it to exit.
 *
 * @param {string[]} args
 * @param {object} options
 * @param {import('node:test').TestContext} options.t
 * @param {Record<string, string>} [options.env]
 * @returns {Promise<SpawnResult>}
 */
function runCli(args, { t, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: path.dirname(CLI),
      env: { ...process.env, NODE_OPTIONS: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * Start `serve`, wait for the URL it reports, and hand back the running child so the
 * caller can request the page and then stop it. A command that never prints a URL
 * fails loudly instead of hanging the suite.
 *
 * @param {import('node:test').TestContext} t
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, url: string, stdout: () => string }>}
 */
function startServe(t, args, env = {}) {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], {
    cwd: path.dirname(CLI),
    env: { ...process.env, NODE_OPTIONS: '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const printed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`serve printed no listening URL within 10s; stdout was ${stdout} and stderr was ${stderr}`));
    }, 10_000);
    child.stdout.on('data', () => {
      const match = /^serve listening on (http:\/\/127\.0\.0\.1:\d+)$/m.exec(stdout);
      if (match === null) return;
      clearTimeout(timer);
      resolve(/** @type {string} */ (match[1]));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited with ${code} before it reported a URL; stdout was ${stdout} and stderr was ${stderr}`));
    });
  });

  return /** @type {Promise<any>} */ (printed).then((/** @type {string} */ url) => ({
    child,
    url,
    stdout: () => stdout,
    stderr: () => stderr,
  }));
}

/**
 * Wait for the child to exit after a signal, so the assertion is about the exit code
 * the command ends with rather than about a kill.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @returns {Promise<number|null>}
 */
function signalAndWait(child, signal) {
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
    child.kill(signal);
  });
}

test('serve is reachable from the process entry point and listed in the usage', async (t) => {
  // Arrange: a temporary home the command may resolve, and nothing else.
  const { home } = temporaryHome(t);

  // Act: the usage listing, and the command's own help.
  const usage = await runCli(['--help'], { t, env: { REPO_SIGNAL_HOME: home } });
  const help = await runCli(['serve', '--help'], { t, env: { REPO_SIGNAL_HOME: home } });

  // Assert: the registry entry reached the composition root, and help exits 0 without
  // starting a server.
  assert.equal(usage.status, 0, `expected exit 0\n${usage.stdout}${usage.stderr}`);
  assert.match(usage.stdout, /^ {2}serve \[--port 0\]\s{2,}Start the read-only dashboard/m,
    `the usage listing does not name the dashboard command; got ${usage.stdout}`);
  assert.equal(help.status, 0, `serve --help must exit 0\n${help.stdout}${help.stderr}`);
  assert.match(help.stdout, /node src\/cli\.js serve \[--port 0\]/, 'help prints the command\'s own usage');
  assert.doesNotMatch(help.stdout, /serve listening on/, 'help does not start a server');
});

test('serve --port 0 starts on loopback, prints the URL it listens on and serves the list page', async (t) => {
  // Arrange: a temporary home with one enrolled repository and its collected traffic.
  const f = temporaryHome(t);
  const seedDay = today();
  await seedOneRepository(t, f);

  // Act: start the command the way an operator would, and read the page it serves.
  const server = await startServe(t, ['--port', '0'], { REPO_SIGNAL_HOME: f.home });
  const response = await fetch(`${server.url}/repos`);
  const body = await response.text();
  const indexResponse = await fetch(`${server.url}/`);
  const indexBody = await indexResponse.text();

  // Assert, in the order the acceptance criteria name.
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'the dashboard is on the loopback interface');
  assert.ok(Number(new URL(server.url).port) > 0, 'the reported port is a real port');
  assert.equal(new URL(server.url).hostname, '127.0.0.1');
  assert.ok(server.stdout().includes(`serve listening on ${server.url}`),
    `the command printed the URL it is listening on; got ${server.stdout()}`);
  assert.ok(server.stdout().includes(`repository list: ${server.url}/repos`),
    'the command names the list page it serves');

  assert.equal(response.status, 200, `the list page must be served; body was ${body.slice(0, 300)}`);
  assert.match(body, /<html lang="en">/, 'the page is served through the product\'s document shell');
  assert.match(body, /<h1>Enrolled repositories<\/h1>/, 'the list page is the page that answers /repos');
  assert.ok(body.includes(escapeText(`${OWNER}/${NAME}`)),
    `the served list names the enrolled repository; got ${body.slice(0, 600)}`);
  assert.match(body, /healthy:/, 'the served page shows the recorded collection state word as text');
  // The stored days really are inside the window the page states, so the page is a
  // reading of the archive rather than an empty table. The two candidate last days are
  // the day the fixture seeded and the day the command ran, so a run that crosses
  // midnight UTC does not fail for that reason alone.
  const window = /Selected range: from ([0-9-]+) to ([0-9-]+)/.exec(body);
  assert.ok(window !== null, `the page states the window it read; got ${body.slice(0, 600)}`);
  assert.ok([seedDay, today()].includes(/** @type {string} */ (window[2])),
    `a bound-less route resolves to the day the command ran; the page says ${window[2]}`);
  assert.equal(calendarDays(window[1], window[2]).length, 14, 'the resolved window covers fourteen days');
  assert.ok(body.includes(`summed over ${SEEDED_DAYS} stored days`), 'the page sums the seeded stored days');
  // The index is served too, and links onward to the list with the window carried.
  assert.equal(indexResponse.status, 200);
  assert.match(indexBody, /<title>RepoSignal<\/title>/);
  assert.ok(indexBody.includes(`href="/repos?from=${window[1]}&amp;to=${window[2]}"`),
    'the index links to the list carrying the resolved window');

  // The security headers are the server's, read off the response.
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null, 'no cross-origin header is sent');
  // No printed line carries credential material, and none names a remote host.
  for (const line of server.stdout().split('\n').filter((entry) => entry !== '')) {
    assert.doesNotMatch(line, TOKEN_SHAPE, `no printed line carries a token-shaped value: ${line}`);
  }

  // Act and assert: a signal ends the command with the success code.
  assert.equal(await signalAndWait(server.child, 'SIGTERM'), 0, 'the command exits 0 when it is signalled');
});

test('serve answers 404 and 400 for an unknown repository and an inverted range', async (t) => {
  // Arrange: the same running dashboard, asked the two refusals.
  const f = temporaryHome(t);
  await seedOneRepository(t, f);
  const server = await startServe(t, ['--port=0'], { REPO_SIGNAL_HOME: f.home });

  // Act: the two requests the route table refuses.
  const unknown = await fetch(`${server.url}/repo/${OWNER}/never-enrolled`);
  const unknownBody = await unknown.text();
  const inverted = await fetch(`${server.url}/repos?from=2026-10-02&to=2026-09-20`);
  const invertedBody = await inverted.text();

  // Assert: each refusal names its cause in words, through the same shell.
  assert.equal(unknown.status, 404);
  assert.ok(unknownBody.includes(escapeText(`${OWNER}/never-enrolled`)),
    `the 404 page names the repository; got ${unknownBody.slice(0, 400)}`);
  assert.equal(inverted.status, 400);
  assert.ok(invertedBody.includes(escapeText('from 2026-10-02 is later than to 2026-09-20')),
    `the 400 page names the inversion; got ${invertedBody.slice(0, 400)}`);
  assert.equal(await signalAndWait(server.child, 'SIGINT'), 0);
});

test('serve serves an empty home with a first-connect state and no configuration file', async (t) => {
  // Arrange: a home that holds no archive, no configuration and no credential. The
  // command migrates the archive itself, and must not need a token to serve a page.
  const f = temporaryHome(t);

  // Act: start it with no flag at all, which is the default an operator runs, and ask
  // for the list.
  const server = await startServe(t, [], { REPO_SIGNAL_HOME: f.home });
  const response = await fetch(`${server.url}/repos`);
  const body = await response.text();

  // Assert: the archive was created and migrated, and the page says in words that
  // nothing is enrolled rather than rendering an empty table.
  assert.equal(response.status, 200, `the list page must be served; body was ${body.slice(0, 300)}`);
  assert.match(body, /No repository is enrolled/, 'the empty state is announced as text');
  assert.equal(body.includes('<table'), false, 'an empty table is not the empty state');
  assert.ok(statSync(f.databasePath).isFile(), 'the command created and migrated the archive itself');
  assert.equal(await signalAndWait(server.child, 'SIGTERM'), 0);
});

test('serve refuses a port it cannot bind, an unknown flag and a repeated flag as usage errors', async (t) => {
  // Arrange: a home that does not exist yet, so a run that never reaches the command
  // body leaves nothing behind.
  const { home } = unusedHome(t);

  // Act and assert: a fixed port this build does not take is refused by name, with the
  // reason and the value that is accepted.
  const fixedPort = await runCli(['serve', '--port', '8080'], { t, env: { REPO_SIGNAL_HOME: home } });
  assert.equal(fixedPort.status, 2, `a port the build cannot bind is a usage error\n${fixedPort.stderr}`);
  assert.match(fixedPort.stderr, /--port 8080 cannot be honoured/, 'the refusal names the flag and its value');
  assert.match(fixedPort.stderr, /127\.0\.0\.1/, 'the refusal names the interface the dashboard binds');
  assert.match(fixedPort.stderr, /Commands:/, 'a usage error prints the usage listing');
  assert.match(fixedPort.stderr, /serve \[--port 0\]/, 'the usage names the real command and its flag');

  // An unknown flag, and a repeated flag, are usage errors too.
  const unknownFlag = await runCli(['serve', '--open'], { t, env: { REPO_SIGNAL_HOME: home } });
  assert.equal(unknownFlag.status, 2);
  assert.match(unknownFlag.stderr, /serve does not know "--open"/);

  const repeated = await runCli(['serve', '--port', '0', '--port=0'], { t, env: { REPO_SIGNAL_HOME: home } });
  assert.equal(repeated.status, 2);
  assert.match(repeated.stderr, /--port twice/);

  // None of them started a listener, and none of them created the home: the home is
  // created by the command body, which a usage error never reaches.
  assert.doesNotMatch(fixedPort.stdout, /serve listening on/);
  assert.throws(() => statSync(home), /ENOENT/, 'a usage error resolved no home');
});

test('serve exits 1 and names the cause when the home cannot be resolved', async (t) => {
  // Arrange: a home that is a git work tree root, which the product refuses to keep
  // its archive in.
  const root = mkdtempSync('/tmp/opencode/repo-signal-serve-refused-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'worktree');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(home, '.git'));

  // Act: run the command against it.
  const result = await runCli(['serve'], { t, env: { REPO_SIGNAL_HOME: home } });

  // Assert: an operational failure, exit 1, with the refusal and the next action.
  assert.equal(result.status, 1, `expected exit 1\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /serve failed/, 'the failure line names the command');
  assert.match(result.stderr, /git repository root/, 'the failure names the cause');
  assert.doesNotMatch(result.stdout, /listening on/, 'nothing was served');
});

test('the command source names no host and reads no credential or configuration', async (t) => {
  // Arrange: the command's own source, read as it is on disk, and a run that only
  // reaches its usage path.
  const { home } = unusedHome(t);
  const result = await runCli(['serve', '--nonsense'], { t, env: { REPO_SIGNAL_HOME: home } });
  const source = readFileSync(path.join(ROOT, 'src', 'commands', 'serve.js'), 'utf8');

  // Act and assert: no outbound transport, no credential read, and no remote host. A
  // dashboard reads the archive and answers on loopback; anything else is a defect
  // this file catches at the source rather than at run time.
  assert.equal(result.status, 2);
  assert.equal(/(^|[^.\w])fetch\s*\(/.test(source), false, 'serve must not call fetch');
  assert.equal(source.includes('node:https'), false, 'serve must not import an outbound transport');
  assert.equal(/https?:\/\/(?!127\.0\.0\.1)/.test(source), false, 'serve names no host but the loopback interface');
  assert.equal(/credentials\/store/.test(source), false, 'serve imports no credential store');
  assert.equal(/loadCredentials|getToken/.test(source), false, 'serve reads no credential');
  assert.equal(/from '\.\.\/config\//.test(source), false, 'serve needs no configuration file to serve a page');
  // Redaction is the exception every command makes: every printed line passes it.
  assert.match(source, /redact/, 'every printed line passes the redaction helper');
  assert.match(source, /createRouter/, 'the router is mounted by the command');
  assert.match(source, /createViewRegistry/, 'the view registry is mounted by the command');
  assert.match(source, /server\.url/, 'the command reports the URL the factory returned');
});