import { assertRepository, assertTimestamp } from '../db/ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */

/**
 * The reserved record kind carrying the collection boundary. Provenance evidence
 * is recorded in the archive's existing append-only `backfill_records` table
 * rather than in a new table or column, so this task adds no migration. The kind
 * is a stamp rather than a backfill, so it is excluded from the reported
 * backfill list.
 */
export const FIRST_COLLECTED_KIND = 'first-collected';
export const CONNECTED = /** @type {const} */ ('connected');
export const NOT_CONNECTED = /** @type {const} */ ('not-connected');

/**
 * @typedef {object} BackfillCompletion
 * @property {string} kind Recorded backfill kind, never the boundary stamp.
 * @property {string|null} windowFrom First day the backfill actually observed.
 * @property {string|null} windowTo Last day the backfill actually observed.
 * @property {boolean} truncated Whether the recorded window was shorter than a year.
 * @property {string} collectedAt Canonical UTC ISO time the backfill completed.
 */

/**
 * @typedef {object} Provenance
 * @property {'connected'|'not-connected'} state not-connected until a collection has been stamped.
 * @property {string|null} firstCollectedDay First day collected data exists, null while not connected.
 * @property {string|null} firstCollectedAt When that first collection was recorded.
 * @property {boolean} connectedToday Whether the first collected day is the reference day.
 * @property {boolean} backfillCompleted Whether any backfill record exists for the repository.
 * @property {string[]} backfillKinds Sorted kinds that completed, without the boundary stamp.
 * @property {string|null} backfillCompletedAt Most recent recorded backfill completion time.
 * @property {BackfillCompletion[]} backfills Latest recorded completion per kind, sorted by kind.
 */

/** @typedef {{kind: string, windowFrom: string|null, windowTo: string|null, truncated: number, collectedAt: string}} BackfillRow */
/** @typedef {{day: string, collectedAt: string}} StampRow */

/**
 * Validate a real UTC calendar day. The boundary is a calendar day, never a
 * timestamp, so no host timezone is inferred from it.
 * @param {string} day
 * @returns {void}
 */
function assertIsoDay(day) {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(time)
      || new Date(time).toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid boundary day; supply a real UTC date in YYYY-MM-DD form');
  }
}

/**
 * Record the first day collected data exists for a repository. A collection run
 * calls this with the day it wrote its first fact; the day is supplied, never
 * derived from stored metric rows. The insert is a single conditional statement,
 * so the boundary is stamped exactly once and a later run cannot move it; the
 * archive's append-only guard then makes the stamped day impossible to rewrite
 * or remove.
 * @param {Database} db
 * @param {number} repositoryId
 * @param {{day: string, collectedAt: string}} input observed first collected day and its canonical UTC time
 * @returns {{day: string, stamped: boolean}} the day in force and whether this call wrote it
 */
export function stampFirstCollected(db, repositoryId, input) {
  assertIsoDay(input.day);
  assertTimestamp(input.collectedAt);
  assertRepository(db, repositoryId);
  const result = db.prepare(`INSERT INTO backfill_records
      (repository_id, kind, window_from, window_to, truncated, collected_at)
    SELECT ?, ?, ?, ?, 0, ?
    WHERE NOT EXISTS (SELECT 1 FROM backfill_records WHERE repository_id=? AND kind=?)`)
    .run(repositoryId, FIRST_COLLECTED_KIND, input.day, input.day, input.collectedAt,
      repositoryId, FIRST_COLLECTED_KIND);
  if (result.changes === 1) return { day: input.day, stamped: true };
  const existing = /** @type {StampRow} */ (/** @type {unknown} */ (db.prepare(
    `SELECT window_from AS day, collected_at AS collectedAt FROM backfill_records
     WHERE repository_id=? AND kind=? ORDER BY id LIMIT 1`).get(repositoryId, FIRST_COLLECTED_KIND)));
  return { day: existing.day, stamped: false };
}

/**
 * The single provenance read the dashboard labels from. It reports recorded
 * facts only: the boundary comes from the stamp and never from the earliest
 * stored row of any metric, a never-collected repository reports not-connected
 * rather than a first day, and backfill completion is read from the recorded
 * backfill entries. A repository with no observations at all still has a
 * provenance record; only an unknown identity is an error.
 * @param {Database} db
 * @param {number} repositoryId
 * @param {{today?: string}} [options] reference UTC day for the connected-today answer
 * @returns {Provenance}
 */
export function readProvenance(db, repositoryId, options = {}) {
  assertRepository(db, repositoryId);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  assertIsoDay(today);

  const stamp = /** @type {StampRow|undefined} */ (/** @type {unknown} */ (db.prepare(
    `SELECT window_from AS day, collected_at AS collectedAt FROM backfill_records
     WHERE repository_id=? AND kind=? ORDER BY id LIMIT 1`).get(repositoryId, FIRST_COLLECTED_KIND)));
  const rows = /** @type {BackfillRow[]} */ (/** @type {unknown} */ (db.prepare(
    `SELECT kind, window_from AS windowFrom, window_to AS windowTo, truncated, collected_at AS collectedAt
     FROM backfill_records WHERE repository_id=? AND kind<>? ORDER BY kind, collected_at, id`)
    .all(repositoryId, FIRST_COLLECTED_KIND)));

  // Rows arrive ordered by kind, oldest completion first, so the last row per kind is the one in force.
  /** @type {Map<string, BackfillCompletion>} */
  const latest = new Map();
  for (const row of rows) {
    latest.set(row.kind, { kind: row.kind, windowFrom: row.windowFrom, windowTo: row.windowTo,
      truncated: row.truncated === 1, collectedAt: row.collectedAt });
  }
  const backfills = [...latest.values()]
    .sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));

  let backfillCompletedAt = /** @type {string|null} */ (null);
  for (const backfill of backfills) {
    if (backfillCompletedAt === null || backfill.collectedAt > backfillCompletedAt) {
      backfillCompletedAt = backfill.collectedAt;
    }
  }

  const firstCollectedDay = stamp?.day ?? null;
  return {
    state: /** @type {'connected'|'not-connected'} */ (firstCollectedDay === null ? NOT_CONNECTED : CONNECTED),
    firstCollectedDay,
    firstCollectedAt: stamp?.collectedAt ?? null,
    connectedToday: firstCollectedDay !== null && firstCollectedDay === today,
    backfillCompleted: backfills.length > 0,
    backfillKinds: backfills.map((backfill) => backfill.kind),
    backfillCompletedAt,
    backfills,
  };
}