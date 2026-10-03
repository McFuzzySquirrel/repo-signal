import { findRepository } from '../repo-data.js';
import { isIsoDay } from '../router.js';
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
 * The renderer list below is the whole of the mount table: a new route is a new
 * `read`/`render` pair here, and the router's own route table is server-engineer's
 * to extend separately.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../router.js').PageContext} PageContext */
/** @typedef {import('../router.js').RouterViews} RouterViews */

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
 * renders it. The read is called with the open archive, the clock and the resolved
 * window; the render function receives only the route context and that data, so it
 * stays a function of its arguments and nothing else.
 *
 * @typedef {object} ViewMount
 * @property {(options: { db: Database, clock: () => number, range: ResolvedRange }) => unknown} read
 * @property {(ctx: PageContext, data: any) => string} render
 */

/**
 * The mount table: route to the page that answers it. This is the one list a new
 * page is added to.
 *
 * `detail` currently answers with the repository list and says so on the page,
 * because this build has no per-repository detail page yet. A detail URL that names
 * an enrolled repository still gets 200 and a page rather than an error, and the
 * page states that the whole enrolled set is shown instead.
 *
 * @type {Readonly<Record<typeof ROUTE_INDEX|typeof ROUTE_LIST|typeof ROUTE_DETAIL, ViewMount>>}
 */
export const VIEW_MOUNT_TABLE = Object.freeze({
  [ROUTE_INDEX]: Object.freeze({ read: readIndexPage, render: renderIndexPage }),
  [ROUTE_LIST]: Object.freeze({ read: readRepositoryListPage, render: renderRepositoryListPage }),
  [ROUTE_DETAIL]: Object.freeze({ read: readRepositoryListPage, render: renderRepositoryListPage }),
});

/**
 * The registry the router mounts, together with the identity predicate it asks
 * before a detail page runs.
 *
 * Every renderer takes the route context alone, as the router calls it. The data
 * is read here - through the archive's own page read and the health read the CLI
 * shares - and handed to the pure render function, so a view module never opens the
 * archive itself and can never disagree with the CLI about a repository's state.
 *
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {() => number} [options.clock] Epoch milliseconds the health read is judged against.
 * @param {string} options.today Reference UTC day a route with no bound resolves to.
 * @returns {{ views: RouterViews, hasRepository: (owner: string, name: string) => boolean,
 *   routes: readonly string[], mounts: Readonly<Record<string, ViewMount>> }}
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
    const data = entry.read({ db, clock, range });
    return entry.render(ctx, data);
  };

  /** @type {RouterViews} */
  const views = {
    [ROUTE_INDEX]: (ctx) => mount(ROUTE_INDEX, ctx),
    [ROUTE_LIST]: (ctx) => mount(ROUTE_LIST, ctx),
    [ROUTE_DETAIL]: (ctx) => mount(ROUTE_DETAIL, ctx),
  };

  return {
    views,
    // The router asks the archive, not a view, whether an identity is enrolled: a
    // repository that does not exist is a 404, never an empty page.
    hasRepository: (owner, name) => findRepository(db, owner, name) !== null,
    routes: VIEW_ROUTES,
    mounts: VIEW_MOUNT_TABLE,
  };
}