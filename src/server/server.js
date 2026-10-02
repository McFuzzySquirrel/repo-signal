import http from 'node:http';
import process from 'node:process';
import { redact } from '../credentials/redact.js';
import { CONTENT_TYPE_HTML, securityHeaders } from './security.js';

/** The only interface the server ever binds to; it is not configurable. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Default upper bound on the request URL, rejected before any view runs. */
export const DEFAULT_MAX_URL_LENGTH = 2048;

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

/**
 * @typedef {object} ViewResult
 * @property {number} [status] HTTP status, defaulting to 200.
 * @property {string} [body] Response HTML, defaulting to empty.
 * @property {Record<string, string>} [headers] Extra response headers.
 */

/**
 * A view handler injected by the caller. The router supplies one; a test
 * substitutes its own. The server never imports a view module itself.
 *
 * @typedef {(req: http.IncomingMessage) => (ViewResult | string) | Promise<ViewResult | string>} ViewHandler
 */

/**
 * @param {unknown} address The peer address string from the socket.
 * @returns {boolean} True when the peer arrived on a loopback interface.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  if (address === '::1' || address === '::ffff:127.0.0.1' || address === '0:0:0:0:0:0:0:1') return true;
  return address === '127.0.0.1' || address.startsWith('127.');
}

/**
 * Minimal standalone page used for boundary errors. It names the problem in
 * text, carries the security headers, and never carries a thrown message, a
 * stack trace, or a correlation identifier.
 *
 * @param {string} title Short name of the problem.
 * @param {string} message One sentence naming the cause.
 * @returns {string}
 */
function boundaryPage(title, message) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title} - RepoSignal</title>\n</head>\n<body>\n<main>\n<h1>${title}</h1>\n<p>${message}</p>\n</main>\n</body>\n</html>\n`;
}

/**
 * @param {unknown} error
 * @returns {void}
 */
function defaultLogger(error) {
  const text = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[repo-signal] view error: ${redact(text)}\n`);
}

/**
 * Build the request listener: peer check, method allowlist, URL length
 * limit, then the injected handler, with every boundary rejection and the
 * 500 containment carrying the security headers. HEAD gets the GET headers
 * with no body.
 *
 * @param {object} options
 * @param {ViewHandler} options.handler Injected view handler.
 * @param {(error: unknown) => void} [options.logger] Local detail sink for
 *   thrown views, defaulting to a redacted write to stderr.
 * @param {number} [options.maxUrlLength]
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>}
 */
export function createRequestHandler(/** @type {{ handler: ViewHandler, logger?: (error: unknown) => void, maxUrlLength?: number }} */ { handler, logger = defaultLogger, maxUrlLength = DEFAULT_MAX_URL_LENGTH }) {
  if (typeof handler !== 'function') throw new TypeError('createRequestHandler requires a view handler function');

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {string} body
   * @param {Record<string, string>} [extra]
   */
  const send = (req, res, status, body, extra = {}) => {
    const headers = { 'Content-Type': CONTENT_TYPE_HTML, ...extra, ...securityHeaders() };
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  return async function requestHandler(req, res) {
    try {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        send(req, res, 403, boundaryPage('Forbidden', 'This dashboard refuses connections that did not arrive on the loopback interface.'));
        return;
      }
      if (!ALLOWED_METHODS.has(req.method ?? '')) {
        send(req, res, 405, boundaryPage('Method not allowed', 'Only GET and HEAD requests are supported.'), { Allow: 'GET, HEAD' });
        return;
      }
      const url = typeof req.url === 'string' ? req.url : '';
      if (url.length > maxUrlLength) {
        send(req, res, 414, boundaryPage('Request URL too long', `The request URL exceeds the ${maxUrlLength} character limit.`));
        return;
      }
      const view = await handler(req);
      if (typeof view === 'string') {
        send(req, res, 200, view);
        return;
      }
      const status = view && Number.isInteger(view.status) ? /** @type {number} */ (view.status) : 200;
      const body = view && typeof view.body === 'string' ? view.body : '';
      send(req, res, status, body, view && view.headers ? view.headers : {});
    } catch (error) {
      logger(error);
      if (!res.headersSent) {
        send(req, res, 500, boundaryPage('Something went wrong', 'The page could not be rendered.'));
      } else {
        res.end();
      }
    }
  };
}

/**
 * Start the loopback dashboard server on an ephemeral port.
 *
 * @param {object} options
 * @param {ViewHandler} options.handler Injected view handler.
 * @param {(error: unknown) => void} [options.logger]
 * @param {number} [options.maxUrlLength]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} The real
 *   listening URL on 127.0.0.1 and a close function that is safe to call
 *   more than once.
 */
export async function createServer(/** @type {{ handler: ViewHandler, logger?: (error: unknown) => void, maxUrlLength?: number }} */ options) {
  const { handler, logger, maxUrlLength } = options ?? {};
  if (typeof handler !== 'function') throw new TypeError('createServer requires a view handler function');
  const requestHandler = createRequestHandler({ handler, logger, maxUrlLength });
  const server = http.createServer((req, res) => {
    void requestHandler(req, res);
  });
  server.on('connection', (socket) => {
    if (!isLoopbackAddress(socket.remoteAddress)) socket.destroy();
  });
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => resolve(undefined));
  }));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return /** @type {Promise<void>} */ (new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }));
  };
  return { url: `http://${LOOPBACK_HOST}:${port}`, close };
}
