import { assertRepository, assertTimestamp } from './ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {{repositoryId: number, metric: string, granularity: 'day'|'week', day: string, value: number, source: 'backfill'|'collected', collectedAt: string}} DayFact */
/** @typedef {{repositoryId: number, metric: string, granularity: 'day'|'week', from: string, to: string}} DayRange */

/**
 * Validate real UTC calendar dates, rejecting normalised impossible days.
 * @param {string} day
 * @returns {number} UTC milliseconds.
 */
function dayTime(day) {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid calendar day; supply a real UTC date in YYYY-MM-DD form');
  }
  return time;
}

/**
 * Validate inclusive ranges consistently without converting reversed dates to empty data.
 * @param {string} from
 * @param {string} to
 */
function rangeTimes(from, to) {
  const start = dayTime(from);
  const end = dayTime(to);
  if (start > end) throw new Error('Reversed day range; supply from <= to');
  return { start, end };
}

/**
 * Enumerate all inclusive UTC days separately from observations. This calendar says
 * nothing about values: a missing day is never written or returned as a zero.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function calendarDays(from, to) {
  const { start, end } = rangeTimes(from, to);
  const days = [];
  for (let time = start; time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Correct only the identical four-part key with a strictly newer collection time.
 * Value, source and time move together; stale/equal writes are read-only no-ops.
 * Database constraints independently enforce source, granularity and provenance.
 * @param {Database} db
 * @param {DayFact} fact
 */
export function upsertDayFact(db, fact) {
  dayTime(fact.day);
  assertTimestamp(fact.collectedAt);
  return db.prepare(`INSERT INTO day_series
    (repository_id, metric, granularity, day, value, source, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, metric, granularity, day) DO UPDATE SET
      value=excluded.value, source=excluded.source, collected_at=excluded.collected_at
    WHERE excluded.collected_at > day_series.collected_at`)
    .run(fact.repositoryId, fact.metric, fact.granularity, fact.day, fact.value, fact.source, fact.collectedAt);
}

/**
 * Return only stored facts ordered by day, including source and collection time.
 * Inclusive bounds do not densify, carry values, or mix repositories/metrics/buckets.
 * A known repository with no observations returns []; an unknown identity errors.
 * @param {Database} db
 * @param {DayRange} range
 * @returns {DayFact[]}
 */
export function readDaySeries(db, range) {
  rangeTimes(range.from, range.to);
  assertRepository(db, range.repositoryId);
  return /** @type {DayFact[]} */ (/** @type {unknown} */ (db.prepare(`SELECT
    repository_id AS repositoryId, metric, granularity, day, value, source, collected_at AS collectedAt
    FROM day_series WHERE repository_id=? AND metric=? AND granularity=? AND day BETWEEN ? AND ?
    ORDER BY day`).all(range.repositoryId, range.metric, range.granularity, range.from, range.to)));
}
