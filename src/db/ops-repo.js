import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/**
 * @typedef {object} Repository
 * @property {number} id Stable GitHub repository identity, not its name.
 * @property {string} owner
 * @property {string} name
 * @property {'active'|'unavailable'} lifecycle
 * @property {string|null} unavailableReason
 * @property {number} enrolled SQLite 0 or 1.
 * @property {string|null} backfillRefusedAt When the first-connect backfill was first refused, or null.
 * @property {string|null} backfillRefusedReason Why it was refused, recorded once and never overwritten.
 * @property {string} lastSeenAt
 * @property {string|null} lastSuccessAt
 * @property {number} consecutiveFailures
 */
/** @typedef {Pick<Repository, 'id'|'owner'|'name'|'lastSeenAt'> & Partial<Omit<Repository, 'id'|'owner'|'name'|'lastSeenAt'>>} RepositoryInput */
/** @typedef {{id: string, startedAt: string, closedAt: string|null, status: string, successCount: number, failureCount: number, requestCount: number, durationMs: number|null}} Run */
/** @typedef {{closedAt: string, status: string, successCount: number, failureCount: number, requestCount: number, durationMs: number}} RunCompletion */

const repositoryColumns = `id, owner, name, lifecycle, unavailable_reason AS unavailableReason,
  enrolled, backfill_refused_at AS backfillRefusedAt,
  backfill_refused_reason AS backfillRefusedReason,
  last_seen_at AS lastSeenAt, last_success_at AS lastSuccessAt,
  consecutive_failures AS consecutiveFailures`;

/**
 * Open through the guarded connection and checksum-verified migration runner.
 * The caller owns closing the shared connection; no repository opens a private one.
 * @param {string} [databasePath]
 * @returns {Promise<Database>}
 */
export async function openArchive(databasePath) {
  const db = openDatabase(databasePath);
  try {
    await migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Canonical UTC milliseconds keep collection-time string comparisons chronological.
 * No missing timestamp is defaulted to the current clock.
 * @param {string} value
 * @returns {void}
 */
export function assertTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Invalid collection timestamp; supply a canonical UTC ISO timestamp with milliseconds');
  }
}

/**
 * Unknown identity is an error, not an empty observed history.
 * @param {Database} db
 * @param {number} repositoryId
 */
export function assertRepository(db, repositoryId) {
  if (!db.prepare('SELECT 1 FROM repositories WHERE id=?').get(repositoryId)) {
    throw new Error(`Unknown repository ${repositoryId}; register its stable identity before reading its archive`);
  }
}

/**
 * Commit a caller-selected repository's synchronous writes as one unit. A failure
 * rolls back only this unit; callers choose isolation and never await in the body.
 * Nested transactions are rejected by SQLite before the body runs.
 * @template T
 * @param {Database} db
 * @param {() => T} body
 * @returns {T}
 */
export function withTransaction(db, body) {
  if (body.constructor.name === 'AsyncFunction') {
    throw new Error('Archive transactions must be synchronous; perform network work before starting a transaction');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    if (result && typeof /** @type {{then?: unknown}} */ (result).then === 'function') {
      throw new Error('Archive transaction returned a promise; use a synchronous write-only body');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Read recorded lifecycle and collection health without deriving or guessing state.
 * @param {Database} db
 * @param {number} repositoryId
 * @returns {Repository}
 */
export function getRepository(db, repositoryId) {
  assertRepository(db, repositoryId);
  return /** @type {Repository} */ (/** @type {unknown} */ (db.prepare(
    `SELECT ${repositoryColumns} FROM repositories WHERE id=?`).get(repositoryId)));
}

/**
 * Update identity, lifecycle and enrolment in place, never delete history. Omitted
 * state fields preserve their existing values; explicit null clears nullable state.
 * The caller decides health transitions and whether a rename needs an alias.
 * @param {Database} db
 * @param {RepositoryInput} input
 */
export function upsertRepository(db, input) {
  assertTimestamp(input.lastSeenAt);
  if (input.lastSuccessAt != null) assertTimestamp(input.lastSuccessAt);
  const existing = db.prepare('SELECT 1 FROM repositories WHERE id=?').get(input.id)
    ? getRepository(db, input.id) : null;
  const row = { lifecycle: 'active', unavailableReason: null, enrolled: 0,
    lastSuccessAt: null, consecutiveFailures: 0, ...existing, ...input };
  db.prepare(`INSERT INTO repositories
    (id, owner, name, lifecycle, unavailable_reason, enrolled, backfill_refused_at,
      backfill_refused_reason, last_seen_at, last_success_at, consecutive_failures)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, name=excluded.name,
      lifecycle=excluded.lifecycle, unavailable_reason=excluded.unavailable_reason,
      enrolled=excluded.enrolled, backfill_refused_at=excluded.backfill_refused_at,
      backfill_refused_reason=excluded.backfill_refused_reason,
      last_seen_at=excluded.last_seen_at,
      last_success_at=excluded.last_success_at, consecutive_failures=excluded.consecutive_failures`)
    .run(row.id, row.owner, row.name, row.lifecycle, row.unavailableReason, row.enrolled,
      row.backfillRefusedAt ?? null, row.backfillRefusedReason ?? null,
      row.lastSeenAt, row.lastSuccessAt, row.consecutiveFailures);
}

/**
 * Insert an alias once; a repeated alias never rewrites its original recorded time.
 * @param {Database} db
 * @param {{repositoryId: number, owner: string, name: string, recordedAt: string}} alias
 */
export function upsertAlias(db, alias) {
  assertTimestamp(alias.recordedAt);
  return db.prepare(`INSERT INTO repository_aliases (repository_id, owner, name, recorded_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(repository_id, owner, name) DO NOTHING`)
    .run(alias.repositoryId, alias.owner, alias.name, alias.recordedAt);
}

/**
 * List precisely enrolled identities, including unavailable ones and their recorded
 * health. Scheduling eligibility is the caller's decision, not this read's policy.
 * @param {Database} db
 * @returns {Repository[]}
 */
export function listEnrolledRepositories(db) {
  return /** @type {Repository[]} */ (/** @type {unknown} */ (db.prepare(
    `SELECT ${repositoryColumns} FROM repositories WHERE enrolled=1 ORDER BY id`).all()));
}

/**
 * Append the run at start; duplicate identifiers fail rather than replacing a journal.
 * @param {Database} db
 * @param {{id: string, startedAt: string}} run
 */
export function appendRun(db, run) {
  assertTimestamp(run.startedAt);
  return db.prepare('INSERT INTO runs (id, started_at) VALUES (?, ?)').run(run.id, run.startedAt);
}

/**
 * Read the recorded journal, preserving unfinished runs as closedAt=null.
 * @param {Database} db
 * @param {string} id
 * @returns {Run|undefined}
 */
export function getRun(db, id) {
  return /** @type {Run|undefined} */ (/** @type {unknown} */ (db.prepare(`SELECT id,
    started_at AS startedAt, closed_at AS closedAt, status, success_count AS successCount,
    failure_count AS failureCount, request_count AS requestCount, duration_ms AS durationMs
    FROM runs WHERE id=?`).get(id)));
}

/**
 * Close the existing run without changing its original start time or inserting a new
 * journal. A missing or already closed run is rejected rather than silently ignored.
 * @param {Database} db
 * @param {string} id
 * @param {RunCompletion} completion
 */
export function completeRun(db, id, completion) {
  assertTimestamp(completion.closedAt);
  const result = db.prepare(`UPDATE runs SET closed_at=?, status=?, success_count=?,
    failure_count=?, request_count=?, duration_ms=? WHERE id=? AND closed_at IS NULL`)
    .run(completion.closedAt, completion.status, completion.successCount, completion.failureCount,
      completion.requestCount, completion.durationMs, id);
  if (result.changes !== 1) throw new Error(`Run ${id} is missing or already closed; append a new run at start`);
}

/**
 * Append failure evidence with its run and observed time; no health policy is inferred.
 * @param {Database} db
 * @param {{repositoryId: number, runId: string, kind: string, message: string, collectedAt: string}} error
 */
export function appendError(db, error) {
  assertTimestamp(error.collectedAt);
  return db.prepare(`INSERT INTO repository_errors (repository_id, run_id, kind, message, collected_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(error.repositoryId, error.runId, error.kind, error.message, error.collectedAt);
}

/**
 * Append one heartbeat at run start; repeated starts cannot overwrite journal evidence.
 * @param {Database} db
 * @param {{runId: string, startedAt: string, collectedAt: string}} heartbeat
 */
export function appendHeartbeat(db, heartbeat) {
  assertTimestamp(heartbeat.startedAt);
  assertTimestamp(heartbeat.collectedAt);
  return db.prepare('INSERT INTO heartbeats (run_id, started_at, collected_at) VALUES (?, ?, ?)')
    .run(heartbeat.runId, heartbeat.startedAt, heartbeat.collectedAt);
}

/**
 * Record heartbeat progress or closure without changing its start; older/equal ticks
 * and closed heartbeats cannot overwrite newer evidence. No clock default is used.
 * @param {Database} db
 * @param {string} runId
 * @param {{collectedAt: string, completedRepositories: number, closedAt?: string|null}} progress
 */
export function updateHeartbeat(db, runId, progress) {
  assertTimestamp(progress.collectedAt);
  if (progress.closedAt != null) assertTimestamp(progress.closedAt);
  const result = db.prepare(`UPDATE heartbeats SET collected_at=?, completed_repositories=?, closed_at=?
    WHERE run_id=? AND collected_at < ? AND closed_at IS NULL`)
    .run(progress.collectedAt, progress.completedRepositories, progress.closedAt ?? null, runId, progress.collectedAt);
  if (result.changes !== 1) {
    throw new Error(`Heartbeat ${runId} is missing, closed or not older; append its start or supply a newer tick`);
  }
}

/**
 * Append the actually available backfill window; repeated completions coexist, and
 * an unavailable window remains null rather than being padded to a presumed year.
 * @param {Database} db
 * @param {{repositoryId: number, kind: string, windowFrom?: string|null, windowTo?: string|null, truncated: boolean, collectedAt: string}} record
 */
export function appendBackfillRecord(db, record) {
  assertTimestamp(record.collectedAt);
  return db.prepare(`INSERT INTO backfill_records
    (repository_id, kind, window_from, window_to, truncated, collected_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(record.repositoryId, record.kind, record.windowFrom ?? null, record.windowTo ?? null,
      record.truncated ? 1 : 0, record.collectedAt);
}
