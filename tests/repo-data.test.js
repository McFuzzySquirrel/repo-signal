import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { readProvenance, stampFirstCollected } from '../src/backfill/provenance.js';
import { upsertDayFact } from '../src/db/day-series-repo.js';
import { appendRun, openArchive, upsertAlias, upsertRepository } from '../src/db/ops-repo.js';
import { appendSnapshot } from '../src/db/snapshot-repo.js';
import { GitHubRequestError } from '../src/github/retry.js';
import { resolveHomePaths } from '../src/paths.js';
import {
  PAGE_METRICS, PAGE_STATUS_KNOWN, PAGE_STATUS_UNKNOWN, findRepository, readRepositoryPage,
} from '../src/server/repo-data.js';
import { repositoryHealth } from '../src/supervision/health.js';
import { recordFailure, recordSuccess } from '../src/supervision/repo-state-reporter.js';

/**
 * The page data layer is exercised against a real archive built through the
 * product's own writes: day facts through the day-series upsert, snapshot
 * entries through the append, the collection state through the supervision
 * recorder, and the collection boundary through the provenance stamp. Every
 * instant below is the instant a real writer recorded it, and the deliberate
 * hole at 2026-09-22 is the case the whole read exists for.
 */

/** A range of four days in which no traffic run recorded 2026-09-22. */
const FROM = '2026-09-20';
const TO = '2026-09-23';
/** The day the archive holds no traffic for, and where the test must see a gap. */
const HOLE = '2026-09-22';
const FIRST_STORED_DAY = '2026-09-21';

const RUN_ONE = '2026-09-20T06:00:00.000Z';
const RUN_TWO = '2026-09-24T06:00:00.000Z';
const BACKFILLED_AT = '2026-09-19T06:00:00.000Z';
const COLLECTED_AT = '2026-09-24T06:00:05.000Z';
const FAILED_AT = '2026-09-24T06:30:00.000Z';
/** The instant the page's health read is taken: an hour after the last success. */
const READ_AT_MS = Date.parse('2026-09-24T07:00:00.000Z');

const OWNER = 'maintainer';
const NAME = 'archive';

const moduleSource = readFileSync(new URL('../src/server/repo-data.js', import.meta.url), 'utf8');

/**
 * @type {typeof globalThis.fetch|null}
 */
let realFetch = null;
/** @type {string[]} */
const attemptedUrls = [];

refuseNetwork();
after(() => {
  if (realFetch !== null) globalThis.fetch = realFetch;
});

/** No test in this file may reach a host, so a fetch that is attempted fails loudly. */
function refuseNetwork() {
  realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (
    /** @param {string|URL|Request} url */
    (url) => {
      attemptedUrls.push(String(url));
      throw new Error(`this test must not reach the network: ${String(url)}`);
    });
}

/**
 * A temporary home holding a migrated archive with the repository under test, a
 * second repository that must never bleed into the first one's page, two runs,
 * two referrer captures, one popular-path capture, a recorded success, a recorded
 * rate-limit failure and a stamped collection boundary.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<import('node:sqlite').DatabaseSync>}
 */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-page-data-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700, 'the home directory is held at 0700');
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());

  upsertRepository(db, { id: 1, owner: OWNER, name: NAME, lastSeenAt: RUN_ONE, enrolled: 1 });
  upsertRepository(db, { id: 2, owner: OWNER, name: 'other', lastSeenAt: RUN_ONE, enrolled: 1 });
  appendRun(db, { id: 'run-1', startedAt: RUN_ONE });
  appendRun(db, { id: 'run-2', startedAt: RUN_TWO });

  // Traffic with a hole: views skips 2026-09-22 while clones stores that day, so a
  // reader that carried one metric into the other would be visible here.
  for (const [day, value] of /** @type {Array<[string, number]>} */ ([[FROM, 30], [FIRST_STORED_DAY, 41], [TO, 52]])) {
    upsertDayFact(db, { repositoryId: 1, metric: 'views', granularity: 'day', day, value,
      source: 'collected', collectedAt: COLLECTED_AT });
  }
  for (const [day, value] of /** @type {Array<[string, number]>} */ ([[FROM, 3], [FIRST_STORED_DAY, 4], [TO, 5]])) {
    upsertDayFact(db, { repositoryId: 1, metric: 'unique-visitors', granularity: 'day', day, value,
      source: 'collected', collectedAt: COLLECTED_AT });
  }
  for (const [day, value] of /** @type {Array<[string, number]>} */ ([[FROM, 2], [HOLE, 5]])) {
    upsertDayFact(db, { repositoryId: 1, metric: 'clones', granularity: 'day', day, value,
      source: 'collected', collectedAt: COLLECTED_AT });
  }
  upsertDayFact(db, { repositoryId: 1, metric: 'unique-cloners', granularity: 'day',
    day: FIRST_STORED_DAY, value: 1, source: 'collected', collectedAt: COLLECTED_AT });

  // Backfilled history: a star row from 2019 that must never become the boundary,
  // and the weekly development metrics stored at the week start.
  upsertDayFact(db, { repositoryId: 1, metric: 'stars', granularity: 'day', day: '2019-04-01',
    value: 12, source: 'backfill', collectedAt: BACKFILLED_AT });
  upsertDayFact(db, { repositoryId: 1, metric: 'stars', granularity: 'day', day: HOLE,
    value: 40, source: 'backfill', collectedAt: BACKFILLED_AT });
  upsertDayFact(db, { repositoryId: 1, metric: 'commit-activity', granularity: 'week',
    day: FIRST_STORED_DAY, value: 7, source: 'backfill', collectedAt: BACKFILLED_AT });
  upsertDayFact(db, { repositoryId: 1, metric: 'owner-participation', granularity: 'week',
    day: FIRST_STORED_DAY, value: 3, source: 'backfill', collectedAt: BACKFILLED_AT });

  // A second repository's stored day on a day the first repository also has one.
  upsertDayFact(db, { repositoryId: 2, metric: 'views', granularity: 'day', day: FIRST_STORED_DAY,
    value: 999, source: 'collected', collectedAt: COLLECTED_AT });

  // Two captures of the referrer list, the second repeating a label from the first,
  // and one capture of the popular-path list.
  appendSnapshot(db, { repositoryId: 1, runId: 'run-1', kind: 'referrers',
    label: 'https://example.org/blog', count: 4, uniques: 2, position: 0, collectedAt: RUN_ONE });
  appendSnapshot(db, { repositoryId: 1, runId: 'run-1', kind: 'referrers',
    label: 'https://news.example/post', count: 2, uniques: 2, position: 1, collectedAt: RUN_ONE });
  appendSnapshot(db, { repositoryId: 1, runId: 'run-2', kind: 'referrers',
    label: 'https://example.org/blog', count: 9, uniques: 4, position: 0, collectedAt: RUN_TWO });
  appendSnapshot(db, { repositoryId: 1, runId: 'run-2', kind: 'referrers',
    label: 'https://example.org/other', count: 1, uniques: 1, position: 1, collectedAt: RUN_TWO });
  appendSnapshot(db, { repositoryId: 1, runId: 'run-2', kind: 'popular_paths',
    label: '/guide', title: 'Guide', count: 11, uniques: 6, position: 0, collectedAt: RUN_TWO });
  appendSnapshot(db, { repositoryId: 1, runId: 'run-2', kind: 'popular_paths',
    label: '/api/v1', count: 7, uniques: 5, position: 1, collectedAt: RUN_TWO });

  // Recorded collection state: one success, then one rate-limited attempt that
  // leaves the repository degraded rather than stalled.
  recordSuccess({ db, repositoryId: 1, collectedAt: COLLECTED_AT });
  recordFailure({
    db, repositoryId: 1, runId: 'run-2', endpointType: 'traffic',
    error: new GitHubRequestError('rate-limited', 429, `/repos/${OWNER}/${NAME}/traffic/clones`,
      'Wait for GitHub to reset the rate limit for this token', 1),
    collectedAt: FAILED_AT, repo: `${OWNER}/${NAME}`,
  });

  // The boundary comes from this stamp, not from the 2019 star row above it.
  stampFirstCollected(db, 1, { day: FROM, collectedAt: COLLECTED_AT });
  return db;
}

/**
 * The page the tests read, over the four-day range with the hole in it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [overrides]
 * @param {string} [overrides.owner]
 * @param {string} [overrides.name]
 * @param {string} [overrides.from]
 * @param {string} [overrides.to]
 * @param {string} [overrides.today]
 * @returns {import('../src/server/repo-data.js').RepositoryPage}
 */
function pageFor(db, overrides = {}) {
  return readRepositoryPage({
    db,
    owner: overrides.owner ?? OWNER,
    name: overrides.name ?? NAME,
    from: overrides.from ?? FROM,
    to: overrides.to ?? TO,
    clock: () => READ_AT_MS,
    ...(overrides.today === undefined ? {} : { today: overrides.today }),
  });
}

/**
 * @param {import('../src/server/repo-data.js').RepositoryPage} page
 * @param {string} metric
 * @returns {import('../src/db/day-series-repo.js').DayFact[]}
 */
function rowsOf(page, metric) {
  const series = page.series.find((entry) => entry.metric === metric);
  assert.ok(series !== undefined, `the page must carry the ${metric} series`);
  return series.rows;
}

/**
 * @param {import('../src/db/day-series-repo.js').DayFact[]} rows
 * @returns {string[]} The stored days, oldest first.
 */
function storedDays(rows) {
  return rows.map((row) => row.day);
}

/**
 * Count the statements an open archive is asked to prepare, so a test can prove
 * that a rejected request read nothing at all.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {() => number} Statements prepared since this call.
 */
function countStatements(db) {
  let prepared = 0;
  const original = db.prepare.bind(db);
  db.prepare = /** @type {typeof db.prepare} */ (
    /** @param {string} sql */
    (sql) => {
      prepared += 1;
      return original(sql);
    });
  return () => prepared;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Record<string, number>} Row count of every table the read touches.
 */
function rowCounts(db) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of ['repositories', 'repository_aliases', 'day_series', 'snapshots',
    'repository_errors', 'runs', 'heartbeats', 'backfill_records']) {
    const row = /** @type {{n: number}} */ (/** @type {unknown} */ (db.prepare(
      `SELECT count(*) AS n FROM ${table}`).get()));
    counts[table] = row.n;
  }
  return counts;
}

test('the page hands the views the days the range covers beside the days the archive stores', async (t) => {
  const db = await fixture(t);
  const page = pageFor(db);
  assert.equal(page.status, PAGE_STATUS_KNOWN);
  assert.deepEqual(page.range, { from: FROM, to: TO });
  assert.deepEqual(page.calendarDays, [FROM, FIRST_STORED_DAY, HOLE, TO]);

  const views = rowsOf(page, 'views');
  // The hole is in the calendar and absent from the series: a view sees the day
  // the range covers and finds no stored value for it, which is what makes a gap
  // renderable instead of a zero.
  assert.equal(page.calendarDays.includes(HOLE), true);
  assert.deepEqual(storedDays(views), [FROM, FIRST_STORED_DAY, TO]);
  assert.equal(views.some((row) => row.day === HOLE), false);
  // The rows are the archive's own, spread only because a statement row has a null
  // prototype and the comparison is between plain objects.
  assert.deepEqual(views.map((row) => ({ ...row })), [
    { repositoryId: 1, metric: 'views', granularity: 'day', day: FROM, value: 30,
      source: 'collected', collectedAt: COLLECTED_AT },
    { repositoryId: 1, metric: 'views', granularity: 'day', day: FIRST_STORED_DAY, value: 41,
      source: 'collected', collectedAt: COLLECTED_AT },
    { repositoryId: 1, metric: 'views', granularity: 'day', day: TO, value: 52,
      source: 'collected', collectedAt: COLLECTED_AT },
  ]);
  assert.ok(views.length < page.calendarDays.length);
});

test('a missing day is never defaulted, carried across metrics or read from another repository', async (t) => {
  const db = await fixture(t);
  const page = pageFor(db);

  // Clones stored the day views did not; the read never moves one into the other.
  assert.deepEqual(storedDays(rowsOf(page, 'clones')), [FROM, HOLE]);
  assert.deepEqual(storedDays(rowsOf(page, 'views')), [FROM, FIRST_STORED_DAY, TO]);
  assert.deepEqual(storedDays(rowsOf(page, 'unique-cloners')), [FIRST_STORED_DAY]);
  // Every stored day is inside the range, and no metric contains a substituted zero
  // for a day the archive never recorded.
  for (const { metric, rows } of page.series) {
    for (const row of rows) {
      assert.ok(row.day >= page.range.from && row.day <= page.range.to,
        `${metric} row ${row.day} must lie inside the selected range`);
    }
  }
  // The other repository's 999 lives under its own identity and is not on this page.
  assert.equal(rowsOf(page, 'views').some((row) => row.value === 999), false);
  assert.equal(page.repository?.id, 1);
});

test('every page metric arrives with the granularity the archive stores it at, in the documented order', async (t) => {
  const db = await fixture(t);
  const page = pageFor(db);
  assert.deepEqual(page.series.map((entry) => [entry.metric, entry.granularity]),
    PAGE_METRICS.map((entry) => [entry.metric, entry.granularity]));
  assert.deepEqual(page.series.map((entry) => entry.metric),
    ['clones', 'unique-cloners', 'views', 'unique-visitors', 'stars', 'commit-activity',
      'owner-participation']);
  // The weekly metric is stored at the week start and stays a week, so no view can
  // read a week bucket as a day.
  assert.deepEqual(rowsOf(page, 'commit-activity').map((row) => [row.day, row.granularity, row.value]),
    [[FIRST_STORED_DAY, 'week', 7]]);
  // The backfilled star row from 2019 is outside the range and is not returned.
  assert.deepEqual(storedDays(rowsOf(page, 'stars')), [HOLE]);
  assert.equal(rowsOf(page, 'stars')[0].source, 'backfill');
});

test('both referrer captures come back with their own capture times and the latest is the newest one', async (t) => {
  const db = await fixture(t);
  const page = pageFor(db);

  const referrers = page.captures.referrers;
  assert.equal(referrers.length, 2, 'two captures stay two captures');
  assert.deepEqual(referrers.map((capture) => [capture.runId, capture.collectedAt]),
    [['run-1', RUN_ONE], ['run-2', RUN_TWO]]);
  assert.deepEqual(referrers.map((capture) => capture.entries.length), [2, 2]);
  // The label captured twice is not merged into one list, and each capture keeps
  // the count that was recorded with it.
  const labels = referrers.map((capture) => capture.entries.map((entry) => [entry.label, entry.count]));
  assert.deepEqual(labels, [
    [['https://example.org/blog', 4], ['https://news.example/post', 2]],
    [['https://example.org/blog', 9], ['https://example.org/other', 1]],
  ]);
  assert.deepEqual(page.latestCaptures.referrers, referrers[1].entries);

  assert.deepEqual(page.captures.popularPaths.map((capture) => [capture.runId, capture.collectedAt]),
    [['run-2', RUN_TWO]]);
  assert.deepEqual(page.captures.popularPaths[0].entries.map((entry) => [entry.label, entry.title, entry.uniques]),
    [['/guide', 'Guide', 6], ['/api/v1', null, 5]]);
  assert.deepEqual(page.latestCaptures.popularPaths, page.captures.popularPaths[0].entries);
});

test('health and provenance arrive unchanged from the reads that own them', async (t) => {
  const db = await fixture(t);
  const page = pageFor(db, { today: FROM });

  assert.deepEqual(page.health, repositoryHealth(db, 1, READ_AT_MS));
  assert.deepEqual(page.provenance, readProvenance(db, 1, { today: FROM }));
  assert.equal(page.health?.state, 'degraded');
  assert.equal(page.health?.consecutiveFailures, 1);
  assert.equal(page.health?.lastSuccessAt, COLLECTED_AT);
  assert.equal(page.health?.stalled, false);
  assert.equal(page.health?.lastFailure?.kind, 'rate-limited');
  assert.equal(page.health?.needsReauthentication, false);

  // The boundary is the recorded stamp at 2026-09-20, never the 2019 star row and
  // never the first day a metric happens to hold.
  assert.equal(page.provenance?.firstCollectedDay, FROM);
  assert.equal(page.provenance?.connectedToday, true);
  assert.equal(rowsOf(page, 'stars').some((row) => row.day === '2019-04-01'), false);

  // An injected reference day changes only the connected-today answer the read owns.
  assert.equal(pageFor(db, { today: TO }).provenance?.connectedToday, false);
});

test('a repository the archive does not hold is unknown, not an empty repository', async (t) => {
  const db = await fixture(t);
  assert.equal(findRepository(db, OWNER, 'never-collected'), null);

  for (const name of ['never-collected', '<script>"quoted"</script>']) {
    const page = pageFor(db, { name });
    assert.equal(page.status, PAGE_STATUS_UNKNOWN);
    assert.equal(page.repository, null);
    assert.deepEqual(page.series, []);
    assert.deepEqual(page.calendarDays, [], 'an unknown repository has no calendar to lay out');
    assert.deepEqual(page.captures, { referrers: [], popularPaths: [] });
    assert.deepEqual(page.latestCaptures, { referrers: [], popularPaths: [] });
    assert.equal(page.health, null);
    assert.equal(page.provenance, null);
    // The request is echoed back as data, untouched: escaping is the view's step and
    // the read must not pre-encode what the archive stored.
    assert.equal(page.name, name);
    assert.deepEqual(page.range, { from: FROM, to: TO });
  }
});

test('an invalid range is refused before a single query runs', async (t) => {
  const db = await fixture(t);
  for (const range of /** @type {Array<{from: string, to: string, error: RegExp}>} */ ([
    { from: TO, to: FROM, error: /Inverted range/ },
    { from: '2026-02-30', to: TO, error: /Malformed day for "from"/ },
    { from: '2026-10-2', to: TO, error: /Malformed day for "from"/ },
    { from: '', to: TO, error: /needs a first day/ },
    { from: FROM, to: '', error: /needs a last day/ },
  ])) {
    const prepared = countStatements(db);
    assert.throws(() => pageFor(db, range), range.error, `range ${range.from}..${range.to} must be refused`);
    assert.equal(prepared(), 0, 'an invalid range must be refused before any query runs');
  }
  // An identity that could name no repository row is refused on the same footing.
  for (const identity of /** @type {Array<{owner: string, name: string}>} */ ([
    { owner: '', name: NAME }, { owner: OWNER, name: '' },
  ])) {
    const prepared = countStatements(db);
    assert.throws(() => pageFor(db, identity), /needs the repository/);
    assert.equal(prepared(), 0, 'an unusable identity must be refused before any query runs');
  }
});

test('a range the archive holds no day for returns a full calendar beside empty row lists', async (t) => {
  const db = await fixture(t);
  const page = pageFor(db, { from: '2026-01-01', to: '2026-01-03' });
  assert.equal(page.status, PAGE_STATUS_KNOWN);
  assert.deepEqual(page.calendarDays, ['2026-01-01', '2026-01-02', '2026-01-03']);
  for (const { metric, rows } of page.series) {
    assert.deepEqual(rows, [], `${metric} must report no stored day rather than a zero`);
  }
  assert.deepEqual(page.captures.referrers.length, 2, 'captures are not filtered by the range');
});

test('a four-hundred-day range costs a fixed number of statements and returns no invented row', async (t) => {
  const db = await fixture(t);
  const from = new Date(Date.parse(`${TO}T00:00:00.000Z`) - 399 * 86_400_000).toISOString().slice(0, 10);

  const prepared = countStatements(db);
  const wide = pageFor(db, { from });
  const wideStatements = prepared();
  const narrow = pageFor(db);
  const narrowStatements = prepared() - wideStatements;

  assert.equal(wide.calendarDays.length, 400);
  assert.equal(wide.series.length, PAGE_METRICS.length);
  // The statement count does not grow with the range, because the read is one query
  // per metric and per capture rather than one query per day.
  assert.ok(narrowStatements > 0, 'the counter must be counting the statements a real read prepares');
  assert.equal(wideStatements, narrowStatements);
  assert.ok(wideStatements <= 40, `a page read must stay a fixed number of queries, saw ${wideStatements}`);
  assert.deepEqual(storedDays(rowsOf(wide, 'views')), [FROM, FIRST_STORED_DAY, TO]);
  assert.equal(rowsOf(wide, 'clones').length, 2);
});

test('a recorded alias resolves to the same repository, so a pre-rename bookmark still opens', async (t) => {
  const db = await fixture(t);
  assert.equal(findRepository(db, OWNER, 'archive-old'), null);
  upsertAlias(db, { repositoryId: 1, owner: OWNER, name: 'archive-old', recordedAt: RUN_TWO });

  assert.equal(findRepository(db, OWNER, 'archive-old')?.id, 1);
  const page = pageFor(db, { name: 'archive-old' });
  assert.equal(page.status, PAGE_STATUS_KNOWN);
  assert.equal(page.repository?.id, 1);
  assert.deepEqual(page.name, 'archive-old', 'the requested identity is echoed, not the stored one');
  assert.deepEqual(storedDays(rowsOf(page, 'views')), [FROM, FIRST_STORED_DAY, TO]);
});

test('the read changes nothing in the archive and returns stored values verbatim', async (t) => {
  const db = await fixture(t);
  const before = rowCounts(db);
  const page = pageFor(db);
  assert.deepEqual(rowCounts(db), before, 'reading a page must write nothing');
  assert.deepEqual(pageFor(db), page, 'the same request reads the same page');
  assert.equal(page.repository?.lifecycle, 'active');
  assert.equal(page.repository?.enrolled, 1);
});

test('this module is a read path: no markup, no view, no remote asset and no verdict vocabulary', async (t) => {
  const db = await fixture(t);
  pageFor(db);
  assert.deepEqual(attemptedUrls, [], 'the page data layer makes no request of its own');

  for (const forbidden of ['node:http', 'node:https', 'node:fs', 'documentShell', 'escapeText',
    'escapeAttribute', 'escapeUrl', 'views/', '<html', '<svg', 'fetch(', 'require(']) {
    assert.equal(moduleSource.includes(forbidden), false,
      `the page data layer must not contain or import ${forbidden}`);
  }
  // RS-HO-01: no score, ranking, trend word or adoption language in anything this
  // module can put in front of a reader. Comments are stripped first, because the
  // module says in prose that it emits none of these words.
  const emitted = moduleSource.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');
  for (const word of ['adoption', 'score', 'rank', 'ranking', 'trending', 'momentum',
    'engagement', 'popularity', 'increasing', 'decreasing', 'surging', 'declining', 'improving']) {
    assert.equal(emitted.toLowerCase().includes(word), false,
      `the page data layer must not emit the word ${word}`);
  }
});