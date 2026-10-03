import { GitHubRequestError } from './retry.js';

// Contract: https://docs.github.com/en/rest/activity/starring#list-repository-star-history
//
// The `/repos/{owner}/{repo}/stargazers` listing is restricted to admins and
// collaborators from July 2026, so it cannot be the source of a backfill that has
// to work for an ordinary token. `/stargazers/history` was not included in that
// restriction and answers an unauthenticated caller, and it returns the same
// cumulative daily shape without enumerating a single user, which is the data the
// restriction exists to protect. Announced 2026-06-30:
// https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/
export const STAR_HISTORY_ENDPOINT_TYPE = 'stargazers';

/** The vendor caps a page at 30 weeks and the series at 100 pages. */
export const STAR_HISTORY_PER_PAGE = 30;
export const STAR_HISTORY_MAX_PAGES = 100;

/** @typedef {{week: number, total: number, days: number[]}} StarWeek */
/** @typedef {(weeks: StarWeek[], page: number, endpoint: string) => void | Promise<void>} StarWeekPageHandler */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Do not include payload values or JSON parser diagnostics in errors.
 * @param {string} endpoint @param {string} detail
 */
function invalidPayload(endpoint, detail) {
  return new GitHubRequestError('unexpected', 200, endpoint,
    `Check the star history response contract: ${detail}`, 1);
}

/** Parse the RFC 8288 Link header for the rel="next" target, or null.
 * @param {string|null} header
 */
function nextPage(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (match !== null && match[2] === 'next') return match[1];
  }
  return null;
}

/** @param {string} repo */
function repositoryPath(repo) {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || parts.some((part) => !part.trim() || part === '.' || part === '..')) {
    throw new TypeError('Repository must be an owner/name pair');
  }
  return `/repos/${parts.map((part) => encodeURIComponent(part)).join('/')}/stargazers/history`;
}

/**
 * One week as the vendor serves it. `total` is the stars created in that week and
 * must equal the sum of `days`; a payload where it does not is refused rather than
 * reconciled, because a total that disagrees with its own days means the record is
 * not what this backfill understands. Unknown fields pass through untouched.
 * @param {unknown} value
 * @param {string} endpoint
 * @param {number} index
 * @returns {StarWeek}
 */
function week(value, endpoint, index) {
  if (!isRecord(value)) throw invalidPayload(endpoint, `week ${index} must be a record`);
  const { week: start, total, days } = /** @type {Record<string, unknown>} */ (value);
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start <= 0) {
    throw invalidPayload(endpoint, `week ${index} must carry a positive integer week start`);
  }
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw invalidPayload(endpoint, `week ${index} total must be a non-negative safe integer`);
  }
  if (!Array.isArray(days) || days.length !== 7
      || days.some((day) => typeof day !== 'number' || !Number.isSafeInteger(day) || day < 0)) {
    throw invalidPayload(endpoint, `week ${index} days must be seven non-negative safe integers`);
  }
  const sum = days.reduce((total_, day) => total_ + /** @type {number} */ (day), 0);
  if (sum !== total) {
    throw invalidPayload(endpoint, `week ${index} total ${String(total)} disagrees with its days ${String(sum)}`);
  }
  return { week: start, total, days: [...days] };
}

/**
 * Star-history client: each page is handed to the caller's callback instead of being
 * buffered, and pagination follows only the advertised rel="next" Link, never a
 * fixed page count. No credentials, timers or storage. The vendor caps the series
 * at 100 pages, so `truncated` says when the oldest week was never reached rather
 * than letting a partial history read as a complete one.
 * @param {object} options
 * @param {Pick<ReturnType<typeof import('./retry.js').createRetryPolicy>, 'get'>} options.policy
 */
export function createStarsClient({ policy }) {
  /**
   * @param {string} repo
   * @param {StarWeekPageHandler} onPage
   * @returns {Promise<{pages: number, weeks: number, truncated: boolean}>}
   */
  async function starHistory(repo, onPage) {
    if (typeof onPage !== 'function') throw new TypeError('A caller-supplied onPage callback is required');
    /** @type {string|null} */
    let endpoint = `${repositoryPath(repo)}?per_page=${STAR_HISTORY_PER_PAGE}&page=1`;
    let page = 0;
    let weeks = 0;
    let truncated = false;
    while (endpoint !== null) {
      const current = endpoint;
      page += 1;
      if (page > STAR_HISTORY_MAX_PAGES) {
        // The vendor will not page further than this, so the oldest week is not in
        // this reading. Reported rather than silently treated as the whole history.
        truncated = true;
        break;
      }
      const response = await policy.get(current, { endpointType: STAR_HISTORY_ENDPOINT_TYPE });
      if (response.status !== 200) {
        throw new GitHubRequestError('unexpected', response.status, current,
          'Check the star history endpoint contract; expected HTTP 200', 1);
      }
      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw invalidPayload(current, 'response must be valid JSON');
      }
      if (!Array.isArray(payload)) throw invalidPayload(current, 'star history response must be an array');
      const records = payload.map((entry, index) => week(entry, current, index));
      weeks += records.length;
      await onPage(records, page, current);
      const next = nextPage(response.headers.get('link'));
      // A hostile Link target is refused by the transport allowlist, so hand it through.
      endpoint = next;
    }
    return { pages: page - (truncated ? 1 : 0), weeks, truncated };
  }

  return Object.freeze({ starHistory });
}