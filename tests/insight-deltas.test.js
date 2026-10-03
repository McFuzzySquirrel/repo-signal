import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  COMPARISON_DAYS, DELTA_INSUFFICIENT, DELTA_SUFFICIENT, PERCENTAGE_OMITTED_ZERO_BASE,
  REASON_MISSING_DAYS, REASON_SHORT_RANGE, WINDOW_DAYS, sevenDayDelta, weekOverWeekDelta,
} from '../src/insight/deltas.js';

/** @typedef {import('../src/insight/deltas.js').DeltaRequest} DeltaRequest */
/** @typedef {import('../src/insight/deltas.js').InsufficientDelta} InsufficientDelta */
/** @typedef {import('../src/insight/deltas.js').Observation} Observation */
/** @typedef {import('../src/insight/deltas.js').SufficientDelta} SufficientDelta */

const metric = 'clones';
const moduleSource = readFileSync(new URL('../src/insight/deltas.js', import.meta.url), 'utf8');

/**
 * Twenty consecutive stored days, 2026-03-01 to 2026-03-20, one clone per day and a
 * value equal to the day of the month so every expected total below can be checked
 * by hand. The fixture is complete on purpose: the holes are introduced by the
 * fixtures that name them, so a rule that only holds when data is whole cannot be
 * mistaken for a rule that holds when it is not.
 * @returns {Observation[]}
 */
function twentyStoredDays() {
  /** @type {Observation[]} */
  const rows = [];
  for (let day = 1; day <= 20; day += 1) {
    rows.push({ day: `2026-03-${String(day).padStart(2, '0')}`, value: day });
  }
  return rows;
}

/**
 * The same twenty days with 2026-03-15 absent. The archive holds no value for that
 * day, so the fixture omits the row rather than writing a zero in its place, and the
 * hole is visible here in the source: the array steps from the 14th to the 16th.
 * @returns {Observation[]}
 */
function holeInTheLaterWindow() {
  return [
    { day: '2026-03-01', value: 1 },
    { day: '2026-03-02', value: 2 },
    { day: '2026-03-03', value: 3 },
    { day: '2026-03-04', value: 4 },
    { day: '2026-03-05', value: 5 },
    { day: '2026-03-06', value: 6 },
    { day: '2026-03-07', value: 7 },
    { day: '2026-03-08', value: 8 },
    { day: '2026-03-09', value: 9 },
    { day: '2026-03-10', value: 10 },
    // 2026-03-11 through 2026-03-14 are stored; the earlier window is whole, so the
    // reading below can show which side of the comparison actually held the data.
    { day: '2026-03-11', value: 11 },
    { day: '2026-03-12', value: 12 },
    { day: '2026-03-13', value: 13 },
    { day: '2026-03-14', value: 14 },
    // 2026-03-15 was never observed either: this is the hole the later window reports.
    { day: '2026-03-16', value: 16 },
    { day: '2026-03-17', value: 17 },
    { day: '2026-03-18', value: 18 },
    { day: '2026-03-19', value: 19 },
    { day: '2026-03-20', value: 20 },
  ];
}

/**
 * @param {Observation[]} observations
 * @param {string} from
 * @param {string} to
 * @returns {DeltaRequest}
 */
function request(observations, from, to) {
  return { metric, observations, range: { from, to } };
}

/**
 * Narrow a reading to its sufficient variant, so a test cannot read `change` off a
 * result that never computed one.
 * @param {SufficientDelta|InsufficientDelta} delta
 * @returns {SufficientDelta}
 */
function sufficient(delta) {
  if (delta.status !== DELTA_SUFFICIENT) {
    assert.fail(`expected a sufficient reading, got ${delta.status} (${delta.reason}): ${delta.summary}`);
  }
  return delta;
}

/**
 * @param {SufficientDelta|InsufficientDelta} delta
 * @returns {InsufficientDelta}
 */
function insufficient(delta) {
  if (delta.status !== DELTA_INSUFFICIENT) {
    assert.fail(`expected an insufficient reading, got ${delta.status}: ${delta.summary}`);
  }
  return delta;
}

/**
 * Every string a reading carries, including the sentences. A banned-word assertion
 * that only looked at `summary` would pass while a verdict word sat in another field.
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
  'score', 'grade', 'graded', 'rank', 'ranked', 'ranking', 'threshold', 'verdict',
  'verdict-word', 'adoption', 'adopted', 'usage', 'popularity', 'popular',
  'engagement', 'momentum', 'trending', 'trend', 'increasing', 'decreasing',
  'surging', 'surged', 'declining', 'declined', 'improving', 'improved', 'healthy',
  'unhealthy', 'active', 'quiet', 'busy', 'stable', 'growth', 'drop', 'rise', 'falling',
];

test('two complete seven-day windows report both sums, the difference and the percentage', () => {
  const delta = sufficient(sevenDayDelta(request(twentyStoredDays(), '2026-03-07', '2026-03-20')));

  assert.equal(delta.comparison, 'seven-day');
  assert.equal(delta.metric, metric);
  assert.deepEqual(delta.range, { from: '2026-03-07', to: '2026-03-20' });
  // The range's own last seven days against the seven before them: 14+15+16+17+18+19+20
  // is 119, and 7+8+9+10+11+12+13 is 70.
  assert.deepEqual([delta.current.from, delta.current.to], ['2026-03-14', '2026-03-20']);
  assert.deepEqual([delta.previous.from, delta.previous.to], ['2026-03-07', '2026-03-13']);
  assert.equal(delta.current.sum, 119);
  assert.equal(delta.previous.sum, 70);
  assert.equal(delta.change, 49);
  assert.equal(delta.percentage, 70);
  assert.equal(delta.percentageOmitted, null);
  assert.deepEqual(delta.current.missingDays, []);
  assert.deepEqual(delta.previous.missingDays, []);
  assert.equal(delta.current.days, WINDOW_DAYS);
  assert.equal(delta.previous.days, WINDOW_DAYS);
  assert.equal(delta.current.storedDays.length, WINDOW_DAYS);
  // Every absolute first, then the difference, then the percentage beside its base.
  assert.equal(
    delta.summary,
    'clones recorded 119 over the last 7 days of the selected range (2026-03-14 to 2026-03-20) and 70 over the '
    + '7 days before them (2026-03-07 to 2026-03-13); the difference is 49 and 70% of 70',
  );
});

test('one missing day in the later window returns insufficient data naming that day and no percentage', () => {
  const delta = insufficient(sevenDayDelta(request(holeInTheLaterWindow(), '2026-03-07', '2026-03-20')));

  assert.equal(delta.reason, REASON_MISSING_DAYS);
  assert.deepEqual(delta.missingDays, ['2026-03-15']);
  assert.ok(delta.summary.includes('2026-03-15'), `the reason must name the day: ${delta.summary}`);
  // The smaller sum is the failure this rule exists to prevent: the later window
  // holds six stored days and must not total them as though the seventh were zero.
  assert.equal(delta.current.sum, null);
  assert.deepEqual(delta.current.storedDays.length, 6);
  assert.deepEqual(delta.current.missingDays, ['2026-03-15']);
  // The window that is whole keeps its total, so a reader can see which side held.
  assert.equal(delta.previous.sum, 70);
  // No difference and no percentage are reported at all, not a percentage of null.
  assert.ok(!('change' in delta));
  assert.ok(!('percentage' in delta));
  assert.ok(!('percentageOmitted' in delta));
  assert.equal(delta.requiredDays, COMPARISON_DAYS);
  assert.equal(delta.availableDays, 14);
});

test('a hole in the earlier window is named and not summed as a smaller base', () => {
  const rows = twentyStoredDays().filter((row) => row.day !== '2026-03-10');
  const delta = insufficient(sevenDayDelta(request(rows, '2026-03-07', '2026-03-20')));

  assert.deepEqual(delta.missingDays, ['2026-03-10']);
  assert.equal(delta.previous.sum, null);
  assert.equal(delta.current.sum, 119);
  assert.ok(!('percentage' in delta));
});

test('two holes in two windows are both named, oldest first', () => {
  const rows = twentyStoredDays().filter((row) => row.day !== '2026-03-15' && row.day !== '2026-03-10');
  const delta = insufficient(sevenDayDelta(request(rows, '2026-03-07', '2026-03-20')));

  assert.deepEqual(delta.missingDays, ['2026-03-10', '2026-03-15']);
  assert.ok(delta.summary.includes('2026-03-10'));
  assert.ok(delta.summary.includes('2026-03-15'));
});

test('an earlier window of stored zeros reports the absolute difference with the percentage omitted', () => {
  const rows = twentyStoredDays().map((row) => (row.day <= '2026-03-13' ? { ...row, value: 0 } : row));
  const delta = sufficient(sevenDayDelta(request(rows, '2026-03-07', '2026-03-20')));

  // Zeros here are stored readings, not holes: the windows are complete, which is
  // exactly why a zero base can be told apart from a missing day.
  assert.deepEqual(delta.previous.missingDays, []);
  assert.equal(delta.previous.sum, 0);
  assert.equal(delta.current.sum, 119);
  assert.equal(delta.change, 119);
  assert.equal(delta.percentage, null);
  assert.equal(delta.percentageOmitted, PERCENTAGE_OMITTED_ZERO_BASE);
  assert.ok(delta.summary.includes('no percentage is reported'));
  const serialised = JSON.stringify(delta);
  assert.ok(!serialised.includes('Infinity'), 'a zero base must never produce Infinity');
  assert.ok(!serialised.includes('NaN'), 'a zero base must never produce NaN');
});

test('a window of stored zeros is a reading, not a fall to nothing', () => {
  const rows = twentyStoredDays().map((row) => (row.day >= '2026-03-14' ? { ...row, value: 0 } : row));
  const delta = sufficient(sevenDayDelta(request(rows, '2026-03-07', '2026-03-20')));

  assert.deepEqual(delta.current.missingDays, []);
  assert.equal(delta.current.sum, 0);
  assert.equal(delta.previous.sum, 70);
  assert.equal(delta.change, -70);
  assert.equal(delta.percentage, -100);
  assert.ok(delta.summary.includes('-100% of 70'));
});

test('a range shorter than fourteen days returns insufficient data naming the requirement', () => {
  const delta = insufficient(sevenDayDelta(request(twentyStoredDays(), '2026-03-14', '2026-03-20')));

  assert.equal(delta.reason, REASON_SHORT_RANGE);
  assert.equal(delta.requiredDays, COMPARISON_DAYS);
  assert.equal(delta.availableDays, 7);
  assert.deepEqual(delta.missingDays, []);
  assert.ok(delta.summary.includes(`${COMPARISON_DAYS} stored days`), `must name the requirement: ${delta.summary}`);
  assert.ok(delta.summary.includes('seven-day'));
  assert.ok(!('change' in delta));
  assert.ok(!('percentage' in delta));
  // A range that cannot hold both windows totals neither of them, even when every day
  // it does cover happens to be stored.
  assert.equal(delta.current.sum, null);
  assert.equal(delta.previous.sum, null);
});

test('a hole outside both windows does not block the reading', () => {
  const rows = twentyStoredDays().filter((row) => row.day !== '2026-03-03');
  const delta = sufficient(sevenDayDelta(request(rows, '2026-03-01', '2026-03-20')));

  // 2026-03-03 is inside the range and inside neither window, so the requirement is
  // per window: the reading stands, and the hole is not quietly summed as a zero.
  assert.equal(delta.current.sum, 119);
  assert.equal(delta.previous.sum, 70);
  assert.equal(delta.change, 49);
  assert.deepEqual(delta.current.missingDays, []);
  assert.deepEqual(delta.previous.missingDays, []);
});

test('week-over-week compares the last complete week and leaves the running day out', () => {
  const delta = sufficient(weekOverWeekDelta({
    ...request(twentyStoredDays(), '2026-03-01', '2026-03-20'), today: '2026-03-20',
  }));

  // 2026-03-20 is still running, so the last complete week ends the day before it.
  assert.deepEqual([delta.current.from, delta.current.to], ['2026-03-13', '2026-03-19']);
  assert.deepEqual([delta.previous.from, delta.previous.to], ['2026-03-06', '2026-03-12']);
  assert.ok(!delta.current.calendarDays.includes('2026-03-20'));
  assert.ok(!delta.previous.calendarDays.includes('2026-03-20'));
  // 13+14+15+16+17+18+19 is 112, not the 119 a partial week ending today would give.
  assert.equal(delta.current.sum, 112);
  assert.equal(delta.previous.sum, 63);
  assert.equal(delta.change, 49);
  assert.equal(delta.percentage, 77.78);
  assert.ok(delta.summary.includes('the last complete week'));
});

test('week-over-week ends on the range end when the range ends before the reference day', () => {
  const delta = sufficient(weekOverWeekDelta({
    ...request(twentyStoredDays(), '2026-03-01', '2026-03-19'), today: '2026-03-25',
  }));

  assert.deepEqual([delta.current.from, delta.current.to], ['2026-03-13', '2026-03-19']);
  assert.equal(delta.current.sum, 112);
  assert.equal(delta.previous.sum, 63);
});

test('week-over-week names the fourteen-day requirement when the range cannot hold both weeks', () => {
  const delta = insufficient(weekOverWeekDelta({
    ...request(twentyStoredDays(), '2026-03-07', '2026-03-20'), today: '2026-03-20',
  }));

  // A fourteen-day range that ends today reaches one day short of the last complete
  // week's first day. The range is refused rather than shortened, while the
  // seven-day reading over the very same range is available.
  assert.equal(delta.reason, REASON_SHORT_RANGE);
  assert.equal(delta.requiredDays, COMPARISON_DAYS);
  assert.equal(delta.availableDays, 13);
  assert.ok(delta.summary.includes('week-over-week'));
  assert.ok(!('percentage' in delta));
  assert.equal(sufficient(sevenDayDelta(request(twentyStoredDays(), '2026-03-07', '2026-03-20'))).status,
    DELTA_SUFFICIENT);
});

test('week-over-week reports a hole inside its own windows', () => {
  const delta = insufficient(weekOverWeekDelta({
    ...request(holeInTheLaterWindow(), '2026-03-01', '2026-03-20'), today: '2026-03-21',
  }));

  assert.equal(delta.reason, REASON_MISSING_DAYS);
  assert.deepEqual(delta.missingDays, ['2026-03-15']);
  assert.equal(delta.current.sum, null);
  assert.ok(delta.summary.includes('2026-03-15'));
});

test('a small repository moving a large ratio keeps its absolute values beside the percentage', () => {
  const rows = [
    { day: '2026-03-07', value: 0 },
    { day: '2026-03-08', value: 0 },
    { day: '2026-03-09', value: 0 },
    { day: '2026-03-10', value: 1 },
    { day: '2026-03-11', value: 1 },
    { day: '2026-03-12', value: 1 },
    { day: '2026-03-13', value: 0 },
    { day: '2026-03-14', value: 2 },
    { day: '2026-03-15', value: 2 },
    { day: '2026-03-16', value: 2 },
    { day: '2026-03-17', value: 2 },
    { day: '2026-03-18', value: 1 },
    { day: '2026-03-19', value: 1 },
    { day: '2026-03-20', value: 2 },
  ];
  const delta = sufficient(sevenDayDelta(request(rows, '2026-03-07', '2026-03-20')));

  // Three clones to twelve: the ratio is 300%, and the honest answer keeps 3 and 12
  // in the sentence rather than leading with the percentage.
  assert.equal(delta.previous.sum, 3);
  assert.equal(delta.current.sum, 12);
  assert.equal(delta.change, 9);
  assert.equal(delta.percentage, 300);
  assert.ok(delta.summary.includes('recorded 12'));
  assert.ok(delta.summary.includes('and 3 over'));
  assert.ok(delta.summary.includes('300% of 3'));
});

test('a real change of one clone against a thousand is not rendered as zero percent', () => {
  const rows = [
    { day: '2026-03-07', value: 100 },
    { day: '2026-03-08', value: 100 },
    { day: '2026-03-09', value: 100 },
    { day: '2026-03-10', value: 100 },
    { day: '2026-03-11', value: 200 },
    { day: '2026-03-12', value: 200 },
    { day: '2026-03-13', value: 200 },
    { day: '2026-03-14', value: 143 },
    { day: '2026-03-15', value: 143 },
    { day: '2026-03-16', value: 143 },
    { day: '2026-03-17', value: 143 },
    { day: '2026-03-18', value: 143 },
    { day: '2026-03-19', value: 143 },
    { day: '2026-03-20', value: 143 },
  ];
  const delta = sufficient(sevenDayDelta(request(rows, '2026-03-07', '2026-03-20')));

  assert.equal(delta.previous.sum, 1000);
  assert.equal(delta.current.sum, 1001);
  assert.equal(delta.change, 1);
  assert.ok(delta.summary.includes('0.1% of 1000'));
  assert.ok(!delta.summary.includes('0% of'), 'a nonzero change must never read as no change');
});

test('identical input returns an identical reading, whatever order the rows arrive in', () => {
  const rows = twentyStoredDays();
  const first = sevenDayDelta(request(rows, '2026-03-07', '2026-03-20'));
  const second = sevenDayDelta(request(rows, '2026-03-07', '2026-03-20'));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  // Order carries no meaning and a row from outside the range is not an error: both
  // are properties of a pure function over stored days, not of the caller's array.
  const reversed = [...rows].reverse();
  assert.deepEqual(sevenDayDelta(request(reversed, '2026-03-07', '2026-03-20')), first);
  const withExtraDays = [...rows, { day: '2026-03-25', value: 900 }];
  assert.deepEqual(sevenDayDelta(request(withExtraDays, '2026-03-07', '2026-03-20')), first);
});

test('no output string carries a score, grade, threshold, verdict or trend word', () => {
  const readings = [
    sevenDayDelta(request(twentyStoredDays(), '2026-03-07', '2026-03-20')),
    sevenDayDelta(request(holeInTheLaterWindow(), '2026-03-07', '2026-03-20')),
    sevenDayDelta(request(twentyStoredDays(), '2026-03-14', '2026-03-20')),
    sevenDayDelta(request(twentyStoredDays().map((row) => (row.day <= '2026-03-13'
      ? { ...row, value: 0 } : row)), '2026-03-07', '2026-03-20')),
    weekOverWeekDelta({ ...request(twentyStoredDays(), '2026-03-01', '2026-03-20'), today: '2026-03-20' }),
    weekOverWeekDelta({ ...request(holeInTheLaterWindow(), '2026-03-01', '2026-03-20'), today: '2026-03-21' }),
    weekOverWeekDelta({ ...request(twentyStoredDays(), '2026-03-07', '2026-03-20'), today: '2026-03-20' }),
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
  const readings = [
    sevenDayDelta(request(twentyStoredDays(), '2026-03-07', '2026-03-20')),
    weekOverWeekDelta({ ...request(twentyStoredDays(), '2026-03-01', '2026-03-20'), today: '2026-03-20' }),
  ];
  for (const reading of readings) {
    const delta = sufficient(reading);
    if (delta.percentage === null) continue;
    assert.ok(delta.summary.includes(`${delta.current.sum}`));
    assert.ok(delta.summary.includes(`${delta.previous.sum}`));
    assert.ok(delta.summary.includes(`${delta.change}`));
    assert.ok(delta.summary.includes('%'), 'a percentage must be shown, not only carried as a number');
  }
});

test('a stored reading that is not a real calendar day is refused', () => {
  assert.throws(() => sevenDayDelta(request([{ day: '2026-02-30', value: 1 }], '2026-02-01', '2026-03-20')),
    /real UTC calendar day/);
  assert.throws(() => sevenDayDelta(request([{ day: '2026-03-01', value: 1 }], '2026-03-01', '2026-03-20z')),
    /real UTC calendar day/);
});

test('two observations on one day are refused rather than summed twice', () => {
  const rows = [...twentyStoredDays(), { day: '2026-03-14', value: 14 }];
  assert.throws(() => sevenDayDelta(request(rows, '2026-03-07', '2026-03-20')),
    /one day has one stored value/);
});

test('an observation without a finite number is refused rather than summed as NaN', () => {
  /** @type {Observation[]} */
  const rows = [{ day: '2026-03-14', value: Number.NaN }];
  assert.throws(() => sevenDayDelta(request(rows, '2026-03-07', '2026-03-20')), /finite numeric value/);
});

test('a request without a metric, a range or an observation array is refused', () => {
  // Each argument here is deliberately wrong in a way the JSDoc already forbids, so
  // the casts are what let the runtime guard be exercised at all.
  assert.throws(() => sevenDayDelta(/** @type {any} */ ({
    observations: [], range: { from: '2026-03-07', to: '2026-03-20' },
  })), /needs a metric name/);
  assert.throws(() => sevenDayDelta(/** @type {any} */ ({ metric, observations: [], range: null })),
    /inclusive range/);
  assert.throws(() => sevenDayDelta(/** @type {any} */ ({ metric, observations: '2026-03-14',
    range: { from: '2026-03-07', to: '2026-03-20' } })), /observation array/);
});

test('a reversed range is refused before anything is summed', () => {
  assert.throws(() => sevenDayDelta(request(twentyStoredDays(), '2026-03-20', '2026-03-07')),
    /Reversed day range/);
});

test('week-over-week insists on the reference day that makes a week complete', () => {
  assert.throws(() => weekOverWeekDelta(/** @type {any} */ (request(twentyStoredDays(), '2026-03-01', '2026-03-20'))),
    /reference day/);
  assert.throws(() => weekOverWeekDelta({
    ...request(twentyStoredDays(), '2026-03-01', '2026-03-20'), today: '2026-03-32',
  }), /real UTC calendar day/);
});

test('the module reads no clock, imports nothing and holds no mutable module state', () => {
  assert.ok(!/\bimport\b/.test(moduleSource), 'the arithmetic takes no dependency: not a date library, not a client');
  assert.ok(!/\bDate\.now\b/.test(moduleSource), 'the current day is a parameter, never a read of the clock');
  assert.ok(!/\bDate\(\s*\)/.test(moduleSource), 'the current instant is never taken from the host');
  assert.ok(!/\bMath\.random\b/.test(moduleSource), 'identical input must produce identical output');
  assert.ok(!/\bprocess\./.test(moduleSource), 'the module reads no environment, so no run can depend on one');
});