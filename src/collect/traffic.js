import { upsertDayFact } from '../db/day-series-repo.js';
import { assertRepository, assertTimestamp, withTransaction } from '../db/ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../github/traffic-client.js').TrafficRecord} TrafficRecord */
/** @typedef {import('../github/traffic-client.js').TrafficGranularity} TrafficGranularity */
/** @typedef {{clones: (repo: string, per?: TrafficGranularity) => Promise<TrafficRecord[]>, views: (repo: string, per?: TrafficGranularity) => Promise<TrafficRecord[]>}} TrafficClient */
/** @typedef {'count'|'uniques'} TrafficField */
/** @typedef {Array<{metric: string, field: TrafficField}>} MetricKeys */
/** @typedef {{days: number, rows: number, written: number, revised: number, unchanged: number}} TrafficSummary */

// The day series carries one value per repository, metric, granularity and day,
// so each returned number becomes its own metric key instead of one row that has
// to drop the other: `count` is the traffic total and `uniques` is GitHub's own
// distinct-visitor count, which the archive stores and never extrapolates.
export const CLONES_METRIC = /** @type {const} */ ('clones');
export const UNIQUE_CLONERS_METRIC = /** @type {const} */ ('unique-cloners');
export const VIEWS_METRIC = /** @type {const} */ ('views');
export const UNIQUE_VISITORS_METRIC = /** @type {const} */ ('unique-visitors');
export const TRAFFIC_GRANULARITY = /** @type {const} */ ('day');
export const TRAFFIC_SOURCE = /** @type {const} */ ('collected');

/** @type {MetricKeys} */
const CLONE_KEYS = [
  { metric: CLONES_METRIC, field: 'count' },
  { metric: UNIQUE_CLONERS_METRIC, field: 'uniques' },
];
/** @type {MetricKeys} */
const VIEW_KEYS = [
  { metric: VIEWS_METRIC, field: 'count' },
  { metric: UNIQUE_VISITORS_METRIC, field: 'uniques' },
];

/**
 * Refuse a record that cannot become a day fact. A missing or non-integer count is
 * a contract failure, not a zero to store, and a week bucket is never relabelled as
 * a day. The calendar day itself is validated by the archive layer.
 * @param {TrafficRecord} record
 * @param {string} metric
 */
function assertDayRecord(record, metric) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`Traffic ${metric} entry must be a record`);
  }
  if (record.granularity !== TRAFFIC_GRANULARITY) {
    throw new TypeError(`Traffic ${metric} entry must carry granularity day; collection never stores a week bucket`);
  }
  if (typeof record.day !== 'string' || record.day.length === 0) {
    throw new TypeError(`Traffic ${metric} entry must carry the UTC day the traffic client derived`);
  }
  for (const field of /** @type {TrafficField[]} */ (['count', 'uniques'])) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Traffic ${metric} entry ${record.day} must carry a non-negative integer ${field}`);
    }
  }
}

/**
 * Write one repository's returned traffic days through the day-series upsert.
 *
 * Every returned day becomes one row per metric key, stamped `source = collected`
 * with the collection time the caller supplies. GitHub re-serves the same rolling
 * 14-day window every day, so a re-run inside that window corrects the stored
 * value in place: the row count is unchanged and the newest collection survives. A
 * replay stamped with an older or equal collection time changes nothing, because
 * newer evidence is never overwritten by a stale one. A day GitHub did not return
 * is never written, defaulted or carried forward; a returned zero is stored as the
 * observed zero it is.
 *
 * Synchronous and write-only, so a caller that must commit a repository's traffic
 * and its snapshots together can compose this inside one wider transaction. The
 * network reads belong to collectTraffic.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {TrafficRecord[]} options.clones
 * @param {TrafficRecord[]} options.views
 * @param {string} options.collectedAt canonical UTC ISO timestamp for the whole write
 * @returns {TrafficSummary} Rows applied per metric key, not per day: `written` is a
 * key the archive had never stored, `revised` an existing key corrected in place,
 * and `unchanged` a returned row the archive already held at least as new a value.
 */
export function writeTrafficDays({ db, repositoryId, clones, views, collectedAt }) {
  assertTimestamp(collectedAt);
  assertRepository(db, repositoryId);
  const stored = db.prepare(`SELECT 1 FROM day_series
    WHERE repository_id=? AND metric=? AND granularity=? AND day=?`);
  /** @type {Set<string>} */
  const days = new Set();
  /** @type {TrafficSummary} */
  const summary = { days: 0, rows: 0, written: 0, revised: 0, unchanged: 0 };

  /** @param {MetricKeys} keys @param {TrafficRecord[]} records */
  const apply = (keys, records) => {
    for (const record of records) {
      for (const { metric, field } of keys) {
        assertDayRecord(record, metric);
        days.add(record.day);
        const existed = stored.get(repositoryId, metric, TRAFFIC_GRANULARITY, record.day) !== undefined;
        const result = upsertDayFact(db, { repositoryId, metric, granularity: TRAFFIC_GRANULARITY,
          day: record.day, value: record[field], source: TRAFFIC_SOURCE, collectedAt });
        summary.rows += 1;
        if (!existed) summary.written += 1;
        else if (result.changes === 1) summary.revised += 1;
        else summary.unchanged += 1;
      }
    }
  };
  apply(CLONE_KEYS, clones);
  apply(VIEW_KEYS, views);
  summary.days = days.size;
  return summary;
}

/**
 * Collect the clone and view traffic of one repository and write it as one unit.
 *
 * Both breakdowns are read before the transaction opens, because an archive
 * transaction is synchronous and must never hold a socket open; the whole write
 * then commits as a single transaction, so an interruption between repositories,
 * or a failure between two writes inside one repository, leaves no half-written
 * repository behind. This step decides nothing about whether a run continues: it
 * raises the failure and the run decides that. It embeds no timer and reads no
 * clock, because the collection time belongs to the run that scheduled it. It
 * stamps no collection boundary either: the run that schedules the collection
 * owns the day it hands to stampFirstCollected.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.repo owner/name pair
 * @param {TrafficClient} options.trafficClient
 * @param {string} options.collectedAt canonical UTC ISO timestamp for this run
 * @returns {Promise<TrafficSummary>}
 */
export async function collectTraffic({ db, repositoryId, repo, trafficClient, collectedAt }) {
  assertTimestamp(collectedAt);
  assertRepository(db, repositoryId);
  const clones = await trafficClient.clones(repo, TRAFFIC_GRANULARITY);
  const views = await trafficClient.views(repo, TRAFFIC_GRANULARITY);
  return withTransaction(db, () =>
    writeTrafficDays({ db, repositoryId, clones, views, collectedAt }));
}