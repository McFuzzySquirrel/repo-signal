import { randomUUID } from 'node:crypto';

import {
  appendHeartbeat, appendRun, completeRun, getRepository, updateHeartbeat, withTransaction,
} from '../db/ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../db/ops-repo.js').Repository} Repository */

/**
 * The run journal and the heartbeat that runs beside it.
 *
 * A collection run is supervised by two rows: the run row, which is appended before
 * the first request and only ever closed at the end, and the heartbeat, which records
 * how far the run has got. Appending the run row at the start is what makes a run that
 * never finished detectable from the archive alone - a row written only at completion
 * cannot say anything about the run that never got there - so an abandoned run is a
 * recorded state a later read reports, not a silence someone has to interpret.
 *
 * Everything here is recorded, never inferred. Stall comes from the last successful
 * collection the archive already stores and from an injected clock, never from a file
 * timestamp, a row count or the absence of pages; a repository nobody has ever
 * collected successfully is never reported stalled, because "never collected" is its
 * own state. The module embeds no timer, retries nothing, classifies no failure and
 * decides nothing about whether a run continues: the run owns that, and it composes
 * this step by opening the journal before its first request and closing it after the
 * last.
 */

/** The word a run row carries between its start and its closure; the schema's own default. */
export const RUN_STATUS_RUNNING = /** @type {const} */ ('running');

/**
 * A repository whose last successful collection is *older* than this is stalled. A
 * daily schedule that has missed one slot is the signal worth showing; the value is
 * exported because it is a decision, not a constant of nature. The comparison is
 * strict, so a success exactly at the threshold is still healthy.
 */
export const STALL_THRESHOLD_HOURS = 26;
export const STALL_THRESHOLD_MS = STALL_THRESHOLD_HOURS * 60 * 60 * 1000;

/**
 * Why a progress tick was not recorded. The archive refuses to move a heartbeat to the
 * instant it already holds or to an earlier one, so a tick can only be written when the
 * clock actually advanced; when it did not, the tick is reported as unrecorded instead
 * of being written as if it had been observed.
 */
export const TICK_NOT_RECORDED_CLOCK = /** @type {const} */ ('clock-did-not-advance');

/** What a repository's recorded collection state says about it. */
export const STALL_NEVER_COLLECTED = /** @type {const} */ ('never-collected');
export const STALL_HEALTHY = /** @type {const} */ ('healthy');
export const STALL_STALLED = /** @type {const} */ ('stalled');
/** A stored success time that cannot be read is an unknown state, never a stall. */
export const STALL_UNREADABLE = /** @type {const} */ ('unreadable');

/**
 * @typedef {'healthy'|'stalled'|'never-collected'|'unreadable'} StallWord
 */

/**
 * @typedef {object} JournalTick
 * @property {boolean} recorded Whether the archive now holds this progress.
 * @property {string} at The instant the tick carried, from the injected clock.
 * @property {number} completedRepositories Repositories the run had finished at this tick.
 * @property {string|null} reason Why the tick was not recorded, or null when it was.
 */

/**
 * @typedef {object} JournalStart
 * @property {string} runId Identifier written to the run row.
 * @property {string} startedAt Canonical UTC ISO instant the run began.
 * @property {number} startedAtMs The same instant as epoch milliseconds.
 */

/**
 * @typedef {object} JournalClosure
 * @property {string} runId
 * @property {string} status Status word written to the run row.
 * @property {string} closedAt Canonical UTC ISO instant the run closed.
 * @property {number} durationMs Measured from the recorded start, never negative.
 * @property {number} completedRepositories Repositories the run finished.
 * @property {JournalTick} heartbeat What the heartbeat recorded as it closed.
 */

/**
 * @typedef {object} RunJournal
 * @property {string|null} runId Identifier this journal writes, or null when it generates one.
 * @property {() => JournalStart} start Append the run row and its heartbeat before the first request.
 * @property {(progress: {completedRepositories: number}) => JournalTick} progress Record how far the run has got.
 * @property {(closure: {status: string, successCount: number, failureCount: number,
 *   requestCount: number, completedRepositories: number}) => JournalClosure} close
 */

/**
 * @typedef {object} JournalEntry
 * @property {string} runId
 * @property {string} startedAt
 * @property {string|null} closedAt Null for a run that never closed.
 * @property {string} status `running` while open; the run's own status word once closed.
 * @property {number} successCount
 * @property {number} failureCount
 * @property {number} requestCount
 * @property {number|null} durationMs Null while the run is open.
 * @property {boolean} open True when the run was never closed.
 * @property {number} completedRepositories Repositories the heartbeat last recorded; 0 when none did.
 * @property {string|null} lastProgressAt The heartbeat's last recorded tick, or null when none was.
 * @property {string|null} heartbeatClosedAt When the heartbeat closed, or null while it is open.
 */

/**
 * @typedef {object} RepositoryStallState
 * @property {number} repositoryId
 * @property {StallWord} state The word the recorded state reports.
 * @property {boolean} stalled True only for `stalled`; never inferred from missing data.
 * @property {string|null} lastSuccessAt The recorded last successful collection, or null.
 * @property {number|null} elapsedMs Milliseconds since that success, or null when there is none.
 */

/** @param {number} value @param {string} what @returns {number} */
function assertCount(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`A run journal needs a non-negative ${what} count`);
  }
  return value;
}

/**
 * An identifier that names the instant the run began, so a journal read can be ordered
 * by eye as well as by column.
 * @param {number} nowMs
 * @returns {string}
 */
export function nextRunId(nowMs) {
  return `collect-${new Date(nowMs).toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
}

/**
 * Open the journal for one run. The returned object is the whole supervision surface a
 * run needs: start before the first request, progress as each repository finishes, close
 * at the end. It holds no clock of its own - every instant comes from the injected one -
 * and performs no request, retry or classification.
 *
 * `runId` may be null, in which case the identifier is derived from the instant the run
 * started, so the journal row and the printed identifier cannot disagree.
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {string|null} [options.runId] Identifier to write, or null to generate one.
 * @param {() => number} [options.clock] Epoch milliseconds; every recorded instant comes from it.
 * @returns {RunJournal}
 */
export function createRunJournal({ db, runId = null, clock = Date.now }) {
  if (runId !== null && (typeof runId !== 'string' || runId.trim() === '')) {
    throw new TypeError('A run journal needs the run identifier it writes, or null to generate one');
  }
  if (typeof clock !== 'function') throw new TypeError('A run journal needs a clock returning epoch milliseconds');
  /** @type {JournalStart|null} */
  let opened = null;
  /**
   * The last instant this journal actually wrote; a tick must be newer than it, because
   * the archive refuses to move a heartbeat to an instant it already holds.
   * @type {number|null}
   */
  let writtenMs = null;

  /**
   * @param {JournalStart|null} run
   * @returns {JournalStart}
   */
  function requireOpen(run) {
    if (run === null) throw new Error('The run journal must be opened before it can record progress or closure');
    return run;
  }

  /**
   * @param {number} atMs Epoch milliseconds from the injected clock.
   * @param {number} completedRepositories
   * @param {string|null} closedAt Set only for the tick that closes the heartbeat.
   * @returns {JournalTick}
   */
  function tick(atMs, completedRepositories, closedAt) {
    if (!Number.isFinite(atMs)) throw new TypeError('The injected clock must return epoch milliseconds');
    const at = new Date(atMs).toISOString();
    if (writtenMs !== null && atMs <= writtenMs) {
      // The archive will not hold two heartbeat ticks at the same instant, and this
      // module will not invent a later one. The unrecorded tick is reported, not faked.
      return { recorded: false, at, completedRepositories, reason: TICK_NOT_RECORDED_CLOCK };
    }
    updateHeartbeat(db, requireOpen(opened).runId, { collectedAt: at, completedRepositories, closedAt });
    writtenMs = atMs;
    return { recorded: true, at, completedRepositories, reason: null };
  }

  return Object.freeze({
    runId,
    start() {
      if (opened !== null) {
        throw new Error(`Run ${opened.runId} is already journalled; a run is opened once and closed once`);
      }
      const startedAtMs = clock();
      if (!Number.isFinite(startedAtMs)) throw new TypeError('The injected clock must return epoch milliseconds');
      const startedAt = new Date(startedAtMs).toISOString();
      const identifier = runId ?? nextRunId(startedAtMs);
      // Both rows commit as one unit, so a run can never be journalled without the
      // heartbeat that says it is in progress, and neither row can be half-written by
      // an interruption between the two writes.
      withTransaction(db, () => {
        appendRun(db, { id: identifier, startedAt });
        appendHeartbeat(db, { runId: identifier, startedAt, collectedAt: startedAt });
      });
      opened = { runId: identifier, startedAt, startedAtMs };
      writtenMs = startedAtMs;
      return opened;
    },
    progress({ completedRepositories }) {
      requireOpen(opened);
      const count = assertCount(completedRepositories, 'completed repositories');
      return tick(clock(), count, null);
    },
    close({ status, successCount, failureCount, requestCount, completedRepositories }) {
      const run = requireOpen(opened);
      if (typeof status !== 'string' || status.trim() === '') {
        throw new TypeError('A run closes with a status word, so a reader is never left guessing');
      }
      const count = assertCount(completedRepositories, 'completed repositories');
      const closedAtMs = clock();
      if (!Number.isFinite(closedAtMs)) throw new TypeError('The injected clock must return epoch milliseconds');
      const closedAt = new Date(closedAtMs).toISOString();
      const durationMs = Math.max(0, closedAtMs - run.startedAtMs);
      // The run row is the journal, so it closes whatever the heartbeat managed to
      // record: a heartbeat left open beside a closed run is visible evidence that the
      // clock did not move, and a finished run never looks abandoned.
      completeRun(db, run.runId, {
        closedAt,
        status,
        successCount: assertCount(successCount, 'success'),
        failureCount: assertCount(failureCount, 'failure'),
        requestCount: assertCount(requestCount, 'request'),
        durationMs,
      });
      return {
        runId: run.runId,
        status,
        closedAt,
        durationMs,
        completedRepositories: count,
        heartbeat: tick(closedAtMs, count, closedAt),
      };
    },
  });
}

const JOURNAL_COLUMNS = `runs.id AS runId, runs.started_at AS startedAt, runs.closed_at AS closedAt,
  runs.status, runs.success_count AS successCount, runs.failure_count AS failureCount,
  runs.request_count AS requestCount, runs.duration_ms AS durationMs,
  heartbeats.collected_at AS lastProgressAt, heartbeats.closed_at AS heartbeatClosedAt,
  heartbeats.completed_repositories AS completedRepositories`;

/**
 * One journalled run, read as the pair of rows it is: the run row and the heartbeat it
 * wrote. The two are read together because a reader asking "did this run finish" needs
 * both halves of the answer, and a heartbeat absent from a run row means the archive
 * holds no progress for it at all rather than progress of zero.
 * @param {Record<string, unknown>} row
 * @returns {JournalEntry}
 */
function journalEntry(row) {
  const closedAt = row.closedAt === null ? null : String(row.closedAt);
  return {
    runId: String(row.runId),
    startedAt: String(row.startedAt),
    closedAt,
    status: String(row.status),
    successCount: Number(row.successCount),
    failureCount: Number(row.failureCount),
    requestCount: Number(row.requestCount),
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    open: closedAt === null,
    completedRepositories: row.completedRepositories === null ? 0 : Number(row.completedRepositories),
    lastProgressAt: row.lastProgressAt === null ? null : String(row.lastProgressAt),
    heartbeatClosedAt: row.heartbeatClosedAt === null ? null : String(row.heartbeatClosedAt),
  };
}

/**
 * Read one run from the journal, whether it closed or not. Null means the archive holds
 * no such run, which is a different answer from an open one.
 * @param {Database} db
 * @param {string} runId
 * @returns {JournalEntry|null}
 */
export function readRunJournal(db, runId) {
  const row = /** @type {Record<string, unknown>|undefined} */ (/** @type {unknown} */ (db.prepare(
    `SELECT ${JOURNAL_COLUMNS} FROM runs LEFT JOIN heartbeats ON heartbeats.run_id = runs.id
      WHERE runs.id = ?`).get(runId)));
  return row === undefined ? null : journalEntry(row);
}

/**
 * Every run the journal holds, newest first. Nothing is filtered: a closed run and an
 * abandoned one are both evidence, and deciding which one matters belongs to the caller.
 * @param {Database} db
 * @returns {JournalEntry[]}
 */
export function listRuns(db) {
  const rows = /** @type {Record<string, unknown>[]} */ (/** @type {unknown} */ (db.prepare(
    `SELECT ${JOURNAL_COLUMNS} FROM runs LEFT JOIN heartbeats ON heartbeats.run_id = runs.id
      ORDER BY runs.started_at DESC, runs.id DESC`).all()));
  return rows.map((row) => journalEntry(row));
}

/**
 * The runs that began and never closed. This is the whole of "a run died silently":
 * readable from the archive alone, with no log, no exit code and no process to inspect.
 * @param {Database} db
 * @returns {JournalEntry[]} Newest first.
 */
export function listUnclosedRuns(db) {
  const rows = /** @type {Record<string, unknown>[]} */ (/** @type {unknown} */ (db.prepare(
    `SELECT ${JOURNAL_COLUMNS} FROM runs LEFT JOIN heartbeats ON heartbeats.run_id = runs.id
      WHERE runs.closed_at IS NULL ORDER BY runs.started_at DESC, runs.id DESC`).all()));
  return rows.map((row) => journalEntry(row));
}

/**
 * Whether a recorded last successful collection is older than the stall threshold.
 * Strictly older: a success exactly at the threshold is still healthy, because one late
 * run is not a stopped schedule. A repository with no recorded success is never stalled,
 * since nothing about a schedule can be concluded from a repository that was never
 * collected in the first place.
 * @param {string|null} lastSuccessAt Canonical UTC ISO timestamp, or null for never collected.
 * @param {number} nowMs Epoch milliseconds from the caller's clock.
 * @returns {boolean}
 */
export function isStalledSince(lastSuccessAt, nowMs) {
  if (typeof lastSuccessAt !== 'string') return false;
  const lastSuccessMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) return false;
  return nowMs - lastSuccessMs > STALL_THRESHOLD_MS;
}

/**
 * @param {Repository} stored
 * @param {number} nowMs
 * @returns {RepositoryStallState}
 */
function stallStateOf(stored, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('Stall is decided against an injected clock returning epoch milliseconds');
  }
  const lastSuccessAt = stored.lastSuccessAt;
  if (lastSuccessAt === null || lastSuccessAt === undefined) {
    return { repositoryId: stored.id, state: STALL_NEVER_COLLECTED, stalled: false, lastSuccessAt: null, elapsedMs: null };
  }
  const lastSuccessMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) {
    // The archive holds a success time this build cannot read. That is an unknown
    // state to report, not evidence of a stopped schedule.
    return { repositoryId: stored.id, state: STALL_UNREADABLE, stalled: false, lastSuccessAt, elapsedMs: null };
  }
  const elapsedMs = Math.max(0, nowMs - lastSuccessMs);
  const stalled = elapsedMs > STALL_THRESHOLD_MS;
  return {
    repositoryId: stored.id,
    state: stalled ? STALL_STALLED : STALL_HEALTHY,
    stalled,
    lastSuccessAt,
    elapsedMs,
  };
}

/**
 * What the archive already recorded says about one repository's collection, judged
 * against the caller's clock: the word for its state, whether it is stalled, the last
 * successful collection it recorded and how long ago that was. A pure read of recorded
 * state with no request, no clock of its own and no inference from what is absent.
 * @param {Database} db Open archive; the caller owns closing it.
 * @param {number} repositoryId
 * @param {number} nowMs Epoch milliseconds from the caller's clock.
 * @returns {RepositoryStallState}
 */
export function repositoryStallState(db, repositoryId, nowMs) {
  return stallStateOf(getRepository(db, repositoryId), nowMs);
}

/**
 * The one-line answer to "has this repository stopped being collected". True only for a
 * repository whose last recorded success is older than the threshold.
 * @param {Database} db
 * @param {number} repositoryId
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isRepositoryStalled(db, repositoryId, nowMs) {
  return repositoryStallState(db, repositoryId, nowMs).stalled;
}