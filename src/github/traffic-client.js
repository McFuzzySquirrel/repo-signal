import { GitHubRequestError } from './retry.js';

// Contract: https://docs.github.com/en/rest/metrics/traffic
/** @typedef {'day' | 'week'} TrafficGranularity */
/** @typedef {Record<string, unknown> & {count: number, uniques: number}} TrafficCounts */
/** @typedef {TrafficCounts & {timestamp: string, day: string, granularity: TrafficGranularity}} TrafficRecord */
/** @typedef {TrafficCounts & {referrer: string}} ReferrerRecord */
/** @typedef {TrafficCounts & {path: string, title: string}} PopularPathRecord */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Do not include payload values or JSON parser diagnostics in errors.
 * @param {string} endpoint @param {string} detail
 */
function invalidPayload(endpoint, detail) {
  return new GitHubRequestError('unexpected', 200, endpoint,
    `Check the traffic response contract: ${detail}`, 1);
}

/** @param {unknown} value @param {string} endpoint @param {string} location @returns {TrafficCounts} */
function counts(value, endpoint, location) {
  if (!isRecord(value)) throw invalidPayload(endpoint, `${location} must be a record`);
  const { count, uniques } = value;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
      || typeof uniques !== 'number' || !Number.isSafeInteger(uniques) || uniques < 0) {
    throw invalidPayload(endpoint, `${location} count and uniques must be non-negative safe integers`);
  }
  return { ...value, count, uniques };
}

/** Require an explicit date-time zone, rejecting missing/invalid dates, not inventing a day.
 * @param {unknown} timestamp @param {string} endpoint @param {number} index
 * @returns {{timestamp: string, day: string}}
 */
function utcDay(timestamp, endpoint, index) {
  const pattern = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;
  const match = typeof timestamp === 'string' ? pattern.exec(timestamp) : null;
  if (match === null || typeof timestamp !== 'string') {
    throw invalidPayload(endpoint, `entry ${index} timestamp is missing or is not a zoned date-time`);
  }
  const calendarDate = new Date(`${match[1]}T00:00:00Z`);
  const instant = new Date(timestamp);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== match[1]
      || !Number.isFinite(instant.getTime())) {
    throw invalidPayload(endpoint, `entry ${index} timestamp is not a valid calendar date-time`);
  }
  return { timestamp, day: instant.toISOString().slice(0, 10) };
}

/** @param {string} repo */
function repositoryPath(repo) {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || parts.some((part) => !part.trim() || part === '.' || part === '..')) {
    throw new TypeError('Repository must be an owner/name pair');
  }
  return `/repos/${parts.map((part) => encodeURIComponent(part)).join('/')}/traffic`;
}

/**
 * Thin clients sharing the existing GET-only policy. No credentials, timers,
 * storage or collection logic. Unknown record fields pass through unchanged.
 * @param {object} options
 * @param {Pick<ReturnType<typeof import('./retry.js').createRetryPolicy>, 'get'>} options.policy
 */
export function createTrafficClient({ policy }) {
  /** @param {string} endpoint @returns {Promise<unknown>} */
  async function read(endpoint) {
    const response = await policy.get(endpoint, { endpointType: 'traffic' });
    // In particular, an undocumented traffic 202 is not data or an empty list.
    if (response.status !== 200) {
      throw new GitHubRequestError('unexpected', response.status, endpoint,
        'Check the traffic endpoint contract; expected HTTP 200', 1);
    }
    try {
      return JSON.parse(response.body);
    } catch {
      throw invalidPayload(endpoint, 'response must be valid JSON');
    }
  }

  /** @param {string} repo @param {'clones' | 'views'} metric @param {TrafficGranularity} per
   * @returns {Promise<TrafficRecord[]>}
   */
  async function breakdown(repo, metric, per) {
    if (per !== 'day' && per !== 'week') throw new TypeError('Traffic per must be day or week');
    const endpoint = `${repositoryPath(repo)}/${metric}?per=${per}`;
    const payload = counts(await read(endpoint), endpoint, 'response');
    const entries = payload[metric];
    if (!Array.isArray(entries)) throw invalidPayload(endpoint, `${metric} breakdown must be an array`);
    if (per === 'day' && entries.length > 14) {
      throw invalidPayload(endpoint, `day breakdown has ${entries.length} entries; maximum is 14`);
    }
    return entries.map((entry, index) => {
      const record = counts(entry, endpoint, `entry ${index}`);
      return { ...record, ...utcDay(record.timestamp, endpoint, index), granularity: per };
    });
  }

  /** @param {string} repo @param {'referrers' | 'paths'} metric @returns {Promise<TrafficCounts[]>} */
  async function popular(repo, metric) {
    const endpoint = `${repositoryPath(repo)}/popular/${metric}`;
    const payload = await read(endpoint);
    if (!Array.isArray(payload)) throw invalidPayload(endpoint, `${metric} response must be an array`);
    const fields = metric === 'referrers' ? ['referrer'] : ['path', 'title'];
    return payload.map((entry, index) => {
      const record = counts(entry, endpoint, `entry ${index}`);
      if (fields.some((field) => typeof record[field] !== 'string')) {
        throw invalidPayload(endpoint, `entry ${index} requires string ${fields.join(' and ')} fields`);
      }
      // These are aggregate snapshots, not dated observations. Add no day.
      return record;
    });
  }

  return Object.freeze({
    /** @param {string} repo @param {TrafficGranularity} [per] */
    clones: (repo, per = 'day') => breakdown(repo, 'clones', per),
    /** @param {string} repo @param {TrafficGranularity} [per] */
    views: (repo, per = 'day') => breakdown(repo, 'views', per),
    /** @param {string} repo @returns {Promise<ReferrerRecord[]>} */
    referrers: async (repo) => /** @type {ReferrerRecord[]} */ (await popular(repo, 'referrers')),
    /** @param {string} repo @returns {Promise<PopularPathRecord[]>} */
    popularPaths: async (repo) => /** @type {PopularPathRecord[]} */ (await popular(repo, 'paths')),
  });
}
