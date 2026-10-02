import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpTransport, GITHUB_API_VERSION, USER_AGENT } from '../src/github/http.js';
import { createRetryPolicy, GitHubRequestError } from '../src/github/retry.js';
import { createRepoClient } from '../src/github/repo-client.js';

// Fixtures follow https://docs.github.com/en/rest/repos/repos:
// a repository record carries stargazers_count, forks_count and watchers_count.
const token = `github_pat_${'FAKE_TEST_ONLY_'.repeat(4)}`;
const repo = 'example/repo';
const repoPayload = {
  id: 1, name: 'repo', full_name: 'example/repo',
  stargazers_count: 120, forks_count: 9, watchers_count: 41, future_field: { kept: true },
};

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
    sleep: async () => { assert.fail('repository fixture must not sleep'); },
    random: () => 1,
  });
  return { client: createRepoClient({ policy }), calls };
}

test('repository: stars, forks and watchers map to plain integer fields', async () => {
  const h = harness(repoPayload);
  const record = await h.client.repository(repo);
  assert.equal(record.stars, 120);
  assert.equal(record.forks, 9);
  assert.equal(record.watchers, 41);
  assert.ok(Number.isInteger(record.stars) && Number.isInteger(record.forks) && Number.isInteger(record.watchers));
  assert.equal(record.name, 'repo');
  assert.deepEqual(record.future_field, { kept: true });
  assert.equal(h.calls[0]?.url, `https://api.github.com/repos/example/repo`);
  assert.equal(h.calls[0]?.init?.method, 'GET');
  assert.equal(h.calls[0]?.init?.body, undefined);
  const headers = new Headers(h.calls[0]?.init?.headers);
  assert.equal(headers.get('Accept'), 'application/vnd.github+json');
  assert.equal(headers.get('Authorization'), `Bearer ${token}`);
  assert.equal(headers.get('X-GitHub-Api-Version'), GITHUB_API_VERSION);
  assert.equal(headers.get('User-Agent'), USER_AGENT);
});

test('repository: malformed counts reject rather than interpret', async () => {
  for (const field of ['stargazers_count', 'forks_count', 'watchers_count']) {
    const h = harness({ ...repoPayload, [field]: -1 });
    await assert.rejects(h.client.repository(repo), (error) => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.kind, 'unexpected');
      assert.match(error.message, new RegExp(field));
      assert.ok(!error.stack?.includes(token));
      return true;
    });
  }
});

test('repository: a non-record payload rejects', async () => {
  await assert.rejects(harness([1, 2]).client.repository(repo), /must be a record/);
  await assert.rejects(harness(null).client.repository(repo), /must be a record/);
});

test('releases: records pass through and stay an array', async () => {
  const releases = [
    { id: 7, tag_name: 'v1.0.0', name: 'v1.0.0', published_at: '2026-09-01T00:00:00Z' },
    { id: 8, tag_name: 'v1.1.0', future_field: ['kept'] },
  ];
  const h = harness(releases);
  assert.deepEqual(await h.client.releases(repo), releases);
  assert.equal(h.calls[0]?.url, 'https://api.github.com/repos/example/repo/releases');
  assert.equal(h.calls[0]?.init?.method, 'GET');
});

test('releases: empty list stays empty; a non-array rejects', async () => {
  assert.deepEqual(await harness([]).client.releases(repo), []);
  await assert.rejects(harness({}).client.releases(repo), /must be an array/);
  await assert.rejects(harness([null]).client.releases(repo), /entry 0 must be a record/);
});

test('403 on the repository record is a typed permission error, attempted once', async () => {
  const h = harness({ message: 'forbidden' }, 403);
  await assert.rejects(h.client.repository(repo), (error) => {
    assert.ok(error instanceof GitHubRequestError);
    assert.equal(error.kind, 'permission-missing');
    assert.equal(error.status, 403);
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(h.calls.length, 1);
});

test('invalid repository names are refused before any request', async () => {
  const h = harness({});
  for (const name of ['', 'example', 'example/repo/extra', '/repo']) {
    await assert.rejects(h.client.releases(name), /owner\/name pair/);
  }
  assert.equal(h.calls.length, 0);
});
