import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHANGE_LIST_SUFFICIENT,
  MAX_CHANGE_ENTRIES,
  MAX_NAMED_GAP_DAYS as CHANGE_LIST_GAP_DAYS,
  changeList,
} from '../src/insight/changes.js';
import { COMPARISON_DAYS, DELTA_SUFFICIENT, WINDOW_DAYS, sevenDayDelta } from '../src/insight/deltas.js';
import {
  DIVERGENCE_SUFFICIENT,
  MAX_NAMED_GAP_DAYS as DIVERGENCE_GAP_DAYS,
  MINIMUM_COLLECTED_DAYS,
  starsVersusClonesDivergence,
} from '../src/insight/divergence.js';
import {
  MAX_DAY_LABELS,
  MAX_NAMED_GAP_DAYS as CHART_GAP_DAYS,
  MAX_VALUE_TICKS,
  buildLineChart,
  renderLineChart,
} from '../src/views/components/line-chart.js';

/**
 * Section 9 of `docs/features/chart-and-insight.md` against the modules that cite it.
 *
 * That section is the published list of the numbers this feature's own source files say
 * they take from it: `src/insight/divergence.js` cites it for the minimum-volume floor
 * and `src/insight/changes.js` for the entry cap. Nothing checked that the citation
 * still resolved, so a section renumbered from 9 to 10, or a floor quietly moved from
 * fourteen to seven, would leave every other suite green.
 *
 * The direction of repair is the document's. A constant the plan asked for is not moved
 * to make a document agree with it; a section renumbered out from under a citation is a
 * document defect and is named as one. So every figure below is read out of the section
 * and compared against the constant the module exports, and a failure names both sides.
 */

/** @typedef {import('../src/insight/changes.js').ChangeListRequest} ChangeListRequest */
/** @typedef {import('../src/insight/changes.js').InsufficientChangeList} InsufficientChangeList */
/** @typedef {import('../src/insight/changes.js').SufficientChangeList} SufficientChangeList */
/** @typedef {import('../src/insight/deltas.js').SufficientDelta} SufficientDelta */
/** @typedef {import('../src/insight/divergence.js').DivergenceRequest} DivergenceRequest */
/** @typedef {import('../src/insight/divergence.js').InsufficientDivergence} InsufficientDivergence */
/** @typedef {import('../src/insight/divergence.js').SufficientDivergence} SufficientDivergence */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAY_MS = 86_400_000;

/** The document that owns the claim, named the way the source files name it. */
const FEATURE_RELATIVE = 'docs/features/chart-and-insight.md';
const FEATURE = path.join(ROOT, 'docs', 'features', 'chart-and-insight.md');

/** The heading the two source citations point at. */
const THRESHOLDS_HEADING = '9. Sufficiency Thresholds and Caps';

const DELTAS_RELATIVE = 'src/insight/deltas.js';
const DIVERGENCE_RELATIVE = 'src/insight/divergence.js';
const CHANGES_RELATIVE = 'src/insight/changes.js';
const LINE_CHART_RELATIVE = 'src/views/components/line-chart.js';

/** The two modules whose comments cite this document for their own defaults. */
const CITING_MODULES = [DIVERGENCE_RELATIVE, CHANGES_RELATIVE];

/**
 * Every constant section 9 publishes, with the module that owns it and the value that
 * module exports. The name and the module are the only things stated here: a figure
 * appears once in this file, and it is the one the code already uses.
 */
const CONSTANT_ROWS = [
  { name: 'WINDOW_DAYS', module: DELTAS_RELATIVE, value: WINDOW_DAYS },
  { name: 'COMPARISON_DAYS', module: DELTAS_RELATIVE, value: COMPARISON_DAYS },
  { name: 'MINIMUM_COLLECTED_DAYS', module: DIVERGENCE_RELATIVE, value: MINIMUM_COLLECTED_DAYS },
  { name: 'MAX_CHANGE_ENTRIES', module: CHANGES_RELATIVE, value: MAX_CHANGE_ENTRIES },
  { name: 'MAX_NAMED_GAP_DAYS', module: CHANGES_RELATIVE, value: CHANGE_LIST_GAP_DAYS },
  { name: 'MAX_VALUE_TICKS', module: LINE_CHART_RELATIVE, value: MAX_VALUE_TICKS },
  { name: 'MAX_DAY_LABELS', module: LINE_CHART_RELATIVE, value: MAX_DAY_LABELS },
];

/**
 * The three caps the chart is held to, which is this task's third acceptance criterion.
 * Read from the imports rather than restated, so the loop over the names cannot disagree
 * with the renderer it is checking.
 */
const CHART_CAPS = [
  { name: 'MAX_NAMED_GAP_DAYS', value: CHART_GAP_DAYS },
  { name: 'MAX_VALUE_TICKS', value: MAX_VALUE_TICKS },
  { name: 'MAX_DAY_LABELS', value: MAX_DAY_LABELS },
];

/**
 * The two rows of the same table that publish a rounding rule rather than a constant.
 * Their value cell is read as a shape - how many decimal places, and what precision the
 * fallback keeps - and that shape is observed from the readings themselves, because no
 * module exports a rounding constant to compare a document against.
 */
const ROUNDING_ROWS = ['Rounded ratio', 'Rounded percentage'];

/**
 * The modules this feature caps named gap days in, each against the single row that
 * publishes the cap. `src/report/format.js` exports the same name for the report's own
 * coverage line; that cap is asserted against its own feature document by
 * `tests/contract-report.test.js`, so it is deliberately not a third authority here.
 */
const GAP_DAY_CAPS = [
  { module: DIVERGENCE_RELATIVE, value: DIVERGENCE_GAP_DAYS },
  { module: CHANGES_RELATIVE, value: CHANGE_LIST_GAP_DAYS },
  { module: LINE_CHART_RELATIVE, value: CHART_GAP_DAYS },
];

/**
 * The English words for the figures this repository spells out in prose rather than
 * printing as digits, so a published number written either way can be read.
 */
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four',
  'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty',
];

/**
 * @param {string} file
 * @returns {string}
 */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Flatten a document's line wrapping, so an assertion about a sentence does not depend on
 * where the prose happens to wrap.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One `##` section of the feature document, verbatim, because the claim is carried by a
 * table row rather than by a sentence. A heading that is not there fails the test rather
 * than matching the whole document by accident - which is what a citation renumbered
 * away from section 9 needs.
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function sectionText(heading) {
  const page = read(FEATURE);
  const marker = `## ${heading}\n`;
  assert.ok(page.includes(marker), `${FEATURE_RELATIVE} has no "## ${heading}" section`);
  const body = page.slice(page.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * One `##` section of the feature document, flattened.
 * @param {string} heading
 * @returns {string}
 */
function section(heading) {
  return flatten(sectionText(heading));
}

/**
 * The document's own section numbers, read from its headings, so `section 9` in a source
 * comment is resolved against the document rather than trusted.
 * @returns {Map<number, string>} Section number to the rest of its heading.
 */
function documentSections() {
  const headings = new Map();
  for (const match of read(FEATURE).matchAll(/^## (\d+)\. (.+)$/gm)) {
    headings.set(Number(match[1] ?? ''), (match[2] ?? '').trim());
  }
  assert.ok(headings.size > 0, `${FEATURE_RELATIVE} has no numbered section for a citation to resolve against`);
  return headings;
}

/**
 * Every row of section 9's table, found by the table's own shape rather than by position,
 * so reordering the table is not a failure and dropping a row is. The header and the
 * alignment row carry no backticked name, so neither is mistaken for a claim.
 * @returns {{name: string, value: string, why: string}[]}
 */
function thresholdRows() {
  const rows = [];
  for (const line of sectionText(THRESHOLDS_HEADING).split('\n')) {
    if (!/^\|\s*`/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    rows.push({
      name: (cells[0] ?? '').replace(/^`|`$/g, ''),
      value: cells[1] ?? '',
      why: cells[2] ?? '',
    });
  }
  assert.ok(rows.length > 0, `section ${THRESHOLDS_HEADING.split('.')[0]} of ${FEATURE_RELATIVE} publishes no table`);
  return rows;
}

/**
 * One row of section 9's table, by the constant it names.
 * @param {string} name
 * @returns {{name: string, value: string, why: string}}
 */
function thresholdRow(name) {
  const rows = thresholdRows();
  const row = rows.find((candidate) => candidate.name === name);
  assert.ok(row !== undefined,
    `section 9 of ${FEATURE_RELATIVE} publishes no row for \`${name}\`; it publishes ` +
      `${JSON.stringify(rows.map((candidate) => candidate.name))}`);
  return row;
}

/**
 * The whole number a section 9 row publishes, so the comparison is against the code's own
 * figure and never against a copy of it made here.
 * @param {string} name
 * @returns {number}
 */
function documentedInteger(name) {
  const { value } = thresholdRow(name);
  assert.match(value, /^\d+$/,
    `section 9 of ${FEATURE_RELATIVE} publishes \`${name}\` as "${value}", which is not a whole number`);
  return Number(value);
}

/**
 * The English word for a figure, so a document that spells a published number out in
 * prose is read against the same constant the table carries.
 * @param {number} value
 * @returns {string}
 */
function numberWord(value) {
  const word = NUMBER_WORDS[value];
  assert.ok(word !== undefined, `${value} has no English word in this suite's list`);
  return word;
}

/**
 * Every day an inclusive range covers, oldest first.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function days(from, to) {
  const listed = [];
  for (let time = Date.parse(`${from}T00:00:00.000Z`); time <= Date.parse(`${to}T00:00:00.000Z`);
    time += DAY_MS) {
    listed.push(new Date(time).toISOString().slice(0, 10));
  }
  return listed;
}

/**
 * The day the given number of days after `day`. The fixtures state their window as an
 * offset from the imported constants rather than as a second copy of the window length.
 * @param {string} day
 * @param {number} offset
 * @returns {string}
 */
function shiftDay(day, offset) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The exported whole-number constants of one module, each with the documentation comment
 * written immediately above it. Read from the module's own source rather than restated,
 * because the citation lives in that comment and a citation that stops naming the section
 * is exactly what has to fail here.
 * @param {string} relative
 * @returns {{name: string, value: number, comment: string}[]}
 */
function exportedConstants(relative) {
  const lines = read(path.join(ROOT, relative)).split('\n');
  const found = [];
  for (const [index, line] of lines.entries()) {
    const declaration = /^export const ([A-Z][A-Z0-9_]*) = (\d+);$/.exec(line.trim());
    if (declaration === null) continue;
    const comment = [];
    for (let back = index - 1; back >= 0; back -= 1) {
      const above = lines[back] ?? '';
      if (above.trim().startsWith('*') || above.trim() === '/**') {
        comment.unshift(above);
        continue;
      }
      break;
    }
    found.push({
      name: declaration[1] ?? '',
      value: Number(declaration[2] ?? ''),
      comment: flatten(comment.join(' ')),
    });
  }
  assert.ok(found.length > 0, `${relative} exports no whole-number constant this suite can compare`);
  return found;
}

/**
 * Narrow a divergence reading to its sufficient variant, so a test cannot read a `ratio`
 * off a reading that never computed one.
 * @param {SufficientDivergence|InsufficientDivergence} reading
 * @returns {SufficientDivergence}
 */
function sufficientDivergence(reading) {
  if (reading.status !== DIVERGENCE_SUFFICIENT) {
    assert.fail(`expected a sufficient reading, got ${reading.status} (${reading.reason}): ${reading.summary}`);
  }
  return reading;
}

/**
 * Narrow a change list to its sufficient variant.
 * @param {SufficientChangeList|InsufficientChangeList} list
 * @returns {SufficientChangeList}
 */
function sufficientList(list) {
  if (list.status !== CHANGE_LIST_SUFFICIENT) {
    assert.fail(`expected a sufficient list, got ${list.status} (${list.reason}): ${list.summary}`);
  }
  return list;
}

/**
 * A stars-versus-clones reading over `collected` paired days with `gaps` unmeasured days
 * strictly inside the window. The window length is the published floor and the gap count is
 * the caller's, so a fixture can never quietly pass by being a day short of the floor.
 *
 * The measured days are the opening days and the closing day, so no gap day is one of the
 * two days the summary states as the window's own. A gap day that were also an end of the
 * range would be found in the summary by the range it is printed in rather than by the gap
 * sentence that names it, and the count below would be one too high for the wrong reason.
 * @param {{collected: number, gaps?: number, cloners: number, stars: number}} options
 * @returns {SufficientDivergence|InsufficientDivergence}
 */
function divergenceReading({ collected, gaps = 0, cloners, stars }) {
  const from = '2026-03-01';
  const calendar = days(from, shiftDay(from, collected + gaps - 1));
  const measured = measuredDays(calendar, collected, gaps);
  /** @type {DivergenceRequest} */
  const request = {
    // The cloner total lands on the last measured day, so the sum the reading reports is
    // exactly the figure the assertion names rather than a total of seven repetitions.
    uniqueCloners: measured.map((day, index) => ({
      day,
      value: index === measured.length - 1 ? cloners : 0,
    })),
    stars: measured.map((day) => ({ day, value: stars })),
    range: { from, to: calendar[calendar.length - 1] ?? from },
  };
  return starsVersusClonesDivergence(request);
}

/**
 * Which days of a window carry a stored value: the opening days and, when the window also
 * holds unmeasured days, the closing day, so every unmeasured day lies strictly inside the
 * window. See {@link divergenceReading} for why that matters to an assertion.
 * @param {string[]} calendar Every day the window covers, oldest first.
 * @param {number} stored Stored days the window holds.
 * @param {number} gaps Unmeasured days the window also covers.
 * @returns {string[]}
 */
function measuredDays(calendar, stored, gaps) {
  const opening = calendar.slice(0, gaps === 0 ? stored : stored - 1);
  const closing = gaps === 0 ? '' : (calendar[calendar.length - 1] ?? '');
  return closing === '' || opening.includes(closing) ? opening : [...opening, closing];
}

/**
 * A seven-day comparison over the shortest range that can carry one: the later window
 * holds `current` on every one of its days and the earlier window `base`. The percentage
 * is therefore `(current - base) / base * 100`, worked out here from the fixture rather
 * than copied out of a result.
 * @param {number} base
 * @param {number} current
 * @returns {SufficientDelta}
 */
function deltaReading(base, current) {
  const from = '2026-03-01';
  const calendar = days(from, shiftDay(from, COMPARISON_DAYS - 1));
  const result = sevenDayDelta({
    metric: 'clones',
    observations: calendar.map((day, index) => ({ day, value: index < WINDOW_DAYS ? base : current })),
    range: { from, to: calendar[calendar.length - 1] ?? from },
  });
  if (result.status !== DELTA_SUFFICIENT) {
    assert.fail(`expected a sufficient seven-day reading, got ${result.status}: ${result.summary}`);
  }
  return result;
}

/**
 * A change list over one metric whose stored days each differ from the day before, so the
 * walk finds one entry per stored day after the first. Triangular numbers make every
 * difference distinct, so the ordering by absolute change has nothing to break a tie on.
 *
 * Any unmeasured days sit strictly inside the window, for the reason
 * {@link divergenceReading} gives.
 * @param {number} storedDays
 * @param {number} [gaps] Calendar days the window also covers that hold nothing.
 * @returns {ChangeListRequest}
 */
function changeListRequest(storedDays, gaps = 0) {
  const from = '2026-03-01';
  const calendar = days(from, shiftDay(from, storedDays + gaps - 1));
  const observations = measuredDays(calendar, storedDays, gaps).map((day, index) => ({
    day,
    value: (index * (index + 1)) / 2,
  }));
  return {
    series: [{ metric: 'unique-cloners', observations }],
    range: { from, to: calendar[calendar.length - 1] ?? from },
  };
}

/**
 * How many elements of one kind the rendered chart carries, so the axis caps are counted
 * in the output a reader is shown rather than read back out of the constant.
 * @param {string} markup
 * @param {string} kind
 * @returns {number}
 */
function ticks(markup, kind) {
  return [...markup.matchAll(new RegExp(`<g class="${kind}"`, 'g'))].length;
}

/**
 * The rounding a section 9 row publishes, as the two precisions it states: how many
 * decimal places a figure is printed at, and how many significant digits it keeps when
 * that precision would round it away.
 * @param {string} name
 * @returns {{decimals: number, fallback: number}}
 */
function roundingRule(name) {
  const { value } = thresholdRow(name);
  const match = /^(\d+) decimals?, (\d+)-significant-digit fallback$/.exec(value);
  assert.ok(match !== null, `section 9 of ${FEATURE_RELATIVE} publishes \`${name}\` as "${value}", which this suite ` +
    'cannot read as a rounding rule');
  return { decimals: Number(match[1] ?? ''), fallback: Number(match[2] ?? '') };
}

// RS-C12 and this feature's own acceptance criterion 6: every threshold section 9 publishes
// is the value the module that owns it exports. The document is read as a table and the
// modules are imported as modules, so a threshold that moves on either side is caught.
test('every constant section 9 publishes is the value the module that owns it exports', () => {
  const published = thresholdRows().map((row) => row.name);
  const expected = [...CONSTANT_ROWS.map((row) => row.name), ...ROUNDING_ROWS];

  // Both directions: a row naming a constant no module exports, and a constant the
  // document used to publish and no longer does.
  assert.deepEqual([...published].sort(), [...expected].sort(),
    `section 9 of ${FEATURE_RELATIVE} publishes ${JSON.stringify([...published].sort())} and the modules this ` +
      `suite holds to that section own ${JSON.stringify([...expected].sort())}`);

  for (const { name, module: owner, value } of CONSTANT_ROWS) {
    const declared = documentedInteger(name);
    assert.equal(declared, value,
      `section 9 of ${FEATURE_RELATIVE} publishes ${name} as ${declared} and ${name} in ${owner} is ${value}`);
    // The module still exports it under that name, so a rename is a rename in the
    // document too rather than a row that happens to read correctly.
    assert.ok(exportedConstants(owner).some((entry) => entry.name === name),
      `${owner} exports no whole-number constant named ${name}, which section 9 of ${FEATURE_RELATIVE} publishes`);
  }
});

// RS-C12: a citation in a source comment is a claim that a document still says this, and
// a document that has moved on breaks it. The citation is resolved - comment to section
// number to the row it points at - and the figure it resolves to is compared with the
// constant the comment sits on.
test('the two source citations of this document still resolve to section 9 and to the figure it publishes', () => {
  const headings = documentSections();
  const cited = [];

  for (const relative of CITING_MODULES) {
    const citing = exportedConstants(relative).filter((entry) => entry.comment.includes(FEATURE_RELATIVE));
    assert.ok(citing.length > 0,
      `${relative} no longer cites ${FEATURE_RELATIVE} in the documentation comment of any exported constant, so ` +
        'the citation this suite protects is gone rather than wrong');
    for (const entry of citing) {
      const reference = /section (\d+)/.exec(entry.comment);
      assert.ok(reference !== null,
        `${relative} cites ${FEATURE_RELATIVE} for ${entry.name} without naming a section; its comment reads ` +
          `${JSON.stringify(entry.comment)}`);
      const number = Number(reference[1] ?? '');
      const heading = headings.get(number);
      assert.ok(heading !== undefined,
        `${relative} cites ${FEATURE_RELATIVE} section ${number} for ${entry.name}, and that document numbers its ` +
          `sections ${JSON.stringify([...headings.keys()])}`);
      assert.equal(`${number}. ${heading}`, THRESHOLDS_HEADING,
        `${relative} cites ${FEATURE_RELATIVE} section ${number} for ${entry.name}, but section ${number} of ` +
          `that document is "${number}. ${heading}", which publishes no thresholds`);
      // The cited section is read for the row the comment is attached to, so a section that
      // renumbered its table fails here rather than passing against another row.
      const published = new RegExp(`\\| \`${entry.name}\` \\| (\\d+) \\|`, 'g').exec(section(THRESHOLDS_HEADING));
      assert.ok(published !== null,
        `section ${number} of ${FEATURE_RELATIVE} is cited by ${relative} for ${entry.name} but publishes no row ` +
          'for it');
      assert.equal(entry.value, Number(published[1] ?? ''),
        `${relative} cites ${FEATURE_RELATIVE} section ${number} for ${entry.name} as ${entry.value}, and that ` +
          `section publishes ${String(published[1])}`);
    }
    cited.push(...citing.map((entry) => entry.name));
  }

  // The two numbers the citations exist for are still cited. A citation that survives on
  // some other constant is not the claim this feature document makes.
  for (const name of ['MINIMUM_COLLECTED_DAYS', 'MAX_CHANGE_ENTRIES']) {
    assert.ok(cited.includes(name),
      `no module of ${CITING_MODULES.join(' and ')} cites ${FEATURE_RELATIVE} section 9 for ${name} any more; the ` +
        `constants that do cite it are ${JSON.stringify(cited)}`);
  }
});

// RS-C12: this task's acceptance criterion is that losing section 9, or either number it is
// cited for, is a failure. Both numbers are published twice - as a figure in the table and
// as a word in the sentence that explains it - and the floor is spelled out in two further
// places of the same document, so each of those is held to the imported constant.
test('section 9 still carries both cited numbers, as a figure in its table and as a word beside it', () => {
  const cited = [
    { name: 'MINIMUM_COLLECTED_DAYS', module: DIVERGENCE_RELATIVE, value: MINIMUM_COLLECTED_DAYS },
    { name: 'MAX_CHANGE_ENTRIES', module: CHANGES_RELATIVE, value: MAX_CHANGE_ENTRIES },
  ];

  for (const { name, module: owner, value } of cited) {
    const { why } = thresholdRow(name);
    const declared = documentedInteger(name);
    assert.equal(declared, value,
      `section 9 of ${FEATURE_RELATIVE} publishes ${name} as ${declared} and ${name} in ${owner} is ${value}`);
    const word = numberWord(value);
    assert.ok(why.toLowerCase().includes(word),
      `section 9 of ${FEATURE_RELATIVE} no longer spells ${name} out as "${word}" in the sentence that explains it; ` +
        `that sentence reads ${JSON.stringify(why)}`);
  }

  const scenarios = section('8. Testing Strategy');
  assert.ok(
    new RegExp(`${numberWord(MINIMUM_COLLECTED_DAYS)} paired days is the boundary of sufficiency`).test(scenarios),
    `section 8 of ${FEATURE_RELATIVE} no longer states that ${numberWord(MINIMUM_COLLECTED_DAYS)} paired days is the ` +
      'boundary of sufficiency for the divergence reading',
  );
  assert.ok(
    new RegExp(`${numberWord(MINIMUM_COLLECTED_DAYS - 1)} is not`).test(scenarios),
    `section 8 of ${FEATURE_RELATIVE} no longer states that ${numberWord(MINIMUM_COLLECTED_DAYS - 1)} paired days is ` +
      'below the boundary of sufficiency',
  );
  const criteria = section('11. Acceptance Criteria');
  assert.ok(
    new RegExp(`insufficient below ${numberWord(MINIMUM_COLLECTED_DAYS)} paired collected days`).test(criteria),
    `section 11 of ${FEATURE_RELATIVE} no longer states that the reading is insufficient below ` +
      `${numberWord(MINIMUM_COLLECTED_DAYS)} paired collected days`,
  );
});

// RS-INS-C06: the chart is held to the same caps section 9 publishes. Each cap is compared
// with the published figure and then observed in the chart a reader is shown, so neither
// the table nor the renderer can move alone.
test('the chart\'s gap-day, value-tick and day-label caps are the ones section 9 publishes', () => {
  for (const { name, value } of CHART_CAPS) {
    assert.equal(documentedInteger(name), value,
      `section 9 of ${FEATURE_RELATIVE} publishes ${name} as ${String(documentedInteger(name))} and ${name} in ` +
        `${LINE_CHART_RELATIVE} is ${String(value)}`);
  }

  // The value axis: bounded by the published cap, and the bound is reachable, so a smaller
  // effective cap cannot pass this by never producing the published number of ticks.
  const valueAxis = (/** @type {number} */ maximum) => buildLineChart({
    label: 'Views',
    observations: [{ day: '2026-03-01', value: maximum }, { day: '2026-03-02', value: 0 }],
  });
  for (const maximum of [1, 3, 21, 100, 900, 12345]) {
    const model = valueAxis(maximum);
    assert.ok(model.valueTicks.length <= MAX_VALUE_TICKS,
      `a largest stored value of ${maximum} produced ${model.valueTicks.length} ticks and section 9 of ` +
        `${FEATURE_RELATIVE} publishes a cap of ${MAX_VALUE_TICKS}`);
    assert.equal(model.valueTicks[0], 0, `the axis for ${maximum} does not start at zero`);
    assert.equal(model.valueTicks[model.valueTicks.length - 1], maximum,
      `the axis for ${maximum} does not end at the largest stored value`);
  }
  assert.equal(valueAxis(400).valueTicks.length, MAX_VALUE_TICKS,
    `no largest stored value reached the published cap of ${MAX_VALUE_TICKS} ticks, so the bound above proves ` +
      'nothing about the cap');
  // The same axis counted in the output a reader is shown, so the cap is asserted against
  // the markup and not only against the model the markup is rendered from.
  const renderedAxis = renderLineChart({
    label: 'Views',
    observations: [{ day: '2026-03-01', value: 400 }, { day: '2026-03-02', value: 0 }],
  });
  assert.equal(ticks(renderedAxis, 'chart-value-tick'), MAX_VALUE_TICKS,
    `the rendered value axis carries ${String(ticks(renderedAxis, 'chart-value-tick'))} ticks and section 9 of ` +
      `${FEATURE_RELATIVE} publishes a cap of ${MAX_VALUE_TICKS}`);

  // The bottom axis: a window of many days is still labelled at the published number of
  // points, the boundary inside the window being one of them. The days before the boundary
  // are recorded as reconstructed, which is what the archive holds for them.
  const window = days('2026-03-01', shiftDay('2026-03-01', 29));
  const boundary = window[10] ?? window[0];
  const labelled = renderLineChart({
    label: 'Clones',
    observations: window.map((day, index) => ({
      day,
      value: index + 1,
      source: /** @type {'backfill'|'collected'} */ (day < (boundary ?? '') ? 'backfill' : 'collected'),
    })),
    calendarDays: window,
    boundaryDay: boundary,
  });
  assert.equal(ticks(labelled, 'chart-day-tick'), MAX_DAY_LABELS,
    `a ${window.length}-day window was labelled at ${String(ticks(labelled, 'chart-day-tick'))} days and section 9 ` +
      `of ${FEATURE_RELATIVE} publishes a cap of ${MAX_DAY_LABELS} day labels`);

  // The named gap days: the sentence names the published number and counts the rest, and
  // the table beside it still carries a row for every day the window covers. The gaps sit
  // strictly inside the window, so the two days the summary states as the window's own are
  // never themselves gaps and cannot be counted as named ones.
  const gapCount = CHART_GAP_DAYS + 5;
  const gapped = days('2026-03-01', shiftDay('2026-03-01', 2 + gapCount - 1));
  const model = buildLineChart({
    label: 'Clones',
    observations: [
      { day: gapped[0] ?? '2026-03-01', value: 1 },
      { day: gapped[gapped.length - 1] ?? '2026-03-17', value: 2 },
    ],
    calendarDays: gapped,
  });
  const named = model.missingDays.filter((day) => model.summary.includes(day));
  assert.equal(named.length, CHART_GAP_DAYS,
    `the chart named ${named.length} of its ${gapCount} gap days and section 9 of ${FEATURE_RELATIVE} publishes a ` +
      `cap of ${CHART_GAP_DAYS} named gap days; it printed ${JSON.stringify(model.summary)}`);
  assert.ok(model.summary.includes(`and ${String(gapCount - CHART_GAP_DAYS)} further days`),
    `the chart does not count the gap days past the published cap; it printed ${JSON.stringify(model.summary)}`);
  assert.equal(model.missingDays.length, gapCount,
    'the chart dropped the gap days past the published cap instead of counting them');
  assert.equal(model.rows.length, model.calendarDayCount,
    'the paired table does not carry a row for every day the window covers, so a capped sentence would be the ' +
      'only record of the days it did not name');
});

// RS-INS-C04 and RS-INS-C05: the caps the two cited modules enforce are the published
// ones, observed in the readings they produce. `MAX_NAMED_GAP_DAYS` is one published row
// and three implementations, so all three are compared with it.
test('the readings enforce the caps section 9 publishes, and every module agrees on the gap-day cap', () => {
  const documented = documentedInteger('MAX_NAMED_GAP_DAYS');
  for (const { module: owner, value } of GAP_DAY_CAPS) {
    assert.equal(value, documented,
      `section 9 of ${FEATURE_RELATIVE} publishes MAX_NAMED_GAP_DAYS as ${documented} and MAX_NAMED_GAP_DAYS in ` +
        `${owner} is ${value}`);
  }

  // The change list: capped at the published figure, with the remainder counted.
  const omitted = 5;
  const storedDays = MAX_CHANGE_ENTRIES + omitted + 1;
  const capped = sufficientList(changeList(changeListRequest(storedDays)));
  assert.equal(capped.entries.length, MAX_CHANGE_ENTRIES,
    `the change list returned ${capped.entries.length} entries and section 9 of ${FEATURE_RELATIVE} publishes a ` +
      `cap of ${MAX_CHANGE_ENTRIES}`);
  assert.equal(capped.maxEntries, MAX_CHANGE_ENTRIES,
    'the change list does not report the published cap as the cap in force');
  assert.equal(capped.omittedEntries, omitted,
    `the change list counted ${capped.omittedEntries} omitted entries rather than ${omitted}`);
  assert.equal(capped.capped, true, 'a truncated change list does not report itself as capped');
  assert.ok(capped.summary.includes(`and ${omitted} differences are counted but not listed`),
    `the change list does not report what it omitted; it printed ${JSON.stringify(capped.summary)}`);
  assert.equal(capped.totalEntries, storedDays - 1,
    'the capped list reports a different total from the differences the walk actually made');

  // A list shorter than the cap reports no remainder, so a cap never invents one.
  const short = sufficientList(changeList(changeListRequest(MAX_CHANGE_ENTRIES)));
  assert.equal(short.omittedEntries, 0, 'a list exactly at the cap reports omitted entries it did not have');
  assert.equal(short.capped, false, 'a list exactly at the cap reports itself as capped');

  // The change list's gap sentence, at the published named-gap cap.
  const listGaps = CHANGE_LIST_GAP_DAYS + 6;
  const gapped = sufficientList(changeList(changeListRequest(2, listGaps)));
  const coverage = gapped.seriesCoverage[0];
  assert.ok(coverage !== undefined, 'the change list reported no coverage for the series it was given');
  assert.equal(coverage.missingDays.length, listGaps,
    'the change list dropped the gap days past the published cap instead of carrying every one of them');
  const namedByList = coverage.missingDays.filter((day) => gapped.summary.includes(day));
  assert.equal(namedByList.length, CHANGE_LIST_GAP_DAYS,
    `the change list named ${namedByList.length} of its ${listGaps} gap days and section 9 of ${FEATURE_RELATIVE} ` +
      `publishes a cap of ${CHANGE_LIST_GAP_DAYS}; it printed ${JSON.stringify(gapped.summary)}`);
  assert.ok(
    gapped.summary.includes(`${listGaps - CHANGE_LIST_GAP_DAYS} further gap days are counted but not named`),
    `the change list does not count the gap days past the published cap; it printed ${JSON.stringify(gapped.summary)}`,
  );

  // The divergence reading's gap sentence, at the same published cap.
  const readingGaps = DIVERGENCE_GAP_DAYS + 6;
  const divergence = sufficientDivergence(
    divergenceReading({ collected: MINIMUM_COLLECTED_DAYS, gaps: readingGaps, cloners: 21, stars: 400 }),
  );
  assert.equal(divergence.missingDays.length, readingGaps,
    'the divergence reading dropped the gap days past the published cap instead of carrying every one of them');
  const namedByReading = divergence.missingDays.filter((day) => divergence.summary.includes(day));
  assert.equal(namedByReading.length, DIVERGENCE_GAP_DAYS,
    `the divergence reading named ${namedByReading.length} of its ${readingGaps} gap days and section 9 of ` +
      `${FEATURE_RELATIVE} publishes a cap of ${DIVERGENCE_GAP_DAYS}; it printed ` +
      `${JSON.stringify(divergence.summary)}`);
  assert.ok(
    divergence.summary.includes(`${readingGaps - DIVERGENCE_GAP_DAYS} further gap days are counted but not named`),
    `the divergence reading does not count the gap days past the published cap; it printed ` +
      `${JSON.stringify(divergence.summary)}`,
  );

  // And the floor itself, at the boundary the same table publishes.
  const below = divergenceReading({ collected: MINIMUM_COLLECTED_DAYS - 1, cloners: 21, stars: 400 });
  assert.equal(below.status, 'insufficient',
    'a reading one collected day below the published floor still reported a comparison');
  const at = divergenceReading({ collected: MINIMUM_COLLECTED_DAYS, cloners: 21, stars: 400 });
  assert.equal(at.status, 'sufficient',
    `a reading at the published floor of ${MINIMUM_COLLECTED_DAYS} collected days is not sufficient`);
});

// RS-C05 and RS-INS-C03: the two rounding rows publish a rule rather than a constant, so
// the shape they state is read out of the table and then observed from the readings. A
// figure small enough to round away keeps its fallback precision rather than becoming a
// zero, because a zero beside a genuine difference is a wrong claim about the data.
test('the rounding section 9 publishes is the rounding the readings perform', () => {
  const ratio = roundingRule('Rounded ratio');
  const percentage = roundingRule('Rounded percentage');

  // A ratio needing more decimal places than the published figure gives, and one so small
  // that the published precision would round it away entirely.
  for (const level of [700, 1_000_000]) {
    const reading = sufficientDivergence(
      divergenceReading({ collected: MINIMUM_COLLECTED_DAYS, cloners: 1, stars: level }),
    );
    const exact = reading.uniqueCloners / reading.stars;
    const exactPercentage = exact * 100;
    const ratioAtPrecision = Number(exact.toFixed(ratio.decimals));
    assert.equal(
      reading.ratio,
      ratioAtPrecision === 0 ? Number(exact.toPrecision(ratio.fallback)) : ratioAtPrecision,
      `section 9 of ${FEATURE_RELATIVE} publishes a ratio rounded to ${ratio.decimals} decimals with a ` +
        `${ratio.fallback}-significant-digit fallback, and a reading over ${level} stars printed ` +
        `${String(reading.ratio)} for an exact ratio of ${exact}`,
    );
    const percentageAtPrecision = Number(exactPercentage.toFixed(percentage.decimals));
    assert.equal(
      reading.percentage,
      percentageAtPrecision === 0 ? Number(exactPercentage.toPrecision(percentage.fallback)) : percentageAtPrecision,
      `section 9 of ${FEATURE_RELATIVE} publishes a percentage rounded to ${percentage.decimals} decimals with a ` +
        `${percentage.fallback}-significant-digit fallback, and a reading over ${level} stars printed ` +
        `${String(reading.percentage)}% for an exact percentage of ${exactPercentage}`,
    );
    // The figure beside the number is the same number, so a page and a summary cannot
    // disagree about a rounding rule this suite has just pinned down.
    assert.ok(reading.summary.includes(`the ratio is ${String(reading.ratio)} unique-cloner day counts per star`),
      `the divergence summary does not print the rounded ratio the reading reported; it printed ` +
        `${JSON.stringify(reading.summary)}`);
    assert.ok(reading.summary.includes(`${String(reading.percentage)}% of ${String(level)}`),
      `the divergence summary does not print the rounded percentage beside the star count it came from; it ` +
        `printed ${JSON.stringify(reading.summary)}`);
  }

  // The same percentage rule in the delta reading, which is the other place the table's
  // percentage row is implemented: a non-zero change never reads as no change.
  for (const [base, current] of [[3, 4], [1_000_000, 1_000_001]]) {
    const reading = deltaReading(base, current);
    const exact = ((current - base) / base) * 100;
    const atPrecision = Number(exact.toFixed(percentage.decimals));
    assert.equal(reading.change, (current - base) * WINDOW_DAYS,
      'the fixture did not produce the change it was built to produce, so the percentage below proves nothing');
    assert.equal(
      reading.percentage,
      atPrecision === 0 ? Number(exact.toPrecision(percentage.fallback)) : atPrecision,
      `section 9 of ${FEATURE_RELATIVE} publishes a percentage rounded to ${percentage.decimals} decimals with a ` +
        `${percentage.fallback}-significant-digit fallback, and a seven-day reading from ${base} to ${current} ` +
        `printed ${String(reading.percentage)}% for an exact change of ${exact}%`,
    );
  }
});