import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stampFirstCollected } from '../../src/backfill/provenance.js';
import { STARS_GRANULARITY, STARS_METRIC, STARS_SOURCE } from '../../src/backfill/stars.js';
import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../../src/collect/traffic.js';
import { calendarDays, upsertDayFact } from '../../src/db/day-series-repo.js';
import {
  appendBackfillRecord, appendRun, completeRun, listEnrolledRepositories, openArchive, upsertRepository,
  withTransaction,
} from '../../src/db/ops-repo.js';
import { appendSnapshot } from '../../src/db/snapshot-repo.js';
import { resolveHomePaths } from '../../src/paths.js';
import { escapeText, escapeUrl } from '../../src/server/html.js';
import { createRouter } from '../../src/server/router.js';
import { createServer } from '../../src/server/server.js';
import {
  auditChartPairing, auditDocument, headingLevelSkips, skipLink, sliceElements, visibleText,
} from '../../src/server/views/a11y.js';
import { createViewRegistry } from '../../src/server/views/index.js';
import { NO_STORED_VALUE_TEXT } from '../../src/server/views/repo-list.js';
import { collectionHealth, statePhrase } from '../../src/supervision/health.js';
import { recordFailure, recordSuccess } from '../../src/supervision/repo-state-reporter.js';
import { GAP_CELL_TEXT } from '../../src/views/components/line-chart.js';

/**
 * Every dashboard page, requested from the running server.
 *
 * RS-UI-FR-05 asks for one test that starts the real server against a temporary
 * home with seeded data and requests every page. This file is that test. The only
 * thing it substitutes is the clock: the server factory, the router, the document
 * shell, the escaping helpers, the view registry and all three view modules are
 * the product's own, mounted exactly the way `src/commands/serve.js` mounts them,
 * and every request travels over real loopback HTTP to whatever ephemeral port the
 * factory actually bound. The last test repeats the six requests through
 * `node src/cli.js serve` itself, so the composition the entry point performs is
 * the one under test rather than one this file assembled.
 *
 * The archive is a real migrated archive in a real temporary home, and every row
 * in it was written through the product's own repositories - identities through
 * `upsertRepository`, day facts through `upsertDayFact`, captures through
 * `appendSnapshot`, the boundary through `stampFirstCollected`, the backfill
 * record through `appendBackfillRecord`, collection state through the supervision
 * recorder - so every number a served page shows is a row the schema's own
 * constraints accepted. No direct SQL seeds data, and the row counts the
 * assertions compare against are counted from the database rather than from a
 * page's own account of itself.
 *
 * One seeder builds the archive, so both fixtures hold the same shape. The
 * seeded archive carries exactly what the task names: a deliberate hole in the
 * stored range, two snapshot captures of one list, a backfilled range before the
 * recorded boundary and a collected range after it, and six repositories covering
 * six of the seven collection states the health read can report.
 *
 * Nothing here reaches a host. A fetch guard installed for the whole file records
 * every URL asked for and refuses anything that is not this file's own loopback
 * servers, and one test probes that guard directly, so "this suite makes no
 * outbound request" is a statement about a list rather than a promise. No test
 * reads a token: the temporary home holds an archive and nothing else, which one
 * test asserts, and the suite runs with no local-transport override set at all.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../../src/server/views/a11y.js').DocumentAudit} DocumentAudit */
/** @typedef {import('../../src/server/views/a11y.js').TableSummary} TableSummary */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How many days the seeded window covers. */
const WINDOW_DAYS = 14;

/** The reference day the fixed fixture's window ends on, and when its reads are taken. */
const FIXED_TODAY = '2026-10-02';
const FIXED_READ_AT = '2026-10-02T12:00:00.000Z';

const OWNER = 'maintainer';
/** Collected, with the hole in the middle of its range. */
const ARCHIVE = 'archive';
/** Enrolled and never touched by a run, so it reports never-collected. */
const FRESH = 'fresh';
/** A rate limit nothing a new token clears, so it reports degraded. */
const FLAKY = 'flaky';
/** A refused token, so it reports needs-re-authentication. */
const LAPSED = 'lapsed';
/** A last success past the stall threshold, so it reports stalled. */
const STALE = 'stale';
/** GitHub no longer serves it, so it reports unavailable. */
const RETIRED = 'retired';

/** An identity the archive does not hold, so the router refuses it with a 404. */
const UNKNOWN_NAME = 'never-enrolled';

/**
 * The state each fixture repository is recorded in, keyed by its archived
 * identity. These are the words `src/supervision/health.js` returns; the test
 * checks the served page against this table *and* against the read itself, so a
 * page that reported a different state, and a read that returned a different
 * word, both fail.
 *
 * @type {Readonly<Record<string, string>>}
 */
const EXPECTED_STATES = Object.freeze({
  [`${OWNER}/${ARCHIVE}`]: 'healthy',
  [`${OWNER}/${FRESH}`]: 'never-collected',
  [`${OWNER}/${FLAKY}`]: 'degraded',
  [`${OWNER}/${LAPSED}`]: 'needs-re-authentication',
  [`${OWNER}/${STALE}`]: 'stalled',
  [`${OWNER}/${RETIRED}`]: 'unavailable',
});

/**
 * The four traffic metrics and the value each seeded day carries. Every value is
 * derived from the day's index and the repository's own offset, so no two
 * repositories or days share a number by accident of scripting, and no value is
 * ever zero - which is what makes the "no substituted zero" assertions below real
 * checks rather than coincidences.
 *
 * @type {ReadonlyArray<{metric: string, value: (index: number, seed: number) => number}>}
 */
const TRAFFIC_METRICS = Object.freeze([
  Object.freeze({
    metric: CLONES_METRIC,
    value: (/** @type {number} */ index, /** @type {number} */ seed) => 2 + ((index * 3 + seed) % 7),
  }),
  Object.freeze({
    metric: UNIQUE_CLONERS_METRIC,
    value: (/** @type {number} */ index, /** @type {number} */ seed) => 1 + ((index + seed) % 4),
  }),
  Object.freeze({
    metric: VIEWS_METRIC,
    value: (/** @type {number} */ index, /** @type {number} */ seed) => 30 + ((index * 5 + seed) % 11),
  }),
  Object.freeze({
    metric: UNIQUE_VISITORS_METRIC,
    value: (/** @type {number} */ index, /** @type {number} */ seed) => 5 + ((index * 2 + seed) % 6),
  }),
]);

/**
 * The chart component labels its value axis at zero. That is a scale, not a
 * measurement, so the assertions about substituted zeros name this one exemption
 * instead of searching for "no zero anywhere" and passing by luck.
 */
const AXIS_ZERO = /<text[^>]*class="chart-axis-label"[^>]*>0<\/text>/g;

/** Words that would turn a measurement into a verdict the archive does not support (RS-HO-01). */
const VERDICT_WORDS = [
  'adoption', 'adopters', 'score', 'scoring', 'ranked higher', 'outperform', 'outperforms',
  'outranking', 'anomaly', 'anomalous', 'spike detected', 'surging', 'surged', 'soaring',
  'declining', 'declined', 'increasing trend', 'decreasing trend', 'best-performing',
];

/** Every table the archive owns, so "serving a page wrote nothing" is a whole-archive claim. */
const ARCHIVE_TABLES = ['repositories', 'repository_aliases', 'runs', 'day_series', 'snapshots',
  'repository_errors', 'heartbeats', 'backfill_records'];

// ---------------------------------------------------------------------------
// Network guard: this file may talk to nothing but its own loopback servers.
// ---------------------------------------------------------------------------

/** @type {typeof globalThis.fetch|null} */
let realFetch = null;
/** @type {string[]} Every URL `fetch` was asked for, in order. */
const attemptedUrls = [];
/** @type {string[]} The URLs the guard refused. */
const refusedUrls = [];
/** @type {string[]} The loopback origins this file is allowed to talk to. */
const loopbackOrigins = [];

/**
 * Replace `fetch` with a recorder that refuses every URL outside this file's own
 * loopback servers. Installed once for the whole file, so a request made from any
 * code path - including a module the server loads - is recorded before it is
 * refused, and refused before a socket for it can open.
 *
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
// The archive plan: every date and instant the fixture derives from two inputs.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ArchivePlan
 * @property {string} today Reference day the window ends on.
 * @property {number} nowMs Epoch milliseconds every health read is judged against.
 * @property {string} from First day of the window.
 * @property {string} to Last day of the window, inclusive.
 * @property {string} boundary The recorded first collected day.
 * @property {string} hole The day inside the window no run ever recorded.
 * @property {string[]} window Every calendar day the window covers.
 * @property {string} recentAt A success five hours before the read: inside the 26-hour threshold.
 * @property {string} staleAt A success thirty-one hours before the read: past the threshold.
 * @property {string} failedAt The instant the recorded failures were written.
 * @property {string} backfilledAt The instant the backfilled range was recorded, before any collection.
 * @property {string} runOne When the first run began.
 * @property {string} runTwo When the second run began.
 * @property {string} query The query every page request carries, selecting the window.
 */

/**
 * Derive the fixture's dates from a reference day and a read instant, so the same
 * seeder fills a fixed archive for the in-process fixtures and a wall-clock one
 * for the spawned `serve` fixture.
 *
 * @param {string} today Reference day, ISO `YYYY-MM-DD`.
 * @param {number} nowMs Epoch milliseconds the health reads are judged against.
 * @returns {ArchivePlan}
 */
function planArchive(today, nowMs) {
  const from = new Date(Date.parse(`${today}T00:00:00.000Z`) - (WINDOW_DAYS - 1) * DAY_MS)
    .toISOString().slice(0, 10);
  const boundary = new Date(Date.parse(`${from}T00:00:00.000Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
  const hole = new Date(Date.parse(`${boundary}T00:00:00.000Z`) + 3 * DAY_MS).toISOString().slice(0, 10);
  return {
    today,
    nowMs,
    from,
    to: today,
    boundary,
    hole,
    window: calendarDays(from, today),
    recentAt: new Date(nowMs - 5 * HOUR_MS).toISOString(),
    staleAt: new Date(nowMs - 31 * HOUR_MS).toISOString(),
    failedAt: new Date(nowMs - 4 * HOUR_MS).toISOString(),
    backfilledAt: `${from}T06:00:00.000Z`,
    runOne: `${from}T06:00:00.000Z`,
    runTwo: `${today}T06:00:00.000Z`,
    query: `from=${from}&to=${today}`,
  };
}

/**
 * The fixed plan: a fixed reference day and a fixed read instant, so every
 * assertion below is about the pages rather than about when the suite ran.
 *
 * @type {ArchivePlan}
 */
const FIXED_PLAN = planArchive(FIXED_TODAY, Date.parse(FIXED_READ_AT));

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/**
 * @param {Database} db
 * @param {string} table
 * @param {string} [where]
 * @returns {number}
 */
function count(db, table, where = '') {
  return Number(/** @type {{n: number}} */ (/** @type {unknown} */ (db.prepare(
    `SELECT count(*) AS n FROM ${table} ${where}`).get())).n);
}

/**
 * @param {Database} db
 * @returns {Record<string, number>} Row count per archive table.
 */
function archiveCounts(db) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of ARCHIVE_TABLES) counts[table] = count(db, table);
  return counts;
}

/**
 * The stored value of one metric on one day, or null when the archive holds no row
 * for it. Read back from the database, so a page that shows a number nobody
 * stored is caught against the archive rather than against itself.
 *
 * @param {Database} db
 * @param {number} repositoryId
 * @param {string} metric
 * @param {string} day
 * @returns {number|null}
 */
function storedValue(db, repositoryId, metric, day) {
  const row = /** @type {{value: number}|undefined} */ (/** @type {unknown} */ (db.prepare(
    'SELECT value FROM day_series WHERE repository_id=? AND metric=? AND day=?').get(repositoryId, metric, day)));
  return row === undefined ? null : row.value;
}

/**
 * @param {string} owner
 * @param {string} name
 * @returns {string} The detail path for one repository, with the identity
 *   percent-encoded by the product's own URL helper.
 */
function detailPath(owner, name) {
  return `/repo/${escapeUrl(owner)}/${escapeUrl(name)}`;
}

/**
 * The `href` an anchor carries for a same-origin reference, attribute-escaped the
 * way the shell's escaping helper writes it, so a page's own link can be compared
 * against the reference the product builds for it.
 *
 * @param {string} reference A same-origin path with its query, unescaped.
 * @returns {string}
 */
function hrefOf(reference) {
  return `href="${reference.replaceAll('&', '&amp;')}"`;
}

/**
 * One request the dashboard must answer, and the status the criteria require of it.
 *
 * @typedef {object} PageRequest
 * @property {string} label What the request is for.
 * @property {string} pathname Path and query, relative to the server URL.
 * @property {number} expected The status the acceptance criteria require of it.
 */

/**
 * The six requests the task names, each with the status the criteria require,
 * built from a plan. The fixed fixtures and the spawned `serve` fixture seed
 * against different days - one a fixed day so every assertion is reproducible, the
 * other the wall clock because the product composes that fixture itself - so the
 * request table takes the plan rather than closing over one.
 *
 * @param {ArchivePlan} plan
 * @returns {readonly PageRequest[]}
 */
function sixRequests(plan) {
  return Object.freeze([
    Object.freeze({ label: 'index', pathname: `/?${plan.query}`, expected: 200 }),
    Object.freeze({ label: 'repository list', pathname: `/repos?${plan.query}`, expected: 200 }),
    Object.freeze({ label: 'detail page', pathname: `${detailPath(OWNER, ARCHIVE)}?${plan.query}`, expected: 200 }),
    // The health page reads recorded collection state, which has no day dimension,
    // so it is requested without a range and the router never sees one.
    Object.freeze({ label: 'health page', pathname: '/health', expected: 200 }),
    Object.freeze({
      label: 'unknown repository',
      pathname: `${detailPath(OWNER, UNKNOWN_NAME)}?${plan.query}`,
      expected: 404,
    }),
    Object.freeze({
      label: 'inverted range',
      pathname: `${detailPath(OWNER, ARCHIVE)}?from=${plan.to}&to=${plan.from}`,
      expected: 400,
    }),
  ]);
}

/** The outcomes the acceptance criteria name, in order. */
const EXPECTED_OUTCOMES = [200, 200, 200, 200, 404, 400];

// ---------------------------------------------------------------------------
// Seeding: one archive, written entirely through the product's repositories.
// ---------------------------------------------------------------------------

/**
 * Seed one repository through the writes that own each kind of row: the identity
 * through the repository upsert, the day facts through the day-series upsert, the
 * list captures through the snapshot append, the boundary through the provenance
 * stamp, the backfill record through the archive's own append, and the recorded
 * collection state through the supervision recorder.
 *
 * @param {Database} db
 * @param {ArchivePlan} plan
 * @param {object} options
 * @param {number} options.id Archive identity to allocate.
 * @param {string} options.name Repository name as the archive holds it.
 * @param {number} options.seed Per-repository offset, so no two repositories share a value.
 * @param {keyof typeof EXPECTED_STATES extends never ? never : string} options.state
 *   The state word this repository is recorded in; the only archive difference
 *   between two fixtures is which state word their rows produce.
 * @returns {void}
 */
function seedRepository(db, plan, { id, name, seed, state }) {
  upsertRepository(db, { id, owner: OWNER, name, lastSeenAt: plan.runOne, enrolled: 1 });

  if (state === 'never-collected') {
    // Enrolled and never touched by a run: no stored day, no recorded success and
    // no boundary, which is the first-connect state the detail page reports.
    return;
  }

  const days = plan.window.filter((day) => day !== plan.hole);
  withTransaction(db, () => {
    for (const [index, day] of days.entries()) {
      const backfilled = day < plan.boundary;
      for (const metric of TRAFFIC_METRICS) {
        upsertDayFact(db, {
          repositoryId: id, metric: metric.metric, granularity: 'day', day,
          value: metric.value(index, seed),
          source: backfilled ? 'backfill' : 'collected',
          collectedAt: backfilled ? plan.backfilledAt : plan.recentAt,
        });
      }
      if (!backfilled) {
        // A cumulative level recorded on each collected day, so the divergence
        // reading has days where both metrics were measured.
        upsertDayFact(db, {
          repositoryId: id, metric: STARS_METRIC, granularity: STARS_GRANULARITY, day,
          value: 40 + seed * 10 + index, source: STARS_SOURCE, collectedAt: plan.backfilledAt,
        });
      }
    }
    if (state === 'unavailable') return;
    // Two captures of the referrer list on two different runs, so the page shows
    // two observations of the vendor answering rather than one merged list that
    // never existed.
    appendSnapshot(db, {
      repositoryId: id, runId: 'run-1', kind: 'referrers', label: 'https://news.example/post',
      count: 4 + seed, uniques: 2, position: 0, collectedAt: plan.runOne,
    });
    appendSnapshot(db, {
      repositoryId: id, runId: 'run-2', kind: 'referrers', label: 'https://news.example/post',
      count: 9 + seed, uniques: 5, position: 0, collectedAt: plan.runTwo,
    });
    appendSnapshot(db, {
      repositoryId: id, runId: 'run-2', kind: 'popular_paths', label: '/guide', title: 'Guide',
      count: 11 + seed, uniques: 6, position: 0, collectedAt: plan.runTwo,
    });
  });

  if (state === 'unavailable') {
    upsertRepository(db, {
      id, owner: OWNER, name, lastSeenAt: plan.recentAt, enrolled: 1, lifecycle: 'unavailable',
      unavailableReason: `GitHub answered HTTP 404 for ${OWNER}/${name}: the repository does not exist`,
    });
  }

  stampFirstCollected(db, id, { day: plan.boundary, collectedAt: plan.recentAt });
  appendBackfillRecord(db, {
    repositoryId: id, kind: STARS_METRIC, windowFrom: plan.from, windowTo: plan.boundary,
    truncated: true, collectedAt: plan.backfilledAt,
  });

  if (state === 'stalled') {
    recordSuccess({ db, repositoryId: id, collectedAt: plan.staleAt });
    return;
  }
  recordSuccess({ db, repositoryId: id, collectedAt: plan.recentAt });
  if (state === 'needs-re-authentication') {
    recordFailure({
      db, repositoryId: id, runId: 'run-2', repo: `${OWNER}/${name}`, endpointType: 'traffic',
      error: { status: 403 }, collectedAt: plan.failedAt,
    });
  }
  if (state === 'degraded') {
    recordFailure({
      db, repositoryId: id, runId: 'run-2', repo: `${OWNER}/${name}`, endpointType: 'traffic',
      error: { status: 429 }, collectedAt: plan.failedAt,
    });
  }
}

/**
 * The seeded archive: six repositories covering six of the seven states the health
 * read can report, a hole in the stored range, a backfilled range before the
 * boundary and a collected range after it, and two referrer captures of one list.
 *
 * @param {Database} db
 * @param {ArchivePlan} plan
 * @returns {void}
 */
function seedArchive(db, plan) {
  appendRun(db, { id: 'run-1', startedAt: plan.runOne });
  appendRun(db, { id: 'run-2', startedAt: plan.runTwo });
  seedRepository(db, plan, { id: 1, name: ARCHIVE, seed: 1, state: 'healthy' });
  seedRepository(db, plan, { id: 2, name: FRESH, seed: 2, state: 'never-collected' });
  seedRepository(db, plan, { id: 3, name: FLAKY, seed: 3, state: 'degraded' });
  seedRepository(db, plan, { id: 4, name: LAPSED, seed: 4, state: 'needs-re-authentication' });
  seedRepository(db, plan, { id: 5, name: STALE, seed: 5, state: 'stalled' });
  seedRepository(db, plan, { id: 6, name: RETIRED, seed: 6, state: 'unavailable' });
  completeRun(db, 'run-2', {
    closedAt: plan.recentAt, status: 'degraded', successCount: 5, failureCount: 2,
    requestCount: 28, durationMs: 4200,
  });
}

// ---------------------------------------------------------------------------
// The fixture: a temporary home, a real migrated archive, the real server.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DashboardFixture
 * @property {Database} db The open, migrated archive.
 * @property {string} home The temporary home the product resolved.
 * @property {string} databasePath Where the archive really landed.
 * @property {ArchivePlan} plan The dates this fixture was seeded with.
 * @property {{url: string, close: () => Promise<void>}} server The real loopback server.
 */

/**
 * @typedef {object} SeededHome
 * @property {Database} db The open, migrated archive.
 * @property {string} home The temporary home the product resolved.
 * @property {string} databasePath Where the archive really landed.
 * @property {() => void} close Close the archive once, whether or not the caller did.
 */

/**
 * Open a temporary home holding a migrated archive, resolve the paths through the
 * product's own resolver, and hand back what the fixture needs. Every test gets
 * its own home, so this file is independent of every other suite and of the
 * developer's own archive.
 *
 * The archive is closed by the returned `close`, which is idempotent, because a
 * fixture that serves the archive to a spawned process has to release it first:
 * SQLite will not let two connections write the same file, and the child process
 * is about to open it through the product's own resolver.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} prefix Distinguishes each fixture's temporary directory.
 * @param {ArchivePlan} plan
 * @returns {Promise<SeededHome>}
 */
async function openSeededHome(t, prefix, plan) {
  const root = mkdtempSync(`/tmp/opencode/${prefix}-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  // The product resolves the home itself, so the archive lands exactly where the
  // product would put it: outside every work tree, held at 0700.
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: home } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700, 'the home directory is held at 0700');
  const db = await openArchive(paths.databasePath);
  seedArchive(db, plan);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  t.after(close);
  return { db, home: paths.home, databasePath: paths.databasePath, close };
}

/**
 * Start the real server over a real migrated archive with the product's own view
 * registry mounted the way `serve` mounts it, on an ephemeral loopback port.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<DashboardFixture>}
 */
async function createDashboardFixture(t) {
  const { db, home, databasePath } = await openSeededHome(t, 'repo-signal-dashboard-e2e', FIXED_PLAN);
  assert.ok(db !== null, 'the archive is open while this fixture serves from it');
  const registry = createViewRegistry({ db, clock: () => FIXED_PLAN.nowMs, today: FIXED_PLAN.today });
  const router = createRouter({ views: registry.views, hasRepository: registry.hasRepository });
  // Mounted exactly as `src/commands/serve.js` mounts it: the registry's own pages
  // in front of the router, which owns the three routes and every status it returns.
  const server = await createServer({ handler: registry.answerOwnRoutes(router), logger: () => {} });
  t.after(() => server.close());
  loopbackOrigins.push(`${new URL(server.url).origin}/`);
  return { db, home, databasePath, plan: FIXED_PLAN, server };
}

/**
 * Request one page and read the whole response, so every assertion is about bytes
 * on the wire rather than about a status line.
 *
 * @param {{url: string}} server
 * @param {string} pathname Path and query, relative to the server URL.
 * @returns {Promise<{status: number, headers: Headers, body: string}>}
 */
async function request(server, pathname) {
  const response = await fetch(`${server.url}${pathname}`);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/**
 * @typedef {object} AnsweredPage
 * @property {string} label What the request was for.
 * @property {string} pathname The path and query that was asked for.
 * @property {number} expected The status the acceptance criteria require.
 * @property {{status: number, headers: Headers, body: string}} page What came back.
 */

/**
 * The six requests, in order, each paired with the status the criteria require.
 *
 * @param {DashboardFixture} f
 * @returns {Promise<AnsweredPage[]>}
 */
async function requestEveryPage(f) {
  /** @type {AnsweredPage[]} */
  const answered = [];
  for (const entry of sixRequests(f.plan)) {
    answered.push({
      label: entry.label, pathname: entry.pathname, expected: entry.expected,
      page: await request(f.server, entry.pathname),
    });
  }
  return answered;
}

/**
 * The security header policy, read off the response rather than off the module
 * that wrote it, so a header the server stopped sending fails here.
 *
 * @param {Headers} headers
 * @param {string} label
 * @returns {void}
 */
function assertSecurityHeaders(headers, label) {
  const csp = headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/, `${label}: no source is allowed by default`);
  assert.match(csp, /script-src 'none'/, `${label}: no script is allowed`);
  assert.match(csp, /style-src 'self'/, `${label}: styles come from this origin only`);
  assert.match(csp, /img-src 'self'/, `${label}: an image would come from this origin only`);
  assert.match(csp, /base-uri 'none'/, `${label}: no base override`);
  assert.match(csp, /frame-ancestors 'none'/, `${label}: the page cannot be framed`);
  assert.equal(headers.get('cache-control'), 'no-store', `${label}: the page is never cacheable`);
  assert.equal(headers.get('referrer-policy'), 'no-referrer', `${label}: no referrer leaves the page`);
  assert.equal(headers.get('x-content-type-options'), 'nosniff', `${label}: no content sniffing`);
  assert.equal(headers.get('access-control-allow-origin'), null, `${label}: no cross-origin header is sent`);
  assert.match(headers.get('content-type') ?? '', /^text\/html/, `${label}: the page is served as HTML`);
}

/**
 * The row of a served page's repository table that belongs to one identity, read
 * out of the markup through the escaped attribute the page itself carries.
 *
 * @param {string} body
 * @param {string} repo `owner/name` as the archive holds it.
 * @returns {string} The row's own markup.
 */
function repositoryRow(body, repo) {
  const rows = [...body.matchAll(/<tr data-repository="[^"]*"[^>]*>[\s\S]*?<\/tr>/g)].map((match) => match[0]);
  const row = rows.find((markup) => markup.includes(`data-repository="${escapeText(repo)}"`));
  assert.ok(row !== undefined, `${repo} has a row; the page carried ${JSON.stringify(rows.length)} rows`);
  return row;
}

/**
 * A zero standing on its own: not a digit of a larger number, not part of a date,
 * a time or a thousand-separated count. A substituted zero is exactly this - a
 * bare `0` where the archive holds nothing - so the scan looks for that shape and
 * not for the character.
 */
const ZERO_TOKEN = /(^|[^\d.,:-])0(?!\d)/;

/**
 * Assert that no table cell on a served page states a substituted zero.
 *
 * The scan reads every table cell's *visible text*, so a zero cannot be smuggled
 * past it inside a nested element, inside a longer sentence, or in a table the
 * chart walk never reached. Every table on the page is examined, not only the
 * charted ones: the per-metric readings table is a second place a day can be
 * turned into a number, and on a repository the archive never collected every
 * metric in it is missing, which is where a view is most tempted to print zeros.
 *
 * One exemption is named: a capture's position in the vendor's list is a recorded
 * ordinal that starts at zero, not a measurement. The count of cells the exemption
 * actually matched is returned so the caller can assert that it matched the ordinal
 * it is meant to and nothing broader - an exemption that quietly swallowed every
 * cell would otherwise read as a clean page.
 *
 * @param {string} body The served markup.
 * @param {string} label What the page is, for the failure message.
 * @returns {{cells: number, exempted: number}} How many cells were examined and how
 *   many the ordinal exemption covered.
 */
function assertNoSubstitutedZeros(body, label) {
  const allCells = [...body.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)]
    .map((match) => ({ attributes: match[1], text: visibleText(match[2]) }));
  assert.ok(allCells.length > 0, `${label}: the page carries table cells for this scan to examine`);
  const exempt = /class="[^"]*\bfigure-note\b/;
  const carryingZero = allCells.filter((cell) => ZERO_TOKEN.test(cell.text));
  const zeroCells = carryingZero.filter((cell) => !exempt.test(cell.attributes));
  const exempted = carryingZero.length - zeroCells.length;
  assert.deepEqual(zeroCells.map((cell) => cell.text), [],
    `${label}: no table cell states a zero standing on its own in place of a day nobody measured; `
    + `${zeroCells.length} of ${allCells.length} cells did, and ${exempted} were exempted as ordinals. `
    + `The first was ${JSON.stringify(zeroCells[0] ?? null)}`);
  // The token rule must separate a bare zero from a number that merely contains
  // one, or the scan above would be measuring the fixture's dates rather than a
  // substituted value - a scan that fails for the wrong reason in the other
  // direction. The bare-zero sample is the positive control: if it stopped
  // matching, the exemption above would be hiding everything.
  /** @type {ReadonlyArray<[string, boolean]>} */
  const samples = [
    ['0', true], ['0 stored days', true], ['(0)', true], ['value 0 here', true],
    ['30', false], ['10', false], ['2026-09-19 to 2026-10-02', false], ['12:00:00.000Z', false],
    ['1,040', false], ['summed over 13 stored days of 14 in the range', false],
  ];
  for (const [sample, matches] of samples) {
    assert.equal(ZERO_TOKEN.test(sample), matches,
      `the zero-token rule must ${matches ? '' : 'not '}match ${JSON.stringify(sample)}; the scan above is `
      + (matches ? 'missing a substituted value' : 'measuring dates and long numbers rather than a zero'));
  }
  return { cells: allCells.length, exempted };
}

/**
 * A markup assertion is only worth making if it fails for the right reason, so
 * the walkers this file relies on are proved sensitive before any page is judged
 * with them: a document built to break each rule is reported as broken, and a
 * served page with a second landmark injected into it is reported as carrying two.
 *
 * @param {string} servedDetailBody The served detail page's own markup.
 * @returns {void}
 */
function assertTheWalkersCanFail(servedDetailBody) {
  const broken = auditDocument([
    '<!doctype html><html lang="en"><head><title>Broken</title></head><body>',
    '<main id="main"><h1>Broken</h1><h3>A skipped level</h3>',
    '<table><tbody><tr><td>1</td></tr></tbody></table></main>',
    '<main id="second">A second landmark</main></body></html>',
  ].join(''));
  assert.equal(broken.mainLandmarks, 2, 'the walk counts a second main landmark');
  assert.deepEqual(headingLevelSkips(broken.headings.map((heading) => heading.level)), [{ after: 1, level: 3 }],
    'the walk reports a skipped heading level');
  assert.equal(broken.tables[0]?.caption, '', 'the walk reports a table with no caption');
  assert.equal(broken.tables[0]?.columnHeaders.length, 0, 'the walk reports a table with no header row');

  // The same walk over the served page with a second landmark injected: if this
  // reported one, the landmark assertion below would be measuring nothing.
  const doubled = auditDocument(servedDetailBody.replace('</main>', '</main><main id="injected"></main>'));
  assert.equal(doubled.mainLandmarks, 2,
    'the landmark assertion is sensitive to the served markup it is given');
  assert.equal(auditChartPairing('<figure><figcaption>A chart with no table</figcaption><svg></svg></figure>').paired,
    false, 'a figure with no data table is not a paired chart');
}

// ---------------------------------------------------------------------------
// The six requests.
// ---------------------------------------------------------------------------

test('the six requests over the running server answer 200, 200, 200, 200, 404 and 400, and every response carries the header policy', async (t) => {
  // Arrange: a temporary home holding a migrated archive seeded through the
  // product's own writes, with the product's registry mounted behind the real
  // server factory on a real loopback port.
  const f = await createDashboardFixture(t);

  // Act: the six requests the task names, in order.
  const pages = await requestEveryPage(f);

  // Assert: each answered the status the acceptance criteria require of it.
  assert.deepEqual(pages.map((entry) => entry.expected), EXPECTED_OUTCOMES,
    'the six requests under test are the six outcomes the criteria name, in order');
  for (const { label, expected, page } of pages) {
    assert.equal(page.status, expected,
      `${label}: expected ${expected}; got ${page.status} with body ${JSON.stringify(page.body.slice(0, 300))}`);
    // The headers belong to the server, so a 404 and a 400 carry them as surely as
    // a 200 does.
    assertSecurityHeaders(page.headers, label);
    assert.match(page.body, /^<!doctype html>/, `${label}: a served page is a complete document`);
    assert.match(page.body, /<html lang="en">/, `${label}: a served page declares its language`);
    assert.match(page.body, /<main id="main">/, `${label}: a served page uses the shared document shell`);
  }

  // The server reported a real loopback address on a real ephemeral port, so the
  // suite collided with nothing and could not have been answered by anything else.
  assert.equal(new URL(f.server.url).hostname, '127.0.0.1', 'the dashboard binds the loopback interface only');
  assert.ok(Number(new URL(f.server.url).port) > 0, 'the port is one the operating system chose');

  // The index states the roll-up the health read returned and links onward with
  // the selected range carried in the URL.
  const index = pages[0].page.body;
  assert.match(index, /Collection state/);
  assert.ok(index.includes(hrefOf(`/repos?${FIXED_PLAN.query}`)),
    `the index links onward with the range in the URL; got ${JSON.stringify(index)}`);

  // The list names every enrolled repository, including the one no run has ever
  // touched, and links each to a detail page that keeps the range.
  const list = pages[1].page.body;
  for (const repo of Object.keys(EXPECTED_STATES)) {
    assert.ok(list.includes(escapeText(repo)), `the list names ${repo}; got ${JSON.stringify(list)}`);
  }
  assert.ok(list.includes(hrefOf(`${detailPath(OWNER, ARCHIVE)}?${FIXED_PLAN.query}`)),
    'the list links to the detail page carrying the repository and the range');

  // The detail page is about the repository the URL asked for, over the selected
  // window, and names the boundary the archive recorded.
  const detail = pages[2].page.body;
  assert.ok(detail.includes(`data-repository="${escapeText(`${OWNER}/${ARCHIVE}`)}"`),
    `the detail page names the repository it is about; got ${JSON.stringify(detail.slice(0, 400))}`);
  assert.ok(detail.includes(escapeText(`from ${FIXED_PLAN.from} to ${FIXED_PLAN.to}`)),
    'the detail page states the window it read');

  // The boundary the page states must be the boundary the archive *recorded*, read
  // out of the provenance caption rather than out of the document: the day string
  // also appears in every `data-day` attribute and axis tick on the page, so
  // searching the whole body for it would pass whether or not the boundary was
  // stated. The fixture's boundary is deliberately not the first day of the
  // window, so a read that fell back to the earliest stored row would name a
  // different day here.
  assert.equal(FIXED_PLAN.boundary !== FIXED_PLAN.from, true,
    'the fixture boundary differs from the first window day, so a boundary read from the rows would differ');
  const provenanceCaption = /<p class="provenance-caption"[^>]*>([\s\S]*?)<\/p>/.exec(detail)?.[1];
  assert.ok(provenanceCaption !== undefined, 'the detail page carries a provenance caption stating where history begins');
  assert.ok(visibleText(provenanceCaption).includes(`Collected history begins on ${FIXED_PLAN.boundary}`),
    `the provenance caption names the recorded first collected day ${FIXED_PLAN.boundary}; it read ` +
    `${JSON.stringify(visibleText(provenanceCaption))}`);
  assert.equal(storedValue(f.db, 1, VIEWS_METRIC, FIXED_PLAN.from) !== null, true,
    'the archive really does hold a stored row before the boundary, so the two are distinguishable');
  assert.ok(detail.includes(hrefOf(`${detailPath(OWNER, ARCHIVE)}?${FIXED_PLAN.query}`)),
    'the detail page names its own address, so it is reproducible from its URL');

  // The health page is mounted at its own path and carries a row per repository.
  const health = pages[3].page.body;
  for (const repo of Object.keys(EXPECTED_STATES)) {
    assert.ok(health.includes(`data-repository="${escapeText(repo)}"`), `the health page carries a row for ${repo}`);
  }

  // The 404 names the identity the archive does not hold and the 400 names the
  // inversion, both through the shell every other page uses.
  const unknown = pages[4].page.body;
  const inverted = pages[5].page.body;
  assert.ok(unknown.includes(escapeText(`${OWNER}/${UNKNOWN_NAME}`)),
    `the 404 page names the repository that is not enrolled; got ${JSON.stringify(unknown)}`);
  assert.ok(inverted.includes(escapeText('Inverted range')),
    `the 400 page names the inversion; got ${JSON.stringify(inverted)}`);
  assert.ok(inverted.includes(escapeText(`from ${FIXED_PLAN.to} is later than to ${FIXED_PLAN.from}`)),
    'the 400 page names both bounds of the range it refused');
});

test('the deliberate hole reaches the served detail page as a gap, and no day without a stored row carries a number', async (t) => {
  // Arrange: the same seeded archive, whose hole is a day no run ever recorded.
  const f = await createDashboardFixture(t);

  // Act: request the detail page and walk the chart tables it carries.
  const page = await request(f.server, `${detailPath(OWNER, ARCHIVE)}?${FIXED_PLAN.query}`);
  assert.equal(page.status, 200, `the detail page must be served; body was ${JSON.stringify(page.body.slice(0, 300))}`);
  const audit = auditDocument(page.body);

  // Assert: the hole is a real absence in the archive, so the gap on the page is
  // the archive's state and not the view's invention.
  assert.equal(count(f.db, 'day_series', `WHERE day='${FIXED_PLAN.hole}'`), 0,
    `the fixture stored no row for ${FIXED_PLAN.hole} on any metric, so the gap is the archive's state`);
  assert.equal(count(f.db, 'day_series', `WHERE repository_id=1 AND metric='${VIEWS_METRIC}'`),
    WINDOW_DAYS - 1, 'the collected repository stored every window day but the hole');

  // Every charted metric's table has one row per calendar day, the hole's row says
  // so in words rather than carrying a number, and every other row is the value
  // the archive itself holds - read back from the database, not from the page.
  assert.ok(audit.figures.length > 0, 'the detail page carries the charted metrics as figures');
  for (const figure of audit.figures) {
    const metric = /^chart-(.+)-figure$/.exec(figure.id)?.[1] ?? '';
    const table = /** @type {TableSummary} */ (figure.tables[0]);
    assert.ok(table !== undefined, `${figure.id}: the figure carries a data table beside it`);
    assert.deepEqual(table.rows.map((row) => row.label), FIXED_PLAN.window,
      `${figure.id}: the table has one row per calendar day, so a gap is a named day and not an omission`);
    const holeRow = table.rows.find((row) => row.label === FIXED_PLAN.hole);
    assert.ok(holeRow !== undefined, `${figure.id}: the table has a row for ${FIXED_PLAN.hole}`);
    assert.equal(holeRow.cells[0], GAP_CELL_TEXT,
      `${figure.id}: the hole's row says so in words; it carried ${JSON.stringify(holeRow.cells)}`);
    for (const row of table.rows) {
      if (row.label === FIXED_PLAN.hole) continue;
      const stored = storedValue(f.db, 1, metric, row.label);
      assert.equal(row.cells[0], stored === null ? GAP_CELL_TEXT : String(stored),
        `${figure.id}: the value for ${row.label} is the archive's own; the archive holds ${JSON.stringify(stored)}`);
    }
    // The picture states the gap in words, so a reader reaching the chart hears the
    // missing day rather than seeing a line that quietly bridges it.
    assert.ok(figure.caption.includes(FIXED_PLAN.hole),
      `${figure.id}: the figure's caption names ${FIXED_PLAN.hole}; got ${JSON.stringify(figure.caption)}`);
  }

  // Every charted metric's table plots no day as zero, which is the claim that
  // matters: the fixture stores no zero for any day, so a zero in a chart table
  // could only have come from a substitution.
  for (const figure of audit.figures) {
    const rows = /** @type {TableSummary} */ (figure.tables[0]).rows;
    assert.equal(rows.filter((row) => row.cells[0] === '0').length, 0,
      `${figure.id}: no chart table plots a day as zero`);
    assert.equal(rows.filter((row) => row.cells[0] === GAP_CELL_TEXT).length, 1,
      `${figure.id}: exactly the hole is a gap row, so a day nobody measured is the only one named as a gap`);
  }
  // The page-wide scan over every table cell, not only the chart tables. This page
  // carries both a chart and the captures, so it is where the two legitimate zeros
  // are proved to exist: the axis label naming the scale's origin, and a capture's
  // recorded position in the vendor's list. Without them the scan above would be a
  // claim that had never been shown to be able to pass for the right reason.
  const scan = assertNoSubstitutedZeros(page.body, `${OWNER}/${ARCHIVE} over the window`);
  assert.equal(AXIS_ZERO.test(page.body), true,
    'the chart labels its value axis at zero, so the scan is not vacuously empty of real zeros');
  AXIS_ZERO.lastIndex = 0;
  assert.ok(scan.exempted > 0,
    `the ordinal exemption covered the capture positions the fixture records; it covered ${scan.exempted} of `
    + `${scan.cells} cells`);
  const readings = audit.tables.find((table) => table.caption.startsWith('Current absolute numbers'));
  assert.ok(readings !== undefined, 'the current-numbers table is on the page');
  const storedRows = /** @type {TableSummary} */ (readings).rows
    .filter((row) => row.cells.some((cell) => /stored days? of the \d+ in the range/.test(cell)));
  assert.ok(storedRows.length > 0,
    `the readings table states stored-day counts; the rows were ${JSON.stringify(readings.rows.map((r) => r.cells))}`);

  // The current-numbers table states how many stored days each total is over, and
  // that count is the number of days the archive holds, never the number of days
  // the range covers.
  const storedDayCounts = [...page.body.matchAll(/summed over (\d+) stored days? of the (\d+) in the range/g)]
    .map((match) => ({ stored: Number(match[1]), range: Number(match[2]) }));
  assert.ok(storedDayCounts.length > 0, 'the page states how many stored days each total is over');
  for (const { stored, range } of storedDayCounts) {
    assert.equal(range, WINDOW_DAYS, `the range covers all ${WINDOW_DAYS} days`);
    assert.equal(stored, WINDOW_DAYS - 1,
      `a summed total is over the ${WINDOW_DAYS - 1} stored days, not the ${WINDOW_DAYS} in the range, ` +
      'so the hole contributed no value to the total');
  }
  // The change list walks stored days only, so it carries no entry dated the hole.
  assert.equal(page.body.includes(`data-day="${FIXED_PLAN.hole}"`), false,
    `no section dated ${FIXED_PLAN.hole} claims a measurement for it`);

  // The current-numbers section names the same gap beside its stored-day counts,
  // and the panels that need two complete windows report insufficient data rather
  // than a difference computed over a day nobody measured.
  assert.ok(page.body.includes(escapeText(FIXED_PLAN.hole)), 'the coverage line names the hole');
  assert.match(page.body, /unmeasured, not zero/, 'the page says the day is unmeasured rather than zero');
  assert.match(page.body, /data-status="insufficient"/,
    'the comparison panels report insufficient data over a window with a hole');
});

test('the served markup satisfies the landmark, heading-order and table-alternative assertions', async (t) => {
  // Arrange: every page the dashboard serves, fetched over the running server.
  const f = await createDashboardFixture(t);
  const pages = await requestEveryPage(f);

  // Act and assert: each served page holds exactly one main landmark the skip link
  // targets, an unbroken heading sequence, and - wherever it carries a table - a
  // caption, a header row and a row header on the body rows.
  for (const { label, page } of pages) {
    const audit = auditDocument(page.body);

    assert.equal(audit.mainLandmarks, 1, `${label}: exactly one main landmark`);
    assert.ok(audit.ids.includes('main'), `${label}: the main landmark carries the id the skip link targets`);
    assert.ok(page.body.includes(skipLink()), `${label}: the shell's skip link is present`);
    assert.equal(audit.focusable[0]?.attributes.href, '#main',
      `${label}: the skip link is the first stop a keyboard makes`);

    const levels = audit.headings.map((heading) => heading.level);
    assert.equal(levels[0], 1, `${label}: the first heading is the page heading`);
    assert.deepEqual(headingLevelSkips(levels), [], `${label}: the heading sequence skips no level`);

    for (const table of audit.tables) {
      const where = `${label}: the table ${table.id === '' ? 'a page carries' : table.id} carries no caption`;
      assert.ok(table.caption.length > 0, where);
      assert.ok(table.columnHeaders.length > 0, `${label}: the table ${table.id} carries a header row`);
      for (const row of table.rows) {
        assert.ok(row.label.length > 0,
          `${label}: a body row of ${table.id} carries no row header; it read ${JSON.stringify(row.cells)}`);
      }
    }
  }

  // The detail page is walked section by section, so a section that gained or lost
  // a heading changes the walk rather than passing as a shorter page.
  const detailBody = pages[2].page.body;
  const detail = auditDocument(detailBody);
  const sectionKeys = [...detailBody.matchAll(/data-section="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(sectionKeys.length >= 9, `the detail page carries its labelled sections; got ${JSON.stringify(sectionKeys)}`);
  assert.equal(detail.headings.filter((heading) => heading.level === 2).length, sectionKeys.length,
    'the detail page carries one heading per labelled section');
  assert.ok(detail.headings.some((heading) => heading.level === 3),
    'the chart headings sit inside their section rather than beside it');

  // The table alternative: every figure on the served detail page pairs with a
  // data table holding the same values as text, checked against the served markup
  // rather than against a rendered string in isolation.
  const figures = sliceElements(detailBody, 'figure');
  assert.ok(figures.length > 0, 'the served detail page carries a figure to pair');
  assert.equal(figures.length, detail.figures.length, 'every figure on the page was walked');
  for (const figure of figures) {
    const id = /\bid="([^"]*)"/.exec(figure.markup)?.[1] ?? '';
    const pairing = auditChartPairing(figure.markup);
    assert.equal(pairing.paired, true,
      `${id}: the chart pairs with its data table; ${JSON.stringify(pairing.reasons)}`);
  }

  // The assertions above are only worth reading if they can fail, so the walkers
  // are proved sensitive against documents built to break them.
  assertTheWalkersCanFail(detailBody);
});

test('every page states its recorded state in words and adds no script, handler, remote asset or verdict', async (t) => {
  // Arrange: the seeded archive, whose six repositories cover six recorded states.
  const f = await createDashboardFixture(t);
  const pages = await requestEveryPage(f);
  const healthBody = pages[3].page.body;
  const listBody = pages[1].page.body;

  // Act: read each repository's state from the archive's own health read.
  const read = collectionHealth({ db: f.db, clock: () => FIXED_PLAN.nowMs });
  const served = read.repositories.map((entry) => [entry.repo, entry.state]);
  assert.deepEqual([...new Set(served.map(([, state]) => state))].sort(),
    ['degraded', 'healthy', 'needs-re-authentication', 'never-collected', 'stalled', 'unavailable'],
    'the fixture really holds six distinct recorded states, so each row asserts something different');

  // Assert: the served health page carries each repository's own state word, as
  // text beside the sentence the read wrote for it - readable with every class
  // attribute removed, which is why the word is looked for in the visible text.
  for (const [repo, state] of served) {
    assert.equal(state, EXPECTED_STATES[repo], `the archive records ${repo} as ${EXPECTED_STATES[repo]}`);
    const row = repositoryRow(healthBody, repo);
    assert.ok(row.includes(`data-state="${state}"`),
      `the health page reports ${repo} as ${state}; the row was ${JSON.stringify(row.slice(0, 300))}`);
    assert.ok(row.includes(`<span class="state-word">${state}</span>`),
      `${repo}: the state word is present as text, so a page with no styling still says what state it is in`);
    // The read's own phrase for the state is what a reader is shown, so the check
    // uses the read's own transformation rather than assuming one: `statePhrase`
    // keeps the hyphen inside `re-authentication` while splitting the separators
    // between words, which a blanket replacement of every hyphen would not.
    assert.ok(visibleText(row).includes(statePhrase(state)),
      `${repo}: the row's own sentence names the state in words as "${statePhrase(state)}"; the row read ` +
      `${JSON.stringify(visibleText(row).slice(0, 200))}`);
    // The same word appears on the list page for the same repository, so two
    // surfaces reading one archive cannot disagree about a repository's state.
    assert.ok(repositoryRow(listBody, repo).includes(`data-state="${state}"`),
      `the list page reports ${repo} as ${state}`);
  }

  // The never-collected repository reads as not yet connected rather than as
  // broken, and carries no failure action: nothing has failed.
  const freshRow = repositoryRow(healthBody, `${OWNER}/${FRESH}`);
  assert.ok(freshRow.includes('Not yet connected'), `${OWNER}/${FRESH} reads as not yet connected`);
  assert.equal(freshRow.includes('data-action="re-authenticate"'), false,
    `${OWNER}/${FRESH} carries no failure action, because nothing failed`);
  // The refused-token row names the permission in its action and links to the
  // guidance the page itself carries.
  const lapsedRow = repositoryRow(healthBody, `${OWNER}/${LAPSED}`);
  assert.ok(lapsedRow.includes('Administration repository permission (read)'),
    `${OWNER}/${LAPSED} names the permission its action needs`);
  assert.ok(lapsedRow.includes('href="#reauthenticate"'), `${OWNER}/${LAPSED} links to the on-page guidance`);
  assert.ok(auditDocument(healthBody).ids.includes('reauthenticate'),
    'the anchor the action links to is an element of the page');
  // The stalled row names the last successful collection, because that instant is
  // the evidence for the warning.
  const staleRow = repositoryRow(healthBody, `${OWNER}/${STALE}`);
  assert.ok(staleRow.includes(FIXED_PLAN.staleAt),
    `${OWNER}/${STALE} names the recorded last successful collection it is warning about`);

  // A repository no run has ever collected renders a first-connect state rather
  // than an axes-only chart, and reports no number for a metric it never stored.
  const freshDetail = await request(f.server, `${detailPath(OWNER, FRESH)}?${FIXED_PLAN.query}`);
  assert.equal(freshDetail.status, 200, `${OWNER}/${FRESH}: the page is served, not refused`);
  const freshAudit = auditDocument(freshDetail.body);
  assert.equal(freshAudit.figures.length, 0,
    `${OWNER}/${FRESH}: no chart is drawn for a repository with no collected day`);
  assert.equal(/<svg\b/.test(freshDetail.body), false,
    `${OWNER}/${FRESH}: no axes-only chart is drawn where there is no data`);
  assert.match(freshDetail.body, /data-state="first-connect"/,
    `${OWNER}/${FRESH}: the page reports the first-connect state`);
  assert.ok(freshDetail.body.includes('Administration repository permission (read)'),
    `${OWNER}/${FRESH}: the first-connect wording names the permission a run needs`);
  assert.ok(freshDetail.body.includes(escapeText(NO_STORED_VALUE_TEXT)),
    `${OWNER}/${FRESH}: an unstored metric is named in words rather than shown as a number`);
  // This is the page where every metric is missing, so it is where a view is most
  // tempted to print a zero for each of them. The same scan the populated page is
  // held to runs here, and the readings table is asserted to be the one carrying
  // those missing readings, so the scan is looking at the cells in question rather
  // than at an empty corner of the page.
  const freshReadings = freshAudit.tables.find((table) => table.caption.startsWith('Current absolute numbers'));
  assert.ok(freshReadings !== undefined, `${OWNER}/${FRESH}: the readings table is on the page`);
  // `cells` already holds visible text, which is why the absence is looked for in
  // it directly rather than in the markup.
  const missingRows = /** @type {TableSummary} */ (freshReadings).rows
    .filter((row) => row.cells.some((cell) => cell.includes(NO_STORED_VALUE_TEXT)));
  assert.ok(missingRows.length >= 4,
    `${OWNER}/${FRESH}: the readings table names every unstored metric; it had ${missingRows.length} such rows`);
  assertNoSubstitutedZeros(freshDetail.body, `${OWNER}/${FRESH} detail page, which has no stored day at all`);

  // RS-UI-CON-01 and RS-SC-01: no script, no inline handler, no remote asset, no
  // motion, no colour literal, and no verdict the archive does not support. Every
  // addressable reference is a relative same-origin path, so no page introduces a
  // request to any host.
  for (const { label, page } of pages) {
    assertSecurityHeaders(page.headers, label);
    assert.equal(/<script\b/i.test(page.body), false, `${label}: no page carries a script element`);
    assert.equal(/<[^>]+\son[a-z]+\s*=/i.test(page.body), false, `${label}: no inline event handler`);
    assert.equal(/<iframe|<embed|<object|<form\b/i.test(page.body), false, `${label}: no nested or submitted document`);
    assert.equal(/@font-face|@import|url\(/i.test(page.body), false, `${label}: no remote font or fetched asset`);
    assert.equal(/\stransition=|style="/i.test(page.body), false, `${label}: no inline style and no animated transition`);
    // Entity references are stripped before the colour search, so an escaped
    // character cannot be mistaken for a hex colour.
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(page.body.replaceAll(/&#[0-9a-z]+;/g, ' ')), false,
      `${label}: no colour literal in the markup; the stylesheet is the only place one is declared`);
    const references = [...page.body.matchAll(/\b(?:href|src|srcset)\s*=\s*"([^"]*)"/g)].map((match) => match[1]);
    assert.ok(references.length > 0, `${label}: the page references its stylesheet`);
    for (const reference of references) {
      assert.match(reference, /^(#|\/(?!\/))/,
        `${label}: every reference is a relative same-origin path or a fragment; got ${JSON.stringify(reference)}`);
    }
    // A stored referrer label is a URL in the archive, so the words appear in the
    // text; what must not appear is a verdict no measurement supports.
    const words = visibleText(page.body).toLowerCase();
    for (const word of VERDICT_WORDS) {
      assert.equal(words.includes(word), false, `${label}: the page says "${word}", which the archive does not support`);
    }
  }
});

test('serving the six pages wrote nothing, and the archive they read is the archive the fixture seeded', async (t) => {
  // Arrange: the seeded archive, counted before anything is served.
  const f = await createDashboardFixture(t);
  const before = archiveCounts(f.db);

  // Act: serve every page the dashboard serves, twice, to catch a page that writes.
  await requestEveryPage(f);
  const pages = await requestEveryPage(f);

  // Assert: the archive was migrated by the product, not hand-built.
  const versions = /** @type {{version: number}[]} */ (/** @type {unknown} */ (
    f.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()))
    .map((row) => ({ version: Number(row.version) }));
  assert.deepEqual(versions, [{ version: 1 }, { version: 2 }],
    'the archive was migrated by the product, not hand-built');

  // The rows the fixture wrote are the rows the archive holds: a hole stored as an
  // absence, a backfilled range before the boundary and a collected range after
  // it, and two captures of one referrer list on two runs.
  assert.equal(count(f.db, 'repositories'), 6, 'the six fixture repositories are enrolled');
  assert.equal(count(f.db, 'day_series', `WHERE repository_id=1 AND day='${FIXED_PLAN.hole}'`), 0,
    'the hole is stored as an absence, not as a row');
  // The two ranges are stored apart, and the counts are per metric rather than
  // across the table: the cumulative star level is stored by the backfill on the
  // collected days too, because stars come from the backfill and not from a
  // traffic collection. Conflating the two would hide that, so each is counted
  // under its own metric.
  const trafficKeys = TRAFFIC_METRICS.map((metric) => `'${metric.metric}'`).join(',');
  const beforeBoundary = FIXED_PLAN.window.filter((day) => day < FIXED_PLAN.boundary).length;
  const onOrAfter = FIXED_PLAN.window.filter((day) => day >= FIXED_PLAN.boundary && day !== FIXED_PLAN.hole).length;
  assert.equal(count(f.db, 'day_series',
    `WHERE repository_id=1 AND metric IN (${trafficKeys}) AND source='backfill'`),
  beforeBoundary * TRAFFIC_METRICS.length,
  'the traffic range before the recorded boundary is stored as backfilled');
  assert.equal(count(f.db, 'day_series',
    `WHERE repository_id=1 AND metric IN (${trafficKeys}) AND source='collected'`),
  onOrAfter * TRAFFIC_METRICS.length,
  'the traffic range after the boundary is stored as collected');
  assert.equal(count(f.db, 'day_series', `WHERE repository_id=1 AND metric='${STARS_METRIC}'`),
    onOrAfter, 'the cumulative level is stored once per collected day, and never for the hole');
  assert.equal(count(f.db, 'day_series', `WHERE repository_id=1 AND source='collected' AND metric='${STARS_METRIC}'`),
    0, 'the cumulative level is never recorded as collected, because a traffic run does not measure it');
  assert.equal(count(f.db, 'snapshots', "WHERE repository_id=1 AND kind='referrers'"), 2,
    'two captures of one list on two runs are two observations, and are stored as two');
  assert.equal(count(f.db, 'backfill_records', "WHERE repository_id=1 AND kind='first-collected'"), 1,
    'the boundary is stamped once');

  // Serving twelve pages wrote nothing: the archive a page reads is read-only, so
  // a page cannot change the evidence it shows.
  assert.deepEqual(archiveCounts(f.db), before, 'serving the pages must not write to the archive');

  // Two renders of one archive are byte-identical, so a page carries no per-render
  // randomness and no clock the archive does not hold.
  for (const { label, pathname, page } of pages) {
    const again = await request(f.server, pathname);
    assert.equal(again.body, page.body, `${label}: two requests over one archive render identical bytes`);
  }
});

test('this suite reaches no host, needs no token, and the guard that proves it is live', async (t) => {
  // Arrange: a running server this file started, so the guard has a loopback
  // origin to allow and every other host to refuse.
  const f = await createDashboardFixture(t);
  await request(f.server, `/?${FIXED_PLAN.query}`);
  await request(f.server, `${detailPath(OWNER, ARCHIVE)}?${FIXED_PLAN.query}`);
  await request(f.server, '/health');

  // Act: attempt a request to the one host this product may talk to in production,
  // and to a host it may never talk to.
  await assert.rejects(() => fetch('https://api.github.com/'), /this suite must not reach any host/,
    'the guard refuses api.github.com before a socket for it opens');
  await assert.rejects(() => fetch('https://example.org/'), /this suite must not reach any host/);

  // Assert: every URL asked for was recorded, the two outside ones were refused,
  // and nothing that was allowed left the loopback interface.
  const served = attemptedUrls.filter((url) => !refusedUrls.includes(url));
  assert.ok(served.length >= 3, `the guard saw this file's own requests; got ${JSON.stringify(served)}`);
  assert.deepEqual(refusedUrls, ['https://api.github.com/', 'https://example.org/'], 'exactly the two probes were refused');
  for (const url of served) {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//, `no request left the loopback server; got ${url}`);
    assert.ok(loopbackOrigins.some((origin) => url.startsWith(origin)),
      `every allowed request went to a server this file started; got ${url}`);
  }
  for (const origin of loopbackOrigins) assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(served.some((url) => url.startsWith(`${f.server.url}/`)),
    'this test\'s own server really did answer, so the guard was not idle');

  // Assert: no token. The home the product resolved holds an archive and nothing
  // else, so nothing these pages showed could have come from a credential.
  const entries = readdirSync(f.home);
  assert.deepEqual(entries.filter((name) => !name.startsWith('archive.sqlite3')), [],
    `the temporary home holds only the archive; it holds ${JSON.stringify(entries)}`);
  assert.equal(entries.some((name) => /credential|config/i.test(name)), false,
    'the home holds no credential file and no configuration');
  // The suite runs without the local-transport override, so the allowlist the
  // product enforces was never relaxed for these tests.
  assert.equal(process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT, undefined,
    'the suite runs with no local-transport override set');
});

test('the process entry point serves the same six pages over loopback, with no token and no outbound request', async (t) => {
  // Arrange: a second temporary home, seeded against the wall clock, because this
  // fixture is served by a real `node src/cli.js serve` rather than by a handler
  // this file composed.
  const plan = planArchive(new Date().toISOString().slice(0, 10), Date.now());
  const { close, home, databasePath } = await openSeededHome(t, 'repo-signal-dashboard-serve', plan);
  // The child opens this archive itself, so this process releases it first.
  close();

  // Act: spawn the real command with no credential in the home, no configuration
  // and no transport override, and wait for it to print the whole banner it
  // announces itself with - not merely its first line, because a pipe delivers
  // the lines in arbitrary chunks and asserting on a line that has not arrived
  // yet measures the scheduler rather than the command.
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], {
    cwd: ROOT,
    env: {
      ...process.env,
      REPO_SIGNAL_HOME: home,
      REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: undefined,
      REPO_SIGNAL_GITHUB_BASE_URL: undefined,
      NODE_OPTIONS: '',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

  const listening = await waitForServeBanner(child, () => stdout, (line) => line.includes(databasePath));
  loopbackOrigins.push(`${new URL(listening).origin}/`);

  // Assert: the URL it printed is the one it is listening on, and the routes it
  // named are all reachable - the collection health page and the stylesheet are
  // served by the registry's own mount, not by the router.
  assert.match(listening, /^http:\/\/127\.0\.0\.1:\d+$/, `serve printed a loopback URL; got ${listening}`);
  assert.ok(stdout.includes(`repository list: ${listening}/repos`), 'serve named the list route');
  assert.ok(stdout.includes(`collection health: ${listening}/health`), 'serve named the health route');
  assert.ok(stdout.includes(`stylesheet: ${listening}/assets/theme.css`), 'serve named the stylesheet route');
  assert.ok(stdout.includes(`archive: ${databasePath}`), 'serve named the archive it opened');

  // The six requests, over the spawned process's own port and its own window.
  /** @type {number[]} */
  const outcomes = [];
  for (const entry of sixRequests(plan)) {
    const page = await request({ url: listening }, entry.pathname);
    outcomes.push(page.status);
    assert.equal(page.status, entry.expected,
      `${entry.label}: expected ${entry.expected}; got ${page.status} with body ` +
      `${JSON.stringify(page.body.slice(0, 300))}`);
    assertSecurityHeaders(page.headers, `spawned serve: ${entry.label}`);
    assert.match(page.body, /<main id="main">/, `${entry.label}: the entry point serves the shared document shell`);
  }
  assert.deepEqual(outcomes, EXPECTED_OUTCOMES,
    'the entry point answers the same six outcomes as the handler this file mounted');

  // The stylesheet the pages link resolves, so no page references a file the
  // dashboard would refuse to serve.
  const stylesheet = await request({ url: listening }, '/assets/theme.css');
  assert.equal(stylesheet.status, 200, 'the stylesheet route serves the token file');
  assert.match(stylesheet.headers.get('content-type') ?? '', /^text\/css/);
  assert.ok(stylesheet.body.includes(':root'), 'the served stylesheet carries its token block');

  // The served detail page names the hole as a gap, through the entry point too.
  const detail = await request({ url: listening }, `${detailPath(OWNER, ARCHIVE)}?${plan.query}`);
  assert.ok(detail.body.includes(escapeText(plan.hole)),
    `the entry point's detail page names the hole ${plan.hole}; got ${JSON.stringify(detail.body.slice(0, 300))}`);
  assert.ok(detail.body.includes(GAP_CELL_TEXT), 'the gap row travels through the entry point unchanged');
  // The health page reached through the entry point carries every recorded state,
  // which is the page the registry mounts rather than a route the router owns.
  const health = await request({ url: listening }, '/health');
  for (const [repo, state] of Object.entries(EXPECTED_STATES)) {
    assert.ok(health.body.includes(`data-repository="${escapeText(repo)}" data-state="${state}"`),
      `the entry point's health page reports ${repo} as ${state}`);
  }

  // Act and assert: a signal ends the command with exit 0, and nothing it printed
  // carries credential material.
  child.kill('SIGTERM');
  const status = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(status, 0, `serve exits 0 on a signal; stderr was ${JSON.stringify(stderr)}`);
  assert.equal(stderr, '', `serve wrote nothing to stderr; got ${JSON.stringify(stderr)}`);
  assert.doesNotMatch(stdout, /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/, 'no printed line carries a token-shaped value');
});

/**
 * The last line `serve` prints once it has announced itself. It is the end of the
 * banner, so a reader that has seen it has seen every line before it.
 */
const SERVE_BANNER_END = 'stop with Ctrl-C';

/**
 * Resolve once a child `serve` process has printed the whole banner it announces
 * itself with, and hand back the URL it reported listening on.
 *
 * Waiting for the banner rather than for the first line is what makes the
 * assertions about the printed lines a statement about the command: stdout
 * arrives in chunks, so a reader that stopped at the first line would assert on
 * whatever else happened to have been delivered by then and fail a run out of
 * every few, with a message that named the product rather than the race.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => string} output Its accumulated stdout.
 * @param {(line: string) => boolean} reached The line that ends the banner this
 *   caller is waiting for - the archive it opened, which is the one line only
 *   this fixture's own home can produce.
 * @returns {Promise<string>} The URL it reported.
 */
async function waitForServeBanner(child, output, reached) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const lines = output().split('\n');
    const found = /serve listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output());
    // The banner is only complete once its end and the line this caller is waiting
    // for have both arrived, so an assertion below can never race the pipe.
    const ended = lines.some((line) => line.includes(SERVE_BANNER_END));
    if (found !== null && ended && lines.some(reached)) {
      return /** @type {string} */ (found[1]);
    }
    if (child.exitCode !== null) {
      throw new Error(`serve exited with ${child.exitCode} before printing its banner; stdout was ${JSON.stringify(output())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`serve never finished printing the banner it announces itself with; stdout was ${JSON.stringify(output())}`);
}
