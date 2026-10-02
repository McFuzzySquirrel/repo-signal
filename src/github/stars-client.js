import { GitHubRequestError } from './retry.js';

// Contract: https://docs.github.com/en/rest/activity/starring
// The star media type is what makes each entry carry `starred_at`.
export const STARGAZER_ACCEPT = 'application/vnd.github.star+json';

/** @typedef {Record<string, unknown>} StargazerEntry */
/** @typedef {(entries: StargazerEntry[], page: number, endpoint: string) => void | Promise<void>} StargazerPageHandler */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Do not include payload values or JSON parser diagnostics in errors.
 * @param {string} endpoint @param {string} detail
 */
function invalidPayload(endpoint, detail) {
  return new GitHubRequestError('unexpected', 200, endpoint,
    `Check the stargazer response contract: ${detail}`, 1);
}

/** @param {string} repo */
function repositoryPath(repo) {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || parts.some((part) => !part.trim() || part === '.' || part === '..')) {
    throw new TypeError('Repository must be an owner/name pair');
  }
  return `/repos/${parts.map((part) => encodeURIComponent(part)).join('/')}/stargazers`;
}

/** Parse the RFC 8288 Link header for the rel="next" target, or null.
 * @param {string | null} header
 */
function nextPage(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (match !== null && match[2] === 'next') return match[1];
  }
  return null;
}

/**
 * Streaming stargazer client: each page is handed to the caller's callback
 * instead of being buffered. Pagination follows only the advertised
 * rel="next" Link, never a page count. No writes, timers or storage.
 * @param {object} options
 * @param {Pick<ReturnType<typeof import('./retry.js').createRetryPolicy>, 'get'>} options.policy
 */
export function createStarsClient({ policy }) {
  /**
   * @param {string} repo
   * @param {StargazerPageHandler} onPage
   * @returns {Promise<{pages: number, entries: number}>}
   */
  async function stargazerStars(repo, onPage) {
    if (typeof onPage !== 'function') throw new TypeError('A caller-supplied onPage callback is required');
    const first = `${repositoryPath(repo)}?per_page=100&page=1`;
    /** @type {string | null} */
    let endpoint = first;
    let page = 0;
    let entries = 0;
    while (endpoint !== null) {
      const current = endpoint;
      page += 1;
      const response = await policy.get(current, {
        accept: STARGAZER_ACCEPT, endpointType: 'repository',
      });
      if (response.status !== 200) {
        throw new GitHubRequestError('unexpected', response.status, current,
          'Check the stargazer endpoint contract; expected HTTP 200', 1);
      }
      /** @type {unknown} */
      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw invalidPayload(current, 'response must be valid JSON');
      }
      if (!Array.isArray(payload)) throw invalidPayload(current, 'stargazers response must be an array');
      const records = payload.map((entry, index) => {
        if (!isRecord(entry)) throw invalidPayload(current, `entry ${index} must be a record`);
        return entry;
      });
      entries += records.length;
      await onPage(records, page, current);
      endpoint = nextPage(response.headers.get('link'));
    }
    return { pages: page, entries };
  }

  return Object.freeze({ stargazerStars });
}
