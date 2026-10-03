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
 * Five decisions follow from that, and each of them is asserted by a test rather
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
 *
 * There is no script, no animation, no external asset and no charting dependency:
 * the only import is the shared escaping module, because a repository name may
 * contain markup and a chart label is a reader-facing string.
 *
 * **Seam for the provenance task (`RS-VIZ-05`).** `boundaryDay` is accepted and
 * drawn as a labelled tick on the bottom axis, because the bottom axis names the
 * first, last and boundary days. What is deliberately *not* here: the vertical
 * boundary marker, the dashed treatment for backfilled days, the two-entry legend
 * and the first-connect caption. Each of those is annotation rather than geometry,
 * each is asserted by that task's own tests, and a stored day's `source` is carried
 * on the model without changing how it is drawn - so a day is never drawn as if it
 * were collected on the strength of a guess.
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
 * One stored day of one metric. A day the archive holds nothing for is absent from
 * this array entirely - never present with a zero standing in for it - which is
 * what lets this module tell a quiet day from an unmeasured one.
 *
 * @typedef {object} ChartObservation
 * @property {string} day UTC calendar day the value was observed on, ISO `YYYY-MM-DD`.
 * @property {number} value The stored value: a count, or a cumulative total.
 * @property {string} [source] `'backfill'` or `'collected'` when the archive
 *   recorded it. Carried on the model for the provenance annotation; it never
 *   changes a coordinate in this task.
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
 * contains a missing day, which is the whole point of it.
 *
 * @typedef {object} ChartRun
 * @property {number} index 1-based position of the run in the range, oldest first.
 * @property {string} from First day of the run.
 * @property {string} to Last day of the run.
 * @property {number} days Calendar days the run covers.
 * @property {ChartPoint[]} points
 */

/**
 * One row of the paired data table: one calendar day, stored or not. `gap` is what
 * the row says in words, so nothing in the table can be read as a zero.
 *
 * @typedef {object} ChartRow
 * @property {string} day
 * @property {number|null} value Stored value, or null for a day the archive holds none.
 * @property {boolean} gap
 * @property {string} text What the cell says.
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
 * @property {string|null} boundaryDay Boundary day the caller supplied, or null.
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
 * @property {string} [boundaryDay] First collected day, drawn as a labelled bottom
 *   tick. The marker, legend and caption that give it meaning belong to the
 *   provenance annotation.
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
 * Split the window's stored days into contiguous runs. A missing day closes the run
 * that was open, which is the mechanism that keeps a bridged segment out of the
 * output: the next stored day opens a new run instead of extending the old one.
 * @param {string[]} calendarDays
 * @param {Map<string, ChartObservation>} byDay
 * @param {number} domainTop
 * @returns {ChartRun[]}
 */
function splitRuns(calendarDays, byDay, domainTop) {
  /** @type {ChartRun[]} */
  const runs = [];
  /** @type {ChartRun|null} */
  let open = null;
  calendarDays.forEach((day, dayIndex) => {
    const observation = byDay.get(day);
    if (observation === undefined) {
      open = null;
      return;
    }
    /** @type {ChartPoint} */
    const point = {
      day,
      value: observation.value,
      x: xFor(dayIndex, calendarDays.length),
      y: yFor(observation.value, domainTop),
      dayIndex,
      source: observation.source,
    };
    if (open === null) {
      open = { index: runs.length + 1, from: day, to: day, days: 1, points: [point] };
      runs.push(open);
      return;
    }
    open.to = day;
    open.days += 1;
    open.points.push(point);
  });
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
  return sentences.join(' ');
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

  /** @type {string[]} */
  const storedDays = [];
  /** @type {string[]} */
  const missingDays = [];
  let maxValue = 0;
  for (const day of calendarDays) {
    const observation = byDay.get(day);
    if (observation === undefined) missingDays.push(day);
    else {
      storedDays.push(day);
      if (observation.value > maxValue) maxValue = observation.value;
    }
  }

  // A series of zeros still needs a domain to divide by, so the domain is one
  // rather than the zero that would make every coordinate `NaN`.
  const valueDomainTop = maxValue > 0 ? maxValue : 1;
  const runs = splitRuns(calendarDays, byDay, valueDomainTop);

  /** @type {ChartRow[]} */
  const rows = calendarDays.map((day) => {
    const observation = byDay.get(day);
    if (observation === undefined) return { day, value: null, gap: true, text: GAP_CELL_TEXT };
    return { day, value: observation.value, gap: false, text: formatValue(observation.value) };
  });

  /** @type {ChartPoint[]} */
  const storedPoints = [];
  for (const run of runs) storedPoints.push(...run.points);

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
    boundaryDay: checked.boundaryDay ?? null,
    plottable: storedDays.length > 0,
    summary: '',
    tableCaption: '',
  };
  model.summary = describe(model);
  model.tableCaption = `${model.label}: stored values by day, ${model.rangeFrom} to ${model.rangeTo}. `
    + `${model.storedDays.length} of ${model.calendarDayCount} ${countWord(model.calendarDayCount, 'day', 'days')} `
    + `${countWord(model.storedDays.length, 'carries', 'carry')} a stored value; every other row is a gap `
    + 'and holds no stored value, not zero.';
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
 * The plotted series: one `polyline` per run of two or more stored days, and one
 * `circle` per run of exactly one. A run never spans a missing day, so no element
 * in this output bridges a hole.
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
      + `data-days="${run.days}" data-points="${run.points.length}" points="${points}" `
      + `fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`,
    );
  }
  for (const run of model.markerRuns) {
    const point = run.points[0];
    parts.push(
      `<circle class="chart-point" data-run="${run.index}" `
      + `data-day="${escapeAttribute(run.from)}" cx="${point.x}" cy="${point.y}" r="3" `
      + `fill="currentColor" />`,
    );
  }
  return parts.join('');
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
    + '</svg>';
}

/**
 * The paired data table: one row per calendar day, so a gap is a named day rather
 * than an omission a screen reader would read as a zero. Reachable from the chart
 * because the `svg` above points its `aria-describedby` at this caption.
 * @param {LineChartModel} model
 * @returns {string}
 */
export function renderLineChartTable(model) {
  const captionId = `${model.id}-table-caption`;
  const rows = model.rows.map((row) => {
    const className = row.gap ? 'chart-row chart-row-gap' : 'chart-row';
    return `<tr class="${className}"><th scope="row">${escapeText(row.day)}</th>`
      + `<td>${escapeText(row.text)}</td></tr>`;
  });
  return `<table class="chart-table" id="${escapeAttribute(`${model.id}-table`)}">`
    + `<caption id="${escapeAttribute(captionId)}">${escapeText(model.tableCaption)}</caption>`
    + '<thead><tr><th scope="col">Day</th>'
    + `<th scope="col">${escapeText(model.valueLabel)}</th></tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table>`;
}

/**
 * The chart and its paired table, as one figure.
 *
 * The returned string is escaped HTML built by a pure function: no clock, no I/O,
 * no randomness, and identical input produces identical bytes.
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
    + renderLineChartTable(model)
    + '</figure>';
}