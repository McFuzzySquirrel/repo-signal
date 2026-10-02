import { LIFECYCLE_UNAVAILABLE } from '../collect/lifecycle.js';
import { getRepository, listEnrolledRepositories, openArchive } from '../db/ops-repo.js';
import { resolveHomePaths } from '../paths.js';
import { latestFailure, needsReauthenticationFor } from './repo-state-reporter.js';
import { STALL_THRESHOLD_HOURS, listUnclosedRuns, readRunJournal, repositoryStallState } from './journal.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../db/ops-repo.js').Repository} Repository */
/** @typedef {import('./journal.js').JournalEntry} JournalEntry */
/** @typedef {import('./journal.js').StallWord} StallWord */
/** @typedef {import('./repo-state-reporter.js').RecordedErrorRow} RecordedErrorRow */
/** @typedef {import('./errors.js').FailureKind} FailureKind */

/**
 * The one health read.
 *
 * The dashboard and the CLI both come through here, so the two surfaces cannot
 * disagree about whether collection is working: there is one aggregation, and it
 * reads only what the archive already recorded. It makes no request, holds no
 * credential, embeds no timer and writes nothing - it opens no socket, imports no
 * client, and creates no transport, so it cannot reach GitHub even by accident.
 *
 * Every state here is a named word with a sentence that names it again. That is the
 * whole of RS-AX-07's requirement in this layer: the re-authentication, stalled and
 * empty states travel as text, so a badge, an icon or a colour is something a
 * surface may add and never something the state depends on. The boolean readings
 * beside each word are conveniences for a caller that wants them; they are
 * derived from the same recorded rows and never replace the word.
 *
 * The state is recorded, never inferred from what is missing. A repository with no
 * recorded success is `never-collected`, which is emphatically not `stalled`: a
 * first-connect install has nothing to judge a schedule against, and reporting it
 * as stalled would alarm a maintainer about a repository that has not run yet. A
 * repository nobody ever failed reports zero failures because that is what was
 * recorded, not because no failure row could be found.
 *
 * Where a repository carries more than one true thing - a repository GitHub no
 * longer serves *and* one that stopped being collected 30 hours ago - the named
 * `state` is the single most actionable word in a fixed order, and every other
 * reading stays beside it. Collapsing them would hide one behind the other.
 */

/** The named states a single enrolled repository can report. */
export const REPOSITORY_STATE_HEALTHY = /** @type {const} */ ('healthy');
export const REPOSITORY_STATE_NEVER_COLLECTED = /** @type {const} */ ('never-collected');
export const REPOSITORY_STATE_DEGRADED = /** @type {const} */ ('degraded');
export const REPOSITORY_STATE_NEEDS_REAUTHENTICATION = /** @type {const} */ ('needs-re-authentication');
export const REPOSITORY_STATE_STALLED = /** @type {const} */ ('stalled');
export const REPOSITORY_STATE_UNAVAILABLE = /** @type {const} */ ('unavailable');
/** A recorded collection time this build cannot read: an unknown state, never a stall. */
export const REPOSITORY_STATE_UNREADABLE = /** @type {const} */ ('unreadable');

/**
 * @typedef {'healthy'|'never-collected'|'degraded'|'needs-re-authentication'|'stalled'
 *   |'unavailable'|'unreadable'} RepositoryState
 */

/**
 * Which named state wins when a repository reports more than one. Ordered from the
 * state a maintainer must act on first to the state that only reports progress, so
 * the single word is always the one that has a next step. This order is exported so
 * a surface cannot quietly invent a seventh precedence, and so a test can assert it.
 * @type {readonly RepositoryState[]}
 */
export const REPOSITORY_STATE_PRECEDENCE = Object.freeze([
  REPOSITORY_STATE_UNAVAILABLE,
  REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
  REPOSITORY_STATE_UNREADABLE,
  REPOSITORY_STATE_STALLED,
  REPOSITORY_STATE_DEGRADED,
  REPOSITORY_STATE_NEVER_COLLECTED,
  REPOSITORY_STATE_HEALTHY,
]);

/** The named states the run half of the read can report. */
export const RUN_STATE_NEVER_RUN = /** @type {const} */ ('never-run');
/** A run row that began and never closed: a run in progress and a killed run look alike. */
export const RUN_STATE_UNCLOSED = /** @type {const} */ ('unclosed');
export const RUN_STATE_COMPLETED = /** @type {const} */ ('completed');
export const RUN_STATE_DEGRADED = /** @type {const} */ ('degraded');

/** @typedef {'never-run'|'unclosed'|'completed'|'degraded'} RunState */

/**
 * The roll-up word for a home that has enrolled nothing at all. It is its own state
 * rather than a healthy one, because RS-AX-07 requires the empty case to be
 * announced as text rather than rendered as an absence of rows.
 */
export const SUMMARY_STATE_EMPTY = /** @type {const} */ ('empty');

/** @typedef {RepositoryState|'empty'} SummaryState */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * @param {number} count
 * @param {string} singular
 * @returns {string} `1 <singular>` or `<n> <singular>s`.
 */
function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * How long ago an interval was, in words a person reads. The exact millisecond
 * figure travels beside this in `sinceLastSuccessMs`; this is the sentence a page
 * or a terminal line announces.
 * @param {number} ms
 * @returns {string}
 */
function elapsedText(ms) {
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return 'less than a minute';
  if (ms < HOUR_MS) return plural(Math.floor(ms / MINUTE_MS), 'minute');
  if (ms < DAY_MS) return plural(Math.floor(ms / HOUR_MS), 'hour');
  return plural(Math.floor(ms / DAY_MS), 'day');
}

/**
 * The state word as the sentence that carries it: `never-collected` reads as "never
 * collected", while `needs-re-authentication` reads as "needs re-authentication",
 * because a hyphen inside a word is part of the word and only the separators between
 * words become spaces. Every reason in this module begins with its own state in this
 * form, which is what lets a surface announce the state as text without having to
 * translate the word itself.
 * @param {string} word
 * @returns {string}
 */
export function statePhrase(word) {
  const phrase = /** @type {Record<string, string>} */ (STATE_PHRASES)[word];
  return phrase ?? word.replace(/-/g, ' ');
}

/**
 * States whose words are not simply their hyphenated form. One entry here would be a
 * state whose announced sentence does not contain its own word.
 * @type {Readonly<Record<string, string>>}
 */
const STATE_PHRASES = Object.freeze({
  'needs-re-authentication': 'needs re-authentication',
  'never-run': 'never run',
});

/**
 * The most recent recorded failure, as evidence to show rather than as a verdict.
 * @typedef {object} RepositoryFailure
 * @property {FailureKind} kind The kind the classifier assigned at the time.
 * @property {string} message The one line recorded then, free of credential material.
 * @property {string} recordedAt Canonical UTC ISO instant of the failure.
 * @property {string} runId The run that recorded it.
 */

/**
 * @typedef {object} RepositoryHealth
 * @property {number} repositoryId Stable archive identity, never the name.
 * @property {string} owner
 * @property {string} name
 * @property {string} repo `owner/name` as the archive holds it now.
 * @property {'active'|'unavailable'} lifecycle The archive's own lifecycle word.
 * @property {RepositoryState} state The named state; never a colour and never a bare flag.
 * @property {string} reason One sentence beginning with `state` in words.
 * @property {StallWord} collectionState The journal's own word for the recorded schedule.
 * @property {string|null} lastSuccessAt The recorded last successful collection, or null.
 * @property {number|null} sinceLastSuccessMs Milliseconds since it, or null when never collected.
 * @property {number} consecutiveFailures The recorded streak; zero after a success.
 * @property {boolean} needsReauthentication True only for a recorded failure a new token leaves.
 * @property {boolean} stalled True only for a recorded success older than the threshold.
 * @property {boolean} unavailable The archive's recorded lifecycle word, read back.
 * @property {string|null} unavailableReason Why the archive marked it, when it did.
 * @property {RepositoryFailure|null} lastFailure The most recent recorded failure, or null.
 */

/**
 * @typedef {object} RunHealth
 * @property {RunState} state The named state of the most recent run.
 * @property {string} reason One sentence beginning with `state` in words.
 * @property {string|null} runId The most recent run's identifier, or null when none was ever journalled.
 * @property {string|null} status The status word the run itself recorded, verbatim.
 * @property {string|null} startedAt
 * @property {string|null} closedAt Null while the run is open.
 * @property {number|null} durationMs Null while the run is open.
 * @property {number} successCount
 * @property {number} failureCount
 * @property {number} requestCount
 * @property {string|null} lastProgressAt The heartbeat's last recorded tick.
 * @property {boolean} open Whether that run never closed.
 * @property {number} unclosedRuns How many runs began and never closed, across every run.
 * @property {string|null} unclosedRunId The newest such run, so a dead run can be named.
 */

/**
 * @typedef {object} HealthSummary
 * @property {SummaryState} state The named roll-up state.
 * @property {string} reason One sentence beginning with `state` in words.
 * @property {boolean} needsAttention True when a state a maintainer must act on is present.
 * @property {number} enrolled Repositories the read covered.
 * @property {number} healthy
 * @property {number} neverCollected
 * @property {number} degraded
 * @property {number} needsReauthentication
 * @property {number} stalled
 * @property {number} unavailable
 * @property {number} unreadable
 */

/**
 * @typedef {object} CollectionHealth
 * @property {string} readAt The instant of this read, from the injected clock.
 * @property {RepositoryHealth[]} repositories Enrolled repositories, in the archive's own order.
 * @property {RunHealth} run The most recent run and whether runs are being abandoned.
 * @property {HealthSummary} summary The enrolled-set roll-up.
 */

/**
 * @typedef {object} HealthHomeOptions
 * @property {string} [home] Home directory; resolved from the environment when omitted.
 * @property {NodeJS.ProcessEnv} [env] Environment the home is resolved from.
 * @property {string} [cwd] Working directory a relative home is resolved against.
 * @property {() => number} [clock] Epoch milliseconds; every elapsed figure comes from it.
 */

/**
 * The one-line reason for the most recent failure, appended only when there is one.
 * A counter can only advance beside an evidence row, so the message is present in
 * practice; when it is not, no message is invented and the state stands on its own.
 * @param {RecordedErrorRow|null} failure
 * @returns {string}
 */
function failureClause(failure) {
  if (failure === null) return '';
  return ` the most recent failure was ${failure.kind}: ${failure.message}`;
}

/**
 * Which named state this repository reports, and why in one sentence. The order is
 * the exported precedence: an action a maintainer must take beats a warning about
 * a schedule, and a schedule beats progress.
 * @param {object} reading
 * @param {boolean} reading.unavailable
 * @param {string|null} reading.unavailableReason
 * @param {boolean} reading.needsReauthentication
 * @param {StallWord} reading.collectionState
 * @param {number|null} reading.elapsedMs
 * @param {number} reading.consecutiveFailures
 * @param {RecordedErrorRow|null} reading.lastFailure
 * @returns {{state: RepositoryState, reason: string}}
 */
function describeRepository({ unavailable, unavailableReason, needsReauthentication, collectionState,
  elapsedMs, consecutiveFailures, lastFailure }) {
  const threshold = `${STALL_THRESHOLD_HOURS}-hour`;
  /** @type {RepositoryState} */
  let state = REPOSITORY_STATE_HEALTHY;
  if (unavailable) state = REPOSITORY_STATE_UNAVAILABLE;
  else if (needsReauthentication) state = REPOSITORY_STATE_NEEDS_REAUTHENTICATION;
  else if (collectionState === 'unreadable') state = REPOSITORY_STATE_UNREADABLE;
  else if (collectionState === 'stalled') state = REPOSITORY_STATE_STALLED;
  else if (consecutiveFailures > 0) state = REPOSITORY_STATE_DEGRADED;
  else if (collectionState === 'never-collected') state = REPOSITORY_STATE_NEVER_COLLECTED;

  /** @type {string} */
  let detail;
  switch (state) {
    case REPOSITORY_STATE_UNAVAILABLE:
      detail = unavailableReason === null || unavailableReason === ''
        ? 'the archive marked this repository unavailable without recording a reason'
        : unavailableReason;
      break;
    case REPOSITORY_STATE_NEEDS_REAUTHENTICATION:
      detail = `the stored credential was refused and only a new token leaves this state;${failureClause(lastFailure)}`;
      break;
    case REPOSITORY_STATE_UNREADABLE:
      detail = 'the recorded last successful collection time cannot be read by this build, so the schedule '
        + 'cannot be judged and this is not reported as stalled';
      break;
    case REPOSITORY_STATE_STALLED:
      detail = `the last successful collection was ${elapsedText(elapsedMs ?? 0)} ago, past the ${threshold} `
        + 'threshold, so scheduled collection has stopped';
      break;
    case REPOSITORY_STATE_DEGRADED:
      detail = `${plural(consecutiveFailures, 'collection')} failed in a row;${failureClause(lastFailure)}`;
      break;
    case REPOSITORY_STATE_NEVER_COLLECTED:
      detail = 'no successful collection has been recorded for this repository yet, so there is no schedule '
        + 'to judge and this is not reported as stalled';
      break;
    default:
      detail = `the last collection succeeded ${elapsedText(elapsedMs ?? 0)} ago, inside the ${threshold} `
        + 'threshold, and no failure is outstanding';
      break;
  }
  return { state, reason: `${statePhrase(state)}: ${detail}` };
}

/**
 * Everything the read says about one enrolled repository.
 *
 * It composes the reads the previous supervision steps already own rather than
 * re-deriving their rules: the stall word and the elapsed interval come from the
 * journal's pure `repositoryStallState`, and the last failure and the
 * re-authentication flag come from the reporter's pure reads of recorded evidence.
 * This step decides nothing about collection and writes nothing; it only puts the
 * recorded answers in one object and gives the top one a sentence.
 *
 * The stall threshold is applied by the journal, never recomputed here, so the word
 * a repository carries here is the same word `repositoryStallState` returns.
 * @param {Database} db Open archive; the caller owns closing it.
 * @param {number} repositoryId Stable archive identity.
 * @param {number} nowMs Epoch milliseconds from the caller's clock.
 * @returns {RepositoryHealth}
 */
export function repositoryHealth(db, repositoryId, nowMs) {
  const stored = getRepository(db, repositoryId);
  const schedule = repositoryStallState(db, repositoryId, nowMs);
  const lastFailure = latestFailure(db, repositoryId);
  const needsReauthentication = needsReauthenticationFor(db, repositoryId);
  const unavailable = stored.lifecycle === LIFECYCLE_UNAVAILABLE;
  const { state, reason } = describeRepository({
    unavailable,
    unavailableReason: stored.unavailableReason,
    needsReauthentication,
    collectionState: schedule.state,
    elapsedMs: schedule.elapsedMs,
    consecutiveFailures: stored.consecutiveFailures,
    lastFailure,
  });
  return {
    repositoryId,
    owner: stored.owner,
    name: stored.name,
    repo: `${stored.owner}/${stored.name}`,
    lifecycle: stored.lifecycle,
    state,
    reason,
    collectionState: schedule.state,
    lastSuccessAt: schedule.lastSuccessAt,
    sinceLastSuccessMs: schedule.elapsedMs,
    consecutiveFailures: stored.consecutiveFailures,
    needsReauthentication,
    stalled: schedule.stalled,
    unavailable,
    unavailableReason: stored.unavailableReason,
    lastFailure: lastFailure === null ? null : {
      kind: lastFailure.kind,
      message: lastFailure.message,
      recordedAt: lastFailure.recordedAt,
      runId: lastFailure.runId,
    },
  };
}

/**
 * The run half of the read: the most recent run, whether it closed, and whether
 * any run in the archive began and never did.
 *
 * A home that has never run is not an error and not an absence of pages: it reports
 * `never-run` with every field at its neutral value, so a first-connect install gets
 * the same shape as an install with a year of history behind it. An unclosed run is
 * reported as `unclosed` rather than as `running`, because the archive cannot tell
 * a run in progress from a process that was killed, and claiming the first would
 * hide the second.
 * @param {Database} db Open archive; the caller owns closing it.
 * @returns {RunHealth}
 */
export function runHealth(db) {
  const newest = /** @type {{id: string}|undefined} */ (/** @type {unknown} */ (db.prepare(
    'SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT 1').get()));
  const unclosed = listUnclosedRuns(db);
  /** @type {JournalEntry|null} */
  const entry = newest === undefined ? null : readRunJournal(db, newest.id);
  const unclosedRunId = unclosed.length === 0 ? null : /** @type {string} */ (unclosed[0].runId);

  if (entry === null) {
    return {
      state: RUN_STATE_NEVER_RUN,
      reason: `${statePhrase(RUN_STATE_NEVER_RUN)}: the archive holds no run record, so no collection has been `
        + 'attempted from this home yet',
      runId: null,
      status: null,
      startedAt: null,
      closedAt: null,
      durationMs: null,
      successCount: 0,
      failureCount: 0,
      requestCount: 0,
      lastProgressAt: null,
      open: false,
      unclosedRuns: 0,
      unclosedRunId: null,
    };
  }

  /** @type {RunState} */
  let state = RUN_STATE_COMPLETED;
  if (entry.open) state = RUN_STATE_UNCLOSED;
  else if (entry.failureCount > 0) state = RUN_STATE_DEGRADED;

  /** @type {string} */
  let detail;
  if (state === RUN_STATE_UNCLOSED) {
    detail = `run ${entry.runId} began at ${entry.startedAt} and never closed; a run still in progress and a run `
      + 'whose process was killed leave the same record behind';
  } else if (state === RUN_STATE_DEGRADED) {
    detail = `run ${entry.runId} closed at ${entry.closedAt} with ${plural(entry.successCount, 'repository')} `
      + `collected and ${plural(entry.failureCount, 'failure')}`;
  } else {
    detail = `run ${entry.runId} closed at ${entry.closedAt} after ${elapsedText(entry.durationMs ?? 0)} with `
      + `${plural(entry.successCount, 'repository')} collected and no failure recorded`;
  }
  return {
    state,
    reason: `${statePhrase(state)}: ${detail}`,
    runId: entry.runId,
    status: entry.status,
    startedAt: entry.startedAt,
    closedAt: entry.closedAt,
    durationMs: entry.durationMs,
    successCount: entry.successCount,
    failureCount: entry.failureCount,
    requestCount: entry.requestCount,
    lastProgressAt: entry.lastProgressAt,
    open: entry.open,
    unclosedRuns: unclosed.length,
    unclosedRunId,
  };
}

/**
 * The enrolled-set roll-up: one named state and one sentence for the whole home,
 * plus the count behind each state so a surface can show the breakdown without
 * counting it again. The word is the repository precedence applied across the set,
 * so the state a maintainer must act on is never averaged away by the repositories
 * that are fine. An install with nothing enrolled reports `empty` rather than
 * `healthy`, because there is no healthy collection to report.
 * @param {RepositoryHealth[]} repositories
 * @returns {HealthSummary}
 */
export function summariseHealth(repositories) {
  /** @type {Record<SummaryState, number>} */
  const counts = {
    healthy: 0, 'never-collected': 0, degraded: 0, 'needs-re-authentication': 0,
    stalled: 0, unavailable: 0, unreadable: 0, empty: 0,
  };
  for (const entry of repositories) counts[entry.state] += 1;

  /** @type {SummaryState} */
  let state = SUMMARY_STATE_EMPTY;
  if (repositories.length > 0) {
    const first = REPOSITORY_STATE_PRECEDENCE.find((word) => counts[word] > 0);
    state = first ?? REPOSITORY_STATE_HEALTHY;
  }

  const total = repositories.length;
  /** @param {SummaryState} word */
  const of = (word) => plural(counts[word], 'enrolled repository');
  const threshold = `${STALL_THRESHOLD_HOURS}-hour`;
  /** @type {string} */
  let detail;
  switch (state) {
    case SUMMARY_STATE_EMPTY:
      detail = 'no repository is enrolled, so there is nothing to judge collection against';
      break;
    case REPOSITORY_STATE_UNAVAILABLE:
      detail = `${of(state)} is no longer served by GitHub and keeps its history`;
      break;
    case REPOSITORY_STATE_NEEDS_REAUTHENTICATION:
      detail = `${of(state)} was refused a credential that only a new token replaces`;
      break;
    case REPOSITORY_STATE_UNREADABLE:
      detail = `${of(state)} carries a recorded collection time this build cannot read`;
      break;
    case REPOSITORY_STATE_STALLED:
      detail = `${of(state)} has no successful collection for more than ${threshold}`;
      break;
    case REPOSITORY_STATE_DEGRADED:
      detail = `${of(state)} has an outstanding collection failure`;
      break;
    case REPOSITORY_STATE_NEVER_COLLECTED:
      detail = `${of(state)} has no recorded successful collection yet, so there is no schedule to judge`;
      break;
    default:
      detail = `all ${plural(total, 'enrolled repository')} ${total === 1 ? 'is' : 'are'} inside the ${threshold} `
        + 'threshold with no failure outstanding';
      break;
  }
  return {
    state,
    reason: `${statePhrase(state)}: ${detail}`,
    needsAttention: state !== REPOSITORY_STATE_HEALTHY && state !== REPOSITORY_STATE_NEVER_COLLECTED
      && state !== SUMMARY_STATE_EMPTY,
    enrolled: total,
    healthy: counts.healthy,
    neverCollected: counts['never-collected'],
    degraded: counts.degraded,
    needsReauthentication: counts['needs-re-authentication'],
    stalled: counts.stalled,
    unavailable: counts.unavailable,
    unreadable: counts.unreadable,
  };
}

/**
 * Read the health of every enrolled repository in an open archive, with the run
 * that produced the most recent state and the roll-up across the set.
 *
 * This is a pure query: it selects from what the archive holds, writes nothing, and
 * reaches no host. The enrolled set is the archive's own, so a repository the
 * configuration enrolls but no run has ever registered is part of the empty state
 * rather than an invented row - a first-connect install reads as "never run", which
 * is what it is.
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {() => number} [options.clock] Epoch milliseconds; every elapsed figure comes from it.
 * @returns {CollectionHealth}
 */
export function collectionHealth({ db, clock = Date.now }) {
  if (typeof clock !== 'function') throw new TypeError('The health read needs a clock returning epoch milliseconds');
  const nowMs = clock();
  if (!Number.isFinite(nowMs)) throw new TypeError('The injected clock must return epoch milliseconds');
  const repositories = listEnrolledRepositories(db)
    .map((/** @type {Repository} */ stored) => repositoryHealth(db, stored.id, nowMs));
  return {
    readAt: new Date(nowMs).toISOString(),
    repositories,
    run: runHealth(db),
    summary: summariseHealth(repositories),
  };
}

/**
 * The same read, from a home directory instead of an open archive: the wrapper both
 * surfaces use, so neither has to know where the archive lives or that it has to be
 * opened at all.
 *
 * Opening the archive is the only effect this wrapper has, and it is the archive
 * layer's own guarded open: a home whose schema is behind the code is migrated the
 * way `collect` and `serve` migrate it, so a reader is not asked to repair an
 * archive before it can be read. A home with no archive at all therefore answers
 * with the empty shape rather than an error. It still reads no credential and makes
 * no request: nothing here imports a client or constructs a transport.
 * @param {HealthHomeOptions} [options]
 * @returns {Promise<CollectionHealth>}
 */
export async function healthForHome(options = {}) {
  const home = options.home;
  const env = home === undefined
    ? (options.env ?? process.env)
    : { ...(options.env ?? process.env), REPO_SIGNAL_HOME: home };
  const paths = resolveHomePaths({
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const db = await openArchive(paths.databasePath);
  try {
    return collectionHealth({ db, ...(options.clock === undefined ? {} : { clock: options.clock }) });
  } finally {
    db.close();
  }
}