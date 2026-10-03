import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../../src/collect/traffic.js';
import { calendarDays, upsertDayFact } from '../../src/db/day-series-repo.js';
import { appendRun, openArchive, upsertRepository, withTransaction } from '../../src/db/ops-repo.js';
import { resolveHomePaths } from '../../src/paths.js';
import { escapeAttribute, escapeText, escapeUrl } from '../../src/server/html.js';
import { createRouter } from '../../src/server/router.js';
import {
  DEFAULT_WINDOW_DAYS, ROUTE_INDEX, ROUTE_LIST, VIEW_MOUNT_TABLE, VIEW_ROUTES,
  createViewRegistry, resolvePageRange,
} from '../../src/server/views/index.js';
import {
  NO_STORED_VALUE_TEXT, readIndexPage, readRepositoryListPage, renderIndexPage, renderRepositoryListPage,
} from '../../src/server/views/repo-list.js';
import { collectionHealth } from '../../src/supervision/health.js';
import { recordFailure, recordSuccess } from '../../src/supervision/repo-state-reporter.js';

/**
 * The registry and the two pages it mounts, driven through the real router over a
 * real migrated archive.
 *
 * Everything a page shows is written through the product's own writes - identities
 * through the repository upsert, day facts through the day-series upsert, collection
 * state through the supervision recorder - so a page that renders plausibly over the
 * wrong data still fails here. The views are mounted by the product's registry and
 * rendered by the product's shell and escaping helpers; nothing in this file renders
 * markup by hand, because a test that escaped its own fixture would prove something
 * about the test.
 */

/** @typedef {import('../../src/server/router.js').PageContext} PageContext */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VIEWS_DIRECTORY = path.join(ROOT, 'src', 'server', 'views');
const REGISTRY_FILE = path.join(VIEWS_DIRECTORY, 'index.js');

/** The window every fixture selects explicitly, so the page states the range it read. */
const FROM = '2026-09-20';
const TO = '2026-10-02';
/** The interior day no run recorded: the gap the list page has to name. */
const HOLE = '2026-09-26';

const OWNER = 'maintainer';
const NAME = 'archive';
const QUIET_NAME = 'quiet';
/** RS-SP-07: an identity whose stored spelling is markup, not a name. */
const HOSTILE_OWNER = 'own&er';
const HOSTILE_NAME = '"><script>alert(1)</script>';
const HOSTILE_LABEL = `${HOSTILE_OWNER}/${HOSTILE_NAME}`;

const RUN_ONE = '2026-09-20T06:00:00.000Z';
const COLLECTED_AT = '2026-10-02T06:00:05.000Z';
const FAILED_AT = '2026-10-02T06:30:00.000Z';
/** The instant the page's health read is taken: six hours after the recorded success. */
const READ_AT_MS = Date.parse('2026-10-02T12:00:00.000Z');

/** The four traffic metrics, with one value each so no two columns can share a number by accident. */
const TRAFFIC_SEED = /** @type {readonly {metric: string, value: (index: number) => number}[]} */ ([
  { metric: CLONES_METRIC, value: (index) => 10 + index },
  { metric: UNIQUE_CLONERS_METRIC, value: (index) => 1 + (index % 3) },
  { metric: VIEWS_METRIC, value: (index) => 100 + index * 5 },
  { metric: UNIQUE_VISITORS_METRIC, value: (index) => 20 + (index % 4) },
]);

/**
 * @param {string} metric
 * @param {number} index Position in the stored-day list.
 * @returns {number} The value the fixture wrote for that metric on that day.
 */
function seedValue(metric, index) {
  const entry = TRAFFIC_SEED.find((candidate) => candidate.metric === metric);
  return entry === undefined ? 0 : entry.value(index);
}

/**
 * @typedef {object} Fixture
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {ReturnType<typeof createViewRegistry>} registry
 * @property {ReturnType<typeof createRouter>} router
 */

/**
 * What driving the router needs, so an empty archive can be exercised through the
 * same helper as the seeded one.
 * @typedef {{ router: ReturnType<typeof createRouter> }} Routable
 */

/**
 * A temporary home holding a migrated archive with three enrolled repositories: one
 * collected over the window with a deliberate hole in it, one that has never run, and
 * one whose recorded failure was a rejected permission, plus the identity whose
 * stored spelling is markup.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<Fixture>}
 */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-list-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());

  const window = calendarDays(FROM, TO);
  const collected = window.filter((day) => day !== HOLE);

  upsertRepository(db, { id: 1, owner: OWNER, name: NAME, lastSeenAt: RUN_ONE, enrolled: 1 });
  upsertRepository(db, { id: 2, owner: OWNER, name: QUIET_NAME, lastSeenAt: RUN_ONE, enrolled: 1 });
  upsertRepository(db, { id: 3, owner: OWNER, name: 'refused', lastSeenAt: FAILED_AT, enrolled: 1 });
  upsertRepository(db, { id: 4, owner: HOSTILE_OWNER, name: HOSTILE_NAME, lastSeenAt: RUN_ONE, enrolled: 1 });
  appendRun(db, { id: 'run-1', startedAt: RUN_ONE });

  // The collected repository: four metrics a day, minus the day no run recorded.
  withTransaction(db, () => {
    collected.forEach((day, index) => {
      for (const entry of TRAFFIC_SEED) {
        upsertDayFact(db, {
          repositoryId: 1, metric: entry.metric, granularity: 'day', day,
          value: entry.value(index), source: 'collected', collectedAt: COLLECTED_AT,
        });
      }
    });
    // The hostile identity holds real numbers too, so a page that showed it well
    // would still have had to escape it.
    for (const entry of TRAFFIC_SEED) {
      upsertDayFact(db, {
        repositoryId: 4, metric: entry.metric, granularity: 'day', day: TO,
        value: 7, source: 'collected', collectedAt: COLLECTED_AT,
      });
    }
  });
  recordSuccess({ db, repositoryId: 1, collectedAt: COLLECTED_AT });
  recordSuccess({ db, repositoryId: 4, collectedAt: COLLECTED_AT });

  // A rejected traffic permission: the state the CLI shows, recorded the way a run
  // records it, so this page cannot report a different word than the command does.
  recordFailure({
    db, repositoryId: 3, runId: 'run-1', repo: `${OWNER}/refused`, endpointType: 'traffic',
    error: { status: 403 }, collectedAt: FAILED_AT,
  });

  const registry = createViewRegistry({ db, clock: () => READ_AT_MS, today: TO });
  const router = createRouter({ views: registry.views, hasRepository: registry.hasRepository });
  return { db, registry, router };
}

/**
 * Drive the real router and read the whole document it renders.
 * @param {Routable} f
 * @param {string} url
 * @returns {Promise<{status: number, body: string}>}
 */
async function request(f, url) {
  const response = await f.router(/** @type {any} */ ({ url }));
  return typeof response === 'string' ? { status: 200, body: response } : response;
}

/**
 * Every heading in the served markup, in document order, as its level.
 * @param {string} body
 * @returns {number[]}
 */
function headingLevels(body) {
  return [...body.matchAll(/<h([1-6])\b[^>]*>/g)].map((match) => Number(match[1]));
}

/**
 * Every addressable reference the served markup carries.
 * @param {string} body
 * @returns {string[]}
 */
function referencesOf(body) {
  return [...body.matchAll(/\b(?:href|src|srcset)\s*=\s*"([^"]*)"/g)].map((match) => match[1] ?? '');
}

/**
 * The document with every class attribute removed: what a reader - or a forced
 * colours mode - is left with when no styling applies at all.
 * @param {string} body
 * @returns {string}
 */
function withoutClasses(body) {
  return body.replaceAll(/\sclass="[^"]*"/g, '');
}

test('the registry maps the index, list and detail routes to a view module export', async (t) => {
  // Arrange: the real registry over a real archive.
  const f = await fixture(t);

  // Act and assert, in three parts: the mount table is the whole mapping, the
  // registry mounts exactly those routes, and each renderer answers its own route.
  assert.deepEqual([...VIEW_ROUTES], ['index', 'list', 'detail'], 'the three routes the router serves');
  assert.deepEqual(Object.keys(VIEW_MOUNT_TABLE).sort(), ['detail', 'index', 'list'],
    'the mount table holds one entry per route and nothing else');
  assert.deepEqual(Object.keys(f.registry.views).sort(), ['detail', 'index', 'list'],
    'the registry the router mounts answers exactly those routes');
  for (const route of VIEW_ROUTES) {
    assert.equal(typeof f.registry.views[route], 'function', `the ${route} route has a renderer`);
    assert.equal(f.registry.mounts[route], VIEW_MOUNT_TABLE[route], `the ${route} mount is the table's entry`);
  }
  assert.equal(VIEW_MOUNT_TABLE[ROUTE_INDEX].read, readIndexPage, 'the index reads through its own module');
  assert.equal(VIEW_MOUNT_TABLE[ROUTE_INDEX].render, renderIndexPage, 'the index renders through its own module');
  assert.equal(VIEW_MOUNT_TABLE[ROUTE_LIST].read, readRepositoryListPage, 'the list reads through its own module');
  assert.equal(VIEW_MOUNT_TABLE[ROUTE_LIST].render, renderRepositoryListPage, 'the list renders through its own module');

  // Each route really produces its own page when the router asks for it.
  const index = await request(f, '/');
  const list = await request(f, `/repos?from=${FROM}&to=${TO}`);
  const detail = await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?from=${FROM}&to=${TO}`);
  assert.equal(index.status, 200);
  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.match(index.body, /<title>RepoSignal<\/title>/, 'the index is its own page');
  assert.match(list.body, /<h1>Enrolled repositories<\/h1>/, 'the list is its own page');
  assert.match(detail.body, /<h1>Repository detail<\/h1>/, 'the detail URL answers with the list page');
  assert.match(detail.body, /no per-repository detail page yet/, 'the degraded detail page says so in words');
  assert.ok(detail.body.includes(escapeText(`The repository this URL asks for is ${OWNER}/${NAME}.`)),
    `the detail page names the repository the route asked for; got ${JSON.stringify(detail.body.slice(0, 700))}`);

  // The titles are distinct per page, which is what a history entry and a browser
  // tab rely on.
  const titles = [index.body, list.body, detail.body].map((page) => /<title>([^<]*)<\/title>/.exec(page)?.[1]);
  assert.equal(new Set(titles).size, 3, `each page carries its own title; got ${JSON.stringify(titles)}`);
});

test('the list page links each repository to its own detail page carrying the range', async (t) => {
  // Arrange: the registry over the seeded archive, asked for an explicit range.
  const f = await fixture(t);

  // Act: the list page for the selected window.
  const list = await request(f, `/repos?from=${FROM}&to=${TO}`);

  // Assert: every enrolled repository appears with a link to its own detail page, and
  // the link carries both bounds so the target reproduces the same window.
  assert.equal(list.status, 200);
  for (const [owner, name] of [[OWNER, NAME], [OWNER, QUIET_NAME], [OWNER, 'refused'], [HOSTILE_OWNER, HOSTILE_NAME]]) {
    const href = `/repo/${escapeUrl(owner)}/${escapeUrl(name)}?from=${FROM}&to=${TO}`;
    assert.ok(list.body.includes(`href="${escapeAttribute(href)}"`),
      `the list must link ${escapeText(`${owner}/${name}`)} to ${href}; got ${JSON.stringify(list.body)}`);
  }
  // One click from the list to a repository, per RS-ST-01: the link is inside the
  // repository's own row, not in a separate column.
  const row = /<tr data-repository="maintainer\/archive">.*?<\/tr>/s.exec(list.body);
  assert.ok(row !== null, `the collected repository has a row; got ${JSON.stringify(list.body)}`);
  assert.ok(row[0].includes(`href="/repo/${OWNER}/${NAME}?from=${FROM}&amp;to=${TO}"`),
    `the row's own cell links to the repository; got ${JSON.stringify(row[0])}`);

  // The state the CLI shows is the state the page shows: both come from the one read.
  assert.match(list.body, /never-collected/, 'a repository that has never run reads as never collected');
  assert.match(list.body, /needs-re-authentication/, 'a refused token reads as needing re-authentication');
  assert.match(list.body, /healthy/, 'a repository inside the threshold reads as healthy');
});

test('a repository name carrying markup is escaped in every context and raw nowhere', async (t) => {
  // Arrange: the archive holds an identity whose stored spelling is markup.
  const f = await fixture(t);

  // Act: render both pages that name it.
  const list = await request(f, `/repos?from=${FROM}&to=${TO}`);
  const detail = await request(f, `/repo/${escapeUrl(HOSTILE_OWNER)}/${escapeUrl(HOSTILE_NAME)}?from=${FROM}&to=${TO}`);
  const href = `/repo/${escapeUrl(HOSTILE_OWNER)}/${escapeUrl(HOSTILE_NAME)}?from=${FROM}&to=${TO}`;

  for (const [label, page] of /** @type {Array<[string, {status: number, body: string}]>} */ ([
    ['list', list], ['detail', detail],
  ])) {
    assert.equal(page.status, 200, `${label}: a stored identity is a page, not an error`);
    // Escaped in each context the product defines for it.
    assert.ok(page.body.includes(escapeText(HOSTILE_LABEL)), `${label}: escaped in text context`);
    assert.ok(page.body.includes(`data-repository="${escapeAttribute(HOSTILE_LABEL)}"`),
      `${label}: attribute escaped where it is carried`);
    assert.ok(page.body.includes(`href="${escapeAttribute(href)}"`), `${label}: percent-encoded in URL context`);
    // Unescaped nowhere: not as markup, not as the raw stored spelling.
    assert.equal(page.body.includes(HOSTILE_NAME), false, `${label}: the raw name appears nowhere`);
    assert.equal(page.body.includes('"><script'), false, `${label}: the payload cannot close an attribute`);
    assert.equal(/<script/i.test(page.body), false, `${label}: no script element reaches the page`);
    assert.equal(page.body.includes('<img'), false, `${label}: no injected element of any kind`);
  }
  // Escaping happens on the way out: the archive still holds the spelling a
  // collector recorded, byte for byte.
  const stored = /** @type {{owner: string, name: string}} */ (/** @type {unknown} */ (
    f.db.prepare('SELECT owner, name FROM repositories WHERE id=4').get()));
  assert.equal(stored.owner, HOSTILE_OWNER);
  assert.equal(stored.name, HOSTILE_NAME);
});

test('the pages are deterministic: the same input renders byte-identical markup', async (t) => {
  // Arrange: the same registry and the same fixed clock, so any difference between
  // two renders came from the render itself.
  const f = await fixture(t);
  /** @type {PageContext} */
  const listContext = {
    route: 'list', owner: null, name: null, from: FROM, to: TO,
    links: {
      index: '/',
      list: `/repos?from=${FROM}&to=${TO}`,
      detail: (owner, name) => `/repo/${owner}/${name}?from=${FROM}&to=${TO}`,
    },
  };

  // Act: render each page twice through its own renderer, and once more through the
  // whole router.
  const first = f.registry.views.list(listContext);
  const second = f.registry.views.list(listContext);
  assert.equal(first, second, 'two renders of the list page are byte-identical');
  const third = await request(f, `/repos?from=${FROM}&to=${TO}`);
  assert.equal(first, third.body, 'the rendered page is the page the router serves');

  const indexContext = /** @type {PageContext} */ ({ ...listContext, route: 'index' });
  assert.equal(f.registry.views.index(indexContext), f.registry.views.index(indexContext),
    'two renders of the index page are byte-identical');

  // The detail route and the list route are the same page over the same window.
  const detailContext = /** @type {PageContext} */ ({ ...listContext, route: 'detail', owner: OWNER, name: NAME });
  assert.equal(f.registry.views.detail(detailContext), f.registry.views.detail(detailContext));
});

test('the pages carry no script, no handler, no remote reference and no colour literal', async (t) => {
  // Arrange: every page the three routes produce, including a refusal.
  const f = await fixture(t);
  const pages = /** @type {Array<[string, {status: number, body: string}]>} */ ([
    ['index', await request(f, '/')],
    ['list', await request(f, `/repos?from=${FROM}&to=${TO}`)],
    ['detail', await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?from=${FROM}&to=${TO}`)],
    ['unknown repository', await request(f, `/repo/${escapeUrl(OWNER)}/never-enrolled`)],
  ]);

  for (const [label, page] of pages) {
    assert.equal(/<script/i.test(page.body), false, `${label}: no script element`);
    assert.equal(/<[^>]+\son[a-z]+\s*=/i.test(page.body), false, `${label}: no inline event handler`);
    assert.equal(/https?:\/\//i.test(page.body.replaceAll(`http://127.0.0.1`, '')), false,
      `${label}: the page names no remote host`);
    assert.equal(/@import|@font-face|url\(/i.test(page.body), false, `${label}: no imported font, style or image`);
    assert.equal(/transition\s*:|animation\s*:/i.test(page.body), false, `${label}: no motion`);
    assert.equal(/#[0-9a-f]{3,8}\b|\brgba?\(/i.test(page.body), false, `${label}: no colour literal in markup`);
    assert.ok(referencesOf(page.body).length > 0, `${label}: the page references its stylesheet`);
    for (const reference of referencesOf(page.body)) {
      assert.match(reference, /^(#|\/(?!\/))/, `${label}: every reference is a relative same-origin path; got ${reference}`);
    }
  }
});

test('every page has one main landmark, a skip link first, a heading order with no gap, and a caption', async (t) => {
  // Arrange: the three rendered pages.
  const f = await fixture(t);
  const pages = [
    ['index', (await request(f, '/')).body],
    ['list', (await request(f, `/repos?from=${FROM}&to=${TO}`)).body],
    ['detail', (await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?from=${FROM}&to=${TO}`)).body],
  ];

  for (const [label, body] of pages) {
    // One main landmark, and the skip link is the first focusable element in it.
    assert.equal(body.match(/<main\b/g)?.length, 1, `${label}: exactly one main landmark`);
    assert.match(body, /<a class="skip-link" href="#main">/, `${label}: a skip link is present`);
    const focusable = [...body.matchAll(/<a\b[^>]*>|<button\b[^>]*>|<input\b[^>]*>/g)][0]?.[0] ?? '';
    assert.match(focusable, /href="#main"/, `${label}: the skip link is the first focusable element`);
    // The language and the title.
    assert.match(body, /<html lang="en">/, `${label}: the language is declared`);
    assert.match(body, /<title>[^<]+<\/title>/, `${label}: the page has a title`);
    // The heading order skips no level and starts at one.
    const levels = headingLevels(body);
    assert.ok(levels.length > 0, `${label}: the page has headings`);
    assert.equal(levels[0], 1, `${label}: the first heading is the page heading`);
    for (let index = 1; index < levels.length; index += 1) {
      const previous = /** @type {number} */ (levels[index - 1]);
      const current = /** @type {number} */ (levels[index]);
      assert.ok(current <= previous + 1,
        `${label}: heading level ${current} follows ${previous}, which skips a level`);
    }
  }

  // Every figure the pages contain is paired with a data table; the list page's table
  // carries its caption and a header cell per column.
  const list = /** @type {string} */ (pages[1][1]);
  assert.match(list, /<table class="repositories">/, 'the list page renders a table');
  assert.match(list, /<caption>[^<]*<\/caption>/, 'the table carries a caption naming what it holds');
  const headers = [...list.matchAll(/<th scope="col"[^>]*>/g)];
  const rowHeaders = [...list.matchAll(/<th scope="row"/g)];
  assert.equal(headers.length, 7, 'the table has a header cell per column');
  assert.equal(rowHeaders.length, 4, 'each repository is a row header, so a cell is named without its row');
});

test('a missing day is named and never written as a zero', async (t) => {
  // Arrange: the archive really holds no row for the hole, and the fixture really
  // holds a row for every other day of the window.
  const f = await fixture(t);
  const stored = Number(/** @type {{n: number}} */ (/** @type {unknown} */ (f.db.prepare(
    `SELECT count(*) AS n FROM day_series WHERE repository_id=1 AND metric=? AND day BETWEEN ? AND ?`)
    .get(CLONES_METRIC, FROM, TO))).n);
  assert.equal(stored, calendarDays(FROM, TO).length - 1, 'the fixture has exactly one interior hole');

  // Act: the list page over that window.
  const list = await request(f, `/repos?from=${FROM}&to=${TO}`);

  // Assert: the hole is named as the calendar day it is, and no cell claims a value
  // for it. The total is a sum over stored days and says so.
  assert.ok(list.body.includes(escapeText(HOLE)),
    `the missing day is named on the page; got ${JSON.stringify(list.body)}`);
  assert.match(list.body, /unmeasured, not zero\./, 'the gap is described as unmeasured rather than as a value');
  assert.match(list.body, /summed over 12 stored days of the 13 in the range/,
    'the total states how many stored days it sums');
  assert.equal(/>0</.test(list.body), false, 'no value cell holds a bare zero, so no unmeasured day became one');
  assert.equal(/13 stored day/.test(list.body), false, 'a day with no stored row is never counted as stored');
  // The sum really is the sum of the stored days, which the archive holds.
  const expected = Number(/** @type {{total: number}} */ (/** @type {unknown} */ (f.db.prepare(
    'SELECT sum(value) AS total FROM day_series WHERE repository_id=1 AND metric=? AND day BETWEEN ? AND ?')
    .get(CLONES_METRIC, FROM, TO))).total);
  const expectedViews = calendarDays(FROM, TO).filter((day) => day !== HOLE)
    .reduce((sum, day, index) => sum + seedValue(VIEWS_METRIC, index), 0);
  assert.ok(list.body.includes(`<span class="figure">${expected}</span>`),
    `the clones total is the archive's own sum of ${expected}`);
  assert.ok(list.body.includes(`<span class="figure">${expectedViews}</span>`),
    `the views total is the archive's own sum of ${expectedViews}`);
});

test('a per-day unique is shown for one day and never added up', async (t) => {
  // Arrange: the same fixture, whose unique-cloner values would inflate if summed.
  const f = await fixture(t);

  // Act: the list page over the window.
  const list = await request(f, `/repos?from=${FROM}&to=${TO}`);

  // Assert: the unique column carries one day's value and names that day, beside a
  // header that says so, and never a sum.
  assert.match(list.body, /Unique cloners on the last stored day/, 'the header states what the column is');
  const summed = calendarDays(FROM, TO).filter((day) => day !== HOLE)
    .reduce((sum, day, index) => sum + seedValue(UNIQUE_CLONERS_METRIC, index), 0);
  assert.equal(list.body.includes(`<span class="figure">${summed}</span>`), false,
    'a per-day unique is never summed across days');
  assert.match(list.body, /on 2026-10-02, the last day with a stored row/, 'the unique names the day it belongs to');
});

test('every collection state is announced as text that survives losing every class', async (t) => {
  // Arrange: three repositories with three different recorded states.
  const f = await fixture(t);

  // Act: the list page, and the same page with every class attribute stripped.
  const list = await request(f, `/repos?from=${FROM}&to=${TO}`);
  const stripped = withoutClasses(list.body);

  // Assert: each state word and its sentence are text, so no styling, colour or badge
  // carries the state.
  for (const word of ['healthy', 'never-collected', 'needs-re-authentication']) {
    assert.ok(stripped.includes(word), `the ${word} state is text once every class is removed`);
    assert.match(list.body, new RegExp(`data-state="${word}"`), `the row marks its state as ${word}`);
  }
  assert.match(stripped, /no successful collection has been recorded/, 'the never-collected state carries a sentence');
  assert.match(stripped, /the stored credential was refused/, 'the re-authentication state carries a sentence');
  // A repository that has never run carries the never-collected word, not the stalled
  // one: an install with nothing collected has no schedule to judge.
  assert.equal(list.body.includes('data-state="stalled"'), false, 'no row claims a stalled collection');
  const quietRow = /<tr data-repository="maintainer\/quiet">.*?<\/tr>/s.exec(list.body)?.[0] ?? '';
  assert.match(quietRow, /data-state="never-collected"/,
    'the repository that has never run is marked never-collected');
  assert.equal(/class="state-word">stalled</.test(quietRow), false,
    'a never-collected repository is never called stalled');
  // Every state word on the page is one the health read itself returns, so the page
  // and the CLI cannot disagree about it.
  const health = collectionHealth({ db: f.db, clock: () => READ_AT_MS });
  for (const entry of health.repositories) {
    assert.ok(stripped.includes(escapeText(entry.reason)),
      `the page shows the health read's own sentence for ${entry.repo}`);
  }
});

test('a repository with nothing stored reads as no stored value rather than as a zero', async (t) => {
  // Arrange: the never-collected repository holds no day fact at all.
  const f = await fixture(t);
  const stored = Number(/** @type {{n: number}} */ (/** @type {unknown} */ (f.db.prepare(
    'SELECT count(*) AS n FROM day_series WHERE repository_id=2').get())).n);
  assert.equal(stored, 0, 'the fixture really holds no observation for the quiet repository');

  // Act: the list page over the window.
  const list = await request(f, `/repos?from=${FROM}&to=${TO}`);

  // Assert: its four metric cells say so in words, and no figure stands in for them.
  const row = /<tr data-repository="maintainer\/quiet">.*?<\/tr>/s.exec(list.body);
  assert.ok(row !== null, `the quiet repository has a row; got ${JSON.stringify(list.body)}`);
  for (const entry of TRAFFIC_SEED) {
    assert.ok(row[0].includes(`data-metric="${entry.metric}" data-state="missing"`),
      `the ${entry.metric} cell reports a gap`);
  }
  assert.equal([...row[0].matchAll(new RegExp(NO_STORED_VALUE_TEXT, 'g'))].length, TRAFFIC_SEED.length,
    'every metric cell says there is no stored value');
  assert.equal(/<span class="figure">\d+<\/span>/.test(row[0]), false,
    'no figure at all stands in for the missing values');
});

test('a route carrying one bound resolves the window the registry declares and states it', async (t) => {
  // Arrange: the registry's own window policy, and the routes the range parameters
  // allow: one bound, or neither.
  const f = await fixture(t);
  const today = TO;
  const expectedFrom = new Date(Date.parse(`${today}T00:00:00.000Z`) - (DEFAULT_WINDOW_DAYS - 1) * 86_400_000)
    .toISOString().slice(0, 10);

  // Act and assert: the policy resolves a missing bound from today, keeping the bound
  // the route did carry exactly as the router validated it.
  assert.deepEqual(resolvePageRange(/** @type {any} */ ({ from: null, to: null }), today),
    { from: expectedFrom, to: today, refusal: null });
  assert.deepEqual(resolvePageRange(/** @type {any} */ ({ from: FROM, to: null }), today),
    { from: FROM, to: today, refusal: null });
  assert.deepEqual(resolvePageRange(/** @type {any} */ ({ from: null, to: TO }), today),
    { from: expectedFrom, to: TO, refusal: null });
  assert.throws(() => resolvePageRange(/** @type {any} */ ({ from: null, to: null }), 'not-a-day'),
    /ISO day/, 'a reference day that is not a calendar day is refused by name');

  // And each of those routes is served, over the window the page states.
  for (const [label, query, expected] of /** @type {Array<[string, string, string]>} */ ([
    ['no bounds', '', today],
    ['only a first day', `?from=${FROM}`, today],
    ['only a last day', `?to=${TO}`, TO],
  ])) {
    const page = await request(f, `/repos${query}`);
    assert.equal(page.status, 200, `a route with ${label} is served`);
    const shown = /Selected range: from ([0-9-]+) to ([0-9-]+)/.exec(page.body);
    assert.ok(shown !== null, `the page states the window it resolved; got ${JSON.stringify(page.body.slice(0, 400))}`);
    assert.equal(shown[2], expected, `the window the page states is the window it read for ${label}`);
    assert.equal(page.body.includes('The page could not be rendered'), false,
      'a half-range must not become a generic error page');
  }
});

test('an inverted range a one-sided route resolves is refused in words and shows no measurement', async (t) => {
  // Arrange: a route carrying a first day beyond today and no last day.
  const f = await fixture(t);
  const beyond = new Date(Date.parse(`${TO}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

  // Act: the list page for that route.
  const list = await request(f, `/repos?from=${beyond}`);

  // Assert: the page names the inversion instead of rendering a table, and nothing on
  // it claims a measurement.
  assert.equal(list.status, 200, 'the page is served; the router refuses an inverted pair, and this is one bound');
  assert.match(list.body, /the first day is later than the last/, 'the refusal names the problem in words');
  assert.ok(list.body.includes(escapeText(`${beyond} to ${TO}`)), 'the refusal names both bounds');
  assert.equal(list.body.includes('<table'), false, 'no table is rendered for a window that covers no day');
  assert.equal(list.body.includes('never-collected'), false, 'no repository state is reported for an unresolved window');
});

test('a home with nothing enrolled renders the empty state in words, not an empty table', async (t) => {
  // Arrange: a second home whose archive was migrated and holds no repository.
  const root = mkdtempSync('/tmp/opencode/repo-signal-list-empty-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  const registry = createViewRegistry({ db, clock: () => READ_AT_MS, today: TO });
  const empty = { registry, router: createRouter({ views: registry.views, hasRepository: registry.hasRepository }) };

  // Act: both pages over an archive with nothing in it.
  const list = await request(empty, `/repos?from=${FROM}&to=${TO}`);
  const index = await request(empty, `/?from=${FROM}&to=${TO}`);

  // Assert: the empty state is a sentence, the table is absent, and the next step names
  // the configuration field and a command this build registers.
  assert.equal(list.status, 200);
  assert.match(list.body, /No repository is enrolled/, 'the empty state is announced as text');
  assert.equal(list.body.includes('<table'), false, 'an empty table is not the empty state');
  assert.ok(list.body.includes('node src/cli.js collect'), 'the next step names a real command');
  assert.match(index.body, /empty:/, 'the index states the recorded roll-up for a home with nothing enrolled');
});

test('the mount table is the only place a view is mounted', () => {
  // Arrange: the files under the views directory, read as they are on disk.
  const names = readdirSync(VIEWS_DIRECTORY).filter((name) => name.endsWith('.js')).sort();
  const registrySource = readFileSync(REGISTRY_FILE, 'utf8');

  // Act and assert: every view module is imported by the registry, no view module
  // imports another, and the router imports none of them. That is what makes
  // "adding a page is a change in this file plus its own view module" true rather
  // than aspirational.
  assert.ok(names.includes('index.js'), 'the composition root is the registry itself');
  assert.ok(names.includes('repo-list.js'), 'the list page is its own module');
  for (const name of names) {
    if (name === 'index.js') continue;
    assert.match(registrySource, new RegExp(`from '\\./${name.replaceAll('.', String.raw`\.`)}'`),
      `the registry imports the view module ${name}`);
  }
  for (const name of names) {
    if (name === 'index.js') continue;
    const source = readFileSync(path.join(VIEWS_DIRECTORY, name), 'utf8');
    for (const other of names) {
      if (other === name) continue;
      assert.equal(source.includes(`from './${other}'`), false,
        `${name} must not import the view module ${other}; the registry mounts views`);
    }
  }
  const routerSource = readFileSync(path.join(ROOT, 'src', 'server', 'router.js'), 'utf8');
  assert.equal(routerSource.includes("from './views/"), false, 'the router never imports a view module');
});