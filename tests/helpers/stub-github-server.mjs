/**
 * A scriptable local GitHub stub for entry-point tests.
 *
 * The stub exists so a spawned `node src/cli.js collect` can be driven without
 * a real token and without reaching `api.github.com`: it binds to `127.0.0.1`
 * on an ephemeral port and the test points `REPO_SIGNAL_GITHUB_BASE_URL` at it
 * with `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT`, which is the only network path the
 * transport accepts for a non-production base URL.
 *
 * It is a route table, not a model of GitHub: every endpoint is scripted by the
 * test that needs it, an unscripted request is recorded and answered 404, and
 * no response invents a rate-limit budget. Extend it with `route()` rather than
 * hardcoding endpoints here.
 */

import { createServer } from 'node:http';

/**
 * @typedef {object} StubResponse
 * @property {number} [status] Defaults to 200.
 * @property {unknown} [json] Serialized as an application/json body.
 * @property {string} [body] Raw body, for a payload that is deliberately not JSON.
 * @property {Record<string, string>} [headers] Extra headers, for example a Link page.
 */

/**
 * @typedef {object} StubRequest
 * @property {string} method
 * @property {string} path Request path without the query string.
 * @property {string} search Raw query string, including the leading `?`.
 * @property {boolean} authorized Whether a bearer credential reached the stub.
 * @property {boolean} tokenMatched Whether it was exactly the expected token.
 *   The credential itself is never retained, so an assertion can prove the
 *   transport presented it without the stub holding a secret.
 */

/** @typedef {StubResponse|StubResponse[]|((request: StubRequest, callIndex: number) => StubResponse)} StubReply */
/**
 * @typedef {object} StubRoute
 * @property {string|RegExp} pattern
 * @property {(method: string, path: string) => boolean} match
 * @property {StubReply} reply
 * @property {number} calls
 */

/**
 * Compile a route pattern into a matcher over the method and path.
 *
 * Accepted forms: `'<METHOD> <path>'` where a path segment may be a `:name`
 * placeholder matching one segment or a `*` placeholder matching one segment,
 * and a trailing `*` matching the rest of the path. The method may be `*` to
 * match any method. A `RegExp` is tested against `` `${method} ${path}` ``.
 * @param {string | RegExp} pattern
 * @returns {(method: string, path: string) => boolean}
 */
function matcher(pattern) {
  if (pattern instanceof RegExp) return (method, path) => pattern.test(`${method} ${path}`);
  const separator = pattern.indexOf(' ');
  const method = separator === -1 ? '*' : pattern.slice(0, separator);
  const template = separator === -1 ? pattern : pattern.slice(separator + 1);
  // A trailing `*` matches the rest of the path, so it is removed from the
  // template before the segments are compiled; a whole-segment `*` matches one.
  const wildcard = template.endsWith('*');
  const body = (wildcard ? template.slice(0, -1) : template).split('/').map((segment) => {
    if (segment === '*') return '[^/]*';
    if (segment.startsWith(':')) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const expression = new RegExp(`^${body}${wildcard ? '.*' : ''}$`);
  return (candidate, path) => (method === '*' || candidate === method) && expression.test(path);
}

/**
 * Pick the scripted reply for one call. An array is a script consumed in order,
 * with the last entry repeating, which is how a statistics endpoint answers 202
 * once and 200 afterwards.
 * @param {StubReply} reply
 * @param {StubRequest} request
 * @param {number} callIndex Zero-based count of earlier calls to this route.
 * @returns {StubResponse}
 */
function selectReply(reply, request, callIndex) {
  const chosen = Array.isArray(reply)
    ? reply[Math.min(callIndex, reply.length - 1)]
    : reply;
  return typeof chosen === 'function' ? chosen(request, callIndex) : chosen;
}

/**
 * @typedef {object} StubGitHub
 * @property {(pattern: string | RegExp, reply: StubReply) => StubGitHub} route Script one endpoint.
 * @property {() => Promise<string>} start Bind the ephemeral loopback port and return the base URL.
 * @property {() => Promise<void>} stop Close the listener.
 * @property {() => string} baseUrl Empty until `start` resolved.
 * @property {() => StubRequest[]} requests Every request received, in order.
 * @property {() => string[]} paths Requested paths in order, for compact assertions.
 * @property {() => void} reset Forget the recorded requests and every route's call count.
 */

/**
 * Create a stub that answers only what a test scripts.
 *
 * Re-registering the same pattern replaces that endpoint's script and keeps its
 * call count, which is how a test makes GitHub "revise" its window between two
 * runs. Distinct patterns are matched in registration order, so a test can
 * script one repository differently from the others.
 * @param {{ token?: string }} [options] The credential the transport is expected to present.
 * @returns {StubGitHub}
 */
export function createStubGitHub(options = {}) {
  const token = typeof options.token === 'string' ? options.token : '';
  /** @type {StubRoute[]} */
  const routes = [];
  /** @type {StubRequest[]} */
  const seen = [];

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {StubResponse} reply
   */
  function respond(response, reply) {
    const status = typeof reply?.status === 'number' ? reply.status : 200;
    const headers = { 'content-type': reply?.json === undefined ? 'text/plain' : 'application/json', ...reply?.headers };
    response.writeHead(status, headers);
    response.end(reply?.json === undefined ? (reply?.body ?? '') : JSON.stringify(reply.json));
  }

  const server = createServer((request, response) => {
    const target = new URL(request.url ?? '/', 'http://127.0.0.1');
    const authorization = request.headers.authorization ?? '';
    /** @type {StubRequest} */
    const observed = {
      method: request.method ?? 'GET',
      path: target.pathname,
      search: target.search,
      authorized: /^Bearer\s+\S/.test(authorization),
      tokenMatched: token !== '' && authorization === `Bearer ${token}`,
    };
    seen.push(observed);
    const route = routes.find((candidate) => candidate.match(observed.method, observed.path));
    if (route === undefined) {
      respond(response, { status: 404, json: { message: `no stubbed route for ${observed.method} ${observed.path}` } });
      return;
    }
    respond(response, selectReply(route.reply, observed, route.calls));
    route.calls += 1;
  });

  /** @type {string} */
  let baseUrl = '';

  /** @type {StubGitHub} */
  const stub = {
    route(pattern, reply) {
      const existing = routes.find((candidate) => String(candidate.pattern) === String(pattern));
      if (existing !== undefined) {
        existing.reply = reply;
        return stub;
      }
      routes.push({ pattern, match: matcher(pattern), reply, calls: 0 });
      return stub;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}/`;
      return baseUrl;
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
    baseUrl: () => baseUrl,
    requests: () => seen.slice(),
    paths: () => seen.map((observed) => observed.path),
    reset() {
      seen.length = 0;
      for (const route of routes) route.calls = 0;
    },
  };
  return stub;
}
