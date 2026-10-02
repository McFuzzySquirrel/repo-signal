import { assertTimestamp, getRepository, listEnrolledRepositories, upsertAlias, upsertRepository } from '../db/ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../db/ops-repo.js').Repository} Repository */

/**
 * Repository lifecycle is recorded, never inferred and never fatal. A repository
 * that was renamed or transferred keeps the identity the archive already gave it,
 * gains an alias row for the name it used to answer to, and continues to be
 * collected under the name GitHub now returns. A repository GitHub no longer
 * serves is marked unavailable with the reason it gave, stays enrolled in the
 * archive with all of its history, and is skipped by later runs instead of
 * failing them again.
 *
 * This step decides what a repository's identity is. It does not classify a
 * failure beyond the not-found the transport already typed, it embeds no timer,
 * and it adds no retry: the transport policy owns backoff.
 */

/** The two lifecycle words the archive's own CHECK constraint allows. */
export const LIFECYCLE_ACTIVE = /** @type {const} */ ('active');
export const LIFECYCLE_UNAVAILABLE = /** @type {const} */ ('unavailable');

/**
 * The repository payload did not carry the identity fields this step compares.
 * A name is never guessed from a partial payload, so a contract failure stops the
 * repository rather than inventing a rename. This step classifies nothing else: a
 * missing permission, a rejected token or a rate limit is the classifier's work.
 */
export class LifecycleContractError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LifecycleContractError';
  }
}

/**
 * @typedef {object} RemoteRepository
 * @property {string} owner Owner login GitHub returned for this repository.
 * @property {string} name Repository name GitHub returned.
 * @property {string} repo `owner/name` as GitHub spells it now.
 *
 * GitHub's own numeric repository id is deliberately not adopted here. The
 * archive's identity is the row every stored fact already references, so
 * renumbering it to GitHub's would detach the history this step exists to
 * preserve.
 */

/**
 * @typedef {object} IdentityChange
 * @property {boolean} renamed The repository name differs from the stored one, ignoring case.
 * @property {boolean} transferred The owner differs from the stored one, ignoring case.
 * @property {string} previousOwner Owner the archive held before this call.
 * @property {string} previousName Name the archive held before this call.
 * @property {string} owner Canonical owner after this call.
 * @property {string} name Canonical name after this call.
 * @property {string} repo `owner/name` after this call.
 * @property {boolean} aliasRecorded Whether this call wrote an alias row.
 */

/**
 * @typedef {object} RepoClient
 * @property {(repo: string) => Promise<import('../github/repo-client.js').RepositoryRecord>} repository
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Split and validate an owner/name pair. The same rule the GitHub clients apply,
 * so a repository that cannot address an endpoint cannot become an identity here
 * either.
 * @param {string} repo
 * @returns {[string, string]}
 */
export function splitRepository(repo) {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || parts.some((part) => !part.trim() || part === '.' || part === '..')) {
    throw new TypeError('Repository must be an owner/name pair');
  }
  return [parts[0], parts[1]];
}

/** @param {string} owner @param {string} name @returns {string} */
function pair(owner, name) {
  return `${owner}/${name}`;
}

/**
 * Confirm that GitHub still serves this repository, and read the identity it
 * answers with. Exactly one request is made, and nothing is written: the caller
 * decides what the returned identity means for the archive.
 *
 * A repository GitHub no longer serves raises the typed `repository-missing`
 * failure the transport policy already assigned, so the caller can mark it
 * instead of reporting a collection failure.
 *
 * GitHub answers a request for a renamed repository with a redirect rather than a
 * second identity, and this project's transport refuses every redirect. So a
 * rename or a transfer reaches this step as an explicit name change rather than
 * silently as a redirect that is never followed.
 * @param {object} options
 * @param {string} options.repo owner/name pair to confirm
 * @param {RepoClient} options.repoClient
 * @returns {Promise<RemoteRepository>}
 */
export async function confirmRepository({ repo, repoClient }) {
  splitRepository(repo);
  const record = await repoClient.repository(repo);
  if (!isRecord(record)) {
    throw new LifecycleContractError('Check the repository response contract: the response must be a record');
  }
  const { owner, name } = record;
  if (!isRecord(owner) || typeof owner.login !== 'string' || owner.login.trim() === '') {
    throw new LifecycleContractError(
      'Check the repository response contract: owner.login must name the account that owns the repository',
    );
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new LifecycleContractError(
      'Check the repository response contract: name must be the repository name GitHub serves it under',
    );
  }
  return { owner: owner.login, name, repo: pair(owner.login, name) };
}

/**
 * Find the identity the archive already gave a repository, by its canonical
 * owner/name pair or by any name it used to answer to. An alias matters here
 * because the enrolled set comes from the configuration, which still names the
 * repository the way it was written before the rename: without this lookup the
 * next run would allocate a second identity and split one history in two.
 *
 * A canonical pair wins over an alias, and the comparison is case-insensitive
 * because GitHub treats a repository name that way.
 * @param {Database} db
 * @param {string} repo owner/name pair to look up
 * @returns {Repository|null}
 */
export function findRepositoryByName(db, repo) {
  const wanted = pair(...splitRepository(repo)).toLowerCase();
  const canonical = listEnrolledRepositories(db)
    .find((row) => pair(row.owner, row.name).toLowerCase() === wanted);
  if (canonical !== undefined) return canonical;
  // SQLite's lower() folds ASCII, which is the whole of GitHub's owner/name alphabet.
  const alias = /** @type {{repositoryId: number}|undefined} */ (/** @type {unknown} */ (db.prepare(
    `SELECT repository_id AS repositoryId FROM repository_aliases
      WHERE lower(owner || '/' || name) = ? ORDER BY recorded_at, repository_id LIMIT 1`).get(wanted)));
  if (alias === undefined) return null;
  return getRepository(db, alias.repositoryId);
}

/**
 * @param {Repository} repository
 * @returns {boolean} Whether the archive already marked this repository unavailable.
 */
export function isUnavailable(repository) {
  return repository.lifecycle === LIFECYCLE_UNAVAILABLE;
}

/**
 * The reason to record for a repository GitHub no longer serves, or null when the
 * failure is not that. The typed status the transport assigned is the only input:
 * a rate limit, a rejected token, a missing permission or a transport failure are
 * not evidence that a repository disappeared, so they are left to the classifier.
 * @param {unknown} error
 * @param {string} repo owner/name pair the run was collecting
 * @returns {string|null} A reason naming the status, the repository and the next step.
 */
export function unavailableReason(error, repo) {
  const { kind, status, action } = /** @type {{kind?: unknown, status?: unknown, action?: unknown}} */ (error ?? {});
  if (status !== 404 && kind !== 'repository-missing') return null;
  const next = typeof action === 'string' && action.trim() !== ''
    ? action
    : 'Check whether the repository still exists and whether the token can still see it';
  // The status is named only when the failure carries one, because the transport
  // typed this failure by status and a reason must not report a status it lacks.
  const answered = typeof status === 'number' ? `HTTP ${status}` : 'no such repository';
  return `GitHub answered ${answered} for ${repo}: ${next}`;
}

/**
 * Record the identity GitHub now serves for a repository, keeping the identity the
 * archive already holds.
 *
 * A rename or a transfer appends an alias row for the stored pair, so the name the
 * archive used to answer to stays readable, and moves the canonical owner and name
 * onto what GitHub returned. A repository that is merely respelled is moved without
 * an alias, because a difference in case is not a rename. The row's identity,
 * lifecycle, enrolment and recorded health are untouched: no repository row is ever
 * deleted or renumbered, and every fact already stored under this identity keeps
 * its history.
 *
 * Synchronous and write-only, so a caller composing a repository's whole write
 * commits this inside its own transaction.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {RemoteRepository} options.remote
 * @param {string} options.collectedAt canonical UTC ISO timestamp for this write
 * @returns {IdentityChange}
 */
export function recordIdentity({ db, repositoryId, remote, collectedAt }) {
  assertTimestamp(collectedAt);
  const stored = getRepository(db, repositoryId);
  const renamed = stored.name.toLowerCase() !== remote.name.toLowerCase();
  const transferred = stored.owner.toLowerCase() !== remote.owner.toLowerCase();
  const aliasRecorded = renamed || transferred;
  if (aliasRecorded) {
    upsertAlias(db, { repositoryId, owner: stored.owner, name: stored.name, recordedAt: collectedAt });
  }
  // The canonical pair follows GitHub; identity, lifecycle, enrolment and health
  // are preserved by the upsert because they are not part of this input.
  upsertRepository(db, {
    id: repositoryId, owner: remote.owner, name: remote.name, lastSeenAt: collectedAt,
  });
  return {
    renamed,
    transferred,
    previousOwner: stored.owner,
    previousName: stored.name,
    owner: remote.owner,
    name: remote.name,
    repo: pair(remote.owner, remote.name),
    aliasRecorded,
  };
}

/**
 * Mark a repository the archive holds as unavailable, with the reason GitHub gave.
 * The row stays enrolled and keeps every fact ever written under its identity; only
 * its lifecycle changes, which is what later runs read to skip it. A repository
 * marked unavailable again keeps the reason it was first given unless this call
 * supplies a new one, so the original disappearance is never overwritten by a
 * repeat of itself.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.reason A single-line reason naming the status and the next step.
 * @param {string} options.collectedAt canonical UTC ISO timestamp for this write
 * @returns {void}
 */
export function markUnavailable({ db, repositoryId, reason, collectedAt }) {
  assertTimestamp(collectedAt);
  const stored = getRepository(db, repositoryId);
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new TypeError('An unavailable repository needs a reason; record what GitHub answered');
  }
  upsertRepository(db, {
    id: repositoryId,
    owner: stored.owner,
    name: stored.name,
    lastSeenAt: collectedAt,
    lifecycle: LIFECYCLE_UNAVAILABLE,
    unavailableReason: stored.lifecycle === LIFECYCLE_UNAVAILABLE && stored.unavailableReason !== null
      ? stored.unavailableReason
      : reason,
  });
}