import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../../collect/traffic.js';
import { listEnrolledRepositories } from '../../db/ops-repo.js';
import { collectionHealth } from '../../supervision/health.js';
import { documentShell, escapeAttribute, escapeText, escapeUrl } from '../html.js';
import { readRepositoryPage } from '../repo-data.js';

/**
 * The index a maintainer lands on and the table of enrolled repositories.
 *
 * Both pages are pure rendering over data the composition root in `./index.js`
 * read for them: this module opens no archive, holds no credential, reaches no
 * host and asks nobody for the time. Every dynamic value passes the shared helper
 * for its own context, so an identity whose stored spelling is markup reaches the
 * page as text and never as an element, and no page carries a script tag, an
 * inline handler, a remote asset or a colour literal.
 *
 * Four rules decide what the list page is allowed to say, and they are the reason
 * the numbers are shaped this way rather than as one tidy column:
 *
 * 1. **An absolute value leads, and it is what the archive holds.** A total is the
 *    sum of the stored days with the count of those days beside it. No percentage,
 *    no score, no threshold, no verdict and no trend language appears anywhere,
 *    because a list of three clones cannot support one.
 * 2. **A missing day stays a gap.** A day with no stored row contributes nothing to
 *    a total, is never written as `0`, and is named as the calendar day it is. A
 *    metric no run has ever stored reads "no stored value in this range" rather
 *    than an empty figure or an axes-only chart.
 * 3. **A per-day unique is never added up.** GitHub's unique cloners and unique
 *    visitors are unique within a day, so summing them across days counts one
 *    person more than once. Each is shown for the last day that holds a stored row,
 *    and the cell says which day that was.
 * 4. **A state is a word and a sentence.** The collection state word is the one the
 *    health read returns, so this page and the CLI cannot disagree, and it travels
 *    as text beside that read's own sentence: no badge, icon or colour carries it.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../router.js').PageContext} PageContext */
/** @typedef {import('./index.js').ResolvedRange} ResolvedRange */
/** @typedef {import('../repo-data.js').PageSeries} PageSeries */
/** @typedef {import('../../db/ops-repo.js').Repository} Repository */
/** @typedef {import('../../supervision/health.js').HealthSummary} HealthSummary */
/** @typedef {import('../../supervision/health.js').RunHealth} RunHealth */
/** @typedef {import('../../supervision/health.js').RepositoryHealth} RepositoryHealth */

/** The page title suffix every page carries, so a browser tab and a history entry name the product. */
const TITLE_SUFFIX = 'RepoSignal';

/** How many gap days a row names before it counts the rest. */
export const MAX_LISTED_GAP_DAYS = 10;

/** What a metric cell says when the archive holds no stored row for it in the range. */
export const NO_STORED_VALUE_TEXT = 'no stored value in this range';

/**
 * How a metric's stored days become the number a cell shows.
 *
 * `sum` is only correct for a count that is meaningful to add: clones and views are
 * counts of events, so their stored days add up. `last` is the only honest reading
 * of a per-day unique, and it says which day it belongs to.
 *
 * @typedef {object} MetricColumn
 * @property {string} metric The archive's own metric key.
 * @property {string} group Acquisition or interest, named as the column groups are.
 * @property {string} label Column header.
 * @property {'sum'|'last'} kind How the stored days become the number.
 */

/**
 * The two acquisition columns and the two interest columns, in the order the archive
 * stores them. The keys are the writers' own constants, so a page column cannot
 * drift from what a run actually writes.
 *
 * @type {readonly Readonly<MetricColumn>[]}
 */
export const TRAFFIC_COLUMNS = Object.freeze([
  Object.freeze({ metric: CLONES_METRIC, group: 'Acquisition', label: 'Clones, summed over stored days', kind: 'sum' }),
  Object.freeze({ metric: UNIQUE_CLONERS_METRIC, group: 'Acquisition', label: 'Unique cloners on the last stored day', kind: 'last' }),
  Object.freeze({ metric: VIEWS_METRIC, group: 'Interest', label: 'Views, summed over stored days', kind: 'sum' }),
  Object.freeze({ metric: UNIQUE_VISITORS_METRIC, group: 'Interest', label: 'Unique visitors on the last stored day', kind: 'last' }),
]);

/**
 * What one metric's stored days are worth on this page. `value` is null - never
 * zero - when the archive holds no stored row for the metric in the range.
 *
 * @typedef {object} MetricReading
 * @property {string} metric
 * @property {'sum'|'last'} kind
 * @property {number|null} value The number the cell shows, or null for a gap.
 * @property {number} storedDays Days the archive holds a stored row for.
 * @property {string|null} lastDay The last day a stored row covers, or null.
 */

/**
 * One repository as the list page shows it: the identity the archive holds, the
 * recorded collection state word and its sentence, and the four traffic columns
 * read from the archive's own page read.
 *
 * @typedef {object} ListRepository
 * @property {string} owner
 * @property {string} name
 * @property {string} repo `owner/name` as the archive holds it.
 * @property {'active'|'unavailable'} lifecycle
 * @property {RepositoryHealth} health The one health read, unmodified.
 * @property {MetricReading[]} readings One entry per traffic column, in column order.
 * @property {string[]} gapDays Days in the range with no stored row for any traffic metric.
 * @property {number} rangeDays Days the range covers.
 */

/**
 * @typedef {object} RepositoryListData
 * @property {ResolvedRange} range The window the page resolved, with any refusal in words.
 * @property {ListRepository[]} repositories Enrolled repositories, in the archive's own order.
 */

/**
 * @typedef {object} IndexData
 * @property {ResolvedRange} range The window the page resolved, with any refusal in words.
 * @property {HealthSummary} summary The enrolled-set roll-up, as the health read returned it.
 * @property {RunHealth} run The most recent recorded run, as the health read returned it.
 */

/**
 * @param {number} count
 * @param {string} singular
 * @returns {string} `1 <singular>` or `<n> <singular>s`.
 */
function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} many The plural of a noun whose plural is not the singular plus `s`.
 * @returns {string} `1 <singular>` or `<n> <many>`.
 */
function counted(count, singular, many) {
  return `${count} ${count === 1 ? singular : many}`;
}

/**
 * The repository a route asked for, in words. The detail route always carries both
 * parts, so the fallback names the absence rather than printing `null` at a reader.
 *
 * @param {PageContext} ctx
 * @returns {string}
 */
function requestedRepository(ctx) {
  if (ctx.owner === null || ctx.name === null || ctx.owner === '' || ctx.name === '') {
    return 'not named by this URL';
  }
  return `${ctx.owner}/${ctx.name}`;
}

/**
 * The index page's data: the recorded collection state of the whole home, read
 * through the one health read the CLI and the dashboard share, plus the window the
 * page resolved. Nothing here is a judgement about the maintainer's repositories -
 * it is the recorded state word, the roll-up sentence and the run sentence, each of
 * which the health read wrote for itself.
 *
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {() => number} options.clock Epoch milliseconds the health read is judged against.
 * @param {ResolvedRange} options.range The window the page resolved.
 * @returns {IndexData}
 */
export function readIndexPage({ db, clock, range }) {
  const health = collectionHealth({ db, clock });
  return { range, summary: health.summary, run: health.run };
}

/**
 * The list page's data: one entry per enrolled repository, read through the archive
 * page read so the series, the calendar and the health state are exactly what the
 * detail page will read and no view ever queries the archive itself.
 *
 * Every row is taken at one instant - the clock is read once for the whole page -
 * so two rows can never disagree about how long ago a collection succeeded, and
 * rendering the same archive twice produces the same page.
 *
 * @param {object} options
 * @param {Database} options.db Open archive; the caller owns closing it.
 * @param {() => number} options.clock Epoch milliseconds the health read is judged against.
 * @param {ResolvedRange} options.range The window the page resolved.
 * @returns {RepositoryListData}
 */
export function readRepositoryListPage({ db, clock, range }) {
  // A window the registry refused covers no day, so there is nothing to read and the
  // page shows the refusal rather than an empty table that looks like an archive
  // with nothing in it.
  if (range.refusal !== null) return { range, repositories: [] };
  const nowMs = clock();
  const repositories = listEnrolledRepositories(db).map((/** @type {Repository} */ stored) => {
    const page = readRepositoryPage({
      db,
      owner: stored.owner,
      name: stored.name,
      from: range.from,
      to: range.to,
      clock: () => nowMs,
    });
    return {
      owner: stored.owner,
      name: stored.name,
      repo: `${stored.owner}/${stored.name}`,
      lifecycle: stored.lifecycle,
      health: /** @type {RepositoryHealth} */ (page.health),
      readings: TRAFFIC_COLUMNS.map((column) => readMetric(page.series, column)),
      gapDays: unmeasuredDays(page.series, page.calendarDays),
      rangeDays: page.calendarDays.length,
    };
  });
  return { range, repositories };
}

/**
 * @param {readonly string[]} days
 * @returns {string} `a, b and c`, with a and b for two.
 */
function dayList(days) {
  if (days.length <= 1) return days.join('');
  if (days.length === 2) return `${days[0]} and ${days[1]}`;
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}

/**
 * @param {PageSeries[]} series
 * @param {string} metric
 * @returns {import('../repo-data.js').DayFact[]} Stored rows for one metric, oldest first.
 */
function rowsFor(series, metric) {
  const entry = series.find((candidate) => candidate.metric === metric);
  return entry === undefined ? [] : entry.rows;
}

/**
 * Read one metric's stored days and decide what the cell can honestly say. A
 * metric with no stored row reports null, which the cell renders as words: a zero
 * here would be a measurement of a day nobody measured.
 *
 * @param {PageSeries[]} series
 * @param {MetricColumn} column
 * @returns {MetricReading}
 */
function readMetric(series, column) {
  const rows = rowsFor(series, column.metric);
  const last = rows.length === 0 ? undefined : rows[rows.length - 1];
  if (last === undefined) return { metric: column.metric, kind: column.kind, value: null, storedDays: 0, lastDay: null };
  const value = column.kind === 'sum'
    ? rows.reduce((total, row) => total + row.value, 0)
    : last.value;
  return { metric: column.metric, kind: column.kind, value, storedDays: rows.length, lastDay: last.day };
}

/**
 * The days in the range no traffic metric has a stored row for. This is the union
 * across the four columns, and each column carries its own stored-day count beside
 * its number, so a metric that missed a day the others kept is visible rather than
 * hidden behind a shared word.
 *
 * @param {PageSeries[]} series
 * @param {string[]} calendarDays
 * @returns {string[]}
 */
function unmeasuredDays(series, calendarDays) {
  const measured = new Set();
  for (const column of TRAFFIC_COLUMNS) {
    for (const row of rowsFor(series, column.metric)) measured.add(row.day);
  }
  return calendarDays.filter((day) => !measured.has(day));
}

/**
 * @param {ResolvedRange} range
 * @returns {string} `from <first day> to <last day>`, the window the page resolved.
 */
function rangeText(range) {
  return `from ${range.from} to ${range.to}`;
}

/**
 * @param {ResolvedRange} range
 * @returns {string} The query string carrying both bounds.
 */
function rangeQuery(range) {
  return new URLSearchParams({ from: range.from, to: range.to }).toString();
}

/**
 * The list page link for a resolved window.
 *
 * The route's own `links` carry the bounds the URL carried, which may be none of
 * them. This link carries the window the page actually resolved, so every link
 * states the window its target will read and a bookmark reproduces the page.
 *
 * @param {ResolvedRange} range
 * @returns {string}
 */
export function listHref(range) {
  return `/repos?${rangeQuery(range)}`;
}

/**
 * The detail page link for one repository over the resolved window. The identity
 * is percent-encoded for a path segment and the whole reference is attribute
 * escaped by the caller, so an owner or name carrying markup or a slash cannot
 * leave the path it belongs in.
 *
 * @param {string} owner
 * @param {string} name
 * @param {ResolvedRange} range
 * @returns {string}
 */
export function detailHref(owner, name, range) {
  return `/repo/${escapeUrl(owner)}/${escapeUrl(name)}?${rangeQuery(range)}`;
}

/**
 * @param {number} count
 * @param {number} rangeDays
 * @returns {string} The stored-day count beside a total, which is the number of days the total is over.
 */
function storedDayText(count, rangeDays) {
  return `summed over ${plural(count, 'stored day')} of the ${rangeDays} in the range`;
}

/**
 * One metric cell: the number the archive holds, and the sentence that keeps the
 * number honest. A metric with nothing stored says so in words and shows no
 * figure, so there is nothing on the page a reader could mistake for a measurement.
 *
 * @param {MetricReading} reading
 * @param {MetricColumn} column
 * @param {number} rangeDays
 * @returns {string}
 */
function metricCell(reading, column, rangeDays) {
  if (reading.value === null) {
    return `<td class="value value-missing" data-metric="${escapeAttribute(reading.metric)}" data-state="missing">` +
      `<span class="figure">${escapeText(NO_STORED_VALUE_TEXT)}</span></td>`;
  }
  const note = reading.kind === 'sum'
    ? storedDayText(reading.storedDays, rangeDays)
    : `on ${reading.lastDay}, the last day with a stored row`;
  return `<td class="value" data-metric="${escapeAttribute(reading.metric)}" data-state="stored">` +
    `<span class="figure">${escapeText(reading.value)}</span> ` +
    `<span class="figure-note">${escapeText(note)}</span></td>`;
}

/**
 * The gap cell: the calendar days the range covers that no traffic metric has a
 * stored row for. A day nobody measured is named as a day nobody measured.
 *
 * @param {string[]} gapDays
 * @param {number} rangeDays
 * @returns {string}
 */
function gapCell(gapDays, rangeDays) {
  if (gapDays.length === 0) {
    return `<td class="coverage" data-state="complete">Every day in the range carries a stored row for at least ` +
      `one traffic metric.</td>`;
  }
  const named = gapDays.slice(0, MAX_LISTED_GAP_DAYS);
  const remainder = gapDays.length - named.length;
  const listed = remainder > 0
    ? `${dayList(named)}, and ${counted(remainder, 'further day', 'further days')}`
    : dayList(named);
  // A window with nothing stored in it and a window with one hole read differently,
  // because "every day has no stored row" is a different fact from "some day does".
  const lead = gapDays.length === rangeDays
    ? 'No day in the range has a stored row for any traffic metric'
    : `${counted(gapDays.length, 'day', 'days')} of the ${rangeDays} in the range ${
      gapDays.length === 1 ? 'has' : 'have'} no stored row for any traffic metric`;
  return `<td class="coverage" data-state="gap">${lead}: ${escapeText(listed)}. ` +
    `Those ${gapDays.length === 1 ? 'day is' : 'days are'} unmeasured, not zero.</td>`;
}

/**
 * The collection state cell: the state word the one health read returned, and the
 * sentence that read wrote for it. Both are text, so removing every class attribute
 * from the page leaves the state readable.
 *
 * @param {RepositoryHealth} health
 * @returns {string}
 */
function stateCell(health) {
  return `<td class="state" data-state="${escapeAttribute(health.state)}">` +
    `<span class="state-word">${escapeText(health.state)}</span> ` +
    `<span class="state-reason">${escapeText(health.reason)}</span></td>`;
}

/**
 * One row per enrolled repository, in the archive's own order.
 *
 * @param {ListRepository} repository
 * @param {ResolvedRange} range
 * @returns {string}
 */
function repositoryRow(repository, range) {
  const href = detailHref(repository.owner, repository.name, range);
  return `<tr data-repository="${escapeAttribute(repository.repo)}">` +
    `<th scope="row" class="identity"><a href="${escapeAttribute(href)}">${escapeText(repository.repo)}</a></th>` +
    repository.readings.map((reading) => {
      const column = /** @type {MetricColumn} */ (TRAFFIC_COLUMNS.find((entry) => entry.metric === reading.metric));
      return metricCell(reading, column, repository.rangeDays);
    }).join('') +
    gapCell(repository.gapDays, repository.rangeDays) +
    stateCell(repository.health) +
    '</tr>';
}

/**
 * The table of enrolled repositories. The header names what each column is, so no
 * reading of the page depends on knowing the product's internals.
 *
 * @param {RepositoryListData} data
 * @returns {string}
 */
function repositoryTable(data) {
  const headers = TRAFFIC_COLUMNS.map((column) =>
    `<th scope="col">${escapeText(column.group)}: ${escapeText(column.label)}</th>`);
  return '<table class="repositories">'
    + '<caption>Enrolled repositories: the acquisition and interest totals the archive holds over the selected '
    + 'range, the days it holds no row for, and the recorded collection state of each repository.</caption>'
    + '<thead><tr>'
    + '<th scope="col">Repository</th>'
    + headers.join('')
    + '<th scope="col">Days with no stored row</th>'
    + '<th scope="col">Collection state</th>'
    + '</tr></thead>'
    + `<tbody>${data.repositories.map((repository) => repositoryRow(repository, data.range)).join('')}</tbody>`
    + '</table>';
}

/**
 * The empty case in words rather than as a table with no rows: a home that has
 * enrolled nothing is a first-connect state, and an empty table reads as a page
 * that failed to load.
 *
 * @returns {string}
 */
function emptyState() {
  return '<section class="empty-state">'
    + '<p class="state-sentence">No repository is enrolled: the archive holds no enrolled repository, so this list '
    + 'has no rows to show. That is the state of the archive, not a page that failed to load.</p>'
    + '<p>Add an <code>owner/name</code> pair to the <code>enrolled</code> list in <code>config.json</code>, then run '
    + '<code>node src/cli.js collect</code> to store its first traffic days.</p>'
    + '</section>';
}

/**
 * The section both pages carry: the window this page resolved and where it came
 * from. A page that silently resolved a range nobody chose is a page whose numbers
 * cannot be reproduced from its URL.
 *
 * @param {ResolvedRange} range
 * @returns {string}
 */
function rangeSection(range) {
  return `<section class="range">`
    + `<p class="range-sentence">Selected range: ${escapeText(rangeText(range))}, `
    + `${range.from === range.to ? 'one day' : 'inclusive'} and read from the archive as stored.</p>`
    + '</section>';
}

/**
 * The index page: what this product is, the recorded collection state of the whole
 * home in words, and the way onward to the list.
 *
 * @param {PageContext} ctx
 * @param {IndexData} data
 * @returns {string} A complete document.
 */
export function renderIndexPage(ctx, data) {
  const { range, summary, run } = data;
  const body = [
    `<h1>${escapeText(TITLE_SUFFIX)}</h1>`,
    '<p>RepoSignal archives the traffic of your own GitHub repositories beyond GitHub\'s rolling window and '
    + 'serves that archive read-only from this machine. Every number on a page is a measurement the archive '
    + 'holds; a day with no stored row stays a gap rather than becoming a zero.</p>',
    rangeSection(range),
    '<section class="collection-state">',
    '<h2>Collection state</h2>',
    `<p class="state-sentence">${escapeText(summary.reason)}</p>`,
    `<p class="enrolled-count">${escapeText(counted(summary.enrolled, 'repository', 'repositories'))} enrolled in `
    + 'this archive.</p>',
    `<p class="run-state">${escapeText(run.reason)}.</p>`,
    `<p><a href="${escapeAttribute(listHref(range))}">Enrolled repositories over the selected range</a></p>`,
    '</section>',
  ].join('\n');
  return documentShell({ title: TITLE_SUFFIX, body });
}

/**
 * The repository list page, and - until the detail page this build does not yet
 * have - the answer to a detail URL as well.
 *
 * @param {PageContext} ctx
 * @param {RepositoryListData} data
 * @returns {string} A complete document.
 */
export function renderRepositoryListPage(ctx, data) {
  const { range } = data;
  const onDetailRoute = ctx.route === 'detail';
  // A route the page refused shows the refusal in words and no table: a page that
  // quietly resolved a range nobody chose would put numbers on the screen that no
  // URL reproduces.
  const refusal = range.refusal === null ? null :
    `<p class="range-refusal">${escapeText(range.refusal)}</p>`;
  const body = [
    onDetailRoute ? '<h1>Repository detail</h1>' : '<h1>Enrolled repositories</h1>',
    onDetailRoute
      ? '<p class="state-sentence">This build has no per-repository detail page yet, so the whole enrolled set is '
        + 'shown below instead. The repository this URL asks for is '
        + `${escapeText(requestedRepository(ctx))}.</p>`
      : '<p>One row per enrolled repository: what the archive holds for it over the selected range, and the '
        + 'collection state its last run recorded.</p>',
    rangeSection(range),
    refusal === null ? '' : refusal,
    '<section class="section-repositories">'
    + `<h2>${onDetailRoute ? 'Enrolled repositories' : 'Traffic totals and collection state'}</h2>`
    + (data.repositories.length === 0 ? emptyState() : repositoryTable(data))
    + '</section>',
    `<p><a href="${escapeAttribute(ctx.links.index)}">Back to the index</a></p>`,
  ].join('\n');
  return documentShell({
    title: onDetailRoute
      ? `Repository detail is not in this build - ${TITLE_SUFFIX}`
      : `Enrolled repositories - ${TITLE_SUFFIX}`,
    body,
  });
}