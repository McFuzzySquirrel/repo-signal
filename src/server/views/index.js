import { escapeUrl } from '../html.js';
import { findRepository } from '../repo-data.js';
import { isIsoDay } from '../router.js';
import {
  readRepositoryDetailPage, renderRepositoryDetailPage,
} from './repo-detail.js';
import { HEALTH_PAGE_PATH, readCollectionHealthPage, renderCollectionHealthPage } from './health.js';
import {
  readIndexPage, readRepositoryListPage, renderIndexPage, renderRepositoryListPage,
} from './repo-list.js';

/**
 * The composition root for every page: the one file that decides which module
 * answers which route.
 *
 * The router knows the three routes and refuses an unknown repository before any
 * view runs; the server knows loopback and the security headers; the page read
 * knows what the archive holds. Nothing here decides any of that. This module only
 * joins them: it resolves the window a page is about, reads the data that page
 * needs through the layer that owns it, and hands it to a pure render function.
 *
 * Adding a page is a change in this file plus its own view module, and nothing else.
 * There are two mount tables and both are here: {@link VIEW_MOUNT_TABLE} holds the
 * three routes the router dispatches, and {@link VIEW_PATH_TABLE} holds the pages the
 * dashboard serves at a path the router does not name - the collection health page
 * today. The router's own route table is server-engineer's and is never edited from
 * here.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../router.js').PageContext} PageContext */
/** @typedef {import('../router.js').RouterViews} RouterViews */
/** @typedef {import('./health.js').HealthPageContext} HealthPageContext */

/** The three routes the dashboard serves, in the order the route table declares them. */
export const ROUTE_INDEX = /** @type {const} */ ('index');
export const ROUTE_LIST = /** @type {const} */ ('list');
export const ROUTE_DETAIL = /** @type {const} */ ('detail');

/** Every route a view is mounted for. */
export const VIEW_ROUTES = /** @type {readonly (typeof ROUTE_INDEX|typeof ROUTE_LIST|typeof ROUTE_DETAIL)[]} */ (
  Object.freeze([ROUTE_INDEX, ROUTE_LIST, ROUTE_DETAIL]));

/**
 * The name of a route a view is mounted for. The mount table is keyed by it, so a
 * route with no mount entry is a naming mistake rather than a silent absence.
 * @typedef {typeof ROUTE_INDEX|typeof ROUTE_LIST|typeof ROUTE_DETAIL} RouteName
 */

/**
 * How many days the default window covers when a route carries no bound. Fourteen
 * is the traffic window GitHub itself serves, so a bare URL shows the days the
 * vendor is still answering for rather than a window nobody chose. It is this
 * module's policy because the page read refuses a range missing a bound, and
 * resolving it here keeps the reader from inventing one.
 */
export const DEFAULT_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * The window a page resolved. A route may carry one bound, neither, or a first day
 * later than its last; the first two are resolved here and the third is refused in
 * words rather than rendered, because a page that resolved an inverted range would
 * show numbers no URL reproduces.
 *
 * @typedef {object} ResolvedRange
 * @property {string} from First day, ISO `YYYY-MM-DD`.
 * @property {string} to Last day, inclusive, ISO `YYYY-MM-DD`.
 * @property {string|null} refusal One sentence naming why no window was resolved, or null.
 */

/**
 * @param {string} day ISO day.
 * @param {number} offset Days to add; may be negative.
 * @returns {string} The shifted day, without reading a clock.
 */
function shiftDay(day, offset) {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(time)) throw new TypeError(`A page needs a real ISO day, not ${JSON.stringify(day)}`);
  return new Date(time + offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Resolve the window a route is about.
 *
 * A bound the URL carried is kept exactly as the router validated it. A bound it
 * did not carry is filled from this module's policy: the window ends on `today` and
 * covers {@link DEFAULT_WINDOW_DAYS} ending there. A resolved window whose first day
 * is later than its last - only reachable when a route carried a first day beyond
 * today and no last day - is reported in words rather than rendered.
 *
 * @param {PageContext} ctx
 * @param {string} today Reference UTC day this registry was built for.
 * @returns {ResolvedRange}
 */
export function resolvePageRange(ctx, today) {
  if (!isIsoDay(today)) {
    throw new TypeError(`A page range needs a real ISO day such as 2026-01-31, not ${JSON.stringify(today)}`);
  }
  const to = ctx.to ?? today;
  const from = ctx.from ?? shiftDay(to, -(DEFAULT_WINDOW_DAYS - 1));
  if (from > to) {
    return {
      from,
      to,
      refusal: `No window covers ${from} to ${to}: the first day is later than the last, so no repository is `
        + `shown. Choose a first day that is not after ${to}, or omit the range to use the default window.`,
    };
  }
  return { from, to, refusal: null };
}

/**
 * One mounted page: the read that produces its data and the pure function that
 * renders it. The read is called with the open archive, the clock, the resolved
 * window and the route context, and the render function receives only the context
 * and that data, so it stays a function of its arguments and nothing else.
 *
 * The context and the reference day travel to the read because the detail page needs
 * both: it reads one repository named by the route, and it passes `today` on so the
 * provenance read answers its connected-today question without reading the wall clock
 * inside a function whose output has to be reproducible. A read that needs neither -
 * the index and the list - ignores them.
 *
 * @typedef {object} ViewMount
 * @property {(options: ViewReadOptions) => unknown} read
 * @property {(ctx: PageContext, data: any) => string} render
 */

/**
 * @typedef {object} ViewReadOptions
 * @property {Database} db Open archive; the caller owns closing it.
 * @property {() => number} clock Epoch milliseconds the health read is judged against.
 * @property {ResolvedRange} range The window the page resolved.
 * @property {PageContext} ctx The route context, naming the repository on the detail route.
 * @property {string} today Reference UTC day this registry was built for.
 */

/**
 * The mount table: route to the page that answers it. This is the one list a new
 * page is added to.
 *
 * `detail` is answered by the repository detail page: the per-repository charts,
 * comparisons, captures, collection state and provenance boundary, composed in
 * `./repo-detail.js` from the modules the earlier features built. Before that page
 * existed the detail route degraded to the list, and it says so on the page rather
 * than erroring; that degradation is gone now that there is something better to show.
 *
 * @type {Readonly<Record<typeof ROUTE_INDEX|typeof ROUTE_LIST|typeof ROUTE_DETAIL, ViewMount>>}
 */
export const VIEW_MOUNT_TABLE = Object.freeze({
  [ROUTE_INDEX]: Object.freeze({ read: readIndexPage, render: renderIndexPage }),
  [ROUTE_LIST]: Object.freeze({ read: readRepositoryListPage, render: renderRepositoryListPage }),
  [ROUTE_DETAIL]: Object.freeze({ read: readRepositoryDetailPage, render: renderRepositoryDetailPage }),
});

/**
 * The name of the collection health page. It is a route in its own right - the
 * repository list, the detail page and this page are three answers to three questions -
 * but it is not one of the three routes the router dispatches, so it is named here
 * rather than added to {@link VIEW_ROUTES}.
 * @typedef {'health'} HealthRouteName
 */

/**
 * One page mounted at a path the router's own route table does not name.
 *
 * The router owns `/`, `/repos` and `/repo/{owner}/{name}` and refuses anything else
 * with a 404; that table is server-engineer's, so this registry does not extend it. A
 * page the dashboard serves at its own path - the collection health page today, the
 * theme stylesheet route in RS-UI-04 - is mounted here instead, and
 * {@link createViewRegistry}'s `answerOwnRoutes` answers these paths in front of the
 * router. The page owns the path it is served from, so a page added here needed no
 * change anywhere else.
 *
 * @typedef {object} ViewPathMount
 * @property {string} path The absolute path this page answers, exactly.
 * @property {HealthRouteName} route The route name this page is mounted for.
 * @property {(options: { db: Database, clock: () => number }) => unknown} read
 * @property {(ctx: HealthPageContext, data: any) => string} render
 */

/**
 * Every page this registry mounts at a path of its own. This list is the whole of that
 * mount table, exactly as {@link VIEW_MOUNT_TABLE} is the whole of the router's.
 *
 * @type {readonly ViewPathMount[]}
 */
export const VIEW_PATH_TABLE = Object.freeze([
  Object.freeze({
    path: HEALTH_PAGE_PATH,
    route: /** @type {const} */ ('health'),
    read: readCollectionHealthPage,
    render: renderCollectionHealthPage,
  }),
]);

/**
 * The context a page mounted at a path of its own is rendered with.
 *
 * The router builds its own context for the routes it dispatches, carrying the day
 * range the URL selected. A registry-mounted page gets the same shape with no
 * repository and no range: the collection health page reads the archive's recorded
 * collection state, which has no day dimension, so there is no window here for a range
 * to select and nothing a reader could mistake for a measurement of one.
 *
 * @param {HealthRouteName} route
 * @returns {import('./health.js').HealthPageContext}
 */
function ownPageContext(route) {
  return {
    route,
    owner: null,
    name: null,
    from: null,
    to: null,
    links: {
      index: '/',
      list: '/repos',
      detail: (/** @type {string} */ owner, /** @type {string} */ name) =>
        `/repo/${escapeUrl(owner)}/${escapeUrl(name)}`,
    },
  };
}

/**
 * The registry the router mounts, together with the identity predicate it asks
 * before a detail page runs.
 *
 * Every renderer takes the route context alone, as the router calls it. The data
 * is read here - through the archive's own page read and the health read the CLI
 * shares - and handed to the pure render function, so a view module never opens the
 * archive itself and can never disagree with the CLI about a repository's state.
 *
 * `answerOwnRoutes` is what the `serve` command mounts in front of the router: the
 * pages in {@link VIEW_PATH_TABLE} are served from here rather than from the router's
 * route table, which the router's owner extends separately.
 *
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {() => number} [options.clock] Epoch milliseconds the health read is judged against.
 * @param {string} options.today Reference UTC day a route with no bound resolves to.
 * @returns {{ views: RouterViews, hasRepository: (owner: string, name: string) => boolean,
 *   routes: readonly string[], mounts: Readonly<Record<string, ViewMount>>,
 *   paths: readonly ViewPathMount[], healthPath: string,
 *   answerOwnRoutes: (next: (req: import('node:http').IncomingMessage) => Promise<{status: number, body: string}>)
 *     => (req: import('node:http').IncomingMessage) => Promise<{status: number, body: string}> }}
 */
export function createViewRegistry({ db, clock = Date.now, today }) {
  if (!db) throw new TypeError('The view registry needs an open archive');
  if (typeof clock !== 'function') throw new TypeError('The view registry needs a clock returning epoch milliseconds');
  if (!isIsoDay(today)) {
    throw new TypeError(`The view registry needs today as an ISO day such as 2026-01-31, not ${JSON.stringify(today)}`);
  }

  /**
   * Read what one route's page needs and render it. Both halves are the mounted
   * pair's, so a route's data layer and its markup cannot drift apart.
   * @param {RouteName} route
   * @param {PageContext} ctx
   * @returns {string}
   */
  const mount = (route, ctx) => {
    const entry = VIEW_MOUNT_TABLE[route];
    const range = resolvePageRange(ctx, today);
    const data = entry.read({ db, clock, range, ctx, today });
    return entry.render(ctx, data);
  };

  /** @type {RouterViews} */
  const views = {
    [ROUTE_INDEX]: (ctx) => mount(ROUTE_INDEX, ctx),
    [ROUTE_LIST]: (ctx) => mount(ROUTE_LIST, ctx),
    [ROUTE_DETAIL]: (ctx) => mount(ROUTE_DETAIL, ctx),
  };

  /**
   * Answer the paths in {@link VIEW_PATH_TABLE} and hand every other request to `next`.
   *
   * The router keeps ownership of the three routes it dispatches and of every status
   * it returns: this wrapper only recognises a path the registry itself mounted, and
   * anything it does not recognise - including a URL it cannot parse, which the router
   * answers with its own 400 - goes straight through. A trailing slash is folded the
   * same way the router folds it, so `/health/` and `/health` are one page.
   *
   * @param {(req: import('node:http').IncomingMessage) => Promise<{status: number, body: string}>} next
   *   The router's handler, or anything with that shape.
   * @returns {(req: import('node:http').IncomingMessage) => Promise<{status: number, body: string}>}
   *   A handler the server factory can mount in place of `next` alone.
   */
  const answerOwnRoutes = (next) => async (req) => {
    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    /** @type {URL} */
    let url;
    try {
      url = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      return next(req);
    }
    const path = url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;
    const entry = VIEW_PATH_TABLE.find((candidate) => candidate.path === path);
    if (entry === undefined) return next(req);
    const data = entry.read({ db, clock });
    return { status: 200, body: entry.render(ownPageContext(entry.route), data) };
  };

  return {
    views,
    // The router asks the archive, not a view, whether an identity is enrolled: a
    // repository that does not exist is a 404, never an empty page.
    hasRepository: (owner, name) => findRepository(db, owner, name) !== null,
    routes: VIEW_ROUTES,
    mounts: VIEW_MOUNT_TABLE,
    paths: VIEW_PATH_TABLE,
    healthPath: HEALTH_PAGE_PATH,
    answerOwnRoutes,
  };
}