import { upsertDayFact } from '../db/day-series-repo.js';
import { appendBackfillRecord, assertRepository, assertTimestamp } from '../db/ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../github/stats-client.js').ParticipationResult} ParticipationResult */
/** @typedef {import('../github/stats-client.js').CommitActivityResult} CommitActivityResult */

export const COMMIT_ACTIVITY_METRIC = 'commit-activity';
export const OWNER_PARTICIPATION_METRIC = 'owner-participation';
export const DEVELOPMENT_GRANULARITY = /** @type {const} */ ('week');
export const DEVELOPMENT_SOURCE = /** @type {const} */ ('backfill');
export const DEVELOPMENT_KIND = 'development';
export const EXPECTED_WEEKS = 52;

/**
 * Group one weekly statistics result into week rows. The commit-activity
 * endpoint stamps every week with its week-start Unix seconds, so the stored
 * day is that week start; values are the endpoint's weekly totals. Unknown
 * entry fields pass through untouched; only `week` and `total` are read.
 * A retryable 202 has already been handed to the shared retry policy upstream;
 * here it surfaces as a retryable outcome, never as data or a failure.
 * @param {CommitActivityResult} result
 * @returns {{kind: 'data', weeks: Array<{day: string, value: number}>} | {kind: 'empty'} | {kind: 'retryable', status: number}}
 */
export function commitActivityWeeks(result) {
  if (result.kind === 'retryable') return { kind: 'retryable', status: result.status };
  if (result.kind === 'no-statistics-yet') return { kind: 'empty' };
  return {
    kind: 'data',
    weeks: result.weeks.map((entry, index) => {
      if (typeof entry.week !== 'number' || !Number.isSafeInteger(entry.week) || entry.week < 0
          || typeof entry.total !== 'number' || !Number.isSafeInteger(entry.total) || entry.total < 0) {
        throw new TypeError(`Commit activity week ${index} must carry non-negative integer week and total`);
      }
      return { day: new Date(entry.week * 1000).toISOString().slice(0, 10), value: entry.total };
    }),
  };
}

/**
 * The participation contract carries bare weekly counts with no timestamps,
 * so owner rows are anchored positionally to the commit-activity week starts.
 * A position missing from either series produces no row: nothing is padded,
 * carried forward or estimated.
 * @param {ParticipationResult} result
 * @param {string[]} weekStarts
 * @returns {{kind: 'data', rows: Array<{day: string, value: number}>} | {kind: 'empty'} | {kind: 'retryable', status: number}}
 */
export function ownerParticipationRows(result, weekStarts) {
  if (result.kind === 'retryable') return { kind: 'retryable', status: result.status };
  if (result.kind === 'no-statistics-yet') return { kind: 'empty' };
  return {
    kind: 'data',
    rows: result.owner.slice(0, weekStarts.length).map((value, index) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('Owner participation counts must be non-negative integers');
      }
      return { day: weekStarts[index], value };
    }),
  };
}

/**
 * First-connect development-activity backfill. Fetches the weekly commit
 * activity and owner participation through the statistics client, maps both
 * to week-granularity day-series rows stamped source = backfill, and records
 * a backfill entry naming the window that was actually available with a
 * truncated flag whenever fewer than 52 weeks came back. A 202 that never
 * resolved through the retry policy yields no rows and no record; an empty
 * series yields no rows but still records the entry. No acquisition metric
 * is ever written.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.repo owner/name pair
 * @param {{commitActivity: (repo: string) => Promise<CommitActivityResult>, participation: (repo: string) => Promise<ParticipationResult>}} options.statsClient
 * @param {string} options.collectedAt canonical UTC ISO timestamp
 * @returns {Promise<{kind: 'data' | 'empty' | 'retryable', weeks: number, rows: number, truncated: boolean, windowFrom: string | null, windowTo: string | null}>}
 */
export async function backfillDevelopment({ db, repositoryId, repo, statsClient, collectedAt }) {
  assertTimestamp(collectedAt);
  assertRepository(db, repositoryId);
  const commitActivity = await statsClient.commitActivity(repo);
  const participation = await statsClient.participation(repo);

  const commit = commitActivityWeeks(commitActivity);
  if (commit.kind === 'retryable') return { kind: commit.kind, weeks: 0, rows: 0, truncated: false, windowFrom: null, windowTo: null };
  const weekStarts = commit.kind === 'data' ? commit.weeks.map((week) => week.day) : [];
  const owner = ownerParticipationRows(participation, weekStarts);
  if (owner.kind === 'retryable') return { kind: owner.kind, weeks: 0, rows: 0, truncated: false, windowFrom: null, windowTo: null };

  const commitRows = commit.kind === 'data' ? commit.weeks : [];
  const ownerRows = owner.kind === 'data' ? owner.rows : [];
  for (const { day, value } of commitRows) {
    upsertDayFact(db, { repositoryId, metric: COMMIT_ACTIVITY_METRIC, granularity: DEVELOPMENT_GRANULARITY,
      day, value, source: DEVELOPMENT_SOURCE, collectedAt });
  }
  for (const { day, value } of ownerRows) {
    upsertDayFact(db, { repositoryId, metric: OWNER_PARTICIPATION_METRIC, granularity: DEVELOPMENT_GRANULARITY,
      day, value, source: DEVELOPMENT_SOURCE, collectedAt });
  }

  const windows = commitRows.map((week) => week.day).sort();
  const windowFrom = windows[0] ?? null;
  const windowTo = windows[windows.length - 1] ?? null;
  const truncated = commitRows.length < EXPECTED_WEEKS;
  appendBackfillRecord(db, { repositoryId, kind: DEVELOPMENT_KIND, windowFrom, windowTo, truncated, collectedAt });
  return {
    kind: commitRows.length === 0 && ownerRows.length === 0 ? 'empty' : 'data',
    weeks: commitRows.length,
    rows: commitRows.length + ownerRows.length,
    truncated,
    windowFrom,
    windowTo,
  };
}
