import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CHANGE_LIST_INSUFFICIENT,
  CHANGE_LIST_SUFFICIENT,
  MAX_CHANGE_ENTRIES,
  MAX_NAMED_GAP_DAYS,
  MAX_NAMED_SERIES,
  REASON_BELOW_MINIMUM_VOLUME,
  REQUIRED_STORED_DAYS,
  changeList,
} from '../src/insight/changes.js';

/** @typedef {import('../src/insight/changes.js').ChangeEntry} ChangeEntry */
/** @typedef {import('../src/insight/changes.js').ChangeListRequest} ChangeListRequest */
/** @typedef {import('../src/insight/changes.js').InsufficientChangeList} InsufficientChangeList */
/** @typedef {import('../src/insight/changes.js').Observation} Observation */
/** @typedef {import('../src/insight/changes.js').SeriesCoverage} SeriesCoverage */
/** @typedef {import('../src/insight/changes.js').SufficientChangeList} SufficientChangeList */

const moduleSource = readFileSync(new URL('../src/insight/changes.js', import.meta.url), 'utf8');

/**
 * Four stored days of one metric across a five-day range, with the holes written into the source
 * rather than filled with zeros:
 *
 * - 2026-03-01 holds 3
 * - 2026-03-02 holds 9, six more than the day before it
 * - 2026-03-03 holds 9 again, so nothing changed on it
 * - 2026-03-04 holds nothing at all
 * - 2026-03-05 holds 4, five fewer than the last stored value before it
 *
 * A walk that filled the hole with a zero would find four differences where there are two.
 * @returns {ChangeListRequest}
 */
function oneMetricWithAHole() {
  return {
    series: [{
      metric: 'unique-cloners',
      observations: [
        { day: '2026-03-01', value: 3 },
        { day: '2026-03-02', value: 9 },
        { day: '2026-03-03', value: 9 },
        // 2026-03-04 holds no stored value.
        { day: '2026-03-05', value: 4 },
      ],
    }],
    range: { from: '2026-03-01', to: '2026-03-05' },
  };
}

/**
 * @param {Observation[]} observations
 * @param {string} from
 * @param {string} to
 * @param {string} [metric]
 * @returns {ChangeListRequest}
 */
function oneMetric(observations, from, to, metric = 'unique-cloners') {
  return { series: [{ metric, observations }], range: { from, to } };
}

/**
 * Narrow a result to its sufficient variant, so a test cannot read `entries` off a result that
 * never produced one.
 * @param {SufficientChangeList|InsufficientChangeList} list
 * @returns {SufficientChangeList}
 */
function sufficient(list) {
  if (list.status !== CHANGE_LIST_SUFFICIENT) {
    assert.fail(`expected a sufficient list, got ${list.status} (${list.reason}): ${list.summary}`);
  }
  return list;
}

/**
 * @param {SufficientChangeList|InsufficientChangeList} list
 * @returns {InsufficientChangeList}
 */
function insufficient(list) {
  if (list.status !== CHANGE_LIST_INSUFFICIENT) {
    assert.fail(`expected an insufficient list, got ${list.status}: ${list.summary}`);
  }
  return list;
}

/**
 * Every string a result carries, including the sentences. A banned-word assertion that only looked
 * at `summary` would pass while a verdict word sat in another field.
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

/**
 * A difference as the entries write it: `+6` for six more, `-5` for five fewer, and the plain number
 * when nothing moved in either direction.
 * @param {number} change
 * @returns {string}
 */
function signed(change) {
  return change > 0 ? `+${change}` : `${change}`;
}

/**
 * @param {SufficientChangeList|InsufficientChangeList} list
 * @param {string} metric
 * @returns {SeriesCoverage}
 */
function coverageOf(list, metric) {
  const found = list.seriesCoverage.find((entry) => entry.metric === metric);
  if (found === undefined) assert.fail(`no coverage was reported for ${metric}`);
  return found;
}

/**
 * An entry sentence states a comparison of two stored values: the metric, both days, both values and
 * the difference, and nothing else. Asserted for every entry of every list a test produces, so a
 * new prose branch cannot quietly drop one of the four facts the requirement names.
 * @param {ChangeEntry} entry
 */
function assertEntryNamesBothStoredValues(entry) {
  const expected = `${entry.metric} recorded ${entry.newValue} on ${entry.date}, after ${entry.previousValue} `
    + `recorded on ${entry.previousDate}; the difference is ${signed(entry.change)}`;
  assert.ok(entry.summary.startsWith(expected),
    `the entry sentence must name the metric, both stored values and the difference: ${entry.summary}`);
  assert.equal(entry.change, entry.newValue - entry.previousValue);
  assert.equal(entry.absoluteChange, Math.abs(entry.change));
}

test('an increase from three to nine produces one entry naming the metric, the date, three and nine', () => {
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 3 },
    { day: '2026-03-02', value: 9 },
  ], '2026-03-01', '2026-03-02')));

  assert.equal(list.totalEntries, 1);
  assert.equal(list.entries.length, 1);
  const entry = list.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.metric, 'unique-cloners');
  assert.equal(entry.date, '2026-03-02');
  assert.equal(entry.previousDate, '2026-03-01');
  assert.equal(entry.previousValue, 3);
  assert.equal(entry.newValue, 9);
  assert.equal(entry.change, 6);
  assert.equal(entry.absoluteChange, 6);
  // The two stored days are consecutive, so the entry skips no day at all.
  assert.equal(entry.daysSincePrevious, 1);
  assert.deepEqual(entry.missingDays, []);
  assertEntryNamesBothStoredValues(entry);
  // Every day of the range is stored here, so no gap sentence rides along with the summary.
  assert.ok(!list.summary.includes('gap'), list.summary);
});

test('a decrease reports the smaller later value with a negative difference and names both stored days', () => {
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 9 },
    { day: '2026-03-02', value: 4 },
  ], '2026-03-01', '2026-03-02', 'clones')));

  assert.equal(list.entries.length, 1);
  const entry = list.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.previousValue, 9);
  assert.equal(entry.newValue, 4);
  assert.equal(entry.change, -5);
  // The absolute difference, not the sign, is what the list is ordered by, so a decrease is
  // comparable with an increase of the same size.
  assert.equal(entry.absoluteChange, 5);
  assert.ok(entry.summary.includes('the difference is -5'), entry.summary);
  assertEntryNamesBothStoredValues(entry);
});

test('two metrics moving on the same day produce two flat entries, each naming its own metric', () => {
  const list = sufficient(changeList({
    series: [
      { metric: 'clones', observations: [{ day: '2026-03-01', value: 4 }, { day: '2026-03-02', value: 6 }] },
      { metric: 'views', observations: [{ day: '2026-03-01', value: 40 }, { day: '2026-03-02', value: 61 }] },
    ],
    range: { from: '2026-03-01', to: '2026-03-02' },
  }));

  // Two days and two metrics: two entries, not one row a reader has to split.
  assert.equal(list.totalEntries, 2);
  assert.equal(list.comparedPairs, 2);
  assert.deepEqual(list.metrics, ['clones', 'views']);
  assert.deepEqual(list.entries.map((entry) => [entry.date, entry.metric, entry.change]), [
    ['2026-03-02', 'views', 21],
    ['2026-03-02', 'clones', 2],
  ]);
  // The list is flat: every entry is a single dated fact with no grouping field and no severity.
  for (const entry of list.entries) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'absoluteChange', 'change', 'date', 'daysSincePrevious', 'metric', 'missingDays', 'newValue',
      'previousDate', 'previousValue', 'summary',
    ]);
  }
  assert.deepEqual(list.seriesCoverage.map((entry) => entry.metric), ['clones', 'views']);
  for (const entry of list.entries) assertEntryNamesBothStoredValues(entry);
});

test('a gap between two stored days compares those two stored values and names the missing day as a gap', () => {
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 9 },
    // 2026-03-02 holds no stored value.
    { day: '2026-03-03', value: 4 },
  ], '2026-03-01', '2026-03-03')));

  // Exactly one comparison was possible, and exactly one difference came out of it. Filling the
  // hole with a zero would find two: one down to nothing and one back up again.
  assert.equal(list.comparedPairs, 1);
  assert.equal(list.totalEntries, 1);
  assert.equal(list.entries.length, 1);
  const entry = list.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.previousDate, '2026-03-01');
  assert.equal(entry.date, '2026-03-03');
  assert.equal(entry.previousValue, 9);
  assert.equal(entry.newValue, 4);
  assert.equal(entry.change, -5);
  // The comparison spans the unmeasured day, and says so as data rather than as a value.
  assert.equal(entry.daysSincePrevious, 2);
  assert.deepEqual(entry.missingDays, ['2026-03-02']);
  assert.deepEqual(coverageOf(list, 'unique-cloners').missingDays, ['2026-03-02']);
  assertEntryNamesBothStoredValues(entry);
  assert.ok(entry.summary.includes('1 day between them holds no stored value'), entry.summary);

  // The missing day is never rendered as a fall to zero, and never described as one.
  assert.ok(!/\b(?:fell|falling|dropped|drop|died|collapsed|lost|plummeted)\b/i.test(entry.summary),
    `an unmeasured day must not be described as a fall: ${entry.summary}`);
  assert.ok(!/\b(?:to|of)\s+0\b/.test(entry.summary),
    `an unmeasured day must not be given a value: ${entry.summary}`);
  assert.ok(list.summary.includes('no gap day is given a value of zero'), list.summary);
  assert.ok(list.summary.includes('2026-03-02'), list.summary);
  const serialised = JSON.stringify(list);
  assert.ok(!serialised.includes('Infinity'), 'no entry may carry a division result');
  assert.ok(!serialised.includes('NaN'), 'no entry may carry NaN');
});

test('an unchanged day produces no entry while the comparison that found it unchanged is still counted', () => {
  const list = sufficient(changeList(oneMetricWithAHole()));

  // Four stored days make three comparisons: 3 to 9 differs, 9 to 9 does not, and 9 to 4 spans the
  // hole and differs. Two of the three produced an entry.
  assert.equal(list.storedDays, 4);
  assert.equal(list.comparedPairs, 3);
  assert.equal(list.totalEntries, 2);
  assert.equal(list.entries.length, 2);
  assert.ok(!list.entries.some((entry) => entry.date === '2026-03-03'),
    'a day whose value repeats the previous stored value produces no entry');
  assert.ok(!list.entries.some((entry) => entry.date === '2026-03-04'),
    'a day with no stored value produces no entry at all');
  // The list still says the comparisons happened, so an empty row is not mistaken for no data.
  assert.ok(list.summary.includes('3 day-to-day comparisons were made'), list.summary);
  assert.ok(list.summary.includes('2 of them recorded a different value'), list.summary);
});

test('a series whose every day repeats its previous value reports a sufficient list of no entries', () => {
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 5 },
    { day: '2026-03-02', value: 5 },
    { day: '2026-03-03', value: 5 },
  ], '2026-03-01', '2026-03-03', 'views')));

  // Six comparisons that found nothing is a reading. An empty list with the comparisons named is
  // honest; an empty list with no count would read as an archive that was never collected.
  assert.deepEqual(list.entries, []);
  assert.equal(list.totalEntries, 0);
  assert.equal(list.comparedPairs, 2);
  assert.equal(list.storedDays, 3);
  assert.equal(list.capped, false);
  assert.equal(list.omittedEntries, 0);
  assert.equal(list.maxEntries, MAX_CHANGE_ENTRIES);
  assert.ok(list.summary.includes('none of them recorded a different value'), list.summary);
  assert.ok(list.summary.includes('so no change entry is reported'), list.summary);
});

test('entries are ordered by absolute change, largest first, asserted with three changes of different sizes', () => {
  // 3 to 9 is six more, 9 to 4 is five fewer, 4 to 4 is nothing, and 4 to 7 is three more. Three
  // differences of three different sizes, so an ordering by date, by sign or by insertion would each
  // produce a different list from this one.
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 3 },
    { day: '2026-03-02', value: 9 },
    { day: '2026-03-03', value: 4 },
    { day: '2026-03-04', value: 4 },
    { day: '2026-03-05', value: 7 },
  ], '2026-03-01', '2026-03-05')));

  assert.equal(list.comparedPairs, 4);
  assert.equal(list.totalEntries, 3);
  assert.deepEqual(list.entries.map((entry) => entry.absoluteChange), [6, 5, 3]);
  assert.deepEqual(list.entries.map((entry) => entry.date), ['2026-03-02', '2026-03-03', '2026-03-05']);
  assert.deepEqual(list.entries.map((entry) => entry.change), [6, -5, 3]);
  for (const entry of list.entries) assertEntryNamesBothStoredValues(entry);
  // The ordering is stated rather than implied, so a reader can tell largest-first from newest-first.
  assert.ok(list.summary.includes('listed by absolute difference with the largest first'), list.summary);
  assert.ok(list.summary.includes('the largest being +6 on 2026-03-02'), list.summary);
});

test('equal magnitudes are ordered by the newer day first, and every entry is a distinct fact', () => {
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 4 },
    { day: '2026-03-02', value: 8 },
    { day: '2026-03-03', value: 4 },
    { day: '2026-03-04', value: 8 },
  ], '2026-03-01', '2026-03-04')));

  // Three differences, all of magnitude four, so only the tie-break decides the order and the
  // newer day comes first. A sort that fell back to the order the rows arrived in, or to the sign of
  // the difference, would produce a different list from this one.
  assert.deepEqual(list.entries.map((entry) => [entry.date, entry.change]), [
    ['2026-03-04', 4],
    ['2026-03-03', -4],
    ['2026-03-02', 4],
  ]);
  for (const entry of list.entries) assert.equal(entry.absoluteChange, 4);
  const keys = list.entries.map((entry) => `${entry.metric} ${entry.date}`);
  assert.equal(new Set(keys).size, keys.length, 'one entry per metric and day');
});

test('a list longer than twenty entries is capped with the remainder counted rather than dropped', () => {
  // Twenty-five stored days where each day differs from the one before it, by a rising difference so
  // that the twenty smallest are the ones the cap leaves out.
  /** @type {Observation[]} */
  const observations = [];
  let value = 0;
  for (let day = 1; day <= MAX_CHANGE_ENTRIES + 5; day += 1) {
    observations.push({ day: `2026-03-${String(day).padStart(2, '0')}`, value });
    value += day;
  }
  const list = sufficient(changeList(oneMetric(observations, '2026-03-01', '2026-03-25')));

  assert.equal(MAX_CHANGE_ENTRIES, 20);
  assert.equal(list.totalEntries, 24);
  assert.equal(list.entries.length, MAX_CHANGE_ENTRIES);
  assert.equal(list.maxEntries, MAX_CHANGE_ENTRIES);
  assert.equal(list.omittedEntries, 4);
  assert.equal(list.capped, true);
  // Largest first: the twenty kept are the twenty biggest differences, so the ones left out are the
  // four smallest. Nothing was dropped: the count beside the list says how many are not shown.
  assert.deepEqual(list.entries.map((entry) => entry.absoluteChange),
    Array.from({ length: MAX_CHANGE_ENTRIES }, (unused, index) => 24 - index));
  assert.equal(list.entries[list.entries.length - 1]?.absoluteChange, 5);
  assert.ok(list.summary.includes('4 differences are counted but not listed'), list.summary);
  assert.ok(list.summary.includes('the 20 largest absolute differences are listed'), list.summary);
});

test('exactly twenty entries is not capped and reports no omitted entry', () => {
  /** @type {Observation[]} */
  const observations = [];
  let value = 0;
  for (let day = 1; day <= MAX_CHANGE_ENTRIES + 1; day += 1) {
    observations.push({ day: `2026-03-${String(day).padStart(2, '0')}`, value });
    value += 1;
  }
  const list = sufficient(changeList(oneMetric(observations, '2026-03-01', '2026-03-21')));

  assert.equal(list.totalEntries, MAX_CHANGE_ENTRIES);
  assert.equal(list.entries.length, MAX_CHANGE_ENTRIES);
  assert.equal(list.omittedEntries, 0);
  assert.equal(list.capped, false);
  assert.ok(!list.summary.includes('counted but not listed'), list.summary);
});

test('a stored zero is a reading, so a change to and from zero produces entries', () => {
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 0 },
    { day: '2026-03-02', value: 3 },
    { day: '2026-03-03', value: 0 },
  ], '2026-03-01', '2026-03-03')));

  // A stored zero is a measurement, and is walked like any other value. This is what tells a
  // measured zero apart from a day the archive never held, which is missing from the array above.
  assert.equal(list.storedDays, 3);
  assert.equal(list.totalEntries, 2);
  assert.deepEqual(list.entries.map((entry) => [entry.date, entry.previousValue, entry.newValue]), [
    ['2026-03-03', 3, 0],
    ['2026-03-02', 0, 3],
  ]);
  assert.deepEqual(coverageOf(list, 'unique-cloners').missingDays, []);
  assert.equal(list.comparedPairs, 2);
});

test('a metric with fewer than two stored days produces no entry and is named in the coverage', () => {
  const list = sufficient(changeList({
    series: [
      { metric: 'clones', observations: [{ day: '2026-03-01', value: 4 }, { day: '2026-03-02', value: 6 }] },
      { metric: 'views', observations: [{ day: '2026-03-01', value: 40 }] },
    ],
    range: { from: '2026-03-01', to: '2026-03-03' },
  }));

  // One metric with something to compare and one without. The list is still produced, and the
  // metric that could not be compared says so as data rather than being quietly left out.
  assert.equal(list.totalEntries, 1);
  assert.deepEqual(list.entries.map((entry) => entry.metric), ['clones']);
  const views = coverageOf(list, 'views');
  assert.equal(views.storedDays, 1);
  assert.equal(views.comparisons, 0);
  assert.equal(views.canCompare, false);
  assert.deepEqual(views.missingDays, ['2026-03-02', '2026-03-03']);
  assert.equal(coverageOf(list, 'clones').canCompare, true);
  assert.equal(list.comparedPairs, 1);
  assert.ok(list.summary.includes('1 day-to-day comparison was made'), list.summary);
});

test('no metric with enough stored days returns insufficient data naming the minimum, carrying no entry fields', () => {
  const list = insufficient(changeList({
    series: [
      { metric: 'views', observations: [{ day: '2026-03-01', value: 40 }] },
      { metric: 'stars', observations: [{ day: '2026-03-02', value: 900 }] },
    ],
    range: { from: '2026-03-01', to: '2026-03-05' },
  }));

  assert.equal(list.reason, REASON_BELOW_MINIMUM_VOLUME);
  assert.equal(list.requiredDays, REQUIRED_STORED_DAYS);
  assert.equal(REQUIRED_STORED_DAYS, 2);
  assert.equal(list.comparedPairs, 0);
  assert.equal(list.storedDays, 2);
  assert.equal(list.availableDays, 5);
  assert.deepEqual(list.metrics, ['views', 'stars']);
  assert.ok(list.summary.includes('needs 2 stored days of one metric'), list.summary);
  assert.ok(list.summary.includes('views holds 1 stored day'), list.summary);
  assert.ok(list.summary.includes('stars holds 1 stored day'), list.summary);
  // No entry list rides along with a refusal: the variant carries no field a view could read.
  assert.ok(!('entries' in list));
  assert.ok(!('totalEntries' in list));
  assert.ok(!('capped' in list));
  assert.ok(!('maxEntries' in list));
  assert.ok(!('omittedEntries' in list));
  // What the range does hold is still carried, so a page can show the evidence beside the refusal.
  assert.deepEqual(coverageOf(list, 'views').missingDays,
    ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
});

test('a range holding no stored day at all for any metric names every missing day as a gap', () => {
  const list = insufficient(changeList({
    series: [
      { metric: 'views', observations: [] },
      { metric: 'clones', observations: [] },
    ],
    range: { from: '2026-03-01', to: '2026-03-03' },
  }));

  assert.equal(list.status, CHANGE_LIST_INSUFFICIENT);
  assert.equal(list.storedDays, 0);
  assert.equal(list.comparedPairs, 0);
  assert.ok(list.summary.includes('views holds no stored value on any of the 3 days'), list.summary);
  assert.ok(list.summary.includes('clones holds no stored value on any of the 3 days'), list.summary);
  assert.ok(list.summary.includes('2026-03-01, 2026-03-02 and 2026-03-03'), list.summary);
  assert.ok(list.summary.includes('no gap day is given a value of zero'), list.summary);
  // A first-connect archive has nothing to compare, and the summary says which requirement is unmet
  // rather than reporting a repository with no changes at all.
  assert.ok(list.summary.startsWith('insufficient data:'), list.summary);
  assert.ok(!('entries' in list));
});

test('a gap longer than ten days names the first ten and counts the rest', () => {
  // Two stored days in a thirty-six-day range, so the single comparison spans thirty-four
  // unmeasured days and the summary has to stop somewhere.
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 9 },
    { day: '2026-04-05', value: 4 },
  ], '2026-03-01', '2026-04-05')));

  assert.equal(list.comparedPairs, 1);
  assert.equal(list.totalEntries, 1);
  assert.equal(list.entries[0]?.daysSincePrevious, 35);
  assert.equal(list.entries[0]?.missingDays.length, 34);
  assert.equal(MAX_NAMED_GAP_DAYS, 10);
  assert.ok(list.summary.includes('The 34 days of the selected 36-day range'), list.summary);
  assert.ok(list.summary.includes('2026-03-02, 2026-03-03'), list.summary);
  assert.ok(list.summary.includes('2026-03-10 and 2026-03-11 are named here'), list.summary);
  assert.ok(list.summary.includes('24 further gap days are counted but not named'), list.summary);
  // The eleventh gap day is the first one the sentence does not name. The range's own end day is
  // still named in the first sentence, because that is the range and not a gap.
  assert.ok(!list.summary.includes('2026-03-12'), list.summary);
  // Every one of the thirty-four is still carried as data; only the prose is bounded.
  assert.equal(coverageOf(list, 'unique-cloners').missingDays.length, 34);
  assert.equal(coverageOf(list, 'unique-cloners').missingDays[33], '2026-04-04');
});

test('a gap crossing a month boundary reports the calendar distance between the stored days', () => {
  // 2026 is not a leap year, so 2026-02-27 and 2026-03-02 are three calendar days apart with two
  // days between them. Counting the distance from the list of stored days rather than from the
  // calendar would call it a month in the one month where the difference shows.
  const list = sufficient(changeList(oneMetric([
    { day: '2026-02-27', value: 9 },
    { day: '2026-03-02', value: 4 },
  ], '2026-02-27', '2026-03-03')));

  const entry = list.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.daysSincePrevious, 3);
  assert.deepEqual(entry.missingDays, ['2026-02-28', '2026-03-01']);
  assert.equal(entry.change, -5);
  assert.ok(entry.summary.includes('2 days between them hold no stored value'), entry.summary);
  assertEntryNamesBothStoredValues(entry);
});

test('a single unmeasured day is named on its own rather than as a list', () => {
  const list = sufficient(changeList(oneMetricWithAHole()));

  assert.ok(list.summary.includes('The 1 day of the selected 5-day range'), list.summary);
  assert.ok(list.summary.includes('is a gap rather than a reading: 2026-03-04'), list.summary);
  assert.ok(!list.summary.includes('days hold no stored value for at least one'), list.summary);
});

test('a refusal over many metrics names the first few and counts the rest', () => {
  // Five metrics, none of which holds two stored days, so the refusal has to describe five short
  // archives without becoming the metric list.
  /** @type {Array<{metric: string, observations: Observation[]}>} */
  const series = [];
  for (let index = 0; index < MAX_NAMED_SERIES + 2; index += 1) {
    series.push({
      metric: `metric-${index + 1}`,
      observations: [{ day: '2026-03-01', value: index + 1 }],
    });
  }
  const list = insufficient(changeList({ series, range: { from: '2026-03-01', to: '2026-03-02' } }));

  assert.equal(list.metrics.length, MAX_NAMED_SERIES + 2);
  assert.equal(list.storedDays, MAX_NAMED_SERIES + 2);
  assert.equal(list.comparedPairs, 0);
  assert.ok(list.summary.includes('across 5 supplied metrics'), list.summary);
  assert.ok(list.summary.includes('metric-3 holds 1 stored day'), list.summary);
  assert.ok(list.summary.includes('2 further metrics are counted but not named here'), list.summary);
  assert.ok(!list.summary.includes('metric-4'), 'a metric past the named ones is counted, not listed');
  // Nothing is dropped: every metric is still carried as data, named or not.
  assert.deepEqual(list.seriesCoverage.map((entry) => entry.metric),
    ['metric-1', 'metric-2', 'metric-3', 'metric-4', 'metric-5']);
});

test('no output string carries a score, grade, threshold, verdict, severity or trend word', () => {
  /** @type {Observation[]} */
  const long = [];
  let value = 0;
  for (let day = 1; day <= MAX_CHANGE_ENTRIES + 5; day += 1) {
    long.push({ day: `2026-03-${String(day).padStart(2, '0')}`, value });
    value += day;
  }
  /** @type {Observation[]} */
  const steady = [
    { day: '2026-03-01', value: 4 },
    { day: '2026-03-02', value: 4 },
  ];
  /** @type {Observation[]} */
  const single = [{ day: '2026-03-01', value: 4 }];
  const results = [
    // Two entries, one of them across a hole, one of them a decrease.
    changeList(oneMetricWithAHole()),
    // No entries at all: the comparison that found nothing unchanged.
    changeList(oneMetric(steady, '2026-03-01', '2026-03-02', 'views')),
    // The refusal, naming the minimum and the days held.
    changeList({ series: [{ metric: 'views', observations: single }], range: { from: '2026-03-01', to: '2026-03-05' } }),
    // A range nobody collected at all.
    changeList({ series: [{ metric: 'views', observations: [] }], range: { from: '2026-03-01', to: '2026-03-03' } }),
    // The cap sentence.
    changeList(oneMetric(long, '2026-03-01', '2026-03-25')),
    // The bounded gap sentence: thirty-four unmeasured days.
    changeList(oneMetric([{ day: '2026-03-01', value: 9 }, { day: '2026-04-05', value: 4 }], '2026-03-01', '2026-04-05')),
    // Two metrics on one day, and one of them with nothing to compare.
    changeList({
      series: [
        { metric: 'clones', observations: [{ day: '2026-03-01', value: 4 }, { day: '2026-03-02', value: 6 }] },
        { metric: 'views', observations: single },
      ],
      range: { from: '2026-03-01', to: '2026-03-03' },
    }),
  ];
  const texts = results.flatMap((result) => stringsIn(result));
  assert.ok(texts.length > 0);
  for (const text of texts) {
    for (const word of BANNED_WORDS) {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(text),
        `the word "${word}" may not appear in a change list, found in: ${text}`);
    }
  }
});

/** Words no output of this module may contain, checked as whole words. */
const BANNED_WORDS = [
  'score', 'grade', 'graded', 'rank', 'ranked', 'ranking', 'threshold', 'verdict', 'adoption',
  'adopted', 'usage', 'popularity', 'popular', 'engagement', 'momentum', 'trending', 'trend',
  'increasing', 'decreasing', 'surging', 'surged', 'surge', 'spike', 'spiked', 'declining',
  'declined', 'improving', 'improved', 'healthy', 'unhealthy', 'active', 'quiet', 'busy', 'stable',
  'unstable', 'growth', 'drop', 'dropped', 'fall', 'fell', 'fallen', 'falling', 'rise', 'rose',
  'risen', 'jump', 'jumped', 'plunge', 'anomaly', 'anomalous', 'alert', 'outlier', 'severe',
  'severity', 'critical', 'warning', 'better', 'worse', 'best', 'worst', 'success', 'successful',
  'failure', 'winner', 'loser', 'impressive', 'remarkable', 'notable', 'exciting', 'explosive',
];

test('identical input returns an identical list, whatever order the rows arrive in', () => {
  const request = oneMetricWithAHole();
  const first = changeList(request);
  const second = changeList(request);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  // Order carries no meaning and nothing is cached between calls: a reader who sorted the rows
  // differently, or who sorted the returned list, cannot change what a second call reports.
  const reversed = changeList({
    series: [{ metric: 'unique-cloners', observations: [...request.series[0].observations].reverse() }],
    range: { from: '2026-03-01', to: '2026-03-05' },
  });
  assert.deepEqual(reversed, first);
  const firstList = sufficient(first);
  firstList.entries.length = 0;
  const afterMutation = sufficient(changeList(request));
  assert.deepEqual(afterMutation, second, 'the module holds no state between calls');
});

test('observations outside the selected range are ignored and cannot invent a comparison', () => {
  const list = sufficient(changeList({
    series: [{
      metric: 'unique-cloners',
      observations: [
        // A stored day before the range and a stored day after it: neither is part of the range the
        // caller selected, and neither may become the previous stored day of a day inside it.
        { day: '2026-02-28', value: 99 },
        { day: '2026-03-01', value: 4 },
        { day: '2026-03-02', value: 6 },
        { day: '2026-03-03', value: 77 },
      ],
    }],
    range: { from: '2026-03-01', to: '2026-03-02' },
  }));

  assert.equal(list.storedDays, 2);
  assert.equal(list.comparedPairs, 1);
  assert.equal(list.totalEntries, 1);
  const entry = list.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.previousDate, '2026-03-01');
  assert.equal(entry.previousValue, 4);
  assert.equal(entry.newValue, 6);
  assert.deepEqual(list.entries.filter((row) => row.previousValue === 99), []);
  assert.deepEqual(coverageOf(list, 'unique-cloners').missingDays, []);
  assert.ok(!list.summary.includes('2026-02-28'), list.summary);
  assert.ok(!list.summary.includes('2026-03-03'), list.summary);
});

test('a stored reading that is not a real calendar day is refused', () => {
  assert.throws(() => changeList(oneMetric([
    { day: '2026-02-30', value: 1 },
    { day: '2026-03-02', value: 2 },
  ], '2026-03-01', '2026-03-03')), /real UTC calendar day/);
  assert.throws(() => changeList(oneMetric([
    { day: '2026-03-01', value: 1 },
  ], '2026-03-01', '2026-03-02z')), /real UTC calendar day/);
});

test('two observations on one day are refused rather than walked as two events', () => {
  assert.throws(() => changeList(oneMetric([
    { day: '2026-03-01', value: 1 },
    { day: '2026-03-01', value: 2 },
  ], '2026-03-01', '2026-03-02')), /one day has one stored value/);
});

test('the same metric supplied twice is refused rather than walked twice', () => {
  assert.throws(() => changeList({
    series: [
      { metric: 'views', observations: [{ day: '2026-03-01', value: 1 }, { day: '2026-03-02', value: 2 }] },
      { metric: 'views', observations: [{ day: '2026-03-01', value: 1 }, { day: '2026-03-02', value: 9 }] },
    ],
    range: { from: '2026-03-01', to: '2026-03-02' },
  }), /supplied twice/);
});

test('an observation without a finite count is refused rather than differenced as NaN', () => {
  assert.throws(() => changeList(oneMetric([
    { day: '2026-03-01', value: Number.NaN },
    { day: '2026-03-02', value: 2 },
  ], '2026-03-01', '2026-03-02')), /finite numeric count/);
  assert.throws(() => changeList(oneMetric(
    /** @type {any} */ ([{ day: '2026-03-01', value: 'nine' }]),
    '2026-03-01',
    '2026-03-02',
  )), /finite numeric count/);
});

test('a negative stored count is refused while a negative difference is reported', () => {
  assert.throws(() => changeList(oneMetric([
    { day: '2026-03-01', value: 4 },
    { day: '2026-03-02', value: -1 },
  ], '2026-03-01', '2026-03-02')), /negative count/);

  // The difference between two stored counts may still be negative, and it is.
  const list = sufficient(changeList(oneMetric([
    { day: '2026-03-01', value: 4 },
    { day: '2026-03-02', value: 1 },
  ], '2026-03-01', '2026-03-02')));
  assert.equal(list.entries[0]?.change, -3);
  assert.equal(list.entries[0]?.absoluteChange, 3);
});

test('a request without a series array or a range is refused', () => {
  const observations = [{ day: '2026-03-01', value: 1 }, { day: '2026-03-02', value: 2 }];
  const range = { from: '2026-03-01', to: '2026-03-02' };
  // Each argument here is deliberately wrong in a way the JSDoc already forbids, so the casts are
  // what let the runtime guards be exercised at all.
  assert.throws(() => changeList(/** @type {any} */ ({ range })), /at least one metric series/);
  assert.throws(() => changeList(/** @type {any} */ ({ series: [], range })), /at least one metric series/);
  assert.throws(() => changeList(/** @type {any} */ ({
    series: [{ metric: 'views', observations }], range: null,
  })), /inclusive range/);
  assert.throws(() => changeList(/** @type {any} */ ({
    series: [{ metric: '', observations }], range,
  })), /needs a metric name/);
  assert.throws(() => changeList(/** @type {any} */ ({
    series: ['views'], range,
  })), /record with a metric/);
  assert.throws(() => changeList(/** @type {any} */ ({
    series: [{ metric: 'views', observations: '2026-03-02' }], range,
  })), /observation array of stored views days/);
});

test('a reversed range is refused before anything is walked', () => {
  assert.throws(() => changeList(oneMetric([
    { day: '2026-03-01', value: 1 },
    { day: '2026-03-02', value: 2 },
  ], '2026-03-02', '2026-03-01')), /Reversed day range/);
});

test('the module reads no clock, imports nothing and holds no mutable module state', () => {
  assert.ok(!/\bimport\b/.test(moduleSource), 'the arithmetic takes no dependency: not a date library, not a client');
  assert.ok(!/\bDate\.now\b/.test(moduleSource), 'the current day is a parameter, never a read of the clock');
  assert.ok(!/\bDate\(\s*\)/.test(moduleSource), 'the current instant is never taken from the host');
  assert.ok(!/\bMath\.random\b/.test(moduleSource), 'identical input must produce identical output');
  assert.ok(!/\bprocess\./.test(moduleSource), 'the module reads no environment, so no run can depend on one');
  // Nothing is declared with `let` at the top level, so there is no module-level binding a call
  // could leave holding a value for the next one. The mutations each call makes are its own.
  assert.ok(!/^let /m.test(moduleSource), 'the module declares no mutable top-level state');
  // The vocabulary constants are literals, not functions closing over anything.
  assert.equal(MAX_CHANGE_ENTRIES, 20);
  assert.equal(REQUIRED_STORED_DAYS, 2);
  assert.equal(CHANGE_LIST_SUFFICIENT, 'sufficient');
  assert.equal(CHANGE_LIST_INSUFFICIENT, 'insufficient');
  assert.equal(REASON_BELOW_MINIMUM_VOLUME, 'below-minimum-volume');
});