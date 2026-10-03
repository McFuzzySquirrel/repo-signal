/**
 * A flat, dated list of what changed, as a pure function over stored observation arrays.
 *
 * This is the reading a maintainer scans when a number moved and they want the day. It is the
 * easiest place in the product to invent a story, because the archive is full of days nobody
 * measured and a list that walks the calendar rather than the stored rows will cheerfully report
 * that a repository lost everything it had on the night of the 4th. Six decisions keep this list
 * to what the archive holds.
 *
 * 1. **The walk is over stored rows, never over calendar days.** Each metric's stored days are
 *    taken in date order and compared with the *previous stored day*. A day the range covers and
 *    the archive does not hold produces no entry at all, is named in `missingDays`, and is never
 *    given a value of zero. That is the whole difference between a quiet day and an unmeasured
 *    one, and it is why `seriesCoverage` reports the covered days separately from the stored ones.
 * 2. **An entry compares two stored values and says nothing about what happened between them.**
 *    When a gap sits between the two stored days the entry carries `previousDate`,
 *    `daysSincePrevious` and the `missingDays` in between, so a reader can see that the comparison
 *    spans an unmeasured stretch. It never renders that stretch as a fall to zero.
 * 3. **Insufficient data is a named variant, not a null and not an exception.** `changeList`
 *    returns `SufficientChangeList | InsufficientChangeList`. The insufficient variant carries no
 *    `entries`, `totalEntries` or `capped` field at all, so a surface that forgets to branch
 *    cannot render a list that was never computed. The reason is data - the minimum number of
 *    stored days and the days the range holds - so a page displays the evidence rather than
 *    re-deriving a sentence about it. This is the same variant shape `deltas.js` and
 *    `divergence.js` speak, and the same `sufficient` / `insufficient` / `below-minimum-volume`
 *    vocabulary, so all three readings render missing evidence the same way.
 * 4. **A day that repeats its previous value produces no entry.** An archive that stores the same
 *    count on six consecutive days has recorded one quiet stretch, not six events, and a list with
 *    six zero-difference rows is a list nobody reads. The *comparisons* that found nothing are
 *    still counted and reported, because "six comparisons, none of which differed" is a reading.
 * 5. **The list is flat and capped.** Entries are ordered by absolute change, largest first, with
 *    the newer day first among equal magnitudes, and each carries its own date so the list reads
 *    as a timeline. At {@link MAX_CHANGE_ENTRIES} entries the rest are counted, not dropped, and
 *    the count travels beside the list. No grouping, no icons, no severity, no colour, and no
 *    ranking: the order is an ordering of numbers, not a ranking of anything.
 * 6. **No score, no grade, no threshold, no verdict, no trend word.** Every claim is a stored
 *    number, a difference between stored numbers, or a statement that the data is insufficient. A
 *    repository with three clones gets the same shape as a busy one, because the shape does not
 *    depend on the size of the numbers - only the words beside them change count.
 *    `tests/insight-changes.test.js` asserts that absence rather than assuming it.
 *
 * **The order of the entries is a property of the arithmetic, not of the page.** The list is
 * ordered by absolute change because that is what this feature specifies, and the tie-break is the
 * newer day first so that equal magnitudes still read as a timeline. Which end of the list a page
 * puts at the top is a legibility decision belonging to the view, and every entry carries the date
 * that decision needs, so no number here depends on a chart order that a human has yet to choose.
 *
 * This module imports nothing at all: no database handle, no filesystem, no clock, no date
 * library, no statistics library, no charting dependency. The day helpers are deliberately repeated
 * from `deltas.js` and `divergence.js` rather than shared, so each insight module stands alone.
 *
 * Identical input therefore produces byte-identical output, and no test that uses this module waits
 * on real time.
 */

const DAY_MS = 86_400_000;

/**
 * Entries the list carries before the remainder is counted rather than listed. The documented
 * default in `docs/features/chart-and-insight.md` section 9: twenty, because a hundred-row list is
 * not read. The cap bounds the prose a page has to render, never the evidence: `totalEntries` and
 * `omittedEntries` carry every difference the walk found.
 */
export const MAX_CHANGE_ENTRIES = 20;

/**
 * Stored days one metric needs before it can produce any entry at all: a previous day to compare
 * against, and the day that differs from it. Below this the result is insufficient data naming the
 * minimum, which is a stated requirement rather than a volume verdict.
 */
export const REQUIRED_STORED_DAYS = 2;

/** The stored days could be compared, so the list of what changed is reported. */
export const CHANGE_LIST_SUFFICIENT = /** @type {const} */ ('sufficient');
/** The stored days cannot carry a comparison, and the result says how many it needed. */
export const CHANGE_LIST_INSUFFICIENT = /** @type {const} */ ('insufficient');

/** No supplied metric holds enough stored days to compare one against another. */
export const REASON_BELOW_MINIMUM_VOLUME = /** @type {const} */ ('below-minimum-volume');

/**
 * Days the summary names in full before it counts the remainder. A range can hold a year nobody
 * collected, and a sentence listing every one of those days is a sentence nobody reads. The full
 * list is never dropped - it is carried as `missingDays` on every coverage record and on every
 * entry that spans a gap - so this bounds the prose, not the evidence.
 */
export const MAX_NAMED_GAP_DAYS = 10;

/** Metrics the summary names one by one before it counts the rest. */
export const MAX_NAMED_SERIES = 3;

/** @typedef {'sufficient'|'insufficient'} ChangeListStatus */
/** @typedef {'below-minimum-volume'} ChangeListReason */

/**
 * One stored day of one metric, as the archive's range read returns it: the day the value was
 * observed on and the value itself. `source` is not required and is never branched on here -
 * provenance belongs to the chart's boundary annotation, and this list treats a backfilled day and a
 * collected day identically rather than blending one silently into the other.
 *
 * A day with no stored value is absent from the array entirely; it is never present with a zero
 * standing in for it.
 *
 * @typedef {object} Observation
 * @property {string} day UTC calendar day the value was observed on, ISO `YYYY-MM-DD`.
 * @property {number} value The stored count. A day with no stored value is absent from the array
 *   entirely; it is never present with a zero standing in for it.
 */

/**
 * The inclusive range the list is about. The router validates the range a page is given, so an
 * inverted or malformed range is refused before it can arrive here.
 *
 * @typedef {object} InsightRange
 * @property {string} from First day, inclusive, ISO `YYYY-MM-DD`.
 * @property {string} to Last day, inclusive, ISO `YYYY-MM-DD`.
 */

/**
 * One metric's stored days. The list is walked metric by metric and each entry names the metric it
 * belongs to, so two metrics moving on the same day produce two flat entries rather than one row
 * that has to be split by a reader.
 *
 * @typedef {object} MetricSeries
 * @property {string} metric The archive metric key these observations belong to, echoed back on
 *   every entry: `clones`, `unique-cloners`, `views`, `unique-visitors`, `stars`,
 *   `commit-activity`, `owner-participation`.
 * @property {Observation[]} observations Stored days for that metric, in any order. A day with no
 *   stored value is absent from this array, and a day outside the range is ignored rather than
 *   treated as an error.
 */

/**
 * @typedef {object} ChangeListRequest
 * @property {MetricSeries[]} series The metrics to walk. One entry per metric, each metric named
 *   once; passing the same metric twice is refused rather than walked twice, which would report one
 *   observation as two events.
 * @property {InsightRange} range Inclusive range the list is about.
 */

/**
 * One day whose stored value differs from the previous stored day of the same metric.
 *
 * `previousDate` is deliberately separate from `date`: when the two are not consecutive the entry
 * is a comparison across an unmeasured stretch, and a reader is entitled to see how long that
 * stretch was and which days it covered. Those days are carried in `missingDays` and are never
 * given a value of zero.
 *
 * @typedef {object} ChangeEntry
 * @property {string} metric The metric key this change belongs to.
 * @property {string} date The day whose stored value differs, ISO `YYYY-MM-DD`.
 * @property {string} previousDate The day the previous stored value belongs to. Equal to the day
 *   before `date` when the two stored days are consecutive, earlier when they are not.
 * @property {number} previousValue The stored value on `previousDate`.
 * @property {number} newValue The stored value on `date`.
 * @property {number} change `newValue - previousValue`: a difference, never a verdict. Negative
 *   when the count on the later day is the smaller of the two.
 * @property {number} absoluteChange `Math.abs(change)`: the number the list is ordered by.
 * @property {number} daysSincePrevious Calendar days from `previousDate` to `date`: 1 when the two
 *   stored days are consecutive, more when days in between hold no stored value.
 * @property {string[]} missingDays Days between the two stored days that hold no stored value for
 *   this metric, oldest first. Empty when the stored days are consecutive.
 * @property {string} summary One flat sentence: the metric, both days, both stored values, the
 *   difference, and a statement of the unmeasured days in between when there are any.
 */

/**
 * What one metric contributed: how many stored days the range holds for it, which days of the range
 * it does not, and how many consecutive stored-day pairs were compared. This describes what was
 * walked, not a grouping of the entries: `entries` stays flat, and each entry carries its own
 * metric key.
 *
 * @typedef {object} SeriesCoverage
 * @property {string} metric The metric key this coverage belongs to.
 * @property {number} storedDays Stored days the range holds for this metric.
 * @property {string[]} missingDays Days the range covers that hold no stored value for this
 *   metric, oldest first. Never counted as zeros.
 * @property {number} comparisons Consecutive stored-day pairs compared for this metric, which is
 *   `storedDays - 1` while the metric holds at least one day.
 * @property {boolean} canCompare True when the metric holds at least {@link REQUIRED_STORED_DAYS}
 *   stored days, so a previous stored day exists to compare against.
 */

/**
 * The coverage fields are repeated in both variants rather than nested under one object, so a view
 * reads `changeList.seriesCoverage` the same way whichever variant it got.
 *
 * @typedef {object} SufficientChangeList
 * @property {'sufficient'} status The variant a caller branches on.
 * @property {InsightRange} range The range the list was asked about.
 * @property {string[]} metrics The metric keys that were walked, in the order they were supplied.
 * @property {number} requiredDays Stored days a metric needs before it can produce an entry:
 *   {@link REQUIRED_STORED_DAYS}.
 * @property {number} availableDays Calendar days the selected range covers.
 * @property {number} storedDays Stored rows the range holds across every supplied metric.
 * @property {number} comparedPairs Consecutive stored-day pairs compared across every metric: the
 *   sum of the per-metric comparison counts. A larger number than `entries` is the evidence that
 *   the days which did not differ were still examined.
 * @property {SeriesCoverage[]} seriesCoverage What each metric contributed, in the order supplied.
 * @property {ChangeEntry[]} entries The flat list, ordered by absolute change with the newer day
 *   first among equal magnitudes, capped at {@link MAX_CHANGE_ENTRIES}.
 * @property {number} totalEntries Differences the walk found before the cap, so a capped list never
 *   reads as a complete one.
 * @property {number} maxEntries The cap in force: {@link MAX_CHANGE_ENTRIES}.
 * @property {number} omittedEntries Differences counted but not listed, always
 *   `totalEntries - entries.length`.
 * @property {boolean} capped True when the cap removed entries, so a view can say so rather than
 *   leaving the reader to assume the list is the whole history.
 * @property {string} summary One sentence: what was walked, how many comparisons were made, how
 *   many of them differed, how the list is ordered, and what the cap left out - followed by the
 *   gap sentence when the range holds days the archive never stored.
 */

/**
 * @typedef {object} InsufficientChangeList
 * @property {'insufficient'} status The variant a caller branches on.
 * @property {ChangeListReason} reason Why no list is reported.
 * @property {InsightRange} range The range the list was asked about.
 * @property {string[]} metrics The metric keys that were walked, in the order they were supplied.
 * @property {number} requiredDays Stored days a metric needs before it can produce an entry:
 *   {@link REQUIRED_STORED_DAYS}.
 * @property {number} availableDays Calendar days the selected range covers.
 * @property {number} storedDays Stored rows the range holds across every supplied metric.
 * @property {number} comparedPairs Consecutive stored-day pairs compared across every metric: zero,
 *   which is why this variant was reached.
 * @property {SeriesCoverage[]} seriesCoverage What each metric contributed, in the order supplied.
 * @property {string} summary One sentence naming the minimum and the stored days the range holds.
 */

/**
 * Validate a real UTC calendar day, rejecting normalised impossible days such as `2026-02-30`.
 * The same rule the archive layer applies, so a day means one thing.
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
 * Every day an inclusive range covers, oldest first. This list says nothing about values; it is the
 * set a stored observation is looked up in.
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
 * Calendar days from one stored day to the next, counting the day itself: 1 for two consecutive
 * stored days, more when days in between hold no stored value. Read off the calendar rather than
 * counted from the day list, so a month boundary cannot make a one-day gap read as a month.
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function daysApart(from, to) {
  return Math.round((dayTime(to, 'comparison day') - dayTime(from, 'previous stored day')) / DAY_MS);
}

/**
 * Index one metric's stored observations by day.
 *
 * The array is validated rather than trusted, because the three ways it can be wrong all produce a
 * plausible entry instead of an error: a day that is not a real calendar date would be walked in a
 * position nobody can check, a value that is not a number would produce a difference of `NaN`, and
 * two rows for one day would report one observation as two events. Each is refused by name. A
 * negative count is refused too, because a count below zero is a contract failure rather than a
 * reading to compare - the *difference* between two stored values may still be negative, and is.
 * @param {Observation[]} observations
 * @param {string} metric Metric key these observations belong to, named in the messages.
 * @returns {Map<string, number>}
 */
function indexObservations(observations, metric) {
  if (!Array.isArray(observations)) {
    throw new TypeError(`A change list needs an observation array of stored ${metric} days; supply one`);
  }
  /** @type {Map<string, number>} */
  const values = new Map();
  for (const observation of observations) {
    if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new TypeError('Each observation must be a record with a day and a value');
    }
    dayTime(observation.day, `${metric} observation day`);
    const { value } = observation;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`${metric} observation ${observation.day} must carry a finite numeric count; `
        + 'a day with no stored value is absent from the array, never a zero standing in for it');
    }
    if (value < 0) {
      throw new TypeError(`${metric} observation ${observation.day} carries a negative count; `
        + 'a count below zero is a contract failure, not a reading to compare');
    }
    if (values.has(observation.day)) {
      throw new TypeError(`Two ${metric} observations carry the day ${observation.day}; one day has one stored value`);
    }
    values.set(observation.day, value);
  }
  return values;
}

/**
 * Read the request the way the rest of the archive reads it: identity first, then the range, then
 * the series the caller walks. A range that is malformed or inverted is refused here, before any
 * day is looked up, and a metric named twice is refused before it can be walked twice.
 * @param {ChangeListRequest} request
 * @returns {ChangeListRequest}
 */
function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('A change list needs a request with a series array and an inclusive range');
  }
  const { series, range } = request;
  if (!Array.isArray(series) || series.length === 0) {
    throw new TypeError('A change list needs at least one metric series to walk');
  }
  if (range === null || typeof range !== 'object' || Array.isArray(range)) {
    throw new TypeError('A change list needs an inclusive range with a from day and a to day');
  }
  dayTime(range.from, 'range start day');
  dayTime(range.to, 'range end day');
  if (dayTime(range.from, 'range start day') > dayTime(range.to, 'range end day')) {
    throw new RangeError('Reversed day range; supply from <= to');
  }
  /** @type {Set<string>} */
  const named = new Set();
  for (const entry of series) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Each series must be a record with a metric and an observation array');
    }
    const { metric } = entry;
    if (typeof metric !== 'string' || metric === '') {
      throw new TypeError('Each series needs a metric name; supply the archive metric key it belongs to');
    }
    if (named.has(metric)) {
      throw new TypeError(`The metric ${metric} was supplied twice; one metric is walked once`);
    }
    named.add(metric);
  }
  return request;
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} many
 * @returns {string} The word that agrees with the count.
 */
function plural(count, singular, many) {
  return count === 1 ? singular : many;
}

/**
 * A list of days as one sentence reads: `2026-03-04`, `2026-03-04 and 2026-03-05`, or
 * `2026-03-04, 2026-03-05 and 2026-03-06`.
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
 * A difference with its direction written out. `+2` and `-6` are arithmetic; the plain `2` beside
 * them reads as a count, and a count cannot tell a reader which of the two stored values is the
 * larger one.
 * @param {number} change
 * @returns {string}
 */
function signed(change) {
  return change > 0 ? `+${change}` : `${change}`;
}

/**
 * The days between two stored days that hold no stored value for this metric.
 *
 * Taken from the range's missing-day list rather than from a walk of the calendar, so the days named
 * are the days the archive is known not to hold, and a day the archive does hold for another metric
 * never appears here. Each day stays a day: none of them is given a value.
 * @param {string[]} missingDays
 * @param {string} previousDate
 * @param {string} date
 * @returns {string[]} Oldest first.
 */
function daysSkipped(missingDays, previousDate, date) {
  return missingDays.filter((day) => day > previousDate && day < date);
}

/**
 * What the days in between the two stored values contribute to an entry's sentence. Empty when the
 * stored days are consecutive, and it never gives an unmeasured day a value.
 * @param {string[]} skipped Days between the two stored days holding no stored value.
 * @returns {string} Empty when the stored days are consecutive.
 */
function gapClause(skipped) {
  const count = skipped.length;
  if (count === 0) return '';
  return `, and ${count} ${plural(count, 'day', 'days')} between them ${plural(count, 'holds', 'hold')} `
    + 'no stored value';
}

/**
 * What one metric holds over the range: the stored days in date order, the covered days it does not
 * hold, and how many consecutive stored-day pairs will be compared. The stored days are looked up in
 * the calendar, never generated from it, so a hole stays a hole.
 * @param {string} metric
 * @param {Observation[]} observations
 * @param {string[]} calendar Every day the range covers, oldest first.
 * @returns {{stored: Array<{day: string, value: number}>, missingDays: string[]}}
 */
function readMetricDays(metric, observations, calendar) {
  const values = indexObservations(observations, metric);
  /** @type {Array<{day: string, value: number}>} */
  const stored = [];
  /** @type {string[]} */
  const missingDays = [];
  for (const day of calendar) {
    const value = values.get(day);
    if (value === undefined) missingDays.push(day);
    else stored.push({ day, value });
  }
  return { stored, missingDays };
}

/**
 * What one metric contributes to the list, and the entries its stored days produced.
 *
 * The walk compares each stored day with the one before it *among the stored days*, so a day the
 * archive never held is skipped rather than filled. A day whose value equals the previous stored
 * value produces no entry: an unchanged day is not an event, and the comparison that found it
 * unchanged is counted in the coverage record all the same.
 * @param {MetricSeries} series
 * @param {string[]} calendar Every day the range covers, oldest first.
 * @returns {{coverage: SeriesCoverage, entries: ChangeEntry[]}}
 */
function walkMetric(series, calendar) {
  const { metric, observations } = series;
  const { stored, missingDays } = readMetricDays(metric, observations, calendar);
  /** @type {ChangeEntry[]} */
  const entries = [];
  let comparisons = 0;
  for (let index = 1; index < stored.length; index += 1) {
    const previous = stored[index - 1];
    const current = stored[index];
    comparisons += 1;
    // An unchanged day produces no entry. The comparison still happened and is still counted.
    if (current.value === previous.value) continue;
    const change = current.value - previous.value;
    const skipped = daysSkipped(missingDays, previous.day, current.day);
    entries.push({
      metric,
      date: current.day,
      previousDate: previous.day,
      previousValue: previous.value,
      newValue: current.value,
      change,
      absoluteChange: Math.abs(change),
      daysSincePrevious: daysApart(previous.day, current.day),
      missingDays: skipped,
      // The entry states a comparison of two stored values and stops there: no cause, no
      // explanation, and no claim about why a count moved. The days in between are named, never
      // valued.
      summary: `${metric} recorded ${current.value} on ${current.day}, after ${previous.value} recorded on `
        + `${previous.day}; the difference is ${signed(change)}${gapClause(skipped)}`,
    });
  }
  return {
    coverage: {
      metric,
      storedDays: stored.length,
      missingDays,
      comparisons,
      canCompare: stored.length >= REQUIRED_STORED_DAYS,
    },
    entries,
  };
}

/**
 * Order the entries by absolute change, largest first, with the newer day first among equal
 * magnitudes so equal numbers still read as a timeline. The comparison is a total order - one entry
 * exists per metric and day, so no two entries share both - which is what makes the result identical
 * on every run rather than dependent on the order the rows happened to arrive in.
 * @param {ChangeEntry[]} entries
 * @returns {ChangeEntry[]} A new array; the input is left alone.
 */
function byAbsoluteChange(entries) {
  return [...entries].sort((left, right) => {
    if (right.absoluteChange !== left.absoluteChange) return right.absoluteChange - left.absoluteChange;
    if (left.date < right.date) return 1;
    if (left.date > right.date) return -1;
    return 0;
  });
}

/**
 * What one metric holds, as a clause of the summary. The stored count comes first; the days the
 * range covers and this metric does not are named after it, so the reader never sees a count with
 * no mention of the days behind it.
 * @param {SeriesCoverage} coverage
 * @param {number} availableDays
 * @returns {string}
 */
function seriesClause(coverage, availableDays) {
  const gaps = coverage.missingDays.length;
  if (coverage.storedDays === 0) {
    return `${coverage.metric} holds no stored value on any of the ${availableDays} ${plural(availableDays, 'day', 'days')} `
      + 'the range covers';
  }
  const held = `${coverage.metric} holds ${coverage.storedDays} stored `
    + `${plural(coverage.storedDays, 'day', 'days')}`;
  if (gaps === 0) return `${held}, every day of the range`;
  return `${held}, and ${gaps} of the range's ${availableDays} ${plural(availableDays, 'day', 'days')} `
    + `${plural(gaps, 'holds', 'hold')} no stored value`;
}

/**
 * The days the range covers that hold no stored value for at least one supplied metric, named once
 * each and oldest first.
 * @param {SeriesCoverage[]} coverage
 * @returns {string[]}
 */
function gapDays(coverage) {
  return [...new Set(coverage.flatMap((entry) => entry.missingDays))].sort();
}

/**
 * The gap sentence both variants append when the range holds days the archive never stored. It names
 * them, states the rule that keeps them from becoming zeros, and bounds itself: a range with more
 * than {@link MAX_NAMED_GAP_DAYS} holes names the first few and counts the rest, because a gap absent
 * from the output reads as a quiet day rather than an unmeasured one, and a sentence of four hundred
 * dates reads as none at all. Every one of them is still carried as `missingDays` on the coverage
 * records and on the entries that span them.
 * @param {SeriesCoverage[]} coverage
 * @param {number} availableDays
 * @returns {string} Empty when the range holds every day of every metric, otherwise a sentence.
 */
function gapSentence(coverage, availableDays) {
  const gaps = gapDays(coverage);
  const count = gaps.length;
  if (count === 0) return '';
  const subject = `The ${count} ${plural(count, 'day', 'days')} of the selected ${availableDays}-day range that `
    + `${plural(count, 'holds', 'hold')} no stored value for at least one supplied metric `
    + `${plural(count, 'is', 'are')} a gap rather than a reading`;
  if (count === 1) {
    return `${subject}: ${gaps[0]}; no gap day is given a value of zero`;
  }
  if (count <= MAX_NAMED_GAP_DAYS) {
    return `${subject}: ${dayList(gaps)}; no gap day is given a value of zero`;
  }
  const remainder = count - MAX_NAMED_GAP_DAYS;
  return `${subject}, of which ${dayList(gaps.slice(0, MAX_NAMED_GAP_DAYS))} ${plural(remainder, 'is', 'are')} `
    + `named here and ${remainder} further ${plural(remainder, 'gap day is', 'gap days are')} counted but not `
    + 'named; the list carries every gap day, and no gap day is given a value of zero';
}

/**
 * Close a sentence and append the gap sentence when the range has gaps, capitalised and separated
 * by a full stop. A summary that trails off without naming its holes is the failure this exists to
 * prevent, so the two sentences are joined here rather than at each call site.
 * @param {string} sentence The first sentence of a summary.
 * @param {SeriesCoverage[]} coverage
 * @param {number} availableDays
 * @returns {string}
 */
function withGapSentence(sentence, coverage, availableDays) {
  const gaps = gapSentence(coverage, availableDays);
  return gaps === '' ? `${sentence}.` : `${sentence}. ${gaps}`;
}

/**
 * The flat, dated list of what changed over the selected range.
 *
 * The walk is over the stored days of each supplied metric, in date order, comparing every stored
 * day with the previous stored day of that same metric. A day whose value differs produces one entry
 * naming the metric, the date, the previous stored value and the new one; a day whose value repeats
 * the previous one produces no entry at all; a day the archive never stored produces no entry and is
 * named as a gap rather than given a value of zero. Entries are ordered by absolute change, largest
 * first, and capped at {@link MAX_CHANGE_ENTRIES} with the remainder counted.
 *
 * The result is a named union, so a caller that forgets to branch on `status` cannot read an
 * `entries` list off a result that never computed one: the insufficient variant carries no such
 * field. That variant is reached only when no supplied metric holds
 * {@link REQUIRED_STORED_DAYS} stored days, because without a previous stored day there is nothing
 * to compare, and a stated requirement is the honest answer to that.
 *
 * Identical input returns identical output: no clock is read, every day comes from the range, and
 * nothing is cached between calls.
 *
 * @param {ChangeListRequest} request
 * @returns {SufficientChangeList|InsufficientChangeList}
 */
export function changeList(request) {
  validateRequest(request);
  const { series, range } = request;
  const calendar = enumerateDays(range.from, range.to);
  const availableDays = calendar.length;

  /** @type {SeriesCoverage[]} */
  const coverage = [];
  /** @type {ChangeEntry[]} */
  const found = [];
  let storedDays = 0;
  let comparedPairs = 0;
  for (const entry of series) {
    const walked = walkMetric(entry, calendar);
    coverage.push(walked.coverage);
    found.push(...walked.entries);
    storedDays += walked.coverage.storedDays;
    comparedPairs += walked.coverage.comparisons;
  }

  const metrics = series.map((entry) => entry.metric);
  const shared = {
    range,
    metrics,
    requiredDays: REQUIRED_STORED_DAYS,
    availableDays,
    storedDays,
    comparedPairs,
    seriesCoverage: coverage,
  };

  // No metric held enough stored days for a single comparison, so there is nothing to compare and
  // no entry to report. The requirement and the days the range does hold are named instead.
  if (comparedPairs === 0) {
    const named = coverage.slice(0, MAX_NAMED_SERIES).map((entry) => seriesClause(entry, availableDays));
    const unnamed = metrics.length - named.length;
    const tail = unnamed > 0 ? `, and ${unnamed} further ${plural(unnamed, 'metric is', 'metrics are')} `
      + 'counted but not named here' : '';
    return {
      status: CHANGE_LIST_INSUFFICIENT,
      reason: REASON_BELOW_MINIMUM_VOLUME,
      ...shared,
      summary: withGapSentence(`insufficient data: a change entry needs ${REQUIRED_STORED_DAYS} stored days of one `
        + 'metric to compare a day against the previous stored day, and the selected range '
        + `${range.from} to ${range.to} holds ${storedDays} stored ${plural(storedDays, 'day', 'days')} `
        + `across ${metrics.length} supplied ${plural(metrics.length, 'metric', 'metrics')}: `
        + `${named.join('; ')}${tail}`, coverage, availableDays),
    };
  }

  const ordered = byAbsoluteChange(found);
  const listed = ordered.slice(0, MAX_CHANGE_ENTRIES);
  const omittedEntries = ordered.length - listed.length;
  const largest = listed[0];
  // What the comparisons found: either the number that differed, or the statement that none did.
  // Both counts are in the sentence, so a list of no entries reads as six comparisons that found
  // nothing rather than as an absence of evidence.
  const differenceClause = ordered.length === 0
    ? 'none of them recorded a different value, so no change entry is reported'
    : `${ordered.length} of them recorded a different value, listed by absolute difference with the `
      + `largest first${largest === undefined ? '' : `, the largest being ${signed(largest.change)} on ${largest.date}`}`;
  const capClause = omittedEntries === 0
    ? ''
    : `; the ${listed.length} largest absolute ${plural(listed.length, 'difference', 'differences')} are listed `
      + `and ${omittedEntries} ${plural(omittedEntries, 'difference is', 'differences are')} counted but not listed`;

  return {
    status: CHANGE_LIST_SUFFICIENT,
    ...shared,
    entries: listed,
    totalEntries: ordered.length,
    maxEntries: MAX_CHANGE_ENTRIES,
    omittedEntries,
    capped: omittedEntries > 0,
    summary: withGapSentence(`the selected range ${range.from} to ${range.to} holds ${storedDays} stored `
      + `${plural(storedDays, 'day', 'days')} across ${metrics.length} ${plural(metrics.length, 'metric', 'metrics')} `
      + `(${metrics.join(', ')}); ${comparedPairs} day-to-day `
      + `${plural(comparedPairs, 'comparison was', 'comparisons were')} made and ${differenceClause}${capClause}`,
    coverage, availableDays),
  };
}