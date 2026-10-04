import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseConfig } from '../src/config/load.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
const TOKEN = 'ghp_' + 'OBVIOUSLY_FAKE_DISCOVER_TOKEN';
const TOKEN_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/;

const LISTING = [
  { full_name: 'owner/enrolled', visibility: 'private', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/fresh', visibility: 'public', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'owner/denied', visibility: 'public', permissions: { admin: true, push: true, pull: true } },
  { full_name: 'org/team-repo', visibility: 'private', permissions: { admin: false, push: false, pull: true } },
];

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const directory = mkdtempSync('/tmp/opencode/repo-signal-discover-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const configPath = path.join(home, 'config.json');
  const credentialsPath = path.join(home, 'credentials.json');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configText = JSON.stringify({ enrolled: ['owner/enrolled'], denyList: ['owner/denied'] }, null, 2);
  writeFileSync(configPath, configText, { mode: 0o600 });
  writeFileSync(credentialsPath, JSON.stringify({ token: TOKEN }), { mode: 0o600 });

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/user/repos')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(LISTING));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/`;

  const run = async (/** @type {string[]} */ args) => {
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve) => child.on('close', resolve));
    return { status, stdout, stderr };
  };
  return { directory, home, configPath, configText, run };
}

/** Extract the fenced configuration block printed by discover. @param {string} stdout */
function fencedBlock(stdout) {
  const lines = stdout.split('\n');
  const start = lines.indexOf('```');
  const end = lines.indexOf('```', start + 1);
  assert.ok(start !== -1 && end !== -1, 'a fenced block is printed');
  return lines.slice(start + 1, end).join('\n');
}

test('discover lists reachable repositories and prints a loader-accepted block', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['discover']);
  
  assert.equal(result.status, 0, String(result.stderr));
  assert.doesNotMatch(result.stdout + result.stderr, TOKEN_SHAPE);
  // The table marks each repository, including the already-enrolled one.
  assert.match(result.stdout, /owner\/enrolled visibility=private enrolled=yes administration-read=yes/);
  assert.match(result.stdout, /owner\/fresh visibility=public enrolled=no administration-read=yes/);
  assert.match(result.stdout, /org\/team-repo visibility=private enrolled=no administration-read=no/);
  // The deny-listed repository is absent from both the table and the printed lines.
  assert.ok(!result.stdout.includes('owner/denied'));
  // The fenced block loads through the configuration loader without edits.
  const block = fencedBlock(result.stdout);
  const parsed = parseConfig(block);
  assert.deepEqual(parsed.enrolled, ['owner/fresh', 'org/team-repo']);
  const altHome = path.join(f.directory, 'alt-home');
  mkdirSync(altHome, { recursive: true });
  writeFileSync(path.join(altHome, 'config.json'), block, { mode: 0o600 });
  const loaded = loadConfig({ env: { ...process.env, REPO_SIGNAL_HOME: altHome }, cwd: f.directory });
  assert.deepEqual(loaded.enrolled, ['owner/fresh', 'org/team-repo']);
  // Discovery is read-only: the configuration file is byte-identical.
  assert.equal(readFileSync(f.configPath, 'utf8'), f.configText);
});

test('discover --json prints repositories and configLines for piping', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['discover', '--json']);
  assert.equal(result.status, 0, String(result.stderr));
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.repositories));
  assert.ok(Array.isArray(parsed.configLines));
  assert.equal(parsed.repositories.length, 3);
  const fresh = parsed.repositories.find((/** @type {any} */ repo) => repo.name === 'owner/fresh');
  assert.equal(fresh.enrolled, false);
  assert.equal(fresh.administrationRead, true);
  assert.ok(!result.stdout.includes('owner/denied'));
  const document = parsed.configLines.join('\n');
  assert.deepEqual(parseConfig(document).enrolled, ['owner/fresh', 'org/team-repo']);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.configText);
});

test('discover --include-organizations is passed through to the listing request', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['discover', '--include-organizations']);
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(result.stdout, /org\/team-repo/);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.configText);
});

test('discover --help is refused and points at the registry help', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['discover', '--help']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /node src\/cli\.js --help/);
  assert.ok(!result.stderr.includes('discover --help'),
    'the message no longer names the invocation it rejects');
  assert.equal(readFileSync(f.configPath, 'utf8'), f.configText);
});

test('discover is a usage error for unknown flags and reaches no host without the gate', async (t) => {
  const f = await fixture(t);
  const unknown = await f.run(['discover', '--bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Usage:/);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.configText);
});
