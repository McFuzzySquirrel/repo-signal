import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createCredentialProvider } from '../src/github/credential-provider.js';
import { createHttpTransport, GITHUB_API_VERSION, GitHubTransportError } from '../src/github/http.js';

const token = `github_pat_${'FAKE_TEST_ONLY_'.repeat(4)}`;
const source = { getToken: () => token };

/** @param {import('node:test').TestContext} t @param {string | undefined} value */
function localGate(t, value) {
  const previous = process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  t.after(() => {
    if (previous === undefined) delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
    else process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = previous;
  });
  if (value === undefined) delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  else process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = value;
}

/** @param {unknown} error @param {string} code */
function safeError(error, code) {
  assert.ok(error instanceof GitHubTransportError);
  assert.equal(error.code, code);
  assert.ok(!JSON.stringify(error).includes(token));
  assert.ok(!String(error.stack).includes(token));
  assert.equal(error.cause, undefined);
  return true;
}

test('provider exposes only getToken and preserves sync/async source receivers', async () => {
  const original = { token, getToken() { return this.token; } };
  const provider = createCredentialProvider(original);
  assert.deepEqual(Object.keys(provider), ['getToken']);
  assert.ok(Object.isFrozen(provider));
  assert.equal(await provider.getToken(), token);
  assert.equal(await createCredentialProvider({ getToken: async () => token }).getToken(), token);
  await assert.rejects(createCredentialProvider({ getToken: () => '' }).getToken(), /non-empty/);
  await assert.rejects(createCredentialProvider({ getToken() { throw new Error(token); } }).getToken(), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.stack?.includes(token));
    assert.equal(error.cause, undefined);
    return true;
  });
});

// Header contracts: PRD 6.4 traffic and API-version pages, plus GitHub's
// /en/rest/using-the-rest-api/getting-started-with-the-rest-api (User-Agent).
test('captured GET has the exact headers, version pin and package version, no body', async () => {
  const unknownPayload = '{"new_vendor_field":{"untouched":true}}';
  const transport = createHttpTransport({ credentialProvider: createCredentialProvider(source), fetch: async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/example/repo?per=day');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(Object.hasOwn(init ?? {}, 'body'), false);
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.deepEqual(init.headers, {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': `repo-signal/${version}`,
    });
    assert.equal(GITHUB_API_VERSION, '2026-03-10');
    return new Response(unknownPayload, { headers: { 'x-ratelimit-remaining': '8' } });
  } });
  const result = await transport.get('/repos/example/repo?per=day');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-ratelimit-remaining'), '8');
  assert.equal(result.body, unknownPayload);
});

test('non-allowlisted targets and insecure URLs never call fetch or credentials', async (t) => {
  localGate(t, undefined);
  let calls = 0;
  let credentialCalls = 0;
  const transport = createHttpTransport({
    credentialProvider: { getToken() { credentialCalls++; return token; } },
    fetch: async () => { calls++; return new Response(); },
  });
  for (const endpoint of [
    'https://example.com/a', '//example.com/a', 'https://api.github.com.evil.test/a',
    'http://api.github.com/a', 'https://api.github.com:8443/a',
    'https://user:password@api.github.com/a', 'ftp://api.github.com/a',
    'http://127.0.0.1:1234/a', 'https://api.github.com/a#fragment',
  ]) {
    await assert.rejects(transport.get(endpoint), (error) => safeError(error, 'ERR_TRANSPORT_HOST'));
  }
  assert.equal(calls, 0);
  assert.equal(credentialCalls, 0);
});

test('local base is refused without the gate; gate is checked per request', async (t) => {
  localGate(t, undefined);
  let calls = 0;
  const transport = createHttpTransport({ credentialProvider: source, baseUrl: 'http://127.0.0.1:1234/',
    fetch: async (url) => { calls++; assert.equal(url, 'http://127.0.0.1:1234/test'); return new Response('local'); },
  });
  await assert.rejects(transport.get('/test'), (error) => safeError(error, 'ERR_TRANSPORT_HOST'));
  assert.equal(calls, 0);
  process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT = '1';
  assert.equal((await transport.get('/test')).body, 'local');
  delete process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT;
  await assert.rejects(transport.get('/test'), (error) => safeError(error, 'ERR_TRANSPORT_HOST'));
  assert.equal(calls, 1);
});

test('local gate does not authorize other hosts, localhost, IPv6 or other local ports', async (t) => {
  localGate(t, '1');
  let calls = 0;
  const fetchStub = async () => { calls++; return new Response(); };
  for (const baseUrl of ['https://example.com', 'http://localhost:1234', 'http://[::1]:1234']) {
    await assert.rejects(createHttpTransport({ credentialProvider: source, baseUrl, fetch: fetchStub }).get('/test'),
      (error) => safeError(error, 'ERR_TRANSPORT_HOST'));
  }
  const transport = createHttpTransport({ credentialProvider: source, baseUrl: 'http://127.0.0.1:1234', fetch: fetchStub });
  for (const endpoint of ['http://127.0.0.1:4321/test', 'https://example.com/test']) {
    await assert.rejects(transport.get(endpoint), (error) => safeError(error, 'ERR_TRANSPORT_HOST'));
  }
  assert.equal(calls, 0);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`${status} cross-host redirect is refused after exactly one GET`, async () => {
    let calls = 0;
    const transport = createHttpTransport({ credentialProvider: source, fetch: async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status, headers: { Location: `https://example.com/${token}` } });
    } });
    await assert.rejects(transport.get('/test'), (error) => {
      safeError(error, 'ERR_TRANSPORT_REDIRECT');
      assert.ok(error instanceof GitHubTransportError);
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('same-host redirects are also refused rather than implicitly issuing a second request', async () => {
  const transport = createHttpTransport({ credentialProvider: source,
    fetch: async () => new Response(null, { status: 302, headers: { Location: '/canonical' } }),
  });
  await assert.rejects(transport.get('/test'), (error) => safeError(error, 'ERR_TRANSPORT_REDIRECT'));
});

test('every error boundary redacts token shapes and never retains raw causes', async () => {
  for (const stage of ['provider', 'fetch', 'body']) {
    const raw = Object.assign(new Error(`failed ${token}`), { authorization: token });
    const transport = createHttpTransport({
      credentialProvider: { getToken() { if (stage === 'provider') throw raw; return token; } },
      fetch: async () => {
        if (stage === 'fetch') throw raw;
        const response = new Response();
        Object.defineProperty(response, 'text', { value: async () => { throw raw; } });
        return response;
      },
    });
    await assert.rejects(transport.get(`/test/${token}`), (error) => safeError(error,
      stage === 'provider' ? 'ERR_TRANSPORT_CREDENTIAL' : 'ERR_TRANSPORT_NETWORK'));
  }
  const transport = createHttpTransport({ credentialProvider: source, baseUrl: `not a URL ${token}` });
  await assert.rejects(transport.get(token), (error) => safeError(error, 'ERR_TRANSPORT_CONFIGURATION'));
});

test('opaque known tokens are redacted too, and non-Error throws get safe text', async () => {
  const opaque = 'obviously-fake-opaque-secret';
  const transport = createHttpTransport({ credentialProvider: { getToken: () => opaque },
    fetch: async () => { throw new Error(`connection failed ${opaque}`); },
  });
  await assert.rejects(transport.get('/test'), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.stack?.includes(opaque));
    assert.match(error.message, /REDACTED/);
    return true;
  });
  await assert.rejects(createHttpTransport({ credentialProvider: source,
    fetch: async () => { throw token; },
  }).get('/test'), (error) => safeError(error, 'ERR_TRANSPORT_NETWORK'));
});

test('timeout aborts fetch deterministically with no real waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  const transport = createHttpTransport({ credentialProvider: source, timeoutMs: 100,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error(token)); }, { once: true });
    }),
  });
  const pending = transport.get('/test');
  await Promise.resolve();
  t.mock.timers.tick(100);
  await assert.rejects(pending, (error) => safeError(error, 'ERR_TRANSPORT_TIMEOUT'));
  assert.equal(aborted, true);
});

test('timeout includes body consumption and successful requests clear their timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = createHttpTransport({ credentialProvider: source, timeoutMs: 100,
    fetch: async (_url, init) => {
      const response = new Response();
      Object.defineProperty(response, 'text', { value: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(token)), { once: true });
      }) });
      return response;
    },
  });
  const pending = transport.get('/test');
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(100);
  await assert.rejects(pending, (error) => safeError(error, 'ERR_TRANSPORT_TIMEOUT'));
  let aborted = false;
  const successful = createHttpTransport({ credentialProvider: source, timeoutMs: 100,
    fetch: async (_url, init) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return new Response('ok');
    },
  });
  await successful.get('/test');
  t.mock.timers.tick(100);
  assert.equal(aborted, false);
});

test('invalid timeouts, media types and credentials fail before fetch', async () => {
  let calls = 0;
  const fetchStub = async () => { calls++; return new Response(); };
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    await assert.rejects(createHttpTransport({ credentialProvider: source, timeoutMs, fetch: fetchStub }).get('/test'),
      (error) => safeError(error, 'ERR_TRANSPORT_CONFIGURATION'));
  }
  for (const accept of ['', `application/json\r\n${token}`]) {
    await assert.rejects(createHttpTransport({ credentialProvider: source, fetch: fetchStub }).get('/test', accept),
      (error) => safeError(error, 'ERR_TRANSPORT_CONFIGURATION'));
  }
  for (const invalid of ['', `${token}\r\nInjected: value`]) {
    await assert.rejects(createHttpTransport({ credentialProvider: { getToken: () => invalid }, fetch: fetchStub }).get('/test'),
      (error) => safeError(error, 'ERR_TRANSPORT_CREDENTIAL'));
  }
  assert.equal(calls, 0);
});

test('HTTP statuses are returned once without retry, classification or endpoint parsing', async () => {
  for (const status of [202, 401, 403, 404, 429, 500]) {
    let calls = 0;
    const transport = createHttpTransport({ credentialProvider: source,
      fetch: async () => { calls++; return new Response('untouched', { status }); },
    });
    assert.equal((await transport.get('/test')).status, status);
    assert.equal(calls, 1);
  }
});
