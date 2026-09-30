import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpTransport, GITHUB_API_VERSION, GitHubTransportError, USER_AGENT } from '../src/github/http.js';
import { createRetryPolicy, GitHubRequestError } from '../src/github/retry.js';
import { parseRateLimitHeaders, primaryBudgetDelay } from '../src/github/rate-limit.js';

const token = `github_pat_${'FAKE_TEST_ONLY_'.repeat(4)}`;
const endpoint = '/repos/example/repo';

/**
 * All HTTP responses come from fetch injection, never the network. Fake sleep
 * advances the fake clock, so even minute-long secondary limits take no time.
 * @param {{status: number, headers?: Record<string, string>, body?: string}[]} responses
 * @param {{maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, random?: () => number}} [options]
 */
function harness(responses, options = {}) {
  let now = 100_000;
  /** @type {number[]} */
  const delays = [];
  /** @type {{at: number, url: string, init: RequestInit | undefined}[]} */
  const calls = [];
  const transport = createHttpTransport({
    credentialProvider: { getToken: () => token },
    fetch: async (url, init) => {
      const next = responses[calls.length];
      calls.push({ at: now, url: String(url), init });
      assert.ok(next, 'unexpected extra HTTP attempt');
      return new Response(next.body ?? 'untouched', { status: next.status, headers: next.headers });
    },
  });
  const policy = createRetryPolicy({ transport, clock: () => now,
    sleep: async (ms) => { delays.push(ms); now += ms; },
    random: () => 1, baseDelayMs: 100, maxDelayMs: 250, ...options,
  });
  return { policy, calls, delays };
}

/** @param {unknown} error @param {number} status @param {string} kind @param {number} attempts */
function requestError(error, status, kind, attempts) {
  assert.ok(error instanceof GitHubRequestError);
  assert.equal(error.status, status);
  assert.equal(error.kind, kind);
  assert.equal(error.attempts, attempts);
  assert.ok(error.action.length > 0);
  assert.ok(!JSON.stringify(error).includes(token));
  assert.ok(!error.stack?.includes(token));
  assert.equal(error.cause, undefined);
  return true;
}

// Header meanings and reset units verified against GitHub's rate-limit page.
test('rate-limit headers become a budget record with epoch millisecond reset and retry delay', () => {
  const budget = parseRateLimitHeaders(new Headers({
    'X-RateLimit-Limit': '5000', 'x-ratelimit-remaining': '0',
    'x-ratelimit-used': '5000', 'x-ratelimit-reset': '105',
    'x-ratelimit-resource': 'core', 'retry-after': '7',
  }), 100_000);
  assert.deepEqual(budget, { limit: 5000, remaining: 0, used: 5000,
    resetAt: 105_000, resource: 'core', retryAfterMs: 7000 });
  assert.equal(primaryBudgetDelay(budget, 100_000), 5000);
  assert.equal(primaryBudgetDelay(budget, 106_000), 0);
});

test('missing and malformed headers remain unknown, not zero or an invalid sleep', () => {
  assert.deepEqual(parseRateLimitHeaders(new Headers(), 100_000), {
    limit: null, remaining: null, used: null, resetAt: null, resource: null, retryAfterMs: null,
  });
  for (const value of ['', '-1', '1.5', 'NaN', 'Infinity', '100abc', '9007199254740992']) {
    const budget = parseRateLimitHeaders(new Headers({
      'x-ratelimit-limit': value, 'x-ratelimit-remaining': value,
      'x-ratelimit-used': value, 'x-ratelimit-reset': value, 'retry-after': value,
    }), 100_000);
    assert.equal(budget.limit, null);
    assert.equal(budget.remaining, null);
    assert.equal(budget.used, null);
    assert.equal(budget.resetAt, null);
    assert.equal(budget.retryAfterMs, null);
    assert.equal(primaryBudgetDelay(budget, 100_000), 0);
  }
  assert.equal(parseRateLimitHeaders(new Headers({ 'x-ratelimit-reset': '9007199254741' }), 0).resetAt, null);
});

test('HTTP-date Retry-After is supported, with past dates clamped to zero', () => {
  assert.equal(parseRateLimitHeaders(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:01:45 GMT' }), 100_000).retryAfterMs, 5000);
  assert.equal(parseRateLimitHeaders(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:01:30 GMT' }), 100_000).retryAfterMs, 0);
});

test('exhausted primary budget waits until reset before another retry', async () => {
  const h = harness([{ status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '105' } }, { status: 200 }]);
  assert.equal((await h.policy.get(endpoint)).status, 200);
  assert.deepEqual(h.delays, [5000]);
  assert.deepEqual(h.calls.map((call) => call.at), [100_000, 105_000]);
});

test('successful exhausted budget paces the next client call, not only retries', async () => {
  const h = harness([{ status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '105' } }, { status: 200 }]);
  await h.policy.get(endpoint);
  assert.deepEqual(h.delays, []);
  await h.policy.get(`${endpoint}/releases`);
  assert.deepEqual(h.delays, [5000]);
  assert.deepEqual(h.calls.map((call) => call.at), [100_000, 105_000]);
});

test('past primary reset does not produce a negative sleep or delay the next call', async () => {
  const h = harness([{ status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '99' } }, { status: 200 }]);
  await h.policy.get(endpoint);
  await h.policy.get(endpoint);
  assert.deepEqual(h.delays, []);
  assert.equal(h.calls.length, 2);
});

test('retry with past primary reset still uses bounded backoff', async () => {
  const h = harness([{ status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '99' } }, { status: 200 }]);
  await h.policy.get(endpoint);
  assert.deepEqual(h.delays, [250]);
  assert.equal(h.calls.length, 2);
});

test('early sleep wakeups cannot issue an attempt before the reset deadline', async () => {
  let now = 100_000;
  let calls = 0;
  /** @type {number[]} */
  const delays = [];
  const policy = createRetryPolicy({
    transport: { get: async () => {
      calls++;
      if (calls === 2) assert.equal(now, 105_000);
      return { status: 200, body: '', headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '105' }) };
    } },
    clock: () => now, sleep: async (ms) => { delays.push(ms); now += Math.min(ms, 2000); },
  });
  await policy.get(endpoint);
  await policy.get(endpoint);
  assert.deepEqual(delays, [5000, 3000, 1000]);
  assert.equal(calls, 2);
});

test('long reset waits are split into safe timer sizes without an early attempt', async () => {
  const h = harness([{ status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2147584' } }, { status: 200 }]);
  await h.policy.get(endpoint);
  await h.policy.get(endpoint);
  assert.deepEqual(h.delays, [2_147_483_647, 353]);
  assert.equal(h.calls[1]?.at, 2_147_584_000);
});

test('fresh response headers replace stale budget observations rather than inventing quota', async () => {
  const h = harness([{ status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '105' } },
    { status: 200 }, { status: 200 }]);
  await h.policy.get(endpoint);
  await h.policy.get(endpoint);
  await h.policy.get(endpoint);
  assert.deepEqual(h.delays, [5000]);
  assert.equal(h.calls.length, 3);
});

// GitHub statistics docs explicitly describe 202 cache compilation, then 200.
test('202 statistics retries with backoff and returns the untouched final response', async () => {
  const body = '{"new_vendor_field":{"untouched":true}}';
  const h = harness([{ status: 202 }, { status: 202 }, { status: 200, body }]);
  assert.equal((await h.policy.get(endpoint, { endpointType: 'statistics' })).body, body);
  assert.deepEqual(h.delays, [100, 200]);
  assert.equal(h.calls.length, 3);
});

test('202 traffic and unmarked endpoints are surfaced once without retry or parsing', async () => {
  for (const endpointType of /** @type {const} */ (['traffic', 'repository'])) {
    const h = harness([{ status: 202, body: 'not JSON' }]);
    const result = await h.policy.get(endpoint, { endpointType });
    assert.equal(result.status, 202);
    assert.equal(result.body, 'not JSON');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.delays, []);
  }
});

for (const status of [429, 500, 503, 599]) {
  test(`${status} retries with increasing capped delays and exactly four attempts`, async () => {
    const isRateLimit = status === 429;
    const h = harness([{ status }, { status }, { status }, { status: 200 }],
      isRateLimit ? { baseDelayMs: 60_000, maxDelayMs: 150_000 } : {});
    assert.equal((await h.policy.get(endpoint)).status, 200);
    assert.deepEqual(h.delays, isRateLimit ? [60_000, 120_000, 150_000] : [100, 200, 250]);
    assert.equal(h.calls.length, 4);
  });
}

test('injected jitter changes delays but never exceeds the local backoff cap', async () => {
  const h = harness([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }], { random: () => 0.5 });
  await h.policy.get(endpoint);
  assert.deepEqual(h.delays, [75, 150, 188]);
  assert.equal(h.calls.length, 4);
});

test('429 without rate-limit timing waits at least a minute even at the lowest jitter', async () => {
  const h = harness([{ status: 429 }, { status: 200 }], { random: () => 0 });
  await h.policy.get(endpoint);
  assert.deepEqual(h.delays, [60_000]);
});

test('Retry-After server delay is respected even beyond the local backoff cap', async () => {
  for (const status of [429, 500, 202]) {
    const h = harness([{ status, headers: { 'retry-after': '7' } }, { status: 200 }]);
    await h.policy.get(endpoint, { endpointType: 'statistics' });
    assert.deepEqual(h.delays, [7000]);
    assert.deepEqual(h.calls.map((call) => call.at), [100_000, 107_000]);
  }
});

test('larger reset or Retry-After deadline wins when both are supplied', async () => {
  for (const [reset, expected] of [['105', 7000], ['110', 10_000]]) {
    const h = harness([{ status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'retry-after': '7' } }, { status: 200 }]);
    await h.policy.get(endpoint);
    assert.deepEqual(h.delays, [expected]);
    assert.equal(h.calls.length, 2);
  }
});

for (const [status, kind] of /** @type {const} */ ([[401, 'authentication-rejected'], [403, 'permission-missing'], [404, 'repository-missing']])) {
  test(`${status} fails fast with distinct ${kind} kind and exactly one attempt`, async () => {
    const h = harness([{ status, body: token, headers: { 'retry-after': '7', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '105' } }]);
    await assert.rejects(h.policy.get(`${endpoint}/${token}`, { endpointType: 'traffic' }), (error) => {
      requestError(error, status, kind, 1);
      assert.ok(error instanceof GitHubRequestError);
      if (status === 403) assert.match(error.message, /Administration repository permission \(read\)/);
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.delays, []);
  });
}

test('generic 403 names token access without inventing a traffic-specific permission', async () => {
  const h = harness([{ status: 403 }]);
  await assert.rejects(h.policy.get(endpoint), (error) => {
    requestError(error, 403, 'permission-missing', 1);
    assert.ok(error instanceof GitHubRequestError);
    assert.doesNotMatch(error.message, /Administration/);
    return true;
  });
});

test('403 is not retried, but its exhausted budget paces a later independent request', async () => {
  const h = harness([{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '105' } }, { status: 200 }]);
  await assert.rejects(h.policy.get(endpoint), (error) => requestError(error, 403, 'permission-missing', 1));
  assert.deepEqual(h.delays, []);
  await h.policy.get(`${endpoint}/releases`);
  assert.deepEqual(h.delays, [5000]);
  assert.equal(h.calls.length, 2);
});

test('attempt cap surfaces the last status and attempt count with no final sleep', async () => {
  const h = harness([{ status: 500 }, { status: 429 }, { status: 502, body: token }], { maxAttempts: 3 });
  await assert.rejects(h.policy.get(endpoint), (error) => requestError(error, 502, 'transient', 3));
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.delays, [100, 60_000]);
});

for (const [status, kind] of /** @type {const} */ ([[429, 'rate-limited'], [202, 'transient'], [500, 'transient']])) {
  test(`one-attempt cap surfaces ${status} and does not sleep`, async () => {
    const h = harness([{ status }], { maxAttempts: 1 });
    await assert.rejects(h.policy.get(endpoint, { endpointType: 'statistics' }), (error) => requestError(error, status, kind, 1));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.delays, []);
  });
}

test('unexpected HTTP status is safe and not retried', async () => {
  const h = harness([{ status: 422, body: token }]);
  await assert.rejects(h.policy.get(`${endpoint}/${token}`), (error) => requestError(error, 422, 'unexpected', 1));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
});

test('every retry stays GET-only with the transport header contract and Accept override', async () => {
  const h = harness([{ status: 500 }, { status: 200 }]);
  await h.policy.get(endpoint, { accept: 'application/vnd.github.star+json' });
  assert.equal(h.calls.length, 2);
  for (const { init } of h.calls) {
    assert.equal(init?.method, 'GET');
    assert.equal(Object.hasOwn(init ?? {}, 'body'), false);
    assert.deepEqual(init?.headers, {
      Accept: 'application/vnd.github.star+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': USER_AGENT,
    });
  }
});

test('transport allowlist failure propagates unchanged with no fetch or policy sleep', async () => {
  const h = harness([]);
  await assert.rejects(h.policy.get('https://example.com/test'), (error) => {
    assert.ok(error instanceof GitHubTransportError);
    assert.equal(error.code, 'ERR_TRANSPORT_HOST');
    return true;
  });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.delays, []);
});

test('transport network failure is not rewrapped or retried and remains redacted', async () => {
  let calls = 0;
  const policy = createRetryPolicy({ transport: createHttpTransport({
    credentialProvider: { getToken: () => token },
    fetch: async () => { calls++; throw new Error(token); },
  }), clock: () => 0, sleep: async () => { assert.fail('unexpected policy sleep'); } });
  await assert.rejects(policy.get(endpoint), (error) => {
    assert.ok(error instanceof GitHubTransportError);
    assert.ok(!error.stack?.includes(token));
    return true;
  });
  assert.equal(calls, 1);
});

test('invalid attempt caps and delay configuration are rejected', () => {
  const transport = { get: async () => ({ status: 200, headers: new Headers(), body: '' }) };
  for (const maxAttempts of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createRetryPolicy({ transport, maxAttempts }), TypeError);
  }
  for (const baseDelayMs of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => createRetryPolicy({ transport, baseDelayMs }), TypeError);
  }
  assert.throws(() => createRetryPolicy({ transport, baseDelayMs: 100, maxDelayMs: 99 }), TypeError);
});

test('invalid jitter fails safely after one attempt without sleeping', async () => {
  const h = harness([{ status: 500 }], { random: () => NaN });
  await assert.rejects(h.policy.get(endpoint), /jitter source/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
});
