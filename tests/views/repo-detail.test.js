import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { STARS_METRIC } from '../../src/backfill/stars.js';
import { stampFirstCollected } from '../../src/backfill/provenance.js';
import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../../src/collect/traffic.js';
import { GAP_CELL_TEXT } from '../../src/views/components/line-chart.js';
import { calendarDays, upsertDayFact } from '../../src/db/day-series-repo.js';
import { appendRun, openArchive, upsertRepository, withTransaction } from '../../src/db/ops-repo.js';
import { appendSnapshot } from '../../src/db/snapshot-repo.js';
import { resolveHomePaths } from '../../src/paths.js';
import { escapeAttribute, escapeText, escapeUrl } from '../../src/server/html.js';
import { createRouter } from '../../src/server/router.js';
import {
  ROUTE_DETAIL, VIEW_MOUNT_TABLE, createViewRegistry,
} from '../../src/server/views/index.js';
import {
  DETAIL_SECTION_ORDER, FIRST_CONNECT_STEP, readRepositoryDetailPage, renderRepositoryDetailPage,
} from '../../src/server/views/repo-detail.js';
import { collectionHealth } from '../../src/supervision/health.js';
import { recordFailure, recordSuccess } from '../../src/supervision/repo-state-reporter.js';

/**
 * The repository detail page, driven through the real router over a real migrated
 * archive, and through the mounted view registry.
 *
 * Everything the page shows is written through the product's own writes - identities
 * through the repository upsert, day facts through the day-series upsert, the
 * collection boundary through the provenance stamp, list captures through the
 * snapshot append, collection state through the supervision recorder - so a page that
 * renders plausibly over the wrong data still fails here. The page is mounted by the
 * product's registry, rendered by the product's shell and escaping helpers, and built
 * from the product's chart and insight modules; nothing in this file writes markup by
 * hand, because a test that rendered its own fixture would prove something about
 * itself.
 *
 * Five repositories, each one a state the page has to tell apart from the others:
 *
 * | id | repository | what it holds |
 * |----|------------|---------------|
 * | 1 | `maintainer/archive` | fourteen days with one interior hole, collected throughout |
 * | 2 | `maintainer/steady`   | fourteen complete days, boundary mid-window, backfill before it |
 * | 3 | `maintainer/quiet`    | enrolled and never collected: the first-connect case |
 * | 4 | `maintainer/refused`  | recorded data plus a rejected permission: a failure state |
 * | 5 | `own&er/"><script>`   | an identity whose stored spelling is markup |
 */

/** @typedef {import('../../src/server/router.js').PageContext} PageContext */

/** The fourteen-day window every fixture selects explicitly, so the page states the range it read. */
const FROM = '2026-09-19';
const TO = '2026-10-02';
/** The interior day no run recorded: the gap both the chart and the table have to name. */
const HOLE = '2026-09-26';
/**
 * The recorded collection boundary for the steady repository, inside its window: the
 * days before it are reconstructed on first connect and must not be drawn as though a
 * collection run had measured them.
 */
const BOUNDARY = '2026-09-26';

const OWNER = 'maintainer';
const STEADY = 'steady';
const QUIET = 'quiet';
const REFUSED = 'refused';
const PARTIAL = 'partial';
/** RS-SP-07: an identity whose stored spelling is markup, not a name. */
const HOSTILE_OWNER = 'own&er';
const HOSTILE_NAME = '"><script>alert(1)</script>';
const HOSTILE_LABEL = `${HOSTILE_OWNER}/${HOSTILE_NAME}`;

const RUN_ONE = '2026-09-19T06:00:00.000Z';
const COLLECTED_AT = '2026-10-02T06:00:05.000Z';
const CAPTURED_AT = '2026-10-02T06:00:04.000Z';
const EARLIER_CAPTURE_AT = '2026-09-26T06:00:04.000Z';
const FAILED_AT = '2026-10-02T06:30:00.000Z';
/** The instant the page's health read is taken: six hours after the recorded success. */
const READ_AT_MS = Date.parse('2026-10-02T12:00:00.000Z');

/** The four traffic metrics, with one distinct value each so no two columns can share a number by accident. */
const TRAFFIC_SEED = /** @type {readonly {metric: string, value: (index: number) => number}[]} */ ([
  { metric: CLONES_METRIC, value: (index) => 10 + index },
  { metric: UNIQUE_CLONERS_METRIC, value: (index) => 4 + (index % 3) },
  { metric: VIEWS_METRIC, value: (index) => 100 + index * 5 },
  { metric: UNIQUE_VISITORS_METRIC, value: (index) => 20 + (index % 4) },
]);

/** The referrer and popular-path captures one run recorded, in the vendor's own order. */
const REFERRERS = /** @type {readonly {label: string, count: number, uniques: number}[]} */ ([
  { label: 'github.com', count: 12, uniques: 9 },
  { label: 'news.ycombinator.com', count: 4, uniques: 4 },
  { label: 'duckduckgo.com', count: 2, uniques: 2 },
]);
const POPULAR_PATHS = /** @type {readonly {label: string, title: string|null, count: number, uniques: number}[]} */ ([
  { label: '/own&er/archive', title: null, count: 7, uniques: 6 },
  { label: '/own&er/archive/issues', title: 'Issues', count: 3, uniques: 2 },
]);

/**
 * @typedef {object} Fixture
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {ReturnType<typeof createViewRegistry>} registry
 * @property {ReturnType<typeof createRouter>} router
 */

/**
 * A temporary home holding a migrated archive with the five repositories above.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<Fixture>}
 */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-detail-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());

  const window = calendarDays(FROM, TO);
  const withHole = window.filter((day) => day !== HOLE);

  upsertRepository(db, { id: 1, owner: OWNER, name: 'archive', lastSeenAt: RUN_ONE, enrolled: 1 });
  upsertRepository(db, { id: 2, owner: OWNER, name: STEADY, lastSeenAt: RUN_ONE, enrolled: 1 });
  upsertRepository(db, { id: 3, owner: OWNER, name: QUIET, lastSeenAt: RUN_ONE, enrolled: 1 });
  upsertRepository(db, { id: 4, owner: OWNER, name: REFUSED, lastSeenAt: FAILED_AT, enrolled: 1 });
  upsertRepository(db, { id: 5, owner: HOSTILE_OWNER, name: HOSTILE_NAME, lastSeenAt: RUN_ONE, enrolled: 1 });
  // 6: a repository whose stored days start three days into the window, so the first
  // days of the range are gaps the chart has to draw and name.
  upsertRepository(db, { id: 6, owner: OWNER, name: 'partial', lastSeenAt: RUN_ONE, enrolled: 1 });
  appendRun(db, { id: 'run-1', startedAt: RUN_ONE });

  withTransaction(db, () => {
    // 1: fourteen days with one interior hole, every stored day backfilled before the
    // boundary and collected from it on.
    for (const day of withHole) writeTraffic(db, 1, day, day >= BOUNDARY ? 'collected' : 'backfill');
    // 2: fourteen complete days, the first seven reconstructed on first connect. This
    // repository holds a day for every day of the window, so the two differ only in
    // whether the archive has a row for the hole.
    for (const day of window) writeTraffic(db, 2, day, day >= BOUNDARY ? 'collected' : 'backfill');
    for (const day of window) writeStars(db, 2, day);
    // 4: a repository whose last run was refused, but which holds real numbers, so a
    // page that dropped a section in a failure state would be caught.
    for (const day of withHole) writeTraffic(db, 4, day, 'collected');
    // 5: the hostile identity holds numbers too, so a page that showed it well would
    // still have had to escape it.
    writeTraffic(db, 5, TO, 'collected');
    // 6: stored days only from the fourth day of the window on.
    for (const day of window.slice(3)) writeTraffic(db, 6, day, 'collected');
    for (const entry of REFERRERS) {
      appendSnapshot(db, {
        repositoryId: 1, runId: 'run-1', kind: 'referrers', label: entry.label,
        count: entry.count, uniques: entry.uniques, position: REFERRERS.indexOf(entry) + 1,
        collectedAt: CAPTURED_AT,
      });
      appendSnapshot(db, {
        repositoryId: 1, runId: 'run-1', kind: 'referrers', label: entry.label,
        count: entry.count + 1, uniques: entry.uniques + 1, position: REFERRERS.indexOf(entry) + 1,
        collectedAt: EARLIER_CAPTURE_AT,
      });
    }
    for (const entry of POPULAR_PATHS) {
      appendSnapshot(db, {
        repositoryId: 1, runId: 'run-1', kind: 'popular_paths', label: entry.label, title: entry.title,
        count: entry.count, uniques: entry.uniques, position: POPULAR_PATHS.indexOf(entry) + 1,
        collectedAt: CAPTURED_AT,
      });
    }
  });

  // The boundary is stamped the way a run stamps it, in the same transaction as the
  // traffic it describes, so a repository with collected days has a first collected day.
  stampFirstCollected(db, 1, { day: FROM, collectedAt: COLLECTED_AT });
  stampFirstCollected(db, 2, { day: BOUNDARY, collectedAt: COLLECTED_AT });
  stampFirstCollected(db, 4, { day: FROM, collectedAt: COLLECTED_AT });
  stampFirstCollected(db, 5, { day: TO, collectedAt: COLLECTED_AT });
  stampFirstCollected(db, 6, { day: window[3], collectedAt: COLLECTED_AT });
  recordSuccess({ db, repositoryId: 1, collectedAt: COLLECTED_AT });
  recordSuccess({ db, repositoryId: 2, collectedAt: COLLECTED_AT });
  recordSuccess({ db, repositoryId: 5, collectedAt: COLLECTED_AT });
  recordSuccess({ db, repositoryId: 6, collectedAt: COLLECTED_AT });
  // A rejected traffic permission: the state the CLI shows, recorded the way a run
  // records it, so this page cannot report a different word than the command does.
  recordFailure({
    db, repositoryId: 4, runId: 'run-1', repo: `${OWNER}/${REFUSED}`, endpointType: 'traffic',
    error: { status: 403 }, collectedAt: FAILED_AT,
  });

  const registry = createViewRegistry({ db, clock: () => READ_AT_MS, today: TO });
  const router = createRouter({ views: registry.views, hasRepository: registry.hasRepository });
  return { db, registry, router };
}

/**
 * Write one stored day of every traffic metric, the way a run writes them.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} repositoryId
 * @param {string} day
 * @param {'backfill'|'collected'} source The archive's own recorded source for the day.
 */
function writeTraffic(db, repositoryId, day, source) {
  const index = calendarDays(FROM, TO).indexOf(day);
  for (const entry of TRAFFIC_SEED) {
    upsertDayFact(db, {
      repositoryId,
      metric: entry.metric,
      granularity: 'day',
      day,
      value: entry.value(index),
      source,
      collectedAt: COLLECTED_AT,
    });
  }
}

/**
 * Write one stored star day, at the granularity and source the backfill writer uses:
 * a cumulative level recorded by reconstruction, never by a collection run.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} repositoryId
 * @param {string} day
 */
function writeStars(db, repositoryId, day) {
  const index = calendarDays(FROM, TO).indexOf(day);
  upsertDayFact(db, {
    repositoryId,
    metric: STARS_METRIC,
    granularity: 'day',
    day,
    value: 40 + index,
    source: 'backfill',
    collectedAt: COLLECTED_AT,
  });
}

/**
 * Drive the real router and read the whole document it renders.
 * @param {Fixture} f
 * @param {string} url
 * @returns {Promise<{status: number, body: string}>}
 */
async function request(f, url) {
  const response = await f.router(/** @type {any} */ ({ url }));
  return typeof response === 'string' ? { status: 200, body: response } : response;
}

/**
 * @param {string} owner
 * @param {string} name
 * @returns {string}
 */
function detailUrl(owner, name) {
  return `/repo/${escapeUrl(owner)}/${escapeUrl(name)}?from=${FROM}&to=${TO}`;
}

/**
 * The `h2` section headings in document order, with the section key each one labels.
 * @param {string} body
 * @returns {{key: string, text: string}[]}
 */
function sectionHeadings(body) {
  return [...body.matchAll(/<h2 id="([a-z-]+)-heading">(?:<[^>]*>)*([^<]*)</g)]
    .map((match) => ({ key: /** @type {string} */ (match[1]), text: /** @type {string} */ (match[2]) }));
}

/**
 * Every heading level in the served markup, in document order.
 * @param {string} body
 * @returns {number[]}
 */
function headingLevels(body) {
  return [...body.matchAll(/<h([1-6])\b[^>]*>/g)].map((match) => Number(match[1]));
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

/**
 * One figure's markup, from its opening element to the one that closes it. The chart
 * component nests its own table inside the figure, so the slice ends at the next
 * heading.
 * @param {string} body
 * @param {string} metric
 * @returns {string}
 */
function figureOf(body, metric) {
  const start = body.indexOf(`<figure class="chart" id="chart-${metric}-figure"`);
  assert.notEqual(start, -1, `the ${metric} figure is rendered; the page must carry one chart per metric`);
  const rest = body.slice(start + 1);
  const end = rest.indexOf('<h3');
  return end === -1 ? rest : rest.slice(0, end);
}

test('the registry mounts the detail route to the detail page', async (t) => {
  // Arrange: the real registry over a real archive.
  const f = await fixture(t);

  // Act and assert: the mount table names the detail page's own read and render, and
  // the router really serves that page for a detail URL.
  assert.equal(VIEW_MOUNT_TABLE[ROUTE_DETAIL].read, readRepositoryDetailPage,
    'the detail route reads through the detail page module');
  assert.equal(VIEW_MOUNT_TABLE[ROUTE_DETAIL].render, renderRepositoryDetailPage,
    'the detail route renders through the detail page module');
  const detail = await request(f, detailUrl(OWNER, 'archive'));
  assert.equal(detail.status, 200);
  assert.match(detail.body, /<h1>maintainer\/archive<\/h1>/, 'the detail URL answers with the detail page');
  assert.equal(/no per-repository detail page yet/.test(detail.body), false,
    'the page no longer degrades to the list');
  assert.match(detail.body, /data-repository="maintainer\/archive"/, 'the page names the repository it is about');
});

test('the sections appear in the order the legibility review recorded', async (t) => {
  // Arrange: one collected repository over the recorded window.
  const f = await fixture(t);

  // Act: the detail page for that repository.
  const detail = await request(f, detailUrl(OWNER, 'archive'));

  // Assert: the heading sequence is exactly the recorded order. Each section is
  // labelled with the same key it carries in DETAIL_SECTION_ORDER, so a section that
  // moves, is renamed or is dropped fails here rather than being noticed by eye.
  assert.equal(detail.status, 200);
  const headings = sectionHeadings(detail.body);
  assert.deepEqual(headings.map((heading) => heading.key), [...DETAIL_SECTION_ORDER],
    'the rendered sections are the recorded order');
  assert.equal(new Set(headings.map((heading) => heading.text)).size, headings.length,
    `every section carries its own heading; got ${JSON.stringify(headings)}`);
  // And the order is the documented one, not merely a permutation of these keys.
  assert.deepEqual([...DETAIL_SECTION_ORDER], [
    'current-numbers', 'acquisition', 'interest', 'comparison', 'clones-against-stars',
    'changes', 'captures', 'collection-state', 'provenance',
  ], 'the recorded order is the one the review and the feature document state');

  // Each section is a labelled landmark carrying its own heading, so the page can be
  // navigated by heading and a screen reader announces what it has entered.
  for (const key of DETAIL_SECTION_ORDER) {
    assert.ok(detail.body.includes(`<section class="detail-section detail-${key}" data-section="${key}" `
      + `aria-labelledby="${key}-heading">`),
    `the ${key} section is a labelled landmark naming its own heading`);
  }
});

test('a repository with no collected data renders a first-connect state and no chart element', async (t) => {
  // Arrange: an enrolled repository the archive has never collected, and therefore
  // holds no day of, and no first-collected stamp for.
  const f = await fixture(t);
  const stored = Number(/** @type {{n: number}} */ (/** @type {unknown} */ (f.db.prepare(
    'SELECT count(*) AS n FROM day_series WHERE repository_id=3').get())).n);
  assert.equal(stored, 0, 'the fixture really holds no stored day for this repository');

  // Act: its detail page.
  const detail = await request(f, detailUrl(OWNER, QUIET));

  // Assert: a first-connect state in words, naming the permission and the next step,
  // and no chart element of any kind - not an axes-only figure that would read as a
  // repository which measured nothing and reached zero.
  assert.equal(detail.status, 200);
  assert.match(detail.body, /data-state="first-connect"/, 'the page carries a first-connect state');
  const firstConnect = /<p class="no-chart-state" data-state="first-connect"[^>]*>([\s\S]*?)<\/p>/
    .exec(detail.body)?.[1] ?? '';
  assert.ok(firstConnect.includes('No collection has been recorded for this repository'),
    `the state names what is missing; got ${JSON.stringify(firstConnect)}`);
  assert.ok(firstConnect.includes(FIRST_CONNECT_STEP),
    `the state names the permission and the next step; got ${JSON.stringify(firstConnect)}`);
  assert.ok(FIRST_CONNECT_STEP.includes('Administration repository permission (read)'),
    'the next step names the permission a collection needs');
  assert.match(firstConnect, /<code>node src\/cli\.js collect<\/code>/, 'the next step names a command that exists');

  // No chart element anywhere on the page.
  assert.equal(detail.body.includes('<figure'), false, 'no figure is rendered for a repository with no data');
  assert.equal(detail.body.includes('<svg'), false, 'no svg is rendered for a repository with no data');
  assert.equal(detail.body.includes('class="chart-table"'), false, 'no chart table is rendered either');
  assert.equal(/<polyline/.test(detail.body), false, 'no series is drawn');

  // The sections are still all there, because a first-connect state is a state this
  // page reports rather than a reason to show less of it.
  assert.deepEqual(sectionHeadings(detail.body).map((heading) => heading.key), [...DETAIL_SECTION_ORDER],
    'every section renders in a first-connect state');

  // The numbers section reports the absence in words, never as a zero.
  assert.match(detail.body, /no stored value in this range/, 'an unstored metric says so in words');
  assert.equal(/>0</.test(detail.body), false, 'no figure cell holds a bare zero for an unmeasured day');
  assert.match(detail.body, /are unmeasured, not zero\./, 'the unmeasured days are named as unmeasured');
});

test('a window before the recorded boundary reads as an empty window, not as a first connect', async (t) => {
  // Arrange: the partial repository is connected - it holds collected days from
  // 2026-09-22 - and this window ends the day before its boundary.
  const f = await fixture(t);
  const boundary = /** @type {{day: string}} */ (/** @type {unknown} */ (f.db.prepare(
    `SELECT window_from AS day FROM backfill_records WHERE repository_id=6 AND kind='first-collected'`)
    .get())).day;
  assert.equal(boundary, '2026-09-22', 'the recorded boundary is the day its stored days begin');

  // Act: a window entirely before it.
  const response = await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(PARTIAL)}?from=2026-09-19&to=2026-09-21`);

  // Assert: a different state from a never-collected repository, with a different
  // remedy, and still no chart element.
  assert.equal(response.status, 200);
  const states = [...response.body.matchAll(/data-state="(first-connect|empty-window)"/g)]
    .map((match) => match[1]);
  assert.ok(states.length > 0, 'the page states which of the two empty readings this is');
  assert.equal(states.includes('first-connect'), false,
    'a connected repository whose window holds nothing is not called a first connect');
  assert.ok(states.includes('empty-window'), 'it is the empty-window reading');
  assert.match(response.body, /Collected history begins on 2026-09-22, which is outside the selected window/,
    'the state names the boundary the archive recorded and where the window sits relative to it');
  assert.match(response.body, /Choose a range that covers the boundary, or collect more days/,
    'and names a next step that is not "connect this repository"');
  assert.equal(response.body.includes('<figure'), false, 'no figure is drawn for an empty window');
  assert.equal(response.body.includes('<svg'), false, 'no svg is drawn for an empty window');
  assert.match(response.body, /Collected history begins on <strong>2026-09-22<\/strong>/,
    'the provenance caption still names the first collected day');
});

test('a day with no observation renders no zero and names the day in the text alternative', async (t) => {
  // Arrange: the archive really holds no row for the interior day of the window.
  const f = await fixture(t);
  const rows = Number(/** @type {{n: number}} */ (/** @type {unknown} */ (f.db.prepare(
    `SELECT count(*) AS n FROM day_series WHERE repository_id=1 AND metric=? AND day BETWEEN ? AND ?`)
    .get(CLONES_METRIC, FROM, TO))).n);
  assert.equal(rows, calendarDays(FROM, TO).length - 1, 'the fixture has exactly one interior hole');

  // Act: the clones chart on the detail page.
  const detail = await request(f, detailUrl(OWNER, 'archive'));
  const figure = figureOf(detail.body, CLONES_METRIC);

  // Assert: the hole breaks the line instead of being bridged. Two runs, neither of
  // which spans the missing day.
  const runs = [...figure.matchAll(/<polyline[^>]*data-from="([^"]+)"[^>]*data-to="([^"]+)"/g)]
    .map((match) => ({ from: /** @type {string} */ (match[1]), to: /** @type {string} */ (match[2]) }));
  assert.equal(runs.length, 2, `one interior hole produces two polylines; got ${JSON.stringify(runs)}`);
  for (const run of runs) {
    assert.ok(!(run.from <= HOLE && run.to >= HOLE),
      `no run spans the missing day ${HOLE}; got ${JSON.stringify(runs)}`);
  }
  assert.equal(runs[0].to, '2026-09-25', 'the first run ends the day before the hole');
  assert.equal(runs[1].from, '2026-09-27', 'the second run opens the day after it');

  // Assert: the paired table carries the hole as a row that says so, and no cell
  // anywhere on the page turns it into a number.
  assert.ok(figure.includes(`<tr class="chart-row chart-row-gap"><th scope="row">${HOLE}</th>`),
    `the table has a row for the missing day; got ${JSON.stringify(figure.slice(0, 600))}`);
  assert.ok(figure.includes(`<td>${escapeText(GAP_CELL_TEXT)}</td>`),
    'the gap row says in words that the day holds no stored value');
  assert.equal(/>0<\/td>/.test(figure), false, 'no gap row holds a zero');
  assert.equal(/<td[^>]*>0<\/td>/.test(detail.body), false,
    'no table cell anywhere on the page holds a bare zero');
  assert.equal(/<span class="figure">0<\/span>/.test(detail.body), false,
    'no current-number figure holds a bare zero for an unmeasured day');

  // Assert: the day is named in the text alternative - the caption, the table caption
  // and the summary sentence - because an omitted day reads as a zero day to a screen
  // reader user.
  assert.ok(figure.includes(escapeText(HOLE)), 'the missing day is named inside the figure');
  assert.match(figure, /No stored value for 2026-09-26: 1 day is unmeasured, not zero\./,
    'the figure states in text which day is unmeasured and that it is not zero');
  const caption = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(figure)?.[1] ?? '';
  assert.ok(caption.includes(HOLE), 'the figcaption names the missing day');
  const description = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(figure)?.[1] ?? '';
  assert.ok(description.includes(HOLE),
    'the svg description a screen reader reaches names the missing day too');
  assert.ok(/<tr class="chart-row chart-row-gap"><th scope="row">2026-09-26<\/th>/.test(figure),
    'the table names the missing day as a row of its own rather than omitting it');

  // Assert: the surrounding windows are named as gaps too, so a metric that missed a
  // day the others kept stays visible.
  assert.match(detail.body,
    /1 day of the 14 in the range has no stored row for any traffic metric: 2026-09-26\./,
    'the coverage sentence names the unmeasured day across the charted metrics');
  assert.match(detail.body, /That day is unmeasured, not zero\./,
    'and says in words that the day is unmeasured rather than empty');

  // Arrange and act: a repository whose stored days begin three days into the window.
  // The window comes from the range, not from the stored rows, so the leading days are
  // gaps the chart draws and the table names - a window derived from the stored days
  // would silently shorten itself and hide them.
  const partial = await request(f, detailUrl(OWNER, PARTIAL));
  const partialFigure = figureOf(partial.body, CLONES_METRIC);
  const chartRows = [...partialFigure
    .matchAll(/<tr class="chart-row(?: chart-row-gap)?"><th scope="row">([^<]+)<\/th>/g)]
    .map((match) => match[1]);
  assert.deepEqual(chartRows, calendarDays(FROM, TO),
    'the chart table carries a row for every day of the window, gaps included');
  for (const day of calendarDays(FROM, TO).slice(0, 3)) {
    assert.ok(partialFigure.includes(
      `<tr class="chart-row chart-row-gap"><th scope="row">${day}</th><td>${escapeText(GAP_CELL_TEXT)}</td>`),
    `the leading unmeasured day ${day} is a named gap row`);
  }
  assert.match(partialFigure, /No stored value for 2026-09-19, 2026-09-20 and 2026-09-21: 3 days are unmeasured/,
    'the figure names every leading gap day in its text alternative');
  assert.equal(/points="[^"]*"/.test(partialFigure), true,
    'the remaining stored days are still plotted');
  assert.match(partialFigure, /<polyline[^>]*data-from="2026-09-22"/,
    'the plotted run starts on the first day that holds a stored row');
});

test('referrer and popular-path captures are shown with their capture times', async (t) => {
  // Arrange: two referrer captures and one popular-path capture, recorded by the run.
  const f = await fixture(t);
  const stored = Number(/** @type {{n: number}} */ (/** @type {unknown} */ (f.db.prepare(
    `SELECT count(*) AS n FROM snapshots WHERE repository_id=1`).get())).n);
  assert.equal(stored, REFERRERS.length * 2 + POPULAR_PATHS.length, 'the fixture holds both captures and lists');

  // Act: the detail page over the same window.
  const detail = await request(f, detailUrl(OWNER, 'archive'));
  const section = /<section class="detail-section detail-captures"[\s\S]*?<\/section>/
    .exec(detail.body)?.[0] ?? '';

  // Assert: every capture is present with the instant the archive recorded it, so a
  // capture is never shown as though it belonged to a day it has no dimension for.
  assert.ok(section.length > 0, 'the captures section renders');
  for (const capturedAt of [CAPTURED_AT, EARLIER_CAPTURE_AT]) {
    assert.ok(section.includes(`data-captured-at="${capturedAt}"`),
      `a capture is shown with its capture time ${capturedAt}`);
    assert.ok(section.includes(`<td class="captured-at">${capturedAt}</td>`),
      `the capture time is text in its own cell, not only an attribute`);
  }
  assert.equal([...section.matchAll(/data-captured-at="/g)].length, REFERRERS.length * 2 + POPULAR_PATHS.length,
    'every stored capture row is rendered');

  // Both lists are present and distinguished, and the two referrer captures stay two
  // captures rather than merging into one list that never existed.
  assert.match(section, /<h3 id="referrers-heading">Referrers<\/h3>/, 'the referrer list has its own heading');
  assert.match(section, /<h3 id="popular-paths-heading">Popular paths<\/h3>/, 'the popular-path list has its own heading');
  const captureTimes = [...section.matchAll(/data-captured-at="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(captureTimes)], [CAPTURED_AT, EARLIER_CAPTURE_AT],
    'both recorded instants are shown, newest first');
  assert.ok(section.includes(escapeText(REFERRERS[0].label)), 'a referrer label is shown as text');
  assert.ok(section.includes(escapeText(POPULAR_PATHS[0].label)), 'a popular path is shown as text');
  assert.ok(section.includes(escapeText(POPULAR_PATHS[1].title)), 'a captured title is shown when the vendor sent one');

  // A list with no capture says so, and says it is an absence rather than a zero.
  const quiet = await request(f, detailUrl(OWNER, QUIET));
  const quietSection = /<section class="detail-section detail-captures"[\s\S]*?<\/section>/
    .exec(quiet.body)?.[0] ?? '';
  assert.match(quietSection, /No referrer capture is stored for this repository\./,
    'an unstored list is named as a missing capture');
  assert.match(quietSection, /not that the referrer count is zero/,
    'a missing capture is never read as a count of zero');
});

test('the provenance caption names the first collected day, or the first-connect wording when there is none', async (t) => {
  // Arrange: three repositories with three different recorded boundaries.
  const f = await fixture(t);

  // Act: the provenance section of each.
  const inside = provenanceOf((await request(f, detailUrl(OWNER, STEADY))).body);
  const before = provenanceOf((await request(f, detailUrl(OWNER, 'archive'))).body);
  const none = provenanceOf((await request(f, detailUrl(OWNER, QUIET))).body);

  // Assert: the boundary the archive recorded is the day named - and the steady
  // repository's boundary is inside its window, so the marker and the caption agree.
  assert.match(inside, /Collected history begins on <strong>2026-09-26<\/strong>/,
    `the caption names the recorded first collected day; got ${JSON.stringify(inside)}`);
  assert.ok(inside.includes('were not measured by a collection run'),
    'the caption says the days before the boundary were not measured');
  assert.match(before, /Collected history begins on <strong>2026-09-19<\/strong>/,
    'the boundary comes from the recorded stamp, not from the earliest stored row');

  // Assert: a repository the archive records as never collected gets the first-connect
  // wording and names no day at all, because there is no day to name.
  assert.match(none, /data-state="first-connect"/, 'a never-collected repository carries the first-connect caption');
  assert.match(none, /No collection has been recorded for this repository, so there is no first collected day/,
    'the caption states that no first collected day exists');
  assert.equal(/Collected history begins on/.test(none), false, 'no boundary day is invented for it');

  // Assert: the boundary is never derived from the stored rows. The steady repository
  // holds days from 2026-09-19 but its recorded boundary is 2026-09-26, and the page
  // says 2026-09-26.
  const storedFirst = /** @type {{day: string}} */ (/** @type {unknown} */ (f.db.prepare(
    `SELECT min(day) AS day FROM day_series WHERE repository_id=2 AND metric=?`).get(CLONES_METRIC)));
  assert.equal(storedFirst.day, FROM, 'the archive really holds earlier rows than the recorded boundary');
  assert.ok(!inside.includes(`<strong>${FROM}</strong>`), 'the earliest stored row did not become the boundary');

  // Assert: a boundary inside the window is drawn, and a day before it is never drawn
  // in the collected treatment. The sources are checked in the table's own cells, not
  // in a data attribute: the legend carries the same words, so an attribute would pass
  // whether or not a day reached the chart with its own recorded source.
  const detail = await request(f, detailUrl(OWNER, STEADY));
  const figure = figureOf(detail.body, CLONES_METRIC);
  assert.match(figure, /<g class="chart-boundary" data-day="2026-09-26">/,
    'the figure marks the boundary at the recorded day');
  assert.match(figure, /Backfilled: dashed, reconstructed on first connect/,
    'the legend names the reconstructed treatment in words');
  assert.match(figure, /<th scope="col">Source<\/th>/,
    'the table names each day\'s source, so the picture is not the only place it exists');
  for (const [day, source] of /** @type {Array<[string, string]>} */ ([
    ['2026-09-19', 'Backfilled'], ['2026-09-25', 'Backfilled'],
    ['2026-09-26', 'Collected'], ['2026-10-02', 'Collected'],
  ])) {
    assert.ok(figure.includes(`<tr class="chart-row"><th scope="row">${day}</th>`),
      `the table has a stored row for ${day}`);
    const cell = new RegExp(`<th scope="row">${day}</th><td>\\d+</td><td>${source}</td>`);
    assert.match(figure, cell,
      `the day ${day} says in the table that the archive recorded it as ${source}`);
  }
  // And the day the archive never labelled is named as such rather than guessed into
  // one of the two treatments.
  const unlabelled = Number(/** @type {{n: number}} */ (/** @type {unknown} */ (f.db.prepare(
    `SELECT count(*) AS n FROM day_series WHERE repository_id=2 AND source NOT IN ('backfill','collected')`)
    .get())).n);
  assert.equal(unlabelled, 0, 'every stored day of the fixture carries a recorded source');
});

/**
 * @param {string} body
 * @returns {string} The provenance section's own markup.
 */
function provenanceOf(body) {
  return /<section class="detail-section detail-provenance"[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';
}

test('calling the render function twice with the same input returns byte-identical markup', async (t) => {
  // Arrange: the registry over the seeded archive and a fixed reference day, so any
  // difference between two renders came from the render itself.
  const f = await fixture(t);
  /** @type {PageContext} */
  const ctx = {
    route: 'detail', owner: OWNER, name: 'archive', from: FROM, to: TO,
    links: {
      index: '/',
      list: `/repos?from=${FROM}&to=${TO}`,
      detail: (owner, name) => `/repo/${owner}/${name}?from=${FROM}&to=${TO}`,
    },
  };

  // Act: render the page three ways - the renderer alone twice, then through the
  // router - and compare the bytes.
  const first = f.registry.views.detail(ctx);
  const second = f.registry.views.detail(ctx);
  assert.equal(first, second, 'two renders of the detail page are byte-identical');

  // Act: the read and the render function called directly, to prove the split between
  // them introduces no clock of its own.
  const range = {
    from: FROM,
    to: TO,
    refusal: /** @type {string|null} */ (null),
  };
  const data = readRepositoryDetailPage({ db: f.db, clock: () => READ_AT_MS, range, ctx, today: TO });
  assert.equal(renderRepositoryDetailPage(ctx, data), first,
    'the read plus the render function produces the page the registry serves');
  const again = readRepositoryDetailPage({ db: f.db, clock: () => READ_AT_MS, range, ctx, today: TO });
  assert.equal(renderRepositoryDetailPage(ctx, again), first, 'a second read is byte-identical too');

  const served = await request(f, detailUrl(OWNER, 'archive'));
  assert.equal(served.body, first, 'the served page is the page the renderer produces');

  // The reference day travels to the read rather than being read from the wall clock
  // inside it. The hostile repository's recorded boundary is the reference day, so its
  // connected-today sentence is the one sentence a different reference day changes.
  /** @type {PageContext} */
  const boundaryCtx = { ...ctx, owner: HOSTILE_OWNER, name: HOSTILE_NAME };
  const onTheDay = readRepositoryDetailPage({
    db: f.db, clock: () => READ_AT_MS, range, ctx: boundaryCtx, today: TO,
  });
  const afterTheDay = readRepositoryDetailPage({
    db: f.db, clock: () => READ_AT_MS, range, ctx: boundaryCtx, today: '2026-10-05',
  });
  assert.ok(renderRepositoryDetailPage(boundaryCtx, onTheDay)
    .includes('The first collected day is the reference day'),
  'a boundary on the reference day says so');
  assert.ok(renderRepositoryDetailPage(boundaryCtx, afterTheDay)
    .includes('The first collected day is not the reference day'),
  'and the same repository against a later reference day says the opposite');
  assert.equal(
    renderRepositoryDetailPage(boundaryCtx, readRepositoryDetailPage({
      db: f.db, clock: () => READ_AT_MS, range, ctx: boundaryCtx, today: '2026-10-05',
    })),
    renderRepositoryDetailPage(boundaryCtx, afterTheDay),
    'the reference day is data, so the same one produces the same bytes every time',
  );
});

test('every chart carries its own data table, and every state survives losing every class', async (t) => {
  // Arrange: a collected repository, a never-collected one and one in a failure state.
  const f = await fixture(t);
  const pages = /** @type {Array<[string, string]>} */ ([
    ['collected', (await request(f, detailUrl(OWNER, 'archive'))).body],
    ['steady', (await request(f, detailUrl(OWNER, STEADY))).body],
    ['never collected', (await request(f, detailUrl(OWNER, QUIET))).body],
    ['needs re-authentication', (await request(f, detailUrl(OWNER, REFUSED))).body],
  ]);

  for (const [label, body] of pages) {
    // Every figure is paired with a table carrying the same days, reachable from the
    // picture through its description.
    const figures = [...body.matchAll(/<figure\b/g)].length;
    const chartTables = [...body.matchAll(/<table class="chart-table"/g)].length;
    assert.equal(figures, chartTables, `${label}: every figure carries its own data table`);
    for (const figure of body.split('<figure').slice(1)) {
      assert.ok(figure.includes('<table class="chart-table"'),
        `${label}: the figure's table is inside it, so the caption reaches both`);
      assert.ok(/<caption id="[^"]*">[^<]+<\/caption>/.test(figure),
        `${label}: the paired table has a caption naming what it holds`);
      const rows = [...figure.matchAll(/<tr class="chart-row(?: chart-row-gap)?">/g)].length;
      assert.ok(rows >= 14, `${label}: the table has a row per calendar day; got ${rows}`);
    }
    // A day the archive does not hold is named as a day in the table beside the
    // picture, so an omitted day never reads as a zero day.
    for (const figure of body.split('<figure').slice(1)) {
      const gaps = [...figure.matchAll(/<tr class="chart-row chart-row-gap"><th scope="row">([^<]+)<\/th>/g)];
      for (const [, day] of gaps) {
        assert.ok(figure.includes(`<td>${escapeText(GAP_CELL_TEXT)}</td>`),
          `${label}: the gap day ${day} says in words that it holds no stored value`);
      }
    }
    // And the page reads without any styling at all.
    assert.ok(withoutClasses(body).includes('Selected range:'),
      `${label}: the page reads without any styling`);
  }
  // A first-connect state is text rather than a class, so stripping every class
  // attribute leaves the state and its next step standing.
  const quiet = withoutClasses(/** @type {string} */ (pages[2][1]));
  assert.ok(quiet.includes('No collection has been recorded for this repository'),
    'the first-connect state is text, not a class');
  assert.ok(quiet.includes('Administration repository permission (read)'),
    'and it still names the permission once every class is removed');
  assert.ok(quiet.includes('node src/cli.js collect'),
    'and it still names the next step once every class is removed');

  // The states the health read returns are text on the page, and every section is
  // still there for a repository whose last run was refused.
  const refused = pages.find(([label]) => label === 'needs re-authentication')?.[1] ?? '';
  assert.deepEqual(sectionHeadings(refused).map((heading) => heading.key), [...DETAIL_SECTION_ORDER],
    'a repository in a failure state still renders every section');
  assert.match(refused, /Administration repository permission \(read\)/,
    'the re-authentication state names the permission a new token needs');

  // Every state word on the page is the one the health read itself returned, in an
  // element of its own - not folded into another sentence, and not left to the class
  // attribute that carries it. The stripped markup is the control: with every class
  // removed, each word and its reason must still be there as text.
  const enrolled = collectionHealth({ db: f.db, clock: () => READ_AT_MS }).repositories;
  assert.ok(enrolled.length >= 4, 'the fixture enrolled several repositories');
  for (const entry of enrolled) {
    const page = await request(f, detailUrl(entry.owner, entry.name));
    assert.equal(page.status, 200, `${entry.repo} is a page`);
    assert.ok(page.body.includes(`<span class="state-word">${escapeText(entry.state)}</span>`),
      `${entry.repo}: the page states the health read's own state word in an element of its own`);
    assert.ok(withoutClasses(page.body).includes(`<span>${escapeText(entry.state)}</span>`),
      `${entry.repo}: the state word survives stripping every class attribute`);
    assert.ok(withoutClasses(page.body).includes(escapeText(entry.reason)),
      `${entry.repo}: the health read's own sentence survives stripping every class attribute`);
  }
});

test('the page states no trend, score or verdict, and no remote reference or colour literal', async (t) => {
  // Arrange: every state the page can be in, including the refused one.
  const f = await fixture(t);
  const pages = /** @type {Array<[string, {status: number, body: string}]>} */ ([
    ['collected', await request(f, detailUrl(OWNER, 'archive'))],
    ['steady', await request(f, detailUrl(OWNER, STEADY))],
    ['never collected', await request(f, detailUrl(OWNER, QUIET))],
    ['needs re-authentication', await request(f, detailUrl(OWNER, REFUSED))],
    ['unknown repository', await request(f, detailUrl(OWNER, 'never-enrolled'))],
  ]);

  for (const [label, page] of pages) {
    // RS-HO-01: no adoption claim, no score, no threshold verdict and no directional
    // language the stored counts cannot support.
    for (const banned of ['adoption', 'score', 'verdict', 'anomaly', 'trend', 'increasing', 'decreasing',
      'surging', 'declining', 'rising', 'falling', 'growth']) {
      assert.equal(new RegExp(`\\b${banned}\\w*`, 'i').test(page.body), false,
        `${label}: the page states no ${banned}; a set of counts cannot support one`);
    }
    // RS-UI-CON-01: no script, no inline handler, no remote asset, no motion, no colour.
    assert.equal(/<script/i.test(page.body), false, `${label}: no script element`);
    assert.equal(/<[^>]+\son[a-z]+\s*=/i.test(page.body), false, `${label}: no inline event handler`);
    assert.equal(/https?:\/\//i.test(page.body.replaceAll('http://127.0.0.1', '')), false,
      `${label}: the page names no remote host`);
    assert.equal(/@import|@font-face|url\(/i.test(page.body), false, `${label}: no imported font, style or image`);
    assert.equal(/transition\s*:|animation\s*:/i.test(page.body), false, `${label}: no motion`);
    assert.equal(/#[0-9a-f]{3,8}\b|\brgba?\(/i.test(page.body), false, `${label}: no colour literal in markup`);
    for (const reference of [...page.body.matchAll(/\b(?:href|src|srcset)\s*=\s*"([^"]*)"/g)]
      .map((match) => match[1] ?? '')) {
      assert.match(reference, /^(#|\/(?!\/))/, `${label}: every reference is a relative same-origin path`);
    }
  }
});

test('the page meets the structural accessibility contract on its served markup', async (t) => {
  // Arrange: the detail pages, one per state.
  const f = await fixture(t);
  const pages = /** @type {Array<[string, string]>} */ ([
    ['collected', (await request(f, detailUrl(OWNER, 'archive'))).body],
    ['never collected', (await request(f, detailUrl(OWNER, QUIET))).body],
  ]);

  for (const [label, body] of pages) {
    // One main landmark, owned by the shell, and the skip link is the first focusable
    // element in the document.
    assert.equal(body.match(/<main\b/g)?.length, 1, `${label}: exactly one main landmark`);
    const focusable = [...body.matchAll(/<a\b[^>]*>|<button\b[^>]*>|<input\b[^>]*>/g)][0]?.[0] ?? '';
    assert.match(focusable, /href="#main"/, `${label}: the skip link is the first focusable element`);
    // The language, and a title naming the repository and the range.
    assert.match(body, /<html lang="en">/, `${label}: the language is declared`);
    const repository = label === 'collected' ? `${OWNER}/archive` : `${OWNER}/${QUIET}`;
    assert.ok(body.includes(`<title>${escapeText(`${repository} ${FROM} to ${TO}`)} - RepoSignal</title>`),
      `${label}: the title names the repository and the range`);
    // The heading order skips no level and starts at one.
    const levels = headingLevels(body);
    assert.equal(levels[0], 1, `${label}: the first heading is the page heading`);
    for (let index = 1; index < levels.length; index += 1) {
      const previous = /** @type {number} */ (levels[index - 1]);
      const current = /** @type {number} */ (levels[index]);
      assert.ok(current <= previous + 1,
        `${label}: heading level ${current} follows ${previous}, which skips a level`);
    }
    // Every table the page renders names what it holds in its caption.
    const captions = [...body.matchAll(/<table\b[^>]*>\s*<caption[^>]*>([^<]+)<\/caption>/g)].length;
    const tables = [...body.matchAll(/<table\b/g)].length;
    assert.ok(tables > 0, `${label}: the page renders tables`);
    assert.equal(captions, tables, `${label}: every table carries a caption naming what it holds`);
  }

  // An unenrolled identity is the router's 404, and it uses the same shell rather than
  // a bare error string, so a mistyped URL still looks like the product.
  const missing = await request(f, detailUrl(OWNER, 'never-enrolled'));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.match(/<main\b/g)?.length, 1, 'the 404 page has one main landmark');
  assert.match(missing.body, /<html lang="en">/, 'the 404 page declares its language');
  assert.match(missing.body, /No repository named maintainer\/never-enrolled is enrolled/,
    'the 404 page names the problem');

  // The three pages carry three different titles, and a detail page is not the list
  // page wearing a different title.
  const list = await request(f, `/repos?from=${FROM}&to=${TO}`);
  const titles = [pages[0][1], pages[1][1], list.body].map((page) => /<title>([^<]*)<\/title>/.exec(page)?.[1]);
  assert.equal(new Set(titles).size, 3, `each page carries its own title; got ${JSON.stringify(titles)}`);
  assert.equal(list.body.includes('data-section="current-numbers"'), false,
    'the list page is not the detail page');
  assert.ok(pages[0][1].includes('data-section="current-numbers"'), 'the detail page is');
});

test('a repository name carrying markup is escaped in every context and raw nowhere', async (t) => {
  // Arrange: the archive holds an identity whose stored spelling is markup, and the
  // product's captured label carries markup too.
  const f = await fixture(t);
  const detail = await request(f, detailUrl(HOSTILE_OWNER, HOSTILE_NAME));

  // Act and assert: escaped in each context the product defines for it, and raw
  // nowhere - including the captured list label, which is a value from the vendor.
  assert.equal(detail.status, 200, 'a stored identity is a page, not an error');
  assert.ok(detail.body.includes(escapeText(HOSTILE_LABEL)), 'escaped in text context');
  assert.ok(detail.body.includes(`data-repository="${escapeAttribute(HOSTILE_LABEL)}"`),
    'attribute escaped where it is carried');
  assert.ok(detail.body.includes(`href="${escapeAttribute(detailUrl(HOSTILE_OWNER, HOSTILE_NAME))}"`),
    'percent-encoded in URL context');
  assert.equal(detail.body.includes(HOSTILE_NAME), false, 'the raw name appears nowhere');
  assert.equal(detail.body.includes('"><script'), false, 'the payload cannot close an attribute');
  assert.equal(/<script/i.test(detail.body), false, 'no script element reaches the page');
  assert.equal(detail.body.includes('<img'), false, 'no injected element of any kind');
  // The archive still holds the spelling a collector recorded, byte for byte.
  const stored = /** @type {{owner: string, name: string}} */ (/** @type {unknown} */ (
    f.db.prepare('SELECT owner, name FROM repositories WHERE id=5').get()));
  assert.equal(stored.owner, HOSTILE_OWNER);
  assert.equal(stored.name, HOSTILE_NAME);
});

test('the comparison, divergence and change list mount the insight modules and show their results', async (t) => {
  // Arrange: two repositories over the same window - one complete, one with a hole -
  // so the sufficient and the insufficient variants of each reading are both reached.
  const f = await fixture(t);

  // Act: both pages.
  const steady = await request(f, detailUrl(OWNER, STEADY));
  const holed = await request(f, detailUrl(OWNER, 'archive'));

  // Assert: the complete repository's readings are computed from the stored days.
  const comparison = /<section class="detail-section detail-comparison"[\s\S]*?<\/section>/
    .exec(steady.body)?.[0] ?? '';
  assert.match(comparison, /data-metric="clones" data-status="sufficient"/,
    'a complete window carries the difference between its two seven-day windows');
  assert.match(comparison, /<td class="value">(-?\d+)<span class="figure-note">2026-09-19 to 2026-09-25<\/span>/,
    'the earlier window total is shown with the days it is over');
  assert.match(comparison, /%\sof \d+<\/span>/, 'the share is shown beside the number it came from');
  // The earlier window sum really is the sum of the stored days the archive holds.
  const expected = Number(/** @type {{total: number}} */ (/** @type {unknown} */ (f.db.prepare(
    `SELECT sum(value) AS total FROM day_series WHERE repository_id=2 AND metric=? AND day BETWEEN ? AND ?`)
    .get(CLONES_METRIC, FROM, '2026-09-25'))).total);
  assert.ok(comparison.includes(`<td class="value">${expected}<span class="figure-note">2026-09-19 to 2026-09-25`),
    `the earlier window total is the archive's own sum of ${expected}`);

  // Assert: the reading with a hole inside one of its windows reports insufficient
  // data in the module's own words, naming the day, rather than a number over fewer
  // days than it claims.
  const holedComparison = /<section class="detail-section detail-comparison"[\s\S]*?<\/section>/
    .exec(holed.body)?.[0] ?? '';
  assert.match(holedComparison, /data-metric="clones" data-status="insufficient"/,
    'a window with an unmeasured day reports no difference');
  assert.match(holedComparison, /insufficient data: [^<]*2026-09-26/,
    `the insufficient reading names the day; got ${JSON.stringify(holedComparison.slice(0, 900))}`);
  assert.equal(/<td class="value">-?\d+<\/td>\s*<td class="value">-?\d+<\/td>/.test(holedComparison), false,
    'no window total is printed for a window holding an unmeasured day');

  // Assert: the divergence comparison needs fourteen days carrying both metrics, and
  // one repository has them while the other does not.
  const divergence = /<section class="detail-section detail-clones-against-stars"[\s\S]*?<\/section>/
    .exec(steady.body)?.[0] ?? '';
  assert.match(divergence, /data-status="sufficient"/, 'fourteen paired days carry the comparison');
  assert.match(divergence, /<td class="value">69<\/td>/,
    'the unique-cloner total is the sum of the archive\'s own stored daily counts');
  assert.match(divergence, /the cumulative level recorded on 2026-10-02/,
    'the star level belongs to a named day');
  const holedDivergence = /<section class="detail-section detail-clones-against-stars"[\s\S]*?<\/section>/
    .exec(holed.body)?.[0] ?? '';
  assert.match(holedDivergence, /data-status="insufficient"/,
    'thirteen paired days cannot carry the comparison');
  assert.match(holedDivergence, /needs 14 days that carry both a unique-cloner count and a star count/,
    'the insufficient reading names the requirement');

  // Assert: the change list is the flat dated list, with both stored days and the
  // unmeasured days between them named.
  const changes = /<section class="detail-section detail-changes"[\s\S]*?<\/section>/
    .exec(steady.body)?.[0] ?? '';
  assert.match(changes, /data-status="sufficient"/, 'a complete window produces a change list');
  assert.ok([...changes.matchAll(/data-metric="[a-z-]+" data-day="\d{4}-\d{2}-\d{2}"/g)].length > 0,
    'the list names the metric and the day of each change');
  assert.match(changes, /1 day between; none: the two stored days are consecutive/,
    'a consecutive pair says so rather than naming a gap that is not there');
  // The repository with the hole: a pair separated by an unmeasured day names that day
  // rather than being presented as a one-day move.
  const holedChanges = /<section class="detail-section detail-changes"[\s\S]*?<\/section>/
    .exec(holed.body)?.[0] ?? '';
  assert.match(holedChanges, /2 days between; 2026-09-26/,
    'a pair separated by an unmeasured day names that day rather than calling it a one-day move');

  // Assert: a per-day unique is never added up into a window total. The comparison
  // carries only the two counted metrics.
  for (const [label, body] of /** @type {Array<[string, string]>} */ ([['steady', steady.body]])) {
    const section = /<section class="detail-section detail-comparison"[\s\S]*?<\/section>/
      .exec(body)?.[0] ?? '';
    assert.equal(section.includes('data-metric="unique-cloners"'), false,
      `${label}: a per-day unique is never summed across days`);
    assert.equal(section.includes('data-metric="unique-visitors"'), false,
      `${label}: nor is a per-day unique visitor count`);
  }
  // The current-numbers section shows each per-day unique for one named day instead,
  // and the number it prints is that day's stored value rather than a sum over the
  // window: the sentence beside it and the figure beside that must not disagree.
  const numbers = /<section class="detail-section detail-current-numbers"[\s\S]*?<\/section>/
    .exec(steady.body)?.[0] ?? '';
  assert.match(numbers, /the last day with a stored row; a per-day unique is never added up across days/,
    'a per-day unique names the day it belongs to');
  const lastDay = TO;
  assert.equal(lastDay, calendarDays(FROM, TO).at(-1), 'the last day of the window is the one named beside it');
  const storedCloners = Number(/** @type {{value: number}} */ (/** @type {unknown} */ (f.db.prepare(
    'SELECT value FROM day_series WHERE repository_id=2 AND metric=? AND day=?')
    .get(UNIQUE_CLONERS_METRIC, lastDay))).value);
  const summedCloners = Number(/** @type {{total: number}} */ (/** @type {unknown} */ (f.db.prepare(
    'SELECT sum(value) AS total FROM day_series WHERE repository_id=2 AND metric=? AND day BETWEEN ? AND ?')
    .get(UNIQUE_CLONERS_METRIC, FROM, TO))).total);
  assert.notEqual(storedCloners, summedCloners, 'the fixture distinguishes the day from the sum');
  const clonerRow = /<tr data-metric="unique-cloners"[\s\S]*?<\/tr>/.exec(numbers)?.[0] ?? '';
  assert.ok(clonerRow.includes(`<span class="figure">${storedCloners}</span>`),
    `the unique-cloner reading is the last stored day's own value of ${storedCloners}`);
  assert.equal(clonerRow.includes(`<span class="figure">${summedCloners}</span>`), false,
    `it is never the sum of ${summedCloners} over the window`);
  // The same holds for the visitor count, whose values would inflate the same way.
  const visitorRow = /<tr data-metric="unique-visitors"[\s\S]*?<\/tr>/.exec(numbers)?.[0] ?? '';
  const summedVisitors = Number(/** @type {{total: number}} */ (/** @type {unknown} */ (f.db.prepare(
    'SELECT sum(value) AS total FROM day_series WHERE repository_id=2 AND metric=? AND day BETWEEN ? AND ?')
    .get(UNIQUE_VISITORS_METRIC, FROM, TO))).total);
  const storedVisitors = Number(/** @type {{value: number}} */ (/** @type {unknown} */ (f.db.prepare(
    'SELECT value FROM day_series WHERE repository_id=2 AND metric=? AND day=?')
    .get(UNIQUE_VISITORS_METRIC, lastDay))).value);
  assert.equal(visitorRow.includes(`<span class="figure">${summedVisitors}</span>`), false,
    `a unique-visitor reading is never the sum of ${summedVisitors} over the window`);
  assert.ok(visitorRow.includes(`<span class="figure">${storedVisitors}</span>`),
    `it is the last stored day's own value of ${storedVisitors}`);
});

test('a window the registry refuses reads nothing and reports no number', async (t) => {
  // Arrange: a route carrying only a first day beyond the registry's reference day,
  // which resolves to a window whose first day is later than its last. A fully
  // specified inverted range never reaches the view - the router refuses it first.
  const f = await fixture(t);

  // Act: that detail URL.
  const response = await request(f, `/repo/${escapeUrl(OWNER)}/archive?from=2026-10-05`);

  // Assert: the refusal is stated in words, no chart is drawn, and every section is
  // still present - a refused window is not an archive that holds nothing.
  assert.equal(response.status, 200);
  assert.match(response.body, /data-state="refused"/, 'the page states the refusal');
  assert.match(response.body, /the first day is later than the last/,
    'the refusal names the inversion rather than showing numbers for it');
  assert.equal(response.body.includes('<figure'), false, 'no figure is drawn for a window that covers no day');
  assert.deepEqual(sectionHeadings(response.body).map((heading) => heading.key), [...DETAIL_SECTION_ORDER],
    'every section still renders so the reader can see what the page would have shown');
  // A fully specified inverted range is the router's own 400, and it uses the same shell.
  const inverted = await request(f, `/repo/${escapeUrl(OWNER)}/archive?from=${TO}&to=${FROM}`);
  assert.equal(inverted.status, 400);
  assert.match(inverted.body, /<main\b/, 'the 400 page uses the same shell');
});