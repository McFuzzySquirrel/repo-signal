import { documentShell, escapeText } from './html.js';

/**
 * The three pages the dashboard routes: the index, the repository list, and
 * the repository detail at `/repo/{owner}/{name}` with optional ISO-day
 * `from`/`to` query parameters. Renderers are injected by the caller — the
 * router never imports a view module — and the page data layer is composed
 * inside those injected renderers, not here.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {object} PageContext
 * @property {'index' | 'list' | 'detail'} route
 * @property {string | null} owner Repository owner, detail route only.
 * @property {string | null} name Repository name, detail route only.
 * @property {string | null} from Validated ISO day or null.
 * @property {string | null} to Validated ISO day or null.
 * @property {{ index: string, list: string, detail: (owner: string, name: string) => string }} links
 *   Generated links that always carry the selected repository and range.
 */

/**
 * @typedef {(ctx: PageContext) => (string | Promise<string>)} PageRenderer
 */

/**
 * @typedef {object} RouterViews
 * @property {PageRenderer} index
 * @property {PageRenderer} list
 * @property {PageRenderer} detail
 */

/**
 * @param {string} value
 * @returns {boolean} True only for a real calendar day in ISO `YYYY-MM-DD`
 *   form — a malformed value is never coerced.
 */
export function isIsoDay(value) {
  if (!ISO_DAY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Validate the day range query parameters. Malformed days are rejected,
 * not coerced; an inverted range names the inversion.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{ from: string | null, to: string | null } | { error: string }}
 */
export function parseRange(searchParams) {
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (from !== null && !isIsoDay(from)) {
    return { error: `Malformed day for "from": "${from}". Expected an ISO day such as 2026-01-31.` };
  }
  if (to !== null && !isIsoDay(to)) {
    return { error: `Malformed day for "to": "${to}". Expected an ISO day such as 2026-01-31.` };
  }
  if (from !== null && to !== null && from > to) {
    return { error: `Inverted range: from ${from} is later than to ${to}.` };
  }
  return { from, to };
}

/**
 * Build the links the views emit: every one carries the selected range, and
 * a detail link carries the repository, so a page stays bookmarkable.
 *
 * @param {string | null} from
 * @param {string | null} to
 */
function buildLinks(from, to) {
  const params = new URLSearchParams();
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  const query = params.toString();
  const suffix = query === '' ? '' : `?${query}`;
  return {
    index: '/',
    list: `/repos${suffix}`,
    detail: (/** @type {string} */ owner, /** @type {string} */ name) =>
      `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`
  };
}

/**
 * @param {number} status
 * @param {string} title
 * @param {string} message
 */
function problemPage(status, title, message) {
  return {
    status,
    body: documentShell({
      title: `${title} - RepoSignal`,
      body: `<h1>${escapeText(title)}</h1>\n<p>${escapeText(message)}</p>`
    })
  };
}

/**
 * Create the request handler the server factory mounts. The handler maps a
 * request to one of the three injected renderers, validates the range before
 * any data access, and renders 400/404 problems through the shared shell.
 *
 * @param {object} options
 * @param {RouterViews} options.views Injected renderers, one per route.
 * @param {(owner: string, name: string) => (boolean | Promise<boolean>)} options.hasRepository
 *   Whether the repository is known; an absent one is a 404, never an empty page.
 * @returns {(req: import('node:http').IncomingMessage) => Promise<{ status: number, body: string }>}
 */
export function createRouter({ views, hasRepository }) {
  if (!views || typeof views.index !== 'function' || typeof views.list !== 'function' || typeof views.detail !== 'function') {
    throw new TypeError('createRouter requires index, list and detail view renderers');
  }
  if (typeof hasRepository !== 'function') throw new TypeError('createRouter requires a hasRepository predicate');

  return async function route(req) {
    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    /** @type {URL} */
    let url;
    try {
      url = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      return problemPage(400, 'Bad request', 'The request URL could not be parsed.');
    }
    const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;

    if (path === '/') {
      const range = parseRange(url.searchParams);
      if ('error' in range) return problemPage(400, 'Invalid range', range.error);
      const body = await views.index({ route: 'index', owner: null, name: null, from: range.from, to: range.to, links: buildLinks(range.from, range.to) });
      return { status: 200, body };
    }

    if (path === '/repos') {
      const range = parseRange(url.searchParams);
      if ('error' in range) return problemPage(400, 'Invalid range', range.error);
      const body = await views.list({ route: 'list', owner: null, name: null, from: range.from, to: range.to, links: buildLinks(range.from, range.to) });
      return { status: 200, body };
    }

    const detailMatch = /^\/repo\/([^/]+)\/([^/]+)$/.exec(path);
    if (detailMatch) {
      let owner, name;
      try {
        owner = decodeURIComponent(detailMatch[1]);
        name = decodeURIComponent(detailMatch[2]);
      } catch {
        return problemPage(400, 'Bad request', 'The repository path is not valid percent-encoding.');
      }
      const range = parseRange(url.searchParams);
      if ('error' in range) return problemPage(400, 'Invalid range', range.error);
      if (!(await hasRepository(owner, name))) {
        return problemPage(404, 'Unknown repository', `No repository named ${owner}/${name} is enrolled.`);
      }
      const body = await views.detail({ route: 'detail', owner, name, from: range.from, to: range.to, links: buildLinks(range.from, range.to) });
      return { status: 200, body };
    }

    return problemPage(404, 'Not found', `No page matches ${path}.`);
  };
}
