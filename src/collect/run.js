import { randomUUID } from 'node:crypto';

import { backfillDevelopment } from '../backfill/development.js';
import { readProvenance, stampFirstCollected } from '../backfill/provenance.js';
import { backfillStars } from '../backfill/stars.js';
import { redact } from '../credentials/redact.js';
import {
  appendRun, completeRun, getRepository, listEnrolledRepositories, upsertRepository, withTransaction,
} from '../db/ops-repo.js';
import { resolveEnrollment } from '../enrollment/resolve.js';
import { createRepoClient } from '../github/repo-client.js';
import { createStarsClient } from '../github/stars-client.js';
import { createStatsClient } from '../github/stats-client.js';
import { createTrafficClient } from '../github/traffic-client.js';
import {
  confirmRepository, findRepositoryByName, isUnavailable, markUnavailable, recordIdentity,
  splitRepository, unavailableReason,
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
 * @property {{pages: number, entries: number, rows: number}} stars
 * @property {{kind: string, weeks: number, rows: number, truncated: boolean, windowFrom: string|null, windowTo: string|null}} development
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
 * @property {{kind: string, message: string}|null} failure
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

/**
 * @param {number} nowMs
 * @returns {string} An identifier that names the instant the run began.
 */
export function nextRunId(nowMs) {
  return `collect-${new Date(nowMs).toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
}

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
    return {
      repo,
      repositoryId: stored?.id ?? null,
      backfill,
      requests: RESOLUTION_REQUESTS_PER_REPOSITORY + TRAFFIC_REQUESTS_PER_REPOSITORY
        + (backfill ? BACKFILL_REQUESTS_FLOOR : 0),
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
 * First-connect backfill for one repository, before its traffic. It runs only
 * while no backfill has completed, so history is reconstructed on connect and
 * never re-derived daily, and a second run skips it. The step is not a
 * per-day pass: it writes what GitHub serves once and records the window it
 * actually observed.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.repo
 * @param {Clients} options.clients
 * @param {string} options.collectedAt
 * @returns {Promise<BackfillOutcome>}
 */
async function runFirstConnectBackfill({ db, repositoryId, repo, clients, collectedAt }) {
  const stars = await backfillStars({ db, repositoryId, repo, starsClient: clients.stars, collectedAt });
  const development = await backfillDevelopment({ db, repositoryId, repo, statsClient: clients.stats, collectedAt });
  return {
    stars: { pages: stars.pages, entries: stars.entries, rows: stars.rows },
    development: {
      kind: development.kind, weeks: development.weeks, rows: development.rows,
      truncated: development.truncated, windowFrom: development.windowFrom, windowTo: development.windowTo,
    },
  };
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
  try {
    const identity = ensureRepository({ db, repo: planned.repo, collectedAt });
    repositoryId = identity.id;
    registered = identity.registered;
    // A local alias keeps the narrowed identity inside the transaction closure.
    const id = identity.id;

    const remote = await confirmRepository({ repo: planned.repo, repoClient: clients.repo });

    if (!readProvenance(db, id).backfillCompleted) {
      backfill = await runFirstConnectBackfill({ db, repositoryId: id, repo: remote.repo, clients, collectedAt });
    }

    const clones = await clients.traffic.clones(remote.repo, TRAFFIC_GRANULARITY);
    const views = await clients.traffic.views(remote.repo, TRAFFIC_GRANULARITY);
    const referrers = await clients.traffic.referrers(remote.repo);
    const popularPaths = await clients.traffic.popularPaths(remote.repo);

    written = withTransaction(db, () => {
      const change = recordIdentity({ db, repositoryId: id, remote, collectedAt });
      const traffic = writeTrafficDays({ db, repositoryId: id, clones, views, collectedAt });
      const snapshots = writeSnapshotCaptures({ db, repositoryId: id, runId, referrers, popularPaths, collectedAt });
      const stamp = stampFirstCollected(db, id, {
        day: firstCollectedDay(clones, views, collectedAt), collectedAt,
      });
      return { identity: change, traffic, snapshots, stamp };
    });
  } catch (error) {
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
    traffic: written?.traffic ?? null,
    snapshots: written?.snapshots ?? null,
    stamp: written?.stamp ?? null,
    identity: written?.identity ?? null,
    unavailableReason: null,
    failure: null,
  };
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
    traffic: null,
    snapshots: null,
    stamp: null,
    identity: null,
    unavailableReason: reason,
    failure: { kind: failureKind(error), message: reason },
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
    traffic: null,
    snapshots: null,
    stamp: null,
    identity: null,
    unavailableReason: null,
    failure: { kind: failureKind(error), message: safeMessage(error, secrets) },
  };
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
 * Run the collection: resolve the enrolled set, plan the work, open a run record
 * before the first request, collect each repository inside its own failure
 * boundary, and close the run record with counts, a duration and a status. A
 * repository that fails never aborts the run, a repository GitHub no longer serves
 * is marked unavailable inside its own boundary, and a run where every repository
 * fails still closes a complete run record; the caller turns a degraded run into
 * a non-zero exit code. The run row is appended at the start, so a process killed
 * mid-run is still visible as an unclosed run in the journal.
 *
 * A dry run plans and reports and writes nothing at all: no run row, no fact row,
 * no heartbeat and no request.
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

  const startedAtMs = clock();
  const startedAt = new Date(startedAtMs).toISOString();
  const identifier = runId ?? nextRunId(startedAtMs);
  appendRun(db, { id: identifier, startedAt });

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
  }

  const totals = totalise(outcomes);
  // A repository that vanished is not a repository that was collected, so the run
  // reports it as degraded rather than complete; a repository an earlier run already
  // marked is only skipped, because the marking is already recorded and reported.
  const status = totals.failed + totals.unavailable === 0 ? RUN_STATUS_COMPLETED : RUN_STATUS_DEGRADED;
  const closedAtMs = clock();
  const durationMs = Math.max(0, closedAtMs - startedAtMs);
  completeRun(db, identifier, {
    closedAt: new Date(closedAtMs).toISOString(),
    status,
    successCount: totals.ok,
    failureCount: totals.failed + totals.unavailable,
    requestCount: counted.count(),
    durationMs,
  });

  return {
    mode: 'collected',
    runId: identifier,
    plan,
    outcomes,
    totals: { repositories: outcomes.length, ...totals, requests: counted.count(), durationMs },
    status,
  };
}
