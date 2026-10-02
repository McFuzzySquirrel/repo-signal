/**
 * The response header policy of the loopback dashboard. Every response the
 * server emits — product page, error page, HEAD reply, even a 405 — carries
 * these headers, so no code path can accidentally make a page cacheable,
 * referrer-leaking or script-capable.
 */

/** Content type for the server-rendered HTML pages. */
export const CONTENT_TYPE_HTML = 'text/html; charset=utf-8';

/**
 * Content security policy: no script of any kind, styles only from the
 * same origin, images only from the same origin, no base override, no form
 * target, and no embedding in another document. Every asset the pages load
 * is same-origin, so `'self'` is exact rather than permissive.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

/**
 * The headers every response carries. A handler may add route-specific
 * headers on top, but these are always present and always win.
 *
 * @returns {Record<string, string>}
 */
export function securityHeaders() {
  return {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  };
}
