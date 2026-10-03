import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stampFirstCollected } from '../../src/backfill/provenance.js';
import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../../src/collect/traffic.js';
import { GAP_CELL_TEXT } from '../../src/views/components/line-chart.js';
import { calendarDays, upsertDayFact } from '../../src/db/day-series-repo.js';
import { appendRun, openArchive, upsertRepository, withTransaction } from '../../src/db/ops-repo.js';
import { resolveHomePaths } from '../../src/paths.js';
import { STYLESHEET_HREF } from '../../src/server/html.js';
import { createRouter } from '../../src/server/router.js';
import { createServer } from '../../src/server/server.js';
import {
  SKIP_LINK_TARGET, SKIP_LINK_TEXT, THEME_CONTENT_TYPE, THEME_STYLESHEET_PATH, auditChartPairing,
  auditDocument, chartLegendEntries, headingLevelSkips, namedLink, readThemeStylesheet, skipLink,
  sliceElements, visibleText,
} from '../../src/server/views/a11y.js';
import { HEALTH_PAGE_PATH } from '../../src/server/views/health.js';
import { VIEW_ASSET_TABLE, createViewRegistry } from '../../src/server/views/index.js';
import { recordFailure, recordSuccess } from '../../src/supervision/repo-state-reporter.js';

/**
 * The mechanical accessibility contract, walked over the markup the dashboard
 * actually serves.
 *
 * Every page is rendered by the product's own registry, shell, escaping helpers,
 * view modules and chart component over an archive written through the product's
 * own writes, and is read through the handler `serve` mounts. Nothing here renders
 * markup by hand, because a test that escaped its own fixture would prove something
 * about the test rather than about the page.
 *
 * The assertions are made against a walk of the served document - landmarks,
 * headings, controls, figures and their tables - because an accessibility test
 * that greps a string constant proves the constant. Where a walk could be a
 * self-fulfilling reader, the walk itself is checked against markup built to be
 * wrong: a heading sequence that skips a level, a figure with no table, a link
 * named by an icon.
 *
 * The half of the contract that is about the stylesheet lives beside it:
 * `tests/contrast.test.js` computes every token pair's ratio, searches the
 * repository for a colour declared anywhere but `src/ui/theme.css`, and checks the
 * stylesheet for motion, remote fonts and fetched assets.
 *
 * The four pages covered are the index, the repository list, the repository detail
 * and the collection health page, plus the 404 and 400 pages the router owns,
 * because a mistyped URL is still a page a person reads.
 */

/** @typedef {import('../../src/server/router.js').PageContext} PageContext */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The window every fixture selects explicitly, so a page states the days it read. */
const FROM = '2026-09-19';
const TO = '2026-10-02';
/** The interior day no run recorded: the gap the chart, the table and the text all name. */
const HOLE = '2026-09-26';
/** The recorded collection boundary, inside the window: days before it were reconstructed. */
const BOUNDARY = '2026-09-26';

const OWNER = 'maintainer';
const NAME = 'archive';
/** RS-SP-07: an identity whose stored spelling is markup, not a name. */
const HOSTILE_OWNER = 'own&er';
const HOSTILE_NAME = '"><script>alert(1)</script>';

const RUN_ONE = '2026-09-19T06:00:00.000Z';
const COLLECTED_AT = '2026-10-02T06:00:05.000Z';
const FAILED_AT = '2026-10-02T06:30:00.000Z';
/** The instant the health read is taken: six hours after the recorded success. */
const READ_AT_MS = Date.parse('2026-10-02T12:00:00.000Z');

/** The four traffic metrics, one distinct value each so no column can share a number. */
const TRAFFIC_SEED = /** @type {readonly {metric: string, value: (index: number) => number}[]} */ ([
  { metric: CLONES_METRIC, value: (index) => 10 + index },
  { metric: UNIQUE_CLONERS_METRIC, value: (index) => 4 + (index % 3) },
  { metric: VIEWS_METRIC, value: (index) => 100 + index * 5 },
  { metric: UNIQUE_VISITORS_METRIC, value: (index) => 20 + (index % 4) },
]);

/**
 * The fonts the stylesheet may name: families an operating system already provides.
 * Anything else would be a font download, which this product does not do.
 */
const SYSTEM_FONTS = new Set([
  'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'Noto Sans',
  'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'Courier New',
  'sans-serif', 'serif', 'monospace',
]);

/**
 * @typedef {object} Fixture
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {string} home
 * @property {string} databasePath
 * @property {ReturnType<typeof createViewRegistry>} registry
 * @property {(req: any) => Promise<{status: number, body: string, headers?: Record<string, string>}>} handle
 */

/**
 * A temporary home holding a migrated archive with one collected repository whose
 * window has a hole in it, one repository that has never run, and one identity whose
 * stored spelling is markup.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<Fixture>}
 */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-a11y-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());

  upsertRepository(db, { id: 1, owner: OWNER, name: NAME, lastSeenAt: RUN_ONE, enrolled: 1 });
  upsertRepository(db, { id: 2, owner: OWNER, name: 'quiet', lastSeenAt: RUN_ONE, enrolled: 1 });
  upsertRepository(db, { id: 3, owner: HOSTILE_OWNER, name: HOSTILE_NAME, lastSeenAt: RUN_ONE, enrolled: 1 });
  // 4: enrolled and never touched by a run, so the never-collected state is on a page.
  upsertRepository(db, { id: 4, owner: OWNER, name: 'fresh', lastSeenAt: RUN_ONE, enrolled: 1 });
  appendRun(db, { id: 'run-1', startedAt: RUN_ONE });

  const window = calendarDays(FROM, TO);
  withTransaction(db, () => {
    for (const day of window) {
      if (day === HOLE) continue;
      const index = window.indexOf(day);
      for (const entry of TRAFFIC_SEED) {
        upsertDayFact(db, {
          repositoryId: 1, metric: entry.metric, granularity: 'day', day,
          value: entry.value(index), source: day >= BOUNDARY ? 'collected' : 'backfill',
          collectedAt: COLLECTED_AT,
        });
      }
    }
    // The identity whose stored spelling is markup holds real numbers too, so a page
    // that rendered it badly would still have had to render its numbers.
    for (const entry of TRAFFIC_SEED) {
      upsertDayFact(db, {
        repositoryId: 3, metric: entry.metric, granularity: 'day', day: TO,
        value: 7, source: 'collected', collectedAt: COLLECTED_AT,
      });
    }
  });
  stampFirstCollected(db, 1, { day: FROM, collectedAt: COLLECTED_AT });
  stampFirstCollected(db, 3, { day: TO, collectedAt: COLLECTED_AT });
  recordSuccess({ db, repositoryId: 1, collectedAt: COLLECTED_AT });
  recordSuccess({ db, repositoryId: 3, collectedAt: COLLECTED_AT });
  // A refused token, so a state word other than "healthy" is on a page somewhere.
  recordFailure({
    db, repositoryId: 2, runId: 'run-1', repo: `${OWNER}/quiet`, endpointType: 'traffic',
    error: { status: 403 }, collectedAt: FAILED_AT,
  });

  const registry = createViewRegistry({ db, clock: () => READ_AT_MS, today: TO });
  const router = createRouter({ views: registry.views, hasRepository: registry.hasRepository });
  return {
    db,
    home: paths.home,
    databasePath: paths.databasePath,
    registry,
    handle: registry.answerOwnRoutes(router),
  };
}

/**
 * Drive the mounted handler and read the whole answer it returns.
 *
 * @param {Fixture} f
 * @param {string} url
 * @returns {Promise<{status: number, body: string, headers?: Record<string, string>}>}
 */
async function request(f, url) {
  const response = await f.handle(/** @type {any} */ ({ url }));
  return typeof response === 'string' ? { status: 200, body: response } : response;
}

/**
 * Every page the dashboard serves, named by the route that produced it.
 *
 * @param {Fixture} f
 * @returns {Promise<Array<[string, {status: number, body: string}]>>}
 */
async function everyPage(f) {
  const hostile = `/repo/${encodeURIComponent(HOSTILE_OWNER)}/${encodeURIComponent(HOSTILE_NAME)}`
    + `?from=${FROM}&to=${TO}`;
  return /** @type {Array<[string, {status: number, body: string}]>} */ ([
    ['index', await request(f, `/?from=${FROM}&to=${TO}`)],
    ['list', await request(f, `/repos?from=${FROM}&to=${TO}`)],
    ['detail', await request(f, `/repo/${OWNER}/${NAME}?from=${FROM}&to=${TO}`)],
    ['detail of a markup identity', await request(f, hostile)],
    ['health', await request(f, HEALTH_PAGE_PATH)],
    ['unknown repository', await request(f, `/repo/${OWNER}/never-enrolled`)],
    ['inverted range', await request(f, `/repos?from=${TO}&to=${FROM}`)],
  ]);
}

/**
 * Every anchor on a page, as its own markup.
 *
 * @param {string} body
 * @returns {string[]}
 */
function anchorsOf(body) {
  return [...body.matchAll(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<\/a>/g)].map((match) => match[0]);
}

/**
 * The page with its stylesheet link removed: what a browser is left holding when the
 * stylesheet does not load, and what the requirement that a page stay readable
 * without it is really about.
 *
 * @param {string} body
 * @returns {string}
 */
function withoutStylesheet(body) {
  return body.replace(/<link\b[^>]*rel="stylesheet"[^>]*>\n?/g, '');
}

/**
 * A stylesheet with its comments removed, so a check for a forbidden construct reads
 * the declarations rather than the prose explaining why the construct is absent.
 *
 * @param {string} css
 * @returns {string}
 */
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

test('every page has exactly one main landmark and the skip link as its first focusable element', async (t) => {
  // Arrange: every page the dashboard serves, including the two the router refuses.
  const f = await fixture(t);
  const pages = await everyPage(f);

  for (const [label, page] of pages) {
    assert.equal(page.status >= 200 && page.status < 500, true, `${label}: is served`);
    const audit = auditDocument(page.body);
    assert.equal(audit.mainLandmarks, 1, `${label}: exactly one main landmark`);
    assert.ok(audit.ids.includes('main'), `${label}: the main landmark carries the id the skip link targets`);

    // The skip link is the first stop a keyboard makes, and it is the anchor the
    // shared shell emits - the helper and the shell are compared, not trusted.
    const first = audit.focusable[0];
    assert.ok(first !== undefined, `${label}: the page has a focusable element`);
    assert.equal(first.tag, 'a', `${label}: the first focusable element is a link`);
    assert.equal(first.attributes.href, `#${SKIP_LINK_TARGET}`, `${label}: it points at the main landmark`);
    assert.equal(first.text, SKIP_LINK_TEXT, `${label}: it is named in words`);
    assert.ok(page.body.includes(skipLink()),
      `${label}: the shell's skip link is the one this feature names; got ${JSON.stringify(page.body.slice(0, 600))}`);

    // The language is declared, and there is exactly one title per document.
    assert.equal(audit.lang, 'en', `${label}: the language is declared`);
    assert.equal(audit.titles.length, 1, `${label}: exactly one title`);
    assert.ok(/** @type {string} */ (audit.titles[0]).length > 0, `${label}: the title names something`);
  }

  // The titles are distinct across the pages, which is what a history entry and a
  // browser tab rely on.
  const titles = (await Promise.all(pages.map(([, page]) => page))).map((page) => auditDocument(page.body).titles[0]);
  assert.equal(new Set(titles).size, titles.length, `each page carries its own title; got ${JSON.stringify(titles)}`);
});

test('a walk of each page\'s heading sequence finds no skipped level', async (t) => {
  // Arrange: every page the dashboard serves.
  const f = await fixture(t);
  const pages = await everyPage(f);

  // Act and assert: the walk the tests rely on really does catch a skipped level, so a
  // clean result below is a statement about the pages and not about the walker.
  assert.deepEqual(headingLevelSkips([1, 2, 2, 3, 2]), [], 'a well-ordered sequence reports no skip');
  assert.deepEqual(headingLevelSkips([1, 3]), [{ after: 1, level: 3 }], 'h1 to h3 is a skipped level');
  assert.deepEqual(headingLevelSkips([2, 2, 4, 5]), [{ after: 2, level: 4 }], 'h2 to h4 is a skipped level');
  assert.deepEqual(headingLevelSkips([1, 2, 4]), [{ after: 2, level: 4 }], 'every skip is reported, not only the first');

  for (const [label, page] of pages) {
    const audit = auditDocument(page.body);
    const levels = audit.headings.map((heading) => heading.level);
    assert.ok(levels.length > 0, `${label}: the page has headings`);
    assert.equal(levels[0], 1, `${label}: the first heading is the page heading`);
    assert.deepEqual(headingLevelSkips(levels), [], `${label}: the heading sequence skips no level`);
    // Every heading is named, so a reader navigating by heading knows what is there,
    // and each generated identifier appears once, so a link to one section is unambiguous.
    for (const heading of audit.headings) {
      assert.ok(heading.text.length > 0, `${label}: every heading is named in words`);
      if (heading.id !== '') {
        assert.equal(audit.ids.filter((id) => id === heading.id).length, 1,
          `${label}: the identifier ${heading.id} is declared once`);
      }
    }
    // Every landmark that names itself names something that exists.
    for (const reference of [...page.body.matchAll(/aria-labelledby="([^"]*)"/g)].map((match) => match[1] ?? '')) {
      for (const id of reference.split(/\s+/).filter((entry) => entry !== '')) {
        assert.ok(audit.ids.includes(id), `${label}: the landmark labelled by ${id} names a real heading`);
      }
    }
  }

  // The detail page is walked section by section, so a section that gained or lost a
  // heading changes the walk rather than passing as a shorter page.
  const detailBody = (await request(f, `/repo/${OWNER}/${NAME}?from=${FROM}&to=${TO}`)).body;
  const detail = auditDocument(detailBody);
  const sectionKeys = [...detailBody.matchAll(/data-section="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(sectionKeys.length >= 9, `the detail page has its sections; got ${JSON.stringify(sectionKeys)}`);
  assert.equal(detail.headings.filter((heading) => heading.level === 2).length, sectionKeys.length,
    'the detail page carries one heading per labelled section');
  assert.ok(detail.headings.some((heading) => heading.level === 3),
    'the chart headings sit inside their section rather than beside it');
});

test('every figure carries a data table with the same values, and the table names the gap days', async (t) => {
  // Arrange: one collected repository whose window has a hole in the middle, written
  // through the product's own writes, so the values the page shows are the archive's.
  const f = await fixture(t);
  const detail = await request(f, `/repo/${OWNER}/${NAME}?from=${FROM}&to=${TO}`);

  // Act: the detail page, walked for figures and the tables inside them.
  const audit = auditDocument(detail.body);
  const window = calendarDays(FROM, TO);

  // Assert: one figure per charted metric, each with its own table and a caption.
  assert.equal(audit.figures.length, TRAFFIC_SEED.length,
    `the page carries one figure per charted metric; got ${JSON.stringify(audit.figures.map((figure) => figure.id))}`);
  assert.deepEqual(audit.figures.map((figure) => figure.id).sort(),
    TRAFFIC_SEED.map((entry) => `chart-${entry.metric}-figure`).sort(),
    'each figure is the chart of one of the four charted metrics');
  for (const figure of audit.figures) {
    const metric = /^chart-(.+)-figure$/.exec(figure.id)?.[1] ?? '';
    assert.equal(figure.tables.length, 1, `${figure.id}: exactly one data table beside the figure`);
    const table = /** @type {import('../../src/server/views/a11y.js').TableSummary} */ (figure.tables[0]);
    assert.ok(table.caption.length > 0, `${figure.id}: the table carries a caption naming what it holds`);
    assert.ok(figure.hasCaption, `${figure.id}: the figure states what it plots in text`);
    assert.ok(figure.hasSvg, `${figure.id}: the figure draws the series`);
    assert.deepEqual(table.rows.map((row) => row.label), window,
      `${figure.id}: the table has one row per calendar day, so a gap is a named day and not an omission`);
    assert.equal(table.columnHeaders[0], 'Day', `${figure.id}: the table's day column is headed`);
    assert.equal(table.columnHeaders.length, 1 + (table.rows[0]?.cells.length ?? 0),
      `${figure.id}: a heading for the day column and one per value cell`);
    assert.equal(table.insideFigure, true, `${figure.id}: the table is the figure's own, not a neighbour's`);
    // Every reference the chart points at resolves inside the figure, so the text
    // alternative is reachable from the picture rather than merely nearby.
    for (const reference of figure.describedBy) {
      assert.ok(figure.ids.has(reference), `${figure.id}: the chart points at ${reference}, which the figure holds`);
    }
    // The hole is named in the row itself, as words, and never as a number.
    const gap = table.rows.find((row) => row.label === HOLE);
    assert.ok(gap !== undefined, `${figure.id}: the table has a row for ${HOLE}`);
    assert.equal(gap.cells[0], GAP_CELL_TEXT, `${figure.id}: the gap row says so in words, not as a value`);
    assert.ok(figure.caption.includes(HOLE),
      `${figure.id}: the figure's caption names the gap day; got ${JSON.stringify(figure.caption)}`);
    // The values in this figure's table are the archive's own for this figure's metric.
    const stored = new Map(
      /** @type {{day: string, value: number}[]} */ (/** @type {unknown} */ (f.db.prepare(
        'SELECT day, value FROM day_series WHERE repository_id=1 AND metric=? AND day BETWEEN ? AND ? ORDER BY day')
        .all(metric, FROM, TO))).map((row) => [row.day, row.value]),
    );
    assert.equal(stored.size, window.length - 1,
      `${metric}: the fixture stored every day of the window but the one hole`);
    for (const row of table.rows) {
      const value = /** @type {number} */ (stored.get(row.label));
      assert.equal(row.cells[0], value === undefined ? GAP_CELL_TEXT : String(value),
        `${figure.id}: the table's value for ${row.label} is the archive's own`);
    }
  }

  // The provenance treatment is named in words beside the swatch, so the dash is a
  // second cue rather than the only one, and each figure carries its own two entries.
  const legend = chartLegendEntries(detail.body);
  assert.equal(legend.length, audit.figures.length * 2,
    'every figure carries the two-entry legend beside it');
  for (const figure of sliceElements(detail.body, 'figure')) {
    const entries = chartLegendEntries(figure.markup);
    assert.deepEqual(entries.map((entry) => entry.dashed), [true, false],
      'the legend draws one dashed and one solid treatment');
    for (const entry of entries) {
      assert.match(entry.name, /Backfilled|Collected/, 'each legend entry names its treatment in words');
      assert.ok(entry.name.length > 10, 'each legend entry says more than its swatch does');
    }
  }

  // The pairing rule the wrapper enforces, checked against a figure built to break it.
  const firstFigure = sliceElements(detail.body, 'figure')[0];
  assert.ok(firstFigure !== undefined, 'the page holds a figure to pair');
  const paired = auditChartPairing(firstFigure.markup);
  assert.equal(paired.paired, true, `a real figure pairs; got ${JSON.stringify(paired.reasons)}`);
  const orphan = '<figure class="chart"><figcaption>Clones</figcaption></figure>';
  const broken = auditChartPairing(orphan);
  assert.equal(broken.paired, false, 'a figure with no data table is not paired');
  assert.ok(broken.reasons.some((reason) => reason.includes('data tables')), 'the refusal names what is missing');
  assert.equal(auditChartPairing('<p>no figure here</p>').paired, false,
    'markup with no figure at all is not a paired chart');
});

test('every control has an accessible name in words, and it is the name this feature writes', async (t) => {
  // Arrange: every page the dashboard serves.
  const f = await fixture(t);
  const pages = await everyPage(f);

  for (const [label, page] of pages) {
    const audit = auditDocument(page.body);
    // No placeholder, no title attribute standing in for a name, and no aria-label:
    // the name of every control on a page is the text inside it.
    assert.equal(/placeholder=/.test(page.body), false, `${label}: no control carries a placeholder`);
    assert.equal(/\btitle="/.test(page.body), false, `${label}: no control is named by a title attribute`);
    assert.equal(/aria-label\s*=/.test(page.body), false, `${label}: no control is named by an aria-label`);
    assert.equal(/<(input|select|textarea)\b/i.test(page.body), false,
      `${label}: the only controls are links, which take their name from their text`);

    // Every anchor is exactly what the named-control helper emits, and its name is
    // the text a reader sees. The one anchor carrying a class is the skip link the
    // shell owns, and it is byte-for-byte the anchor this feature names.
    const anchors = anchorsOf(page.body);
    assert.ok(anchors.length > 0, `${label}: the page has somewhere to go`);
    let classed = 0;
    for (const anchor of anchors) {
      const href = /\bhref="([^"]*)"/.exec(anchor)?.[1] ?? '';
      const className = /\bclass="([^"]*)"/.exec(anchor)?.[1];
      const name = visibleText(anchor);
      assert.match(name, /[\p{L}\p{N}]/u, `${label}: the link to ${href} is named in words`);
      if (className !== undefined) {
        classed += 1;
        assert.equal(anchor, skipLink(), `${label}: the only classed anchor is the shell's skip link`);
        continue;
      }
      assert.equal(anchor, namedLink({ href: href.replaceAll('&amp;', '&'), name }),
        `${label}: the link to ${href} is the named control this feature writes`);
    }
    assert.ok(classed <= 1, `${label}: the shell's skip link is the only classed anchor`);
    for (const control of audit.focusable) {
      assert.match(control.text, /[\p{L}\p{N}]/u, `${label}: every control carries a name in words`);
    }
  }

  // The helper refuses the two ways a control loses its name: an icon and a placeholder.
  for (const name of ['', '   ', '→', '»', '×', '...', '#']) {
    assert.throws(() => namedLink({ href: '/repos', name }), /accessible name in words/,
      `a link named ${JSON.stringify(name)} is refused`);
  }
  assert.throws(() => namedLink({ href: '', name: 'Enrolled repositories' }), /reference to follow/,
    'a link with no reference is refused');
});

test('a page rendered without the stylesheet still carries every value in text', async (t) => {
  // Arrange: the detail page over the collected repository, and the list page.
  const f = await fixture(t);
  const pages = await everyPage(f);

  for (const [label, page] of pages) {
    const unstyled = withoutStylesheet(page.body);
    assert.equal(unstyled.length < page.body.length, true, `${label}: the stylesheet link was removed`);
    // The stylesheet is the only thing styling applies through: no inline style, no
    // style element and no presentational attribute, so removing it removes no text.
    assert.equal(/<style\b/i.test(page.body), false, `${label}: no page carries its own style element`);
    assert.equal(/\sstyle="/i.test(page.body), false, `${label}: no element carries an inline style`);
    assert.equal(/\s(bgcolor|bgcolor|text|face|link|vlink|alink)="/i.test(page.body), false,
      `${label}: no presentational attribute carries a value a stylesheet would`);
    assert.deepEqual(
      auditDocument(unstyled).tables.map((table) => table.rows.length),
      auditDocument(page.body).tables.map((table) => table.rows.length),
      `${label}: every table row survives without the stylesheet`,
    );
    assert.deepEqual(
      auditDocument(unstyled).headings.map((heading) => heading.level),
      auditDocument(page.body).headings.map((heading) => heading.level),
      `${label}: the heading sequence is not the stylesheet's to give`,
    );
  }

  // The detail page's numbers are all in the document, with or without the stylesheet.
  const detail = withoutStylesheet((await request(f, `/repo/${OWNER}/${NAME}?from=${FROM}&to=${TO}`)).body);
  const text = visibleText(detail);
  const window = calendarDays(FROM, TO);
  for (const entry of TRAFFIC_SEED) {
    const stored = /** @type {{day: string, value: number}[]} */ (/** @type {unknown} */ (f.db.prepare(
      'SELECT day, value FROM day_series WHERE repository_id=1 AND metric=? AND day BETWEEN ? AND ? ORDER BY day')
      .all(entry.metric, FROM, TO)));
    assert.ok(stored.length > 0, `${entry.metric}: the fixture really stored days`);
    for (const row of stored) {
      assert.ok(text.includes(String(row.value)), `${entry.metric}: the stored value for ${row.day} is in the text`);
    }
  }
  for (const day of window) assert.ok(text.includes(day), `the page names ${day} in text`);
  assert.ok(text.includes(HOLE), 'the gap day is named in the text beside the numbers');
  assert.ok(text.includes('unmeasured, not zero'), 'the gap is stated as unmeasured rather than as a value');

  // Every collection state the archive recorded is a word in the documents, not a
  // colour, and it is there with the stylesheet link gone.
  const listText = visibleText(withoutStylesheet((await request(f, `/repos?from=${FROM}&to=${TO}`)).body));
  const healthText = visibleText(withoutStylesheet((await request(f, HEALTH_PAGE_PATH)).body));
  for (const word of ['healthy', 'never-collected', 'needs-re-authentication']) {
    assert.ok(listText.includes(word), `the ${word} state is in the list page's text`);
    assert.ok(healthText.includes(word), `the ${word} state is in the health page's text`);
  }
});

test('the stylesheet route serves the token file as text/css, and nothing else is served from disk', async (t) => {
  // Arrange: the real loopback server with the registry mounted, the way `serve` does.
  const f = await fixture(t);
  const server = await createServer({ handler: f.handle });
  t.after(() => server.close());

  // Act: the stylesheet route, the shell's own link, and three near misses.
  const response = await fetch(`${server.url}${THEME_STYLESHEET_PATH}`);
  const body = await response.text();
  const withQuery = await fetch(`${server.url}${THEME_STYLESHEET_PATH}?v=2`);
  const trailingSlash = await fetch(`${server.url}${THEME_STYLESHEET_PATH}/`);
  const sibling = await fetch(`${server.url}/assets/other.css`);
  const sourceFile = await fetch(`${server.url}/src/ui/theme.css`);
  const index = await fetch(`${server.url}/`);

  // Assert: the route answers with the file, with the content type the browser needs,
  // and with the security headers the server factory always adds.
  assert.equal(THEME_STYLESHEET_PATH, STYLESHEET_HREF, 'the route serves the path the document shell links to');
  assert.equal(VIEW_ASSET_TABLE.length, 1, 'the stylesheet is the only file the dashboard serves from disk');
  assert.equal(VIEW_ASSET_TABLE[0]?.contentType, THEME_CONTENT_TYPE);
  // The content type is asserted as the literal the requirement names, not only
  // against this feature's own constant: a constant changed on both sides together
  // would otherwise pass without a browser ever being able to use the file.
  assert.equal(THEME_CONTENT_TYPE, 'text/css; charset=utf-8');
  assert.equal(response.status, 200, `the stylesheet must be served; body was ${body.slice(0, 200)}`);
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(body, readThemeStylesheet(), 'the route serves the token file, byte for byte');
  assert.ok(body.includes(':root'), 'the served file is the token block the contrast test reads');

  // No remote font and no fetched asset of any kind in what was served. The comments
  // are stripped first: a comment naming a forbidden construct is not a declaration
  // of one, and this stylesheet explains why it has none.
  const declarations = withoutComments(body);
  assert.equal(/@import/i.test(declarations), false, 'the stylesheet imports nothing');
  assert.equal(/@font-face/i.test(declarations), false, 'the stylesheet downloads no font');
  assert.equal(/url\(/i.test(declarations), false, 'the stylesheet fetches no file');
  assert.equal(/https?:\/\//i.test(declarations), false, 'the stylesheet names no host');
  assert.equal(/transition|animation|@keyframes/i.test(declarations), false, 'the stylesheet has no motion');
  const families = [...declarations.matchAll(/(?:font-family|font-sans|font-mono)\s*:\s*([^;]+);/g)]
    .map((match) => match[1] ?? '');
  assert.ok(families.length > 0, 'the stylesheet declares at least one font stack');
  const tokens = new Map([...declarations.matchAll(/(--rs-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
    .map((match) => [match[1] ?? '', (match[2] ?? '').trim()]));
  for (const family of families) {
    // A stack may be named through a token; a reference to a token that is not
    // declared would inherit nothing, so every reference has to resolve first.
    const resolved = family.replace(/var\((--rs-[a-z0-9-]+)\)/g, (whole, reference) => {
      assert.ok(tokens.has(/** @type {string} */ (reference)),
        `the stylesheet refers to ${reference}, which it never declares`);
      return tokens.get(/** @type {string} */ (reference)) ?? whole;
    });
    assert.notEqual(resolved, '', 'a font stack resolves to something');
    for (const name of resolved.split(',').map((entry) => entry.trim().replace(/^["']|["']$/g, ''))) {
      assert.ok(SYSTEM_FONTS.has(name), `the stylesheet names only fonts the operating system has: ${name}`);
    }
  }

  // A trailing slash and a query string are the same stylesheet; anything not named
  // in the asset table is the router's 404, so there is no static file server here.
  assert.equal(withQuery.status, 200, 'a query string does not change the stylesheet');
  assert.equal(await withQuery.text(), body);
  assert.equal(trailingSlash.status, 200, 'a trailing slash folds to the same file');
  assert.equal(await trailingSlash.text(), body);
  assert.equal(sibling.status, 404, 'a file nobody mounted is not served');
  assert.equal(sourceFile.status, 404, 'a source file is not served from disk');
  assert.equal(index.status, 200, 'the pages are still served');
  assert.match(await index.text(), /<html lang="en">/);
});

test('every page renders byte-identical markup from the same archive and clock', async (t) => {
  // Arrange: one archive and one fixed clock, so any difference between two renders
  // came from the render itself.
  const f = await fixture(t);

  // Act and assert: the same URL requested twice is the same bytes, on every page.
  for (const url of [
    `/?from=${FROM}&to=${TO}`,
    `/repos?from=${FROM}&to=${TO}`,
    `/repo/${OWNER}/${NAME}?from=${FROM}&to=${TO}`,
    HEALTH_PAGE_PATH,
    THEME_STYLESHEET_PATH,
  ]) {
    const first = await request(f, url);
    const second = await request(f, url);
    assert.equal(first.status, second.status, `${url}: the status is the same twice`);
    assert.equal(first.body, second.body, `${url}: two renders are byte-identical`);
  }
});
