import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestHandler, createServer, isLoopbackAddress } from '../src/server/server.js';

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
function get(url, init) {
  return fetch(url, init);
}

test('factory reports a URL on 127.0.0.1 with the real ephemeral port', async (t) => {
  const server = await createServer({ handler: () => '<html><body>ok</body></html>' });
  t.after(() => server.close());
  const parsed = new URL(server.url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.protocol, 'http:');
  assert.ok(Number(parsed.port) > 0, 'the reported port must be the real listening port');
  const response = await get(server.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html><body>ok</body></html>');
});

test('every response carries the CSP, no-store and no-referrer headers and no cross-origin header', async (t) => {
  const server = await createServer({ handler: () => '<html><body>ok</body></html>' });
  t.after(() => server.close());
  const response = await get(server.url);
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /style-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('access-control-allow-methods'), null);
});

test('HEAD returns the same headers as GET and no body', async (t) => {
  const server = await createServer({ handler: () => '<html><body>body that HEAD must drop</body></html>' });
  t.after(() => server.close());
  const getResponse = await get(server.url);
  const head = await fetch(server.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-security-policy'), getResponse.headers.get('content-security-policy'));
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(head.headers.get('referrer-policy'), 'no-referrer');
});

test('a non-GET, non-HEAD request is rejected with 405 and an Allow header', async (t) => {
  let calls = 0;
  const server = await createServer({
    handler: () => {
      calls += 1;
      return 'ok';
    }
  });
  t.after(() => server.close());
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await fetch(server.url, { method });
    assert.equal(response.status, 405, `${method} must be rejected`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(response.headers.get('cache-control'), 'no-store', `${method} response must be no-store`);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(await response.text(), /Method not allowed/);
  }
  assert.equal(calls, 0, 'no view must run for a rejected method');
});

test('an over-long request URL is rejected before any view runs', async (t) => {
  let calls = 0;
  const server = await createServer({
    handler: () => {
      calls += 1;
      return 'ok';
    }
  });
  t.after(() => server.close());
  const longPath = `/repo/owner/name?pad=${'x'.repeat(4096)}`;
  const response = await get(`${server.url}${longPath}`);
  assert.equal(response.status, 414);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /Request URL too long/);
  assert.equal(calls, 0, 'the view handler must not run for an over-long URL');
});

test('a throwing view yields a generic 500 with no message, no stack and no forwarded headers', async (t) => {
  /** @type {unknown[]} */
  const logged = [];
  const secret = 'invoke-detail github_pat_ABC123 should not leak';
  const server = await createServer({
    logger: (error) => logged.push(error),
    handler: () => {
      throw new Error(`boom: ${secret}`);
    }
  });
  t.after(() => server.close());
  const response = await get(server.url);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'none'/);
  const body = await response.text();
  assert.ok(!body.includes('boom'), 'body must not carry the thrown message');
  assert.ok(!body.includes('github_pat_'), 'body must not carry credential-shaped detail');
  assert.ok(!body.includes('Error'), 'body must not name the error type');
  assert.ok(!/\bat\s+\S+\s+\(/.test(body), 'body must not carry a stack trace');
  assert.equal(logged.length, 1, 'the detail must be logged locally exactly once');
  assert.match(String(logged[0] instanceof Error ? logged[0].message : logged[0]), /boom:/);
});

test('a rejecting async view yields the same generic 500', async (t) => {
  const server = await createServer({
    logger: () => {},
    handler: async () => {
      throw new Error('async detail that must not appear');
    }
  });
  t.after(() => server.close());
  const response = await get(server.url);
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.ok(!body.includes('async detail'));
  assert.ok(!body.includes('must not appear'));
});

test('a peer that is not loopback is refused before the view runs', async () => {
  let calls = 0;
  const listener = createRequestHandler({
    handler: () => {
      calls += 1;
      return 'ok';
    }
  });
  const req = /** @type {any} */ ({
    method: 'GET',
    url: '/',
    socket: { remoteAddress: '198.51.100.23' }
  });
  let status = 0;
  /** @type {Record<string, string>} */
  let headers = {};
  let body = '';
  const res = /** @type {any} */ ({
    headersSent: false,
    writeHead(/** @type {number} */ code, /** @type {Record<string, string>} */ value) {
      status = code;
      headers = value;
      this.headersSent = true;
    },
    end(/** @type {string | undefined} */ chunk) {
      body = chunk ?? '';
    }
  });
  await listener(req, res);
  assert.equal(status, 403);
  assert.equal(calls, 0);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.match(body, /Forbidden/);
});

test('loopback address classification accepts only loopback peers', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackAddress('198.51.100.23'), false);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress('::ffff:10.0.0.5'), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(''), false);
});

test('close is safe to call more than once', async (t) => {
  const server = await createServer({ handler: () => 'ok' });
  await server.close();
  await server.close();
});
