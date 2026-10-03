/**
 * Seven-day and week-over-week deltas, as pure functions over an observation array.
 *
 * This module is the arithmetic half of the descriptive layer, and it is where a
 * hole in the archive would turn into a plausible-looking lie if nothing else
 * stopped it. Every decision below exists to keep one rule true: **a missing day
 * is never counted as zero, never interpolated and never carried forward.** A
 * window with a hole in it returns insufficient data naming that calendar day,
 * not a smaller sum that reads as a real decline.
 *
 * Four rules decide what comes out of every function here.
 *
 * 1. **The calendar and the stored rows are separate inputs.** A caller passes the
 *    stored observations for one metric and the inclusive range the page is about;
 *    this module enumerates the days that range covers and looks each one up. A day
 *    the range covers and the archive does not hold stays absent, and its absence
 *    is what an insufficient-data result reports.
 * 2. **Insufficient data is a named variant, not a null and not an exception.**
 *    Both public functions return `SufficientDelta | InsufficientDelta`, so a
 *    surface that forgets to branch renders missing evidence as a missing number
 *    rather than as a wrong one. The reason is data - the missing day list, the
 *    required window, the zero base - so a page can display the evidence without
 *    re-deriving a sentence.
 * 3. **A zero base suppresses the percentage instead of dividing by it.** When the
 *    earlier window sums to zero, the absolute difference is reported, `percentage`
 *    is null and `percentageOmitted` names the reason. `Infinity`, `NaN` and a bare
 *    `0%` never appear: a fabricated ratio beside a real number is worse than no
 *    ratio at all.
 * 4. **No score, no grade, no threshold, no verdict, no trend word.** Every claim
 *    this module makes is a stored number, a difference between stored numbers, or
 *    a statement that the data is insufficient. A repository with three clones and
 *    one unmeasured day gets the same shape as a busy one, because the shape does
 *    not depend on the size of the numbers - only the words beside them change
 *    count. `tests/insight-deltas.test.js` asserts that absence rather than assuming
 *    it.
 *
 * Two anchors, and the difference between them is deliberate. The seven-day reading
 * is anchored on the selected range: the last seven calendar days of the range
 * against the seven before them, which is the pair a maintainer reads off a chart.
 * The week-over-week reading is anchored on the last *complete* week: a week is
 * only complete once its seven days have passed, so the current UTC day is never
 * part of it and the caller states the reference day (`today`) rather than letting
 * this module read a clock. That is why the two readings can end on different days
 * when the range ends today, and why the week-over-week result names the weeks it
 * used. Both are documented in the function that returns them; neither is adapted
 * to a guessed chart order, because the human review that decides chart order is a
 * judgement about legibility and has no bearing on which days a window contains.
 *
 * This module imports nothing at all: no database handle, no filesystem, no clock,
 * no date library, no statistics library, no charting dependency. Identical input
 * therefore produces byte-identical output, and no test that uses this module waits
 * on real time.
 */

const DAY_MS = 86_400_000;

/** Calendar days in one comparison window. */
export const WINDOW_DAYS = 7;
/** Calendar days a comparison of two windows needs: the later window and the one before it. */
export const COMPARISON_DAYS = 14;

/** Two complete windows were stored, so the difference between them is reported. */
export const DELTA_SUFFICIENT = /** @type {const} */ ('sufficient');
/** The stored evidence cannot carry the difference, and says which day is missing. */
export const DELTA_INSUFFICIENT = /** @type {const} */ ('insufficient');

/** The selected range is shorter than the comparison this function computes. */
export const REASON_SHORT_RANGE = /** @type {const} */ ('short-range');
/** At least one window covers a calendar day the archive holds no value for. */
export const REASON_MISSING_DAYS = /** @type {const} */ ('missing-days');

/** The earlier window summed to zero, so there is no base to take a share of. */
export const PERCENTAGE_OMITTED_ZERO_BASE = /** @type {const} */ ('zero-base');

/** The last seven days of the selected range against the seven before them. */
export const COMPARISON_SEVEN_DAY = /** @type {const} */ ('seven-day');
/** The last complete week against the week before it. */
export const COMPARISON_WEEK_OVER_WEEK = /** @type {const} */ ('week-over-week');

/** @typedef {'sufficient'|'insufficient'} DeltaStatus */
/** @typedef {'short-range'|'missing-days'} DeltaReason */
/** @typedef {'zero-base'} DeltaPercentageOmission */
/** @typedef {'seven-day'|'week-over-week'} DeltaComparison */

/**
 * One stored day of one metric, as the archive's range read returns it: the day the
 * value was observed on and the value itself. `source` is not required and is never
 * summed - provenance belongs to the chart's boundary annotation, and this arithmetic
 * does not blend a backfilled day into a collected one differently from any other day.
 *
 * @typedef {object} Observation
 * @property {string} day UTC calendar day the value was observed on, ISO `YYYY-MM-DD`.
 * @property {number} value The stored value. A day with no stored value is absent
 *   from the array entirely; it is never present with a zero standing in for it.
 */

/**
 * The inclusive range a reading is about. The router validates the range a page is
 * given, so an inverted or malformed range is refused before it can arrive here.
 *
 * @typedef {object} InsightRange
 * @property {string} from First day, inclusive, ISO `YYYY-MM-DD`.
 * @property {string} to Last day, inclusive, ISO `YYYY-MM-DD`.
 */

/**
 * One seven-day window, reported as what it covers and what it holds. The two day
 * lists are deliberately separate: `calendarDays` is what the window spans and says
 * nothing about values, while `missingDays` is the subset of them the archive holds
 * nothing for. `sum` is null whenever a covered day is missing, so a sum can never be
 * a total over fewer days than it claims.
 *
 * @typedef {object} DeltaWindow
 * @property {string} from First day of the window.
 * @property {string} to Last day of the window, inclusive.
 * @property {number} days Calendar days the window covers: always {@link WINDOW_DAYS}.
 * @property {string[]} calendarDays Those days, oldest first.
 * @property {string[]} storedDays The covered days that carry a stored value.
 * @property {string[]} missingDays The covered days that carry none, oldest first.
 * @property {number|null} sum Total of the stored values, or null while a day is missing.
 */

/**
 * @typedef {object} SufficientDelta
 * @property {'sufficient'} status The variant a caller branches on.
 * @property {DeltaComparison} comparison Which pair of windows this reading used.
 * @property {string} metric The metric key the observations belonged to, echoed back.
 * @property {InsightRange} range The range the reading was asked about.
 * @property {DeltaWindow} current The later window, complete.
 * @property {DeltaWindow} previous The earlier window, complete.
 * @property {number} change `current.sum - previous.sum`: a difference, never a verdict.
 * @property {number|null} percentage The change as a share of `previous.sum`, rounded for
 *   a reader and null when that sum is zero. The summary prints this same number, so
 *   the two never disagree.
 * @property {DeltaPercentageOmission|null} percentageOmitted Why the percentage is
 *   absent, or null when it is present.
 * @property {string} summary One sentence: both absolute sums first, then the
 *   difference, then the percentage beside the number it came from.
 */

/**
 * @typedef {object} InsufficientDelta
 * @property {'insufficient'} status The variant a caller branches on.
 * @property {DeltaComparison} comparison Which pair of windows this reading needed.
 * @property {string} metric The metric key the observations belonged to, echoed back.
 * @property {InsightRange} range The range the reading was asked about.
 * @property {DeltaReason} reason Why no difference is reported.
 * @property {string[]} missingDays Covered days with no stored value, oldest first;
 *   empty when {@link DeltaReason} is `short-range`.
 * @property {DeltaWindow} current The window that was needed; `sum` is null when a day is missing.
 * @property {DeltaWindow} previous The window before it; `sum` is null when a day is missing.
 * @property {number} requiredDays Calendar days the comparison needs, always {@link COMPARISON_DAYS}.
 * @property {number} availableDays Calendar days the selected range offers to it.
 * @property {string} summary One sentence naming the requirement, or the missing days.
 */

/**
 * @typedef {object} DeltaRequest
 * @property {string} metric Metric key these observations belong to; one metric per
 *   call, so a series of two different metrics can never be summed together.
 * @property {Observation[]} observations Stored days for that metric, in any order. A
 *   day with no stored value is absent from this array, and a day outside the range is
 *   ignored rather than treated as an error.
 * @property {InsightRange} range Inclusive range the reading is about.
 */

/**
 * @typedef {object} WeekOverWeekRequest
 * @property {string} metric
 * @property {Observation[]} observations
 * @property {InsightRange} range
 * @property {string} today Reference UTC day, ISO `YYYY-MM-DD`. Required, not defaulted:
 *   "the last complete week" is undefined without knowing which day is still running,
 *   and reading the clock here would make the module untestable and flaky in a way
 *   that looks like data drift.
 */

/**
 * Validate a real UTC calendar day, rejecting normalised impossible days such as
 * `2026-02-30`. The same rule the archive layer applies, so a day means one thing.
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
 * @param {string} day ISO calendar day.
 * @param {number} count Days to move, negative to move back.
 * @returns {string} The shifted calendar day.
 */
function shiftDay(day, count) {
  return new Date(dayTime(day, 'calendar day') + count * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The earlier of two calendar days.
 * @param {string} left
 * @param {string} right
 * @returns {string}
 */
function earlierDay(left, right) {
  return dayTime(left, 'calendar day') <= dayTime(right, 'calendar day') ? left : right;
}

/**
 * How many calendar days an inclusive range covers, counted from the calendar's own
 * day length rather than assumed to be thirty, so a range spanning a month boundary
 * is never off by one.
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function countDays(from, to) {
  return Math.floor((dayTime(to, 'range end day') - dayTime(from, 'range start day')) / DAY_MS) + 1;
}

/**
 * Every day an inclusive range covers, oldest first. This list says nothing about
 * values; it is the set a stored observation is looked up in.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function enumerateDays(from, to) {
  const start = dayTime(from, 'range start day');
  const end = dayTime(to, 'range end day');
  if (start > end) throw new RangeError('Reversed day range; supply from <= to');
  /** @type {string[]} */
  const days = [];
  for (let time = start; time <= end; time += DAY_MS) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Index the stored observations by day.
 *
 * The array is validated rather than trusted, because the three ways it can be wrong
 * all produce a plausible number instead of an error: a day that is not a real
 * calendar date would be looked up under a key nothing else can match, a
 * non-numeric value would sum as `NaN`, and two rows for one day would silently
 * double-count a single observation. Each is refused by name.
 * @param {Observation[]} observations
 * @returns {Map<string, number>}
 */
function indexObservations(observations) {
  if (!Array.isArray(observations)) {
    throw new TypeError('A delta needs an observation array of stored days; supply one');
  }
  /** @type {Map<string, number>} */
  const values = new Map();
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
    if (values.has(observation.day)) {
      throw new TypeError(`Two observations carry the day ${observation.day}; one day has one stored value`);
    }
    values.set(observation.day, value);
  }
  return values;
}

/**
 * Read the request the way the rest of the archive reads it: identity first, then the
 * range, then the observations the caller indexes. A range that is malformed or
 * inverted is refused here, before any day is looked up.
 * @template {DeltaRequest|WeekOverWeekRequest} T
 * @param {T} request
 * @returns {T}
 */
function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('A delta needs a request with a metric, observations and a range');
  }
  const { metric, range } = request;
  if (typeof metric !== 'string' || metric === '') {
    throw new TypeError('A delta needs a metric name; supply the archive metric key it belongs to');
  }
  if (range === null || typeof range !== 'object' || Array.isArray(range)) {
    throw new TypeError('A delta needs an inclusive range with a from day and a to day');
  }
  dayTime(range.from, 'range start day');
  dayTime(range.to, 'range end day');
  if (dayTime(range.from, 'range start day') > dayTime(range.to, 'range end day')) {
    throw new RangeError('Reversed day range; supply from <= to');
  }
  return request;
}

/**
 * One window read against the stored days: what it covers, what it holds, what it is
 * missing, and the total only when every day it covers is stored. The missing list is
 * produced before any total, so no arithmetic runs on a window with a hole in it.
 * @param {string} from
 * @param {string} to
 * @param {Map<string, number>} values Stored days by day.
 * @returns {DeltaWindow}
 */
function readWindow(from, to, values) {
  const calendarDays = enumerateDays(from, to);
  /** @type {string[]} */
  const storedDays = [];
  /** @type {string[]} */
  const missingDays = [];
  let sum = 0;
  for (const day of calendarDays) {
    const value = values.get(day);
    if (value === undefined) missingDays.push(day);
    else {
      storedDays.push(day);
      sum += value;
    }
  }
  return {
    from,
    to,
    days: calendarDays.length,
    calendarDays,
    storedDays,
    missingDays,
    sum: missingDays.length === 0 ? sum : null,
  };
}

/**
 * @param {string[]} days
 * @returns {string} The day list as one sentence reads: `2026-03-04`, or
 *   `2026-03-04 and 2026-03-05`.
 */
function dayList(days) {
  if (days.length === 0) return '';
  if (days.length === 1) return days[0];
  if (days.length === 2) return `${days[0]} and ${days[1]}`;
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}

/**
 * The percentage as a figure a reader can check beside its absolute value.
 *
 * Two decimal places are enough for any ratio a maintainer reads, except for a real
 * change small enough to round away at that precision - one clone against a thousand
 * is 0.1%, and one against a million is 0.0001%. Those keep three significant
 * digits rather than becoming `0%`, because a percentage of zero beside a genuine
 * difference of one is a wrong claim about the data. The returned number and the
 * sentence are rounded by this one function, so a surface that prints the number and
 * a surface that prints the sentence never disagree.
 * @param {number} percentage Exact ratio as a percentage.
 * @param {number} change The absolute difference the ratio describes.
 * @returns {number}
 */
function roundedPercentage(percentage, change) {
  if (change === 0) return 0;
  const twoDecimals = Number(percentage.toFixed(2));
  return twoDecimals === 0 ? Number(percentage.toPrecision(3)) : twoDecimals;
}

/**
 * The two windows a reading compares, as the caller named them.
 * @typedef {object} WindowPair
 * @property {string} currentFrom
 * @property {string} currentTo
 * @property {string} previousFrom
 * @property {string} previousTo
 * @property {string} currentLabel How the later window is named in a sentence.
 * @property {string} previousLabel How the earlier window is named in a sentence.
 */

/**
 * The reading itself, shared by both entry points: read both windows, refuse the
 * comparison when either covers a day the archive does not hold, and otherwise report
 * the two sums, their difference and - only over a non-zero base - the percentage.
 * @param {DeltaRequest} request
 * @param {DeltaComparison} comparison
 * @param {WindowPair} pair
 * @param {Map<string, number>} values Stored days by day.
 * @returns {SufficientDelta|InsufficientDelta}
 */
function compareWindows(request, comparison, pair, values) {
  const { metric, range } = request;
  const current = readWindow(pair.currentFrom, pair.currentTo, values);
  const previous = readWindow(pair.previousFrom, pair.previousTo, values);
  // Named oldest first across both windows, so the list reads as a timeline of holes
  // rather than as "the later window's holes, then the earlier window's".
  const missingDays = [...current.missingDays, ...previous.missingDays].sort();

  if (missingDays.length > 0 || current.sum === null || previous.sum === null) {
    /** @type {(string|null)[]} */
    const holes = [];
    if (current.missingDays.length > 0) {
      holes.push(`${dayList(current.missingDays)} in ${pair.currentLabel}`);
    }
    if (previous.missingDays.length > 0) {
      holes.push(`${dayList(previous.missingDays)} in ${pair.previousLabel}`);
    }
    return {
      status: DELTA_INSUFFICIENT,
      comparison,
      metric,
      range,
      reason: REASON_MISSING_DAYS,
      missingDays,
      current,
      previous,
      requiredDays: COMPARISON_DAYS,
      availableDays: countDays(range.from, range.to),
      summary: `insufficient data: ${metric} holds no stored value for ${holes.join(' and ')}, so the `
        + 'difference between the two windows is not reported and no missing day is counted as zero',
    };
  }

  const currentSum = current.sum;
  const previousSum = previous.sum;
  const change = currentSum - previousSum;
  const exactPercentage = previousSum === 0 ? null : (change / previousSum) * 100;
  const percentage = exactPercentage === null ? null : roundedPercentage(exactPercentage, change);
  const percentageClause = percentage === null
    ? ' and no percentage is reported, because the earlier window totals zero'
    : ` and ${percentage}% of ${previousSum}`;
  return {
    status: DELTA_SUFFICIENT,
    comparison,
    metric,
    range,
    current,
    previous,
    change,
    percentage,
    percentageOmitted: percentage === null ? PERCENTAGE_OMITTED_ZERO_BASE : null,
    summary: `${metric} recorded ${currentSum} over ${pair.currentLabel} (${current.from} to ${current.to}) and `
      + `${previousSum} over ${pair.previousLabel} (${previous.from} to ${previous.to}); the difference is `
      + `${change}${percentageClause}`,
  };
}

/**
 * The reading that names the requirement instead of a number, for a range that cannot
 * contain the two windows at all. No window is reported with a total and no
 * percentage, change or sum accompanies the result: a partial window compared against
 * another partial window is exactly the smaller number that reads as a finding.
 * @param {DeltaRequest} request
 * @param {DeltaComparison} comparison
 * @param {WindowPair} pair The windows the calculation wanted.
 * @param {number} availableDays Calendar days the selected range offers to it.
 * @param {string} requirement What the comparison needs, named in words.
 * @param {Map<string, number>} values Stored days by day.
 * @returns {InsufficientDelta}
 */
function shortRange(request, comparison, pair, availableDays, requirement, values) {
  const { metric, range } = request;
  const current = readWindow(pair.currentFrom, pair.currentTo, values);
  const previous = readWindow(pair.previousFrom, pair.previousTo, values);
  return {
    status: DELTA_INSUFFICIENT,
    comparison,
    metric,
    range,
    reason: REASON_SHORT_RANGE,
    missingDays: [],
    // The totals are withheld with the reading itself: these two windows are outside
    // the range the caller asked about, so their sums describe days nobody selected.
    current: { ...current, sum: null },
    previous: { ...previous, sum: null },
    requiredDays: COMPARISON_DAYS,
    availableDays,
    summary: `insufficient data: a ${requirement} comparison needs ${COMPARISON_DAYS} stored days ending `
      + `${pair.currentTo}, and the selected range covers ${availableDays} days from ${range.from} to ${range.to}`,
  };
}

/**
 * The last seven days of the selected range against the seven days before them.
 *
 * The later window is the range's own last seven calendar days, so the reading is
 * anchored on what the page is showing rather than on today. A range that cannot
 * contain two windows - fewer than {@link COMPARISON_DAYS} days - is refused by name
 * before anything is summed. A window with a day the archive does not hold returns
 * insufficient data naming that day; a stored zero is a reading and is summed like
 * any other, which is why the zero *base* case can be told apart from the missing
 * day case at all.
 *
 * Identical input returns identical output: no clock is read, no day is derived from
 * anything but the range, and nothing is cached between calls.
 *
 * @param {DeltaRequest} request
 * @returns {SufficientDelta|InsufficientDelta}
 */
export function sevenDayDelta(request) {
  validateRequest(request);
  const values = indexObservations(request.observations);
  const { range } = request;
  const rangeDays = countDays(range.from, range.to);
  /** @type {WindowPair} */
  const pair = {
    currentFrom: shiftDay(range.to, -(WINDOW_DAYS - 1)),
    currentTo: range.to,
    previousFrom: shiftDay(range.to, -(2 * WINDOW_DAYS - 1)),
    previousTo: shiftDay(range.to, -WINDOW_DAYS),
    currentLabel: `the last ${WINDOW_DAYS} days of the selected range`,
    previousLabel: `the ${WINDOW_DAYS} days before them`,
  };
  if (rangeDays < COMPARISON_DAYS) {
    return shortRange(request, COMPARISON_SEVEN_DAY, pair, rangeDays, 'seven-day', values);
  }
  return compareWindows(request, COMPARISON_SEVEN_DAY, pair, values);
}

/**
 * The last complete week against the week before it.
 *
 * A week is complete only once its seven days have passed, so the reference day
 * `today` is never part of the later window: the reading ends on the day before
 * `today`, or on the range's last day when that day is already in the past. Both
 * windows are therefore whole weeks, and the result names the dates it used so a
 * reader can see which days were compared rather than inferring them from a chart.
 *
 * The range bounds the reading rather than defining it: when the range cannot contain
 * both weeks - including the ordinary case of a 14-day range that ends today, whose
 * last complete week reaches one day past the range's start - the result names the
 * fourteen-day requirement instead of shortening a window.
 *
 * @param {WeekOverWeekRequest} request
 * @returns {SufficientDelta|InsufficientDelta}
 */
export function weekOverWeekDelta(request) {
  validateRequest(request);
  const values = indexObservations(request.observations);
  const { range, today } = request;
  dayTime(today, 'reference day');
  const lastCompleteDay = earlierDay(range.to, shiftDay(today, -1));
  /** @type {WindowPair} */
  const pair = {
    currentFrom: shiftDay(lastCompleteDay, -(WINDOW_DAYS - 1)),
    currentTo: lastCompleteDay,
    previousFrom: shiftDay(lastCompleteDay, -(2 * WINDOW_DAYS - 1)),
    previousTo: shiftDay(lastCompleteDay, -WINDOW_DAYS),
    currentLabel: 'the last complete week',
    previousLabel: 'the week before it',
  };
  const availableDays = Math.max(0, countDays(range.from, lastCompleteDay));
  if (dayTime(pair.previousFrom, 'window start day') < dayTime(range.from, 'range start day')) {
    return shortRange(request, COMPARISON_WEEK_OVER_WEEK, pair, availableDays, 'week-over-week', values);
  }
  return compareWindows(request, COMPARISON_WEEK_OVER_WEEK, pair, values);
}