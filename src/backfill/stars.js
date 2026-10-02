import { upsertDayFact } from '../db/day-series-repo.js';
import { assertRepository, assertTimestamp } from '../db/ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../github/stars-client.js').StargazerEntry} StargazerEntry */

export const STARS_METRIC = 'stars';
export const STARS_GRANULARITY = /** @type {const} */ ('day');
export const STARS_SOURCE = /** @type {const} */ ('backfill');

/**
 * Group raw stargazer entries into a cumulative UTC-day series. Days before the
 * first recorded star are absent, and days with no new star produce no row.
 * Unknown entry fields pass through untouched; only `starred_at` is read.
 * @param {StargazerEntry[]} entries
 * @returns {Array<{day: string, value: number}>}
 */
export function cumulativeStarDays(entries) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`Stargazer entry ${index} must be a record`);
    }
    const starredAt = /** @type {Record<string, unknown>} */ (entry).starred_at;
    if (typeof starredAt !== 'string' || !Number.isFinite(Date.parse(starredAt))) {
      throw new TypeError(`Stargazer entry ${index} must carry a parseable starred_at timestamp`);
    }
    const day = new Date(starredAt).toISOString().slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = [...counts.keys()].sort();
  let total = 0;
  return days.map((day) => {
    total += /** @type {number} */ (counts.get(day));
    return { day, value: total };
  });
}

/**
 * First-connect star-history backfill. Consumes every stargazer page, groups
 * the timestamps by UTC day, and upserts cumulative rows with
 * source = backfill. Re-running over the same input converges to the same
 * rows; a repository with no stars writes no rows and is not an error.
 * Never writes clones, views, referrers or popular paths, and never invents
 * days before the first star.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.repo owner/name pair
 * @param {{stargazerStars: (repo: string, onPage: (entries: StargazerEntry[], page: number, endpoint: string) => void | Promise<void>) => Promise<{pages: number, entries: number}>}} options.starsClient
 * @param {string} options.collectedAt canonical UTC ISO timestamp
 * @returns {Promise<{pages: number, entries: number, rows: number}>}
 */
export async function backfillStars({ db, repositoryId, repo, starsClient, collectedAt }) {
  assertTimestamp(collectedAt);
  assertRepository(db, repositoryId);
  /** @type {StargazerEntry[]} */
  const entries = [];
  const summary = await starsClient.stargazerStars(repo, (pageEntries) => {
    for (const entry of pageEntries) entries.push(entry);
  });
  const rows = cumulativeStarDays(entries);
  for (const { day, value } of rows) {
    upsertDayFact(db, { repositoryId, metric: STARS_METRIC, granularity: STARS_GRANULARITY,
      day, value, source: STARS_SOURCE, collectedAt });
  }
  return { pages: summary.pages, entries: summary.entries, rows: rows.length };
}
