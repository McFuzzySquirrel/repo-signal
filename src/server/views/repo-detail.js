import { STARS_METRIC } from '../../backfill/stars.js';
import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../../collect/traffic.js';
import { changeList } from '../../insight/changes.js';
import { sevenDayDelta } from '../../insight/deltas.js';
import { starsVersusClonesDivergence } from '../../insight/divergence.js';
import { TRAFFIC_PERMISSION } from '../../supervision/errors.js';
import { renderLineChart } from '../../views/components/line-chart.js';
import { documentShell, escapeAttribute, escapeText, escapeUrl } from '../html.js';
import {
  PAGE_STATUS_KNOWN, readRepositoryPage,
} from '../repo-data.js';

/**
 * The repository detail page: the answer the maintainer came for, in the section
 * order the legibility review recorded.
 *
 * This module is the composition point the earlier features were waiting for. The
 * page data layer (`src/server/repo-data.js`) reads the archive, the chart component
 * (`src/views/components/line-chart.js`) draws a series with its gaps intact, and the
 * three insight modules (`deltas.js`, `divergence.js`, `changes.js`) compute the
 * comparisons as pure functions over stored days. This module is where they meet a
 * reader: it decides what is said, in what order, and as text.
 *
 * Six rules decide what the page is allowed to say, and each of them is asserted by a
 * test rather than trusted to review.
 *
 * 1. **The reviewed order is the page.** The sections appear as
 *    {@link DETAIL_SECTION_ORDER} lists them: the current absolute numbers, then
 *    acquisition, then interest, then the comparison with the previous week, then
 *    clones against stars, then what changed, then the discovery captures, then the
 *    recorded collection state, then the provenance boundary. The order is exported
 *    as data rather than remembered, because an order that exists only in a template
 *    cannot be asserted.
 * 2. **An absolute value leads, and a percentage never replaces one.** Every number
 *    the page shows is a stored count or a total of stored counts with the count of
 *    days it sums beside it. A per-day unique is shown for one named day, never
 *    added up, because summing it counts one person more than once.
 * 3. **A missing day is a gap, in the picture and in the text.** The window comes
 *    from the range rather than from the stored rows, so a hole at either edge is
 *    drawn as a break and named as a calendar day. Nothing here converts a day the
 *    archive does not hold into a zero, interpolates across it, carries it forward or
 *    fills it from another metric.
 * 4. **Nothing stored is a first-connect state, never an axes-only chart.** A
 *    repository the archive records as never collected gets the first-connect wording
 *    naming the permission and the next step, and no figure at all. A window that
 *    simply holds no stored day - a range before collection began - gets its own
 *    wording naming the boundary, which is a different fact with a different remedy.
 * 5. **The insight modules' reasoning is mounted, never rewritten.** A delta, a
 *    divergence and a change list are rendered from the sentences those functions
 *    wrote, with their numbers beside them. An insufficient result is displayed as
 *    itself: its own sentence, its own missing days, no substituted figure.
 * 6. **A state is a word and a sentence.** The collection state is the health read's
 *    own word and reason - the same ones the CLI prints - and a failure's next step is
 *    the classifier's own action sentence. No colour, badge or icon carries any of
 *    it, so a page stripped of every class attribute still says what state the
 *    repository is in.
 *
 * Every render function is pure: no clock, no I/O, no randomness, and identical input
 * produces identical bytes. Every dynamic value passes the shared helper for its own
 * context, so an identity whose stored spelling is markup reaches the page as text.
 * There is no script tag, no inline handler, no remote asset, no colour literal and no
 * motion anywhere in the output.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../router.js').PageContext} PageContext */
/** @typedef {import('./index.js').ResolvedRange} ResolvedRange */
/** @typedef {import('../repo-data.js').RepositoryPage} RepositoryPage */
/** @typedef {import('../repo-data.js').PageSeries} PageSeries */
/** @typedef {import('../repo-data.js').SnapshotCapture} SnapshotCapture */
/** @typedef {import('../../db/day-series-repo.js').DayFact} DayFact */
/** @typedef {import('../../db/ops-repo.js').Repository} Repository */
/** @typedef {import('../../db/snapshot-repo.js').Snapshot} Snapshot */
/** @typedef {import('../../backfill/provenance.js').Provenance} Provenance */
/** @typedef {import('../../supervision/health.js').RepositoryHealth} RepositoryHealth */
/** @typedef {import('../../insight/deltas.js').SufficientDelta} SufficientDelta */
/** @typedef {import('../../insight/deltas.js').InsufficientDelta} InsufficientDelta */
/** @typedef {import('../../insight/divergence.js').SufficientDivergence} SufficientDivergence */
/** @typedef {import('../../insight/divergence.js').InsufficientDivergence} InsufficientDivergence */
/** @typedef {import('../../insight/changes.js').SufficientChangeList} SufficientChangeList */
/** @typedef {import('../../insight/changes.js').InsufficientChangeList} InsufficientChangeList */

/** The page title suffix every page carries, so a browser tab and a history entry name the product. */
export const TITLE_SUFFIX = 'RepoSignal';

/**
 * The sections of the detail page, in the order the legibility review recorded and
 * `docs/features/dashboard-views.md` §4 states: the answer the maintainer came for
 * first, then the series behind it, then the comparisons, then what changed, then
 * discovery, then the recorded state, then where the evidence begins.
 *
 * This list is the page's structure as data. `tests/views/repo-detail.test.js`
 * asserts the rendered `h2` sequence against it, so a section that moves, is renamed
 * or is dropped fails rather than being noticed by eye - which is what happened on the
 * detail route before this page existed.
 *
 * @type {readonly string[]}
 */
export const DETAIL_SECTION_ORDER = Object.freeze([
  'current-numbers',
  'acquisition',
  'interest',
  'comparison',
  'clones-against-stars',
  'changes',
  'captures',
  'collection-state',
  'provenance',
]);

/** The heading each section carries, keyed by the section key above. */
const SECTION_HEADINGS = Object.freeze({
  'current-numbers': 'Current numbers, absolute values first',
  'acquisition': 'Acquisition',
  'interest': 'Interest',
  'comparison': 'Comparison with the previous week',
  'clones-against-stars': 'Clones against stars',
  'changes': 'What changed',
  'captures': 'Referrers and popular paths',
  'collection-state': 'Collection state',
  'provenance': 'Where collected history begins',
});

/**
 * The four metrics this page charts, split into the two groups the archive itself
 * distinguishes. A clone is a clone and a view is a view: the page names the event it
 * is counting and never calls either of them adoption, reach or engagement.
 *
 * The two weekly development metrics the archive also stores are deliberately absent.
 * They are week buckets, and plotting a week on a day axis is the same mistake as
 * writing a zero for an unmeasured day - a value read at the wrong resolution. Their
 * stars figure appears in the clones-against-stars comparison, which is the reading
 * the divergence module computes over collected days.
 *
 * @typedef {object} DetailChart
 * @property {string} metric The archive's own metric key.
 * @property {'acquisition'|'interest'} group The section the chart belongs to.
 * @property {string} label The metric in a reader's words.
 * @property {string} valueLabel The value column's heading.
 * @property {string} basis What one stored value counts, so the number is not read as
 *   more than it is.
 * @property {'sum'|'last'} kind How the stored days become the current-number reading:
 *   `sum` for a count of events, `last` for a per-day unique.
 * @property {string} numberLabel The heading of that reading in the current-numbers table.
 */

/** @type {readonly Readonly<DetailChart>[]} */
export const DETAIL_CHARTS = Object.freeze([
  Object.freeze({
    metric: CLONES_METRIC, group: 'acquisition', label: 'Clones', valueLabel: 'Clones',
    basis: 'clone events recorded on the stored day', kind: 'sum',
    numberLabel: 'Clones, summed over stored days',
  }),
  Object.freeze({
    metric: UNIQUE_CLONERS_METRIC, group: 'acquisition', label: 'Unique cloners',
    valueLabel: 'Unique cloners', basis: 'distinct cloners on the stored day', kind: 'last',
    numberLabel: 'Unique cloners on the last stored day',
  }),
  Object.freeze({
    metric: VIEWS_METRIC, group: 'interest', label: 'Views', valueLabel: 'Views',
    basis: 'page views recorded on the stored day', kind: 'sum',
    numberLabel: 'Views, summed over stored days',
  }),
  Object.freeze({
    metric: UNIQUE_VISITORS_METRIC, group: 'interest', label: 'Unique visitors',
    valueLabel: 'Unique visitors', basis: 'distinct visitors on the stored day', kind: 'last',
    numberLabel: 'Unique visitors on the last stored day',
  }),
]);

/**
 * What a metric reading says when the archive holds no stored row for it in the range.
 * It is the page's own constant rather than an import from the list page: this module
 * holds no reference to that page, so the registry stays the only place a view is
 * mounted and each page owns the wording it renders.
 */
export const NO_STORED_VALUE_TEXT = 'no stored value in this range';

/**
 * The metrics the comparison with the previous week is computed over: the two counts
 * whose stored days are events and may be added. A per-day unique is left out of the
 * sum on purpose - seven daily unique-cloner counts are not seven days of distinct
 * people, and a difference between two such sums would be a number about nothing.
 */
const DELTA_METRICS = Object.freeze([
  Object.freeze({ metric: CLONES_METRIC, label: 'Clones' }),
  Object.freeze({ metric: VIEWS_METRIC, label: 'Views' }),
]);

/**
 * The metrics the change list walks: the four charted traffic metrics plus stars.
 * The weekly development buckets are left out for the same reason the charts leave
 * them out - a week bucket is not a day and would produce an entry dated to a day no
 * run measured.
 */
const CHANGE_METRICS = Object.freeze([
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, VIEWS_METRIC, UNIQUE_VISITORS_METRIC, STARS_METRIC,
]);

/**
 * What the page says instead of a chart when the archive holds no stored traffic day
 * for the repository at all. Two different facts reach it and they need different
 * remedies, so they are two different sentences rather than one "no data".
 */

/** The archive records no collection for this repository: a first-connect state. */
export const NO_TRAFFIC_FIRST_CONNECT = /** @type {const} */ ('first-connect');
/** The repository is collected, but this window holds no stored day of it. */
export const NO_TRAFFIC_EMPTY_WINDOW = /** @type {const} */ ('empty-window');

/** The next step a never-collected repository needs, naming the permission a run needs. */
export const FIRST_CONNECT_STEP = `A collection needs a token carrying the ${TRAFFIC_PERMISSION}; `
  + 'the next step is <code>node src/cli.js collect</code>, which stores this repository\'s first traffic days. '
  + 'Until a run records one, this page reports no number and draws no chart, because it has none.';

/**
 * One metric's stored days as the current-number section reads them. `value` is null -
 * never zero - when the archive holds no stored row for the metric in the range.
 *
 * @typedef {object} DetailReading
 * @property {string} metric
 * @property {'sum'|'last'} kind
 * @property {number|null} value
 * @property {number} storedDays
 * @property {string|null} lastDay
 */

/**
 * @typedef {object} DetailDelta
 * @property {string} metric
 * @property {string} label
 * @property {SufficientDelta|InsufficientDelta} reading
 */

/**
 * One recorded list capture, as the discovery section shows it: the instant the
 * archive recorded it and the entries of that capture. Captures are append-only and a
 * capture has no day dimension, so two captures of one list stay two captures here
 * rather than merging into one list that never existed.
 *
 * @typedef {object} DetailCapture
 * @property {string} runId
 * @property {string} collectedAt
 * @property {Snapshot[]} entries
 */

/**
 * @typedef {object} RepositoryDetailData
 * @property {ResolvedRange} range The window the page resolved, with any refusal in words.
 * @property {RepositoryPage|null} page The archive's own page read, or null when the
 *   window was refused before anything was read.
 * @property {string} repo `owner/name` as the archive holds it, for the heading.
 * @property {string} requested `owner/name` as the route asked for it.
 * @property {string} selfHref The page's own address for the resolved window.
 * @property {DetailReading[]} readings The current absolute numbers, in column order.
 * @property {number} rangeDays Days the window covers.
 * @property {string[]} gapDays Days in the window with no stored row for any traffic metric.
 * @property {'first-connect'|'empty-window'|undefined} noTrafficState Which of the two empty
 *   readings this is, absent when the archive holds at least one stored traffic day.
 * @property {DetailChart[]} charts One entry per charted metric, in section order.
 * @property {DetailDelta[]} deltas The comparison with the previous week, per additive metric.
 * @property {SufficientDivergence|InsufficientDivergence} divergence
 * @property {SufficientChangeList|InsufficientChangeList} changes
 * @property {DetailCapture[]} referrers Every stored referrer capture, newest first.
 * @property {DetailCapture[]} popularPaths Every stored popular-path capture, newest first.
 * @property {RepositoryHealth|null} health The supervision read, unmodified.
 * @property {Provenance|null} provenance The provenance read, unmodified.
 */

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} plural A plural that is not the singular plus `s`.
 * @returns {string}
 */
function counted(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * @param {readonly string[]} days
 * @returns {string} `a, b and c`, with a and b for two.
 */
function dayList(days) {
  if (days.length === 0) return '';
  if (days.length === 1) return days[0];
  if (days.length === 2) return `${days[0]} and ${days[1]}`;
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}

/**
 * @param {PageSeries[]} series
 * @param {string} metric
 * @returns {DayFact[]} Stored rows for one metric, oldest first.
 */
function rowsFor(series, metric) {
  const entry = series.find((candidate) => candidate.metric === metric);
  return entry === undefined ? [] : entry.rows;
}

/**
 * Read one metric's stored days and decide what a cell can honestly say. A metric
 * with no stored row reports null, which the cell renders as words: a zero here would
 * be a measurement of a day nobody measured.
 *
 * @param {PageSeries[]} series
 * @param {DetailChart} chart
 * @returns {DetailReading}
 */
function readMetric(series, chart) {
  const rows = rowsFor(series, chart.metric);
  const last = rows.length === 0 ? undefined : rows[rows.length - 1];
  if (last === undefined) {
    return { metric: chart.metric, kind: chart.kind, value: null, storedDays: 0, lastDay: null };
  }
  return {
    metric: chart.metric,
    kind: chart.kind,
    value: chart.kind === 'sum'
      ? rows.reduce((total, row) => total + row.value, 0)
      : last.value,
    storedDays: rows.length,
    lastDay: last.day,
  };
}

/**
 * The days in the window no charted metric has a stored row for. This is the union
 * across the four traffic metrics, and each reading carries its own stored-day count,
 * so a metric that missed a day the others kept stays visible.
 *
 * @param {PageSeries[]} series
 * @param {string[]} calendarDays
 * @returns {string[]}
 */
function unmeasuredDays(series, calendarDays) {
  const measured = new Set();
  for (const chart of DETAIL_CHARTS) {
    for (const row of rowsFor(series, chart.metric)) measured.add(row.day);
  }
  return calendarDays.filter((day) => !measured.has(day));
}

/**
 * Stored days as the chart component and the insight modules take them: the day, the
 * value, and the archive's own recorded source. A day with no stored value is absent
 * from the array entirely, never present with a zero standing in for it.
 *
 * @param {DayFact[]} rows
 * @returns {Array<{day: string, value: number, source: 'backfill'|'collected'}>}
 */
function observationsOf(rows) {
  return rows.map((row) => ({ day: row.day, value: row.value, source: row.source }));
}

/**
 * Every stored capture of one list, newest first.
 *
 * The archive returns captures oldest first, because that is the order they were
 * recorded in; a reader opening this page is asking what the most recent run saw, so
 * the page shows them the other way round. The reversal is the only ordering this
 * module applies, which is what keeps two renders of one archive byte-identical.
 *
 * @param {SnapshotCapture[]} captures
 * @returns {DetailCapture[]}
 */
function newestFirst(captures) {
  return [...captures]
    .reverse()
    .map((capture) => ({ runId: capture.runId, collectedAt: capture.collectedAt, entries: capture.entries }));
}

/**
 * The detail page's data: everything the sections below are rendered from, read
 * through the one page read the archive owns and the three insight modules that
 * compute over stored days.
 *
 * Nothing is summarised here and no reasoning is re-done. `page.health` and
 * `page.provenance` travel as their own reads returned them, so the state word and
 * the first collected day on this page are the ones the CLI and the charts use, and
 * the delta, divergence and change-list results are the modules' own output including
 * their insufficient-data variants.
 *
 * A window the registry refused reads nothing at all and carries no page: an inverted
 * range is refused before the first query, because an invalid range coming back as an
 * empty series is indistinguishable from a repository with no traffic - the finding
 * this product must never invent.
 *
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {() => number} options.clock Epoch milliseconds the health read is judged against.
 * @param {ResolvedRange} options.range The window the page resolved.
 * @param {PageContext} options.ctx The route context naming the repository.
 * @param {string} [options.today] Reference UTC day, so the provenance read's
 *   connected-today answer does not read the wall clock.
 * @returns {RepositoryDetailData}
 */
export function readRepositoryDetailPage({ db, clock, range, ctx, today }) {
  const requested = ctx.owner === null || ctx.name === null || ctx.owner === '' || ctx.name === ''
    ? 'not named by this URL'
    : `${ctx.owner}/${ctx.name}`;

  if (range.refusal !== null) {
    // Nothing has been read, so every reading on this page is absent rather than
    // empty. Each section says so in words and reports no number.
    return {
      range,
      page: null,
      repo: requested,
      requested,
      selfHref: '',
      readings: [],
      rangeDays: 0,
      gapDays: [],
      noTrafficState: NO_TRAFFIC_FIRST_CONNECT,
      charts: [...DETAIL_CHARTS],
      deltas: [],
      divergence: /** @type {InsufficientDivergence} */ ({
        status: /** @type {const} */ ('insufficient'),
        range: { from: range.from, to: range.to },
        reason: /** @type {const} */ ('below-minimum-volume'),
        requiredDays: 0, availableDays: 0, collectedDays: 0,
        pairedDays: [], missingDays: [], missingClonerDays: [], missingStarDays: [],
        summary: range.refusal,
      }),
      changes: /** @type {InsufficientChangeList} */ ({
        status: /** @type {const} */ ('insufficient'),
        reason: /** @type {const} */ ('below-minimum-volume'),
        range: { from: range.from, to: range.to },
        metrics: [], requiredDays: 0, availableDays: 0, storedDays: 0, comparedPairs: 0,
        seriesCoverage: [],
        summary: range.refusal,
      }),
      referrers: [],
      popularPaths: [],
      health: null,
      provenance: null,
    };
  }

  const page = readRepositoryPage({
    db,
    owner: /** @type {string} */ (ctx.owner),
    name: /** @type {string} */ (ctx.name),
    from: range.from,
    to: range.to,
    clock,
    today,
  });

  if (page.status !== PAGE_STATUS_KNOWN) {
    // The router asks the archive before a view runs, so a 404 is its own answer. A
    // direct caller reaching this read anyway gets the same fact in words and no
    // number, rather than an empty series that reads as a quiet repository.
    return {
      range,
      page,
      repo: requested,
      requested,
      selfHref: '',
      readings: [],
      rangeDays: 0,
      gapDays: [],
      noTrafficState: NO_TRAFFIC_FIRST_CONNECT,
      charts: [...DETAIL_CHARTS],
      deltas: [],
      divergence: unknownDivergence(range, requested),
      changes: unknownChanges(range, requested),
      referrers: [],
      popularPaths: [],
      health: null,
      provenance: null,
    };
  }

  const repository = /** @type {Repository} */ (page.repository);
  const insightRange = { from: page.range.from, to: page.range.to };
  const observations = new Map(DETAIL_CHARTS
    .map((chart) => [chart.metric, observationsOf(rowsFor(page.series, chart.metric))]));
  const storedTrafficDays = new Set();
  for (const chart of DETAIL_CHARTS) {
    for (const row of rowsFor(page.series, chart.metric)) storedTrafficDays.add(row.day);
  }

  return {
    range,
    page,
    repo: `${repository.owner}/${repository.name}`,
    requested,
    // The page's own address for the window it resolved: the identity is
    // percent-encoded for a path segment and the whole reference attribute-escaped
    // below, so an owner or name carrying markup or a slash cannot leave the path.
    selfHref: `/repo/${escapeUrl(repository.owner)}/${escapeUrl(repository.name)}`
      + `?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`,
    readings: DETAIL_CHARTS.map((chart) => readMetric(page.series, chart)),
    rangeDays: page.calendarDays.length,
    gapDays: unmeasuredDays(page.series, page.calendarDays),
    // Which of the two empty readings this is, decided from the recorded evidence:
    // a repository the archive records as never collected needs a first connect, and
    // a collected repository whose window holds no stored day needs a wider range.
    noTrafficState: storedTrafficDays.size > 0 ? undefined
      : (page.provenance === null || page.provenance.state === 'not-connected'
        ? NO_TRAFFIC_FIRST_CONNECT
        : NO_TRAFFIC_EMPTY_WINDOW),
    charts: [...DETAIL_CHARTS],
    deltas: DELTA_METRICS.map((entry) => ({
      metric: entry.metric,
      label: entry.label,
      reading: sevenDayDelta({
        metric: entry.metric,
        observations: observations.get(entry.metric) ?? [],
        range: insightRange,
      }),
    })),
    divergence: starsVersusClonesDivergence({
      uniqueCloners: observations.get(UNIQUE_CLONERS_METRIC) ?? [],
      stars: observationsOf(rowsFor(page.series, STARS_METRIC)),
      range: insightRange,
    }),
    changes: changeList({
      series: CHANGE_METRICS.map((metric) => ({
        metric,
        observations: metric === STARS_METRIC
          ? observationsOf(rowsFor(page.series, STARS_METRIC))
          : (observations.get(/** @type {string} */ (metric)) ?? []),
      })),
      range: insightRange,
    }),
    referrers: newestFirst(page.captures.referrers),
    popularPaths: newestFirst(page.captures.popularPaths),
    health: page.health,
    provenance: page.provenance,
  };
}

/**
 * @param {ResolvedRange} range
 * @param {string} identity
 * @returns {InsufficientDivergence}
 */
function unknownDivergence(range, identity) {
  return {
    status: /** @type {const} */ ('insufficient'),
    range: { from: range.from, to: range.to },
    reason: /** @type {const} */ ('below-minimum-volume'),
    requiredDays: 0, availableDays: 0, collectedDays: 0,
    pairedDays: [], missingDays: [], missingClonerDays: [], missingStarDays: [],
    summary: `The archive holds no repository called ${identity}, so there are no stored days to compare.`,
  };
}

/**
 * @param {ResolvedRange} range
 * @param {string} identity
 * @returns {InsufficientChangeList}
 */
function unknownChanges(range, identity) {
  return {
    status: /** @type {const} */ ('insufficient'),
    reason: /** @type {const} */ ('below-minimum-volume'),
    range: { from: range.from, to: range.to },
    metrics: [], requiredDays: 0, availableDays: 0, storedDays: 0, comparedPairs: 0,
    seriesCoverage: [],
    summary: `The archive holds no repository called ${identity}, so there are no stored days to walk.`,
  };
}

/**
 * One labelled section with its own heading, so the page can be navigated by heading
 * and so the heading sequence is structural rather than remembered.
 *
 * @param {string} key A member of {@link DETAIL_SECTION_ORDER}.
 * @param {string} body
 * @returns {string}
 */
function section(key, body) {
  const heading = SECTION_HEADINGS[/** @type {keyof typeof SECTION_HEADINGS} */ (key)];
  return `<section class="detail-section detail-${escapeAttribute(key)}" data-section="${escapeAttribute(key)}" `
    + `aria-labelledby="${escapeAttribute(`${key}-heading`)}">`
    + `<h2 id="${escapeAttribute(`${key}-heading`)}">${escapeText(heading)}</h2>`
    + body
    + '</section>';
}

/**
 * @param {ResolvedRange} range
 * @returns {string}
 */
function rangeSentence(range) {
  return `from ${range.from} to ${range.to}`;
}

/**
 * The page's own address for the window it resolved. A bookmark that reproduces the
 * page is the difference between a URL and a claim, and this link is also the only
 * place the page names itself, so an identity carrying markup is percent-encoded here
 * exactly as it is in every other link the product emits.
 *
 * @param {RepositoryDetailData} data
 * @returns {string}
 */
function selfLink(data) {
  if (data.selfHref === '') return '';
  return '<p class="self-link">This page\'s own address for the selected range: '
    + `<a href="${escapeAttribute(data.selfHref)}">${escapeText(data.selfHref)}</a>.</p>`;
}

/**
 * The list page's address for the resolved window, so a reader can step back to every
 * enrolled repository over the same days rather than the window the URL happened to
 * carry.
 *
 * @param {ResolvedRange} range
 * @returns {string}
 */
function listHref(range) {
  return `/repos?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`;
}

/**
 * The sentence a number is allowed to carry beside itself.
 *
 * @param {DetailReading} reading
 * @param {number} rangeDays
 * @returns {string}
 */
function basisSentence(reading, rangeDays) {
  if (reading.value === null) return NO_STORED_VALUE_TEXT;
  return reading.kind === 'sum'
    ? `summed over ${counted(reading.storedDays, 'stored day', 'stored days')} of the ${rangeDays} in the range`
    : `on ${reading.lastDay}, the last day with a stored row; a per-day unique is never added up across days`;
}

/**
 * The current absolute numbers, as a table whose first data column is the value itself.
 *
 * @param {RepositoryDetailData} data
 * @returns {string}
 */
function currentNumbersTable(data) {
  const rows = data.readings.map((reading) => {
    const chart = DETAIL_CHARTS.find((entry) => entry.metric === reading.metric);
    const value = reading.value === null
      ? `<span class="figure figure-missing">${escapeText(NO_STORED_VALUE_TEXT)}</span>`
      : `<span class="figure">${escapeText(reading.value)}</span>`;
    return `<tr data-metric="${escapeAttribute(reading.metric)}" `
      + `data-state="${reading.value === null ? 'missing' : 'stored'}">`
      + `<th scope="row">${escapeText(chart?.numberLabel ?? reading.metric)}</th>`
      + `<td class="value">${value} `
      + `<span class="figure-note">${escapeText(basisSentence(reading, data.rangeDays))}</span></td>`
      + '</tr>';
  });
  const gaps = data.gapDays.length === 0
    ? '<p class="coverage">Every day in the range carries a stored row for at least one traffic metric.</p>'
    : `<p class="coverage" data-state="gap">${escapeText(counted(data.gapDays.length, 'day', 'days'))} of the `
      + `${data.rangeDays} in the range ${data.gapDays.length === 1 ? 'has' : 'have'} no stored row for any `
      + `traffic metric: ${escapeText(dayList(data.gapDays))}. `
      + `${data.gapDays.length === 1 ? 'That day is' : 'Those days are'} unmeasured, not zero.</p>`;
  return '<table class="current-numbers">'
    + `<caption>Current absolute numbers over ${escapeText(rangeSentence(data.range))}: the stored total of each `
    + 'counted metric and the single-day reading of each per-day unique, with the days each number is over. '
    + 'A day the archive does not hold appears in the coverage line below rather than inside a figure.</caption>'
    + '<thead><tr><th scope="col">Metric</th><th scope="col">Stored value and the days it is over</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table>`
    + gaps;
}

/**
 * The charts for one group, or the reason there is no chart.
 *
 * @param {RepositoryDetailData} data
 * @param {'acquisition'|'interest'} group
 * @returns {string}
 */
function chartGroup(data, group) {
  const charts = data.charts.filter((chart) => chart.group === group);
  const lead = group === 'acquisition'
    ? 'A clone is a copy of this repository made by someone else. The count below is of copies recorded on one '
      + 'stored day, not of people, and one day\'s count says nothing about another day\'s.'
    : 'A view is one recorded request for a page of this repository. A view is not a person, and a visitor is '
      + 'distinct only within the day it was counted.';
  return `<p class="section-lead">${escapeText(lead)}</p>`
    + charts.map((chart) => {
      const rows = data.page === null ? [] : rowsFor(data.page.series, chart.metric);
      if (rows.length === 0) return noChartState(data, chart, group);
      const provenance = data.page?.provenance ?? undefined;
      return `<h3 id="${escapeAttribute(`${chart.metric}-chart-heading`)}">${escapeText(chart.label)} `
        + `per stored day</h3>`
        + `<p class="chart-basis">One stored value is the ${escapeText(chart.basis)}. `
        + `The line is broken where the archive holds no day, and the table beside it names every such day.</p>`
        + renderLineChart({
          label: chart.label,
          observations: observationsOf(rows),
          calendarDays: data.page?.calendarDays,
          provenance,
          id: chart.metric,
          valueLabel: chart.valueLabel,
        });
    }).join('\n');
}

/**
 * What a chart section says when the archive holds no stored day for that metric: the
 * days the window covers, named as gaps, and never a figure. An axes-only chart would
 * read as a repository that measured nothing and reached zero, which is a claim the
 * archive does not support.
 *
 * @param {RepositoryDetailData} data
 * @param {DetailChart} chart
 * @param {'acquisition'|'interest'} group
 * @returns {string}
 */
function noChartState(data, chart, group) {
  const window = data.range.refusal === null
    ? rangeSentence(data.range)
    : `the range this page could not resolve (${rangeSentence(data.range)})`;
  const never = data.noTrafficState === NO_TRAFFIC_FIRST_CONNECT;
  const sentence = never
    ? `No collection has been recorded for this repository, so the archive holds no stored `
      + `${escapeText(chart.label)} value to plot. ${FIRST_CONNECT_STEP}`
    : `Collected history begins on ${escapeText(data.provenance?.firstCollectedDay ?? 'a day this window does not reach')}, `
      + `which is outside the selected window of ${escapeText(window)}, so this range holds no stored `
      + `${escapeText(chart.label)} value to plot. Choose a range that covers the boundary, or collect `
      + 'more days, rather than reading this empty chart as a count of zero.';
  return `<h3 id="${escapeAttribute(`${chart.metric}-chart-heading`)}">${escapeText(chart.label)} `
    + 'per stored day</h3>'
    + `<p class="no-chart-state" data-state="${escapeAttribute(data.noTrafficState ?? NO_TRAFFIC_EMPTY_WINDOW)}" `
    + `data-group="${escapeAttribute(group)}">${sentence} `
    + `${escapeText(counted(data.rangeDays, 'day', 'days'))} in the window carry no stored `
    + `${escapeText(chart.label)} value, and each of them is an unmeasured day rather than a zero.</p>`;
}

/**
 * The comparison with the previous week, mounted from `deltas.js`. The module's own
 * sentence is the heading of each row's reading, and its numbers sit beside it: an
 * absolute sum for each window first, then the difference, then the share of the
 * earlier window beside the number that share came from.
 *
 * @param {RepositoryDetailData} data
 * @returns {string}
 */
function comparisonPanel(data) {
  const rows = data.deltas.map((entry) => {
    const reading = entry.reading;
    if (reading.status === 'insufficient') {
      return `<tr data-metric="${escapeAttribute(entry.metric)}" data-status="insufficient">`
        + `<th scope="row">${escapeText(entry.label)}</th>`
        + `<td colspan="3" class="insufficient">${escapeText(reading.summary)}`
        + `${reading.missingDays.length === 0 ? '' : ` Days with no stored value: ${escapeText(dayList(reading.missingDays))}.`}`
        + '</td></tr>';
    }
    const share = reading.percentage === null
      ? `not reported, because the earlier window summed to ${reading.previous.sum}`
      : `${reading.percentage}% of ${reading.previous.sum}`;
    return `<tr data-metric="${escapeAttribute(entry.metric)}" data-status="sufficient">`
      + `<th scope="row">${escapeText(entry.label)}</th>`
      + `<td class="value">${escapeText(reading.previous.sum)}`
      + `<span class="figure-note">${escapeText(`${reading.previous.from} to ${reading.previous.to}`)}</span></td>`
      + `<td class="value">${escapeText(reading.current.sum)}`
      + `<span class="figure-note">${escapeText(`${reading.current.from} to ${reading.current.to}`)}</span></td>`
      + `<td class="value">${escapeText(reading.change)}`
      + `<span class="figure-note">${escapeText(share)}</span>`
      + `<span class="figure-note">${escapeText(reading.summary)}</span></td>`
      + '</tr>';
  });
  return '<p class="section-lead">Two complete seven-day windows, taken from the selected range rather than from today, '
    + 'so the comparison is reproducible from the URL. Only the two counted metrics appear: seven daily '
    + 'unique-cloner counts are not seven days of distinct people, so no window over them is added up here.</p>'
    + '<table class="comparison">'
    + '<caption>Stored totals for the later seven-day window and the seven days before it, with the difference '
    + 'between them. Every figure is a stored total over stored days.</caption>'
    + '<thead><tr><th scope="col">Metric</th>'
    + '<th scope="col">Earlier window total</th><th scope="col">Later window total</th>'
    + '<th scope="col">Difference, the share of the earlier total, and the reading in words</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table>`;
}

/**
 * Clones against stars, mounted from `divergence.js`: two absolute numbers with the
 * days they belong to, which is larger as data, and the ratio beside the star count
 * rather than instead of it. No verdict, and no word that turns a clone into adoption.
 *
 * @param {RepositoryDetailData} data
 * @returns {string}
 */
function divergencePanel(data) {
  const reading = data.divergence;
  const lead = '<p class="section-lead">A star is a bookmark someone left on GitHub and a clone is a copy they '
    + 'downloaded. They are different acts by possibly different people, so the two numbers are placed beside '
    + 'each other and neither is read as the other.</p>';
  if (reading.status === 'insufficient') {
    return `${lead}<p class="insight-summary" data-status="insufficient">${escapeText(reading.summary)}</p>`
      + `<p class="coverage">Days carrying a reading for both metrics: ${escapeText(reading.collectedDays)}. `
      + `Days in the range carrying neither: ${
        escapeText(reading.missingDays.length === 0 ? 'none' : dayList(reading.missingDays))
      }. No comparison is reported over fewer days than the reading needs.</p>`;
  }
  const ratio = reading.ratio === null
    ? `not reported, because the recorded star count is 0`
    : `${reading.ratio} unique-cloner day counts per star, ${reading.percentage}% of ${reading.stars}`;
  return `${lead}<p class="insight-summary" data-status="sufficient">${escapeText(reading.summary)}</p>`
    + '<table class="divergence">'
    + '<caption>The two absolute numbers the comparison is made from, and the difference between them.</caption>'
    + '<thead><tr><th scope="col">Number</th><th scope="col">Stored value</th>'
    + '<th scope="col">The days it belongs to</th></tr></thead><tbody>'
    + `<tr data-number="unique-cloners"><th scope="row">Unique-cloner day counts</th>`
    + `<td class="value">${escapeText(reading.uniqueCloners)}</td>`
    + `<td class="figure-note">${escapeText(reading.uniqueClonersBasis)} over `
    + `${escapeText(counted(reading.collectedDays, 'collected day', 'collected days'))}, from `
    + `${escapeText(reading.pairedDays[0] ?? '')} to ${escapeText(reading.pairedDays[reading.pairedDays.length - 1] ?? '')}. `
    + 'One cloner active on several days is counted once per day, so this is not a count of distinct people.</td></tr>'
    + `<tr data-number="stars"><th scope="row">Stars recorded</th>`
    + `<td class="value">${escapeText(reading.stars)}</td>`
    + `<td class="figure-note">the cumulative level recorded on ${escapeText(reading.starsDay)}.</td></tr>`
    + `<tr data-number="difference"><th scope="row">Difference</th>`
    + `<td class="value">${escapeText(reading.difference)}</td>`
    + `<td class="figure-note">${escapeText(ratio)}</td></tr>`
    + '</tbody></table>';
}

/**
 * What changed, mounted from `changes.js`: the flat dated list, each entry naming both
 * stored days, both stored values, the difference, and the unmeasured days between
 * them. An entry whose two stored days are not consecutive is labelled as such rather
 * than being presented as a day-to-day move.
 *
 * @param {RepositoryDetailData} data
 * @returns {string}
 */
function changePanel(data) {
  const reading = data.changes;
  const lead = '<p class="section-lead">Every stored day of every listed metric was compared with the previous '
    + 'stored day of that same metric. A day whose value repeats produces no entry, and a day nobody measured '
    + 'produces no entry either - it is named as a gap, never counted as a zero.</p>';
  if (reading.status === 'insufficient') {
    return `${lead}<p class="insight-summary" data-status="insufficient">${escapeText(reading.summary)}</p>`;
  }
  const rows = reading.entries.map((entry) => {
    const between = entry.missingDays.length === 0
      ? 'none: the two stored days are consecutive'
      : dayList(entry.missingDays);
    return `<tr data-metric="${escapeAttribute(entry.metric)}" data-day="${escapeAttribute(entry.date)}">`
      + `<th scope="row">${escapeText(entry.metric)}</th>`
      + `<td class="value">${escapeText(entry.newValue)}</td>`
      + `<td class="value">${escapeText(entry.change)}</td>`
      + `<td class="figure-note">${escapeText(entry.previousDate)}: ${escapeText(entry.previousValue)}</td>`
      + `<td class="figure-note">${escapeText(counted(entry.daysSincePrevious, 'day', 'days'))} between; `
      + `${escapeText(between)}</td></tr>`;
  });
  const cap = reading.capped
    ? `<p class="coverage" data-state="capped">The list is capped at ${escapeText(reading.maxEntries)} entries: `
      + `${escapeText(counted(reading.omittedEntries, 'difference is', 'differences are'))} counted but not listed. `
      + 'The list is not the whole history.</p>'
    : `<p class="coverage">All ${escapeText(reading.totalEntries)} differences the walk found are listed. `
      + `${escapeText(counted(reading.comparedPairs, 'day-to-day comparison was made', 'day-to-day comparisons were made'))}.</p>`;
  return `${lead}<p class="insight-summary" data-status="sufficient">${escapeText(reading.summary)}</p>`
    + '<table class="changes">'
    + '<caption>Every stored day whose value differed from the previous stored day of the same metric, ordered by '
    + 'absolute difference with the largest first.</caption>'
    + '<thead><tr><th scope="col">Metric</th><th scope="col">Stored value on the day</th>'
    + '<th scope="col">Difference</th><th scope="col">Previous stored day and value</th>'
    + '<th scope="col">Calendar days between, and the unmeasured days among them</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table>${cap}`;
}

/**
 * The two discovery lists. Every stored capture is shown with the instant the archive
 * recorded it and the run that recorded it, because a capture has no day dimension:
 * two captures of one list are two observations of the vendor answering, and merging
 * them would describe a list that never existed.
 *
 * @param {RepositoryDetailData} data
 * @returns {string}
 */
function capturePanel(data) {
  const lead = '<p class="section-lead">These are the vendor\'s own ranked lists, captured whole at collection '
    + 'time. They describe the repositories that referred traffic here and the pages they landed on; they are not '
    + 'a count of people and a capture is not a day.</p>';
  return lead
    + '<h3 id="referrers-heading">Referrers</h3>'
    + captureList(data.referrers, 'referrer')
    + '<h3 id="popular-paths-heading">Popular paths</h3>'
    + captureList(data.popularPaths, 'popular path');
}

/**
 * @param {DetailCapture[]} captures
 * @param {string} kind Singular name of one entry, for the empty wording.
 * @returns {string}
 */
function captureList(captures, kind) {
  if (captures.length === 0) {
    return `<p class="no-capture" data-state="absent">No ${escapeText(kind)} capture is stored for this `
      + `repository. An empty capture list means no run has recorded one, not that the ${escapeText(kind)} `
      + 'count is zero.</p>';
  }
  const rows = captures.flatMap((capture) => {
    if (capture.entries.length === 0) {
      return [`<tr data-captured-at="${escapeAttribute(capture.collectedAt)}" data-state="empty">`
        + `<th scope="row">${escapeText(capture.collectedAt)}</th>`
        + `<td class="figure-note">${escapeText(capture.runId)}</td>`
        + `<td class="figure-note">the capture recorded no entries</td></tr>`];
    }
    return capture.entries.map((entry) => captureRow(capture, entry));
  });
  return `<p class="capture-summary">${escapeText(counted(captures.length, 'capture', 'captures'))} stored, `
    + 'newest first.</p>'
    + '<table class="captures">'
    + `<caption>Every stored ${escapeText(kind)} capture with the instant it was recorded and the run that `
    + 'recorded it. Captures are append-only, so a repeated entry across two captures is two observations and is '
    + 'shown as two rows.</caption>'
    + '<thead><tr><th scope="col">Captured at</th><th scope="col">Run</th>'
    + '<th scope="col">Position</th><th scope="col">Label</th><th scope="col">Title</th>'
    + '<th scope="col">Count</th><th scope="col">Unique</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table>`;
}

/**
 * @param {DetailCapture} capture
 * @param {Snapshot} entry
 * @returns {string}
 */
function captureRow(capture, entry) {
  return `<tr data-captured-at="${escapeAttribute(capture.collectedAt)}" `
    + `data-run="${escapeAttribute(capture.runId)}" data-state="stored">`
    + `<td class="captured-at">${escapeText(capture.collectedAt)}</td>`
    + `<td class="figure-note">${escapeText(capture.runId)}</td>`
    + `<td class="figure-note">${escapeText(entry.position)}</td>`
    + `<th scope="row">${escapeText(entry.label)}</th>`
    + `<td class="figure-note">${escapeText(entry.title ?? 'no title recorded')}</td>`
    + `<td class="value">${escapeText(entry.count)}</td>`
    + `<td class="value">${escapeText(entry.uniques)}</td></tr>`;
}

/**
 * The recorded collection state, in the health read's own words. The state word and
 * the sentence are the ones the CLI prints, read from the same place, so this page
 * cannot report a different state than the command does.
 *
 * A next step is stated only where the recorded evidence supplies one: a repository
 * the read marks as needing re-authentication needs a token carrying the permission
 * the traffic endpoints require, and a stalled one names the success that has not been
 * repeated. A state with no recorded failure behind it gets no invented action.
 *
 * @param {RepositoryDetailData} data
 * @returns {string}
 */
function healthPanel(data) {
  const health = data.health;
  if (health === null) {
    return '<p class="state-sentence" data-state="unknown">The archive holds no supervision record for this '
      + 'repository, so no collection state can be reported.</p>';
  }
  const lastSuccess = health.lastSuccessAt === null
    ? 'no successful collection has been recorded'
    : `last successful collection ${health.lastSuccessAt}`;
  const failure = health.lastFailure === null
    ? 'No failure has been recorded against this repository.'
    : `Most recent failure, kind ${health.lastFailure.kind}, recorded ${health.lastFailure.recordedAt} by run `
      + `${health.lastFailure.runId}: ${health.lastFailure.message}`;
  const action = health.needsReauthentication
    ? `<p class="state-action" data-state="needs-re-authentication">A new token is the only thing that clears this `
      + `state. It needs the ${escapeText(TRAFFIC_PERMISSION)}, and reconnecting is what records the change.</p>`
    : health.stalled && health.lastSuccessAt !== null
      ? `<p class="state-action" data-state="stalled">Collection has stopped: the last successful collection was `
        + `${escapeText(health.lastSuccessAt)}. The days after it are gaps, not days with a value of zero.</p>`
      : '';
  return '<p class="section-lead">The state word below is the one the CLI prints, read from the same place, so this '
    + 'page cannot report a different state than the command does.</p>'
    + `<p class="state-sentence" data-state="${escapeAttribute(health.state)}">`
    + `<span class="state-word">${escapeText(health.state)}</span> `
    + `<span class="state-reason">${escapeText(health.reason)}</span></p>`
    + `<ul class="state-facts">`
    + `<li>${escapeText(lastSuccess)}.</li>`
    + `<li>${escapeText(counted(health.consecutiveFailures, 'consecutive recorded failure', 'consecutive recorded failures'))}.</li>`
    + `<li>${escapeText(failure)}</li>`
    + '</ul>'
    + action
    + `<p class="state-note">Lifecycle as the archive holds it: ${escapeText(health.lifecycle)}.</p>`;
}

/**
 * The provenance boundary: where collected evidence begins, which days were
 * reconstructed rather than collected, and what the window before the boundary is.
 * The first collected day comes from the archive's recorded stamp and never from the
 * earliest stored row, so it is stated here as the read returned it.
 *
 * @param {RepositoryDetailData} data
 * @returns {string}
 */
function provenancePanel(data) {
  const provenance = data.provenance;
  if (provenance === null) {
    return '<p class="provenance-state" data-state="unknown">The archive holds no provenance record for this '
      + 'repository, so no first collected day can be named.</p>';
  }
  const never = provenance.state === 'not-connected';
  const backfills = provenance.backfills.length === 0
    ? 'No backfill has been recorded for this repository.'
    : `Backfills recorded: ${provenance.backfills.map((backfill) =>
      `${backfill.kind} covering ${backfill.windowFrom} to ${backfill.windowTo}, completed ${backfill.collectedAt}`
      + (backfill.truncated ? ', a window shorter than a year' : '')).join('; ')}.`;
  const lead = never
    ? '<p class="first-connect-caption" data-state="first-connect">No collection has been recorded for this '
      + `repository, so there is no first collected day to mark. ${FIRST_CONNECT_STEP}</p>`
    : `<p class="provenance-caption" data-state="connected">Collected history begins on `
      + `<strong>${escapeText(provenance.firstCollectedDay ?? '')}</strong>, recorded at `
      + `${escapeText(provenance.firstCollectedAt ?? '')}. Clones and views before that day were not measured by a `
      + 'collection run: a day before the boundary is either reconstructed on first connect or absent, and never '
      + 'a small number.</p>';
  return `<p class="section-lead">Every charted day says in its own table whether the archive recorded it as `
    + 'Backfilled, as Collected, or as not recorded at all, so the boundary is stated in words and not only drawn '
    + 'as a marker.</p>'
    + lead
    + '<ul class="provenance-facts">'
    + `<li>Recorded state: ${escapeText(provenance.state)}.</li>`
    + `<li>${escapeText(backfills)}</li>`
    + `<li>${escapeText(provenance.connectedToday
      ? 'The first collected day is the reference day, so the archive holds one day of collected history so far.'
      : 'The first collected day is not the reference day.')}</li>`
    + '</ul>';
}

/**
 * The detail page.
 *
 * The order is {@link DETAIL_SECTION_ORDER}, every section carries its own heading,
 * and the page holds exactly one `main` landmark because the shared shell owns it.
 *
 * @param {PageContext} ctx
 * @param {RepositoryDetailData} data
 * @returns {string} A complete document.
 */
export function renderRepositoryDetailPage(ctx, data) {
  const refused = data.range.refusal;
  const refusal = refused === null ? '' : `<p class="range-refusal" data-state="refused">${escapeText(refused)}</p>`;
  const body = [
    `<h1>${escapeText(data.repo)}</h1>`,
    `<p class="range-sentence">Selected range: ${escapeText(rangeSentence(data.range))}, inclusive, read from the `
    + 'archive as stored. Every number below is a stored value; a day the archive does not hold is named as a gap '
    + 'rather than shown as a zero.</p>',
    selfLink(data),
    refusal,
    section('current-numbers', currentNumbersTable(data)),
    section('acquisition', chartGroup(data, 'acquisition')),
    section('interest', chartGroup(data, 'interest')),
    section('comparison', comparisonPanel(data)),
    section('clones-against-stars', divergencePanel(data)),
    section('changes', changePanel(data)),
    section('captures', capturePanel(data)),
    section('collection-state', healthPanel(data)),
    section('provenance', provenancePanel(data)),
    `<p class="way-on"><a href="${escapeAttribute(listHref(data.range))}">Enrolled repositories over the selected `
    + 'range</a> &middot; <a href="'
    + `${escapeAttribute(ctx.links.index)}">Back to the index</a></p>`,
  ].join('\n');
  return documentShell({
    title: `${data.repo} ${data.range.from} to ${data.range.to} - ${TITLE_SUFFIX}`,
    body: `<div class="repository-detail" data-repository="${escapeAttribute(data.repo)}">\n${body}\n</div>`,
  });
}