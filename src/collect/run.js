import { backfillDevelopment } from '../backfill/development.js';
import { readProvenance, stampFirstCollected } from '../backfill/provenance.js';
import { STARS_GRANULARITY, STARS_METRIC, backfillStars } from '../backfill/stars.js';
import { redact } from '../credentials/redact.js';
import { upsertDayFact } from '../db/day-series-repo.js';
import {
  assertTimestamp, getRepository, listEnrolledRepositories, upsertRepository, withTransaction,
} from '../db/ops-repo.js';
import { resolveEnrollment } from '../enrollment/resolve.js';
import { createRepoClient } from '../github/repo-client.js';
import { createStarsClient } from '../github/stars-client.js';
import { createStatsClient } from '../github/stats-client.js';
import { createTrafficClient } from '../github/traffic-client.js';
import { createRunJournal } from '../supervision/journal.js';
import { createRepoStateReporter } from '../supervision/repo-state-reporter.js';
import {
  confirmRepository, findRepositoryByName, isBackfillRefused, isUnavailable, markBackfillRefused,
  markUnavailable, recordIdentity, splitRepository, unavailableReason,
} from './lifecycle.js';
import { writeSnapshotCaptures } from './snapshots.js';
import { TRAFFIC_GRANULARITY, writeTrafficDays } from './traffic.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../config/schema.js').Configuration} Configuration */
/** @typedef {import('../db/ops-repo.js').Repository} Repository */
/** @typedef {import('./traffic.js').TrafficSummary} TrafficSummary */
/** @typedef {import('./snapshots.js').SnapshotSummary} SnapshotSummary */
/** @typedef {import('./lifecycle.js').IdentityChange} IdentityChange */
/** @typedef {import('../github/traffic-client.js').TrafficRecord} TrafficRecord */
/** @typedef {ReturnType<typeof createTrafficClient>} TrafficClient */
/** @typedef {ReturnType<typeof createStarsClient>} StarsClient */
/** @typedef {ReturnType<typeof createStatsClient>} StatsClient */
/** @typedef {ReturnType<typeof createRepoClient>} RepoClient */
/** @typedef {ReturnType<typeof import('../github/retry.js').createRetryPolicy>} RetryPolicy */

/**
 * A `--repo` argument naming a repository the enrolled set does not contain. The
 * command turns this into a usage error; the run never widens the enrolled set,
 * because enrollment is resolved from the configuration and nowhere else.
 */
export class CollectScopeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CollectScopeError';
  }
}

/** Run status words; `degraded` is the PRD's word for "at least one repository failed". */
export const RUN_STATUS_COMPLETED = /** @type {const} */ ('completed');
export const RUN_STATUS_DEGRADED = /** @type {const} */ ('degraded');
/** What a dry run reports instead of a run status, because no run happened. */
export const RUN_STATUS_PLANNED = /** @type {const} */ ('planned');

/** The traffic step reads four endpoints per repository: clones, views, referrers, popular paths. */
export const TRAFFIC_REQUESTS_PER_REPOSITORY = 4;
/**
 * Every repository is resolved once before any fact is written, so the collection
 * uses the name GitHub currently serves and a repository that vanished is marked
 * rather than reported as a traffic failure.
 */
export const RESOLUTION_REQUESTS_PER_REPOSITORY = 1;
/**
 * First-connect backfill reads one stargazer page per page GitHub returns plus
 * the two statistics endpoints, so a plan that includes it reports a floor over
 * the page count rather than a guessed number of requests.
 */
export const BACKFILL_REQUESTS_FLOOR = 3;
export const BACKFILL_FIRST_CONNECT = /** @type {const} */ ('first-connect');
export const BACKFILL_SKIPPED = /** @type {const} */ ('skipped');

/** The six kinds the transport policy already assigns to a failure. */
export const FAILURE_KINDS = Object.freeze([
  'authentication-rejected', 'permission-missing', 'repository-missing', 'rate-limited', 'transient', 'unexpected',
]);

/**
 * @typedef {object} PlannedRepository
 * @property {string} repo Enrolled owner/name pair this run would collect.
 * @property {number|null} repositoryId Stored archive identity, or null before first connect.
 * @property {boolean} backfill Whether the first-connect backfill would run.
 * @property {number} requests Requests the plan makes.
 * @property {boolean} exactRequests False when the count is a floor over unknown pages.
 * @property {boolean} skipped The archive already marked this repository unavailable,
 *   so this run requests nothing for it.
 * @property {string|null} unavailableReason Why the archive marked it, when it did.
 */

/**
 * @typedef {object} BackfillOutcome
 * @property {{pages: number, weeks: number, rows: number, truncated: boolean, unalignedWeeks: number}} stars
 *   Zero weeks when the history was refused. `truncated` means the vendor page cap
 *   cut the series short, and `unalignedWeeks` counts weeks whose day buckets do not
 *   start on a UTC midnight and were therefore not placed on a calendar day.
 * @property {{kind: string, weeks: number, rows: number, truncated: boolean, windowFrom: string|null, windowTo: string|null}} development
 * @property {string|null} starsRefusal Why the stargazer listing was unavailable this run, or null when
 *   it was read. A refusal here is not a completed backfill and is recorded on the repository row.
 */

/**
 * @typedef {object} RepositoryOutcome
 * @property {string} repo Enrolled pair this outcome belongs to.
 * @property {number|null} repositoryId
 * @property {boolean} registered True when this run created the repository row.
 * @property {'ok'|'failed'|'unavailable'|'skipped'} state `unavailable` is a repository this
 *   run marked because GitHub no longer serves it; `skipped` is one a previous run already
 *   marked, which this run neither requested nor wrote.
 * @property {BackfillOutcome|null} backfill First-connect backfill performed here, or null.
 * @property {TrafficSummary|null} traffic
 * @property {SnapshotSummary|null} snapshots
 * @property {{day: string, stamped: boolean}|null} stamp Provenance boundary in force after the write.
 * @property {IdentityChange|null} identity Lifecycle change this run recorded, or null.
 * @property {string|null} unavailableReason Why the repository is marked unavailable.
 * @property {string|null} backfillRefusal Why the star history is absent, when the archive
 *   recorded a refused stargazer listing. Null when the listing was read.
 * @property {{kind: string, message: string, endpoint: string|null}|null} failure
 */

/**
 * @typedef {object} CollectTotals
 * @property {number} repositories
 * @property {number} ok
 * @property {number} failed
 * @property {number} unavailable Repositories this run marked unavailable.
 * @property {number} skipped Repositories a previous run had already marked unavailable.
 * @property {number} days Distinct collected days across the run.
 * @property {number} rows Day rows applied, counted per metric key.
 * @property {number} written
 * @property {number} revised
 * @property {number} unchanged
 * @property {number} snapshots
 * @property {number} backfilled
 * @property {number} requests
 * @property {number} durationMs
 */

/**
 * @typedef {object} CollectSummary
 * @property {'dry-run'|'collected'} mode
 * @property {string|null} runId Identifier of the run row, or null when nothing was written.
 * @property {PlannedRepository[]} plan
 * @property {RepositoryOutcome[]} outcomes
 * @property {CollectTotals} totals
 * @property {'completed'|'degraded'|'planned'} status
 */

/** @type {Readonly<Record<string, true>>} */
const KNOWN_KINDS = Object.fromEntries(FAILURE_KINDS.map((kind) => [kind, true]));

/**
 * @param {unknown} error
 * @param {readonly string[]} [secrets]
 * @returns {string} A single-line message safe to print.
 */
function safeMessage(error, secrets = []) {
  return redact(error instanceof Error ? error.message : String(error), secrets)
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * The kind this run reports. The transport policy assigns one of six kinds to
 * every HTTP failure, so that kind is surfaced unchanged; anything else - a
 * contract failure, a database refusal - is reported as `unexpected`. No
 * failure is classified here: that belongs to the classifier, and this step
 * only decides whether the run continues.
 * @param {unknown} error
 * @returns {string}
 */
function failureKind(error) {
  const kind = /** @type {{kind?: unknown}} */ (error)?.kind;
  return typeof kind === 'string' && KNOWN_KINDS[kind] === true ? kind : 'unexpected';
}

/**
 * Narrow the enrolled set to the requested repository, refusing a name the
 * configuration does not enroll rather than collecting something the maintainer
 * never opted in to. Pure, so a caller can refuse a wrong filter before it opens
 * the archive or reads a credential.
 * @param {object} options
 * @param {Configuration} options.config
 * @param {string|null} [options.filter]
 * @returns {string[]} The repositories this run would collect, in enrolled order.
 */
export function resolveCollectScope({ config, filter = null }) {
  const enrolled = resolveEnrollment(config);
  if (filter === null) return enrolled;
  const wanted = filter.toLowerCase();
  const found = enrolled.find((repo) => repo.toLowerCase() === wanted);
  if (found === undefined) {
    throw new CollectScopeError(
      `collect --repo ${filter} is not an enrolled repository; the enrolled set is ` +
        (enrolled.length === 0 ? 'empty, so nothing would be collected' : enrolled.join(', ')),
    );
  }
  return [found];
}

/**
 * Find the stored identity for one enrolled pair. Identity is the archive row,
 * matched on the canonical owner/name pair and on every alias it has ever been
 * collected under, so the configuration still naming a repository the way it was
 * written before a rename finds the history it belongs to instead of allocating a
 * second identity for the same repository.
 * @param {Database} db
 * @param {string} repo
 * @returns {Repository|null}
 */
function storedRepository(db, repo) {
  return findRepositoryByName(db, repo);
}

/**
 * @param {Database} db
 * @param {number} id
 * @returns {boolean} Whether the archive already holds that identity.
 */
function isRegistered(db, id) {
  try {
    getRepository(db, id);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown repository ')) return false;
    throw error;
  }
}

/**
 * Allocate an unused archive identity for a repository the archive has never
 * seen. The next free integer above the highest stored identity is probed
 * through the archive's own read, so an identity that exists is never
 * shadowed. A repository the archive already holds keeps its stored identity,
 * which is what lets a rename or a transfer keep its history.
 * @param {Database} db
 * @param {Repository[]} enrolled
 * @returns {number}
 */
function allocateRepositoryId(db, enrolled) {
  let candidate = enrolled.reduce((highest, row) => Math.max(highest, row.id), 0) + 1;
  while (isRegistered(db, candidate)) candidate += 1;
  return candidate;
}

// The run identifier names a row in the run journal, so the journal derives it from the
// instant it records as the start; it stays exported here for callers that already
// import it from this module.
export { nextRunId } from '../supervision/journal.js';

/**
 * The work a run would do, decided from the configuration and the archive
 * alone. Planning opens no socket, so a dry run can report the plan without
 * contacting GitHub, and the plan names the first-connect backfill step it would
 * perform and the requests it would make.
 *
 * A repository the archive already marked unavailable is planned as skipped: it
 * keeps its row and its history, and no run requests it again until the maintainer
 * re-enrols or unmarks it.
 * @param {object} options
 * @param {Database} options.db
 * @param {Configuration} options.config
 * @param {string|null} [options.filter] One enrolled owner/name pair, or null for all of them.
 * @returns {PlannedRepository[]}
 */
export function planCollect({ db, config, filter = null }) {
  return resolveCollectScope({ config, filter }).map((repo) => {
    const stored = storedRepository(db, repo);
    if (stored !== null && isUnavailable(stored)) {
      return {
        repo,
        repositoryId: stored.id,
        backfill: false,
        requests: 0,
        exactRequests: true,
        skipped: true,
        unavailableReason: stored.unavailableReason,
      };
    }
    const backfill = stored === null || !readProvenance(db, stored.id).backfillCompleted;
    // A refused stargazer listing is not asked again, so the plan does not count
    // its request floor; the development half of the backfill still runs.
    const starsRefused = stored !== null && isBackfillRefused(stored);
    return {
      repo,
      repositoryId: stored?.id ?? null,
      backfill,
      requests: RESOLUTION_REQUESTS_PER_REPOSITORY + TRAFFIC_REQUESTS_PER_REPOSITORY
        + (backfill && !starsRefused ? BACKFILL_REQUESTS_FLOOR : 0),
      exactRequests: !backfill,
      skipped: false,
      unavailableReason: null,
    };
  });
}

/**
 * Count what the run actually asked GitHub for. Counting the policy rather than
 * the client calls keeps stargazer pagination honest: every page is counted,
 * however many GitHub returns.
 * @param {RetryPolicy} policy
 * @returns {{ policy: Pick<RetryPolicy, 'get'>, count: () => number }}
 */
function countedPolicy(policy) {
  let requests = 0;
  /** @type {Pick<RetryPolicy, 'get'>} */
  const counted = {
    get: async (endpoint, options) => {
      requests += 1;
      return policy.get(endpoint, options);
    },
  };
  return { policy: counted, count: () => requests };
}

/**
 * The first day a collection wrote. The boundary is the oldest day GitHub
 * returned, because that is the first day for which collected data exists; a
 * window that returned nothing leaves the run's own day as the first one, which
 * is also the honest answer for a repository GitHub has no history for yet.
 * @param {TrafficRecord[]} clones
 * @param {TrafficRecord[]} views
 * @param {string} collectedAt
 * @returns {string}
 */
function firstCollectedDay(clones, views, collectedAt) {
  let earliest = null;
  for (const record of [...clones, ...views]) {
    if (typeof record.day !== 'string' || record.day === '') continue;
    if (earliest === null || record.day < earliest) earliest = record.day;
  }
  return earliest ?? collectedAt.slice(0, 10);
}

/**
 * @typedef {object} Clients
 * @property {TrafficClient} traffic
 * @property {StarsClient} stars
 * @property {StatsClient} stats
 * @property {RepoClient} repo
 */

/**
 * Whether GitHub refused the stargazer listing itself, rather than the repository.
 * This is an access restriction on that one endpoint family, not a permission the
 * maintainer can grant and not a fault in the repository, so it is the one
 * backfill failure that must not cost the repository its traffic.
 * @param {unknown} error
 * @returns {boolean}
 */
function isStargazersRefusal(error) {
  const failure = /** @type {{kind?: unknown, status?: unknown, endpointType?: unknown}} */ (
    error instanceof Object && error !== null ? error : {});
  return failure.kind === 'permission-missing' && failure.status === 403
    && failure.endpointType === 'stargazers';
}

/**
 * First-connect backfill for one repository, before its traffic. It runs only
 * while no backfill has completed, so history is reconstructed on connect and
 * never re-derived daily, and a second run skips it. The step is not a
 * per-day pass: it writes what GitHub serves once and records the window it
 * actually observed.
 *
 * The two halves are independent. A refused stargazer listing is recorded against
 * the repository and returned, because GitHub limits that listing to admins and
 * collaborators: the star history is simply absent, and the traffic this run came
 * to collect is unaffected. Any other backfill failure still propagates, so a
 * genuine fault is never swallowed.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.repo
 * @param {Clients} options.clients
 * @param {string} options.collectedAt
 * @param {readonly string[]} [options.secrets]
 * @returns {Promise<BackfillOutcome>}
 */
async function runFirstConnectBackfill({ db, repositoryId, repo, clients, collectedAt, secrets = [] }) {
  /** @type {{pages: number, weeks: number, rows: number, truncated: boolean, unalignedWeeks: number}|null} */
  let stars = null;
  /** @type {string|null} */
  let starsRefusal = null;
  const refused = getRepository(db, repositoryId);
  if (isBackfillRefused(refused)) {
    // Already refused once. Re-asking an endpoint that has refused costs a request
    // every run and cannot change the answer, so the recorded reason is reported
    // again: the star history is still absent on this run too.
    starsRefusal = refused.backfillRefusedReason;
  } else {
    try {
      stars = await backfillStars({ db, repositoryId, repo, starsClient: clients.stars, collectedAt });
    } catch (error) {
      if (!isStargazersRefusal(error)) throw error;
      // The policy's own sentence is the reason: it is the transport's redacted
      // status and next step. The reporter remains the only place the classifier
      // is called from.
      const reason = safeMessage(error, secrets);
      starsRefusal = reason;
      withTransaction(db, () => markBackfillRefused({ db, repositoryId, reason, collectedAt }));
    }
  }
  const development = await backfillDevelopment({ db, repositoryId, repo, statsClient: clients.stats, collectedAt });
  return {
    stars: stars ?? { pages: 0, weeks: 0, rows: 0, truncated: false, unalignedWeeks: 0 },
    development: {
      kind: development.kind, weeks: development.weeks, rows: development.rows,
      truncated: development.truncated, windowFrom: development.windowFrom, windowTo: development.windowTo,
    },
    starsRefusal,
  };
}

/**
 * Store the star level this collection observed, as a cumulative day fact for the
 * collection's own UTC day.
 *
 * Every collection already resolves the repository, and that response carries the
 * stargazer count, so this costs no request: it records a level the run had already
 * paid for instead of discarding it. The value is the count as of collection time, so
 * the row is an observation at that instant rather than the day's closing figure -
 * which is why `collected_at` is written with it and why the divergence reading's
 * docstring calls the two series not strictly co-temporal.
 *
 * It is written here, inside the transaction that also writes the traffic facts, so a
 * star level can never commit without the traffic it was collected alongside. A level
 * lower than the stored one is written: a repository can lose stars, and a falling
 * level is a real observation rather than a correction to suppress.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {number} options.stars The stargazer count the repository response carried.
 * @param {string} options.collectedAt canonical UTC ISO timestamp for this write
 * @returns {void}
 */
function writeStarLevel({ db, repositoryId, stars, collectedAt }) {
  assertTimestamp(collectedAt);
  upsertDayFact(db, {
    repositoryId,
    metric: STARS_METRIC,
    granularity: STARS_GRANULARITY,
    day: collectedAt.slice(0, 10),
    value: stars,
    source: 'collected',
    collectedAt,
  });
}

/**
 * Register the repository this run collects, reusing the stored identity when
 * the archive has one and allocating a fresh one on first connect.
 * @param {object} options
 * @param {Database} options.db
 * @param {string} options.repo
 * @param {string} options.collectedAt
 * @returns {{id: number, registered: boolean}}
 */
function ensureRepository({ db, repo, collectedAt }) {
  const stored = storedRepository(db, repo);
  const [owner, name] = splitRepository(repo);
  const id = stored?.id ?? allocateRepositoryId(db, listEnrolledRepositories(db));
  upsertRepository(db, { id, owner, name, lastSeenAt: collectedAt, enrolled: 1 });
  return { id, registered: stored === null };
}

/**
 * @typedef {{traffic: TrafficSummary, snapshots: SnapshotSummary, identity: IdentityChange,
 *   stamp: {day: string, stamped: boolean}}} WrittenFacts
 */

/**
 * Collect one repository inside its own failure boundary. This function never
 * throws, so one repository's failure cannot stop the next one.
 *
 * The repository is resolved once, before anything is written, so the rest of the
 * run reads the name GitHub currently serves: a rename or a transfer is recorded
 * with its alias and collected under the new name instead of being answered with a
 * redirect this transport refuses, and a repository GitHub no longer serves is
 * marked unavailable rather than reported as a traffic failure.
 *
 * The reads all happen before the write opens, because an archive transaction is
 * synchronous and must never hold a socket open; the identity, the day rows, the
 * snapshot captures and the provenance boundary then commit as one transaction, so
 * an interruption between repositories, or a rejection between two writes inside one
 * repository, leaves no half-written repository behind. The boundary is stamped
 * inside the same transaction, so a failed collection never claims a first collected
 * day, and the stamp is itself conditional, so a later run cannot move it.
 *
 * Supervision state rides along with the same boundary: the success commits inside the
 * repository's own transaction, and a failure is recorded as evidence through the
 * reporter, which owns what a failure is. Neither decides anything about this run; the
 * decision to carry on to the next repository is the one this function already makes.
 *
 * Retry and backoff belong to the transport policy, so none is added here; this
 * step embeds no timer and reads no clock, because the collection time belongs to
 * the run that scheduled it.
 * @param {object} options
 * @param {Database} options.db
 * @param {PlannedRepository} options.planned
 * @param {string} options.runId
 * @param {Clients} options.clients
 * @param {string} options.collectedAt
 * @param {readonly string[]} options.secrets
 * @returns {Promise<RepositoryOutcome>}
 */
async function collectRepository({ db, planned, runId, clients, collectedAt, secrets }) {
  /** @type {BackfillOutcome|null} */
  let backfill = null;
  /** @type {number|null} */
  let repositoryId = planned.repositoryId;
  /** @type {boolean} */
  let registered = false;
  /** @type {WrittenFacts|null} */
  let written = null;
  const reporter = createRepoStateReporter({ db });
  try {
    const identity = ensureRepository({ db, repo: planned.repo, collectedAt });
    repositoryId = identity.id;
    registered = identity.registered;
    // A local alias keeps the narrowed identity inside the transaction closure.
    const id = identity.id;

    const remote = await confirmRepository({ repo: planned.repo, repoClient: clients.repo });

    if (!readProvenance(db, id).backfillCompleted) {
      backfill = await runFirstConnectBackfill({ db, repositoryId: id, repo: remote.repo, clients, collectedAt, secrets });
    }

    const clones = await clients.traffic.clones(remote.repo, TRAFFIC_GRANULARITY);
    const views = await clients.traffic.views(remote.repo, TRAFFIC_GRANULARITY);
    const referrers = await clients.traffic.referrers(remote.repo);
    const popularPaths = await clients.traffic.popularPaths(remote.repo);

    written = withTransaction(db, () => {
      const change = recordIdentity({ db, repositoryId: id, remote, collectedAt });
      const traffic = writeTrafficDays({ db, repositoryId: id, clones, views, collectedAt });
      writeStarLevel({ db, repositoryId: id, stars: remote.stars, collectedAt });
      const snapshots = writeSnapshotCaptures({ db, repositoryId: id, runId, referrers, popularPaths, collectedAt });
      const stamp = stampFirstCollected(db, id, {
        day: firstCollectedDay(clones, views, collectedAt), collectedAt,
      });
      // The success joins this repository's own transaction, so a collection that did
      // not commit cannot claim a last successful collection and a committed one
      // cannot lose it. It is the recorded success the stalled rule is later read
      // against; no state here is inferred from the presence or absence of facts.
      reporter.recordSuccess({ repositoryId: id, collectedAt });
      return { identity: change, traffic, snapshots, stamp };
    });
  } catch (error) {
    // The failure is recorded as evidence through the reporter, which owns what a
    // failure *is*. The reporter never decides that this run continues, and a
    // supervision write that cannot be made must not become a collection crash, so a
    // repository with no stored identity yet records nothing rather than inventing one.
    recordFailureEvidence({ reporter, repositoryId, runId, error, collectedAt, repo: planned.repo, secrets });
    // A repository GitHub no longer serves is marked, not failed: it keeps its row,
    // its enrolment and every fact already stored under its identity, and later runs
    // skip it instead of asking about it again. Nothing was written for it in this
    // run, because the marking is reached only while no fact write had opened.
    const reason = repositoryId === null ? null : unavailableReason(error, planned.repo);
    if (reason !== null) {
      try {
        withTransaction(db, () => markUnavailable({ db, repositoryId: /** @type {number} */ (repositoryId),
          reason, collectedAt }));
      } catch {
        // A marking that cannot be written is a failure of this repository, and it
        // is reported as one rather than claimed as a marking that did not happen.
        return failedOutcome({ planned, repositoryId, registered, backfill, error, secrets });
      }
      return unavailableOutcome({ planned, repositoryId, registered, backfill, error, reason });
    }
    return failedOutcome({ planned, repositoryId, registered, backfill, error, secrets });
  }
  return {
    repo: planned.repo,
    repositoryId,
    registered,
    state: 'ok',
    backfill,
    // Read from the archive rather than from this run's backfill step: once the
    // development half has completed, later runs skip the step entirely, and the
    // star history is still absent on every one of them.
    backfillRefusal: repositoryId === null ? null : getRepository(db, repositoryId).backfillRefusedReason,
    traffic: written?.traffic ?? null,
    snapshots: written?.snapshots ?? null,
    stamp: written?.stamp ?? null,
    identity: written?.identity ?? null,
    unavailableReason: null,
    failure: null,
  };
}

/**
 * Record one failure as append-only evidence through the reporter, which classifies it
 * and advances the repository's consecutive-failure count. This step keeps that call
 * from becoming a collection failure of its own: a repository the archive never stored
 * has no identity to record against, and a supervision write the archive refuses is
 * reported nowhere rather than turned into a crash that would abort the run.
 * @param {object} options
 * @param {ReturnType<typeof createRepoStateReporter>} options.reporter
 * @param {number|null} options.repositoryId Stored identity, or null when the archive never got one.
 * @param {string} options.runId
 * @param {unknown} options.error The thrown value, as the client or policy reported it.
 * @param {string} options.collectedAt Canonical UTC ISO instant for this attempt.
 * @param {string} options.repo `owner/name` this run was collecting.
 * @param {readonly string[]} options.secrets
 * @returns {void}
 */
function recordFailureEvidence({ reporter, repositoryId, runId, error, collectedAt, repo, secrets }) {
  if (repositoryId === null) return;
  try {
    reporter.recordFailure({ repositoryId, runId, error, collectedAt, repo, secrets });
  } catch {
    // The evidence could not be written. The repository is still reported as failed by
    // the caller, which is the run's own decision; nothing here is claimed as recorded.
  }
}

/**
 * The outcome for a repository GitHub no longer serves: it is reported as a
 * repository outcome carrying the reason, never as a crash, and the run carries on
 * to the next repository. The typed kind the transport assigned travels with it, so
 * the classifier still owns what the failure was.
 * @param {object} options
 * @param {PlannedRepository} options.planned
 * @param {number|null} options.repositoryId
 * @param {boolean} options.registered
 * @param {BackfillOutcome|null} options.backfill
 * @param {unknown} options.error
 * @param {string} options.reason The recorded reason, already free of credential material.
 * @returns {RepositoryOutcome}
 */
function unavailableOutcome({ planned, repositoryId, registered, backfill, error, reason }) {
  return {
    repo: planned.repo,
    repositoryId,
    registered,
    state: 'unavailable',
    backfill,
    backfillRefusal: null,
    traffic: null,
    snapshots: null,
    stamp: null,
    identity: null,
    unavailableReason: reason,
    failure: { kind: failureKind(error), message: reason, endpoint: failureEndpoint(error) },
  };
}

/**
 * The outcome for a repository that produced no facts and is not unavailable: the
 * typed failure is reported and the run carries on to the next repository.
 * @param {object} options
 * @param {PlannedRepository} options.planned
 * @param {number|null} options.repositoryId
 * @param {boolean} options.registered
 * @param {BackfillOutcome|null} options.backfill
 * @param {unknown} options.error
 * @param {readonly string[]} options.secrets
 * @returns {RepositoryOutcome}
 */
function failedOutcome({ planned, repositoryId, registered, backfill, error, secrets }) {
  return {
    repo: planned.repo,
    repositoryId,
    registered,
    state: 'failed',
    backfill,
    backfillRefusal: null,
    traffic: null,
    snapshots: null,
    stamp: null,
    identity: null,
    unavailableReason: null,
    failure: {
      kind: failureKind(error),
      message: safeMessage(error, secrets),
      endpoint: failureEndpoint(error),
    },
  };
}

/**
 * The endpoint a failure names, already redacted where the policy built it. A run
 * makes several requests per repository, so the endpoint is what distinguishes
 * them; it carries an owner and a name and nothing else.
 * @param {unknown} error
 * @returns {string|null}
 */
function failureEndpoint(error) {
  const failure = /** @type {{endpoint?: unknown}} */ (error instanceof Object && error !== null ? error : {});
  return typeof failure.endpoint === 'string' && failure.endpoint !== '' ? failure.endpoint : null;
}

/**
 * The outcome for a repository an earlier run marked unavailable. No request is
 * made, nothing is written, and the run is not degraded by it: the marking is
 * already recorded and the maintainer has already been told about it.
 * @param {PlannedRepository} planned
 * @returns {RepositoryOutcome}
 */
function skippedOutcome(planned) {
  return {
    repo: planned.repo,
    repositoryId: planned.repositoryId,
    registered: false,
    state: 'skipped',
    backfill: null,
    backfillRefusal: null,
    traffic: null,
    snapshots: null,
    stamp: null,
    identity: null,
    unavailableReason: planned.unavailableReason,
    failure: null,
  };
}

/**
 * Count what a set of outcomes adds up to. A repository the archive had already
 * marked unavailable contributes to `skipped` and nothing else: it wrote no day,
 * appended no capture, and did not make this run fail.
 * @param {RepositoryOutcome[]} outcomes
 * @returns {Pick<CollectTotals, 'ok'|'failed'|'unavailable'|'skipped'|'days'|'rows'|'written'|'revised'|'unchanged'|'snapshots'|'backfilled'>}
 */
function totalise(outcomes) {
  const totals = { ok: 0, failed: 0, unavailable: 0, skipped: 0, days: 0, rows: 0,
    written: 0, revised: 0, unchanged: 0, snapshots: 0, backfilled: 0 };
  for (const outcome of outcomes) {
    if (outcome.state === 'ok') totals.ok += 1;
    else if (outcome.state === 'failed') totals.failed += 1;
    else if (outcome.state === 'unavailable') totals.unavailable += 1;
    else totals.skipped += 1;
    if (outcome.backfill !== null) totals.backfilled += 1;
    if (outcome.traffic !== null) {
      totals.days += outcome.traffic.days;
      totals.rows += outcome.traffic.rows;
      totals.written += outcome.traffic.written;
      totals.revised += outcome.traffic.revised;
      totals.unchanged += outcome.traffic.unchanged;
    }
    if (outcome.snapshots !== null) totals.snapshots += outcome.snapshots.rows;
  }
  return totals;
}

/**
 * Run the collection: resolve the enrolled set, plan the work, open the run journal
 * before the first request, collect each repository inside its own failure boundary,
 * recording progress as each one finishes, and close the journal with counts, a
 * duration, a request count and a status. A repository that fails never aborts the
 * run, a repository GitHub no longer serves is marked unavailable inside its own
 * boundary, and a run where every repository fails still closes a complete run record;
 * the caller turns a degraded run into a non-zero exit code. The run row is appended at
 * the start, so a process killed mid-run is still visible as an unclosed run in the
 * journal.
 *
 * The journal owns the run identifier and every instant this run records, so the
 * identifier printed in the summary is the identifier on the row. Nothing here decides
 * whether a run continues: the per-repository boundary in `collectRepository` is the
 * whole of that decision, and the journal only records what the run did.
 *
 * A dry run plans and reports and writes nothing at all: no run row, no fact row,
 * no heartbeat and no request. It returns before the journal is even opened.
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {Configuration} options.config
 * @param {RetryPolicy} [options.policy] Required unless `dryRun` is set. It is never built here, so a dry run cannot open a socket.
 * @param {string|null} [options.filter] One enrolled owner/name pair, or null for all of them.
 * @param {boolean} [options.dryRun]
 * @param {() => number} [options.clock] Epoch milliseconds; every instant and duration comes from it.
 * @param {readonly string[]} [options.secrets] Values redacted from every reported message.
 * @param {string} [options.runId] Override the generated run identifier.
 * @returns {Promise<CollectSummary>}
 */
export async function collectRun({
  db, config, policy, filter = null, dryRun = false, clock = Date.now, secrets = [], runId,
}) {
  const plan = planCollect({ db, config, filter });
  if (dryRun) {
    return {
      mode: 'dry-run',
      runId: null,
      plan,
      outcomes: [],
      totals: {
        repositories: plan.length, ...totalise([]), requests: 0, durationMs: 0,
      },
      status: RUN_STATUS_PLANNED,
    };
  }
  if (policy === undefined) {
    throw new TypeError('A collection run needs the shared request policy; a dry run must not build one');
  }

  const journal = createRunJournal({ db, runId: runId ?? null, clock });
  const opened = journal.start();
  const identifier = opened.runId;
  const startedAt = opened.startedAt;

  const counted = countedPolicy(policy);
  /** @type {Clients} */
  const clients = {
    traffic: createTrafficClient({ policy: counted.policy }),
    stars: createStarsClient({ policy: counted.policy }),
    stats: createStatsClient({ policy: counted.policy }),
    repo: createRepoClient({ policy: counted.policy }),
  };

  /** @type {RepositoryOutcome[]} */
  const outcomes = [];
  for (const planned of plan) {
    // Sequential on purpose: a handful of repositories stays inside the rate
    // limit, and a sequential run keeps the transaction story readable.
    // A repository an earlier run marked unavailable is skipped without a request:
    // it keeps its row and its history, and asking again would only fail again.
    outcomes.push(planned.skipped
      ? skippedOutcome(planned)
      : await collectRepository({ db, planned, runId: identifier, clients, collectedAt: startedAt, secrets }));
    // Progress is recorded as each repository finishes, inside the loop, so a run
    // that dies on the fourth repository leaves three repositories of progress behind
    // rather than nothing at all. A tick the clock could not advance is reported as
    // unrecorded rather than invented, and does not stop the loop; an archive that
    // refuses the write is a real failure of the run record itself, so it is allowed
    // to surface instead of being swallowed into a run that silently loses its
    // supervision trail.
    journal.progress({ completedRepositories: outcomes.length });
  }

  const totals = totalise(outcomes);
  // A repository that vanished is not a repository that was collected, so the run
  // reports it as degraded rather than complete; a repository an earlier run already
  // marked is only skipped, because the marking is already recorded and reported.
  const status = totals.failed + totals.unavailable === 0 ? RUN_STATUS_COMPLETED : RUN_STATUS_DEGRADED;
  const closed = journal.close({
    status,
    successCount: totals.ok,
    failureCount: totals.failed + totals.unavailable,
    requestCount: counted.count(),
    completedRepositories: outcomes.length,
  });

  return {
    mode: 'collected',
    runId: identifier,
    plan,
    outcomes,
    totals: { repositories: outcomes.length, ...totals, requests: counted.count(), durationMs: closed.durationMs },
    status,
  };
}
