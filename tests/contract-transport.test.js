import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHttpTransport, GITHUB_API_VERSION, GitHubTransportError } from '../src/github/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVACY = readFileSync(path.join(ROOT, 'docs', 'operations', 'privacy.md'), 'utf8');

/** Recursively list the JavaScript files under a directory. @param {string} dir */
function javascriptFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...javascriptFiles(full));
    else if (entry.endsWith('.js')) files.push(full);
  }
  return files;
}

// RS-GHC-C01: the transport reads its environment variables itself, and the
// privacy note must name each one with its effect and its test-only scope.
test('the privacy note names every transport environment variable with its effect and test-only scope', () => {
  const named = new Set();
  for (const file of javascriptFiles(path.join(ROOT, 'src', 'github'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/REPO_SIGNAL_[A-Z_]+/g)) named.add(match[0]);
  }
  // The base-URL variable is read by the command entry points that build the transport.
  named.add('REPO_SIGNAL_GITHUB_BASE_URL');
  assert.deepEqual([...named].sort(), ['REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT', 'REPO_SIGNAL_GITHUB_BASE_URL']);
  for (const variable of named) {
    assert.ok(PRIVACY.includes(variable), `docs/operations/privacy.md does not name ${variable}`);
  }
  assert.match(PRIVACY, /REPO_SIGNAL_GITHUB_BASE_URL[\s\S]{0,400}api\.github\.com/, 'the note does not bound REPO_SIGNAL_GITHUB_BASE_URL to api.github.com');
  assert.match(PRIVACY, /REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT[\s\S]{0,400}127\.0\.0\.1/, 'the note does not bound the gate to a 127.0.0.1 loopback origin');
  assert.match(PRIVACY, /test suite/, 'the note does not state the variables exist for tests');
  assert.match(PRIVACY, /config\.json/, 'the note does not state the variables are not settable from config.json');
});

// RS-C02: the only host the note permits the product to contact is api.github.com.
test('the only host the privacy note allows is api.github.com', () => {
  const hosts = new Set();
  for (const match of PRIVACY.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) hosts.add(match[1]);
  for (const match of PRIVACY.matchAll(/`((?:[a-z0-9-]+\.)+[a-z]{2,})`/g)) hosts.add(match[1]);
  assert.ok(hosts.has('api.github.com'), 'the note names no permitted host at all');
  for (const host of hosts) {
    // File names and paths match the host shape; only bare domain names count.
    if (/\.(json|js|md|sqlite3?|bak|toml|ya?ml|html|css|svg|png|txt|mjs|cjs|lock)$/.test(host)) continue;
    assert.ok(
      host === 'api.github.com' || host === '127.0.0.1' || host === 'www.github.com',
      `docs/operations/privacy.md names a host other than api.github.com: ${host}`,
    );
  }
  // The doc links to itself and GitHub docs only as references; a granted host must be explicit.
  assert.match(PRIVACY, /Only (that host|that host\.)|api\.github\.com`. Only that host|Only `api\.github\.com`/);
});

// The privacy note records the API version header the transport sends, and both
// must equal the exported constant that owns it (docs/features/github-api-client.md).
test('the API version header in the privacy note equals GITHUB_API_VERSION in src/github/http.js', () => {
  const header = readFileSync(path.join(ROOT, 'src', 'github', 'http.js'), 'utf8');
  assert.match(header, /'X-GitHub-Api-Version': GITHUB_API_VERSION/, 'the transport no longer sends the pinned version constant');
  const recorded = PRIVACY.match(/X-GitHub-Api-Version: ([0-9-]+)/);
  assert.ok(recorded, 'docs/operations/privacy.md does not record the X-GitHub-Api-Version value');
  assert.equal(recorded[1], GITHUB_API_VERSION, 'the version the privacy note records disagrees with GITHUB_API_VERSION');
});

// RS-GHC-C01: the loopback gate exists for tests and cannot widen the product to
// any real host, so a non-loopback base URL is refused even with the gate set.
test('the loopback gate is refused for a non-loopback base URL', async (t) => {
  const previous = process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  t.after(() => {
    if (previous === undefined) delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
    else process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = previous;
  });
  process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = '1';
  let calls = 0;
  const transport = createHttpTransport({
    credentialProvider: { getToken: () => 'github_pat_FAKE_TEST_ONLY' },
    baseUrl: 'https://api.github.com.evil.test/',
    fetch: async () => { calls++; return new Response(); },
  });
  await assert.rejects(transport.get('/repos/example/repo'), (error) => {
    assert.ok(error instanceof GitHubTransportError);
    assert.equal(error.code, 'ERR_TRANSPORT_HOST');
    return true;
  });
  assert.equal(calls, 0, 'fetch ran even though the gate was used with a non-loopback base URL');
});

// Neither variable is settable from config.json: the schema must not read them.
test('config.json does not set the transport variables', () => {
  const schema = readFileSync(path.join(ROOT, 'src', 'config', 'schema.js'), 'utf8');
  assert.ok(!schema.includes('REPO_SIGNAL_GITHUB_BASE_URL'), 'the configuration schema reads REPO_SIGNAL_GITHUB_BASE_URL');
  assert.ok(!schema.includes('REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT'), 'the configuration schema reads REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT');
});
