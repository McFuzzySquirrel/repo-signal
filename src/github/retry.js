import { setTimeout as sleepDefault } from 'node:timers/promises';
import { redact } from '../credentials/redact.js';
import { parseRateLimitHeaders, primaryBudgetDelay } from './rate-limit.js';

/** @typedef {'repository' | 'traffic' | 'statistics' | 'stargazers'} EndpointType */
/** @typedef {'authentication-rejected' | 'permission-missing' | 'repository-missing' | 'rate-limited' | 'transient' | 'unexpected'} ErrorKind */

/**
 * GitHub limited the public stargazer listing to admins and collaborators in July
 * 2026, so a 403 there is an access restriction rather than a token permission the
 * maintainer can grant. Announced 2026-06-30:
 * https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/
 */
export const STARGAZERS_RESTRICTED_ACTION =
  'GitHub now limits the stargazer listing to admins and collaborators, so this token cannot read it; ' +
  'collection continues without star history, and re-enrol the repository once access is restored';

/** HTTP policy failure. Raw bodies, headers and causes are never retained. */
export class GitHubRequestError extends Error {
  /**
   * @param {ErrorKind} kind
   * @param {number} status
   * @param {string} endpoint
   * @param {string} action
   * @param {number} attempts
   * @param {EndpointType} [endpointType] Which endpoint family answered, so a caller can classify without parsing the path.
   */
  constructor(kind, status, endpoint, action, attempts, endpointType) {
    super(redact(`GitHub HTTP ${status}: ${action}`));
    this.name = 'GitHubRequestError';
    this.kind = kind;
    this.status = status;
    this.endpoint = redact(endpoint);
    this.action = redact(action);
    this.attempts = attempts;
    this.endpointType = endpointType;
  }
}

/** @param {number} status @param {string} endpoint @param {EndpointType} type @param {number} attempts */
function statusError(status, endpoint, type, attempts) {
  /** @type {ErrorKind} */
  let kind = 'unexpected';
  let action = 'Check the endpoint and supported API contract before retrying';
  if (status === 401) {
    kind = 'authentication-rejected';
    action = 'Re-authenticate with a valid GitHub token';
  } else if (status === 403) {
    kind = 'permission-missing';
    action = type === 'traffic'
      ? 'Grant Administration repository permission (read), accept the permission upgrade, and reconnect'
      : type === 'stargazers'
        ? STARGAZERS_RESTRICTED_ACTION
        : 'Check repository access and grant the required token permissions';
  } else if (status === 404) {
    kind = 'repository-missing';
    action = 'Check the repository name, whether it still exists, and token access';
  } else if (status === 429) {
    kind = 'rate-limited';
    action = 'Wait for the GitHub rate limit to reset before collecting again';
  } else if (status === 202 || (status >= 500 && status <= 599)) {
    kind = 'transient';
    action = status === 202
      ? 'Statistics are not ready yet; try collecting again later'
      : 'GitHub is temporarily unavailable; try collecting again later';
  }
  return new GitHubRequestError(kind, status, endpoint, action, attempts, type);
}

/**
 * Shared GET-only policy on top of createHttpTransport. Reuse one instance
 * across sequential client calls so an exhausted successful response also
 * paces the next request. No payload interpretation, storage or background work.
 * @param {object} options
 * @param {Pick<ReturnType<typeof import('./http.js').createHttpTransport>, 'get'>} options.transport
 * @param {() => number} [options.clock] Epoch milliseconds.
 * @param {(milliseconds: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random] Jitter source in [0, 1].
 * @param {number} [options.maxAttempts] Includes the initial GET.
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs] Caps local backoff, not server deadlines.
 */
export function createRetryPolicy({
  transport, clock = Date.now, sleep = async (ms) => { await sleepDefault(ms); },
  random = Math.random, maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 300_000,
}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1
      || !Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1
      || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new TypeError('Retry attempts and delays must be positive safe integers; maxDelayMs must be at least baseDelayMs');
  }
  /** @type {import('./rate-limit.js').RateLimitBudget | null} */
  let budget = null;

  /** Recheck time after an early wake; split waits to avoid Node timer overflow. @param {number} deadline */
  async function waitUntil(deadline) {
    let delay;
    while ((delay = deadline - clock()) > 0) {
      await sleep(Math.min(delay, 2_147_483_647));
    }
  }

  return Object.freeze({
    /**
     * The caller marks the endpoint type; the policy never parses its path.
     * A non-statistics 202 is returned untouched, once, for the client to surface.
     * @param {string} endpoint
     * @param {object} [options]
     * @param {string} [options.accept]
     * @param {EndpointType} [options.endpointType]
     * @returns {Promise<import('./http.js').TransportResponse>}
     */
    async get(endpoint, { accept, endpointType = 'repository' } = {}) {
      for (let attempts = 1; attempts <= maxAttempts; attempts++) {
        const before = clock();
        await waitUntil(before + primaryBudgetDelay(budget, before));
        // Transport errors already carry safe typed diagnostics; no retry here.
        const response = await transport.get(endpoint, accept);
        const now = clock();
        budget = parseRateLimitHeaders(response.headers, now);
        const { status } = response;
        if (status === 401 || status === 403 || status === 404) {
          throw statusError(status, endpoint, endpointType, attempts);
        }
        const retryable = status === 429 || (status >= 500 && status <= 599)
          || (status === 202 && endpointType === 'statistics');
        if (!retryable) {
          if (status >= 200 && status <= 299) return response;
          throw statusError(status, endpoint, endpointType, attempts);
        }
        if (attempts === maxAttempts) throw statusError(status, endpoint, endpointType, attempts);

        const sample = random();
        if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
          throw new TypeError('Retry jitter source must return a finite number between zero and one');
        }
        // Equal jitter retains a nonzero floor. Secondary limits without headers
        // wait at least a minute, as documented by GitHub. Server waits may exceed
        // the configured cap; clipping them would issue an early retry.
        const base = status === 429 ? Math.max(60_000, baseDelayMs) : baseDelayMs;
        const ceiling = Math.min(maxDelayMs, base * 2 ** (attempts - 1));
        const backoff = Math.ceil(ceiling * (0.5 + sample * 0.5));
        const secondaryFloor = status === 429 && budget.retryAfterMs === null
          && budget.remaining !== 0 ? 60_000 : 0;
        const delay = Math.max(backoff, secondaryFloor, budget.retryAfterMs ?? 0,
          primaryBudgetDelay(budget, now));
        await waitUntil(now + delay);
      }
      // The validated positive attempt cap and final-attempt throw make this unreachable.
      throw new Error('Retry policy exhausted without a response');
    },
  });
}
