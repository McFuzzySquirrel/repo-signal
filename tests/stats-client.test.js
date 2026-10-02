import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpTransport } from '../src/github/http.js';
import { createRetryPolicy, GitHubRequestError } from '../src/github/retry.js';
import { createStatsClient } from '../src/github/stats-client.js';

// Contract: https://docs.github.com/en/rest/metrics/statistics —
// 202 while the cache compiles, 200 with the weekly series, and an empty
// series for a repository whose statistics have not been computed.
const token = `github_pat_${'FAKE_TEST_ONLY_'.repeat(4)}`;
const repo = 'example/repo';

/** @param {Array<{status: number, payload?: unknown}>} sequence */
function harness(sequence) {
  /** @type {{url: string, init: RequestInit | undefined}[]} */
  const calls = [];
  let index = 0;
  const transport = createHttpTransport({
    credentialProvider: { getToken: () => token },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const step = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      const body = step.status === 204 ? null : (step.payload === undefined ? '' : JSON.stringify(step.payload));
      return new Response(body, { status: step.status });
    },
  });
  let now = 0;
  const policy = createRetryPolicy({ transport, clock: () => now,
    sleep: async (ms) => { now += ms; }, random: () => 1, maxAttempts: 5 });
  return { client: createStatsClient({ policy }), calls };
}

/** @param {unknown} payload @param {number} [status] */
function staticHarness(payload, status = 200) {
  return harness([{ status, payload }]);
}

test('participation: weekly owner and all series map from the documented shape', async () => {
  const payload = { all: [5, 3, 0, 7], owner: [2, 1, 0, 4] };
  const h = staticHarness(payload);
  const result = await h.client.participation(repo);
  assert.deepEqual(result, { kind: 'data', all: [5, 3, 0, 7], owner: [2, 1, 0, 4] });
  assert.equal(h.calls[0]?.url, 'https://api.github.com/repos/example/repo/stats/participation');
  assert.equal(h.calls[0]?.init?.method, 'GET');
  assert.equal(h.calls[0]?.init?.body, undefined);
});

test('commit activity: week, total and the seven day counts map per week', async () => {
  const payload = [
    { days: [1, 0, 2, 0, 0, 3, 1], total: 7, week: 1758326400 },
    { days: [0, 0, 0, 0, 0, 0, 0], total: 0, week: 1758931200 },
  ];
  const h = staticHarness(payload);
  const result = await h.client.commitActivity(repo);
  assert.deepEqual(result, { kind: 'data', weeks: payload });
  assert.equal(h.calls[0]?.url, 'https://api.github.com/repos/example/repo/stats/commit_activity');
});

test('202 then 200: the retryable outcome precedes parsed weekly data', async () => {
  const payload = [{ days: [1, 2, 3, 4, 5, 6, 7], total: 28, week: 1758326400 }];
  const h = harness([{ status: 202 }, { status: 200, payload }]);
  const result = await h.client.commitActivity(repo);
  // The shared policy retries 202 for statistics endpoints, so one client
  // call yields the parsed 200 after the 202 was surfaced and waited out.
  assert.deepEqual(result, { kind: 'data', weeks: payload });
  assert.equal(h.calls.length, 2);
});

test('a 202 that never resolves is a retryable outcome, not data and not an error', async () => {
  const calls = [];
  const transport = createHttpTransport({
    credentialProvider: { getToken: () => token },
    fetch: async (url, init) => { calls.push(String(url)); return new Response('', { status: 202 }); },
  });
  let now = 0;
  const policy = createRetryPolicy({ transport, clock: () => now, sleep: async (ms) => { now += ms; }, random: () => 1, maxAttempts: 2 });
  const client = createStatsClient({ policy });
  const result = await client.participation(repo);
  assert.deepEqual(result, { kind: 'retryable', status: 202, reason: 'statistics-cache-compiling' });
  assert.equal(calls.length, 2);
});

test('a stub policy surfacing a 202 directly still reports retryable', async () => {
  const client = createStatsClient({ policy: { get: async () => ({
    status: 202, headers: new Headers(), body: '',
  }) } });
  const result = await client.participation(repo);
  assert.deepEqual(result, { kind: 'retryable', status: 202, reason: 'statistics-cache-compiling' });
});

test('an empty participation response is no statistics yet, not an error', async () => {
  assert.deepEqual(await staticHarness({ all: [], owner: [] }).client.participation(repo),
    { kind: 'no-statistics-yet' });
  assert.deepEqual(await staticHarness({}).client.participation(repo), { kind: 'no-statistics-yet' });
  assert.deepEqual(await harness([{ status: 204 }]).client.participation(repo), { kind: 'no-statistics-yet' });
  assert.deepEqual(await staticHarness([]).client.commitActivity(repo), { kind: 'no-statistics-yet' });
});

test('malformed statistics payloads reject rather than guess', async () => {
  await assert.rejects(staticHarness({ all: 'nope', owner: [] }).client.participation(repo), /all must be an array/);
  await assert.rejects(staticHarness([{ days: [1, 2], total: 3, week: 1 }]).client.commitActivity(repo), /seven non-negative integers/);
  await assert.rejects(staticHarness([{ days: [1, 0, 0, 0, 0, 0, 0], total: -1, week: 1 }]).client.commitActivity(repo), /total and week/);
  await assert.rejects(staticHarness('[]').client.commitActivity(repo), /must be an array/);
});

test('passing unknown participation fields through untouched', async () => {
  const payload = { all: [1], owner: [1], future_field: { keep: true } };
  const result = await staticHarness(payload).client.participation(repo);
  assert.deepEqual(result, { kind: 'data', all: [1], owner: [1], future_field: { keep: true } });
});

test('202 from a traffic endpoint produces a distinct, non-retryable state', async () => {
  // Regression guard: endpointType statistics is required for 202 retries;
  // a traffic-typed client call surfaces 202 exactly once.
  const { createTrafficClient } = await import('../src/github/traffic-client.js');
  const calls = [];
  const transport = createHttpTransport({
    credentialProvider: { getToken: () => token },
    fetch: async (url) => { calls.push(String(url)); return new Response('[]', { status: 202 }); },
  });
  let now = 0;
  const policy = createRetryPolicy({ transport, clock: () => now, sleep: async (ms) => { now += ms; }, random: () => 1 });
  const traffic = createTrafficClient({ policy });
  await assert.rejects(traffic.clones(repo), (error) => {
    assert.ok(error instanceof GitHubRequestError);
    assert.equal(error.status, 202);
    return true;
  });
  assert.equal(calls.length, 1);
});
