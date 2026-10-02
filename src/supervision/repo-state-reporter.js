import { appendError, getRepository, upsertRepository, withTransaction } from '../db/ops-repo.js';
import { classifyFailure, needsReauthentication } from './errors.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('./errors.js').FailureKind} FailureKind */
/** @typedef {import('./errors.js').EndpointType} EndpointType */

/**
 * Per-repository error state.
 *
 * This step decides *what a failure was* and writes that decision down; it never
 * decides whether a run continues, never retries, and never touches a stored
 * observation. The collector owns isolation and the decision to carry on to the
 * next repository, which is why the whole surface is a recorder a caller can call
 * from inside its own failure boundary without importing the classifier's
 * internals: `recordFailure` classifies, `recordSuccess` records a success, and
 * both return the state they wrote.
 *
 * Supervision state is written here and only here, never inferred from the
 * presence or absence of stored data. A repository nobody has ever failed has no
 * error row and a zero counter; that is a recorded "nothing has gone wrong", not
 * an absence of evidence about a failure that happened.
 *
 * Both writes are synchronous, so a caller that already holds a per-repository
 * transaction composes this step inside it: an open transaction is reused, and
 * the error row and the counter commit or roll back together with the rest of
 * that repository's write. With no transaction open the step opens its own, so a
 * counter can never advance without its evidence, and vice versa.
 */

/**
 * @typedef {object} RecordedFailure
 * @property {number} repositoryId Archive identity the state was recorded against.
 * @property {string|null} repo `owner/name` the caller was collecting, when it named one.
 * @property {FailureKind} kind Exactly one of the six kinds.
 * @property {number|null} status HTTP status the failure carried, or null.
 * @property {string} message The single line stored as evidence and printed by `collect`.
 * @property {string} action The next step, as its own sentence.
 * @property {boolean} needsReauthentication True when only a new token leaves this state.
 * @property {number} consecutiveFailures The counter after this failure was recorded.
 * @property {string} recordedAt Canonical UTC ISO timestamp of this failure.
 */

/**
 * @typedef {object} RecordedSuccess
 * @property {number} repositoryId
 * @property {number} consecutiveFailures Always zero after a success: the streak is broken.
 * @property {string} lastSuccessAt Canonical UTC ISO timestamp of this success.
 */

/**
 * @typedef {object} RecordedErrorRow
 * @property {string} runId Run the failure belongs to.
 * @property {FailureKind} kind The kind recorded at the time.
 * @property {string} message The message recorded at the time.
 * @property {string} recordedAt Canonical UTC ISO timestamp of the failure.
 */

/**
 * Run a write as one unit, joining the caller's transaction when one is already
 * open and opening its own when none is. A nested `BEGIN` is refused by SQLite, so
 * the check is what lets this step be composed into a caller's transaction.
 * @template T
 * @param {Database} db
 * @param {() => T} body Synchronous, write-only.
 * @returns {T}
 */
function inTransaction(db, body) {
  return db.isTransaction ? body() : withTransaction(db, body);
}

/**
 * Record one failure against a repository: the classification, the message and the
 * time as append-only evidence, and the consecutive-failure count raised by one.
 *
 * The counter is read and written inside one unit, so a second failure reports
 * two. Nothing is deleted, rewritten or replaced here: an earlier failure keeps
 * its own row, and the previous message stays readable, because a repository
 * whose token was rejected last week is a fact the maintainer may still want.
 *
 * The identity must already be in the archive, because a repository the archive
 * does not hold is a caller error rather than an empty history. The collector
 * registers a repository before its first request, so every failure it records
 * reaches a stored row.
 *
 * This call does not throw for a failed collection and never decides what the run
 * does next; it returns the state it recorded so the caller can report it.
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {number} options.repositoryId Archive identity the failure belongs to.
 * @param {string} options.runId Run the failure belongs to; the journal row already exists.
 * @param {unknown} options.error The thrown value, as the client or policy reported it.
 * @param {string} options.collectedAt Canonical UTC ISO timestamp for this attempt.
 * @param {string|null} [options.repo] `owner/name` the run was collecting.
 * @param {EndpointType|null} [options.endpointType] The caller's endpoint family, when it knows it.
 * @param {readonly string[]} [options.secrets] Values redacted from the recorded message.
 * @returns {RecordedFailure}
 */
export function recordFailure({
  db, repositoryId, runId, error, collectedAt, repo = null, endpointType = null, secrets = [],
}) {
  const classified = classifyFailure(error, { repo, endpointType, secrets });
  const consecutiveFailures = inTransaction(db, () => {
    const stored = getRepository(db, repositoryId);
    const counter = stored.consecutiveFailures + 1;
    appendError(db, {
      repositoryId, runId, kind: classified.kind, message: classified.message, collectedAt,
    });
    upsertRepository(db, {
      id: repositoryId, owner: stored.owner, name: stored.name,
      lastSeenAt: collectedAt, consecutiveFailures: counter,
    });
    return counter;
  });
  return {
    repositoryId,
    repo,
    kind: classified.kind,
    status: classified.status,
    message: classified.message,
    action: classified.action,
    needsReauthentication: classified.needsReauthentication,
    consecutiveFailures,
    recordedAt: collectedAt,
  };
}

/**
 * Record one success against a repository: the counter goes back to zero and the
 * time of the success is recorded.
 *
 * Only the streak is reset. The failure evidence stays, because a repository that
 * needed re-authentication yesterday still carries that history, and a state word
 * is not the same thing as an absence of failures.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.collectedAt Canonical UTC ISO timestamp of this success.
 * @returns {RecordedSuccess}
 */
export function recordSuccess({ db, repositoryId, collectedAt }) {
  inTransaction(db, () => {
    const current = getRepository(db, repositoryId);
    upsertRepository(db, {
      id: repositoryId, owner: current.owner, name: current.name,
      lastSeenAt: collectedAt, lastSuccessAt: collectedAt, consecutiveFailures: 0,
    });
  });
  return { repositoryId, consecutiveFailures: 0, lastSuccessAt: collectedAt };
}

/**
 * The most recent failure recorded for a repository, read back from the evidence
 * rather than reconstructed. The newest row wins by its recorded time and then by
 * insertion order, so a run that recorded two failures keeps the last one.
 * @param {Database} db
 * @param {number} repositoryId
 * @returns {RecordedErrorRow|null} Null when nothing has ever failed, which is not a failure state.
 */
export function latestFailure(db, repositoryId) {
  const row = /** @type {RecordedErrorRow|undefined} */ (/** @type {unknown} */ (db.prepare(`SELECT run_id AS runId,
    kind, message, collected_at AS recordedAt FROM repository_errors
    WHERE repository_id=? ORDER BY collected_at DESC, id DESC LIMIT 1`).get(repositoryId)));
  if (row === undefined) return null;
  return {
    runId: row.runId, kind: row.kind, message: row.message, recordedAt: row.recordedAt,
  };
}

/**
 * Whether a repository's recorded most recent failure is one only a new token
 * leaves. Derived from the recorded row, so a repository that never failed reports
 * false instead of guessing, and a rate limit or a renamed repository does not
 * masquerade as a rejected credential.
 * @param {Database} db
 * @param {number} repositoryId
 * @returns {boolean}
 */
export function needsReauthenticationFor(db, repositoryId) {
  const failure = latestFailure(db, repositoryId);
  return failure === null ? false : needsReauthentication(failure.kind);
}

/**
 * The reporter a collection run composes into its own per-repository failure
 * boundary. It exposes classification and recording only: it has no clock of its
 * own (every call takes the collection instant), no network access, no retry and
 * no opinion about whether the run should continue.
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @returns {{
 *   recordFailure: (input: {repositoryId: number, runId: string, error: unknown,
 *     collectedAt: string, repo?: string|null, endpointType?: EndpointType|null,
 *     secrets?: readonly string[]}) => RecordedFailure,
 *   recordSuccess: (input: {repositoryId: number, collectedAt: string}) => RecordedSuccess,
 * }}
 */
export function createRepoStateReporter({ db }) {
  return Object.freeze({
    recordFailure: (input) => recordFailure({ ...input, db }),
    recordSuccess: (input) => recordSuccess({ ...input, db }),
  });
}
