import { upsertDayFact } from '../db/day-series-repo.js';
import { assertRepository, assertTimestamp } from '../db/ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../github/stars-client.js').StarWeek} StarWeek */

export const STARS_METRIC = 'stars';
export const STARS_GRANULARITY = /** @type {const} */ ('day');
export const STARS_SOURCE = /** @type {const} */ ('backfill');

const SECONDS_PER_DAY = 86_400;
const DAYS_PER_WEEK = 7;

/**
 * The UTC calendar day a week starts on, or null when the instant is not a UTC
 * midnight.
 *
 * GitHub documents that "week and day boundaries are not guaranteed to align with
 * UTC", so this is verified per week rather than assumed. A week that does not
 * start on a UTC midnight carries day counts for buckets this archive cannot name,
 * and naming them anyway would move real stars onto days that never held them. The
 * caller records those weeks as a gap instead.
 * @param {number} start Week start as a Unix timestamp in seconds.
 * @returns {string|null} `YYYY-MM-DD`, or null when the instant is not a UTC midnight.
 */
export function utcWeekStart(start) {
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start <= 0) return null;
  if (start % SECONDS_PER_DAY !== 0) return null;
  const day = new Date(start * 1000).toISOString().slice(0, 10);
  // A round trip through the date proves the instant is a real calendar day and not
  // an extreme value that only formats.
  return new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day ? day : null;
}

/**
 * Group the vendor's weekly star history into a cumulative UTC-day series.
 *
 * Weeks arrive newest first and are reversed here, so the running total is built
 * forwards from the repository's first star. As with the listing this replaces, a
 * day with no new star produces no row: the series says the level on the days it
 * was observed to change, and the days between are a gap rather than a repeated
 * value. A week whose start is not a UTC midnight is skipped and reported, because
 * its day counts cannot be placed on calendar days this archive can name.
 * @param {StarWeek[]} weeks Weeks as GitHub serves them, newest first.
 * @returns {{days: Array<{day: string, value: number}>, unalignedWeeks: number}}
 */
export function cumulativeStarDays(weeks) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  let unalignedWeeks = 0;
  const ordered = [...weeks].sort((left, right) => left.week - right.week);
  let previous = -1;
  for (const week of ordered) {
    const start = utcWeekStart(week.week);
    if (start === null) {
      unalignedWeeks += 1;
      continue;
    }
    // Two entries for the same week would double-count it; the vendor does not send
    // them, and a duplicate is a contract failure rather than a second reading.
    if (week.week === previous) {
      throw new TypeError(`Star history repeats the week starting ${start}`);
    }
    previous = week.week;
    const midnight = Date.parse(`${start}T00:00:00.000Z`) / 1000;
    for (let offset = 0; offset < DAYS_PER_WEEK; offset += 1) {
      const stars = /** @type {number} */ (week.days[offset]);
      if (stars === 0) continue;
      const day = new Date((midnight + offset * SECONDS_PER_DAY) * 1000).toISOString().slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + stars);
    }
  }
  const days = [...counts.keys()].sort();
  let total = 0;
  return {
    days: days.map((day) => {
      total += /** @type {number} */ (counts.get(day));
      return { day, value: total };
    }),
    unalignedWeeks,
  };
}

/**
 * First-connect star-history backfill. Consumes every week GitHub serves, groups
 * the per-day counts by UTC day, and upserts cumulative rows with
 * source = backfill. Re-running over the same input converges to the same rows; a
 * repository with no stars writes no rows and is not an error.
 *
 * Never writes clones, views, referrers or popular paths, and never invents days
 * before the first star. A week GitHub did not align to UTC, or a series the vendor
 * page cap cut short, is reported rather than written as though it were complete.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.repo owner/name pair
 * @param {{starHistory: (repo: string, onPage: (weeks: StarWeek[], page: number, endpoint: string) => void | Promise<void>) => Promise<{pages: number, weeks: number, truncated: boolean}>}} options.starsClient
 * @param {string} options.collectedAt canonical UTC ISO timestamp
 * @returns {Promise<{pages: number, weeks: number, rows: number, truncated: boolean, unalignedWeeks: number}>}
 */
export async function backfillStars({ db, repositoryId, repo, starsClient, collectedAt }) {
  assertTimestamp(collectedAt);
  assertRepository(db, repositoryId);
  /** @type {StarWeek[]} */
  const weeks = [];
  const summary = await starsClient.starHistory(repo, (pageWeeks) => {
    for (const week of pageWeeks) weeks.push(week);
  });
  const { days, unalignedWeeks } = cumulativeStarDays(weeks);
  for (const { day, value } of days) {
    upsertDayFact(db, { repositoryId, metric: STARS_METRIC, granularity: STARS_GRANULARITY,
      day, value, source: STARS_SOURCE, collectedAt });
  }
  return {
    pages: summary.pages,
    weeks: summary.weeks,
    rows: days.length,
    truncated: summary.truncated,
    unalignedWeeks,
  };
}