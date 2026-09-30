/**
 * Header contract: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 * Missing or malformed values stay unknown, never an invented zero budget.
 * All times in the returned record are milliseconds.
 * @typedef {object} RateLimitBudget
 * @property {number | null} limit
 * @property {number | null} remaining
 * @property {number | null} used
 * @property {number | null} resetAt
 * @property {string | null} resource
 * @property {number | null} retryAfterMs
 */

/** @param {string | null} value @returns {number | null} */
function unsignedInteger(value) {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * GitHub documents Retry-After in seconds. HTTP-date is also accepted per
 * HTTP Retry-After semantics; it is not assumed to be emitted by GitHub.
 * @param {Headers} headers
 * @param {number} now Epoch milliseconds, supplied by the policy's clock.
 * @returns {RateLimitBudget}
 */
export function parseRateLimitHeaders(headers, now) {
  const reset = unsignedInteger(headers.get('x-ratelimit-reset'));
  const retry = headers.get('retry-after');
  let retryAfterMs = null;
  if (retry !== null) {
    const seconds = unsignedInteger(retry);
    if (seconds !== null && Number.isSafeInteger(seconds * 1000)) {
      retryAfterMs = seconds * 1000;
    } else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)) {
      const instant = Date.parse(retry);
      if (Number.isFinite(instant)) retryAfterMs = Math.max(0, instant - now);
    }
  }
  return {
    limit: unsignedInteger(headers.get('x-ratelimit-limit')),
    remaining: unsignedInteger(headers.get('x-ratelimit-remaining')),
    used: unsignedInteger(headers.get('x-ratelimit-used')),
    resetAt: reset !== null && Number.isSafeInteger(reset * 1000) ? reset * 1000 : null,
    resource: headers.get('x-ratelimit-resource'),
    retryAfterMs,
  };
}

/** @param {RateLimitBudget | null} budget @param {number} now */
export function primaryBudgetDelay(budget, now) {
  return budget?.remaining === 0 && budget.resetAt !== null
    ? Math.max(0, budget.resetAt - now) : 0;
}
