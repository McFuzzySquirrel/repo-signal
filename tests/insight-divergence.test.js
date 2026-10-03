import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DIVERGENCE_INSUFFICIENT, DIVERGENCE_SUFFICIENT, LARGER_CLONERS, LARGER_EQUAL, LARGER_STARS,
  MAX_NAMED_GAP_DAYS, MINIMUM_COLLECTED_DAYS, RATIO_OMITTED_ZERO_BASE, REASON_BELOW_MINIMUM_VOLUME,
  starsVersusClonesDivergence,
} from '../src/insight/divergence.js';

/** @typedef {import('../src/insight/divergence.js').DivergenceRequest} DivergenceRequest */
/** @typedef {import('../src/insight/divergence.js').InsufficientDivergence} InsufficientDivergence */
/** @typedef {import('../src/insight/divergence.js').Observation} Observation */
/** @typedef {import('../src/insight/divergence.js').SufficientDivergence} SufficientDivergence */

const moduleSource = readFileSync(new URL('../src/insight/divergence.js', import.meta.url), 'utf8');

/**
 * Fourteen collected days, 2026-03-01 to 2026-03-14, whose unique-cloner counts add to exactly
 * 900 - the figure the acceptance criterion names - against a star level that climbs to exactly
 * 8,000 on the last of them. The days are written out rather than generated so a reader can add
 * them up and check the totals below by hand.
 * @type {Observation[]}
 */
const FOURTEEN_CLONER_DAYS_TOTAL_900 = [
  { day: '2026-03-01', value: 60 },
  { day: '2026-03-02', value: 62 },
  { day: '2026-03-03', value: 64 },
  { day: '2026-03-04', value: 63 },
  { day: '2026-03-05', value: 65 },
  { day: '2026-03-06', value: 66 },
  { day: '2026-03-07', value: 64 },
  { day: '2026-03-08', value: 67 },
  { day: '2026-03-09', value: 65 },
  { day: '2026-03-10', value: 66 },
  { day: '2026-03-11', value: 64 },
  { day: '2026-03-12', value: 65 },
  { day: '2026-03-13', value: 63 },
  { day: '2026-03-14', value: 66 },
];

/**
 * The star level recorded on those same fourteen days: 7,987 rising to 8,000, so the reading has
 * to name the day its level belongs to rather than presenting it as a fourteen-day total.
 * @type {Observation[]}
 */
const FOURTEEN_STAR_DAYS_LEVEL_8000 = [
  { day: '2026-03-01', value: 7987 },
  { day: '2026-03-02', value: 7989 },
  { day: '2026-03-03', value: 7990 },
  { day: '2026-03-04', value: 7991 },
  { day: '2026-03-05', value: 7993 },
  { day: '2026-03-06', value: 7994 },
  { day: '2026-03-07', value: 7995 },
  { day: '2026-03-08', value: 7996 },
  { day: '2026-03-09', value: 7997 },
  { day: '2026-03-10', value: 7998 },
  { day: '2026-03-11', value: 7998 },
  { day: '2026-03-12', value: 7999 },
  { day: '2026-03-13', value: 7999 },
  { day: '2026-03-14', value: 8000 },
];

/**
 * The same fourteen days with a stored star count of zero. A zero is a reading, not a hole, which
 * is exactly what lets the zero-base case be told apart from a missing day at all.
 * @returns {Observation[]}
 */
function zeroStarDays() {
  return FOURTEEN_CLONER_DAYS_TOTAL_900.map(({ day }) => ({ day, value: 0 }));
}

/**
 * Thirteen collected days, 2026-03-01 to 2026-03-13, inside a twenty-day range. The last seven days
 * of the range were never collected: the fixture stops at the 13th rather than writing zeros for
 * the 14th to the 20th, and the hole is visible here in the source. A reading that counted those
 * seven days as zeros would find twenty collected days and report a number.
 * @returns {{cloners: Observation[], stars: Observation[]}}
 */
function thirteenCollectedDaysInATwentyDayRange() {
  /** @type {Observation[]} */
  const cloners = [];
  /** @type {Observation[]} */
  const stars = [];
  for (let day = 1; day <= 13; day += 1) {
    const iso = `2026-03-${String(day).padStart(2, '0')}`;
    cloners.push({ day: iso, value: 9 + day });
    stars.push({ day: iso, value: 999 + day });
  }
  return { cloners, stars };
}

/**
 * Twenty calendar days holding fourteen collected days and six holes of three different kinds: a
 * day whose star count was stored while its unique-cloner count was not, a day holding neither, and
 * four days whose unique-cloner counts were stored while their star counts were not. The three
 * lists the result reports have to be distinguishable, or a page cannot say which metric a day is
 * missing.
 * @returns {{cloners: Observation[], stars: Observation[]}}
 */
function twentyDayRangeWithSixHoles() {
  return {
    cloners: [
      // 2026-03-01 to 2026-03-07: collected whole, ten unique cloners a day.
      { day: '2026-03-01', value: 10 },
      { day: '2026-03-02', value: 10 },
      { day: '2026-03-03', value: 10 },
      { day: '2026-03-04', value: 10 },
      { day: '2026-03-05', value: 10 },
      { day: '2026-03-06', value: 10 },
      { day: '2026-03-07', value: 10 },
      // 2026-03-08 holds a star count but no unique-cloner count.
      // 2026-03-09 holds neither metric.
      { day: '2026-03-10', value: 12 },
      { day: '2026-03-11', value: 12 },
      // 2026-03-10 to 2026-03-13 hold unique-cloner counts but no star count.
      { day: '2026-03-12', value: 12 },
      { day: '2026-03-13', value: 12 },
      // 2026-03-14 to 2026-03-20: collected whole, twelve unique cloners a day.
      { day: '2026-03-14', value: 12 },
      { day: '2026-03-15', value: 12 },
      { day: '2026-03-16', value: 12 },
      { day: '2026-03-17', value: 12 },
      { day: '2026-03-18', value: 12 },
      { day: '2026-03-19', value: 12 },
      { day: '2026-03-20', value: 12 },
    ],
    stars: [
      { day: '2026-03-01', value: 500 },
      { day: '2026-03-02', value: 501 },
      { day: '2026-03-03', value: 502 },
      { day: '2026-03-04', value: 503 },
      { day: '2026-03-05', value: 504 },
      { day: '2026-03-06', value: 505 },
      { day: '2026-03-07', value: 506 },
      // The 8th stored its star count while its unique-cloner count was missing.
      { day: '2026-03-08', value: 507 },
      // The 9th holds neither metric.
      // The 10th to the 13th hold no star count.
      { day: '2026-03-14', value: 508 },
      { day: '2026-03-15', value: 509 },
      { day: '2026-03-16', value: 510 },
      { day: '2026-03-17', value: 511 },
      { day: '2026-03-18', value: 512 },
      { day: '2026-03-19', value: 512 },
      { day: '2026-03-20', value: 513 },
    ],
  };
}

/**
 * @param {Observation[]} cloners
 * @param {Observation[]} stars
 * @param {string} from
 * @param {string} to
 * @returns {DivergenceRequest}
 */
function reading(cloners, stars, from, to) {
  return { uniqueCloners: cloners, stars, range: { from, to } };
}

/**
 * @param {Observation[]} cloners
 * @param {Observation[]} stars
 * @returns {DivergenceRequest} The acceptance criterion's own shape: fourteen collected days,
 *   2026-03-01 to 2026-03-14.
 */
function nineHundredAgainstEightThousand(cloners, stars) {
  return reading(cloners, stars, '2026-03-01', '2026-03-14');
}

/**
 * Narrow a reading to its sufficient variant, so a test cannot read `ratio` off a result that
 * never computed one.
 * @param {SufficientDivergence|InsufficientDivergence} divergence
 * @returns {SufficientDivergence}
 */
function sufficient(divergence) {
  if (divergence.status !== DIVERGENCE_SUFFICIENT) {
    assert.fail(`expected a sufficient reading, got ${divergence.status} (${divergence.reason}): ${divergence.summary}`);
  }
  return divergence;
}

/**
 * @param {SufficientDivergence|InsufficientDivergence} divergence
 * @returns {InsufficientDivergence}
 */
function insufficient(divergence) {
  if (divergence.status !== DIVERGENCE_INSUFFICIENT) {
    assert.fail(`expected an insufficient reading, got ${divergence.status}: ${divergence.summary}`);
  }
  return divergence;
}

/**
 * Every string a reading carries, including the sentences. A banned-word assertion that only
 * looked at `summary` would pass while a verdict word sat in another field.
 * @param {unknown} value
 * @returns {string[]}
 */
function stringsIn(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => stringsIn(entry));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((entry) => stringsIn(entry));
  }
  return [];
}

/** Words no output of this module may contain, checked as whole words. */
const BANNED_WORDS = [
  'score', 'grade', 'graded', 'rank', 'ranked', 'ranking', 'threshold', 'verdict', 'verdict-word',
  'adoption', 'adopted', 'usage', 'popularity', 'popular', 'engagement', 'momentum', 'trending',
  'trend', 'increasing', 'decreasing', 'surging', 'surged', 'declining', 'declined', 'improving',
  'improved', 'healthy', 'unhealthy', 'active', 'quiet', 'busy', 'stable', 'growth', 'drop',
  'rise', 'rise', 'falling', 'anomaly', 'anomalous', 'alert', 'outlier', 'underused', 'overused',
  'underused', 'overlooked', 'successful', 'unsuccessful', 'winner', 'losing',
];

test('900 unique cloners against 8,000 stars returns both absolutes, the ratio and a sentence naming which is larger', () => {
  const divergence = sufficient(starsVersusClonesDivergence(
    nineHundredAgainstEightThousand(FOURTEEN_CLONER_DAYS_TOTAL_900, FOURTEEN_STAR_DAYS_LEVEL_8000),
  ));

  assert.deepEqual(divergence.range, { from: '2026-03-01', to: '2026-03-14' });
  assert.equal(divergence.collectedDays, MINIMUM_COLLECTED_DAYS);
  assert.equal(divergence.uniqueCloners, 900);
  assert.equal(divergence.stars, 8000);
  // The star level belongs to a named day, because it is a cumulative count and not a
  // fourteen-day total.
  assert.equal(divergence.starsDay, '2026-03-14');
  assert.equal(divergence.uniqueClonersBasis, 'sum of stored daily unique-cloner counts');
  assert.equal(divergence.difference, -7100);
  assert.equal(divergence.ratio, 0.1125);
  assert.equal(divergence.percentage, 11.25);
  assert.equal(divergence.ratioOmitted, null);
  assert.equal(divergence.larger, LARGER_STARS);
  assert.deepEqual(divergence.missingDays, []);
  assert.equal(divergence.pairedDays.length, MINIMUM_COLLECTED_DAYS);
  // Both absolutes first with their days, then which is larger, then the ratio and the
  // percentage beside the number it came from.
  assert.equal(
    divergence.summary,
    '900 unique-cloner day counts were recorded across 14 collected days from 2026-03-01 to 2026-03-14, against '
    + '8000 stars recorded on 2026-03-14; stars outnumber unique-cloner day counts in this range, and the ratio '
    + 'is 0.1125 unique-cloner day counts per star, 11.25% of 8000.',
  );
});

test('a range below the fourteen-collected-day minimum returns insufficient data naming the minimum', () => {
  const { cloners, stars } = thirteenCollectedDaysInATwentyDayRange();
  const divergence = insufficient(starsVersusClonesDivergence(reading(cloners, stars, '2026-03-01', '2026-03-20')));

  assert.equal(divergence.reason, REASON_BELOW_MINIMUM_VOLUME);
  assert.equal(divergence.requiredDays, MINIMUM_COLLECTED_DAYS);
  assert.equal(divergence.requiredDays, 14);
  // Seven days of the twenty were never collected. Counting them as zeros would report twenty
  // collected days and a reading; naming them is the whole point of this floor.
  assert.equal(divergence.collectedDays, 13);
  assert.equal(divergence.availableDays, 20);
  assert.equal(divergence.missingDays.length, 7);
  assert.deepEqual(divergence.missingDays, [
    '2026-03-14', '2026-03-15', '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20',
  ]);
  assert.ok(divergence.summary.includes('14 days that carry both a unique-cloner count and a star count'),
    `the reason must name the minimum: ${divergence.summary}`);
  assert.ok(divergence.summary.includes('holds 13 such days'), divergence.summary);
  // No number at all rides along with a refusal: the variant carries no field a view could read.
  assert.ok(!('stars' in divergence));
  assert.ok(!('starsDay' in divergence));
  assert.ok(!('uniqueCloners' in divergence));
  assert.ok(!('ratio' in divergence));
  assert.ok(!('percentage' in divergence));
  assert.ok(!('difference' in divergence));
  assert.ok(!('larger' in divergence));
});

test('a range whose every day is stored is still refused when the range is shorter than the minimum', () => {
  /** @type {Observation[]} */
  const cloners = [];
  /** @type {Observation[]} */
  const stars = [];
  for (let day = 1; day <= 10; day += 1) {
    const iso = `2026-03-${String(day).padStart(2, '0')}`;
    cloners.push({ day: iso, value: 5 });
    stars.push({ day: iso, value: 700 + day });
  }
  const divergence = insufficient(starsVersusClonesDivergence(reading(cloners, stars, '2026-03-01', '2026-03-10')));

  // Nothing is missing, so the unmet requirement is the range itself and the result says so.
  assert.equal(divergence.reason, REASON_BELOW_MINIMUM_VOLUME);
  assert.equal(divergence.collectedDays, 10);
  assert.equal(divergence.availableDays, 10);
  assert.deepEqual(divergence.missingDays, []);
  assert.ok(divergence.summary.includes('14 days that carry both'), divergence.summary);
  assert.ok(divergence.summary.includes('holds 10 such days'), divergence.summary);

  // One collected day in a wider range reads as one day rather than as a plural, because the
  // sentence a page displays is this one.
  const single = insufficient(starsVersusClonesDivergence(reading(
    [{ day: '2026-03-01', value: 5 }], [{ day: '2026-03-01', value: 700 }], '2026-03-01', '2026-03-05',
  )));
  assert.equal(single.collectedDays, 1);
  assert.ok(single.summary.includes('holds 1 such day'), single.summary);
});

test('a zero star count returns the absolutes with the ratio omitted and no division result', () => {
  const divergence = sufficient(starsVersusClonesDivergence(
    nineHundredAgainstEightThousand(FOURTEEN_CLONER_DAYS_TOTAL_900, zeroStarDays()),
  ));

  // Both numbers are real readings, so both are reported; the ratio is the only thing missing.
  assert.equal(divergence.stars, 0);
  assert.equal(divergence.starsDay, '2026-03-14');
  assert.equal(divergence.uniqueCloners, 900);
  assert.equal(divergence.difference, 900);
  assert.equal(divergence.collectedDays, MINIMUM_COLLECTED_DAYS);
  assert.equal(divergence.ratio, null);
  assert.equal(divergence.percentage, null);
  assert.equal(divergence.ratioOmitted, RATIO_OMITTED_ZERO_BASE);
  assert.equal(divergence.larger, LARGER_CLONERS);
  assert.ok(divergence.summary.includes('no ratio is reported, because the recorded star count is zero'),
    divergence.summary);
  assert.ok(divergence.summary.includes('900 unique-cloner day counts'), divergence.summary);
  const serialised = JSON.stringify(divergence);
  assert.ok(!serialised.includes('Infinity'), 'a zero base must never produce Infinity');
  assert.ok(!serialised.includes('NaN'), 'a zero base must never produce NaN');
});

test('a gap inside the range is named, kept out of the collected days and never summed as zero', () => {
  const { cloners, stars } = twentyDayRangeWithSixHoles();
  const divergence = sufficient(starsVersusClonesDivergence(reading(cloners, stars, '2026-03-01', '2026-03-20')));

  // Fourteen days carry both metrics; the six holes are not collected days in any sense.
  assert.equal(divergence.collectedDays, 14);
  assert.equal(divergence.availableDays, 20);
  assert.deepEqual(divergence.missingDays, [
    '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  ]);
  assert.deepEqual(divergence.missingClonerDays, ['2026-03-08', '2026-03-09']);
  assert.deepEqual(divergence.missingStarDays, [
    '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  ]);
  // 70 from the first seven collected days and 84 from the last seven. The four days holding a
  // unique-cloner count but no star count are excluded rather than summed, so the archive holds
  // more unique-cloner counts inside this range than the reading reports.
  const storedClonerTotal = cloners.reduce((sum, row) => sum + row.value, 0);
  assert.equal(storedClonerTotal, 202);
  assert.equal(divergence.uniqueCloners, 154);
  assert.equal(divergence.stars, 513);
  assert.equal(divergence.starsDay, '2026-03-20');
  assert.equal(divergence.ratio, 0.3002);
  assert.equal(divergence.percentage, 30.02);
  assert.equal(divergence.larger, LARGER_STARS);
  assert.ok(divergence.summary.includes('2026-03-08 holds no unique-cloner count'), divergence.summary);
  assert.ok(divergence.summary.includes('2026-03-09 holds neither a unique-cloner count nor a star count'),
    divergence.summary);
  assert.ok(divergence.summary.includes('2026-03-10 holds no star count'), divergence.summary);
  assert.ok(divergence.summary.includes('no gap day is counted as zero'), divergence.summary);
  assert.ok(divergence.summary.includes('The 6 days in the selected 20-day range'), divergence.summary);
});

test('a single gap day is named as one gap rather than as a list', () => {
  const divergence = insufficient(starsVersusClonesDivergence(reading(
    [{ day: '2026-03-01', value: 5 }, { day: '2026-03-02', value: 6 }],
    [{ day: '2026-03-01', value: 700 }, { day: '2026-03-03', value: 701 }],
    '2026-03-01', '2026-03-03',
  )));

  // 2026-03-02 holds a star count but no unique-cloner count; 2026-03-03 holds the reverse.
  assert.deepEqual(divergence.missingDays, ['2026-03-02', '2026-03-03']);
  assert.ok(divergence.summary.includes('The 2 days in the selected 3-day range'), divergence.summary);
});

test('a long stretch of uncollected days names the first few and counts the rest', () => {
  /** @type {Observation[]} */
  const cloners = [];
  /** @type {Observation[]} */
  const stars = [];
  for (let day = 1; day <= 20; day += 1) {
    const iso = `2026-03-${String(day).padStart(2, '0')}`;
    cloners.push({ day: iso, value: 3 });
    stars.push({ day: iso, value: 40 });
  }
  // A range that covers thirty-two days but holds twenty of them.
  const divergence = sufficient(starsVersusClonesDivergence(
    reading(cloners, stars, '2026-03-01', '2026-04-01'),
  ));

  // The prose names ten gaps and counts the two it does not, so a long range with uncollected days
  // does not become a paragraph of dates. Every gap day is still carried as data.
  assert.equal(divergence.availableDays, 32);
  assert.equal(divergence.missingDays.length, 12);
  assert.deepEqual(divergence.missingDays.slice(0, 3), ['2026-03-21', '2026-03-22', '2026-03-23']);
  assert.equal(divergence.missingDays[11], '2026-04-01');
  assert.ok(divergence.summary.includes('2026-03-21, 2026-03-22'), divergence.summary);
  assert.ok(divergence.summary.includes('2026-03-30'), divergence.summary);
  assert.ok(divergence.summary.includes('2 further gap days are counted but not named'), divergence.summary);
  assert.ok(!divergence.summary.includes('2026-03-31,'), divergence.summary);
  assert.ok(!divergence.summary.includes('2026-04-01,'), divergence.summary);
  assert.equal(MAX_NAMED_GAP_DAYS, 10);
});

test('unique-cloner day counts outnumbering stars reports the reciprocal ratio', () => {
  /** @type {Observation[]} */
  const cloners = [];
  /** @type {Observation[]} */
  const stars = [];
  for (let day = 1; day <= MINIMUM_COLLECTED_DAYS; day += 1) {
    const iso = `2026-03-${String(day).padStart(2, '0')}`;
    // 4 days of 625 and 10 of 600 is 8,500: the other side of the comparison in the product idea.
    cloners.push({ day: iso, value: day <= 4 ? 625 : 600 });
    stars.push({ day: iso, value: 1200 });
  }
  const divergence = sufficient(starsVersusClonesDivergence(
    reading(cloners, stars, '2026-03-01', '2026-03-14'),
  ));

  assert.equal(divergence.uniqueCloners, 8500);
  assert.equal(divergence.stars, 1200);
  assert.equal(divergence.ratio, 7.0833);
  assert.equal(divergence.percentage, 708.33);
  assert.equal(divergence.difference, 7300);
  assert.equal(divergence.larger, LARGER_CLONERS);
  assert.ok(divergence.summary.includes('unique-cloner day counts outnumber stars in this range'),
    divergence.summary);
  // The percentage travels beside the 1,200 it came from, not on its own.
  assert.ok(divergence.summary.includes('708.33% of 1200'), divergence.summary);
});

test('a three-clone repository keeps its absolutes beside a large ratio', () => {
  /** @type {Observation[]} */
  const cloners = [];
  /** @type {Observation[]} */
  const stars = [];
  for (let day = 1; day <= MINIMUM_COLLECTED_DAYS; day += 1) {
    const iso = `2026-03-${String(day).padStart(2, '0')}`;
    cloners.push({ day: iso, value: day === MINIMUM_COLLECTED_DAYS ? 3 : 0 });
    stars.push({ day: iso, value: day === MINIMUM_COLLECTED_DAYS ? 2 : 1 });
  }
  const divergence = sufficient(starsVersusClonesDivergence(
    reading(cloners, stars, '2026-03-01', '2026-03-14'),
  ));

  // Three against two is 150%, and the honest answer keeps 3 and 2 in the sentence rather than
  // leading with the percentage. The stored zeros are readings, not holes.
  assert.equal(divergence.uniqueCloners, 3);
  assert.equal(divergence.stars, 2);
  assert.equal(divergence.ratio, 1.5);
  assert.equal(divergence.percentage, 150);
  assert.ok(divergence.summary.includes('3 unique-cloner day counts were recorded'), divergence.summary);
  assert.ok(divergence.summary.includes('150% of 2'), divergence.summary);
  assert.deepEqual(divergence.missingDays, []);
});

test('equal stars and unique-cloner day counts report a ratio of one and no verdict', () => {
  /** @type {Observation[]} */
  const cloners = [];
  /** @type {Observation[]} */
  const stars = [];
  for (let day = 1; day <= MINIMUM_COLLECTED_DAYS; day += 1) {
    const iso = `2026-03-${String(day).padStart(2, '0')}`;
    cloners.push({ day: iso, value: day === MINIMUM_COLLECTED_DAYS ? 5 : 0 });
    stars.push({ day: iso, value: day === MINIMUM_COLLECTED_DAYS ? 5 : 0 });
  }
  const divergence = sufficient(starsVersusClonesDivergence(
    reading(cloners, stars, '2026-03-01', '2026-03-14'),
  ));

  assert.equal(divergence.ratio, 1);
  assert.equal(divergence.percentage, 100);
  assert.equal(divergence.difference, 0);
  assert.equal(divergence.larger, LARGER_EQUAL);
  assert.ok(divergence.summary.includes('stars and unique-cloner day counts are equal in this range'),
    divergence.summary);
});

test('a ratio of one in a million is not rounded away to zero', () => {
  /** @type {Observation[]} */
  const cloners = [];
  /** @type {Observation[]} */
  const stars = [];
  for (let day = 1; day <= MINIMUM_COLLECTED_DAYS; day += 1) {
    const iso = `2026-03-${String(day).padStart(2, '0')}`;
    cloners.push({ day: iso, value: day === MINIMUM_COLLECTED_DAYS ? 1 : 0 });
    stars.push({ day: iso, value: day === MINIMUM_COLLECTED_DAYS ? 1_000_000 : 999_000 });
  }
  const divergence = sufficient(starsVersusClonesDivergence(
    reading(cloners, stars, '2026-03-01', '2026-03-14'),
  ));

  assert.equal(divergence.uniqueCloners, 1);
  const ratio = divergence.ratio;
  assert.ok(typeof ratio === 'number' && ratio > 0,
    `a genuine ratio of one in a million is not zero: ${String(ratio)}`);
  assert.equal(divergence.ratio, 0.000001);
  assert.ok(divergence.summary.includes('0.0001% of 1000000'), divergence.summary);
  assert.ok(!divergence.summary.includes('0 unique-cloner day counts per star'),
    'a real difference of one must never read as no difference');
});

test('the star level is the one recorded on the last collected day, not the newest stored row', () => {
  /** @type {Observation[]} */
  const stars = [...FOURTEEN_STAR_DAYS_LEVEL_8000];
  // The archive keeps collecting star counts after the unique-cloner series stops.
  for (let day = 15; day <= 20; day += 1) {
    stars.push({ day: `2026-03-${String(day).padStart(2, '0')}`, value: 8000 + day - 14 });
  }
  const divergence = sufficient(starsVersusClonesDivergence(
    reading(FOURTEEN_CLONER_DAYS_TOTAL_900, stars, '2026-03-01', '2026-03-20'),
  ));

  // The two numbers are read on the same day, so the ratio cannot be a week-old star level
  // against a fresher cloner total.
  assert.equal(divergence.starsDay, '2026-03-14');
  assert.equal(divergence.stars, 8000);
  assert.equal(divergence.collectedDays, MINIMUM_COLLECTED_DAYS);
  assert.deepEqual(divergence.missingClonerDays, [
    '2026-03-15', '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20',
  ]);
  assert.deepEqual(divergence.missingStarDays, []);
});

test('identical input returns an identical reading, whatever order the rows arrive in', () => {
  const request = nineHundredAgainstEightThousand(FOURTEEN_CLONER_DAYS_TOTAL_900, FOURTEEN_STAR_DAYS_LEVEL_8000);
  const first = starsVersusClonesDivergence(request);
  const second = starsVersusClonesDivergence(request);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  // Order carries no meaning and a row from outside the range is not an error: both are
  // properties of a pure function over stored days, not of the caller's array.
  const reversed = starsVersusClonesDivergence({
    uniqueCloners: [...FOURTEEN_CLONER_DAYS_TOTAL_900].reverse(),
    stars: [...FOURTEEN_STAR_DAYS_LEVEL_8000].reverse(),
    range: { from: '2026-03-01', to: '2026-03-14' },
  });
  assert.deepEqual(reversed, first);
});

test('observations outside the selected range are ignored and never counted toward the minimum', () => {
  const { cloners, stars } = thirteenCollectedDaysInATwentyDayRange();
  const divergence = insufficient(starsVersusClonesDivergence({
    uniqueCloners: [
      ...cloners,
      // Ten stored days well after the range ends: they cannot make a short archive long enough.
      { day: '2026-04-01', value: 40 },
      { day: '2026-04-02', value: 40 },
    ],
    stars: [
      ...stars,
      { day: '2026-04-01', value: 1100 },
      { day: '2026-04-02', value: 1100 },
    ],
    range: { from: '2026-03-01', to: '2026-03-20' },
  }));

  assert.equal(divergence.collectedDays, 13);
  assert.equal(divergence.availableDays, 20);
  assert.deepEqual(divergence.missingDays[0], '2026-03-14');
  assert.ok(!divergence.summary.includes('2026-04-01'), 'a day outside the range is not part of the reading');
});

test('no output string carries a score, grade, threshold, verdict or trend word', () => {
  const { cloners: holeyCloners, stars: holeyStars } = twentyDayRangeWithSixHoles();
  const { cloners: shortCloners, stars: shortStars } = thirteenCollectedDaysInATwentyDayRange();
  // Every prose branch the module can produce is here, because the two longest sentences - the
  // single-gap one and the one that names ten gaps and counts the rest - are the branches most
  // likely to smuggle a word in the first place.
  /** @type {Observation[]} */
  const longRangeCloners = [];
  /** @type {Observation[]} */
  const longRangeStars = [];
  for (let day = 1; day <= 20; day += 1) {
    const iso = `2026-03-${String(day).padStart(2, '0')}`;
    longRangeCloners.push({ day: iso, value: 3 });
    longRangeStars.push({ day: iso, value: 40 });
  }
  const readings = [
    starsVersusClonesDivergence(nineHundredAgainstEightThousand(
      FOURTEEN_CLONER_DAYS_TOTAL_900, FOURTEEN_STAR_DAYS_LEVEL_8000,
    )),
    starsVersusClonesDivergence(nineHundredAgainstEightThousand(
      FOURTEEN_CLONER_DAYS_TOTAL_900, zeroStarDays(),
    )),
    starsVersusClonesDivergence(reading(holeyCloners, holeyStars, '2026-03-01', '2026-03-20')),
    starsVersusClonesDivergence(reading(shortCloners, shortStars, '2026-03-01', '2026-03-20')),
    starsVersusClonesDivergence(reading(holeyCloners, [], '2026-03-01', '2026-03-20')),
    // The single-gap sentence: one unusable day, named alone.
    starsVersusClonesDivergence(reading(
      [{ day: '2026-03-01', value: 5 }, { day: '2026-03-02', value: 6 }],
      [{ day: '2026-03-01', value: 700 }, { day: '2026-03-03', value: 701 }],
      '2026-03-01', '2026-03-03',
    )),
    // Exactly one unusable day, which takes the singular gap sentence rather than the list one.
    starsVersusClonesDivergence(reading(
      [{ day: '2026-03-01', value: 5 }, { day: '2026-03-02', value: 6 }],
      [{ day: '2026-03-01', value: 700 }, { day: '2026-03-02', value: 701 }],
      '2026-03-01', '2026-03-03',
    )),
    // The bounded sentence: ten gaps named and the remainder counted.
    starsVersusClonesDivergence(reading(longRangeCloners, longRangeStars, '2026-03-01', '2026-04-01')),
  ];
  const texts = readings.flatMap((reading) => stringsIn(reading));
  assert.ok(texts.length > 0);
  for (const text of texts) {
    for (const word of BANNED_WORDS) {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(text),
        `the word "${word}" may not appear in a reading, found in: ${text}`);
    }
  }
});

test('every reported percentage travels beside the absolute values it came from', () => {
  const { cloners, stars } = twentyDayRangeWithSixHoles();
  const readings = [
    starsVersusClonesDivergence(nineHundredAgainstEightThousand(
      FOURTEEN_CLONER_DAYS_TOTAL_900, FOURTEEN_STAR_DAYS_LEVEL_8000,
    )),
    starsVersusClonesDivergence(reading(cloners, stars, '2026-03-01', '2026-03-20')),
    starsVersusClonesDivergence(nineHundredAgainstEightThousand(
      FOURTEEN_CLONER_DAYS_TOTAL_900, zeroStarDays(),
    )),
  ];
  for (const result of readings) {
    const divergence = sufficient(result);
    if (divergence.percentage === null) continue;
    assert.ok(divergence.summary.includes(`${divergence.uniqueCloners}`),
      'the unique-cloner absolute must appear beside the percentage');
    assert.ok(divergence.summary.includes(`${divergence.stars}`),
      'the star absolute the percentage came from must appear beside it');
    assert.ok(divergence.summary.includes(`${divergence.ratio}`), 'the ratio must appear as a number');
    assert.ok(divergence.summary.includes('%'), 'a percentage must be shown, not only carried as a number');
  }
});

test('a stored reading that is not a real calendar day is refused', () => {
  assert.throws(() => starsVersusClonesDivergence(reading(
    [{ day: '2026-02-30', value: 1 }], FOURTEEN_STAR_DAYS_LEVEL_8000, '2026-03-01', '2026-03-14',
  )), /real UTC calendar day/);
  assert.throws(() => starsVersusClonesDivergence(reading(
    FOURTEEN_CLONER_DAYS_TOTAL_900, [{ day: '2026-03-01', value: 1 }], '2026-03-01', '2026-03-14z',
  )), /real UTC calendar day/);
});

test('two observations on one day are refused rather than summed twice', () => {
  assert.throws(() => starsVersusClonesDivergence(reading(
    [...FOURTEEN_CLONER_DAYS_TOTAL_900, { day: '2026-03-14', value: 66 }],
    FOURTEEN_STAR_DAYS_LEVEL_8000, '2026-03-01', '2026-03-14',
  )), /one day has one stored value/);
  assert.throws(() => starsVersusClonesDivergence(reading(
    FOURTEEN_CLONER_DAYS_TOTAL_900,
    [...FOURTEEN_STAR_DAYS_LEVEL_8000, { day: '2026-03-14', value: 8000 }],
    '2026-03-01', '2026-03-14',
  )), /one day has one stored value/);
});

test('an observation without a finite count is refused rather than summed as NaN', () => {
  /** @type {Observation[]} */
  const rows = [{ day: '2026-03-14', value: Number.NaN }];
  assert.throws(() => starsVersusClonesDivergence(reading(
    rows, FOURTEEN_STAR_DAYS_LEVEL_8000, '2026-03-01', '2026-03-14',
  )), /finite numeric count/);
  assert.throws(() => starsVersusClonesDivergence(reading(
    FOURTEEN_CLONER_DAYS_TOTAL_900, rows, '2026-03-01', '2026-03-14',
  )), /finite numeric count/);
});

test('a negative count is refused rather than divided by', () => {
  assert.throws(() => starsVersusClonesDivergence(reading(
    FOURTEEN_CLONER_DAYS_TOTAL_900,
    [{ day: '2026-03-14', value: -1 }], '2026-03-01', '2026-03-14',
  )), /negative count/);
});

test('a request without both observation arrays or a range is refused', () => {
  // Each argument here is deliberately wrong in a way the JSDoc already forbids, so the casts are
  // what let the runtime guard be exercised at all.
  const range = { from: '2026-03-01', to: '2026-03-14' };
  assert.throws(() => starsVersusClonesDivergence(/** @type {any} */ ({
    stars: FOURTEEN_STAR_DAYS_LEVEL_8000, range,
  })), /observation array of stored unique-cloners days/);
  assert.throws(() => starsVersusClonesDivergence(/** @type {any} */ ({
    uniqueCloners: FOURTEEN_CLONER_DAYS_TOTAL_900, range,
  })), /observation array of stored stars days/);
  assert.throws(() => starsVersusClonesDivergence(/** @type {any} */ ({
    uniqueCloners: FOURTEEN_CLONER_DAYS_TOTAL_900, stars: FOURTEEN_STAR_DAYS_LEVEL_8000, range: null,
  })), /inclusive range/);
  assert.throws(() => starsVersusClonesDivergence(/** @type {any} */ ({
    uniqueCloners: '2026-03-14', stars: FOURTEEN_STAR_DAYS_LEVEL_8000, range,
  })), /observation array/);
});

test('a reversed range is refused before anything is summed', () => {
  assert.throws(() => starsVersusClonesDivergence(reading(
    FOURTEEN_CLONER_DAYS_TOTAL_900, FOURTEEN_STAR_DAYS_LEVEL_8000, '2026-03-14', '2026-03-01',
  )), /Reversed day range/);
});

test('the module reads no clock, imports nothing and holds no mutable module state', () => {
  assert.ok(!/\bimport\b/.test(moduleSource), 'the arithmetic takes no dependency: not a date library, not a client');
  assert.ok(!/\bDate\.now\b/.test(moduleSource), 'the current day is a parameter, never a read of the clock');
  assert.ok(!/\bDate\(\s*\)/.test(moduleSource), 'the current instant is never taken from the host');
  assert.ok(!/\bMath\.random\b/.test(moduleSource), 'identical input must produce identical output');
  assert.ok(!/\bprocess\./.test(moduleSource), 'the module reads no environment, so no run can depend on one');
});
