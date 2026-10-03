import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CONNECTED, FIRST_COLLECTED_KIND, NOT_CONNECTED, readProvenance, stampFirstCollected } from '../src/backfill/provenance.js';
import { calendarDays, readDaySeries, upsertDayFact } from '../src/db/day-series-repo.js';
import { appendBackfillRecord, openArchive, upsertRepository } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';
import {
  BACKFILL_DASH_PATTERN,
  BACKFILL_SOURCE_TEXT,
  COLLECTED_SOURCE_TEXT,
  GAP_CELL_TEXT,
  LEGEND_ENTRIES,
  NO_SOURCE_TEXT,
  PLOT_HEIGHT,
  PLOT_LEFT,
  PLOT_TOP,
  PLOT_WIDTH,
  SOURCE_COLUMN_LABEL,
  UNRECORDED_SOURCE_TEXT,
  buildLineChart,
  renderLineChart,
} from '../src/views/components/line-chart.js';

const firstCollection = '2026-10-02T09:15:00.000Z';
const firstDay = '2026-10-02';
const moduleSource = readFileSync(new URL('../src/backfill/provenance.js', import.meta.url), 'utf8');
const chartSource = readFileSync(new URL('../src/views/components/line-chart.js', import.meta.url), 'utf8');

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-provenance-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'maintainer', name: 'archive',
    lastSeenAt: '2026-10-02T09:15:00.000Z', enrolled: 1 });
  return db;
}

/**
 * Record the two first-connect backfills so the read has real evidence to report.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function recordBackfills(db) {
  appendBackfillRecord(db, { repositoryId: 1, kind: 'stars', truncated: false,
    collectedAt: '2026-10-02T09:10:00.000Z' });
  appendBackfillRecord(db, { repositoryId: 1, kind: 'development', windowFrom: '2025-10-06',
    windowTo: '2026-09-28', truncated: true, collectedAt: '2026-10-02T09:12:00.000Z' });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
function countRows(db, table) {
  return db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
}

test('a repository with no collected data reports not-connected and no first collected day', async (t) => {
  const db = await fixture(t);
  recordBackfills(db);
  const provenance = readProvenance(db, 1, { today: firstDay });
  assert.equal(provenance.state, NOT_CONNECTED);
  assert.equal(provenance.firstCollectedDay, null);
  assert.equal(provenance.firstCollectedAt, null);
  assert.equal(provenance.connectedToday, false);
  assert.deepEqual(provenance.backfillKinds, ['development', 'stars']);
});

test('a repository with no records at all reports not-connected, no first day and no backfill', async (t) => {
  const db = await fixture(t);
  assert.deepEqual(readProvenance(db, 1, { today: firstDay }), {
    state: NOT_CONNECTED,
    firstCollectedDay: null,
    firstCollectedAt: null,
    connectedToday: false,
    backfillCompleted: false,
    backfillKinds: [],
    backfillCompletedAt: null,
    backfills: [],
  });
});

test('the first collection stamps the day once and a second call leaves the original day unchanged', async (t) => {
  const db = await fixture(t);
  recordBackfills(db);
  assert.deepEqual(stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection }),
    { day: firstDay, stamped: true });
  assert.deepEqual(readProvenance(db, 1, { today: firstDay }), {
    state: CONNECTED,
    firstCollectedDay: firstDay,
    firstCollectedAt: firstCollection,
    connectedToday: true,
    backfillCompleted: true,
    backfillKinds: ['development', 'stars'],
    backfillCompletedAt: '2026-10-02T09:12:00.000Z',
    backfills: [
      { kind: 'development', windowFrom: '2025-10-06', windowTo: '2026-09-28', truncated: true,
        collectedAt: '2026-10-02T09:12:00.000Z' },
      { kind: 'stars', windowFrom: null, windowTo: null, truncated: false,
        collectedAt: '2026-10-02T09:10:00.000Z' },
    ],
  });

  assert.deepEqual(stampFirstCollected(db, 1, { day: '2026-10-09', collectedAt: '2026-10-09T09:15:00.000Z' }),
    { day: firstDay, stamped: false });
  const after = readProvenance(db, 1, { today: firstDay });
  assert.equal(after.firstCollectedDay, firstDay);
  assert.equal(after.firstCollectedAt, firstCollection);
  assert.deepEqual(after.backfillKinds, ['development', 'stars']);
  assert.equal(countRows(db, 'backfill_records'), 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM backfill_records WHERE kind=?')
    .get(FIRST_COLLECTED_KIND)?.n, 1);
  const stamp = db.prepare('SELECT window_from AS dayFrom, window_to AS dayTo, collected_at AS collectedAt FROM backfill_records WHERE kind=?')
    .get(FIRST_COLLECTED_KIND);
  assert.deepEqual({ ...stamp }, { dayFrom: firstDay, dayTo: firstDay, collectedAt: firstCollection });
});

test('the stamped boundary cannot be rewritten or removed by a later run', async (t) => {
  const db = await fixture(t);
  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  assert.throws(() => db.prepare('UPDATE backfill_records SET window_from=? WHERE kind=?')
    .run('2020-01-01', FIRST_COLLECTED_KIND), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM backfill_records WHERE kind=?').run(FIRST_COLLECTED_KIND),
    /cannot be deleted/);
  assert.equal(readProvenance(db, 1, { today: firstDay }).firstCollectedDay, firstDay);
});

test('a repository whose first collected day is today is reported as connected today', async (t) => {
  const db = await fixture(t);
  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  const sameDay = readProvenance(db, 1, { today: firstDay });
  assert.equal(sameDay.state, CONNECTED);
  assert.equal(sameDay.connectedToday, true);
  assert.equal(sameDay.firstCollectedDay, firstDay);
  const laterDay = readProvenance(db, 1, { today: '2026-10-09' });
  assert.equal(laterDay.state, CONNECTED);
  assert.equal(laterDay.connectedToday, false);
  assert.equal(laterDay.firstCollectedDay, firstDay);
});

test('a boundary from an earlier day is not today without an injected reference day', async (t) => {
  const db = await fixture(t);
  stampFirstCollected(db, 1, { day: '2024-03-01', collectedAt: '2024-03-01T09:15:00.000Z' });
  const provenance = readProvenance(db, 1);
  assert.equal(provenance.state, CONNECTED);
  assert.equal(provenance.firstCollectedDay, '2024-03-01');
  assert.equal(provenance.connectedToday, false);
});

test('the provenance read lists which backfill kinds have completed', async (t) => {
  const db = await fixture(t);
  recordBackfills(db);
  appendBackfillRecord(db, { repositoryId: 1, kind: 'stars', windowFrom: '2019-01-02',
    windowTo: '2026-10-02', truncated: false, collectedAt: '2026-10-02T09:14:00.000Z' });
  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  const provenance = readProvenance(db, 1, { today: firstDay });
  assert.equal(provenance.backfillCompleted, true);
  assert.deepEqual(provenance.backfillKinds, ['development', 'stars']);
  assert.equal(provenance.backfillCompletedAt, '2026-10-02T09:14:00.000Z');
  assert.deepEqual(provenance.backfills.map((backfill) => [backfill.kind, backfill.windowFrom,
    backfill.windowTo, backfill.truncated]), [
    ['development', '2025-10-06', '2026-09-28', true],
    ['stars', '2019-01-02', '2026-10-02', false],
  ]);
  assert.equal(provenance.backfillKinds.includes(FIRST_COLLECTED_KIND), false);
});

test('the first collected day comes from the stamp and never from a stored metric row', async (t) => {
  const db = await fixture(t);
  // A backfilled star curve and a collected traffic window that both predate any stamp.
  for (const day of ['2019-04-01', '2019-04-03']) {
    upsertDayFact(db, { repositoryId: 1, metric: 'stars', granularity: /** @type {const} */ ('day'),
      day, value: 12, source: /** @type {const} */ ('backfill'), collectedAt: '2026-10-02T09:10:00.000Z' });
  }
  for (const metric of ['clones', 'views']) {
    upsertDayFact(db, { repositoryId: 1, metric, granularity: /** @type {const} */ ('day'),
      day: '2026-09-20', value: 3, source: /** @type {const} */ ('collected'), collectedAt: firstCollection });
  }
  const uncollected = readProvenance(db, 1, { today: firstDay });
  assert.equal(uncollected.state, NOT_CONNECTED);
  assert.equal(uncollected.firstCollectedDay, null);

  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  const collected = readProvenance(db, 1, { today: firstDay });
  assert.equal(collected.firstCollectedDay, firstDay);
  assert.equal(collected.connectedToday, true);
  assert.equal(moduleSource.includes('day_series'), false);
});

test('provenance records facts only: no metric rows, no snapshots and no view import', async (t) => {
  const db = await fixture(t);
  recordBackfills(db);
  stampFirstCollected(db, 1, { day: firstDay, collectedAt: firstCollection });
  const before = readProvenance(db, 1, { today: firstDay });
  assert.equal(countRows(db, 'day_series'), 0);
  assert.equal(countRows(db, 'snapshots'), 0);
  assert.deepEqual(readProvenance(db, 1, { today: firstDay }), before);
  for (const forbidden of ['server/', 'views/', 'node:fs', 'node:http']) {
    assert.equal(moduleSource.includes(forbidden), false, `provenance must not import ${forbidden}`);
  }
  assert.equal(moduleSource.includes('clones'), false);
  assert.equal(moduleSource.includes('views'), false);
});

test('an invalid boundary or an unknown repository is rejected instead of recorded', async (t) => {
  const db = await fixture(t);
  for (const day of ['2026-02-30', '2026-10-2', '2026-10-02T00:00:00.000Z', '', 'tomorrow']) {
    assert.throws(() => stampFirstCollected(db, 1, { day, collectedAt: firstCollection }),
      /Invalid boundary day/, `day ${JSON.stringify(day)} must be refused`);
  }
  assert.throws(() => stampFirstCollected(db, 1, { day: firstDay, collectedAt: '2026-10-02 09:15' }),
    /Invalid collection timestamp/);
  assert.throws(() => stampFirstCollected(db, 404, { day: firstDay, collectedAt: firstCollection }),
    /Unknown repository 404/);
  assert.throws(() => readProvenance(db, 404), /Unknown repository 404/);
  assert.throws(() => readProvenance(db, 1, { today: 'not-a-day' }), /Invalid boundary day/);
  assert.equal(countRows(db, 'backfill_records'), 0);
  assert.equal(readProvenance(db, 1, { today: firstDay }).state, NOT_CONNECTED);
});

// ---------------------------------------------------------------------------
// RS-VIZ-05: the chart annotates itself from the provenance read.
//
// The cases below are the three the task names - a connected repository, a
// repository the archive records as never collected, and a repository whose
// backfill predates its first collected day - and every one of them reads the
// archive rather than hand-building a provenance record, so a change to the read
// that invalidates a rendering assertion shows up here as a failing test.
// ---------------------------------------------------------------------------

const boundary = '2026-10-01';
const windowFrom = '2026-09-28';
const windowTo = '2026-10-04';
const backfillAt = '2026-10-01T09:00:00.000Z';
const collectionAt = '2026-10-01T09:30:00.000Z';

/**
 * A connected repository's stored days: two backfilled days written before the
 * first collection stamped the boundary, then three collected days. 2026-09-30 is
 * absent from the archive entirely, so the window covers it as a gap and the day
 * after the last stored day is one too.
 *
 * @type {readonly (readonly [string, number, 'backfill'|'collected'])[]}
 */
const CONNECTED_DAYS = [
  ['2026-09-28', 4, 'backfill'],
  ['2026-09-29', 6, 'backfill'],
  ['2026-10-01', 7, 'collected'],
  ['2026-10-02', 9, 'collected'],
  ['2026-10-03', 5, 'collected'],
];

/**
 * A repository connected for the first time: its star curve was reconstructed on
 * connect, and no run has ever collected anything for it.
 *
 * @type {readonly (readonly [string, number, 'backfill'|'collected'])[]}
 */
const NEVER_COLLECTED_DAYS = [
  ['2026-09-28', 40, 'backfill'],
  ['2026-09-30', 41, 'backfill'],
];

/**
 * Stars reconstructed on first connect, spanning the window and crossing the
 * boundary the same day: a backfilled day may sit on or after it, which is why the
 * drawn treatment follows each day's recorded source and not its position alone.
 *
 * @type {readonly (readonly [string, number, 'backfill'|'collected'])[]}
 */
const BACKFILL_PREDATES_BOUNDARY = [
  ['2026-09-28', 40, 'backfill'],
  ['2026-09-29', 41, 'backfill'],
  ['2026-09-30', 41, 'backfill'],
  ['2026-10-01', 42, 'backfill'],
  ['2026-10-02', 42, 'collected'],
  ['2026-10-03', 43, 'collected'],
];

/**
 * Write stored days for repository 1, with the collection time the source implies.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly (readonly [string, number, 'backfill'|'collected'])[]} days
 * @param {string} [metric]
 */
function seedDays(db, days, metric = 'clones') {
  for (const [day, value, source] of days) {
    upsertDayFact(db, {
      repositoryId: 1,
      metric,
      granularity: 'day',
      day,
      value,
      source,
      collectedAt: source === 'backfill' ? backfillAt : collectionAt,
    });
  }
}

/**
 * A chart request built the way a page builds one: the archive's own range read for
 * the stored days, its own calendar for the window, and its own provenance read for
 * the boundary. Nothing here hand-builds a provenance record.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {readonly (readonly [string, number, 'backfill'|'collected'])[]} days
 * @param {string} metric
 * @returns {import('../src/views/components/line-chart.js').LineChartRequest}
 */
function pageChartRequest(db, days, metric) {
  const [firstDay_ = windowFrom] = days[0] ?? [];
  const lastDay_ = days[days.length - 1]?.[0] ?? windowFrom;
  return {
    label: metric === 'stars' ? 'Stars' : 'Clones',
    valueLabel: metric === 'stars' ? 'Stars' : 'Clones',
    calendarDays: calendarDays(windowFrom, windowTo),
    observations: readDaySeries(db, {
      repositoryId: 1, metric, granularity: 'day', from: firstDay_, to: lastDay_,
    }),
    provenance: readProvenance(db, 1, { today: windowTo }),
  };
}

/**
 * Every element of a kind in the markup, as `{ attributes, body }`.
 * @param {string} markup
 * @param {string} tag
 * @returns {{attributes: Record<string, string>, body: string}[]}
 */
function chartElements(markup, tag) {
  /** @type {{attributes: Record<string, string>, body: string}[]} */
  const found = [];
  for (const match of markup.matchAll(new RegExp(`<${tag}\\b([^>]*?)(/?)>`, 'g'))) {
    /** @type {Record<string, string>} */
    const attributes = {};
    for (const [, name, value] of match[1].matchAll(/([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)) {
      if (name !== undefined && value !== undefined) attributes[name] = value;
    }
    found.push({ attributes, body: match[2] ?? '' });
  }
  return found;
}

/**
 * Elements of a kind carrying a class, which is how the figure's groups are found
 * without depending on their position.
 * @param {string} markup
 * @param {string} tag
 * @param {string} className
 * @returns {{attributes: Record<string, string>, body: string}[]}
 */
function elementsWithClass(markup, tag, className) {
  return chartElements(markup, tag).filter((found) => found.attributes.class === className);
}

/**
 * The text of one element, tags excluded.
 * @param {string} markup
 * @param {string} tag
 * @returns {string}
 */
function textOf(markup, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(markup);
  return (match?.[1] ?? '').replace(/<[^>]*>/g, '');
}

/**
 * Every row of the paired table as `{ day, text, gap, sourceText }`, with
 * `sourceText` null when the table carries no provenance column.
 * @param {string} markup
 * @returns {{day: string, text: string, gap: boolean, sourceText: string|null}[]}
 */
function chartTableRows(markup) {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(markup)?.[1] ?? '';
  return [...body.matchAll(/<tr class="([^"]*)">([\s\S]*?)<\/tr>/g)].map((match) => {
    const cells = match[2] ?? '';
    const values = [...cells.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cell) => cell[1] ?? '');
    return {
      day: /<th scope="row">([^<]*)<\/th>/.exec(cells)?.[1] ?? '',
      text: values[0] ?? '',
      gap: (match[1] ?? '').includes('chart-row-gap'),
      sourceText: values.length > 1 ? values[1] : null,
    };
  });
}

/**
 * The legend entries as `{ source, label, dashed }`, the dash being the swatch the
 * entry draws beside its own words.
 * @param {string} markup
 * @returns {{source: string, label: string, dashed: boolean}[]}
 */
function legendEntries(markup) {
  const list = /<ul class="chart-legend"[^>]*>([\s\S]*?)<\/ul>/.exec(markup);
  if (list === null) return [];
  return [...(list[1] ?? '').matchAll(/<li class="chart-legend-entry" data-source="([^"]*)">([\s\S]*?)<\/li>/g)]
    .map((match) => ({
      source: match[1] ?? '',
      label: (/<span class="chart-legend-label">([\s\S]*?)<\/span>/.exec(match[2] ?? '')?.[1] ?? ''),
      dashed: (match[2] ?? '').includes('stroke-dasharray'),
    }));
}

/**
 * Every day an inclusive range covers, oldest first.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function daysBetween(from, to) {
  /** @type {string[]} */
  const listed = [];
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`);
    time += 86_400_000) {
    listed.push(new Date(time).toISOString().slice(0, 10));
  }
  return listed;
}

/**
 * Render a request the type checker cannot know is malformed, so a test can assert
 * that the module refuses it by name instead of drawing around it.
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

/** Words no sentence of this feature may contain: a score, a verdict or a direction. */
const VERDICT_WORDS = [
  'score', 'grade', 'rank', 'rating', 'threshold', 'verdict', 'anomaly', 'anomalous', 'outlier',
  'increase', 'increas', 'surg', 'surge', 'surging', 'declin', 'decreas', 'rising', 'rise',
  'falling', 'fell', 'drop', 'trend', 'trending', 'growth', 'adoption', 'impressive', 'concerning',
  'healthy', 'unhealthy', 'better', 'worse', 'above average', 'below average',
];

test('a connected repository renders one boundary marker positioned at the first collected day', async (t) => {
  const db = await fixture(t);
  seedDays(db, CONNECTED_DAYS);
  stampFirstCollected(db, 1, { day: boundary, collectedAt: collectionAt });

  const request = pageChartRequest(db, CONNECTED_DAYS, 'clones');
  assert.equal(request.provenance?.state, CONNECTED, 'the chart is annotated from the archive\'s own read');
  assert.equal(request.provenance?.firstCollectedDay, boundary);

  const model = buildLineChart(request);
  const markup = renderLineChart(request);
  assert.equal(model.boundaryDay, boundary);
  assert.equal(model.boundaryInWindow, true);
  assert.equal(model.provenanceState, CONNECTED);

  const markers = elementsWithClass(markup, 'g', 'chart-boundary');
  assert.equal(markers.length, 1, 'exactly one boundary marker however often the day is named');
  assert.equal(markers[0].attributes['data-day'], boundary);

  const rules = elementsWithClass(markup, 'line', 'chart-boundary-line');
  assert.equal(rules.length, 1, 'the marker is one vertical rule');
  assert.equal(rules[0].attributes.x1, rules[0].attributes.x2, 'a vertical rule has one x');
  assert.equal(Number(rules[0].attributes.x1), model.boundaryX);
  assert.equal(rules[0].attributes.y1, String(PLOT_TOP));
  assert.equal(Number(rules[0].attributes.y2), PLOT_TOP + PLOT_HEIGHT, 'the rule spans the plot box');

  // The position is the first collected day's own coordinate, not the window start
  // and not the earliest stored day: the whole claim of the marker is its position.
  const point = model.storedPoints.find((stored) => stored.day === boundary);
  assert.ok(point !== undefined, 'the boundary day carries a stored value in this fixture');
  assert.equal(Number(rules[0].attributes.x1), point.x);
  assert.notEqual(Number(rules[0].attributes.x1), PLOT_LEFT, 'the window start is a different day here');
  // It stands between the last backfilled day and the first collected one, which is
  // the whole claim the marker makes about where the evidence changes kind.
  const lastBefore = model.storedPoints.at(-1)?.day;
  assert.equal(lastBefore, '2026-10-03');
  const before = model.storedPoints.filter((stored) => stored.day < boundary);
  const after = model.storedPoints.filter((stored) => stored.day > boundary);
  assert.ok(before.length > 0 && after.length > 0, 'the fixture has days either side of the boundary');
  assert.ok(Number(rules[0].attributes.x1) > (before[before.length - 1]?.x ?? 0));
  assert.ok(Number(rules[0].attributes.x1) < (after[0]?.x ?? 0));

  // And the boundary is stated in the text a reader reaches, not only as a line.
  const described = textOf(markup, 'desc');
  assert.match(described, new RegExp(`First collected day: ${boundary}\\.`));
  assert.match(described, new RegExp(`The vertical marker sits on ${boundary}`));
  assert.match(textOf(markup, 'figcaption'), new RegExp(`The vertical marker sits on ${boundary}`));
  // The bottom axis names the same day, which is the label a sighted reader reads.
  assert.deepEqual(
    elementsWithClass(markup, 'g', 'chart-day-tick')
      .map((tick) => tick.attributes['data-day']),
    [windowFrom, boundary, windowTo],
  );

  // A boundary at either end of the window still yields exactly one marker, at that
  // day's own coordinate: the first day sits on the left edge of the plot and the
  // last on its right.
  const backfilled = [
    { day: windowFrom, value: 4, source: /** @type {const} */ ('backfill') },
    { day: '2026-09-29', value: 5, source: /** @type {const} */ ('backfill') },
  ];
  /** @type {[string, number][]} */
  const edges = [[windowFrom, PLOT_LEFT], [windowTo, PLOT_LEFT + PLOT_WIDTH]];
  for (const [edge, expectedX] of edges) {
    const at = { ...request, observations: backfilled,
      provenance: { state: CONNECTED, firstCollectedDay: edge } };
    const drawn = elementsWithClass(renderLineChart(at), 'g', 'chart-boundary');
    assert.equal(drawn.length, 1, `the boundary on ${edge} is drawn once`);
    assert.equal(drawn[0].attributes['data-day'], edge);
    assert.equal(buildLineChart(at).boundaryX, expectedX, `the marker on ${edge} sits at its own x`);
    assert.equal(Number(elementsWithClass(renderLineChart(at), 'line', 'chart-boundary-line')[0].attributes.x1),
      expectedX);
  }
});

test('backfilled days carry a treatment of their own and the legend names both kinds', async (t) => {
  const db = await fixture(t);
  seedDays(db, CONNECTED_DAYS);
  stampFirstCollected(db, 1, { day: boundary, collectedAt: collectionAt });

  const request = pageChartRequest(db, CONNECTED_DAYS, 'clones');
  const model = buildLineChart(request);
  const markup = renderLineChart(request);

  // One run per treatment, so no element wears a dash its own days do not have.
  const lines = chartElements(markup, 'polyline');
  assert.equal(lines.length, 2, 'a backfilled stretch and a collected stretch are two elements');
  assert.deepEqual(
    lines.map((line) => [line.attributes['data-from'], line.attributes['data-to'], line.attributes['data-dash']]),
    [['2026-09-28', '2026-09-29', 'dashed'], ['2026-10-01', '2026-10-03', undefined]],
  );
  for (const line of lines) {
    const span = daysBetween(line.attributes['data-from'], line.attributes['data-to']);
    const dashed = line.attributes['stroke-dasharray'] !== undefined;
    assert.equal(
      dashed,
      span.every((day) => day < boundary),
      `a line mixes the two treatments: ${line.attributes['data-from']} to ${line.attributes['data-to']}`,
    );
  }
  assert.equal(lines[0].attributes['stroke-dasharray'], BACKFILL_DASH_PATTERN);
  assert.equal(lines[1].attributes['stroke-dasharray'], undefined, 'a collected run carries no dash');

  // The distinction is a dash, not a hue: every stroke takes its colour from the
  // stylesheet and no colour literal appears anywhere in the annotated output.
  const strokes = [...markup.matchAll(/stroke="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(strokes.length > 0);
  assert.deepEqual([...new Set(strokes)], ['currentColor']);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(markup), 'a hex colour literal reached the markup');
  assert.ok(!/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/.test(markup), 'a colour function reached the markup');

  // The legend has exactly the two entries the feature names, each naming its own
  // treatment in words as well as drawing it.
  const entries = legendEntries(markup);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.source), ['backfill', 'collected']);
  assert.deepEqual(entries, LEGEND_ENTRIES.map((entry) => ({
    source: entry.key, label: entry.text, dashed: entry.dashed,
  })));
  assert.match(entries[0].label, new RegExp(`^${BACKFILL_SOURCE_TEXT}:`));
  assert.match(entries[0].label, /dashed/);
  assert.match(entries[1].label, new RegExp(`^${COLLECTED_SOURCE_TEXT}:`));
  assert.match(entries[1].label, /solid/);
  assert.equal(entries[0].dashed, true, 'the backfilled swatch is dashed');
  assert.equal(entries[1].dashed, false, 'the collected swatch is solid');

  // And the text half of the treatment: a provenance column naming every day.
  assert.match(markup, new RegExp(`<th scope="col">${SOURCE_COLUMN_LABEL}</th>`));
  assert.deepEqual(
    chartTableRows(markup).map((row) => [row.day, row.sourceText]),
    [
      ['2026-09-28', BACKFILL_SOURCE_TEXT],
      ['2026-09-29', BACKFILL_SOURCE_TEXT],
      ['2026-09-30', NO_SOURCE_TEXT],
      ['2026-10-01', COLLECTED_SOURCE_TEXT],
      ['2026-10-02', COLLECTED_SOURCE_TEXT],
      ['2026-10-03', COLLECTED_SOURCE_TEXT],
      ['2026-10-04', NO_SOURCE_TEXT],
    ],
  );
  assert.deepEqual(model.backfilledDays, ['2026-09-28', '2026-09-29']);
  assert.deepEqual(model.collectedDays, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(model.unrecordedSourceDays, []);
});

test('a lone backfilled day is a hollow dashed marker and a lone collected day is filled', async (t) => {
  const db = await fixture(t);
  seedDays(db, [['2026-09-28', 4, 'backfill']], 'stars');
  stampFirstCollected(db, 1, { day: '2026-09-29', collectedAt: collectionAt });
  const backfilledOnly = renderLineChart(pageChartRequest(db, [['2026-09-28', 4, 'backfill']], 'stars'));
  const marker = chartElements(backfilledOnly, 'circle');
  assert.equal(marker.length, 1);
  assert.equal(marker[0].attributes['data-dash'], 'dashed');
  assert.equal(marker[0].attributes.fill, 'none', 'a backfilled day is hollow, so the dash is visible');
  assert.equal(marker[0].attributes['stroke-dasharray'], BACKFILL_DASH_PATTERN);

  seedDays(db, [['2026-09-29', 6, 'collected']], 'views');
  const collectedOnly = renderLineChart({
    label: 'Views',
    valueLabel: 'Views',
    calendarDays: calendarDays('2026-09-29', '2026-10-04'),
    observations: readDaySeries(db, { repositoryId: 1, metric: 'views', granularity: 'day',
      from: '2026-09-29', to: '2026-09-29' }),
    provenance: readProvenance(db, 1, { today: windowTo }),
  });
  const filled = chartElements(collectedOnly, 'circle');
  assert.equal(filled.length, 1);
  assert.equal(filled[0].attributes['data-dash'], undefined);
  assert.equal(filled[0].attributes.fill, 'currentColor');
  assert.equal(filled[0].attributes['stroke-dasharray'], undefined);
});

test('a repository the archive records as never collected renders the first-connect caption and no marker', async (t) => {
  const db = await fixture(t);
  seedDays(db, NEVER_COLLECTED_DAYS, 'stars');
  // No stamp: nothing has ever been collected for this repository.
  const request = pageChartRequest(db, NEVER_COLLECTED_DAYS, 'stars');
  assert.equal(request.provenance?.state, NOT_CONNECTED);
  assert.equal(request.provenance?.firstCollectedDay, null);

  const model = buildLineChart(request);
  const markup = renderLineChart(request);
  assert.equal(model.provenanceState, NOT_CONNECTED);
  assert.equal(model.boundaryDay, null);
  assert.equal(model.boundaryInWindow, false);
  assert.equal(model.boundaryX, null);

  // No marker of any kind: a rule at the window start would claim a collection.
  assert.equal(elementsWithClass(markup, 'g', 'chart-boundary').length, 0);
  assert.equal(elementsWithClass(markup, 'line', 'chart-boundary-line').length, 0);
  assert.ok(!markup.includes('chart-boundary'), 'no boundary element reaches the markup');
  assert.ok(!/First collected day/.test(markup), 'no first collected day is named when none is recorded');
  assert.ok(!/collected from/.test(markup), 'the bottom axis names no boundary either');

  // The first-connect caption says the state in words, in the sentences a screen
  // reader reaches and the ones a sighted reader reads under the chart.
  const caption = textOf(markup, 'figcaption');
  assert.match(caption, /No collection has been recorded for this repository, so there is no first collected day to mark\./);
  assert.match(caption, /reconstructed on first connect, so this window is the span since connection rather than the repository's history\./);
  assert.match(caption, /2 stored days are backfilled and 0 are collected\./);
  assert.match(textOf(markup, 'desc'), /No collection has been recorded for this repository/);
  assert.match(textOf(markup, 'caption'), /No collection has been recorded for this repository/);

  // The backfilled days are still labelled, so the caption does not lose what the
  // picture shows: two dashed single-day markers of a star curve, named in the table.
  assert.deepEqual(model.backfilledDays, ['2026-09-28', '2026-09-30']);
  assert.deepEqual(legendEntries(markup).map((entry) => entry.source), ['backfill', 'collected']);
  assert.deepEqual(
    chartTableRows(markup).map((row) => [row.day, row.sourceText]),
    [
      ['2026-09-28', BACKFILL_SOURCE_TEXT],
      ['2026-09-29', NO_SOURCE_TEXT],
      ['2026-09-30', BACKFILL_SOURCE_TEXT],
      ['2026-10-01', NO_SOURCE_TEXT],
      ['2026-10-02', NO_SOURCE_TEXT],
      ['2026-10-03', NO_SOURCE_TEXT],
      ['2026-10-04', NO_SOURCE_TEXT],
    ],
  );

  // A never-collected repository with nothing stored at all still says so in words
  // rather than drawing an empty chart that looks like a measurement.
  const empty = renderLineChart({
    label: 'Stars',
    valueLabel: 'Stars',
    calendarDays: calendarDays(windowFrom, windowTo),
    observations: [],
    provenance: readProvenance(db, 1, { today: windowTo }),
  });
  assert.equal(empty.includes('<svg'), false, 'no axes-only figure');
  assert.match(textOf(empty, 'figcaption'), /No collection has been recorded for this repository/);
});

test("a repository whose backfill predates its first collected day labels both sides of the boundary", async (t) => {
  const db = await fixture(t);
  // Stars reconstructed on connect across the whole window, including the day the
  // first collection stamped: a backfilled day may sit after the boundary too, which
  // is why the treatment follows the recorded source and not the position alone.
  seedDays(db, BACKFILL_PREDATES_BOUNDARY, 'stars');
  stampFirstCollected(db, 1, { day: boundary, collectedAt: collectionAt });

  const request = pageChartRequest(db, BACKFILL_PREDATES_BOUNDARY, 'stars');
  const model = buildLineChart(request);
  const markup = renderLineChart(request);
  assert.deepEqual(model.preBoundaryStoredDays, ['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.deepEqual(model.backfilledDays, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
  assert.deepEqual(model.collectedDays, ['2026-10-02', '2026-10-03']);

  const lines = chartElements(markup, 'polyline');
  assert.deepEqual(
    lines.map((line) => [line.attributes['data-from'], line.attributes['data-to'], line.attributes['data-dash']]),
    [['2026-09-28', '2026-10-01', 'dashed'], ['2026-10-02', '2026-10-03', undefined]],
  );
  // The boundary day itself is backfilled and drawn as such, beside the marker.
  assert.equal(elementsWithClass(markup, 'g', 'chart-boundary')[0].attributes['data-day'], boundary);
  assert.equal(model.rows.find((row) => row.day === boundary)?.sourceText, BACKFILL_SOURCE_TEXT);

  const caption = textOf(markup, 'figcaption');
  assert.match(caption, new RegExp(
    `The 3 stored days from 2026-09-28 to 2026-09-30 before ${boundary} are backfilled: `
    + `reconstructed on first connect, so the window before ${boundary} is the span since connection `
    + "rather than the repository's history\\.",
  ));
  assert.match(caption, /4 stored days are backfilled and 2 are collected\./);
  // No sentence claims a pre-boundary day was measured.
  for (const claim of ['measured before', 'collected before', 'was collected on 2026-09-28', 'history since']) {
    assert.ok(!caption.includes(claim), `the caption claims "${claim}": ${caption}`);
  }
});

test('the table text names every gap day and carries the provenance caption', async (t) => {
  const db = await fixture(t);
  seedDays(db, CONNECTED_DAYS);
  stampFirstCollected(db, 1, { day: boundary, collectedAt: collectionAt });
  const connected = renderLineChart(pageChartRequest(db, CONNECTED_DAYS, 'clones'));
  const rows = chartTableRows(connected);

  // One row per calendar day, stored or not: the window's two gaps are named days
  // rather than omissions a screen reader would read as zero days.
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.filter((row) => row.gap).map((row) => row.day), ['2026-09-30', '2026-10-04']);
  for (const row of rows.filter((entry) => entry.gap)) {
    assert.equal(row.text, GAP_CELL_TEXT);
    assert.ok(!/\d/.test(row.text), 'a gap row carries no number');
  }
  assert.match(textOf(connected, 'figcaption'), /No stored value for 2026-09-30 and 2026-10-04: 2 days are unmeasured, not zero\./);
  assert.match(textOf(connected, 'figcaption'), /A day with no stored value was never measured, and an unmeasured day is not a small number\./);

  // The provenance caption rides in the table's caption, which the chart points
  // `aria-describedby` at: the boundary claim reaches assistive technology even
  // though the marker and the legend are the parts a reader sees.
  const svg = chartElements(connected, 'svg')[0];
  assert.ok(svg !== undefined);
  assert.match(svg.attributes['aria-describedby'] ?? '', /chart-clones-table-caption/);
  const tableCaption = textOf(connected, 'caption');
  assert.match(tableCaption, new RegExp(`The vertical marker sits on ${boundary}`));
  assert.match(tableCaption, /reconstructed on first connect/);
  assert.match(tableCaption, /every other row is a gap and holds no stored value, not zero\./);

  // The same for the first-connect case: the caption a never-collected repository
  // gets is in its table's text, not only under the chart.
  const neverDb = await fixture(t);
  seedDays(neverDb, NEVER_COLLECTED_DAYS, 'stars');
  const never = renderLineChart(pageChartRequest(neverDb, NEVER_COLLECTED_DAYS, 'stars'));
  assert.match(textOf(never, 'caption'), /No collection has been recorded for this repository/);
  assert.match(textOf(never, 'caption'), /span since connection rather than the repository's history\./);
  assert.deepEqual(chartTableRows(never).filter((row) => row.gap).map((row) => row.day),
    ['2026-09-29', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
});

test('no day before the boundary is drawn as a collected reading', async (t) => {
  const db = await fixture(t);
  seedDays(db, CONNECTED_DAYS);
  stampFirstCollected(db, 1, { day: boundary, collectedAt: collectionAt });
  const model = buildLineChart(pageChartRequest(db, CONNECTED_DAYS, 'clones'));
  const markup = renderLineChart(pageChartRequest(db, CONNECTED_DAYS, 'clones'));

  for (const day of model.preBoundaryStoredDays) {
    const row = model.rows.find((entry) => entry.day === day);
    assert.ok(row !== undefined);
    assert.equal(row.dashed, true, `${day} precedes the boundary and must not be drawn solid`);
    assert.equal(row.source, 'backfill');
  }
  // Every drawn element holding a pre-boundary day is dashed, marker runs included.
  for (const found of [...chartElements(markup, 'polyline'), ...chartElements(markup, 'circle')]) {
    const span = daysBetween(found.attributes['data-from'] ?? found.attributes['data-day'] ?? '',
      found.attributes['data-to'] ?? found.attributes['data-day'] ?? '');
    const dashed = found.attributes['stroke-dasharray'] !== undefined;
    assert.equal(dashed, span.every((day) => day < boundary),
      `a ${dashed ? 'dashed' : 'solid'} element holds days on both sides of the boundary`);
  }

  // A day before the boundary whose own source the archive never recorded is drawn
  // dashed too: nothing before the boundary was collected, so drawing it solid would
  // be drawing it as though it had been.
  const unrecorded = {
    label: 'Clones',
    calendarDays: calendarDays(windowFrom, windowTo),
    observations: [
      { day: '2026-09-28', value: 4 },
      { day: '2026-09-29', value: 5 },
      { day: '2026-10-02', value: 6, source: /** @type {const} */ ('collected') },
    ],
    provenance: readProvenance(db, 1, { today: windowTo }),
  };
  const unrecordedModel = buildLineChart(unrecorded);
  assert.deepEqual(unrecordedModel.preBoundaryStoredDays, ['2026-09-28', '2026-09-29']);
  assert.deepEqual(unrecordedModel.unrecordedSourceDays, ['2026-09-28', '2026-09-29']);
  const unrecordedMarkup = renderLineChart(unrecorded);
  const unrecordedLines = chartElements(unrecordedMarkup, 'polyline');
  assert.equal(unrecordedLines.length, 1, 'the two source-less days are contiguous');
  assert.equal(unrecordedLines[0].attributes['stroke-dasharray'], BACKFILL_DASH_PATTERN,
    'a day before the boundary is dashed whether or not its own source was recorded');
  assert.equal(chartElements(unrecordedMarkup, 'circle')[0].attributes['stroke-dasharray'], undefined);
  assert.equal(unrecordedModel.rows.find((row) => row.day === '2026-09-28')?.sourceText, UNRECORDED_SOURCE_TEXT);
  // The caption names those days as falling before the boundary rather than calling
  // them backfilled: the archive recorded no source for them.
  assert.match(textOf(unrecordedMarkup, 'figcaption'),
    /The 2 stored days from 2026-09-28 to 2026-09-29 fall before 2026-10-01, the first collected day: reconstructed on first connect, so the window before 2026-10-01 is the span since connection rather than the repository's history\./);
  assert.ok(!/stored days from 2026-09-28 to 2026-09-29 before 2026-10-01 are backfilled/
    .test(textOf(unrecordedMarkup, 'figcaption')), 'a day with no recorded source is not called backfilled');

  // A day recorded as collected before the boundary is a contradiction the archive's
  // writers cannot produce, and it is refused by name rather than drawn around.
  assert.throws(
    () => renderUnchecked({
      label: 'Clones',
      observations: [{ day: '2026-09-28', value: 4, source: 'collected' }],
      boundaryDay: boundary,
    }),
    /recorded as collected but falls before the first collected day 2026-10-01/,
  );
  assert.throws(
    () => renderUnchecked({
      label: 'Clones',
      observations: [{ day: '2026-09-28', value: 4, source: 'estimated' }],
      boundaryDay: boundary,
    }),
    /the archive records a day as either backfill or collected/,
  );
  // A collected day for a repository the read reports as never collected is refused
  // too, so the first-connect caption's claim that every stored day was
  // reconstructed is supported by the evidence rather than assumed.
  assert.throws(
    () => renderUnchecked({
      label: 'Stars',
      observations: [{ day: '2026-09-28', value: 4, source: 'collected' }],
      calendarDays: calendarDays('2026-09-28', '2026-09-29'),
      provenance: { state: 'not-connected', firstCollectedDay: null },
    }),
    /recorded as collected for a repository the archive records as never collected/,
  );
});

test('the recorded read is the only route to a boundary, and a contradictory one is refused', async (t) => {
  const db = await fixture(t);
  const stored = [{ day: '2026-09-28', value: 4, source: /** @type {const} */ ('backfill') }];
  const window = calendarDays('2026-09-28', '2026-10-04');
  assert.throws(
    () => renderUnchecked({ label: 'Clones', observations: stored, calendarDays: window,
      provenance: { state: 'connected', firstCollectedDay: null } }),
    /reporting connected carries the first collected day/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Clones', observations: stored, calendarDays: window,
      provenance: { state: 'not-connected', firstCollectedDay: boundary } }),
    /reporting not-connected carries no first collected day/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Clones', observations: stored, calendarDays: window,
      provenance: { state: 'not-connected', firstCollectedDay: null },
      boundaryDay: boundary }),
    /never collected has no boundary day/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Clones', observations: stored, calendarDays: window,
      provenance: { state: 'connected', firstCollectedDay: boundary }, boundaryDay: '2026-10-02' }),
    /disagree; the recorded read owns the boundary/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Clones', observations: stored, calendarDays: window,
      provenance: { state: /** @type {unknown} */ ('unknown'), firstCollectedDay: null } }),
    /reports state "connected" or "not-connected"/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Clones', observations: stored, calendarDays: window,
      provenance: 'connected' }),
    /a record carrying a state and a first collected day/,
  );
  assert.throws(
    () => renderUnchecked({ label: 'Clones', observations: stored, calendarDays: window,
      provenance: { state: 'connected', firstCollectedDay: '2026-10-32' } }),
    /Invalid first collected day/,
  );

  // Agreeing sources are accepted, and a read that reports a boundary outside the
  // window is stated in words rather than drawn at the window edge.
  const agreeing = renderLineChart({ label: 'Clones', observations: stored, calendarDays: window,
    provenance: { state: 'connected', firstCollectedDay: boundary }, boundaryDay: boundary });
  assert.equal(elementsWithClass(agreeing, 'g', 'chart-boundary').length, 1);
  const outside = renderLineChart({ label: 'Clones', observations: stored, calendarDays: window,
    provenance: { state: 'connected', firstCollectedDay: '2026-12-01' } });
  assert.equal(elementsWithClass(outside, 'g', 'chart-boundary').length, 0);
  assert.match(textOf(outside, 'figcaption'),
    /Collected history begins on 2026-12-01, after this window of 2026-09-28 to 2026-10-04: what this window shows is the span since connection rather than the repository's history\./);
  const earlier = renderLineChart({ label: 'Clones', observations: stored, calendarDays: window,
    provenance: { state: 'connected', firstCollectedDay: '2026-09-01' } });
  assert.equal(elementsWithClass(earlier, 'g', 'chart-boundary').length, 0);
  assert.match(textOf(earlier, 'figcaption'), /Collected history began on 2026-09-01, before this window/);
});

test('the annotated chart is deterministic and stays free of script, assets and motion', async (t) => {
  const db = await fixture(t);
  seedDays(db, CONNECTED_DAYS);
  stampFirstCollected(db, 1, { day: boundary, collectedAt: collectionAt });
  const request = pageChartRequest(db, CONNECTED_DAYS, 'clones');
  const first = renderLineChart(request);
  assert.equal(renderLineChart(request), first, 'the same read and the same rows render the same bytes');

  // The order the archive's rows arrive in is not a measurement.
  const shuffled = renderLineChart({ ...request, observations: [...request.observations].reverse() });
  assert.equal(shuffled, first);
  // Reading the archive again returns the same rows, so the same bytes.
  const reread = renderLineChart(pageChartRequest(db, CONNECTED_DAYS, 'clones'));
  assert.equal(reread, first);

  for (const markup of [first, renderLineChart(pageChartRequest(db, NEVER_COLLECTED_DAYS, 'clones'))]) {
    assert.ok(!/<script/i.test(markup), 'no script tag');
    assert.ok(!/\son[a-z]+=/i.test(markup), 'no inline event handler');
    assert.ok(!/https?:|\/\/|@import|url\(|<img|<link|<iframe/i.test(markup), 'no remote reference');
    assert.ok(!/<animate|<set|<transition|animation/i.test(markup), 'no motion');
    assert.equal((markup.match(/<svg\b/g) ?? []).length,
      (markup.includes('chart-legend') ? 3 : 1), 'one chart figure and one swatch per legend entry');
    assert.ok(!/NaN|Infinity|undefined|null/.test(markup), `a degenerate value reached the markup: ${markup}`);
  }

  // The chart reads the archive as data and never opens it: the escaping module is
  // its only import, so no archive read reaches it except as a request field.
  const imports = [...chartSource.matchAll(/^import\s+(.+?)\s+from\s+'([^']+)'/gm)].map((match) => match[2]);
  assert.deepEqual(imports, ['../../server/html.js']);
  for (const forbidden of ['node:sqlite', 'node:fs', 'node:http', 'node:child_process']) {
    assert.ok(!chartSource.includes(forbidden), `the chart module must not reach into ${forbidden}`);
  }
});

test('a chart with no provenance to show carries no marker, legend or provenance column', async (t) => {
  const db = await fixture(t);
  seedDays(db, CONNECTED_DAYS);
  // A read of stored days with no provenance supplied and no recorded source: the
  // chart knows no boundary and claims none, so it annotates nothing.
  const request = {
    label: 'Clones',
    valueLabel: 'Clones',
    calendarDays: calendarDays(windowFrom, windowTo),
    observations: [{ day: '2026-09-28', value: 4 }, { day: '2026-10-03', value: 5 }],
  };
  const model = buildLineChart(request);
  const markup = renderLineChart(request);
  assert.equal(model.provenanceKnown, false);
  assert.equal(model.provenanceState, null);
  assert.equal(model.boundaryDay, null);
  assert.equal(model.provenanceNotes.length, 0);
  assert.equal(legendEntries(markup).length, 0);
  assert.equal(markup.includes(SOURCE_COLUMN_LABEL), false);
  assert.equal(elementsWithClass(markup, 'g', 'chart-boundary').length, 0);
  assert.ok(!/first collected|since connection/i.test(markup), 'no boundary claim without a read');
  // Two columns, exactly as before the annotation existed.
  assert.deepEqual(chartTableRows(markup).map((row) => row.sourceText),
    [null, null, null, null, null, null, null]);

  // A day carrying no recorded source beside days that do carry one is labelled as
  // unrecorded rather than counted into either total.
  const partly = renderLineChart({
    label: 'Clones',
    calendarDays: calendarDays(windowFrom, windowTo),
    observations: [
      { day: '2026-09-28', value: 4, source: 'backfill' },
      { day: '2026-09-29', value: 6 },
    ],
    provenance: readProvenance(db, 1, { today: windowTo }),
  });
  assert.equal(legendEntries(partly).length, 2);
  assert.match(textOf(partly, 'figcaption'), new RegExp(`No collection has been recorded for this repository`));
  assert.ok(!/\d+ stored days? (?:is|are) backfilled and \d+ (?:is|are) collected\./.test(textOf(partly, 'figcaption')),
    'a day with no recorded source must not be counted as either');
  assert.deepEqual(chartTableRows(partly).map((row) => row.sourceText).slice(0, 2),
    [BACKFILL_SOURCE_TEXT, UNRECORDED_SOURCE_TEXT]);
});

test('no provenance sentence carries a score, a verdict or a direction the data does not support', async (t) => {
  const db = await fixture(t);
  seedDays(db, CONNECTED_DAYS);
  stampFirstCollected(db, 1, { day: boundary, collectedAt: collectionAt });
  const connected = renderLineChart(pageChartRequest(db, CONNECTED_DAYS, 'clones'));
  const neverCollected = renderLineChart(pageChartRequest(db, NEVER_COLLECTED_DAYS, 'clones'));
  for (const markup of [connected, neverCollected]) {
    const model = buildLineChart(markup === connected
      ? pageChartRequest(db, CONNECTED_DAYS, 'clones')
      : pageChartRequest(db, NEVER_COLLECTED_DAYS, 'clones'));
    assert.ok(model.provenanceNotes.length > 0, 'this fixture has provenance to state');
    const prose = [model.summary, model.tableCaption, ...model.provenanceNotes,
      ...legendEntries(markup).map((entry) => entry.label)].join(' ').toLowerCase();
    for (const word of VERDICT_WORDS) {
      assert.ok(!prose.includes(word), `the chart says "${word}": ${prose}`);
    }
    const stripped = markup.replace(/<[^>]*>/g, ' ').toLowerCase();
    for (const word of VERDICT_WORDS) {
      assert.ok(!stripped.includes(word), `the rendered markup says "${word}"`);
    }
  }
});