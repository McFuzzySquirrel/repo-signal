import { randomUUID } from 'node:crypto';

import { backfillDevelopment } from '../backfill/development.js';
import { readProvenance, stampFirstCollected } from '../backfill/provenance.js';
import { backfillStars } from '../backfill/stars.js';
import { redact } from '../credentials/redact.js';
import {
  appendRun, completeRun, getRepository, listEnrolledRepositories, upsertRepository, withTransaction,
} from '../db/ops-repo.js';
import { resolveEnrollment } from '../enrollment/resolve.js';
import { createStarsClient } from '../github/stars-client.js';
import { createStatsClient } from '../github/stats-client.js';
import { createTrafficClient } from '../github/traffic-client.js';
import { writeSnapshotCaptures } from './snapshots.js';
import { TRAFFIC_GRANULARITY, writeTrafficDays } from './traffic.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../config/schema.js').Configuration} Configuration */
/** @typedef {import('../db/ops-repo.js').Repository} Repository */
/** @typedef {import('./traffic.js').TrafficSummary} TrafficSummary */
/** @typedef {import('./snapshots.js').SnapshotSummary} SnapshotSummary */
/** @typedef {import('../github/traffic-client.js').TrafficRecord} TrafficRecord */
/** @typedef {ReturnType<typeof createTrafficClient>} TrafficClient */
/** @typedef {ReturnType<typeof createStarsClient>} StarsClient */
/** @typedef {ReturnType<typeof createStatsClient>} StatsClient */
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
 */

/**
 * @typedef {object} BackfillOutcome
 * @property {{pages: number, entries: number, rows: number}} stars
 * @property {{kind: string, weeks: number, rows: number, truncated: boolean, windowFrom: string|null, windowTo: string|null}} development
 */

/**
 * @typedef {object} RepositoryOutcome
 * @property {string} repo
 * @property {number|null} repositoryId
 * @property {boolean} registered True when this run created the repository row.
 * @property {'ok'|'failed'} state
 * @property {BackfillOutcome|null} backfill First-connect backfill performed here, or null.
 * @property {TrafficSummary|null} traffic
 * @property {SnapshotSummary|null} snapshots
 * @property {{day: string, stamped: boolean}|null} stamp Provenance boundary in force after the write.
 * @property {{kind: string, message: string}|null} failure
 */

/**
 * @typedef {object} CollectTotals
 * @property {number} repositories
 * @property {number} ok
 * @property {number} failed
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
 * matched on the owner/name pair the configuration declared, so a second run
 * never creates a second row for a repository the archive already holds.
 * @param {Database} db
 * @param {string} repo
 * @returns {Repository|null}
 */
function storedRepository(db, repo) {
  const wanted = repo.toLowerCase();
  return listEnrolledRepositories(db)
    .find((row) => `${row.owner}/${row.name}`.toLowerCase() === wanted) ?? null;
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
 * @param {string} repo
 * @returns {[string, string]} owner and name, both validated by the configuration loader.
 */
function splitRepo(repo) {
  const slash = repo.indexOf('/');
  return [repo.slice(0, slash), repo.slice(slash + 1)];
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
 * @param {object} options
 * @param {Database} options.db
 * @param {Configuration} options.config
 * @param {string|null} [options.filter] One enrolled owner/name pair, or null for all of them.
 * @returns {PlannedRepository[]}
 */
export function planCollect({ db, config, filter = null }) {
  const enrolled = listEnrolledRepositories(db);
  return resolveCollectScope({ config, filter }).map((repo) => {
    const stored = enrolled.find((row) => `${row.owner}/${row.name}`.toLowerCase() === repo.toLowerCase()) ?? null;
    const backfill = stored === null || !readProvenance(db, stored.id).backfillCompleted;
    return {
      repo,
      repositoryId: stored?.id ?? null,
      backfill,
      requests: TRAFFIC_REQUESTS_PER_REPOSITORY + (backfill ? BACKFILL_REQUESTS_FLOOR : 0),
      exactRequests: !backfill,
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
  const [owner, name] = splitRepo(repo);
  const id = stored?.id ?? allocateRepositoryId(db, listEnrolledRepositories(db));
  upsertRepository(db, { id, owner, name, lastSeenAt: collectedAt, enrolled: 1 });
  return { id, registered: stored === null };
}

/**
 * @typedef {{traffic: TrafficSummary, snapshots: SnapshotSummary, stamp: {day: string, stamped: boolean}}} WrittenFacts
 */

/**
 * Collect one repository inside its own failure boundary. This function never
 * throws, so one repository's failure cannot stop the next one.
 *
 * The four reads happen before the write opens, because an archive transaction
 * is synchronous and must never hold a socket open; the day rows, the snapshot
 * captures and the provenance boundary then commit as one transaction, so an
 * interruption between repositories, or a rejection between two writes inside
 * one repository, leaves no half-written repository behind. The boundary is
 * stamped inside the same transaction, so a failed collection never claims a
 * first collected day, and the stamp is itself conditional, so a later run
 * cannot move it.
 *
 * Retry and backoff belong to the transport policy, so none is added here; this
 * step embeds no timer and reads no clock, because the collection time belongs
 * to the run that scheduled it.
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

    if (!readProvenance(db, id).backfillCompleted) {
      backfill = await runFirstConnectBackfill({ db, repositoryId: id, repo: planned.repo, clients, collectedAt });
    }

    const clones = await clients.traffic.clones(planned.repo, TRAFFIC_GRANULARITY);
    const views = await clients.traffic.views(planned.repo, TRAFFIC_GRANULARITY);
    const referrers = await clients.traffic.referrers(planned.repo);
    const popularPaths = await clients.traffic.popularPaths(planned.repo);

    written = withTransaction(db, () => {
      const traffic = writeTrafficDays({ db, repositoryId: id, clones, views, collectedAt });
      const snapshots = writeSnapshotCaptures({ db, repositoryId: id, runId, referrers, popularPaths, collectedAt });
      const stamp = stampFirstCollected(db, id, {
        day: firstCollectedDay(clones, views, collectedAt), collectedAt,
      });
      return { traffic, snapshots, stamp };
    });
  } catch (error) {
    return {
      repo: planned.repo,
      repositoryId,
      registered,
      state: 'failed',
      backfill,
      traffic: null,
      snapshots: null,
      stamp: null,
      failure: { kind: failureKind(error), message: safeMessage(error, secrets) },
    };
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
    failure: null,
  };
}

/**
 * @param {RepositoryOutcome[]} outcomes
 * @returns {Pick<CollectTotals, 'days'|'rows'|'written'|'revised'|'unchanged'|'snapshots'|'backfilled'>}
 */
function totalise(outcomes) {
  const totals = { days: 0, rows: 0, written: 0, revised: 0, unchanged: 0, snapshots: 0, backfilled: 0 };
  for (const outcome of outcomes) {
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
 * repository that fails never aborts the run, and a run where every repository
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
      totals: { repositories: plan.length, ok: 0, failed: 0, ...totalise([]), requests: 0, durationMs: 0 },
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
  };

  /** @type {RepositoryOutcome[]} */
  const outcomes = [];
  for (const planned of plan) {
    // Sequential on purpose: a handful of repositories stays inside the rate
    // limit, and a sequential run keeps the transaction story readable.
    outcomes.push(await collectRepository({ db, planned, runId: identifier, clients, collectedAt: startedAt, secrets }));
  }

  const ok = outcomes.filter((outcome) => outcome.state === 'ok').length;
  const failed = outcomes.length - ok;
  const closedAtMs = clock();
  const durationMs = Math.max(0, closedAtMs - startedAtMs);
  const status = failed === 0 ? RUN_STATUS_COMPLETED : RUN_STATUS_DEGRADED;
  completeRun(db, identifier, {
    closedAt: new Date(closedAtMs).toISOString(),
    status,
    successCount: ok,
    failureCount: failed,
    requestCount: counted.count(),
    durationMs,
  });

  return {
    mode: 'collected',
    runId: identifier,
    plan,
    outcomes,
    totals: {
      repositories: outcomes.length,
      ok,
      failed,
      ...totalise(outcomes),
      requests: counted.count(),
      durationMs,
    },
    status,
  };
}
