import { GitHubRequestError } from './retry.js';

// Contract: https://docs.github.com/en/rest/metrics/statistics
// 202 means the cache is compiling: a retryable outcome, never data.
/** @typedef {{kind: 'data', all: number[], owner: number[]}} ParticipationData */
/** @typedef {{kind: 'data', weeks: Record<string, unknown>[]}} CommitActivityData */
/** @typedef {{kind: 'retryable', status: number, reason: string} | {kind: 'no-statistics-yet'}} StatsNonData */
/** @typedef {({kind: 'data', all: number[], owner: number[]} & Record<string, unknown>) | StatsNonData} ParticipationResult */
/** @typedef {({kind: 'data', weeks: Record<string, unknown>[]} & Record<string, unknown>) | StatsNonData} CommitActivityResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Do not include payload values or JSON parser diagnostics in errors.
 * @param {string} endpoint @param {string} detail
 */
function invalidPayload(endpoint, detail) {
  return new GitHubRequestError('unexpected', 200, endpoint,
    `Check the statistics response contract: ${detail}`, 1);
}

/** @param {string} repo */
function repositoryPath(repo) {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || parts.some((part) => !part.trim() || part === '.' || part === '..')) {
    throw new TypeError('Repository must be an owner/name pair');
  }
  return `/repos/${parts.map((part) => encodeURIComponent(part)).join('/')}/stats`;
}

/** A counts array of non-negative safe integers, or null when absent.
 * @param {unknown} value @param {string} endpoint @param {string} field
 */
function weekCounts(value, endpoint, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number'
      || !Number.isSafeInteger(item) || item < 0)) {
    throw invalidPayload(endpoint, `${field} must be an array of non-negative integers`);
  }
  return value;
}

/**
 * Weekly statistics client. 202 is a retryable outcome, not data and never
 * a failure; 200 with an empty series is the normal "no statistics yet"
 * state. No writes, timers or storage.
 * @param {object} options
 * @param {Pick<ReturnType<typeof import('./retry.js').createRetryPolicy>, 'get'>} options.policy
 */
export function createStatsClient({ policy }) {
  /**
   * @param {string} endpoint
   * @returns {Promise<{status: number, payload: unknown}>}
   */
  async function read(endpoint) {
    let response;
    try {
      response = await policy.get(endpoint, { endpointType: 'statistics' });
    } catch (error) {
      // The shared policy retries a statistics 202 up to its cap, then
      // surfaces the last 202. That is a retryable outcome, not a failure.
      if (error instanceof GitHubRequestError && error.status === 202) {
        return { status: 202, payload: null };
      }
      throw error;
    }
    if (response.status === 202) return { status: 202, payload: null };
    if (response.status === 204) return { status: 204, payload: null };
    if (response.status !== 200) {
      throw new GitHubRequestError('unexpected', response.status, endpoint,
        'Check the statistics endpoint contract; expected HTTP 200, 202 or 204', 1);
    }
    try {
      return { status: 200, payload: JSON.parse(response.body) };
    } catch {
      throw invalidPayload(endpoint, 'response must be valid JSON');
    }
  }

  return Object.freeze({
    /** @param {string} repo @returns {Promise<ParticipationResult>} */
    async participation(repo) {
      const endpoint = `${repositoryPath(repo)}/participation`;
      const { status, payload } = await read(endpoint);
      if (status === 202) return { kind: 'retryable', status: 202, reason: 'statistics-cache-compiling' };
      if (status === 204) return { kind: 'no-statistics-yet' };
      if (!isRecord(payload)) throw invalidPayload(endpoint, 'participation response must be a record');
      const all = weekCounts(payload.all, endpoint, 'all');
      const owner = weekCounts(payload.owner, endpoint, 'owner');
      if (all.length === 0 && owner.length === 0) return { kind: 'no-statistics-yet' };
      return { ...payload, kind: 'data', all, owner };
    },

    /** @param {string} repo @returns {Promise<CommitActivityResult>} */
    async commitActivity(repo) {
      const endpoint = `${repositoryPath(repo)}/commit_activity`;
      const { status, payload } = await read(endpoint);
      if (status === 202) return { kind: 'retryable', status: 202, reason: 'statistics-cache-compiling' };
      if (status === 204) return { kind: 'no-statistics-yet' };
      if (!Array.isArray(payload)) throw invalidPayload(endpoint, 'commit activity response must be an array');
      const weeks = payload.map((entry, index) => {
        if (!isRecord(entry)) throw invalidPayload(endpoint, `entry ${index} must be a record`);
        const { days, total, week } = entry;
        if (!Array.isArray(days) || days.length !== 7
            || days.some((day) => typeof day !== 'number' || !Number.isSafeInteger(day) || day < 0)) {
          throw invalidPayload(endpoint, `entry ${index} days must be seven non-negative integers`);
        }
        if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
            || typeof week !== 'number' || !Number.isSafeInteger(week) || week < 0) {
          throw invalidPayload(endpoint, `entry ${index} total and week must be non-negative integers`);
        }
        return entry;
      });
      if (weeks.length === 0) return { kind: 'no-statistics-yet' };
      return { kind: 'data', weeks };
    },
  });
}
