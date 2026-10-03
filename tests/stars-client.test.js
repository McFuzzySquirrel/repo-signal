import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpTransport } from '../src/github/http.js';
import { createRetryPolicy, GitHubRequestError } from '../src/github/retry.js';
import {
  createStarsClient, STAR_HISTORY_ENDPOINT_TYPE, STAR_HISTORY_PER_PAGE,
} from '../src/github/stars-client.js';

// Contract: https://docs.github.com/en/rest/activity/starring#list-repository-star-history
// The `/stargazers` listing is restricted to admins and collaborators from July 2026,
// so this client reads `/stargazers/history`, which that restriction does not cover.
// Pages end on the Link rel="next"; a week is { week, total, days[7] }.
const token = `github_pat_${'FAKE_TEST_ONLY_'.repeat(4)}`;
const repo = 'example/repo';
const PAGE_ONE = `${'https://api.github.com/repos/example/repo/stargazers/history'}?per_page=${STAR_HISTORY_PER_PAGE}&page=1`;

/** @param {number} daysAgo Midnight UTC, whole days ago. @returns {number} Unix seconds. */
function weekStart(daysAgo) {
  return Math.floor(Date.parse(`2026-10-04T00:00:00.000Z`) / 1000) - daysAgo * 86_400;
}

/**
 * @param {Map<string, {status: number, payload: unknown, link?: string}>} pages
 */
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
    sleep: async () => { assert.fail('star history fixture must not sleep'); },
    random: () => 1,
  });
  return { client: createStarsClient({ policy }), calls };
}

/** @param {RequestInit | undefined} init @returns {Headers} */
function headersOf(init) { return new Headers(init?.headers); }

test('star history: the request is a GET with no body, at the page size the vendor caps', async () => {
  const h = harness(new Map([[PAGE_ONE, { status: 200, payload: [] }]]));
  await h.client.starHistory(repo, async () => {});
  assert.match(String(h.calls[0]?.url), /\/repos\/example\/repo\/stargazers\/history\?per_page=30&page=1$/);
  assert.equal(h.calls[0]?.init?.method, 'GET');
  assert.equal(h.calls[0]?.init?.body, undefined);
});

/** @param {number} page @returns {string} The URL the vendor would advertise for `page`. */
function pageUrl(page) {
  return `https://api.github.com/repos/example/repo/stargazers/history?per_page=${STAR_HISTORY_PER_PAGE}&page=${page}`;
}

/** @param {number} page @returns {string} An RFC 8288 Link header advertising `page` as next. */
function nextLink(page) {
  return `<${pageUrl(page)}>; rel="next"`;
}

test('star history: three weeks pages are followed to the last and each handed to onPage', async () => {
  const h = harness(new Map([
    [PAGE_ONE, { status: 200, payload: [{ week: weekStart(0), total: 0, days: [0, 0, 0, 0, 0, 0, 0] }],
      link: nextLink(2) }],
    [pageUrl(2), { status: 200, payload: [{ week: weekStart(7), total: 1, days: [0, 0, 0, 0, 1, 0, 0] }],
      link: nextLink(3) }],
    [pageUrl(3), { status: 200, payload: [{ week: weekStart(14), total: 2, days: [0, 0, 0, 1, 1, 0, 0] }] }],
  ]));
  /** @type {Array<{page: number, count: number}>} */
  const seen = [];
  const summary = await h.client.starHistory(repo, (weeks, page) => { seen.push({ page, count: weeks.length }); });
  assert.deepEqual(seen, [{ page: 1, count: 1 }, { page: 2, count: 1 }, { page: 3, count: 1 }]);
  assert.deepEqual(summary, { pages: 3, weeks: 3, truncated: false });
});

test('star history: a single page with no Link header ends pagination', async () => {
  const h = harness(new Map([[PAGE_ONE, { status: 200, payload: [] }]]));
  const summary = await h.client.starHistory(repo, async () => {});
  assert.deepEqual(summary, { pages: 1, weeks: 0, truncated: false });
  assert.equal(h.calls.length, 1);
});

test('star history: a 403 is refused as a star-history restriction, attempted once', async () => {
  const h = harness(new Map([[PAGE_ONE, { status: 403, payload: {} }]]));
  await assert.rejects(h.client.starHistory(repo, async () => {}), (error) => {
    assert.ok(error instanceof GitHubRequestError);
    assert.equal(error.kind, 'permission-missing');
    assert.equal(error.status, 403);
    assert.equal(error.endpointType, STAR_HISTORY_ENDPOINT_TYPE);
    assert.equal(error.attempts, 1);
    assert.match(error.action, /refused the star history for this token/);
    assert.equal(/grant the required token permissions/i.test(error.action), false);
    return true;
  });
  assert.equal(h.calls.length, 1, 'a refusal is not retried');
});

test('star history: a malformed payload is refused rather than reinterpreted', async () => {
  /** @type {Array<[string, unknown]>} */
  const cases = [
    ['response must be valid JSON', 'not json'],
  ];
  for (const [detail, payload] of cases) {
    const h = harness(new Map([[PAGE_ONE, { status: 200, payload }]]));
    await assert.rejects(
      h.client.starHistory(repo, async () => {}),
      new RegExp(`star history response contract|${detail}`),
    );
  }
});

test('star history: a week that disagrees with its own days is refused, not reconciled', async () => {
  // A total that does not match its days means the record is not what this client
  // understands. Reconciling it would invent a distribution across the week.
  const bad = [
    { week: weekStart(7), total: 5, days: [0, 0, 0, 1, 1, 0, 0] },
    { week: weekStart(7), total: 0, days: [0, 0, 0, 1, 1, 0, 0] },
    { week: weekStart(7), total: 2, days: [0, 0, 0, 1] },
    { week: weekStart(7), total: 2, days: [0, 0, 0, 1, 1, 0, -1] },
    { week: 0, total: 0, days: [0, 0, 0, 0, 0, 0, 0] },
  ];
  for (const payload of bad) {
    const h = harness(new Map([[PAGE_ONE, { status: 200, payload: [payload] }]]));
    await assert.rejects(h.client.starHistory(repo, async () => {}), /star history response contract/);
  }
});

test('star history: the page cap reports truncation instead of a complete history', async () => {
  // GitHub will not page past 100. A series longer than that is cut short, and the
  // reading says so rather than letting a partial history look whole.
  let served = 0;
  const calls = [];
  const transport = createHttpTransport({
    credentialProvider: { getToken: () => token },
    fetch: async (url) => {
      calls.push(String(url));
      served += 1;
      const headers = new Headers();
      headers.set('link', `<${String(url).replace(/page=\d+/, `page=${served + 1}`)}>; rel="next"`);
      return new Response(JSON.stringify([{ week: weekStart(7 * served), total: 0, days: [0, 0, 0, 0, 0, 0, 0] }]),
        { status: 200, headers });
    },
  });
  const policy = createRetryPolicy({ transport, clock: () => 0, sleep: async () => {}, random: () => 1 });
  const summary = await createStarsClient({ policy }).starHistory(repo, async () => {});
  assert.equal(summary.truncated, true, 'a series past the cap is reported as truncated');
  assert.equal(summary.pages, 100, 'the cap is the page count this client requested');
  assert.equal(calls.length, 100, 'no page beyond the vendor cap is requested');
});