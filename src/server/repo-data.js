import { readProvenance } from '../backfill/provenance.js';
import {
  COMMIT_ACTIVITY_METRIC, DEVELOPMENT_GRANULARITY, OWNER_PARTICIPATION_METRIC,
} from '../backfill/development.js';
import { STARS_GRANULARITY, STARS_METRIC } from '../backfill/stars.js';
import {
  CLONES_METRIC, TRAFFIC_GRANULARITY, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../collect/traffic.js';
import { calendarDays, readDaySeries } from '../db/day-series-repo.js';
import { getRepository } from '../db/ops-repo.js';
import { readLatestCapture, readSnapshotHistory } from '../db/snapshot-repo.js';
import { repositoryHealth } from '../supervision/health.js';
import { parseRange } from './router.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../backfill/provenance.js').Provenance} Provenance */
/** @typedef {import('../db/day-series-repo.js').DayFact} DayFact */
/** @typedef {import('../db/ops-repo.js').Repository} Repository */
/** @typedef {import('../db/snapshot-repo.js').Snapshot} Snapshot */
/** @typedef {import('../db/snapshot-repo.js').SnapshotKind} SnapshotKind */
/** @typedef {import('../supervision/health.js').RepositoryHealth} RepositoryHealth */

/**
 * The page data layer: the single read the repository detail page is built from,
 * and nothing else. It answers one question - what the archive actually holds
 * about one repository over one inclusive day range - and hands the answer to the
 * views as data. It contains no rendering, no HTML, no chart markup and no view
 * import, so a view cannot find markup to build here and this module cannot grow
 * an opinion about how a page looks.
 *
 * Three rules decide what comes out, and they are the reason this module exists
 * as its own read rather than as a convenience inside a view:
 *
 * 1. **A missing day stays a missing day.** The stored rows come from the
 *    archive's range read, which returns what exists, and the days the range
 *    covers come from `calendarDays`, which says nothing about values. They are
 *    returned as two separate lists and are never merged, indexed into one
 *    another or collapsed into a dense array: doing that is how a zero appears
 *    for a day nobody measured, and the hole in the data is the finding.
 * 2. **An absent repository is unknown, not empty.** The archive is asked first
 *    whether it holds this repository at all. A repository it does not hold
 *    reports `unknown` with no series, no calendar, no captures, no health and no
 *    provenance, because "no repository called this" and "a repository with no
 *    traffic" are different facts and a page must never conflate them.
 * 3. **The range is checked before the first query.** A malformed or inverted
 *    range is refused while nothing has been read, so an invalid range can never
 *    come back as an empty chart - which looks exactly like a repository with no
 *    traffic, the finding this product must never invent.
 *
 * Health and provenance are passed through unchanged from the reads that own
 * them (`repositoryHealth` and `readProvenance`), including the collection
 * boundary: the first collected day is whatever the archive recorded, and this
 * module never supplies one of its own, never infers it from the earliest stored
 * row and never substitutes the earliest day a metric happens to hold.
 *
 * Every reading is recorded evidence. The module names no score, no threshold,
 * no trend and no verdict, makes no request of its own, and reads no credential:
 * the collector owns all outbound access, so a page can never make one.
 */

/** The archive holds this repository and this page has data to show. */
export const PAGE_STATUS_KNOWN = /** @type {const} */ ('known');
/** The archive does not hold this repository: unknown, never empty. */
export const PAGE_STATUS_UNKNOWN = /** @type {const} */ ('unknown');

/** @typedef {'known'|'unknown'} PageStatus */

/**
 * One metric a page may chart, with the granularity the archive stores it at.
 * Reading a week bucket as though it were a day is the other way a chart starts
 * lying, so the bucket travels with the metric name rather than being assumed.
 *
 * @typedef {object} PageMetric
 * @property {string} metric The archive's own metric key.
 * @property {'day'|'week'} granularity The bucket that key is stored at.
 */

/**
 * Every metric the product writes, in the order the page reads them: acquisition,
 * interest, recognition, then the weekly development metrics. The keys are the
 * constants the writers export, so this list cannot drift from what the archive
 * actually holds, and a metric no run has ever written still appears with an
 * empty row list - which is a gap to render, not a metric to omit.
 *
 * @type {readonly Readonly<PageMetric>[]}
 */
export const PAGE_METRICS = Object.freeze([
  { metric: CLONES_METRIC, granularity: TRAFFIC_GRANULARITY },
  { metric: UNIQUE_CLONERS_METRIC, granularity: TRAFFIC_GRANULARITY },
  { metric: VIEWS_METRIC, granularity: TRAFFIC_GRANULARITY },
  { metric: UNIQUE_VISITORS_METRIC, granularity: TRAFFIC_GRANULARITY },
  { metric: STARS_METRIC, granularity: STARS_GRANULARITY },
  { metric: COMMIT_ACTIVITY_METRIC, granularity: DEVELOPMENT_GRANULARITY },
  { metric: OWNER_PARTICIPATION_METRIC, granularity: DEVELOPMENT_GRANULARITY },
].map((entry) => Object.freeze(entry)));

/**
 * One metric's stored days over the selected range. `rows` is what the archive
 * holds and nothing more: a day with no row is absent from it, and the days the
 * range covers are on the page as `calendarDays`. Nothing in this layer derives a
 * value, carries one forward or fills one from another metric.
 *
 * @typedef {object} PageSeries
 * @property {string} metric
 * @property {'day'|'week'} granularity
 * @property {DayFact[]} rows Stored days only, oldest first, each with its source and collection time.
 */

/**
 * One recorded list capture: the entries of a single capture, kept with the run
 * and the instant it was captured. Snapshots are append-only and a capture has no
 * day dimension, so two captures of one referrer stay two captures here rather
 * than merging into one list that never existed.
 *
 * @typedef {object} SnapshotCapture
 * @property {string} runId The run that recorded the capture.
 * @property {string} collectedAt The instant that capture was taken.
 * @property {Snapshot[]} entries Every stored entry of that capture, in the vendor's order.
 */

/**
 * @typedef {object} SnapshotCaptures
 * @property {SnapshotCapture[]} referrers Captures of the referrer list, oldest first.
 * @property {SnapshotCapture[]} popularPaths Captures of the popular-path list, oldest first.
 */

/**
 * The newest stored capture of each list, as the archive's own latest-capture
 * read selects it, so no view has to re-derive which capture is current. A
 * repository with no stored capture of a kind reports an empty list, which is an
 * absence of a capture rather than a capture with nothing in it.
 *
 * @typedef {object} SnapshotLatest
 * @property {Snapshot[]} referrers
 * @property {Snapshot[]} popularPaths
 */

/**
 * The selected inclusive range, already validated.
 * @typedef {object} PageRange
 * @property {string} from First day, ISO `YYYY-MM-DD`.
 * @property {string} to Last day, inclusive, ISO `YYYY-MM-DD`.
 */

/**
 * Everything one repository page reads. `status` is the variant a consumer
 * branches on: `known` carries the repository and every reading below it, while
 * `unknown` carries the requested identity and nothing else. Health and
 * provenance are the objects their own reads returned, unmodified.
 *
 * @typedef {object} RepositoryPage
 * @property {PageStatus} status `known` when the archive holds the repository.
 * @property {string} owner Owner as requested, exactly as the route carried it.
 * @property {string} name Name as requested, exactly as the route carried it.
 * @property {PageRange} range The validated inclusive range the page is about.
 * @property {Repository|null} repository The archive's own row, or null when unknown.
 * @property {string[]} calendarDays Every day the range covers, including days with no stored row.
 * @property {PageSeries[]} series One entry per page metric, stored rows only.
 * @property {SnapshotCaptures} captures Every recorded capture of both lists, with its capture time.
 * @property {SnapshotLatest} latestCaptures The newest stored capture of each list.
 * @property {RepositoryHealth|null} health The supervision read for this repository, or null when unknown.
 * @property {Provenance|null} provenance The provenance read for this repository, or null when unknown.
 */

/**
 * @typedef {object} RepositoryPageOptions
 * @property {Database} db Open archive; the caller owns closing it.
 * @property {string} owner Repository owner from the route.
 * @property {string} name Repository name from the route.
 * @property {string} from First day of the inclusive range, ISO `YYYY-MM-DD`.
 * @property {string} to Last day of the inclusive range, ISO `YYYY-MM-DD`.
 * @property {() => number} [clock] Epoch milliseconds the health read is judged against.
 * @property {string} [today] Reference UTC day for the provenance read's connected-today answer.
 */

/**
 * Refuse an identity that could never name an archive row. The route already
 * decoded these values, so this only rejects what a direct caller could pass:
 * an empty owner or name is a mistake worth naming, not a repository to look up.
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function assertIdentityPart(value, what) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`A page needs the repository ${what}; supply a non-empty string`);
  }
  return value;
}

/**
 * Validate the inclusive range before anything is read. The day and range rules
 * are the router's, reused rather than restated: a page read that accepted a
 * range the route already refused would let the two disagree about what a day is.
 * @param {RepositoryPageOptions} options
 * @returns {PageRange}
 */
function validateRange({ from, to }) {
  if (typeof from !== 'string' || from === '') {
    throw new RangeError('A page needs a first day; supply "from" as an ISO day such as 2026-01-31');
  }
  if (typeof to !== 'string' || to === '') {
    throw new RangeError('A page needs a last day; supply "to" as an ISO day such as 2026-01-31');
  }
  const parsed = parseRange(new URLSearchParams({ from, to }));
  if ('error' in parsed) throw new RangeError(parsed.error);
  return { from, to };
}

/**
 * Find the repository this page is about, or null when the archive does not hold
 * it. The archive's own row is returned rather than a re-typed copy of it, so
 * the identity, lifecycle and recorded collection state a page shows are the ones
 * the archive holds.
 *
 * A recorded alias resolves too. A repository renamed on GitHub keeps its
 * history under one stable id, and the alias table is where that rename is
 * recorded, so a bookmark made before the rename still opens the same page
 * instead of turning into a 404 over a page that is still there. Matching is on
 * the spelling the archive holds: a differently cased request is a different
 * spelling, and deciding to fold case is a routing policy, not a read's rule.
 *
 * @param {Database} db Open archive; the caller owns closing it.
 * @param {string} owner
 * @param {string} name
 * @returns {Repository|null} The stored repository, or null when the archive holds no such identity.
 */
export function findRepository(db, owner, name) {
  const direct = /** @type {{id: number}|undefined} */ (/** @type {unknown} */ (db.prepare(
    'SELECT id FROM repositories WHERE owner=? AND name=?').get(owner, name)));
  if (direct !== undefined) return getRepository(db, direct.id);

  const aliased = /** @type {{repository_id: number}|undefined} */ (/** @type {unknown} */ (db.prepare(
    'SELECT repository_id FROM repository_aliases WHERE owner=? AND name=? ORDER BY recorded_at DESC, rowid DESC LIMIT 1')
    .get(owner, name)));
  return aliased === undefined ? null : getRepository(db, aliased.repository_id);
}

/**
 * Group the archive's snapshot history into captures. Capture identity is the run
 * plus the collection instant the archive itself records, so entries of one
 * capture arrive together and two captures of the same list stay apart with
 * their own times. The schema stores entries only, so no capture is ever
 * manufactured for a list that produced none.
 * @param {Database} db
 * @param {number} repositoryId
 * @param {SnapshotKind} kind
 * @returns {SnapshotCapture[]} Oldest capture first, as the archive's history read returns them.
 */
function capturesOf(db, repositoryId, kind) {
  /** @type {Map<string, SnapshotCapture>} */
  const grouped = new Map();
  for (const entry of readSnapshotHistory(db, repositoryId, kind)) {
    const key = JSON.stringify([entry.runId, entry.collectedAt]);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { runId: entry.runId, collectedAt: entry.collectedAt, entries: [entry] });
    } else {
      existing.entries.push(entry);
    }
  }
  return [...grouped.values()];
}

/**
 * The page as the archive holds it, for one repository over one inclusive day
 * range. Read the arguments in the order they are checked: the range is
 * validated first, then the archive is asked whether it holds this repository,
 * and only then is anything read for the page.
 *
 * Both bounds are required. A route may arrive with only one of them, and the
 * route's own page context carries `null` for an absent bound; resolving that
 * into a full range belongs to the view, which owns the default-window policy.
 * Choosing a missing bound here would be this read inventing a range, and a
 * range invented by the reader is the same class of mistake as a day invented by
 * the reader.
 *
 * @param {RepositoryPageOptions} options
 * @returns {RepositoryPage}
 */
export function readRepositoryPage(options) {
  const { db, owner, name, clock = Date.now, today } = options;
  const repositoryOwner = assertIdentityPart(owner, 'owner');
  const repositoryName = assertIdentityPart(name, 'name');
  const range = validateRange(options);

  const repository = findRepository(db, repositoryOwner, repositoryName);
  if (repository === null) {
    return {
      status: PAGE_STATUS_UNKNOWN,
      owner: repositoryOwner,
      name: repositoryName,
      range,
      repository: null,
      // The archive holds no such repository, so it has no calendar to lay out,
      // no stored day, no capture and no recorded collection state. Reporting an
      // empty series for a repository that does not exist would be the same lie
      // as reporting a zero for an unmeasured day: both invent a reading.
      calendarDays: [],
      series: [],
      captures: { referrers: [], popularPaths: [] },
      latestCaptures: { referrers: [], popularPaths: [] },
      health: null,
      provenance: null,
    };
  }

  const nowMs = clock();
  return {
    status: PAGE_STATUS_KNOWN,
    owner: repositoryOwner,
    name: repositoryName,
    range,
    repository,
    // The two lists that must stay separate: the days the range covers, and the
    // days the archive holds. A view joins them by day and breaks the line where
    // one has a day and the other does not.
    calendarDays: calendarDays(range.from, range.to),
    series: PAGE_METRICS.map((entry) => ({
      metric: entry.metric,
      granularity: entry.granularity,
      rows: readDaySeries(db, {
        repositoryId: repository.id,
        metric: entry.metric,
        granularity: entry.granularity,
        from: range.from,
        to: range.to,
      }),
    })),
    captures: {
      referrers: capturesOf(db, repository.id, 'referrers'),
      popularPaths: capturesOf(db, repository.id, 'popular_paths'),
    },
    latestCaptures: {
      referrers: readLatestCapture(db, repository.id, 'referrers'),
      popularPaths: readLatestCapture(db, repository.id, 'popular_paths'),
    },
    // Recorded state, passed through as its own read returned it. Neither is
    // summarised here: the state word and its sentence belong to the read that
    // produced them, and a first collected day is never derived from the rows.
    health: repositoryHealth(db, repository.id, nowMs),
    provenance: readProvenance(db, repository.id, today === undefined ? {} : { today }),
  };
}