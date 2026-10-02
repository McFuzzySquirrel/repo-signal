import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpTransport } from '../src/github/http.js';
import { createRetryPolicy } from '../src/github/retry.js';
import { createStarsClient, STARGAZER_ACCEPT } from '../src/github/stars-client.js';

// Contract: https://docs.github.com/en/rest/activity/starring —
// the star media type adds `starred_at`; pages end on the Link rel="next".
const token = `github_pat_${'FAKE_TEST_ONLY_'.repeat(4)}`;
const repo = 'example/repo';

/** @param {Map<string, {status: number, payload: unknown, link?: string}>} pages */
function harness(pages) {
  /** @type {{url: string, init: RequestInit | undefined}[]} */
  const calls = [];
  const transport = createHttpTransport({
    credentialProvider: { getToken: () => token },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const page = pages.get(String(url));
      if (page === undefined) return new Response('not found', { status: 404 });
      const headers = new Headers();
      if (page.link !== undefined) headers.set('link', page.link);
      return new Response(JSON.stringify(page.payload), { status: page.status, headers });
    },
  });
  const policy = createRetryPolicy({ transport, clock: () => 0,
    sleep: async () => { assert.fail('stargazer fixture must not sleep'); },
    random: () => 1,
  });
  return { client: createStarsClient({ policy }), calls };
}

/** @param {RequestInit | undefined} init @returns {Headers} */
function headersOf(init) { return new Headers(init?.headers); }

test('stargazers: the star-timestamp media type is sent on every page', async () => {
  const h = harness(new Map([
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=1`,
      { status: 200, payload: [] }],
  ]));
  await h.client.stargazerStars(repo, async () => {});
  assert.equal(headersOf(h.calls[0]?.init).get('Accept'), STARGAZER_ACCEPT);
  assert.equal(headersOf(h.calls[0]?.init).get('Accept'), 'application/vnd.github.star+json');
  assert.equal(h.calls[0]?.init?.method, 'GET');
  assert.equal(h.calls[0]?.init?.body, undefined);
});

test('stargazers: three pages are followed to the last and each handed to onPage', async () => {
  const pageOne = [{ user: { login: 'a' }, starred_at: '2026-09-01T00:00:00Z' }];
  const pageTwo = [{ user: { login: 'b' }, starred_at: '2026-09-02T00:00:00Z' }];
  const pageThree = [
    { user: { login: 'c' }, starred_at: '2026-09-03T00:00:00Z' },
    { user: { login: 'd' }, starred_at: '2026-09-04T00:00:00Z' },
  ];
  const h = harness(new Map([
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=1`,
      { status: 200, payload: pageOne,
        link: '<https://api.github.com/repos/example/repo/stargazers?per_page=100&page=2>; rel="next", <https://api.github.com/repos/example/repo/stargazers?per_page=100&page=3>; rel="last"' }],
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=2`,
      { status: 200, payload: pageTwo,
        link: '<https://api.github.com/repos/example/repo/stargazers?per_page=100&page=1>; rel="prev", <https://api.github.com/repos/example/repo/stargazers?per_page=100&page=3>; rel="next"' }],
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=3`,
      { status: 200, payload: pageThree,
        link: '<https://api.github.com/repos/example/repo/stargazers?per_page=100&page=2>; rel="prev"' }],
  ]));
  /** @type {number[]} */ const pages = [];
  /** @type {number[]} */ const sizes = [];
  const summary = await h.client.stargazerStars(repo, (entries, page) => {
    pages.push(page);
    sizes.push(entries.length);
  });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(sizes, [1, 1, 2]);
  assert.deepEqual(summary, { pages: 3, entries: 4 });
  assert.deepEqual(h.calls.map((call) => new URL(call.url).searchParams.get('page')), ['1', '2', '3']);
  for (const call of h.calls) {
    assert.equal(headersOf(call.init).get('Accept'), 'application/vnd.github.star+json');
  }
});

test('stargazers: an async onPage callback is awaited and order preserved', async () => {
  const h = harness(new Map([
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=1`,
      { status: 200, payload: [{ starred_at: '2026-09-01T00:00:00Z' }],
        link: '<https://api.github.com/repos/example/repo/stargazers?per_page=100&page=2>; rel="next"' }],
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=2`,
      { status: 200, payload: [{ starred_at: '2026-09-02T00:00:00Z' }] }],
  ]));
  /** @type {string[]} */ const seen = [];
  await h.client.stargazerStars(repo, async (entries) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    seen.push(String(entries[0]?.starred_at));
  });
  assert.deepEqual(seen, ['2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z']);
});

test('stargazers: a single page with no Link header ends pagination', async () => {
  const h = harness(new Map([
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=1`,
      { status: 200, payload: [] }],
  ]));
  let invocations = 0;
  const summary = await h.client.stargazerStars(repo, () => { invocations += 1; });
  assert.equal(invocations, 1);
  assert.deepEqual(summary, { pages: 1, entries: 0 });
  assert.equal(h.calls.length, 1);
});

test('stargazers: entry records pass through untouched, unknown fields kept', async () => {
  const entry = { user: { login: 'a', future: 1 }, starred_at: '2026-09-01T00:00:00Z', future_field: null };
  const h = harness(new Map([
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=1`,
      { status: 200, payload: [entry] }],
  ]));
  /** @type {unknown} */ let seen;
  await h.client.stargazerStars(repo, (entries) => { seen = entries[0]; });
  assert.deepEqual(seen, entry);
});

test('stargazers: a malformed payload rejects without buffering', async () => {
  const h = harness(new Map([
    [`https://api.github.com/repos/example/repo/stargazers?per_page=100&page=1`,
      { status: 200, payload: { not: 'an array' } }],
  ]));
  await assert.rejects(h.client.stargazerStars(repo, () => {}), /must be an array/);
  assert.equal(h.calls.length, 1);
});

test('stargazers: non-function onPage and bad repo are refused before any request', async () => {
  const h = harness(new Map());
  // @ts-expect-error Runtime guard for callers not checked by TypeScript.
  await assert.rejects(h.client.stargazerStars(repo, null), /onPage callback is required/);
  await assert.rejects(h.client.stargazerStars('example', () => {}), /owner\/name pair/);
  assert.equal(h.calls.length, 0);
});
