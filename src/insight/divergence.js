/**
 * Stars-versus-clones divergence, as a pure function over two stored observation arrays.
 *
 * This is the reading that answers "is this project used more than it is recognised, or the
 * other way round?", and it is the easiest place in the product to say something true-sounding
 * that the archive does not support. Five decisions keep it honest.
 *
 * 1. **The calendar and the stored rows are separate inputs.** The caller passes the stored
 *    unique-cloner days and the stored star days for one repository plus the inclusive range the
 *    page is about; this module enumerates the days that range covers and looks each one up in
 *    both. A day the range covers and the archive does not hold stays absent, is named in the
 *    result, and is never summed as a zero. The summary names up to {@link MAX_NAMED_GAP_DAYS} of
 *    those days and counts the rest; every one of them is carried as data either way.
 * 2. **A collected day is a day both metrics were read on.** Unique cloners arrive from
 *    collection only and stars may be backfilled, so the two series do not always cover the same
 *    days. A day carrying only one of them can carry no comparison, so it is named as a gap and
 *    excluded from the count of collected days - which is what makes the minimum-volume floor
 *    mean what it says.
 * 3. **Insufficient data is a named variant, not a null and not an exception.**
 *    `starsVersusClonesDivergence` returns `SufficientDivergence | InsufficientDivergence`, and the
 *    insufficient variant carries no `stars`, `uniqueCloners`, `ratio` or `percentage` field at
 *    all, so a surface that forgets to branch cannot render a number that was never computed.
 *    The reason is data - the minimum, the collected-day count, the gap days - so a page displays
 *    the evidence instead of re-deriving a sentence about it.
 * 4. **A zero star count suppresses the ratio instead of dividing by it.** Both absolutes are
 *    still reported, because they are both real readings, `ratio` and `percentage` are null and
 *    `ratioOmitted` names the zero base. `Infinity`, `NaN` and a bare `0%` never appear: a
 *    fabricated ratio beside a real number is worse than no ratio at all. This is the one case
 *    where a *sufficient* reading carries an omitted ratio, and it is stated as such rather than
 *    being hidden behind an insufficient-data result that would throw away two true numbers.
 * 5. **No score, no grade, no threshold, no verdict, no trend word.** Every claim is a stored
 *    number, a difference between stored numbers, or a statement that the data is insufficient.
 *    The sentence compares the two numbers and stops there. A repository with three clones gets
 *    the same shape as a busy one, because the shape does not depend on the size of the numbers.
 *    `tests/insight-divergence.test.js` asserts that absence rather than assuming it.
 *
 * **The two numbers are not the same kind of number, and the wording says so.**
 *
 * `stars` is a cumulative level: the star count recorded on the last collected day of the range,
 * carried in `starsDay` so a reader knows which day the level belongs to. `uniqueCloners` is the
 * sum of the stored *daily* unique-cloner counts, because that is the only unique-cloner quantity
 * the archive holds - GitHub reports distinct cloners per day and per rolling window, and this
 * tool stores the per-day figure and never extrapolates it. A cloner who cloned on three days of
 * the range is therefore counted three times, so the total is reported as `uniqueCloner day
 * counts` and `uniqueClonersBasis` carries the same statement as data for the view. That ceiling
 * is why the ratio is labelled as unique-cloner day counts per star: it is not a count of distinct
 * people, and no output of this module may be read as one.
 *
 * The minimum-volume floor is the documented default of
 * `docs/features/chart-and-insight.md` section 9: fourteen collected days, matching one full
 * traffic window. Below it the result is insufficient data naming the minimum - never a
 * low-volume verdict, and never a smaller number that reads as a finding.
 *
 * This module imports nothing at all: no database handle, no filesystem, no clock, no date
 * library, no statistics library, no charting dependency. The day helpers are deliberately
 * repeated from `deltas.js` rather than shared, so each insight module stands alone; the result
 * vocabulary - `sufficient` / `insufficient`, `below-minimum-volume`, `zero-base` - is the one
 * both modules speak, so a page renders missing evidence the same way in all three readings.
 *
 * Identical input therefore produces byte-identical output, and no test that uses this module
 * waits on real time.
 */

const DAY_MS = 86_400_000;

/** Collected days a divergence reading needs before it will report a number. The documented
 * default in `docs/features/chart-and-insight.md` section 9: fourteen, matching one full traffic
 * window, below which the reading is insufficient data. */
export const MINIMUM_COLLECTED_DAYS = 14;

/**
 * Gap days the summary sentence names in full before it counts the remainder. A range can hold
 * hundreds of days the archive never collected, and a sentence listing every one of them is a
 * sentence nobody reads; the change list makes the same trade at twenty entries. The full list is
 * never dropped - it is carried as `missingDays`, `missingClonerDays` and `missingStarDays` - so
 * this bounds the prose, not the evidence.
 */
export const MAX_NAMED_GAP_DAYS = 10;

/** Both metrics were read on enough days, so the comparison is reported. */
export const DIVERGENCE_SUFFICIENT = /** @type {const} */ ('sufficient');
/** The stored evidence cannot carry the comparison, and says which requirement is unmet. */
export const DIVERGENCE_INSUFFICIENT = /** @type {const} */ ('insufficient');

/** Fewer collected days than {@link MINIMUM_COLLECTED_DAYS}. */
export const REASON_BELOW_MINIMUM_VOLUME = /** @type {const} */ ('below-minimum-volume');
/** The recorded star count is zero, so there is no base to divide by. */
export const RATIO_OMITTED_ZERO_BASE = /** @type {const} */ ('zero-base');

/** The unique-cloner day-count total is the larger of the two numbers. */
export const LARGER_CLONERS = /** @type {const} */ ('unique-cloners');
/** The recorded star count is the larger of the two numbers. */
export const LARGER_STARS = /** @type {const} */ ('stars');
/** The two numbers are equal. */
export const LARGER_EQUAL = /** @type {const} */ ('equal');

/** @typedef {'sufficient'|'insufficient'} DivergenceStatus */
/** @typedef {'below-minimum-volume'} DivergenceReason */
/** @typedef {'zero-base'} DivergenceRatioOmission */
/** @typedef {'unique-cloners'|'stars'|'equal'} DivergenceLarger */

/**
 * One stored day of one metric, as the archive's range read returns it: the day the value was
 * observed on and the value itself. `source` is not required and is never branched on here -
 * provenance belongs to the chart's boundary annotation, and this reading treats a backfilled star
 * day and a collected star day identically rather than blending one silently into the other.
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
 * The inclusive range a reading is about. The router validates the range a page is given, so an
 * inverted or malformed range is refused before it can arrive here.
 *
 * @typedef {object} InsightRange
 * @property {string} from First day, inclusive, ISO `YYYY-MM-DD`.
 * @property {string} to Last day, inclusive, ISO `YYYY-MM-DD`.
 */

/**
 * @typedef {object} DivergenceRequest
 * @property {Observation[]} uniqueCloners Stored daily unique-cloner counts for one repository, in
 *   any order. GitHub's distinct-cloners figure per UTC day, which the archive stores and never
 *   extrapolates to a window total.
 * @property {Observation[]} stars Stored cumulative star counts for the same repository, in any
 *   order. One level per day, so the reading uses the level on the last collected day.
 * @property {InsightRange} range Inclusive range the reading is about.
 */

/**
 * What the range covers and what the archive holds inside it. Both result variants carry this, so
 * a page can display the evidence behind a reading whether or not a comparison came out of it.
 *
 * `pairedDays` are the collected days: the ones carrying a reading for *both* metrics. A day
 * carrying only one of them appears in `missingDays` and in the list naming which metric it lacks,
 * because a day that cannot be compared is a gap and not a zero.
 *
 * @typedef {object} DivergenceCoverage
 * @property {number} requiredDays Collected days the reading needs: {@link MINIMUM_COLLECTED_DAYS}.
 * @property {number} availableDays Calendar days the selected range covers.
 * @property {number} collectedDays Days in the range carrying a reading for both metrics.
 * @property {string[]} pairedDays Those days, oldest first.
 * @property {string[]} missingDays Days the range covers that lack a reading for either metric,
 *   oldest first.
 * @property {string[]} missingClonerDays Days lacking a unique-cloner count, oldest first.
 * @property {string[]} missingStarDays Days lacking a star count, oldest first.
 */

/**
 * The coverage fields are repeated in both variants rather than nested under one object, so a view
 * reads `divergence.collectedDays` the same way whichever variant it got.
 *
 * @typedef {object} SufficientDivergence
 * @property {'sufficient'} status The variant a caller branches on.
 * @property {InsightRange} range The range the reading was asked about.
 * @property {number} requiredDays Collected days the reading needs: {@link MINIMUM_COLLECTED_DAYS}.
 * @property {number} collectedDays Days the total below was summed from; {@link MINIMUM_COLLECTED_DAYS}
 *   or more, so a short archive never reaches this variant.
 * @property {number} availableDays Calendar days the selected range covers.
 * @property {string[]} pairedDays Collected days, oldest first.
 * @property {string[]} missingDays Days the range covers that carry no reading for either metric.
 * @property {string[]} missingClonerDays Days lacking a unique-cloner count.
 * @property {string[]} missingStarDays Days lacking a star count.
 * @property {number} uniqueCloners Sum of the stored daily unique-cloner counts over
 *   {@link SufficientDivergence#collectedDays} days. A cloner active on several days is counted
 *   once per day, so this is a total of daily counts and never a count of distinct people.
 * @property {string} uniqueClonersBasis The same statement as data, so a view need not re-derive
 *   it: `sum of stored daily unique-cloner counts`.
 * @property {number} stars Cumulative star count recorded on {@link SufficientDivergence#starsDay}.
 * @property {string} starsDay The last collected day, so the level belongs to a named day.
 * @property {number} difference `uniqueCloners - stars`: a difference, never a verdict.
 * @property {number|null} ratio `uniqueCloners / stars` as unique-cloner day counts per star, and
 *   null when the star count is zero.
 * @property {number|null} percentage The ratio as a percentage of the star count, rounded for a
 *   reader and null whenever `ratio` is null. The summary prints this same number, so the two can
 *   never disagree.
 * @property {DivergenceRatioOmission|null} ratioOmitted Why the ratio is absent, or null when it is
 *   present.
 * @property {DivergenceLarger} larger Which of the two numbers is larger, as data rather than as a
 *   label the reader has to interpret.
 * @property {string} summary One sentence: both absolute numbers first with the days they belong
 *   to, then which is larger, then the ratio and the percentage beside the number it came from.
 */

/**
 * @typedef {object} InsufficientDivergence
 * @property {'insufficient'} status The variant a caller branches on.
 * @property {InsightRange} range The range the reading was asked about.
 * @property {DivergenceReason} reason Why no comparison is reported.
 * @property {number} requiredDays Collected days the reading needs: {@link MINIMUM_COLLECTED_DAYS}.
 * @property {number} availableDays Calendar days the selected range covers.
 * @property {number} collectedDays Days the range actually holds for both metrics.
 * @property {string[]} pairedDays Collected days, oldest first.
 * @property {string[]} missingDays Days the range covers that carry no reading for either metric.
 * @property {string[]} missingClonerDays Days lacking a unique-cloner count.
 * @property {string[]} missingStarDays Days lacking a star count.
 * @property {string} summary One sentence naming the minimum and the days held, plus the gap days
 *   when the range has any.
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
 * Every day an inclusive range covers, oldest first. This list says nothing about values; it is
 * the set a stored observation is looked up in.
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
 * Index one metric's stored observations by day.
 *
 * The array is validated rather than trusted, because the three ways it can be wrong all produce a
 * plausible number instead of an error: a day that is not a real calendar date would be looked up
 * under a key nothing else can match, a value that is not a number would sum as `NaN`, and two
 * rows for one day would silently double-count a single observation. Each is refused by name. A
 * negative count is refused too, because a ratio over a negative base would assert something no
 * reading supports.
 * @param {Observation[]} observations
 * @param {string} metric Metric key these observations belong to, named in the messages.
 * @returns {Map<string, number>}
 */
function indexObservations(observations, metric) {
  if (!Array.isArray(observations)) {
    throw new TypeError(`A divergence reading needs an observation array of stored ${metric} days; supply one`);
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
 * the two observation arrays the caller indexes. A range that is malformed or inverted is refused
 * here, before any day is looked up.
 * @param {DivergenceRequest} request
 * @returns {DivergenceRequest}
 */
function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('A divergence reading needs a request with unique cloners, stars and a range');
  }
  const { range } = request;
  if (range === null || typeof range !== 'object' || Array.isArray(range)) {
    throw new TypeError('A divergence reading needs an inclusive range with a from day and a to day');
  }
  dayTime(range.from, 'range start day');
  dayTime(range.to, 'range end day');
  if (dayTime(range.from, 'range start day') > dayTime(range.to, 'range end day')) {
    throw new RangeError('Reversed day range; supply from <= to');
  }
  return request;
}

/**
 * What the range covers and what the archive holds inside it.
 *
 * The star level and the day it belongs to are taken from the *last collected day*, so the two
 * numbers in the reading are read on the same day and the star figure is never silently taken
 * from a day the cloners were never observed. They are null only when the range holds no collected
 * day at all, which the minimum-volume check refuses before any reading is reported.
 *
 * @param {InsightRange} range
 * @param {Map<string, number>} starValues Stored cumulative star counts by day.
 * @param {Map<string, number>} clonerValues Stored daily unique-cloner counts by day.
 * @returns {DivergenceCoverage & {stars: number|null, starsDay: string|null, uniqueCloners: number}}
 */
function readCoverage(range, starValues, clonerValues) {
  const calendar = enumerateDays(range.from, range.to);
  /** @type {string[]} */
  const pairedDays = [];
  /** @type {string[]} */
  const missingDays = [];
  /** @type {string[]} */
  const missingClonerDays = [];
  /** @type {string[]} */
  const missingStarDays = [];
  let uniqueCloners = 0;
  /** @type {number|null} */
  let stars = null;
  /** @type {string|null} */
  let starsDay = null;

  for (const day of calendar) {
    const starCount = starValues.get(day);
    const clonerCount = clonerValues.get(day);
    if (starCount === undefined || clonerCount === undefined) {
      missingDays.push(day);
      if (clonerCount === undefined) missingClonerDays.push(day);
      if (starCount === undefined) missingStarDays.push(day);
      continue;
    }
    pairedDays.push(day);
    uniqueCloners += clonerCount;
    stars = starCount;
    starsDay = day;
  }

  return {
    requiredDays: MINIMUM_COLLECTED_DAYS,
    availableDays: calendar.length,
    collectedDays: pairedDays.length,
    pairedDays,
    missingDays,
    missingClonerDays,
    missingStarDays,
    uniqueCloners,
    stars,
    starsDay,
  };
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
 * What each unusable day lacks, in words, so the gap is legible in text rather than only as a
 * count. A day missing both metrics says so rather than naming the metric it happened to lack
 * first.
 * @param {string[]} missingDays
 * @param {Set<string>} clonerGapDays
 * @param {Set<string>} starGapDays
 * @returns {string[]} One clause per day, in the order the days were given.
 */
function gapClauses(missingDays, clonerGapDays, starGapDays) {
  return missingDays.map((day) => {
    const lacksCloners = clonerGapDays.has(day);
    const lacksStars = starGapDays.has(day);
    if (lacksCloners && lacksStars) return `${day} holds neither a unique-cloner count nor a star count`;
    if (lacksCloners) return `${day} holds no unique-cloner count`;
    return `${day} holds no star count`;
  });
}

/**
 * The gap sentence both variants append when the range holds days the reading could not use. It
 * names them, states the rule that keeps them from becoming zeros, and bounds itself: a range with
 * more than {@link MAX_NAMED_GAP_DAYS} holes names the first few and counts the rest, because a
 * gap absent from the output reads as a quiet day rather than an unmeasured one and a sentence of
 * four hundred dates reads as none at all.
 * @param {DivergenceCoverage} coverage
 * @returns {string} Empty when the range holds every day, otherwise a sentence.
 */
function gapSentence(coverage) {
  const count = coverage.missingDays.length;
  if (count === 0) return '';
  const clonerGapDays = new Set(coverage.missingClonerDays);
  const starGapDays = new Set(coverage.missingStarDays);
  const subject = `The ${count} ${plural(count, 'day', 'days')} in the selected ${coverage.availableDays}-day range `
    + `that ${plural(count, 'carries', 'carry')} no reading for one of the two metrics`;
  if (count === 1) {
    return `${subject} is a gap rather than a reading: `
      + `${gapClauses(coverage.missingDays, clonerGapDays, starGapDays)[0]}; no gap day is counted as zero`;
  }
  if (count <= MAX_NAMED_GAP_DAYS) {
    const clauses = gapClauses(coverage.missingDays, clonerGapDays, starGapDays);
    return `${subject} are gaps rather than readings: ${dayList(clauses)}; no gap day is counted as zero`;
  }
  const remainder = count - MAX_NAMED_GAP_DAYS;
  return `${subject} are gaps rather than readings, of which `
    + `${dayList(coverage.missingDays.slice(0, MAX_NAMED_GAP_DAYS))} are named here and ${remainder} further `
    + `${plural(remainder, 'gap day is', 'gap days are')} counted but not named; the reading carries every `
    + 'gap day, and no gap day is counted as zero';
}

/**
 * Close a sentence and append the gap sentence when the range has gaps, capitalised and separated
 * by a full stop. A summary that trails off without naming its holes is the failure this exists to
 * prevent, so the two sentences are joined here rather than at each call site.
 * @param {string} sentence The first sentence of a summary.
 * @param {DivergenceCoverage} coverage
 * @returns {string}
 */
function withGapSentence(sentence, coverage) {
  const gaps = gapSentence(coverage);
  return gaps === '' ? `${sentence}.` : `${sentence}. ${gaps}`;
}

/**
 * The comparison itself, stated as two facts about the two numbers.
 * @param {DivergenceLarger} larger
 * @returns {string}
 */
function largerClause(larger) {
  if (larger === LARGER_CLONERS) return 'unique-cloner day counts outnumber stars in this range';
  if (larger === LARGER_STARS) return 'stars outnumber unique-cloner day counts in this range';
  return 'stars and unique-cloner day counts are equal in this range';
}

/**
 * The ratio, or the reason it is absent. The percentage is printed beside the star count it came
 * from, never instead of it.
 * @param {number|null} ratio
 * @param {number|null} percentage
 * @param {number} stars
 * @returns {string}
 */
function ratioClause(ratio, percentage, stars) {
  if (ratio === null || percentage === null) {
    return 'no ratio is reported, because the recorded star count is zero';
  }
  return `the ratio is ${ratio} unique-cloner day counts per star, ${percentage}% of ${stars}`;
}

/**
 * The ratio as a figure a reader can check beside its absolute value.
 *
 * Four decimal places are enough for any ratio a maintainer reads, except for a real ratio small
 * enough to round away at that precision - one unique-cloner day count against a million stars is
 * 0.000001. Those keep three significant digits rather than becoming `0`, because a ratio of zero
 * beside a genuine difference of one is a wrong claim about the data.
 * @param {number} ratio Exact quotient.
 * @returns {number}
 */
function roundedRatio(ratio) {
  const fourDecimals = Number(ratio.toFixed(4));
  return fourDecimals === 0 ? Number(ratio.toPrecision(3)) : fourDecimals;
}

/**
 * The percentage as a figure a reader can check beside its absolute value. Two decimal places are
 * enough, except for a genuine ratio that would round to `0%` at that precision, which keeps three
 * significant digits instead. The returned number and the sentence are rounded by this function, so
 * a surface that prints the number and a surface that prints the sentence never disagree.
 * @param {number} percentage Exact ratio as a percentage.
 * @returns {number}
 */
function roundedPercentage(percentage) {
  const twoDecimals = Number(percentage.toFixed(2));
  return twoDecimals === 0 ? Number(percentage.toPrecision(3)) : twoDecimals;
}

/**
 * Compare unique cloners with stars over the selected range, without a verdict.
 *
 * The reading reports the two absolute numbers with the days they belong to, says which of them is
 * larger, and gives the ratio of unique-cloner day counts to stars - with the percentage beside
 * the star count rather than instead of it. Below {@link MINIMUM_COLLECTED_DAYS} collected days it
 * reports insufficient data naming the minimum, and never a number computed from less. A zero star
 * count reports both absolutes with the ratio omitted rather than a division result.
 *
 * The result is a named union, so a caller that forgets to branch on `status` cannot read a
 * `stars` or a `ratio` off a reading that never computed one: the insufficient variant carries no
 * such field.
 *
 * Identical input returns identical output: no clock is read, every day comes from the range, and
 * nothing is cached between calls.
 *
 * @param {DivergenceRequest} request
 * @returns {SufficientDivergence|InsufficientDivergence}
 */
export function starsVersusClonesDivergence(request) {
  validateRequest(request);
  const { range } = request;
  const starValues = indexObservations(request.stars, 'stars');
  const clonerValues = indexObservations(request.uniqueCloners, 'unique-cloners');
  const coverage = readCoverage(range, starValues, clonerValues);
  const { collectedDays, stars, starsDay, uniqueCloners } = coverage;

  if (collectedDays < MINIMUM_COLLECTED_DAYS || stars === null || starsDay === null) {
    return {
      status: DIVERGENCE_INSUFFICIENT,
      range,
      reason: REASON_BELOW_MINIMUM_VOLUME,
      requiredDays: MINIMUM_COLLECTED_DAYS,
      availableDays: coverage.availableDays,
      collectedDays,
      pairedDays: coverage.pairedDays,
      missingDays: coverage.missingDays,
      missingClonerDays: coverage.missingClonerDays,
      missingStarDays: coverage.missingStarDays,
      summary: withGapSentence('insufficient data: a stars-versus-clones divergence reading needs '
        + `${MINIMUM_COLLECTED_DAYS} days that carry both a unique-cloner count and a star count, and the `
        + `selected range ${range.from} to ${range.to} holds ${collectedDays} such `
        + plural(collectedDays, 'day', 'days'), coverage),
    };
  }

  const exactRatio = stars === 0 ? null : uniqueCloners / stars;
  const ratio = exactRatio === null ? null : roundedRatio(exactRatio);
  const percentage = exactRatio === null ? null : roundedPercentage(exactRatio * 100);
  /** @type {DivergenceLarger} */
  let larger = LARGER_EQUAL;
  if (uniqueCloners > stars) larger = LARGER_CLONERS;
  else if (stars > uniqueCloners) larger = LARGER_STARS;
  const firstDay = coverage.pairedDays[0];
  const lastDay = coverage.pairedDays[coverage.pairedDays.length - 1];

  return {
    status: DIVERGENCE_SUFFICIENT,
    range,
    requiredDays: MINIMUM_COLLECTED_DAYS,
    availableDays: coverage.availableDays,
    collectedDays,
    pairedDays: coverage.pairedDays,
    missingDays: coverage.missingDays,
    missingClonerDays: coverage.missingClonerDays,
    missingStarDays: coverage.missingStarDays,
    uniqueCloners,
    uniqueClonersBasis: 'sum of stored daily unique-cloner counts',
    stars,
    starsDay,
    difference: uniqueCloners - stars,
    ratio,
    percentage,
    ratioOmitted: ratio === null ? RATIO_OMITTED_ZERO_BASE : null,
    larger,
    summary: withGapSentence(`${uniqueCloners} unique-cloner day ${plural(uniqueCloners, 'count', 'counts')} `
      + `${plural(collectedDays, 'was', 'were')} recorded across ${collectedDays} collected `
      + `${plural(collectedDays, 'day', 'days')} from ${firstDay} to ${lastDay}, against ${stars} `
      + `${plural(stars, 'star', 'stars')} recorded on ${starsDay}; ${largerClause(larger)}, and `
      + ratioClause(ratio, percentage, stars), coverage),
  };
}
