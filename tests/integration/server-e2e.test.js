import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stampFirstCollected } from '../../src/backfill/provenance.js';
import { STARS_GRANULARITY, STARS_METRIC, STARS_SOURCE } from '../../src/backfill/stars.js';
import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../../src/collect/traffic.js';
import { calendarDays, upsertDayFact } from '../../src/db/day-series-repo.js';
import {
  appendRun, completeRun, listEnrolledRepositories, openArchive, upsertRepository, withTransaction,
} from '../../src/db/ops-repo.js';
import { appendSnapshot } from '../../src/db/snapshot-repo.js';
import { resolveHomePaths } from '../../src/paths.js';
import { documentShell, escapeAttribute, escapeText, escapeUrl } from '../../src/server/html.js';
import { findRepository, readRepositoryPage } from '../../src/server/repo-data.js';
import { createRouter } from '../../src/server/router.js';
import { createServer } from '../../src/server/server.js';
import { collectionHealth, repositoryHealth } from '../../src/supervision/health.js';
import { recordSuccess } from '../../src/supervision/repo-state-reporter.js';

/**
 * The running dashboard, driven end to end with no product view in the way.
 *
 * The server factory, the router, the page data read, the document shell and all
 * three escaping helpers are the real modules. The only thing this file
 * substitutes is the view registry: three renderers defined below and mounted
 * through `createRouter`, because the product's own registry does not exist yet.
 * That registry is a stub and is treated as one - it lives here, it never enters
 * `src/`, and one test below asserts that no product file imports or names it. It
 * renders through the product's escaping helpers and the product's page read over
 * a real migrated archive, so what arrives over the wire is what the archive holds
 * rather than a string this file invented.
 *
 * Every fixture gets its own temporary home, its own migrated archive and its own
 * server on an ephemeral loopback port, so this file is independent of every other
 * suite and of the developer's own archive. Every request goes through a fetch
 * guard that records the URL and refuses anything that is not this file's own
 * loopback server, so "this suite reaches no host" is an assertion over a list
 * rather than a promise - and the guard is probed directly, so it is known to be
 * live rather than assumed to be.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const THIS_FILE = 'tests/integration/server-e2e.test.js';
/** RS-PR-01: a dashboard page for six repositories over a 400-day range renders in under 500 ms. */
const RENDER_BUDGET_MS = 500;

const DAY_MS = 86_400_000;

/** The small archive's range, and the day inside it no run ever recorded. */
const FROM = '2026-09-20';
const TO = '2026-10-02';
const HOLE = '2026-09-26';
/** A backfilled star row far older than any collected day, which must not become the boundary. */
const BACKFILLED_STAR_DAY = '2024-03-05';

const OWNER = 'maintainer';
const NAME = 'archive';
const QUIET_NAME = 'quiet';
/** RS-SP-07: an identity whose stored spelling is markup, not a name. */
const HOSTILE_OWNER = 'own&er';
const HOSTILE_NAME = '"><script>alert(1)</script>';
const HOSTILE_LABEL = `${HOSTILE_OWNER}/${HOSTILE_NAME}`;
/** A stored referrer label carrying markup, which a page must escape like any other. */
const HOSTILE_REFERRER = 'https://evil.example/<script>alert(2)</script>';

const RUN_ONE = '2026-09-20T06:00:00.000Z';
const RUN_TWO = '2026-10-02T06:00:00.000Z';
const COLLECTED_AT = '2026-10-02T06:00:05.000Z';
const BACKFILLED_AT = '2026-09-19T06:00:00.000Z';
/** The instant the page's health read is taken: six hours after the recorded success. */
const READ_AT_MS = Date.parse('2026-10-02T12:00:00.000Z');

/**
 * The traffic metrics the writers own, so a seed cannot drift from the archive's own
 * metric keys. Each value is derived from its index and its repository's seed, so no
 * two repositories share a number by accident of scripting.
 * @type {Array<{metric: string, value: (index: number, seed: number) => number}>}
 */
const TRAFFIC_METRICS = [
  { metric: CLONES_METRIC, value: (index, seed) => index + seed * 100 },
  { metric: UNIQUE_CLONERS_METRIC, value: (index, seed) => 1 + (index % 5) + seed },
  { metric: VIEWS_METRIC, value: (index, seed) => 30 + index + seed * 100 },
  { metric: UNIQUE_VISITORS_METRIC, value: (index, seed) => 10 + (index % 7) + seed },
];
/** The weekly development metrics, stored at their week start by the backfill. */
const WIDE_METRICS = ['commit-activity', 'owner-participation'];

// ---------------------------------------------------------------------------
// Network guard: nothing in this file may reach a host.
// ---------------------------------------------------------------------------

/** @type {typeof globalThis.fetch|null} */
let realFetch = null;
/** @type {string[]} Every URL `fetch` was asked for, in order. */
const attemptedUrls = [];
/** @type {string[]} The URLs the guard refused. */
const refusedUrls = [];
/** @type {string[]} The loopback origins this file is allowed to talk to. */
let loopbackOrigins = [];

/**
 * Replace `fetch` with a recorder that refuses everything outside this file's own
 * loopback servers. Installed once for the whole file, so a request made from any
 * code path - including a module the server loads - is recorded before it is
 * refused, and refused before a socket for it can open.
 * @returns {void}
 */
function installNetworkGuard() {
  realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    /** @param {string|URL|Request} input @param {RequestInit} [init] */
    (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      attemptedUrls.push(url);
      if (!loopbackOrigins.some((origin) => url.startsWith(origin))) {
        refusedUrls.push(url);
        return Promise.reject(new Error(`this suite must not reach any host: ${url}`));
      }
      return /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (realFetch))(input, init);
    });
}

installNetworkGuard();
after(() => {
  if (realFetch !== null) globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/**
 * @param {string} day ISO day.
 * @param {number} count How many days to step back.
 * @returns {string} the day `count` days before `day`.
 */
function dayBefore(day, count) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - count * DAY_MS).toISOString().slice(0, 10);
}

/**
 * @param {readonly string[]} days
 * @returns {string[]} the Monday of each week the days touch, ascending.
 */
function weekStarts(days) {
  return days.filter((day) => new Date(`${day}T00:00:00.000Z`).getUTCDay() === 1);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {string} [where]
 * @returns {number}
 */
function count(db, table, where = '') {
  return Number(/** @type {{n: number}} */ (/** @type {unknown} */ (db.prepare(
    `SELECT count(*) AS n FROM ${table} ${where}`).get())).n);
}

/** Every table the archive owns, so "serving a page wrote nothing" is a whole-archive claim. */
const ARCHIVE_TABLES = ['repositories', 'repository_aliases', 'runs', 'day_series', 'snapshots',
  'repository_errors', 'heartbeats', 'backfill_records'];

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Record<string, number>} row count per archive table.
 */
function archiveCounts(db) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of ARCHIVE_TABLES) counts[table] = count(db, table);
  return counts;
}

// ---------------------------------------------------------------------------
// The test-local stub view registry.
// ---------------------------------------------------------------------------

/** @typedef {import('../../src/server/router.js').PageContext} PageContext */
/** @typedef {import('../../src/server/router.js').RouterViews} RouterViews */
/** @typedef {import('../../src/server/repo-data.js').RepositoryPage} RepositoryPage */
/** @typedef {import('../../src/server/repo-data.js').SnapshotCapture} SnapshotCapture */

/**
 * One render, as the stub registry measured it. `elapsedMs` is the render budget's
 * evidence: the injected monotonic measurement around the whole page build, with
 * the database already open, which is the wording RS-PR-01 uses.
 *
 * @typedef {object} RenderMeasurement
 * @property {string} route Which injected renderer ran.
 * @property {string|null} owner Owner the route carried.
 * @property {string|null} name Name the route carried.
 * @property {string} from First day of the resolved range.
 * @property {string} to Last day of the resolved range.
 * @property {number} elapsedMs Injected monotonic measurement of the page build.
 * @property {number} bytes Size of the rendered document.
 * @property {number} [calendarDays] Days the range covers.
 * @property {number} [storedRows] Stored rows the page carried.
 * @property {number} [gapDays] Calendar days no stored row covers, across all metrics.
 * @property {number} [repositories] Repositories the page listed.
 */

/**
 * Build the three renderers the router mounts.
 *
 * Every renderer goes through the product's document shell, the product's escaping
 * helpers and the product's page read. Nothing escapes by hand here: a stub that
 * hand-rolled its escaping would make the escaping assertions prove something about
 * this file instead of about the product.
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db Open, migrated archive.
 * @param {() => number} options.clock Epoch milliseconds the health reads are judged against.
 * @param {string} options.defaultFrom First day a one-sided range resolves to; the default window is the view's policy.
 * @param {string} options.defaultTo Last day a one-sided range resolves to.
 * @param {() => number} options.now Injected monotonic measurement for the render budget.
 * @param {RenderMeasurement[]} options.measurements Where each render is recorded.
 * @returns {RouterViews} The registry the router mounts.
 */
function createStubRegistry({ db, clock, defaultFrom, defaultTo, now, measurements }) {
  /** @param {PageContext} ctx @returns {{from: string, to: string}} */
  const resolveWindow = (ctx) => {
    // A route may arrive with one bound only, and the page read refuses a missing
    // one rather than inventing a range. Resolving it here is the view's own
    // policy, so the read is never handed a range nobody chose.
    const to = ctx.to ?? defaultTo;
    const from = ctx.from ?? defaultFrom;
    return { from, to };
  };

  /**
   * Run one page build inside the injected measurement and record what it cost.
   * @param {PageContext} ctx
   * @param {() => {html: string, details: Omit<RenderMeasurement, 'route'|'owner'|'name'|'from'|'to'|'elapsedMs'|'bytes'>}} build
   * @returns {string} the rendered document.
   */
  const timed = (ctx, build) => {
    const { from, to } = resolveWindow(ctx);
    const startedAt = now();
    const { html, details } = build();
    measurements.push({
      route: ctx.route,
      owner: ctx.owner,
      name: ctx.name,
      from,
      to,
      elapsedMs: now() - startedAt,
      bytes: html.length,
      ...details,
    });
    return html;
  };

  /**
   * One row per stored day, and one explicitly named gap for every calendar day a
   * metric has no stored row for. The gap row carries the words `not recorded` and
   * never a number: writing a value into a day nobody measured is the finding this
   * product must never ship, and a stub that filled it would hide it.
   * @param {RepositoryPage} page
   * @returns {{html: string, storedRows: number, gapDays: number, calendarDays: number}}
   */
  const seriesTable = (page) => {
    /** @type {string[]} */
    const lines = [];
    let storedRows = 0;
    let gapDays = 0;
    for (const series of page.series) {
      const stored = new Map(series.rows.map((row) => [row.day, row]));
      for (const day of page.calendarDays) {
        const row = stored.get(day);
        if (row === undefined) {
          gapDays += 1;
          lines.push(`<tr data-metric="${escapeAttribute(series.metric)}" data-day="${escapeAttribute(day)}" ` +
            'data-state="gap"><td>' + escapeText(day) + '</td><td>' + escapeText(series.metric) + '</td><td>' +
            escapeText(series.granularity) + '</td><td class="value">not recorded</td></tr>');
          continue;
        }
        storedRows += 1;
        lines.push(`<tr data-metric="${escapeAttribute(series.metric)}" data-day="${escapeAttribute(day)}" ` +
          'data-state="observed"><td>' + escapeText(row.day) + '</td><td>' + escapeText(row.metric) + '</td><td>' +
          escapeText(row.granularity) + '</td><td class="value">' + escapeText(row.value) + '</td><td>' +
          escapeText(row.source) + '</td></tr>');
      }
    }
    const html = [
      '<table><caption>Stored day facts, and the days no stored row covers</caption>',
      '<thead><tr><th scope="col">Day</th><th scope="col">Metric</th><th scope="col">Granularity</th>',
      '<th scope="col">Value</th><th scope="col">Source</th></tr></thead>',
      `<tbody>${lines.join('')}</tbody></table>`,
    ].join('\n');
    return { html, storedRows, gapDays, calendarDays: page.calendarDays.length };
  };

  /**
   * @param {SnapshotCapture[]} captures One list's recorded captures, oldest first.
   * @param {string} heading
   * @returns {string}
   */
  const captureList = (captures, heading) => [
    `<section><h2>${escapeText(heading)}</h2>`,
    captures.map((capture) => `<article data-run="${escapeAttribute(capture.runId)}" ` +
      `data-collected="${escapeAttribute(capture.collectedAt)}"><ul>` +
      capture.entries.map((entry) => `<li data-label="${escapeAttribute(entry.label)}">` +
        escapeText(entry.label) + ': ' + escapeText(entry.count) + ' total, ' + escapeText(entry.uniques) +
        ' unique</li>').join('') + '</ul></article>').join(''),
    '</section>',
  ].join('\n');

  /**
   * @param {string} owner
   * @param {string} name
   * @param {string} from
   * @param {string} to
   * @returns {string} a same-origin path built with the URL helper.
   */
  const detailPath = (owner, name, from, to) =>
    `/repo/${escapeUrl(owner)}/${escapeUrl(name)}?from=${escapeUrl(from)}&to=${escapeUrl(to)}`;

  return {
    index: (ctx) => timed(ctx, () => {
      const { from, to } = resolveWindow(ctx);
      const health = collectionHealth({ db, clock });
      const html = documentShell({
        title: 'RepoSignal',
        body: [
          '<h1>RepoSignal</h1>',
          `<p class="range">Selected range ${escapeText(from)} to ${escapeText(to)}.</p>`,
          `<p class="state">Collection state ${escapeText(health.summary.state)} over ` +
            `${escapeText(health.summary.enrolled)} enrolled repositories.</p>`,
          `<p><a href="${escapeAttribute(ctx.links.list)}">Enrolled repositories</a></p>`,
        ].join('\n'),
      });
      return { html, details: { repositories: health.summary.enrolled } };
    }),

    list: (ctx) => timed(ctx, () => {
      const { from, to } = resolveWindow(ctx);
      const enrolled = listEnrolledRepositories(db);
      const rows = enrolled.map((repository) => {
        const label = `${repository.owner}/${repository.name}`;
        const state = repositoryHealth(db, repository.id, clock());
        return `<tr data-repository="${escapeAttribute(label)}"><th scope="row">` +
          `<a href="${escapeAttribute(detailPath(repository.owner, repository.name, from, to))}">` +
          `${escapeText(label)}</a></th><td>${escapeText(state.state)}</td>` +
          `<td>${escapeText(repository.lifecycle)}</td></tr>`;
      });
      const html = documentShell({
        title: 'Repositories - RepoSignal',
        body: [
          '<h1>Repositories</h1>',
          `<p class="range">Selected range ${escapeText(from)} to ${escapeText(to)}.</p>`,
          '<table><caption>Enrolled repositories and their collection state</caption>' +
            '<thead><tr><th scope="col">Repository</th><th scope="col">State</th>' +
            `<th scope="col">Lifecycle</th></tr></thead><tbody>${rows.join('')}</tbody></table>`,
          `<p><a href="${escapeAttribute(ctx.links.index)}">Back to the index</a></p>`,
        ].join('\n'),
      });
      return { html, details: { repositories: enrolled.length } };
    }),

    detail: (ctx) => timed(ctx, () => {
      // The route guarantees both identity parts on this route; the read refuses a
      // missing one rather than looking up an identity that could name no row.
      const owner = /** @type {string} */ (ctx.owner);
      const name = /** @type {string} */ (ctx.name);
      const { from, to } = resolveWindow(ctx);
      const page = readRepositoryPage({ db, owner, name, from, to, clock, today: to });
      const label = `${page.owner}/${page.name}`;
      const series = seriesTable(page);
      const html = documentShell({
        title: `${label} - RepoSignal`,
        body: [
          `<h1>${escapeText(page.owner)}/${escapeText(page.name)}</h1>`,
          `<p class="range">Range ${escapeText(page.range.from)} to ${escapeText(page.range.to)}, ` +
            `${escapeText(page.calendarDays.length)} days.</p>`,
          // The same value in all three contexts, so each context is checked on the
          // served markup rather than on a helper in isolation.
          `<p class="identity" data-repository="${escapeAttribute(label)}">${escapeText(label)}</p>`,
          `<p><a href="${escapeAttribute(detailPath(page.owner, page.name, page.range.from, page.range.to))}">` +
            'This page again, by URL</a></p>',
          `<p class="status">Page status ${escapeText(page.status)}; lifecycle ` +
            `${escapeText(page.repository?.lifecycle ?? 'none recorded')}.</p>`,
          series.html,
          captureList(page.captures.referrers, 'Referrer captures'),
          captureList(page.captures.popularPaths, 'Popular path captures'),
          '<section><h2>Collection state</h2>' +
            `<p>${escapeText(page.health?.state ?? 'not recorded')}</p>` +
            `<p>${escapeText(page.health?.reason ?? 'no recorded collection state')}</p></section>`,
          '<section><h2>Provenance</h2>' +
            `<p>${escapeText(page.provenance?.state ?? 'not recorded')}; first collected ` +
            `${escapeText(page.provenance?.firstCollectedDay ?? 'not stamped')}.</p></section>`,
          `<p><a href="${escapeAttribute(ctx.links.index)}">Index</a> ` +
            `<a href="${escapeAttribute(ctx.links.list)}">Repositories</a></p>`,
        ].join('\n'),
      });
      return {
        html,
        details: {
          calendarDays: series.calendarDays,
          storedRows: series.storedRows,
          gapDays: series.gapDays,
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixtures: a temporary home, a real migrated archive, a seeded set, a real server.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SeedRepository
 * @property {number} id Stable identity the archive allocates.
 * @property {string} owner
 * @property {string} name
 * @property {readonly string[]} [days] Days this repository has stored traffic for; a day left out stays a gap.
 * @property {readonly string[]} [calendar] Days the seeded range covers, used for the weekly buckets.
 * @property {boolean} [quiet] Seed no observation at all for this repository.
 * @property {boolean} [hostileReferrer] Record a referrer label that is markup.
 */

/**
 * @typedef {object} ServerFixture
 * @property {import('node:sqlite').DatabaseSync} db The open, migrated archive.
 * @property {string} home The temporary home the product resolved.
 * @property {{url: string, close: () => Promise<void>}} server The running server.
 * @property {RenderMeasurement[]} measurements One entry per render the registry performed.
 */

/**
 * Seed one repository through the product's own writes: the identity through the
 * repository upsert, day facts through the day-series upsert, list captures through
 * the snapshot append, the collection state through the supervision recorder and
 * the boundary through the provenance stamp. Direct SQL is never used, so every row
 * a served page shows is a row the schema's own constraints accepted.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SeedRepository} seed
 * @param {object} context
 * @param {string} context.runId Run the captures belong to.
 * @param {number} context.seed Per-repository offset, so no two repositories share a value.
 * @returns {void}
 */
function seedRepository(db, seed, context) {
  const { runId, seed: offset } = context;
  upsertRepository(db, { id: seed.id, owner: seed.owner, name: seed.name, lastSeenAt: RUN_ONE, enrolled: 1 });
  if (seed.quiet === true) return;
  const days = seed.days ?? [];
  const calendar = seed.calendar ?? days;
  const first = days.length === 0 ? FROM : /** @type {string} */ (days[0]);
  const last = days.length === 0 ? TO : /** @type {string} */ (days[days.length - 1]);

  withTransaction(db, () => {
    days.forEach((day, index) => {
      for (const metric of TRAFFIC_METRICS) {
        upsertDayFact(db, {
          repositoryId: seed.id, metric: metric.metric, granularity: 'day', day,
          value: metric.value(index, offset), source: 'collected', collectedAt: COLLECTED_AT,
        });
      }
    });
    // A weekly bucket sits at its week start, so every other day of that week has
    // no stored row: a reader that read a week as a day would be visible here.
    for (const week of weekStarts(calendar)) {
      for (const metric of WIDE_METRICS) {
        upsertDayFact(db, {
          repositoryId: seed.id, metric, granularity: 'week', day: week,
          value: 4 + offset, source: 'backfill', collectedAt: BACKFILLED_AT,
        });
      }
    }
    // A backfilled star history that predates every collected day, so a boundary
    // read from the earliest stored row of some other metric would be visible.
    upsertDayFact(db, {
      repositoryId: seed.id, metric: STARS_METRIC, granularity: STARS_GRANULARITY,
      day: BACKFILLED_STAR_DAY, value: 12, source: STARS_SOURCE, collectedAt: BACKFILLED_AT,
    });
    upsertDayFact(db, {
      repositoryId: seed.id, metric: STARS_METRIC, granularity: STARS_GRANULARITY,
      day: last, value: 12 + offset, source: STARS_SOURCE, collectedAt: BACKFILLED_AT,
    });
    appendSnapshot(db, {
      repositoryId: seed.id, runId, kind: 'referrers',
      label: seed.hostileReferrer === true ? HOSTILE_REFERRER : 'https://example.org/blog',
      count: 4, uniques: 2, position: 0, collectedAt: RUN_ONE,
    });
    appendSnapshot(db, {
      repositoryId: seed.id, runId, kind: 'referrers',
      label: 'https://news.example/post', count: 2, uniques: 2, position: 1, collectedAt: RUN_ONE,
    });
    appendSnapshot(db, {
      repositoryId: seed.id, runId, kind: 'popular_paths',
      label: '/guide', title: 'Guide', count: 11, uniques: 6, position: 0, collectedAt: RUN_TWO,
    });
  });

  // The collection state and the boundary are stamped by the writes that own them,
  // each inside the transaction it manages itself.
  recordSuccess({ db, repositoryId: seed.id, collectedAt: COLLECTED_AT });
  stampFirstCollected(db, seed.id, { day: first, collectedAt: RUN_ONE });
}

/**
 * Start the real server over a real migrated archive with the stub registry
 * mounted, and return everything the assertions need.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} options
 * @param {SeedRepository[]} options.repositories Repositories to seed, in archive order.
 * @param {string} options.from First day of the default range.
 * @param {string} options.to Last day of the default range.
 * @returns {Promise<ServerFixture>}
 */
async function createServerFixture(t, { repositories, from, to }) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-server-e2e-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  // The product resolves the home itself, so the archive really lands where the
  // product would put it: outside every work tree, held at 0700.
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: home } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700, 'the home directory is held at 0700');
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());

  appendRun(db, { id: 'run-1', startedAt: RUN_ONE });
  appendRun(db, { id: 'run-2', startedAt: RUN_TWO });
  completeRun(db, 'run-2', {
    closedAt: COLLECTED_AT, status: 'completed', successCount: repositories.length,
    failureCount: 0, requestCount: repositories.length * 4, durationMs: 4200,
  });
  repositories.forEach((seed, index) => seedRepository(db, seed, { runId: 'run-2', seed: index + 1 }));

  /** @type {RenderMeasurement[]} */
  const measurements = [];
  const views = createStubRegistry({
    db,
    clock: () => READ_AT_MS,
    defaultFrom: from,
    defaultTo: to,
    now: () => performance.now(),
    measurements,
  });
  // The router asks the archive, not a test double, whether a repository is known.
  const router = createRouter({ views, hasRepository: (owner, name) => findRepository(db, owner, name) !== null });
  const server = await createServer({ handler: router, logger: () => {} });
  t.after(() => server.close());
  loopbackOrigins.push(`${new URL(server.url).origin}/`);

  return { db, home: paths.home, server, measurements };
}

/**
 * Request one page over the running server and read the whole response, so the
 * assertions are about bytes on the wire rather than about a status line.
 *
 * @param {ServerFixture} f
 * @param {string} pathname Path and query, relative to the server URL.
 * @param {RequestInit} [init]
 * @returns {Promise<{status: number, headers: Headers, body: string, wallClockMs: number}>}
 */
async function request(f, pathname, init) {
  const startedAt = performance.now();
  const response = await fetch(`${f.server.url}${pathname}`, init);
  const body = await response.text();
  return { status: response.status, headers: response.headers, body, wallClockMs: performance.now() - startedAt };
}

/**
 * The security header policy, read off the response rather than off the module that
 * wrote it, so a header the server stopped sending fails here.
 * @param {Headers} headers
 * @param {string} label
 * @returns {void}
 */
function assertSecurityHeaders(headers, label) {
  const csp = headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/, `${label}: no source is allowed by default`);
  assert.match(csp, /script-src 'none'/, `${label}: no script is allowed`);
  assert.match(csp, /style-src 'self'/, `${label}: styles come from this origin only`);
  assert.equal(headers.get('cache-control'), 'no-store', `${label}: the page is never cacheable`);
  assert.equal(headers.get('referrer-policy'), 'no-referrer', `${label}: no referrer leaves the page`);
  assert.equal(headers.get('x-content-type-options'), 'nosniff', `${label}: no content sniffing`);
  assert.equal(headers.get('access-control-allow-origin'), null, `${label}: no cross-origin header is sent`);
  assert.equal(headers.get('access-control-allow-methods'), null, `${label}: no cross-origin method header`);
  assert.match(headers.get('content-type') ?? '', /^text\/html/, `${label}: the page is served as HTML`);
}

/**
 * Every addressable reference on a served page, read out of the markup.
 * @param {string} body
 * @returns {string[]}
 */
function referencesOf(body) {
  return [...body.matchAll(/\b(?:href|src|srcset)\s*=\s*"([^"]*)"/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// The five requests.
// ---------------------------------------------------------------------------

test('the five requests over the running server return 200, 200, 200, 400 and 404 with the security headers', async (t) => {
  // Arrange: three enrolled repositories over a real migrated archive - one
  // collected, one that has never run, one whose stored name is markup - mounted
  // behind the stub registry and served by the real factory on a real port.
  const window = calendarDays(FROM, TO);
  const storedDays = window.filter((day) => day !== HOLE);
  const f = await createServerFixture(t, {
    from: FROM,
    to: TO,
    repositories: [
      { id: 1, owner: OWNER, name: NAME, days: storedDays, calendar: window },
      { id: 2, owner: OWNER, name: QUIET_NAME, quiet: true },
      { id: 3, owner: HOSTILE_OWNER, name: HOSTILE_NAME, days: [FROM, TO], hostileReferrer: true },
    ],
  });
  const query = `from=${FROM}&to=${TO}`;
  const before = archiveCounts(f.db);
  const rendersBefore = f.measurements.length;

  // Act and assert: the five requests the route table names, in order.
  const index = await request(f, `/?${query}`);
  assert.equal(index.status, 200, `the index must be served; body was ${JSON.stringify(index.body.slice(0, 200))}`);
  const list = await request(f, `/repos?${query}`);
  assert.equal(list.status, 200, 'the repository list must be served');
  const detail = await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?${query}`);
  assert.equal(detail.status, 200, 'a known repository over a valid range must be served');
  const inverted = await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?from=${TO}&to=${FROM}`);
  assert.equal(inverted.status, 400, 'a range whose from is later than its to is refused, not rendered');
  const unknown = await request(f, `/repo/${escapeUrl(OWNER)}/never-enrolled?${query}`);
  assert.equal(unknown.status, 404, 'a repository the archive does not hold is a 404, never an empty page');

  for (const [label, page] of /** @type {Array<[string, typeof index]>} */ ([
    ['index', index], ['list', list], ['detail', detail], ['inverted range', inverted], ['unknown repository', unknown],
  ])) {
    assertSecurityHeaders(page.headers, label);
  }

  // The server reported a real loopback address on a real ephemeral port.
  assert.equal(new URL(f.server.url).hostname, '127.0.0.1');
  assert.ok(Number(new URL(f.server.url).port) > 0);

  // Only the three renderable pages ran a view: the inverted range and the unknown
  // repository were refused before any renderer, so the archive was not read for them.
  assert.deepEqual(f.measurements.slice(rendersBefore).map((entry) => entry.route), ['index', 'list', 'detail'],
    'a refused request must not reach a renderer');
  const refusedRenders = f.measurements.slice(rendersBefore);
  assert.equal(refusedRenders.some((entry) => entry.route === 'detail' && entry.name === 'never-enrolled'), false,
    'an unknown repository is refused by the route, not rendered as an empty repository');

  // The index states the recorded collection state and links onward.
  assert.match(index.body, /<html lang="en">/);
  assert.match(index.body, /Collection state/);
  assert.ok(index.body.includes(escapeAttribute(`/repos?${query}`)),
    `the index must link to the list with the range carried; got ${JSON.stringify(index.body)}`);

  // The list names every enrolled repository, including the one that never ran, and
  // every row links to a detail page that keeps the selected range in the URL.
  for (const label of [`${OWNER}/${NAME}`, `${OWNER}/${QUIET_NAME}`, HOSTILE_LABEL]) {
    assert.ok(list.body.includes(escapeText(label)),
      `the list must name ${label} as escaped text; got ${JSON.stringify(list.body)}`);
  }
  assert.ok(list.body.includes(escapeAttribute(`/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?${query}`)),
    'the list must link to a detail page carrying the repository and the range');
  assert.match(list.body, /never-collected/, 'a repository that has never run says so in words');

  // The detail page shows what the archive holds: the stored days, the hole as a gap
  // with no number in it, the captures with the instant that observed them, and the
  // recorded boundary rather than the older backfilled star row.
  assert.equal(count(f.db, 'day_series', `WHERE repository_id=1 AND day='${HOLE}'`), 0,
    'the fixture really has no row for the hole, so the gap is the archive\'s state and not the view\'s');
  assert.ok(detail.body.includes(`data-day="${HOLE}" data-state="gap"`),
    `the day no run recorded must appear as a gap; got ${JSON.stringify(detail.body.slice(0, 400))}`);
  assert.equal(detail.body.includes(`data-day="${HOLE}" data-state="observed"`), false,
    'a day the archive holds no row for is never presented as an observation');
  assert.ok(detail.body.includes(`data-day="${FROM}" data-state="observed"`));
  assert.ok(detail.body.includes(`data-day="${TO}" data-state="observed"`));
  assert.ok(detail.body.includes(`data-collected="${RUN_TWO}"`),
    'a list capture travels with the run and the instant that observed it');
  assert.ok(detail.body.includes(`first collected ${escapeText(FROM)}`),
    'the boundary is the recorded stamp, not the 2024 star row stored before it');
  assert.equal(detail.body.includes(BACKFILLED_STAR_DAY), false,
    'a day outside the selected range is not on the page');
  assert.match(detail.body, /Page status known/);
  assert.match(detail.body, /<main id="main">/, 'the page uses the shared document shell');
  assert.equal(detail.body.match(/<main\b/g)?.length, 1, 'exactly one main landmark');

  // The 400 page names the inversion in words, through the same shell; the 404 page
  // names the repository that is not enrolled, through the same shell.
  assert.match(inverted.body, /[Ii]nverted range/);
  assert.ok(inverted.body.includes(escapeText(`from ${TO} is later than to ${FROM}`)),
    `the 400 page must name both bounds; got ${JSON.stringify(inverted.body)}`);
  assert.match(inverted.body, /<main id="main">/, 'the 400 page uses the shared document shell');
  assert.match(unknown.body, /[Uu]nknown repository/);
  assert.ok(unknown.body.includes(escapeText(`${OWNER}/never-enrolled`)),
    `the 404 page must name the repository that is not enrolled; got ${JSON.stringify(unknown.body)}`);
  assert.match(unknown.body, /<main id="main">/, 'the 404 page uses the shared document shell');

  // Serving five pages wrote nothing: the archive a page reads is read-only.
  assert.deepEqual(archiveCounts(f.db), before, 'serving pages must not write to the archive');
});

test('a route carrying one range bound still serves a page over a window it resolved', async (t) => {
  // Arrange: the same archive, with a window the fixture declares. The route is
  // allowed to arrive with a single bound, and the page read refuses a range that
  // is missing one, so a view that hands the read a half-range turns the page into
  // a generic 500. That is the failure this test exists to make visible.
  const f = await createServerFixture(t, {
    from: FROM,
    to: TO,
    repositories: [{ id: 1, owner: OWNER, name: NAME, days: calendarDays(FROM, TO) }],
  });
  const path = `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}`;

  // Act: the three one-sided and bare routes the range parameters allow.
  const onlyTo = await request(f, `${path}?to=${TO}`);
  const onlyFrom = await request(f, `${path}?from=${FROM}`);
  const bare = await request(f, path);

  // Assert: each is served rather than refused or crashed, and each is served over
  // the same resolved window, because that window is a decision and it is visible.
  for (const [label, page] of /** @type {Array<[string, typeof onlyTo]>} */ ([
    ['only a last day', onlyTo], ['only a first day', onlyFrom], ['no bounds at all', bare],
  ])) {
    assert.equal(page.status, 200,
      `${label}: a route with one bound must still serve a page; body was ` +
      `${JSON.stringify(page.body.slice(0, 200))}`);
    assert.equal(page.body.includes('The page could not be rendered'), false,
      `${label}: a half-range must not become the generic 500 page`);
    assert.ok(page.body.includes(`Range ${escapeText(FROM)} to ${escapeText(TO)}`),
      `${label}: the page must say which window it resolved; got ${JSON.stringify(page.body.slice(0, 400))}`);
    assertSecurityHeaders(page.headers, label);
  }
  // The three routes resolved the same window, which is the decision being claimed:
  // the render measurement of each page names the bounds the view chose.
  const resolved = f.measurements.filter((entry) => entry.route === 'detail');
  assert.deepEqual(resolved.map((entry) => [entry.from, entry.to]),
    [[FROM, TO], [FROM, TO], [FROM, TO]],
    'a one-sided route must resolve the window the view declares, not a window it invents');
});

test('a repository name carrying markup is escaped on the served page in every context', async (t) => {
  // Arrange: the archive holds an identity whose stored spelling is markup, with a
  // referrer label that is markup too, so the served body is asked about both.
  const f = await createServerFixture(t, {
    from: FROM,
    to: TO,
    repositories: [
      { id: 1, owner: OWNER, name: NAME, days: calendarDays(FROM, TO) },
      { id: 7, owner: HOSTILE_OWNER, name: HOSTILE_NAME, days: [FROM, TO], hostileReferrer: true },
    ],
  });
  const query = `from=${FROM}&to=${TO}`;
  const hostilePath = `/repo/${escapeUrl(HOSTILE_OWNER)}/${escapeUrl(HOSTILE_NAME)}?${query}`;

  // Act: request the hostile repository through the real route, with the path built
  // by the product's own URL helper, and the list page that names the identity too.
  const detail = await request(f, hostilePath);
  const list = await request(f, `/repos?${query}`);

  assert.equal(detail.status, 200, `the hostile name is a stored identity, so the page is served; ` +
    `body was ${JSON.stringify(detail.body.slice(0, 300))}`);
  assertSecurityHeaders(detail.headers, 'hostile detail');
  assertSecurityHeaders(list.headers, 'hostile list');

  for (const [label, page] of /** @type {Array<[string, typeof detail]>} */ ([
    ['detail', detail], ['list', list],
  ])) {
    // Escaped: the markup survives as entities and percent-encoding, in each context
    // the product defines for it.
    assert.ok(page.body.includes(escapeText(HOSTILE_LABEL)),
      `${label}: the hostile identity must appear escaped in text context`);
    assert.ok(page.body.includes(`data-repository="${escapeAttribute(HOSTILE_LABEL)}"`),
      `${label}: the hostile identity must appear attribute-escaped`);
    assert.ok(page.body.includes(`href="${escapeAttribute(hostilePath)}"`),
      `${label}: the hostile identity must appear percent-encoded in URL context`);

    // Unescaped nowhere: not as markup, not as the raw stored spelling, and not as
    // the attribute or element a browser would act on.
    assert.equal(page.body.includes('<script'), false, `${label}: no script element may reach the page`);
    assert.equal(page.body.includes('<img'), false, `${label}: no injected element of any kind`);
    assert.equal(page.body.includes(HOSTILE_NAME), false,
      `${label}: the raw repository name must appear nowhere in the body`);
    assert.equal(page.body.includes('"><script'), false,
      `${label}: the payload must not be able to close an attribute and open an element`);
    assert.equal(page.body.includes(HOSTILE_REFERRER), false,
      `${label}: the raw referrer label must appear nowhere in the body`);
  }

  // The referrer label is escaped where it is shown and attribute-escaped where it is
  // carried, exactly like the repository name.
  assert.ok(detail.body.includes(escapeText(HOSTILE_REFERRER)),
    'a stored referrer label carrying markup must appear escaped');
  assert.ok(detail.body.includes(`data-label="${escapeAttribute(HOSTILE_REFERRER)}"`),
    'a stored referrer label must be attribute-escaped where it is carried');

  // Escaping happens on the way out, not on the way in: the archive still holds the
  // spelling a collector recorded, byte for byte, and no escaped spelling was
  // written back into it.
  assert.equal(findRepository(f.db, HOSTILE_OWNER, HOSTILE_NAME)?.name, HOSTILE_NAME,
    'the archive must hold the identity it was given, unescaped');
  assert.equal(count(f.db, 'repositories', "WHERE name LIKE '%&lt;%'"), 0,
    'no escaped spelling was written back into the archive');
});

test('a detail page over six repositories and four hundred days renders inside the budget', async (t) => {
  // Arrange: the six repositories RS-PR-01 names, each with a full four-hundred-day
  // window of collected traffic, weekly development buckets and a backfilled star
  // history. The first repository has a hole in the middle of its window.
  const WIDE_TO = '2026-10-01';
  const WIDE_FROM = dayBefore(WIDE_TO, 399);
  const wideWindow = calendarDays(WIDE_FROM, WIDE_TO);
  assert.equal(wideWindow.length, 400, 'the wide range must be four hundred days');
  const weeks = weekStarts(wideWindow);
  // The hole is an interior day that is not a week start, so the archive holds no row
  // of any metric for it at all: "a day with no data" is exactly the fixture.
  const wideHole = /** @type {string} */ (wideWindow.slice(1, -1).find((day) => !weeks.includes(day)));
  const enrolled = Array.from({ length: 6 }, (unused, index) => `repo-${index + 1}`);
  const f = await createServerFixture(t, {
    from: WIDE_FROM,
    to: WIDE_TO,
    repositories: enrolled.map((name, index) => ({
      id: index + 1,
      owner: 'owner',
      name,
      days: wideWindow.filter((day) => !(index === 0 && day === wideHole)),
      calendar: wideWindow,
    })),
  });
  const query = `from=${WIDE_FROM}&to=${WIDE_TO}`;

  // The archive really holds six repositories over four hundred days, asserted
  // against the database rather than against a summary line.
  assert.equal(count(f.db, 'repositories'), 6);
  assert.equal(count(f.db, 'day_series', "WHERE source='collected'"),
    6 * wideWindow.length * TRAFFIC_METRICS.length - TRAFFIC_METRICS.length,
    'every repository stored the returned window, less the day the first repository never recorded');
  assert.equal(count(f.db, 'day_series', "WHERE source='backfill' AND granularity='week'"),
    6 * WIDE_METRICS.length * weeks.length);
  assert.equal(count(f.db, 'day_series', `WHERE repository_id=1 AND day='${wideHole}'`), 0);
  assert.equal(count(f.db, 'day_series', `WHERE repository_id=1 AND metric='${VIEWS_METRIC}'`), 399);

  // Act: the detail page over the whole range, then the list page over the same
  // range. Both travel over loopback through the real server.
  const detail = await request(f, `/repo/${escapeUrl('owner')}/${escapeUrl(/** @type {string} */ (enrolled[0]))}?${query}`);
  const list = await request(f, `/repos?${query}`);

  assert.equal(detail.status, 200, `the wide detail page must be served; ${detail.body.slice(0, 200)}`);
  assert.equal(list.status, 200);
  assertSecurityHeaders(detail.headers, 'wide detail');
  assertSecurityHeaders(list.headers, 'wide list');

  // The page was built from the whole range and from the stored rows, not from a
  // truncated read: the measurement carries the counts the page was made of.
  const renders = f.measurements.filter((entry) => entry.route === 'detail');
  assert.equal(renders.length, 1, `one detail render was expected; got ${JSON.stringify(f.measurements)}`);
  const render = /** @type {RenderMeasurement} */ (renders[0]);
  assert.equal(render.from, WIDE_FROM);
  assert.equal(render.to, WIDE_TO);
  assert.equal(render.calendarDays, 400, 'the page covered all four hundred days');
  assert.equal(render.storedRows,
    TRAFFIC_METRICS.length * 399 + WIDE_METRICS.length * weeks.length + 1,
    'the page carried every stored row for the range, and no more');
  assert.ok(render.gapDays !== undefined && render.gapDays > 0, 'the page named its gaps rather than filling them');
  assert.ok(detail.body.includes(`data-day="${wideHole}" data-state="gap"`),
    'the hole in the wide range reached the page as a gap');
  assert.ok(detail.body.includes(`data-day="${WIDE_FROM}" data-state="observed"`));
  assert.ok(detail.body.includes(`data-day="${WIDE_TO}" data-state="observed"`));
  assert.equal(detail.body.includes('>0</td>'), false,
    'no value cell holds a bare zero, so no unmeasured day was substituted with one');

  // The render budget, from the injected monotonic measurement around the page
  // build with the database already open - the wording RS-PR-01 uses.
  assert.ok(render.elapsedMs < RENDER_BUDGET_MS,
    `a detail page over six repositories and four hundred days must render in under ${RENDER_BUDGET_MS} ms; ` +
    `the injected measurement recorded ${render.elapsedMs} ms for ${render.bytes} bytes`);
  const listRender = f.measurements.find((entry) => entry.route === 'list');
  assert.equal(listRender?.repositories, 6, 'the list page covered all six repositories');
  assert.ok(listRender !== undefined && listRender.elapsedMs < RENDER_BUDGET_MS,
    `the list page over the same range must render in under ${RENDER_BUDGET_MS} ms; the injected measurement ` +
    `recorded ${listRender === undefined ? 'no render' : `${listRender.elapsedMs} ms`}`);
  // The budget is about rendering, but a request that never came back would prove
  // nothing either, so the round trip is bounded as well.
  assert.ok(detail.wallClockMs < RENDER_BUDGET_MS * 4,
    `the whole request took ${detail.wallClockMs} ms, which is not a served page`);
});

test('no page loads a remote asset, emits a script or answers with a cross-origin header', async (t) => {
  // Arrange: one repository with referrer labels and a popular path, so the pages
  // carry dynamic text that a careless view could turn into markup or into a fetch.
  const f = await createServerFixture(t, {
    from: FROM,
    to: TO,
    repositories: [{ id: 1, owner: OWNER, name: NAME, days: calendarDays(FROM, TO) }],
  });
  const query = `from=${FROM}&to=${TO}`;

  // Act: fetch every page the route table serves, including the two refusals.
  const pages = /** @type {Array<[string, Awaited<ReturnType<typeof request>>]>} */ ([
    ['index', await request(f, `/?${query}`)],
    ['list', await request(f, `/repos?${query}`)],
    ['detail', await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?${query}`)],
    ['inverted range', await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?from=${TO}&to=${FROM}`)],
    ['unknown repository', await request(f, `/repo/${escapeUrl(OWNER)}/never-enrolled?${query}`)],
  ]);

  for (const [label, page] of pages) {
    assertSecurityHeaders(page.headers, label);
    assert.match(page.headers.get('content-security-policy') ?? '', /img-src 'self'/,
      `${label}: an image would come from this origin only`);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/,
      `${label}: the page cannot be framed`);
    assert.equal(/<script/i.test(page.body), false, `${label}: no page carries a script element`);
    assert.equal(/<[^>]+\son[a-z]+\s*=/i.test(page.body), false, `${label}: no inline event handler`);
    assert.equal(/<iframe|<embed|<object|<link[^>]+rel=["']?import/i.test(page.body), false,
      `${label}: no nested or imported document`);
    // Every addressable reference is relative and same-origin: nothing in a served
    // page can name another machine, so a page introduces no request to any host.
    const references = referencesOf(page.body);
    assert.ok(references.length > 0, `${label}: the page must reference its stylesheet`);
    for (const reference of references) {
      assert.match(reference, /^(#|\/(?!\/))/,
        `${label}: every reference must be a relative same-origin path or a fragment; ` +
        `got ${JSON.stringify(reference)}`);
    }
  }

  // The server still refuses a method the route table does not serve, with the same
  // header policy: the headers belong to the server, not to a page.
  const posted = await request(f, '/repos', { method: 'POST' });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get('allow'), 'GET, HEAD');
  assertSecurityHeaders(posted.headers, 'method refusal');
});

test('this suite reaches no host, and the guard that proves it is live', async (t) => {
  // Arrange: a server this file started, so the guard has a loopback origin to
  // allow and every other host to refuse.
  const f = await createServerFixture(t, {
    from: FROM,
    to: TO,
    repositories: [{ id: 1, owner: OWNER, name: NAME, days: calendarDays(FROM, TO) }],
  });
  const query = `from=${FROM}&to=${TO}`;
  await request(f, `/?${query}`);
  await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?${query}`);

  // Act: attempt a request to the one host this product may talk to in production,
  // and to a host it may never talk to.
  await assert.rejects(() => fetch('https://api.github.com/'), /this suite must not reach any host/,
    'the guard must refuse api.github.com before any socket for it opens');
  await assert.rejects(() => fetch('https://example.org/'), /this suite must not reach any host/);

  // Assert: every URL asked for was recorded, the two outside ones were refused, and
  // nothing that was allowed left the loopback interface. The log spans the whole
  // file, so the servers it names are every server this file started.
  const served = attemptedUrls.filter((url) => !refusedUrls.includes(url));
  assert.ok(served.length >= 2, `the guard must have seen this file's own requests; got ${JSON.stringify(served)}`);
  assert.deepEqual(refusedUrls, ['https://api.github.com/', 'https://example.org/'],
    'exactly the two probes were refused');
  for (const url of served) {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//, `no request left the loopback server; got ${url}`);
    assert.ok(loopbackOrigins.some((origin) => url.startsWith(origin)),
      `every allowed request went to a server this file started; got ${url}`);
  }
  for (const origin of loopbackOrigins) assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(f.server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(served.some((url) => url.startsWith(`${f.server.url}/`)),
    'this test\'s own server really did answer a request, so the guard was not idle');
});

test('the stub registry stays test-local and the server surface makes no request', () => {
  // Arrange: read the sources this suite composes, so the claims below are made
  // against what the files say rather than against what this file intended.
  const serverSources = readdirSync(path.join(ROOT, 'src', 'server'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name: `src/server/${name}`, text: readFileSync(path.join(ROOT, 'src', 'server', name), 'utf8') }));
  const productFiles = listProductFiles(path.join(ROOT, 'src'));

  // Act and assert: the server surface composes no transport of its own. The page
  // data layer, the router and the shell read an archive and build a document;
  // nothing among them may name fetch or an outbound client.
  for (const source of serverSources) {
    assert.equal(/(^|[^.\w])fetch\s*\(/.test(source.text), false,
      `${source.name} must not call fetch; a page cannot make a request of its own`);
    assert.equal(source.text.includes('node:https'), false,
      `${source.name} must not import an outbound transport`);
    // Only the factory may open a listener. A type annotation naming the request
    // type is not an import, so the check is on the module's own calls.
    if (source.name !== 'src/server/server.js') {
      assert.equal(/(^|[^.\w])(createServer|listen)\s*\(/.test(source.text), false,
        `${source.name} must not open a server; only the factory does`);
      assert.equal(/from 'node:http'/.test(source.text), false,
        `${source.name} must not import a server transport`);
    }
  }
  assert.ok(serverSources.some((source) => source.name === 'src/server/router.js'),
    'the router under src/server is the one this suite mounts');

  // The stub registry is a test double: nothing under src/ imports this file and
  // nothing under src/ names the stub. A double that moves into src/ stops being a
  // double, because it becomes product code with no test of its own.
  for (const file of productFiles) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes(THIS_FILE), false, `${file} must not import the test-local stub registry`);
    assert.equal(text.includes('createStubRegistry'), false, `${file} must not name the test-local stub registry`);
  }
  assert.ok(productFiles.length > 0, 'the product surface this claim is about is not empty');
  assert.equal(productFiles.some((file) => file.includes(`${path.sep}tests${path.sep}`)), false,
    'no product file lives under tests');
});

test('the fixture is a real migrated archive the server read, not an empty one', async (t) => {
  // Arrange: the same archive shape every other test here uses, checked directly.
  const f = await createServerFixture(t, {
    from: FROM,
    to: TO,
    repositories: [{ id: 1, owner: OWNER, name: NAME, days: calendarDays(FROM, TO) }],
  });

  // Act: serve the detail page over the small window.
  const page = await request(f, `/repo/${escapeUrl(OWNER)}/${escapeUrl(NAME)}?from=${FROM}&to=${TO}`);
  assert.equal(page.status, 200);

  // Assert: the migration ran against this file's own home, the rows arrived through
  // the product's writes, and the served page read them back unchanged.
  const versions = /** @type {{version: number}[]} */ (/** @type {unknown} */ (
    f.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()))
    .map((row) => ({ version: Number(row.version) }));
  assert.deepEqual(versions, [{ version: 1 }], 'the archive was migrated by the product, not hand-built');
  assert.equal(path.dirname(f.home) !== ROOT, true, 'the temporary home is outside the work tree');
  const stored = readDayFacts(f.db, 1, VIEWS_METRIC, FROM);
  const calendar = calendarDays(FROM, TO);
  assert.equal(stored.length, calendar.length,
    `the seed wrote one row per returned day; ${calendar.length} days were returned`);
  assert.deepEqual(stored.map((row) => row.day), calendar,
    'the archive holds exactly the days the run returned, with none added and none dropped');
  assert.equal(stored[0]?.day, FROM);
  assert.ok(page.body.includes(`<td class="value">${stored[0]?.value}</td>`),
    `the served page shows the stored value, not a summary of it; stored ${JSON.stringify(stored[0])}`);
  assert.ok(page.body.includes(`<td>${TO}</td>`), 'the last day of the range is on the page');
  assert.equal(count(f.db, 'day_series', `WHERE repository_id=1 AND metric='${VIEWS_METRIC}'`), calendar.length,
    'one stored row per returned day, with no day added and none dropped');
});

/**
 * Every file under a directory, so a claim about the whole product surface is made
 * against every file rather than against a glob that might miss one.
 * @param {string} directory
 * @returns {string[]}
 */
function listProductFiles(directory) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listProductFiles(entryPath));
    else if (entry.isFile()) found.push(entryPath);
  }
  return found.sort();
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} repositoryId
 * @param {string} metric
 * @param {string} from
 * @returns {Array<{day: string, value: number}>}
 */
function readDayFacts(db, repositoryId, metric, from) {
  return /** @type {Array<{day: string, value: number}>} */ (/** @type {unknown} */ (db.prepare(
    "SELECT day, value FROM day_series WHERE repository_id=? AND metric=? AND granularity='day' AND day>=? " +
    'ORDER BY day').all(repositoryId, metric, from)));
}