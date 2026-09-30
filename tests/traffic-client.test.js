import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpTransport, GITHUB_API_VERSION, USER_AGENT } from '../src/github/http.js';
import { createRetryPolicy, GitHubRequestError } from '../src/github/retry.js';
import { createTrafficClient } from '../src/github/traffic-client.js';

// Fixtures follow https://docs.github.com/en/rest/metrics/traffic:
// dated clones/views envelopes and undated popular list records. No live calls.
const token = `github_pat_${'FAKE_TEST_ONLY_'.repeat(4)}`;
const repo = 'example/repo';
const dayEntries = [
  { timestamp: '2026-09-20T00:00:00Z', count: 12, uniques: 9 },
  { timestamp: '2026-09-22T00:00:00Z', count: 0, uniques: 0 },
  { timestamp: '2026-09-23T00:00:00Z', count: 7, uniques: 4 },
];

/** @param {unknown} payload @param {number} [status] */
function harness(payload, status = 200) {
  /** @type {{url: string, init: RequestInit | undefined}[]} */
  const calls = [];
  const transport = createHttpTransport({
    credentialProvider: { getToken: () => token },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(payload), { status });
    },
  });
  const policy = createRetryPolicy({ transport, clock: () => 0,
    sleep: async () => { assert.fail('traffic fixture must not sleep'); },
    random: () => 1,
  });
  return { client: createTrafficClient({ policy }), calls };
}

/** @param {unknown} error @param {RegExp} message */
function malformed(error, message) {
  assert.ok(error instanceof GitHubRequestError);
  assert.equal(error.kind, 'unexpected');
  assert.equal(error.status, 200);
  assert.match(error.message, message);
  assert.ok(error.endpoint.startsWith('/repos/example/repo/traffic/'));
  assert.ok(error.action.length > 0);
  assert.ok(!error.stack?.includes(token));
  assert.ok(!JSON.stringify(error).includes(token));
  return true;
}

for (const metric of /** @type {const} */ (['clones', 'views'])) {
  test(`${metric}: three day entries yield UTC days and integer counts, preserving gaps and observed zero`, async () => {
    const h = harness({ count: 19, uniques: 13, [metric]: dayEntries });
    const records = await h.client[metric](repo);
    assert.deepEqual(records, dayEntries.map((entry) => ({ ...entry,
      day: entry.timestamp.slice(0, 10), granularity: 'day' })));
    assert.equal(records.length, 3);
    assert.ok(!records.some((entry) => entry.day === '2026-09-21'));
    assert.ok(records.every((entry) => Number.isInteger(entry.count) && Number.isInteger(entry.uniques)));
    assert.equal(h.calls[0]?.url, `https://api.github.com/repos/example/repo/traffic/${metric}?per=day`);
    assert.equal(h.calls[0]?.init?.method, 'GET');
    assert.equal(h.calls[0]?.init?.body, undefined);
    const headers = new Headers(h.calls[0]?.init?.headers);
    assert.equal(headers.get('Accept'), 'application/vnd.github+json');
    assert.equal(headers.get('Authorization'), `Bearer ${token}`);
    assert.equal(headers.get('X-GitHub-Api-Version'), GITHUB_API_VERSION);
    assert.equal(headers.get('User-Agent'), USER_AGENT);
  });

  test(`${metric}: week parameter returns week-start dates without expanding totals into days`, async () => {
    const entry = { timestamp: '2026-09-21T00:00:00Z', count: 42, uniques: 17 };
    const h = harness({ count: 42, uniques: 17, [metric]: [entry] });
    assert.deepEqual(await h.client[metric](repo, 'week'), [
      { ...entry, day: '2026-09-21', granularity: 'week' },
    ]);
    assert.equal(h.calls[0]?.url, `https://api.github.com/repos/example/repo/traffic/${metric}?per=week`);
  });

  test(`${metric}: empty breakdown stays empty without padding`, async () => {
    const h = harness({ count: 0, uniques: 0, [metric]: [] });
    assert.deepEqual(await h.client[metric](repo), []);
  });

  test(`${metric}: exactly fourteen daily entries are accepted; fifteen are rejected with observed length`, async () => {
    const entries = Array.from({ length: 15 }, (_, index) => ({
      timestamp: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z`, count: 1, uniques: 1,
    }));
    const valid = harness({ count: 14, uniques: 14, [metric]: entries.slice(0, 14) });
    assert.equal((await valid.client[metric](repo)).length, 14);
    const invalid = harness({ count: 15, uniques: 15, [metric]: entries });
    await assert.rejects(invalid.client[metric](repo), (error) => malformed(error, /15 entries; maximum is 14/));
    assert.equal(invalid.calls.length, 1);
  });

  test(`${metric}: missing timestamp rejects the response instead of defaulting a day`, async () => {
    const h = harness({ count: 1, uniques: 1, [metric]: [{ count: 1, uniques: 1 }] });
    await assert.rejects(h.client[metric](repo), (error) => malformed(error, /entry 0 timestamp is missing/));
  });

  test(`${metric}: unknown record fields and timestamp pass through untouched`, async () => {
    const entry = { ...dayEntries[0], future_field: { value: ['untouched'] } };
    const h = harness({ count: 12, uniques: 9, [metric]: [entry] });
    assert.deepEqual(await h.client[metric](repo), [{ ...entry, day: '2026-09-20', granularity: 'day' }]);
  });
}

test('a zoned timestamp is normalized to its UTC day, not its local date', async () => {
  const entry = { timestamp: '2026-09-20T23:30:00-02:00', count: 1, uniques: 1 };
  const h = harness({ count: 1, uniques: 1, clones: [entry] });
  assert.equal((await h.client.clones(repo))[0]?.day, '2026-09-21');
});

for (const timestamp of [null, '', 'not a date', '2026-09-20', '2026-09-20T00:00:00',
  '2026-02-30T00:00:00Z', '2026-09-20T24:00:00Z', token]) {
  test(`invalid timestamp ${timestamp === token ? '(redaction fixture)' : JSON.stringify(timestamp)} is rejected`, async () => {
    const h = harness({ count: 1, uniques: 1, clones: [{ timestamp, count: 1, uniques: 1 }] });
    await assert.rejects(h.client.clones(repo), (error) => malformed(error, /timestamp/));
  });
}

for (const field of ['count', 'uniques']) {
  for (const value of [undefined, null, '1', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    test(`${field} ${String(value)} is rejected, never coerced or rounded`, async () => {
      const entry = { ...dayEntries[0], [field]: value };
      const h = harness({ count: 12, uniques: 9, clones: [entry] });
      await assert.rejects(h.client.clones(repo), (error) => malformed(error, /count and uniques/));
    });
  }
}

const popularFixtures = [
  { method: /** @type {const} */ ('referrers'), path: 'referrers',
    records: [{ referrer: 'github.com', count: 23, uniques: 14, future_field: { keep: true } }] },
  { method: /** @type {const} */ ('popularPaths'), path: 'paths',
    records: [{ path: '/example/repo', title: 'Example', count: 32, uniques: 20, future_field: ['keep'] }] },
];
for (const fixture of popularFixtures) {
  test(`${fixture.method}: count and uniques are preserved with no assigned day or timestamp`, async () => {
    const h = harness(fixture.records);
    const records = await h.client[fixture.method](repo);
    assert.deepEqual(records, fixture.records);
    for (const record of records) {
      assert.ok(!Object.hasOwn(record, 'day'));
      assert.ok(!Object.hasOwn(record, 'timestamp'));
      assert.ok(!Object.hasOwn(record, 'granularity'));
    }
    assert.equal(h.calls[0]?.url, `https://api.github.com/repos/example/repo/traffic/popular/${fixture.path}`);
    assert.equal(h.calls[0]?.init?.method, 'GET');
    assert.equal(h.calls[0]?.init?.body, undefined);
  });

  test(`${fixture.method}: empty list stays empty`, async () => {
    assert.deepEqual(await harness([]).client[fixture.method](repo), []);
  });

  test(`${fixture.method}: missing identity fields reject an invalid snapshot`, async () => {
    const h = harness([{ count: 1, uniques: 1 }]);
    await assert.rejects(h.client[fixture.method](repo), (error) => malformed(error, /requires string/));
  });
}

for (const method of /** @type {const} */ (['clones', 'views', 'referrers', 'popularPaths'])) {
  test(`${method}: 403 is a typed Administration read permission error, attempted once`, async () => {
    const h = harness({ message: token }, 403);
    await assert.rejects(h.client[method](repo), (error) => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.kind, 'permission-missing');
      assert.equal(error.status, 403);
      assert.equal(error.attempts, 1);
      assert.match(error.message, /Administration repository permission \(read\)/);
      assert.match(error.action, /accept the permission upgrade/);
      assert.ok(error.endpoint.includes('/traffic/'));
      assert.ok(!error.stack?.includes(token));
      return true;
    });
    assert.equal(h.calls.length, 1);
  });

  test(`${method}: 202 is surfaced as unexpected, not an empty observation or a retry`, async () => {
    const h = harness([], 202);
    await assert.rejects(h.client[method](repo), (error) => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.kind, 'unexpected');
      assert.equal(error.status, 202);
      return true;
    });
    assert.equal(h.calls.length, 1);
  });
}

for (const [status, kind] of [[401, 'authentication-rejected'], [404, 'repository-missing']]) {
  test(`${status} remains a distinct typed failure and is not converted to permission missing`, async () => {
    const h = harness({}, Number(status));
    await assert.rejects(h.client.clones(repo), (error) => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.kind, kind);
      return true;
    });
    assert.equal(h.calls.length, 1);
  });
}

test('malformed JSON is rejected without echoing body secrets or parser diagnostics', async () => {
  const client = createTrafficClient({ policy: { get: async () => ({
    status: 200, headers: new Headers(), body: `{${token}`,
  }) } });
  await assert.rejects(client.clones(repo), (error) => malformed(error, /valid JSON/));
});

for (const payload of [null, [], {}, { count: 0, uniques: 0 }, { count: 0, uniques: 0, clones: {} }]) {
  test(`malformed clones envelope ${JSON.stringify(payload)} does not masquerade as an empty breakdown`, async () => {
    await assert.rejects(harness(payload).client.clones(repo), (error) => malformed(error, /record|integers|array/));
  });
}

test('invalid per is refused before any request', async () => {
  const h = harness({});
  // @ts-expect-error Runtime guard for callers not checked by TypeScript.
  await assert.rejects(h.client.clones(repo, 'month'), /per must be day or week/);
  assert.equal(h.calls.length, 0);
});

test('invalid repository names are refused before any request', async () => {
  const h = harness([]);
  for (const name of ['', 'example', 'example/repo/extra', '/repo', 'example/..']) {
    await assert.rejects(h.client.referrers(name), /owner\/name pair/);
  }
  assert.equal(h.calls.length, 0);
});

test('repository path components are encoded rather than interpreted as query or fragment', async () => {
  const h = harness([]);
  await h.client.referrers('example/repo?#');
  assert.equal(h.calls[0]?.url, 'https://api.github.com/repos/example/repo%3F%23/traffic/popular/referrers');
});
