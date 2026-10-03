import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHART_HEIGHT,
  CHART_WIDTH,
  DEFAULT_VALUE_LABEL,
  GAP_CELL_TEXT,
  MAX_VALUE_TICKS,
  PLOT_BOTTOM,
  PLOT_HEIGHT,
  PLOT_LEFT,
  PLOT_TOP,
  PLOT_WIDTH,
  buildLineChart,
  renderLineChart,
  renderLineChartSvg,
  renderLineChartTable,
} from '../src/views/components/line-chart.js';

const CHART_SOURCE_PATH = fileURLToPath(new URL('../src/views/components/line-chart.js', import.meta.url));
const DAY_MS = 86_400_000;

/**
 * Every day of an inclusive range, so a test states its window the way a page does.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function days(from, to) {
  /** @type {string[]} */
  const listed = [];
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += DAY_MS) {
    listed.push(new Date(time).toISOString().slice(0, 10));
  }
  return listed;
}

/**
 * One element of a kind, as `{ attributes, body }`, or null when there is none.
 * The attributes are a plain object so an assertion reads as a name and a value.
 * @param {string} markup
 * @param {string} tag `polyline`, `circle` and so on.
 * @returns {{attributes: Record<string, string>, body: string}|null}
 */
function element(markup, tag) {
  const match = new RegExp(`<${tag}\\b([^>]*?)(/?)>`).exec(markup);
  if (match === null) return null;
  /** @type {Record<string, string>} */
  const attributes = {};
  for (const [, name, value] of match[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
    if (name !== undefined && value !== undefined) attributes[name] = value;
  }
  return { attributes, body: match[2] ?? '' };
}

/**
 * Every element of a kind, as `{ attributes, body }`.
 * @param {string} markup
 * @param {string} tag
 * @returns {{attributes: Record<string, string>, body: string}[]}
 */
function elements(markup, tag) {
  /** @type {{attributes: Record<string, string>, body: string}[]} */
  const found = [];
  for (const match of markup.matchAll(new RegExp(`<${tag}\\b([^>]*?)(/?)>`, 'g'))) {
    /** @type {Record<string, string>} */
    const attributes = {};
    for (const [, name, value] of match[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      if (name !== undefined && value !== undefined) attributes[name] = value;
    }
    found.push({ attributes, body: match[2] ?? '' });
  }
  return found;
}

/**
 * The coordinates of a polyline, as `[x, y]` pairs.
 * @param {{attributes: Record<string, string>, body: string}} polyline
 * @returns {[number, number][]}
 */
function coordinates(polyline) {
  const points = polyline.attributes.points ?? '';
  return points.split(' ').filter((pair) => pair !== '').map((pair) => {
    const [x, y] = pair.split(',');
    return [Number(x), Number(y)];
  });
}

/**
 * The `[x, y]` pairs of every polyline in the markup, in order.
 * @param {string} markup
 * @returns {[number, number][][]}
 */
function allCoordinates(markup) {
  return elements(markup, 'polyline').map(coordinates);
}

/**
 * The day and the value cell of every table row, as `{ day, text, gap }`.
 * @param {string} markup
 * @returns {{day: string, text: string, gap: boolean}[]}
 */
function tableRows(markup) {
  const body = element(markup, 'tbody')?.body === '/'
    ? ''
    : /<tbody>([\s\S]*?)<\/tbody>/.exec(markup)?.[1] ?? '';
  return [...body.matchAll(/<tr class="([^"]*)">([\s\S]*?)<\/tr>/g)].map((match) => {
    const classes = match[1] ?? '';
    const cells = match[2] ?? '';
    const day = /<th scope="row">([^<]*)<\/th>/.exec(cells)?.[1] ?? '';
    const text = /<td>([\s\S]*?)<\/td>/.exec(cells)?.[1] ?? '';
    return { day, text, gap: classes.includes('chart-row-gap') };
  });
}

/**
 * The value cell for one day, or null when the table has no row for it.
 * @param {string} markup
 * @param {string} day
 * @returns {string|null}
 */
function cellFor(markup, day) {
  return tableRows(markup).find((row) => row.day === day)?.text ?? null;
}

/**
 * Every number appearing in an attribute of a coordinate element.
 * @param {string} markup
 * @param {string} tag
 * @returns {number[]}
 */
function coordinatesOf(markup, tag) {
  /** @type {number[]} */
  const numbers = [];
  for (const found of elements(markup, tag)) {
    for (const name of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'points', 'r']) {
      const value = found.attributes[name];
      if (value === undefined) continue;
      for (const part of value.split(/[ ,]+/).filter((piece) => piece !== '')) numbers.push(Number(part));
    }
  }
  return numbers;
}

/**
 * Render a request the type checker cannot know is malformed. The cast is confined
 * to this one helper so a test can assert that the module refuses the request by
 * name rather than plotting it.
 * @param {unknown} request
 * @returns {string}
 */
function renderUnchecked(request) {
  return renderLineChart(
    /** @type {import('../src/views/components/line-chart.js').LineChartRequest} */ (
      /** @type {unknown} */ (request)
    ),
  );
}

/**
 * A window of the days a test names, with the days it leaves out absent rather than
 * zero-filled, the way the archive's own range read returns them.
 * @param {string} from
 * @param {string} to
 * @param {number} [padding] Days added either side of the stored days.
 * @returns {string[]}
 */
function windowAround(from, to, padding = 0) {
  return days(
    new Date(Date.parse(`${from}T00:00:00Z`) - padding * DAY_MS).toISOString().slice(0, 10),
    new Date(Date.parse(`${to}T00:00:00Z`) + padding * DAY_MS).toISOString().slice(0, 10),
  );
}

/** @type {import('../src/views/components/line-chart.js').LineChartRequest} */
/**
 * How many times a pattern appears in the markup, counting zero as zero rather than
 * as `undefined`, so an assertion about an absent element reads as an absence.
 * @param {string} markup
 * @param {RegExp} pattern
 * @returns {number}
 */
function count(markup, pattern) {
  return (markup.match(pattern) ?? []).length;
}

/**
 * Every plotted point in the markup: the polyline vertices and the single-day
 * markers alike, since both are a stored day's own coordinate.
 * @param {string} markup
 * @returns {[number, number][]}
 */
function plottedPoints(markup) {
  const runs = allCoordinates(markup);
  for (const marker of elements(markup, 'circle')) {
    runs.push([[Number(marker.attributes.cx), Number(marker.attributes.cy)]]);
  }
  return runs.flat();
}

const CONTIGUOUS = {
  label: 'Clones',
  observations: [
    { day: '2026-03-01', value: 12 },
    { day: '2026-03-02', value: 18 },
    { day: '2026-03-03', value: 15 },
    { day: '2026-03-04', value: 24 },
  ],
};

/** @type {import('../src/views/components/line-chart.js').LineChartRequest} */
const WITH_HOLE = {
  label: 'Clones',
  observations: [
    { day: '2026-03-01', value: 12 },
    { day: '2026-03-02', value: 18 },
    { day: '2026-03-03', value: 15 },
    { day: '2026-03-05', value: 21 },
    { day: '2026-03-06', value: 19 },
  ],
  calendarDays: days('2026-03-01', '2026-03-06'),
};

test('a contiguous series is one polyline carrying one point per stored day', () => {
  const markup = renderLineChart(CONTIGUOUS);
  const polylines = elements(markup, 'polyline');
  assert.equal(polylines.length, 1);
  assert.equal(coordinates(polylines[0]).length, 4);
  assert.equal(elements(markup, 'circle').length, 0);
  assert.equal(elements(markup, 'polyline').reduce((total, line) => total + Number(line.attributes['data-days']), 0), 4);
  assert.equal(polylines[0].attributes['data-from'], '2026-03-01');
  assert.equal(polylines[0].attributes['data-to'], '2026-03-04');
});

test('one interior missing day produces two polylines and no segment spanning the hole', () => {
  const markup = renderLineChart(WITH_HOLE);
  const polylines = elements(markup, 'polyline');
  assert.equal(polylines.length, 2, 'a hole in the middle must break the line in two');
  assert.deepEqual(
    polylines.map((line) => [line.attributes['data-from'], line.attributes['data-to'], coordinates(line).length]),
    [['2026-03-01', '2026-03-03', 3], ['2026-03-05', '2026-03-06', 2]],
  );

  // No element may hold two points whose days are not adjacent in the calendar,
  // which is the definition of a bridged segment.
  const model = buildLineChart(WITH_HOLE);
  const byX = new Map(model.storedPoints.map((point) => [point.x, point.dayIndex]));
  for (const run of allCoordinates(markup)) {
    for (let index = 1; index < run.length; index += 1) {
      const previous = byX.get(run[index - 1][0]);
      const current = byX.get(run[index][0]);
      assert.ok(previous !== undefined && current !== undefined, 'every plotted x belongs to a stored day');
      assert.equal(current - previous, 1, `a segment spans more than one calendar day: ${previous} to ${current}`);
    }
  }
  // The day either side of the hole must be in different runs, never one line.
  const beforeHole = polylines.filter((line) => line.attributes['data-to'] === '2026-03-03');
  const afterHole = polylines.filter((line) => line.attributes['data-from'] === '2026-03-05');
  assert.equal(beforeHole.length, 1);
  assert.equal(afterHole.length, 1);
  assert.equal(model.missingDays.length, 1);
  assert.deepEqual(model.missingDays, ['2026-03-04']);
});

test('a hole of several days, and a hole at either end of the window, are all drawn as breaks', () => {
  const request = {
    label: 'Views',
    observations: [
      { day: '2026-03-03', value: 40 },
      { day: '2026-03-04', value: 44 },
      { day: '2026-03-07', value: 51 },
    ],
    calendarDays: days('2026-03-01', '2026-03-08'),
  };
  const markup = renderLineChart(request);
  const polylines = elements(markup, 'polyline');
  assert.equal(polylines.length, 1, 'only the two adjacent stored days can be joined by a line');
  assert.deepEqual(
    polylines.map((line) => [line.attributes['data-from'], line.attributes['data-to']]),
    [['2026-03-03', '2026-03-04']],
  );
  const model = buildLineChart(request);
  assert.deepEqual(model.missingDays, ['2026-03-01', '2026-03-02', '2026-03-05', '2026-03-06', '2026-03-08']);
  assert.deepEqual(model.markerRuns.map((run) => run.from), ['2026-03-07']);
  assert.equal(elements(markup, 'circle').length, 1, 'the lone stored day is a marker, never a one-point line');
});

test('a single stored day produces a marker, not a line, and divides by nothing', () => {
  const markup = renderLineChart({ label: 'Unique cloners', observations: [{ day: '2026-04-01', value: 3 }] });
  assert.equal(elements(markup, 'polyline').length, 0, 'a one-point polyline draws nothing');
  const marker = element(markup, 'circle');
  assert.ok(marker !== null, 'a single stored day is drawn as a marker');
  assert.equal(marker.attributes['data-day'], '2026-04-01');
  assert.equal(Number(marker.attributes.cx), PLOT_LEFT + PLOT_WIDTH / 2, 'a one-day window is centred');
  assert.equal(Number(marker.attributes.cy), PLOT_TOP);
  assert.ok(Number.isFinite(Number(marker.attributes.cx)) && Number.isFinite(Number(marker.attributes.cy)));
  assert.ok(!/NaN|Infinity|undefined|null/.test(markup), `a degenerate coordinate reached the markup: ${markup}`);
});

test('a window of one day with one stored value stays finite on both axes', () => {
  const markup = renderLineChart({
    label: 'Stars',
    observations: [{ day: '2026-04-01', value: 8000 }],
    calendarDays: ['2026-04-01'],
  });
  assert.ok(!/NaN|Infinity|-0[,."]/.test(markup), 'a one-day window must not produce a degenerate coordinate');
  const marker = element(markup, 'circle');
  assert.ok(marker !== null);
  assert.equal(Number(marker.attributes.cx), PLOT_LEFT + PLOT_WIDTH / 2);
  assert.equal(Number(marker.attributes.cy), PLOT_TOP);
});

test('a stored value of zero is drawn on the baseline and the largest value at the top of the plot box', () => {
  const model = buildLineChart({
    label: 'Views',
    observations: [
      { day: '2026-03-01', value: 0 },
      { day: '2026-03-02', value: 250 },
      { day: '2026-03-03', value: 100 },
    ],
  });
  assert.equal(model.maxValue, 250);
  assert.equal(model.storedPoints[0].y, PLOT_TOP + PLOT_HEIGHT, 'zero sits on the baseline');
  assert.equal(model.storedPoints[1].y, PLOT_TOP, 'the largest stored value reaches the top of the plot box');
  assert.equal(model.storedPoints[2].y, PLOT_TOP + PLOT_HEIGHT - (100 / 250) * PLOT_HEIGHT);
});

test('a small repository is scaled to the full height, and a busy one is drawn in the same shape', () => {
  const smallDays = [{ day: '2026-03-01', value: 3 }, { day: '2026-03-02', value: 5 }];
  const busyDays = [{ day: '2026-03-01', value: 300 }, { day: '2026-03-02', value: 500 }];
  const small = renderLineChart({ label: 'Unique cloners', observations: smallDays });
  const busy = renderLineChart({ label: 'Unique cloners', observations: busyDays });
  /** @param {string} markup */
  const shape = (markup) => elements(markup, 'polyline')
    .map((line) => coordinates(line).map((pair) => pair[0]));
  assert.deepEqual(shape(small), shape(busy), 'the geometry depends on the days, not on the size of the numbers');

  const smallModel = buildLineChart({ label: 'Unique cloners', observations: smallDays });
  const busyModel = buildLineChart({ label: 'Unique cloners', observations: busyDays });
  assert.equal(smallModel.storedPoints[1].y, PLOT_TOP, 'three clones reach the top of the plot box too');
  assert.equal(busyModel.storedPoints[1].y, PLOT_TOP, 'so do five hundred');

  // The axis names different numbers for the two repositories, and says so in the
  // same sentence shape: the small one is described exactly as the busy one, with
  // its own numbers beside it and no adjective about its size.
  assert.match(smallModel.summary, /The value axis runs from 0 to 5, the largest stored value\./);
  assert.match(busyModel.summary, /The value axis runs from 0 to 500, the largest stored value\./);
  assert.equal(smallModel.summary.replace('5,', '#'), busyModel.summary.replace('500,', '#'));
});

test('the left axis carries at most five ticks, and always includes zero and the largest value', () => {
  for (const maximum of [1, 3, 7, 21, 100, 900, 8000, 12345]) {
    const model = buildLineChart({
      label: 'Views',
      observations: [{ day: '2026-03-01', value: maximum }, { day: '2026-03-02', value: 0 }],
    });
    assert.ok(model.valueTicks.length <= MAX_VALUE_TICKS, `${maximum} produced ${model.valueTicks.length} ticks`);
    assert.equal(model.valueTicks[0], 0);
    assert.equal(model.valueTicks[model.valueTicks.length - 1], maximum);
    assert.deepEqual(model.valueTicks, [...model.valueTicks].sort((left, right) => left - right));
    const markup = renderLineChart({
      label: 'Views',
      observations: [{ day: '2026-03-01', value: maximum }, { day: '2026-03-02', value: 0 }],
    });
    assert.equal(elements(markup, 'g').filter((found) => found.attributes.class === 'chart-value-tick').length, model.valueTicks.length);
  }
});

test('the bottom axis names the first day, the last day and the boundary day, and nothing else', () => {
  const withBoundary = renderLineChart({
    label: 'Clones',
    observations: CONTIGUOUS.observations,
    calendarDays: days('2026-03-01', '2026-03-04'),
    boundaryDay: '2026-03-02',
  });
  const ticks = elements(withBoundary, 'g').filter((found) => found.attributes.class === 'chart-day-tick');
  assert.equal(ticks.length, 3);
  assert.deepEqual(ticks.map((tick) => tick.attributes['data-day']), ['2026-03-01', '2026-03-02', '2026-03-04']);
  assert.match(withBoundary, />collected from 2026-03-02</);
  assert.match(withBoundary, /First collected day: 2026-03-02\./);

  const withoutBoundary = renderLineChart({ label: 'Clones', observations: CONTIGUOUS.observations });
  const plain = elements(withoutBoundary, 'g').filter((found) => found.attributes.class === 'chart-day-tick');
  assert.equal(plain.length, 2, 'with no boundary the axis names the first and last day');
  assert.ok(!/collected from/.test(withoutBoundary), 'no boundary means no boundary wording');
});

test('a boundary day outside the window is not drawn as if the chart annotated it', () => {
  const markup = renderLineChart({
    label: 'Clones',
    observations: CONTIGUOUS.observations,
    boundaryDay: '2026-01-05',
  });
  assert.ok(!/collected from/.test(markup));
  assert.ok(!/First collected day/.test(markup));
});

test('the paired data table carries the same values as the plotted series', () => {
  const request = {
    label: 'Unique cloners',
    valueLabel: 'Unique cloners',
    observations: [
      { day: '2026-03-01', value: 7 },
      { day: '2026-03-02', value: 11 },
      { day: '2026-03-03', value: 9 },
      { day: '2026-03-05', value: 13 },
    ],
    calendarDays: days('2026-03-01', '2026-03-05'),
  };
  const model = buildLineChart(request);
  const table = renderLineChartTable(model);
  const rows = tableRows(table);

  // One row per calendar day, so the count of rows is the length of the window, and
  // the rows walk the window oldest first with no day left out.
  assert.equal(rows.length, model.calendarDayCount);
  assert.deepEqual(rows.map((row) => row.day), days('2026-03-01', '2026-03-05'));
  assert.deepEqual(
    rows.filter((row) => !row.gap).map((row) => row.day),
    ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-05'],
  );

  // Every stored value in the table equals the value the archive supplied, and the
  // value axis reports the same numbers.
  const markup = renderLineChart(request);
  for (const point of model.storedPoints) {
    assert.equal(cellFor(markup, point.day), String(point.value), `the table disagrees with the archive on ${point.day}`);
  }
  const tickValues = elements(markup, 'g')
    .filter((found) => found.attributes.class === 'chart-value-tick')
    .map((found) => Number(found.attributes['data-value']));
  assert.deepEqual(tickValues, model.valueTicks);

  // And the plotted y for each stored day is the y the model derived from it, so the
  // picture cannot drift from the numbers underneath it.
  const plotted = new Map();
  for (const [x, y] of plottedPoints(markup)) plotted.set(x, y);
  assert.equal(plotted.size, model.storedPoints.length, 'one plotted point per stored day, no more and no fewer');
  for (const point of model.storedPoints) {
    assert.equal(plotted.get(point.x), point.y, `the plotted point for ${point.day} is not the value's own coordinate`);
  }
});

test('the paired table names every missing day in words instead of omitting it', () => {
  const markup = renderLineChart(WITH_HOLE);
  const rows = tableRows(markup);
  const gap = rows.find((row) => row.day === '2026-03-04');
  assert.ok(gap !== undefined, 'the missing day keeps its row: an omitted day reads as a zero day');
  assert.equal(gap.gap, true);
  assert.equal(gap.text, GAP_CELL_TEXT);
  assert.ok(!/\d/.test(gap.text), 'a gap row must carry no number at all');
  for (const row of rows.filter((entry) => entry.gap)) {
    assert.equal(row.text, GAP_CELL_TEXT);
  }
  assert.equal(rows.length, 6, 'one row per calendar day, stored or not');
  assert.match(markup, /No stored value for 2026-03-04: 1 day is unmeasured, not zero\./);
  assert.match(markup, />2026-03-04<\/th><td>No stored value \(gap\)<\/td></);
});

test('a long run of missing days names the days in the sentence and every day in the table', () => {
  const observations = [{ day: '2026-03-01', value: 5 }, { day: '2026-03-13', value: 6 }];
  const markup = renderLineChart({ label: 'Views', observations, calendarDays: days('2026-03-01', '2026-03-13') });
  const rows = tableRows(markup).filter((row) => row.gap);
  assert.equal(rows.length, 11, 'all eleven missing days keep a row');
  assert.match(markup, /11 days are unmeasured, not zero\./);
  assert.match(markup, /No stored value for 2026-03-02, 2026-03-03/);
  assert.match(markup, /, and 1 further day/, 'a sentence stays readable by counting the days it will not list');
});

test('the chart is reachable from its paired table, and the table is a real table', () => {
  const markup = renderLineChart(WITH_HOLE);
  const svg = element(markup, 'svg');
  assert.ok(svg !== null);
  assert.equal(svg.attributes.role, 'img');
  const describedBy = (svg.attributes['aria-describedby'] ?? '').split(' ');
  assert.ok(describedBy.includes('chart-clones-table-caption'), `the table caption is not reachable: ${describedBy}`);
  assert.match(markup, /<caption id="chart-clones-table-caption">/);
  assert.match(markup, /<th scope="col">Day<\/th>/);
  assert.match(markup, new RegExp(`<th scope="col">${DEFAULT_VALUE_LABEL}</th>`), 'no named column, so the documented default');
  assert.match(
    renderLineChart({ ...WITH_HOLE, valueLabel: 'Unique cloners' }),
    /<th scope="col">Unique cloners<\/th>/,
    'the value column is labelled with the caller-supplied name',
  );
});

test('calling the function twice with the same input returns byte-identical markup', () => {
  const first = renderLineChart(WITH_HOLE);
  const second = renderLineChart(WITH_HOLE);
  assert.equal(first, second);
  assert.equal(renderLineChart(WITH_HOLE).length, first.length);

  // The order the caller hands the observations over in is not part of the input's
  // meaning, so a shuffled array must produce the same bytes.
  const shuffled = {
    ...WITH_HOLE,
    observations: [...WITH_HOLE.observations].reverse(),
  };
  assert.equal(renderLineChart(shuffled), first);
});

test('the module imports nothing but the escaping helpers, and reads no clock or file', () => {
  const source = readFileSync(CHART_SOURCE_PATH, 'utf8');
  const imported = [...source.matchAll(/^import\s+(.+?)\s+from\s+'([^']+)'/gm)].map((match) => match[2]);
  assert.deepEqual(imported, ['../../server/html.js'], 'the only dependency is the shared escaping module');
  // `new Date(suppliedDayString)` is how a calendar day is turned into a number; a
  // clock read would be a `Date.now()` or a `new Date()` with no argument.
  assert.ok(!/Date\.now\s*\(/.test(source), 'the module must not read the clock');
  assert.ok(!/new Date\(\s*\)/.test(source), 'the module must not construct the current time');
  assert.ok(!/Math\.random|performance\.now|process\.hrtime|process\.env|Date\.UTC/.test(source), 'the module must not read anything else');
  for (const forbidden of ['node:fs', 'node:http', 'node:sqlite', 'node:child_process', 'require(', 'process.']) {
    assert.ok(!source.includes(forbidden), `the chart module must not use ${forbidden}`);
  }
});

test('the markup is a valid inline SVG fragment', () => {
  const markup = renderLineChart(WITH_HOLE);
  assert.equal(count(markup, /<svg\b/g), 1);
  assert.equal(count(markup, /<\/svg>/g), 1);
  const svg = element(markup, 'svg');
  assert.ok(svg !== null);
  assert.equal(svg.attributes.viewBox, `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
  assert.ok(svg.body === '', 'the svg is an inline fragment with no script or event handler');
  assert.match(markup, /<\/svg><figcaption/);
  assert.match(markup, /<title id="chart-clones-title">Clones<\/title>/);
  assert.match(markup, /<desc id="chart-clones-desc">/);
  // Every element the fragment opens is a self-closing line, text, polyline or circle.
  for (const found of [...elements(markup, 'line'), ...elements(markup, 'polyline'), ...elements(markup, 'circle')]) {
    assert.equal(found.body, '/', 'a void element must close itself inside an XML-compatible fragment');
  }
  // Elements nest in the order a parser expects.
  const order = ['<svg ', '<g class="chart-axis"', '<g class="chart-series"', '</g>', '</svg>'];
  let cursor = -1;
  for (const token of order) {
    const at = markup.indexOf(token, cursor + 1);
    assert.ok(at > cursor, `expected ${token} after the previous element`);
    cursor = at;
  }
});

test('the output carries no script, no event handler, no remote reference and no motion', () => {
  const requests = [
    CONTIGUOUS,
    WITH_HOLE,
    { label: 'Views', observations: [], calendarDays: days('2026-03-01', '2026-03-06') },
  ];
  for (const request of requests) {
    const markup = renderLineChart(request);
    assert.ok(!/<script/i.test(markup), 'no script tag');
    assert.ok(!/\son[a-z]+=/i.test(markup), 'no inline event handler');
    assert.ok(!/https?:|\/\/|@import|url\(|<img|<link|<iframe/i.test(markup), 'no external asset or protocol reference');
    assert.ok(!/<animate|<set|<transition|animation/i.test(markup), 'no motion');
    assert.ok(!/xlink:href|href=/.test(markup), 'no reference of any kind from the chart');
  }
});

test('no colour literal appears in the output, so the stylesheet stays the only place one is declared', () => {
  for (const request of [CONTIGUOUS, WITH_HOLE]) {
    const markup = renderLineChart(request);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(markup), `a hex colour literal reached the markup: ${markup}`);
    assert.ok(!/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/.test(markup), 'a colour function reached the markup');
    const named = ['red', 'blue', 'green', 'black', 'white', 'grey', 'gray', 'orange', 'purple', 'steelblue', 'tomato'];
    for (const colour of named) {
      assert.ok(!new RegExp(`(?:fill|stroke|color)="${colour}"`, 'i').test(markup), `a named colour reached the markup: ${colour}`);
    }
    assert.match(markup, /stroke="currentColor"/, 'the series takes its colour from the stylesheet');
  }
  // The single-day marker is filled rather than stroked, and takes the same colour
  // from the same place.
  const marker = renderLineChart({ label: 'Views', observations: [{ day: '2026-03-01', value: 2 }] });
  assert.match(marker, /<circle[^>]*fill="currentColor"/);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(marker));
});

test('a hostile label is escaped for text and attribute context', () => {
  const hostile = `"><img src=x onerror='alert(1)'> & <svg><script>x</script>`;
  const markup = renderLineChart({ label: hostile, observations: [{ day: '2026-03-01', value: 4 }] });
  assert.ok(!markup.includes('<img'), 'a label must not be able to open an element');
  assert.ok(!markup.includes('<script>'), 'a label must not be able to open a script');
  // The label reaches text contexts through the text escaper, which does not touch
  // a single quote because a quote cannot escape an element's content.
  assert.match(markup, /&lt;img src=x onerror='alert\(1\)'&gt;/);
  assert.ok(!/\son[a-z]+=/i.test(markup.replaceAll(/&lt;img[\s\S]*?&gt;/g, '')), 'no event handler survives as a real attribute');
  assert.equal(count(markup, /<img/g), 0);
  // The figure carries exactly the elements this module emits.
  assert.equal(count(markup, /<figure\b/g), 1);
  assert.equal(count(markup, /<table\b/g), 1);
  assert.equal(count(markup, /<svg\b/g), 1);
});

test('no stored day at all renders no figure and says so in words', () => {
  const markup = renderLineChart({
    label: 'Views',
    observations: [],
    calendarDays: days('2026-03-01', '2026-03-03'),
  });
  assert.equal(count(markup, /<svg\b/g), 0, 'an axes-only figure reads as a repository that peaked at zero');
  assert.equal(elements(markup, 'polyline').length, 0);
  assert.match(markup, /Views: no day in 2026-03-01 to 2026-03-03 carries a stored value, so there is nothing to plot\./);
  const rows = tableRows(markup);
  assert.equal(rows.length, 3);
  assert.deepEqual([...new Set(rows.map((row) => row.text))], [GAP_CELL_TEXT]);
  assert.equal(count(markup, /<figure\b/g), 1, 'the paired table still travels with the figure');
});

test('every coordinate in the output is a finite number inside the plot box', () => {
  assert.ok(PLOT_BOTTOM < CHART_HEIGHT, 'the bottom axis has room inside the viewBox');
  for (const request of [CONTIGUOUS, WITH_HOLE, {
    label: 'Stars',
    observations: [{ day: '2026-03-01', value: 0 }, { day: '2026-03-02', value: 0 }],
  }]) {
    const markup = renderLineChart(request);
    for (const number of coordinatesOf(markup, 'polyline')) {
      assert.ok(Number.isFinite(number), `a non-finite coordinate reached the markup: ${number}`);
      assert.ok(number >= 0 && number <= Math.max(CHART_WIDTH, CHART_HEIGHT));
    }
    const model = buildLineChart(request);
    for (const point of model.storedPoints) {
      assert.ok(point.x >= PLOT_LEFT && point.x <= PLOT_LEFT + PLOT_WIDTH, `${point.day} is plotted off the plot box`);
      assert.ok(point.y >= PLOT_TOP && point.y <= PLOT_TOP + PLOT_HEIGHT, `${point.day} is plotted off the plot box`);
    }
  }
});

test('no output string contains a score, a threshold or a directional verdict', () => {
  const banned = [
    'score', 'grade', 'rank', 'rating', 'threshold', 'verdict', 'anomaly', 'anomalous', 'outlier',
    'increase', 'increas', 'surg', 'surge', 'surging', 'declin', 'decreas', 'rising', 'rise', 'falling',
    'fell', 'drop', 'trend', 'trending', 'growth', 'adoption', 'popular', 'unhealthy', 'healthy',
    'healthy', 'impressive', 'concerning', 'good', 'bad', 'better', 'worse', 'above average', 'below average',
  ];
  const requests = [
    CONTIGUOUS,
    WITH_HOLE,
    { label: 'Views', observations: [], calendarDays: days('2026-03-01', '2026-03-03') },
    {
      label: 'Stars',
      observations: [
        { day: '2026-03-01', value: 8000 },
        { day: '2026-03-02', value: 8000 },
        { day: '2026-03-03', value: 7900 },
        { day: '2026-03-04', value: 8400 },
      ],
    },
    { label: 'Unique cloners', observations: [{ day: '2026-03-01', value: 3 }] },
  ];
  for (const request of requests) {
    const model = buildLineChart(request);
    const text = renderLineChart(request).replace(/<[^>]*>/g, ' ').toLowerCase();
    for (const word of banned) {
      assert.ok(!text.includes(word), `the chart says "${word}": ${model.summary}`);
    }
    // The same absence holds in the sentences a screen reader reads, before any tag
    // is stripped, and in the figure caption a sighted reader reads.
    const prose = `${model.summary} ${model.tableCaption}`.toLowerCase();
    for (const word of banned) {
      assert.ok(!prose.includes(word), `the chart prose says "${word}": ${model.summary} / ${model.tableCaption}`);
    }
  }
});

test('a malformed request is refused by name rather than plotted', () => {
  const stored = [{ day: '2026-03-01', value: 3 }];
  assert.throws(() => renderUnchecked({ observations: stored }), /label/);
  assert.throws(() => renderUnchecked({ label: '', observations: stored }), /label/);
  assert.throws(() => renderUnchecked({ label: 'Views' }), /observation array/);
  assert.throws(() => renderUnchecked({ label: 'Views', observations: {} }), /observation array/);
  assert.throws(() => renderUnchecked({ label: 'Views', observations: [null] }), /record with a day and a value/);
  assert.throws(() => renderUnchecked({ label: 'Views', observations: [{ day: '2026-03-01' }] }), /finite numeric value/);
  assert.throws(
    () => renderUnchecked({ label: 'Views', observations: [{ day: '2026-03-01', value: Number.NaN }] }),
    /finite numeric value/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Views', observations: [{ day: '2026-03-01', value: Number.POSITIVE_INFINITY }] }),
    /finite numeric value/,
  );
  assert.throws(() => renderUnchecked({ label: 'Views', observations: [{ day: '2026-02-30', value: 1 }] }), /real UTC calendar day/);
  assert.throws(() => renderUnchecked({ label: 'Views', observations: [{ day: '2026-03-01', value: -2 }] }), /negative value/);
  assert.throws(
    () => renderUnchecked({ label: 'Views', observations: [{ day: '2026-03-01', value: 1 }, { day: '2026-03-01', value: 2 }] }),
    /one day has one stored value/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Views', observations: [], calendarDays: ['2026-03-01', '2026-03-03'] }),
    /consecutive calendar days/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Views', observations: [], calendarDays: ['2026-03-01', '2026-03-01'] }),
    /twice/,
  );
  assert.throws(() => renderUnchecked({ label: 'Views', observations: [] }), /calendarDays window/);
  assert.throws(() => renderUnchecked({ label: 'Views', observations: stored, boundaryDay: '2026-13-01' }), /boundary day/);
  assert.throws(() => renderUnchecked({ label: 'Views', observations: stored, id: 'a b' }), /chart id/);
  assert.throws(() => renderUnchecked({ label: 'Views', observations: stored, valueLabel: '' }), /value label/);
  assert.throws(() => renderUnchecked(null), /request with a label/);
  assert.throws(() => renderUnchecked({ label: 'Views', observations: [], calendarDays: [] }), /non-empty array/);
  // A window handed over in another order is the same window, so it renders the same
  // bytes rather than being refused: the order a caller enumerates days in is not a
  // measurement.
  assert.equal(
    renderLineChart({ ...WITH_HOLE, calendarDays: [...(WITH_HOLE.calendarDays ?? [])].reverse() }),
    renderLineChart(WITH_HOLE),
  );
  // A day outside the window is not an error: the caller may hold a wider calendar
  // than the one it asked to draw, so the day is ignored rather than refused.
  const wider = renderLineChart({
    label: 'Views',
    observations: [{ day: '2026-03-02', value: 7 }],
    calendarDays: windowAround('2026-03-02', '2026-03-02', 1),
  });
  assert.equal(buildLineChart({
    label: 'Views',
    observations: [{ day: '2026-03-02', value: 7 }],
    calendarDays: windowAround('2026-03-02', '2026-03-02', 1),
  }).storedDays.length, 1);
  assert.equal(cellFor(wider, '2026-03-01'), GAP_CELL_TEXT);
});

test('a window supplied by the caller is used exactly as given, gaps at its edges included', () => {
  const model = buildLineChart({ label: 'Views', observations: [{ day: '2026-03-03', value: 9 }], calendarDays: days('2026-03-01', '2026-03-05') });
  assert.equal(model.rangeFrom, '2026-03-01');
  assert.equal(model.rangeTo, '2026-03-05');
  assert.equal(model.calendarDayCount, 5);
  assert.deepEqual(model.missingDays, ['2026-03-01', '2026-03-02', '2026-03-04', '2026-03-05']);
  assert.equal(model.rows.length, 5);
  // The lone stored day is centred against a window that holds four other days.
  assert.equal(model.storedPoints[0].dayIndex, 2);
  assert.equal(model.storedPoints[0].x, PLOT_LEFT + (2 / 4) * PLOT_WIDTH);
});

test('the svg fragment, the table and the figure are separately renderable from one model', () => {
  const model = buildLineChart(WITH_HOLE);
  const svg = renderLineChartSvg(model);
  const table = renderLineChartTable(model);
  assert.match(svg, /^<svg /);
  assert.ok(svg.endsWith('</svg>'));
  assert.match(table, /^<table /);
  assert.match(table, /<\/table>$/);
  assert.equal(renderLineChart(WITH_HOLE), `<figure class="chart" id="${model.id}-figure" `
    + `aria-labelledby="${model.id}-title">${svg}`
    + `<figcaption class="chart-caption" id="${model.id}-caption">${model.summary}</figcaption>${table}</figure>`);
});