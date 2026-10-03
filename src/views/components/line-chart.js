/**
 * The hand-rolled SVG line chart, and the data table that has to travel with it.
 *
 * This module is the rendering half of the chart feature, and it exists because a
 * charting library would draw the one thing the archive exists to prevent. A
 * library asked to plot "a series with a hole in it" will happily connect the two
 * points either side of the hole, because a continuous line is what a line chart
 * looks like. That single bridged segment is a claim - that the archive holds a
 * measurement for a day it never measured - and no amount of careful wording
 * elsewhere on the page undoes it. So the chart is emitted here, by hand, and the
 * rule it is written around is that **a missing day is a break in the line and a
 * named day in the table.**
 *
 * Six decisions follow from that, and each of them is asserted by a test rather
 * than trusted to review.
 *
 * 1. **One `polyline` per contiguous run of stored days.** Runs are produced by
 *    walking the calendar the range covers, not the rows the archive happens to
 *    hold. Two stored days either side of an unmeasured day are in different runs,
 *    so no element in the output spans the hole. A run of exactly one stored day
 *    cannot be a line at all - a `polyline` with one point draws nothing - so it is
 *    emitted as a `circle` marker instead, which is also what makes a single
 *    stored day visible rather than an empty plot box.
 * 2. **The window comes from the caller, and the calendar is enumerated from it.**
 *    A day the range covers and the archive holds nothing for is a gap the chart
 *    has to show, including a gap at the very start or the very end of the range;
 *    neither is discoverable from the stored rows alone. When a caller supplies
 *    `calendarDays` that window is used exactly as given. When it supplies none,
 *    the window is the span from the first stored day to the last, which is a
 *    truthful reading of what was measured and cannot invent a day the archive
 *    never held.
 * 3. **The value axis starts at zero and ends at the largest stored value.** Every
 *    metric this product stores is a count or a cumulative total, so a
 *    non-zero baseline would exaggerate the distance between two small numbers -
 *    the same exaggeration a truncated axis produces. Scaling the largest stored
 *    day to the full plot height is what keeps a repository with three clones
 *    readable instead of rendering it as a flat line. The degenerate cases are
 *    handled by construction rather than hoped for: a range covering one day
 *    divides by `dayCount - 1` only when `dayCount > 1`, and a series whose stored
 *    values are all zero is scaled against a domain of one so that no coordinate
 *    is a division by zero.
 * 4. **The table is part of the output, not an afterthought next to it.** Every
 *    day the range covers gets a row, stored or not, and a gap row says in words
 *    that the day holds no stored value. Omitting the gap rows would leave a
 *    screen-reader user reading the omission as a zero day, so the rows are there
 *    and they are reachable from the figure through the `aria-describedby` chain
 *    running from the `svg` to the table's caption.
 * 5. **Nothing here reads a clock, touches a file or draws a random number, and
 *    no colour literal appears in the output.** The stroke and the fills use
 *    `currentColor`, so the stylesheet in `src/ui/theme.css` remains the only place
 *    a colour is declared and a contrast test can see it. Identical input
 *    therefore produces byte-identical markup.
 * 6. **Provenance is annotation, never geometry.** The provenance read the caller
 *    supplies decides how a stored day is *labelled*, and never where it is
 *    plotted: a day recorded as backfilled, and a day that falls before the first
 *    collected day, are drawn dashed, while a collected day is drawn solid. A run
 *    splits where that treatment changes, because one `polyline` carries one
 *    `stroke-dasharray` - so no day before the boundary can end up drawn in the
 *    collected treatment, and the boundary marker is a vertical rule drawn at the
 *    first collected day's own x coordinate. A repository the archive records as
 *    never collected gets the first-connect caption and no marker at all: a marker
 *    at the window start would claim a collection that never happened.
 *
 * The six are the reasons the two treatments differ by dash rather than by
 * colour: RS-AX-01 requires that no meaning rides on colour alone, and a dash is
 * also legible in a monochrome print and in a forced-colours mode.
 *
 * There is no script, no animation, no external asset and no charting dependency:
 * the only import is the shared escaping module, because a repository name may
 * contain markup and a chart label is a reader-facing string.
 *
 * The provenance read itself is owned by `src/backfill/provenance.js` and reaches
 * this module as data through the request, never as an import: the first collected
 * day comes from the recorded boundary and never from the earliest stored row of any
 * metric. Two contradictions between that read and the stored rows are refused by
 * name rather than drawn - a day recorded `collected` before the boundary, and a day
 * recorded `collected` for a repository the read reports as never collected - because
 * the archive's own writers cannot produce either, so each is a caller reading the
 * archive wrongly rather than a fact to render around.
 */

import { escapeAttribute, escapeText } from '../../server/html.js';

const DAY_MS = 86_400_000;

/** Fixed SVG viewBox width; the figure scales to its container through this box. */
export const CHART_WIDTH = 720;
/** Fixed SVG viewBox height, chosen so the plot box stays wide at any range length. */
export const CHART_HEIGHT = 260;
/** Left edge of the plot box: the room the value axis and its labels occupy. */
export const PLOT_LEFT = 62;
/** Room between the last day and the right edge of the viewBox. */
export const PLOT_RIGHT = 16;
/** Top edge of the plot box, where the largest stored value sits. */
export const PLOT_TOP = 16;
/** Room below the plot box: the bottom axis, its ticks and their day labels. */
export const PLOT_BOTTOM = 44;
/** Width of the plot box inside the viewBox. */
export const PLOT_WIDTH = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT;
/** Height of the plot box inside the viewBox. */
export const PLOT_HEIGHT = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;
/** The left axis carries at most this many ticks, `0` and the largest value included. */
export const MAX_VALUE_TICKS = 5;
/** The bottom axis names at most the first day, the boundary day and the last day. */
export const MAX_DAY_LABELS = 3;
/** Gap days named in full in the summary sentence; the table always names every one. */
export const MAX_NAMED_GAP_DAYS = 10;
/** The words a gap row carries. A gap is never rendered as a number. */
export const GAP_CELL_TEXT = 'No stored value (gap)';
/** Placeholder used when a caller names no value column of its own. */
export const DEFAULT_VALUE_LABEL = 'Stored value';

/**
 * The two sources the archive's own `day_series` check constraint allows. A third
 * value is a caller's mistake rather than a source, and is refused by name instead
 * of being drawn as though it were collected.
 */
export const SOURCE_BACKFILL = /** @type {const} */ ('backfill');
export const SOURCE_COLLECTED = /** @type {const} */ ('collected');
/**
 * The dash pattern a backfilled day is drawn with. A dash rather than a colour is
 * what keeps the two treatments distinguishable in monochrome, in forced-colours
 * mode and to a reader who cannot separate two hues at all.
 */
export const BACKFILL_DASH_PATTERN = '6 4';
/** What a backfilled day says in the table's provenance column. */
export const BACKFILL_SOURCE_TEXT = 'Backfilled';
/** What a collected day says in the table's provenance column. */
export const COLLECTED_SOURCE_TEXT = 'Collected';
/** What a day carrying no recorded source says. Never guessed into a source. */
export const UNRECORDED_SOURCE_TEXT = 'Not recorded';
/** What a gap row says in the provenance column: a day with no row has no source. */
export const NO_SOURCE_TEXT = 'No stored day';
/** Column heading of the provenance column, present only when provenance is known. */
export const SOURCE_COLUMN_LABEL = 'Source';
/** The two legend entries, in a fixed order, when the chart carries provenance. */
export const LEGEND_ENTRIES = Object.freeze([
  Object.freeze({
    key: SOURCE_BACKFILL,
    dashed: true,
    text: `${BACKFILL_SOURCE_TEXT}: dashed, reconstructed on first connect`,
  }),
  Object.freeze({
    key: SOURCE_COLLECTED,
    dashed: false,
    text: `${COLLECTED_SOURCE_TEXT}: solid, read on a collection day`,
  }),
]);

/**
 * One stored day of one metric. A day the archive holds nothing for is absent from
 * this array entirely - never present with a zero standing in for it - which is
 * what lets this module tell a quiet day from an unmeasured one.
 *
 * @typedef {object} ChartObservation
 * @property {string} day UTC calendar day the value was observed on, ISO `YYYY-MM-DD`.
 * @property {number} value The stored value: a count, or a cumulative total.
 * @property {'backfill'|'collected'} [source] The archive's own recorded source for
 *   that day, exactly as `day_series` stores it. A backfilled day is drawn dashed and
 *   a collected day solid; a day with no recorded source carries no provenance claim
 *   in either direction.
 */

/**
 * One plotted point. `x` and `y` are viewBox coordinates; `value` is the stored
 * number those coordinates came from, so a test can check the geometry against the
 * archive's own numbers rather than against a second copy of them.
 *
 * @typedef {object} ChartPoint
 * @property {string} day
 * @property {number} value
 * @property {number} x
 * @property {number} y
 * @property {number} dayIndex Position of the day in the range's calendar, oldest first.
 * @property {string|undefined} source
 */

/**
 * One contiguous run of stored days: what a single `polyline` draws. A run never
 * contains a missing day, which is the whole point of it, and never mixes the two
 * provenance treatments, because one `polyline` carries one `stroke-dasharray`.
 *
 * @typedef {object} ChartRun
 * @property {number} index 1-based position of the run in the range, oldest first.
 * @property {string} from First day of the run.
 * @property {string} to Last day of the run.
 * @property {number} days Calendar days the run covers.
 * @property {boolean} dashed Whether the run is drawn with the backfill dash.
 * @property {boolean} backfilled Whether every stored day of the run is recorded as backfill.
 * @property {ChartPoint[]} points
 */

/**
 * One row of the paired data table: one calendar day, stored or not. `gap` is what
 * the row says in words, so nothing in the table can be read as a zero, and
 * `sourceText` is what the provenance column says in words, so the picture's dash
 * treatment is never the only place a day's provenance exists.
 *
 * @typedef {object} ChartRow
 * @property {string} day
 * @property {number|null} value Stored value, or null for a day the archive holds none.
 * @property {boolean} gap
 * @property {string} text What the value cell says.
 * @property {'backfill'|'collected'|null} source The day's recorded source, or null.
 * @property {boolean} dashed Whether the day is drawn with the backfill dash.
 * @property {string} sourceText What the provenance cell says.
 */

/**
 * The recorded provenance of one repository, as far as this module reads it. The
 * archive's own read (`readProvenance`) satisfies this shape structurally, which
 * is how the boundary arrives here as data: this module never opens the archive,
 * never imports a read and never derives a first collected day from a stored row.
 *
 * @typedef {object} ProvenanceRead
 * @property {'connected'|'not-connected'} state `not-connected` until a collection is stamped.
 * @property {string|null} firstCollectedDay The recorded boundary, null while not connected.
 */

/**
 * Everything the markup is drawn from, computed once and free of any clock or I/O,
 * so a test can assert on the geometry and the table separately and find out which
 * one drifted.
 *
 * @typedef {object} LineChartModel
 * @property {string} id Element id prefix; unique per figure on a page.
 * @property {string} label Metric name in a reader's words.
 * @property {string} valueLabel Column heading of the value column.
 * @property {string} rangeFrom First day of the window, inclusive.
 * @property {string} rangeTo Last day of the window, inclusive.
 * @property {number} calendarDayCount Days the window covers.
 * @property {ChartPoint[]} storedPoints Every stored day, oldest first.
 * @property {string[]} storedDays
 * @property {string[]} missingDays Days the window covers with no stored value, oldest first.
 * @property {ChartRun[]} runs Runs of two or more stored days: one `polyline` each.
 * @property {ChartRun[]} markerRuns Runs of exactly one stored day: one `circle` each.
 * @property {number} maxValue Largest stored value, or zero when nothing is stored.
 * @property {number} valueDomainTop Domain the vertical scale divides by; one when
 *   nothing is stored, so no coordinate is ever a division by zero.
 * @property {number[]} valueTicks At most {@link MAX_VALUE_TICKS} values, ascending.
 * @property {ChartRow[]} rows One row per calendar day.
 * @property {'connected'|'not-connected'|null} provenanceState The recorded state, or
 *   null when the caller supplied no provenance read at all.
 * @property {string|null} boundaryDay The boundary in force, or null.
 * @property {boolean} boundaryInWindow Whether that boundary falls inside the window.
 * @property {number|null} boundaryX The boundary's own x coordinate, or null.
 * @property {boolean} provenanceKnown Whether the chart carries provenance to explain,
 *   which is what puts the legend and the table's provenance column in the output.
 * @property {string[]} backfilledDays Stored days the archive recorded as backfilled.
 * @property {string[]} collectedDays Stored days the archive recorded as collected.
 * @property {string[]} unrecordedSourceDays Stored days carrying no recorded source.
 * @property {string[]} preBoundaryStoredDays Stored days before the boundary.
 * @property {typeof LEGEND_ENTRIES[number][]} legendEntries The two legend entries.
 * @property {string} sourceColumnLabel Heading of the table's provenance column.
 * @property {string[]} provenanceNotes The sentences stating where collected history
 *   begins and what the window before it is.
 * @property {boolean} plottable Whether any stored day exists to plot.
 * @property {string} summary The sentences a reader gets in text.
 * @property {string} tableCaption The paired table's caption.
 */

/**
 * @typedef {object} LineChartRequest
 * @property {string} label Metric name in a reader's words, such as `Clones`.
 * @property {ChartObservation[]} observations Stored days for that metric, in any
 *   order. A day with no stored value is absent from this array.
 * @property {string[]} [calendarDays] The window the chart covers, oldest first,
 *   every day including the unmeasured ones. Omit it only when the stored days
 *   themselves are the window.
 * @property {ProvenanceRead} [provenance] The archive's recorded provenance for the
 *   repository. Supplying it turns on the boundary marker, the first-connect caption
 *   and the legend; a `not-connected` read states that no collection is recorded.
 * @property {string} [boundaryDay] The first collected day, drawn as a labelled bottom
 *   tick and as the vertical boundary marker. `provenance` is the read that owns this
 *   value and the route a page should take; supply either, never two that disagree.
 * @property {string} [valueLabel] Column heading for the value column.
 * @property {string} [id] Element id prefix. Derived from the label when omitted.
 */

/**
 * Validate a real UTC calendar day, rejecting normalised impossible days such as
 * `2026-02-30`, so a day means one thing across the archive and the chart.
 * @param {string} day
 * @param {string} what Name of the value, named in the message.
 * @returns {number} Epoch milliseconds at UTC midnight of that day.
 */
function dayTime(day, what) {
  const time = typeof day === 'string' ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) {
    throw new TypeError(`Invalid ${what}; supply a real UTC calendar day in YYYY-MM-DD form`);
  }
  return time;
}

/**
 * Every day an inclusive window covers, oldest first.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function enumerateDays(from, to) {
  const start = dayTime(from, 'window start day');
  const end = dayTime(to, 'window end day');
  if (start > end) throw new RangeError('Reversed chart window; supply from <= to');
  /** @type {string[]} */
  const days = [];
  for (let time = start; time <= end; time += DAY_MS) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Round a coordinate for markup. Two decimals is finer than a pixel at this
 * viewBox size and keeps the output short, and rounding here - once - is what
 * makes the same input produce the same bytes.
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Number(value.toFixed(2));
}

/**
 * A stored number as text, used by the value axis and the table's value cells
 * alike. Both read from this one function, so the number beside the axis can never
 * disagree with the number in the row.
 * @param {number} value
 * @returns {string}
 */
function formatValue(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError('A chart value must be a finite number; a day with no stored value is a gap, not a value');
  }
  const rounded = Number(value.toFixed(3));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * A "nice" axis step - one of 1, 2 or 5 times a power of ten - so tick labels are
 * numbers a reader can hold in their head rather than 3718.4.
 * @param {number} raw Step size before rounding.
 * @returns {number}
 */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Number((factor * magnitude).toFixed(10));
}

/**
 * At most {@link MAX_VALUE_TICKS} values for the left axis, ascending, always
 * including `0` and the largest stored value. The largest value is included exactly
 * rather than rounded up to a nice number above it, because that is what puts the
 * longest day at the top of the plot box. An interior tick closer to the largest
 * value than a quarter of a step is dropped rather than printed underneath it, so a
 * series ending at 21 carries `0`, `10`, `21` and not `0`, `10`, `20`, `21`.
 * @param {number} maxValue Largest stored value.
 * @returns {number[]}
 */
function valueTicks(maxValue) {
  if (!(maxValue > 0)) return [0];
  const step = niceStep(maxValue / (MAX_VALUE_TICKS - 1));
  /** @type {number[]} */
  const ticks = [0];
  for (let index = 1; index < MAX_VALUE_TICKS - 1; index += 1) {
    const value = Number((index * step).toFixed(10));
    if (value >= maxValue) break;
    if (maxValue - value < step / 4) break;
    if (value > (ticks[ticks.length - 1] ?? 0)) ticks.push(value);
  }
  ticks.push(maxValue);
  return ticks;
}

/**
 * Index the stored observations by day.
 *
 * The array is validated rather than trusted, because each way it can be wrong
 * draws something: a day that is not a real date would be looked up under a key
 * nothing else can match and read as a gap, a non-numeric value would plot as
 * `NaN`, a negative value would put a count below its own baseline, and two rows
 * for one day would silently double-count a single observation.
 * @param {ChartObservation[]} observations
 * @returns {Map<string, ChartObservation>}
 */
function readObservations(observations) {
  if (!Array.isArray(observations)) {
    throw new TypeError('A chart needs an observation array of stored days; supply one');
  }
  /** @type {Map<string, ChartObservation>} */
  const byDay = new Map();
  for (const observation of observations) {
    if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new TypeError('Each observation must be a record with a day and a value');
    }
    dayTime(observation.day, 'observation day');
    const { value } = observation;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`Observation ${observation.day} must carry a finite numeric value; `
        + 'a day with no stored value is absent from the array, never a zero standing in for it');
    }
    if (value < 0) {
      throw new TypeError(`Observation ${observation.day} carries a negative value; `
        + 'every metric the archive stores is a count or a cumulative total');
    }
    if (byDay.has(observation.day)) {
      throw new TypeError(`Two observations carry the day ${observation.day}; one day has one stored value`);
    }
    if (observation.source !== undefined && observation.source !== SOURCE_BACKFILL
      && observation.source !== SOURCE_COLLECTED) {
      throw new TypeError(`Observation ${observation.day} carries source `
        + `${JSON.stringify(observation.source)}; the archive records a day as either `
        + `${SOURCE_BACKFILL} or ${SOURCE_COLLECTED}, and an unknown source is drawn as neither`);
    }
    byDay.set(observation.day, observation);
  }
  return byDay;
}

/**
 * The window the chart covers. A caller-supplied list is used exactly as given, so
 * a range edge with no stored day is still drawn as a gap. The list is sorted
 * rather than trusted to arrive oldest-first, because the order a caller enumerates
 * the calendar in is not a measurement: two callers holding the same window must
 * produce the same bytes. Without a list, the window is the span from the first
 * stored day to the last.
 * @param {string[]|undefined} calendarDays
 * @param {Map<string, ChartObservation>} byDay
 * @returns {string[]}
 */
function readCalendarDays(calendarDays, byDay) {
  if (calendarDays === undefined) {
    if (byDay.size === 0) {
      throw new TypeError('A chart with no stored day needs a calendarDays window; '
        + 'supply the days the range covers so the empty case has a window to name');
    }
    const stored = [...byDay.keys()].sort();
    return enumerateDays(stored[0], stored[stored.length - 1]);
  }
  if (!Array.isArray(calendarDays) || calendarDays.length === 0) {
    throw new TypeError('A chart window is a non-empty array of calendar days, oldest first');
  }
  for (const day of calendarDays) dayTime(day, 'window day');
  const sorted = [...calendarDays].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new TypeError(`The chart window names ${sorted[index]} twice; one day appears once`);
    }
    if (dayTime(sorted[index], 'window day') - dayTime(sorted[index - 1], 'window day') !== DAY_MS) {
      throw new TypeError('The chart window must be consecutive calendar days; a missing day is a gap, '
        + 'not a shorter window');
    }
  }
  return sorted;
}

/**
 * The provenance the chart annotates from, read off the request and validated
 * before a single day is looked up.
 *
 * The archive's own read owns the boundary, so a record that contradicts itself is
 * refused by name rather than drawn around: a repository reported `connected` with
 * no first collected day has no boundary to place, and one reported `not-connected`
 * while carrying a day would have a marker standing for a collection that no run
 * recorded. A caller that also names a `boundaryDay` must name the same day, because
 * two sources disagreeing about where collected history begins is a defect to
 * report, not a rendering preference to resolve here.
 *
 * @param {LineChartRequest} request
 * @returns {{state: 'connected'|'not-connected'|null, firstCollectedDay: string|null}}
 */
function readProvenanceInput(request) {
  const record = request.provenance;
  if (record === undefined) {
    return { state: null, firstCollectedDay: request.boundaryDay ?? null };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('A provenance read is a record carrying a state and a first collected day');
  }
  if (record.state !== 'connected' && record.state !== 'not-connected') {
    throw new TypeError('A provenance read reports state "connected" or "not-connected"; '
      + 'nothing else names a collection boundary');
  }
  const firstCollectedDay = record.firstCollectedDay ?? null;
  if (firstCollectedDay !== null) dayTime(firstCollectedDay, 'first collected day');
  if (record.state === 'connected' && firstCollectedDay === null) {
    throw new TypeError('A provenance read reporting connected carries the first collected day; '
      + 'without one there is no boundary to draw and none is invented');
  }
  if (record.state === 'not-connected' && firstCollectedDay !== null) {
    throw new TypeError(`A provenance read reporting not-connected carries no first collected day, `
      + `so the boundary on ${firstCollectedDay} cannot be drawn`);
  }
  if (request.boundaryDay !== undefined && record.state === 'not-connected') {
    throw new TypeError('A repository the archive records as never collected has no boundary day; '
      + 'a marker on such a chart would claim a collection no run recorded');
  }
  if (request.boundaryDay !== undefined && firstCollectedDay !== null
    && request.boundaryDay !== firstCollectedDay) {
    throw new TypeError(`The supplied boundary day ${request.boundaryDay} and the provenance read's `
      + `first collected day ${firstCollectedDay} disagree; the recorded read owns the boundary`);
  }
  return { state: record.state, firstCollectedDay };
}

/**
 * Horizontal position of a day in the window. A window of one day is centred rather
 * than divided by `dayCount - 1`, which is the only division by zero this chart
 * could have contained.
 * @param {number} dayIndex
 * @param {number} dayCount
 * @returns {number}
 */
function xFor(dayIndex, dayCount) {
  if (dayCount <= 1) return round2(PLOT_LEFT + PLOT_WIDTH / 2);
  return round2(PLOT_LEFT + (dayIndex / (dayCount - 1)) * PLOT_WIDTH);
}

/**
 * Vertical position of a stored value, with zero on the baseline and the largest
 * stored value at the top of the plot box. The clamp guards the last bit of
 * floating-point noise: no stored value can exceed the domain, because the domain
 * is computed from the stored values.
 * @param {number} value
 * @param {number} domainTop
 * @returns {number}
 */
function yFor(value, domainTop) {
  const bounded = Math.min(Math.max(value, 0), domainTop);
  return round2(PLOT_TOP + PLOT_HEIGHT - (bounded / domainTop) * PLOT_HEIGHT);
}

/**
 * How one stored day is labelled, decided before any coordinate is computed. A day
 * the archive recorded as backfilled is dashed; so is a day that falls before the
 * recorded first collected day, whatever its own source says, because the boundary
 * is where collected evidence begins and a day before it was never read by a
 * collection run.
 *
 * Two contradictions are refused rather than drawn, because each would put a
 * provenance claim on a day the recorded evidence does not support: a day recorded
 * `collected` before the boundary, and a day recorded `collected` for a repository
 * the read reports as never collected. The archive's own writers cannot produce
 * either - the boundary is stamped in the same transaction as the traffic it
 * describes - so each is a caller reading the archive wrongly.
 *
 * @param {string} day
 * @param {ChartObservation} observation
 * @param {{state: 'connected'|'not-connected'|null, firstCollectedDay: string|null}} provenance
 * @returns {{source: 'backfill'|'collected'|null, backfilled: boolean, dashed: boolean}}
 */
function readDayProvenance(day, observation, provenance) {
  const source = observation.source ?? null;
  const boundaryDay = provenance.firstCollectedDay;
  const backfilled = source === SOURCE_BACKFILL;
  if (source === SOURCE_COLLECTED && provenance.state === 'not-connected') {
    throw new TypeError(`Observation ${day} is recorded as ${SOURCE_COLLECTED} for a repository the `
      + 'archive records as never collected; the boundary and the stored source cannot disagree');
  }
  if (source === SOURCE_COLLECTED && boundaryDay !== null && day < boundaryDay) {
    throw new TypeError(`Observation ${day} is recorded as ${SOURCE_COLLECTED} but falls before the `
      + `first collected day ${boundaryDay}; a day before the boundary was never collected`);
  }
  return { source, backfilled, dashed: backfilled || (boundaryDay !== null && day < boundaryDay) };
}

/**
 * Split the window's stored days into contiguous runs. A missing day closes the run
 * that was open, which is the mechanism that keeps a bridged segment out of the
 * output: the next stored day opens a new run instead of extending the old one. A
 * change of provenance treatment closes it too, because one `polyline` carries one
 * `stroke-dasharray`: a run that mixed backfilled and collected days could not be
 * drawn with the treatment its own days have, so the split is what makes the dashed
 * days distinguishable rather than a single line wearing the wrong dash.
 *
 * Splitting further can never bridge a hole - it can only break a line that was
 * already continuous - so the rule that a missing day is a break still holds.
 * @param {string[]} calendarDays
 * @param {Map<string, ChartObservation>} byDay
 * @param {number} domainTop
 * @param {Map<string, {source: 'backfill'|'collected'|null, backfilled: boolean, dashed: boolean}>} provenanceByDay
 * @returns {ChartRun[]}
 */
function splitRuns(calendarDays, byDay, domainTop, provenanceByDay) {
  /** @type {{point: ChartPoint, dashed: boolean, backfilled: boolean}[]} */
  const stored = [];
  calendarDays.forEach((day, dayIndex) => {
    const observation = byDay.get(day);
    if (observation === undefined) return;
    const record = provenanceByDay.get(day);
    /** @type {ChartPoint} */
    const point = {
      day,
      value: observation.value,
      x: xFor(dayIndex, calendarDays.length),
      y: yFor(observation.value, domainTop),
      dayIndex,
      source: observation.source,
    };
    stored.push({ point, dashed: record?.dashed ?? false, backfilled: record?.backfilled ?? false });
  });

  /** @type {ChartRun[]} */
  const runs = [];
  /** @type {ChartRun|null} */
  let open = null;
  for (const entry of stored) {
    const openRun = open;
    const previous = openRun === null ? undefined : openRun.points[openRun.points.length - 1];
    const continues = previous !== undefined
      && entry.point.dayIndex === previous.dayIndex + 1
      && entry.dashed === openRun?.dashed;
    if (!continues || openRun === null) {
      open = {
        index: runs.length + 1,
        from: entry.point.day,
        to: entry.point.day,
        days: 1,
        dashed: entry.dashed,
        backfilled: entry.backfilled,
        points: [entry.point],
      };
      runs.push(open);
      continue;
    }
    openRun.to = entry.point.day;
    openRun.days += 1;
    openRun.backfilled = openRun.backfilled && entry.backfilled;
    openRun.points.push(entry.point);
  }
  return runs;
}

/**
 * A day list as one sentence reads: `2026-03-04`, or `2026-03-04 and 2026-03-05`.
 * @param {string[]} days
 * @returns {string}
 */
function dayList(days) {
  if (days.length === 0) return '';
  if (days.length === 1) return days[0];
  if (days.length === 2) return `${days[0]} and ${days[1]}`;
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}

/**
 * One `gap-count`, `gap-days`, `day-count` or `day-days` word, kept beside the
 * number it agrees with rather than in a sentence that could drift from it.
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
function countWord(count, singular, plural) {
  return count === 1 ? singular : plural;
}

/**
 * The gap sentence. A day the archive does not hold is named as unmeasured, and
 * never as a zero, because a page that lists three quiet days and three unmeasured
 * days as the same thing has told the reader something false. The sentence names at
 * most {@link MAX_NAMED_GAP_DAYS} days and counts the rest; the table beside it
 * names every one, so a long range does not become a paragraph of dates.
 * @param {string[]} missingDays
 * @returns {string}
 */
function gapSentence(missingDays) {
  if (missingDays.length === 0) return 'Every day in the window carries a stored value.';
  const count = missingDays.length;
  const days = countWord(count, 'day', 'days');
  const named = missingDays.slice(0, MAX_NAMED_GAP_DAYS);
  const remainder = count - named.length;
  const list = remainder > 0
    ? `${dayList(named)}, and ${remainder} further ${countWord(remainder, 'day', 'days')}`
    : dayList(named);
  return `No stored value for ${list}: ${count} ${days} ${count === 1 ? 'is' : 'are'} unmeasured, not zero.`;
}

/**
 * The sentences the figure states in text. Every claim in them is a stored number,
 * a count of days, or a statement that something was not measured.
 * @param {LineChartModel} model
 * @returns {string}
 */
function describe(model) {
  const { label, rangeFrom, rangeTo, storedDays, missingDays, maxValue } = model;
  const window = `${rangeFrom} to ${rangeTo}`;
  /** @type {string[]} */
  const sentences = [];
  if (model.storedDays.length === 0) {
    sentences.push(`${label}: no day in ${window} carries a stored value, so there is nothing to plot.`);
  } else {
    sentences.push(
      `${label}: ${storedDays.length} of the ${model.calendarDayCount} ${countWord(model.calendarDayCount, 'day', 'days')} `
      + `in ${window} ${countWord(storedDays.length, 'carries', 'carry')} a stored value.`,
    );
  }
  sentences.push(gapSentence(missingDays));
  if (model.storedDays.length > 0) {
    sentences.push(maxValue === 0
      ? 'Every stored value is 0.'
      : `The value axis runs from 0 to ${formatValue(maxValue)}, the largest stored value.`);
  }
  if (model.boundaryDay !== null && withinWindow(model, model.boundaryDay)) {
    sentences.push(`First collected day: ${model.boundaryDay}.`);
  }
  sentences.push(...model.provenanceNotes);
  return sentences.join(' ');
}

/**
 * The provenance sentences: where collected history begins, what the window before
 * that boundary is, and which stored days the archive recorded as backfilled.
 *
 * They are stated only when the caller supplied the archive's recorded read. Without
 * it this module knows no boundary and claims none, because a caption asserting that
 * a window is "since connection rather than history" is a statement about a
 * collection that only the read can support.
 *
 * Every sentence here is a number, a difference or a statement that something was
 * not measured. None of them scores the repository, ranks it, sets a threshold or
 * claims a direction, and none of them says a day before the boundary was measured:
 * the window before it is described as evidence reconstructed on connect, which is
 * what it is.
 * @param {LineChartModel} model
 * @returns {string[]}
 */
function provenanceNotes(model) {
  if (model.provenanceState === null) return [];
  const { boundaryDay, storedDays, preBoundaryStoredDays, missingDays } = model;
  /** @type {string[]} */
  const notes = [];

  if (boundaryDay === null) {
    notes.push(
      'No collection has been recorded for this repository, so there is no first collected day to mark.',
      'Every stored day here was reconstructed on first connect, so this window is the span since '
      + 'connection rather than the repository\'s history.',
    );
  } else if (model.boundaryInWindow) {
    notes.push(
      `The vertical marker sits on ${boundaryDay}, and no stored day before it is drawn as a collected reading.`,
    );
    if (preBoundaryStoredDays.length > 0) {
      const count = preBoundaryStoredDays.length;
      const span = `${preBoundaryStoredDays[0]} to ${preBoundaryStoredDays[preBoundaryStoredDays.length - 1]}`;
      const since = `reconstructed on first connect, so the window before ${boundaryDay} is the span `
        + 'since connection rather than the repository\'s history.';
      // The backfilled wording is used only when the archive recorded every stored day
      // before the boundary as a backfill, which is what a first-connect backfill
      // writes. A day with no recorded source is named as unmeasured rather than
      // called backfilled: this module does not put a provenance claim in the archive's
      // mouth, and the table's own column says which days carried a source.
      notes.push(preBoundaryStoredDays.every((day) => model.backfilledDays.includes(day))
        ? `The ${count} stored ${countWord(count, 'day', 'days')} from ${span} before ${boundaryDay} `
          + `${countWord(count, 'is', 'are')} backfilled: ${since}`
        : `The ${count} stored ${countWord(count, 'day', 'days')} from ${span} ${countWord(count, 'falls', 'fall')} `
          + `before ${boundaryDay}, the first collected day: ${since}`);
    } else {
      notes.push(`No stored day in this window falls before ${boundaryDay}.`);
    }
  } else if (boundaryDay > model.rangeTo) {
    notes.push(
      `Collected history begins on ${boundaryDay}, after this window of ${model.rangeFrom} to `
      + `${model.rangeTo}: what this window shows is the span since connection rather than the `
      + 'repository\'s history.',
    );
  } else {
    notes.push(`Collected history began on ${boundaryDay}, before this window of ${model.rangeFrom} to ${model.rangeTo}.`);
  }

  // The counts stand in for "which days were backfilled and which were collected" in
  // the sentences. They are stated only when every stored day carries a recorded
  // source: counting a day the archive never labelled as either would be inventing a
  // provenance claim, and the table's own column says "not recorded" for it instead.
  if (storedDays.length > 0 && model.unrecordedSourceDays.length === 0) {
    const backfilled = model.backfilledDays.length;
    const collected = model.collectedDays.length;
    notes.push(
      `${backfilled} stored ${countWord(backfilled, 'day', 'days')} ${countWord(backfilled, 'is', 'are')} `
      + `backfilled and ${collected} ${countWord(collected, 'is', 'are')} collected.`,
    );
  }

  if (missingDays.length > 0) {
    notes.push('A day with no stored value was never measured, and an unmeasured day is not a small number.');
  }
  return notes;
}

/**
 * Read the request the way the archive reads it, refusing a malformed window
 * before a single day is looked up.
 * @param {LineChartRequest} request
 * @returns {LineChartRequest}
 */
function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('A chart needs a request with a label and an observation array');
  }
  if (typeof request.label !== 'string' || request.label === '') {
    throw new TypeError('A chart needs a label naming the metric in a reader\'s words');
  }
  if (request.boundaryDay !== undefined) dayTime(request.boundaryDay, 'boundary day');
  if (request.valueLabel !== undefined && (typeof request.valueLabel !== 'string' || request.valueLabel === '')) {
    throw new TypeError('A chart value label is a column heading; supply a string or none');
  }
  if (request.id !== undefined && !/^[A-Za-z0-9_-]+$/.test(request.id)) {
    throw new TypeError('A chart id may hold letters, digits, hyphens and underscores only');
  }
  return request;
}

/**
 * An element id prefix that is stable for the same input, so rendering twice
 * produces the same bytes and a page with two charts can still address each one.
 * @param {LineChartRequest} request
 * @returns {string}
 */
function figureId(request) {
  if (request.id !== undefined) return `chart-${request.id}`;
  const slug = request.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `chart-${slug === '' ? 'series' : slug}`;
}

/**
 * Whether a day falls inside the window the chart covers. A boundary day outside
 * the window is still true of the repository but is not drawn on this chart, so the
 * figure does not claim to annotate something it is not showing.
 * @param {LineChartModel} model
 * @param {string} day ISO calendar day.
 * @returns {boolean}
 */
function withinWindow(model, day) {
  return day >= model.rangeFrom && day <= model.rangeTo;
}

/**
 * The bottom axis labels: the first day, the boundary day and the last day, and
 * nothing else, because a tick per day stops being readable at a month. When the
 * boundary day is one of the two ends it keeps its own wording rather than being
 * labelled twice.
 * @param {LineChartModel} model
 * @returns {{day: string, text: string, x: number}[]}
 */
function dayLabels(model) {
  const byDay = new Map();
  byDay.set(model.rangeFrom, model.rangeFrom);
  byDay.set(model.rangeTo, model.rangeTo);
  if (model.boundaryDay !== null && withinWindow(model, model.boundaryDay)) {
    byDay.set(model.boundaryDay, `collected from ${model.boundaryDay}`);
  }
  /** @type {{day: string, text: string, x: number}[]} */
  const labels = [];
  for (const [day, text] of byDay) {
    const dayIndex = Math.round(
      (dayTime(day, 'window day') - dayTime(model.rangeFrom, 'window start day')) / DAY_MS,
    );
    labels.push({ day, text, x: xFor(dayIndex, model.calendarDayCount) });
  }
  labels.sort((left, right) => left.day.localeCompare(right.day));
  return labels.slice(0, MAX_DAY_LABELS);
}

/**
 * Build the chart model: the calendar, the runs, the scales, the axis values and
 * the table rows, all derived here so the markup below is a formatting pass with
 * no arithmetic in it.
 * @param {LineChartRequest} request
 * @returns {LineChartModel}
 */
export function buildLineChart(request) {
  const checked = validateRequest(request);
  const byDay = readObservations(checked.observations);
  const calendarDays = readCalendarDays(checked.calendarDays, byDay);
  const provenance = readProvenanceInput(checked);
  const boundaryDay = provenance.firstCollectedDay;

  /** @type {string[]} */
  const storedDays = [];
  /** @type {string[]} */
  const missingDays = [];
  /** @type {string[]} */
  const backfilledDays = [];
  /** @type {string[]} */
  const collectedDays = [];
  /** @type {string[]} */
  const unrecordedSourceDays = [];
  /** @type {string[]} */
  const preBoundaryStoredDays = [];
  /** @type {Map<string, {source: 'backfill'|'collected'|null, backfilled: boolean, dashed: boolean}>} */
  const provenanceByDay = new Map();
  let maxValue = 0;
  for (const day of calendarDays) {
    const observation = byDay.get(day);
    if (observation === undefined) {
      missingDays.push(day);
      continue;
    }
    const record = readDayProvenance(day, observation, provenance);
    provenanceByDay.set(day, record);
    storedDays.push(day);
    if (record.backfilled) backfilledDays.push(day);
    else if (record.source === SOURCE_COLLECTED) collectedDays.push(day);
    else unrecordedSourceDays.push(day);
    if (boundaryDay !== null && day < boundaryDay) preBoundaryStoredDays.push(day);
    if (observation.value > maxValue) maxValue = observation.value;
  }

  // A series of zeros still needs a domain to divide by, so the domain is one
  // rather than the zero that would make every coordinate `NaN`.
  const valueDomainTop = maxValue > 0 ? maxValue : 1;
  const runs = splitRuns(calendarDays, byDay, valueDomainTop, provenanceByDay);

  const boundaryIndex = boundaryDay === null ? -1 : calendarDays.indexOf(boundaryDay);
  const boundaryInWindow = boundaryIndex >= 0;

  /** @type {ChartRow[]} */
  const rows = calendarDays.map((day) => {
    const observation = byDay.get(day);
    if (observation === undefined) {
      return {
        day, value: null, gap: true, text: GAP_CELL_TEXT, source: null, dashed: false,
        sourceText: NO_SOURCE_TEXT,
      };
    }
    const record = provenanceByDay.get(day);
    const source = record?.source ?? null;
    /** @type {string} */
    let sourceText = UNRECORDED_SOURCE_TEXT;
    if (source === SOURCE_BACKFILL) sourceText = BACKFILL_SOURCE_TEXT;
    else if (source === SOURCE_COLLECTED) sourceText = COLLECTED_SOURCE_TEXT;
    return {
      day,
      value: observation.value,
      gap: false,
      text: formatValue(observation.value),
      source,
      dashed: record?.dashed ?? false,
      sourceText,
    };
  });

  /** @type {ChartPoint[]} */
  const storedPoints = [];
  for (const run of runs) storedPoints.push(...run.points);

  // The chart carries provenance when the caller supplied the archive's recorded
  // read, when it named a boundary directly, or when the stored days themselves say
  // which were backfilled. Only then is there something for the legend and the
  // table's provenance column to describe.
  const provenanceKnown = provenance.state !== null
    || boundaryDay !== null
    || [...byDay.values()].some((observation) => observation.source !== undefined);

  /** @type {LineChartModel} */
  const model = {
    id: figureId(checked),
    label: checked.label,
    valueLabel: checked.valueLabel ?? DEFAULT_VALUE_LABEL,
    rangeFrom: calendarDays[0],
    rangeTo: calendarDays[calendarDays.length - 1],
    calendarDayCount: calendarDays.length,
    storedPoints,
    storedDays,
    missingDays,
    runs: runs.filter((run) => run.points.length > 1),
    markerRuns: runs.filter((run) => run.points.length === 1),
    maxValue,
    valueDomainTop,
    valueTicks: valueTicks(maxValue),
    rows,
    provenanceState: provenance.state,
    boundaryDay,
    boundaryInWindow,
    boundaryX: boundaryInWindow ? xFor(boundaryIndex, calendarDays.length) : null,
    provenanceKnown,
    backfilledDays,
    collectedDays,
    unrecordedSourceDays,
    preBoundaryStoredDays,
    legendEntries: [...LEGEND_ENTRIES],
    sourceColumnLabel: SOURCE_COLUMN_LABEL,
    provenanceNotes: [],
    plottable: storedDays.length > 0,
    summary: '',
    tableCaption: '',
  };
  model.provenanceNotes = provenanceNotes(model);
  model.summary = describe(model);
  model.tableCaption = `${model.label}: stored values by day, ${model.rangeFrom} to ${model.rangeTo}. `
    + `${model.storedDays.length} of ${model.calendarDayCount} ${countWord(model.calendarDayCount, 'day', 'days')} `
    + `${countWord(model.storedDays.length, 'carries', 'carry')} a stored value; every other row is a gap `
    + 'and holds no stored value, not zero.';
  // The provenance sentences ride in the caption too, because the caption is what a
  // screen reader reaches through the chart's `aria-describedby`: a legend that only
  // exists as two dashes would leave the boundary claim in the picture alone.
  if (model.provenanceNotes.length > 0) {
    model.tableCaption = `${model.tableCaption} ${model.provenanceNotes.join(' ')}`;
  }
  return model;
}

/**
 * The value axis: one tick per value, `0` at the baseline and the largest stored
 * value at the top. The group is hidden from assistive technology because `desc`
 * states the same range in words - the numbers a reader needs must not exist only
 * as tick text.
 * @param {LineChartModel} model
 * @returns {string}
 */
function renderValueAxis(model) {
  const baseY = PLOT_TOP + PLOT_HEIGHT;
  /** @type {string[]} */
  const parts = [
    `<line class="chart-axis-line" x1="${PLOT_LEFT}" y1="${baseY}" `
      + `x2="${PLOT_LEFT + PLOT_WIDTH}" y2="${baseY}" />`,
    `<line class="chart-axis-line" x1="${PLOT_LEFT}" y1="${PLOT_TOP}" x2="${PLOT_LEFT}" y2="${baseY}" />`,
  ];
  for (const value of model.valueTicks) {
    const y = yFor(value, model.valueDomainTop);
    parts.push(
      `<g class="chart-value-tick" data-value="${escapeAttribute(formatValue(value))}">`
      + `<line class="chart-axis-line" x1="${PLOT_LEFT - 6}" y1="${y}" x2="${PLOT_LEFT}" y2="${y}" />`
      + `<text class="chart-axis-label" x="${PLOT_LEFT - 10}" y="${round2(y + 4)}" text-anchor="end">`
      + `${escapeText(formatValue(value))}</text></g>`,
    );
  }
  for (const label of dayLabels(model)) {
    const anchor = model.calendarDayCount === 1
      ? 'middle'
      : label.day === model.rangeFrom
        ? 'start'
        : label.day === model.rangeTo
          ? 'end'
          : 'middle';
    parts.push(
      `<g class="chart-day-tick" data-day="${escapeAttribute(label.day)}">`
      + `<line class="chart-axis-line" x1="${label.x}" y1="${baseY}" x2="${label.x}" y2="${baseY + 6}" />`
      + `<text class="chart-axis-label" x="${label.x}" y="${baseY + 20}" text-anchor="${anchor}">`
      + `${escapeText(label.text)}</text></g>`,
    );
  }
  return parts.join('');
}

/**
 * The `data-dash` and `data-source` attributes naming how a run is labelled. They
 * are emitted only when the chart carries provenance, so a chart with nothing to say
 * about provenance produces the bytes it produced before this annotation existed.
 * @param {ChartRun} run
 * @returns {string}
 */
function runProvenanceAttributes(run) {
  const dash = run.dashed ? ' data-dash="dashed"' : '';
  const source = run.backfilled
    ? ` data-source="${SOURCE_BACKFILL}"`
    : run.dashed ? ' data-source="pre-boundary"' : '';
  return `${dash}${source}`;
}

/**
 * The plotted series: one `polyline` per run of two or more stored days, and one
 * `circle` per run of exactly one. A run never spans a missing day, so no element
 * in this output bridges a hole, and a run never mixes the two treatments, so every
 * dash on screen belongs to the days that carry it.
 *
 * The two treatments differ by dash and by fill rather than by colour: a backfilled
 * run is dashed and a lone backfilled day is a hollow dashed marker, while a
 * collected run is solid and a lone collected day is filled. A reader who cannot
 * separate the two hues - or who sees none at all - still reads the difference, and
 * the paired table names each day's source in words.
 * @param {LineChartModel} model
 * @returns {string}
 */
function renderSeries(model) {
  /** @type {string[]} */
  const parts = [];
  for (const run of model.runs) {
    const points = run.points.map((point) => `${point.x},${point.y}`).join(' ');
    parts.push(
      `<polyline class="chart-line" data-run="${run.index}" `
      + `data-from="${escapeAttribute(run.from)}" data-to="${escapeAttribute(run.to)}" `
      + `data-days="${run.days}" data-points="${run.points.length}"${runProvenanceAttributes(run)} `
      + `points="${points}" fill="none" stroke="currentColor" stroke-width="2" `
      + `stroke-linejoin="round" stroke-linecap="round"`
      + `${run.dashed ? ` stroke-dasharray="${BACKFILL_DASH_PATTERN}"` : ''} />`,
    );
  }
  for (const run of model.markerRuns) {
    const point = run.points[0];
    parts.push(
      `<circle class="chart-point" data-run="${run.index}" `
      + `data-day="${escapeAttribute(run.from)}"${runProvenanceAttributes(run)} `
      + `cx="${point.x}" cy="${point.y}" r="3" `
      + (run.dashed
        ? `fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="${BACKFILL_DASH_PATTERN}"`
        : 'fill="currentColor"')
      + ' />',
    );
  }
  return parts.join('');
}

/**
 * The provenance boundary: a vertical rule at the first collected day's own x
 * coordinate, drawn after the series so it is visible over the line, and carrying
 * the day in an attribute so a test can check the position against the archive's own
 * coordinates rather than against a second copy of them.
 *
 * There is no marker at all for a repository the archive records as never collected,
 * and none when the boundary falls outside the window: a rule at the window start
 * would stand for a collection no run recorded. The figure's `desc`, its caption and
 * its table caption all say in words which case this is, so the marker is never the
 * only place the boundary exists.
 * @param {LineChartModel} model
 * @returns {string}
 */
function renderBoundary(model) {
  if (model.boundaryX === null || model.boundaryDay === null) return '';
  const x = model.boundaryX;
  const baseY = PLOT_TOP + PLOT_HEIGHT;
  return `<g class="chart-boundary" data-day="${escapeAttribute(model.boundaryDay)}">`
    + `<line class="chart-boundary-line" x1="${x}" y1="${PLOT_TOP}" x2="${x}" y2="${baseY}" `
    + `stroke="currentColor" stroke-width="2" /></g>`;
}

/**
 * The two-entry legend, naming backfilled and collected beside a swatch of each
 * treatment. It appears only when the chart carries provenance and has something to
 * annotate - a legend beside a figure that was not drawn explains a picture nobody
 * is looking at - and each entry names its own treatment in words as well as drawing
 * it, so the distinction never rests on a dash or a hue alone. The swatches are
 * `aria-hidden` because the text beside them already carries the same statement for
 * a screen reader.
 * @param {LineChartModel} model
 * @returns {string}
 */
function renderLegend(model) {
  if (!model.provenanceKnown || !model.plottable) return '';
  const entries = model.legendEntries.map((entry) => (
    `<li class="chart-legend-entry" data-source="${escapeAttribute(entry.key)}">`
    + '<svg class="chart-legend-swatch" viewBox="0 0 36 12" width="36" height="12" '
    + `aria-hidden="true" focusable="false">`
    + `<line class="chart-legend-swatch-line" x1="2" y1="6" x2="34" y2="6" `
    + `stroke="currentColor" stroke-width="2"`
    + `${entry.dashed ? ` stroke-dasharray="${BACKFILL_DASH_PATTERN}"` : ''} /></svg>`
    + `<span class="chart-legend-label">${escapeText(entry.text)}</span></li>`
  ));
  return `<ul class="chart-legend" id="${escapeAttribute(`${model.id}-legend`)}">${entries.join('')}</ul>`;
}

/**
 * The inline SVG fragment.
 *
 * With no stored day at all there is no figure: an axes-only chart reads as a
 * repository that measured nothing and reached zero, which is a claim the archive
 * does not support. The paired table and the summary sentence carry that case in
 * words instead.
 * @param {LineChartModel} model
 * @returns {string}
 */
export function renderLineChartSvg(model) {
  if (!model.plottable) return '';
  const titleId = `${model.id}-title`;
  const descId = `${model.id}-desc`;
  const tableCaptionId = `${model.id}-table-caption`;
  return `<svg class="chart-figure" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" `
    + `width="100%" height="${CHART_HEIGHT}" preserveAspectRatio="xMidYMid meet" role="img" `
    + `aria-labelledby="${escapeAttribute(titleId)}" `
    + `aria-describedby="${escapeAttribute(`${descId} ${tableCaptionId}`)}" focusable="false">`
    + `<title id="${escapeAttribute(titleId)}">${escapeText(model.label)}</title>`
    + `<desc id="${escapeAttribute(descId)}">${escapeText(model.summary)}</desc>`
    + `<g class="chart-axis" aria-hidden="true">${renderValueAxis(model)}</g>`
    + `<g class="chart-series">${renderSeries(model)}</g>`
    + renderBoundary(model)
    + '</svg>';
}

/**
 * The paired data table: one row per calendar day, so a gap is a named day rather
 * than an omission a screen reader would read as a zero. Reachable from the chart
 * because the `svg` above points its `aria-describedby` at this caption.
 *
 * The provenance column is the text half of the dash treatment: every day says in
 * words whether the archive recorded it as backfilled, as collected, or not at all,
 * so a reader who never sees the picture is told which days are which. It appears
 * only when the chart carries provenance to describe, keeping the table's shape
 * unchanged for a chart that has none.
 * @param {LineChartModel} model
 * @returns {string}
 */
export function renderLineChartTable(model) {
  const captionId = `${model.id}-table-caption`;
  const rows = model.rows.map((row) => {
    const className = row.gap ? 'chart-row chart-row-gap' : 'chart-row';
    const source = model.provenanceKnown ? `<td>${escapeText(row.sourceText)}</td>` : '';
    return `<tr class="${className}"><th scope="row">${escapeText(row.day)}</th>`
      + `<td>${escapeText(row.text)}</td>${source}</tr>`;
  });
  const heading = model.provenanceKnown
    ? `<th scope="col">${escapeText(model.sourceColumnLabel)}</th>`
    : '';
  return `<table class="chart-table" id="${escapeAttribute(`${model.id}-table`)}">`
    + `<caption id="${escapeAttribute(captionId)}">${escapeText(model.tableCaption)}</caption>`
    + '<thead><tr><th scope="col">Day</th>'
    + `<th scope="col">${escapeText(model.valueLabel)}</th>${heading}</tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table>`;
}

/**
 * The chart and its paired table, as one figure.
 *
 * The returned string is escaped HTML built by a pure function: no clock, no I/O,
 * no randomness, and identical input produces identical bytes.
 *
 * The order is chart, caption, legend, table: the caption states the numbers and the
 * boundary in sentences, the legend names the two treatments beside their swatches,
 * and the table carries every day - stored, backfilled, collected or a gap - as text.
 * @param {LineChartRequest} request
 * @returns {string}
 */
export function renderLineChart(request) {
  const model = buildLineChart(request);
  const svg = renderLineChartSvg(model);
  return `<figure class="chart" id="${escapeAttribute(`${model.id}-figure`)}" `
    + `aria-labelledby="${escapeAttribute(`${model.id}-title`)}">`
    + svg
    + `<figcaption class="chart-caption" id="${escapeAttribute(`${model.id}-caption`)}">`
    + `${escapeText(model.summary)}</figcaption>`
    + renderLegend(model)
    + renderLineChartTable(model)
    + '</figure>';
}