import { GitHubRequestError } from './retry.js';

// Contract: https://docs.github.com/en/rest/repos/repos and
// https://docs.github.com/en/rest/repos/releases
/** @typedef {Record<string, unknown> & {stars: number, forks: number, watchers: number}} RepositoryRecord */
/** @typedef {Record<string, unknown>} ReleaseRecord */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Do not include payload values or JSON parser diagnostics in errors.
 * @param {string} endpoint @param {string} detail
 */
function invalidPayload(endpoint, detail) {
  return new GitHubRequestError('unexpected', 200, endpoint,
    `Check the repository response contract: ${detail}`, 1);
}

/** @param {string} repo */
function repositoryPath(repo) {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || parts.some((part) => !part.trim() || part === '.' || part === '..')) {
    throw new TypeError('Repository must be an owner/name pair');
  }
  return `/repos/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
}

/** Reject a count that is not an integer rather than coercing it.
 * @param {unknown} value @param {string} endpoint @param {string} field
 */
function count(value, endpoint, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidPayload(endpoint, `${field} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Thin client over the repository record and releases. Unknown fields pass
 * through untouched; nothing is renamed for taste. No writes, no timers,
 * no storage.
 * @param {object} options
 * @param {Pick<ReturnType<typeof import('./retry.js').createRetryPolicy>, 'get'>} options.policy
 */
export function createRepoClient({ policy }) {
  /** @param {string} endpoint @returns {Promise<unknown>} */
  async function read(endpoint) {
    const response = await policy.get(endpoint, { endpointType: 'repository' });
    if (response.status !== 200) {
      throw new GitHubRequestError('unexpected', response.status, endpoint,
        'Check the repository endpoint contract; expected HTTP 200', 1);
    }
    try {
      return JSON.parse(response.body);
    } catch {
      throw invalidPayload(endpoint, 'response must be valid JSON');
    }
  }

  return Object.freeze({
    /** @param {string} repo @returns {Promise<RepositoryRecord>} */
    async repository(repo) {
      const endpoint = repositoryPath(repo);
      const payload = await read(endpoint);
      if (!isRecord(payload)) throw invalidPayload(endpoint, 'repository response must be a record');
      const stars = count(payload.stargazers_count, endpoint, 'stargazers_count');
      const forks = count(payload.forks_count, endpoint, 'forks_count');
      const watchers = count(payload.watchers_count, endpoint, 'watchers_count');
      // Plain fields for the counts; every other documented or future field
      // is carried through unchanged.
      return { ...payload, stars, forks, watchers };
    },

    /** @param {string} repo @returns {Promise<ReleaseRecord[]>} */
    async releases(repo) {
      const endpoint = `${repositoryPath(repo)}/releases`;
      const payload = await read(endpoint);
      if (!Array.isArray(payload)) throw invalidPayload(endpoint, 'releases response must be an array');
      return payload.map((entry, index) => {
        if (!isRecord(entry)) throw invalidPayload(endpoint, `entry ${index} must be a record`);
        return entry;
      });
    },
  });
}
