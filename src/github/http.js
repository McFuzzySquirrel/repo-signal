import { readFileSync } from 'node:fs';
import process from 'node:process';
import { redact } from '../credentials/redact.js';

// Vendor contract: https://docs.github.com/rest/overview/api-versions
export const GITHUB_API_VERSION = '2026-03-10';
const DEFAULT_BASE_URL = 'https://api.github.com/';
const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const USER_AGENT = `repo-signal/${metadata.version}`;

/** A transport failure, not an HTTP status classification or retry decision. */
export class GitHubTransportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} endpoint
   * @param {number | null} status
   * @param {readonly string[]} secrets
   */
  constructor(code, message, endpoint, status, secrets = []) {
    super(redact(message, secrets));
    this.name = 'GitHubTransportError';
    this.code = code;
    this.endpoint = redact(endpoint, secrets);
    this.status = status;
    this.action = 'Check the transport configuration and connection before retrying';
  }
}

/**
 * @typedef {object} TransportResponse
 * @property {number} status HTTP statuses are left to the request policy.
 * @property {Headers} headers Includes rate-limit and pagination headers untouched.
 * @property {string} body Unparsed payload; unknown fields remain untouched.
 */

/**
 * Single outbound boundary. No arbitrary headers, method, body or fetch options
 * are accepted. The only request customization is the endpoint's Accept type.
 * @param {object} options
 * @param {import('./credential-provider.js').CredentialSource} options.credentialProvider
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 */
export function createHttpTransport({
  credentialProvider,
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 30_000,
}) {
  return Object.freeze({
    /**
     * Read one response including its body within the timeout. All redirects
     * (even same-host redirects) are refused: no implicit second request occurs.
     * @param {string} endpoint Absolute URL or path, including query parameters.
     * @param {string} [accept]
     * @returns {Promise<TransportResponse>}
     */
    async get(endpoint, accept = 'application/vnd.github+json') {
      let token = '';
      let code = 'ERR_TRANSPORT_CONFIGURATION';
      /** @type {number | null} */
      let status = null;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const controller = new AbortController();
      try {
        const base = new URL(baseUrl);
        const target = new URL(endpoint, base);
        // Evaluate the explicit test gate on EVERY request, not at import time.
        const local = Boolean(process.env.REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT)
          && base.hostname === '127.0.0.1'
          && (base.protocol === 'http:' || base.protocol === 'https:');
        /** @param {URL} url */
        const allowed = (url) => !url.username && !url.password && !url.hash && (
          (url.protocol === 'https:' && url.hostname === 'api.github.com' && url.port === '')
          || (local && url.origin === base.origin)
        );
        code = 'ERR_TRANSPORT_HOST';
        if (!allowed(base) || !allowed(target)) {
          throw new Error('Request refused: use https://api.github.com or the explicitly gated 127.0.0.1 test base URL');
        }
        code = 'ERR_TRANSPORT_CONFIGURATION';
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
          throw new Error('Request timeout must be a positive integer no greater than 2147483647 milliseconds');
        }
        if (typeof accept !== 'string' || !accept || /[\r\n]/.test(accept)) {
          throw new Error('Accept must be a non-empty media type without line breaks');
        }
        code = 'ERR_TRANSPORT_CREDENTIAL';
        token = await credentialProvider.getToken();
        if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
          token = typeof token === 'string' ? token : '';
          throw new Error('Credential provider must return a non-empty, single-line token');
        }
        code = 'ERR_TRANSPORT_NETWORK';
        timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetchImpl(target.href, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: accept,
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            'User-Agent': USER_AGENT,
          },
        });
        status = response.status;
        if ([301, 302, 303, 307, 308].includes(status) || response.redirected) {
          code = 'ERR_TRANSPORT_REDIRECT';
          controller.abort();
          throw new Error('Redirect refused: request the canonical allowlisted endpoint directly');
        }
        const body = await response.text();
        return { status, headers: response.headers, body };
      } catch (error) {
        if (controller.signal.aborted && code === 'ERR_TRANSPORT_NETWORK') {
          code = 'ERR_TRANSPORT_TIMEOUT';
        }
        throw new GitHubTransportError(
          code,
          code === 'ERR_TRANSPORT_TIMEOUT'
            ? 'GitHub request timed out; check connectivity and retry'
            : error instanceof Error ? error.message : 'GitHub transport failed',
          typeof endpoint === 'string' ? endpoint : '(invalid endpoint)',
          status,
          [token],
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  });
}
