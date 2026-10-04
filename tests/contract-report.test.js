import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stampFirstCollected } from '../src/backfill/provenance.js';
import { markBackfillRefused, markUnavailable } from '../src/collect/lifecycle.js';
import { isoDayBefore } from '../src/commands/report.js';
import { firstStoredDay, upsertDayFact } from '../src/db/day-series-repo.js';
import { openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { sevenDayDelta, weekOverWeekDelta } from '../src/insight/deltas.js';
import {
  MAX_NAMED_GAP_DAYS,
  boundaryBlock,
  changeBlock,
  coverageLine,
  describeDays,
  header,
  refusalLine,
  repositoryLines,
  runBlock,
  summaryBlock,
} from '../src/report/format.js';
import { PAGE_METRICS, readRepositoryPage } from '../src/server/repo-data.js';
import {
  REPOSITORY_STATE_DEGRADED,
  REPOSITORY_STATE_HEALTHY,
  REPOSITORY_STATE_NEVER_COLLECTED,
  REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
  REPOSITORY_STATE_PRECEDENCE,
  REPOSITORY_STATE_STALLED,
  REPOSITORY_STATE_UNAVAILABLE,
  REPOSITORY_STATE_UNREADABLE,
  RUN_STATE_COMPLETED,
  RUN_STATE_DEGRADED,
  RUN_STATE_NEVER_RUN,
  RUN_STATE_UNCLOSED,
  SUMMARY_STATE_EMPTY,
  collectionHealth,
} from '../src/supervision/health.js';
import { STALL_THRESHOLD_HOURS, createRunJournal } from '../src/supervision/journal.js';
import { recordFailure } from '../src/supervision/repo-state-reporter.js';
import { createCollectHome, outputLines as lines } from './helpers/collect-home.js';

/**
 * The documented report shape and state vocabulary, asserted against the formatter
 * that composes them and the health read that decides them.
 *
 * The direction of repair is the document's. A state word printed in a runbook that
 * the health read cannot return is a false capability, and a word the read can return
 * that no document names is a word an operator will never be told about. So every word
 * below is either read out of the documents or produced by the modules - never
 * restated as a literal in this file - and a disagreement is reported by naming both
 * sides.
 *
 * No test here reaches a host. The one that drives the real entry point runs it
 * against a temporary home with a loopback GitHub stub armed and its request log
 * asserted empty, because RS-SUP-C05 says the report contacts nothing.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT_COMMAND = 'src/commands/report.js';
const FORMAT_JS = 'src/report/format.js';
const HEALTH_JS = 'src/supervision/health.js';
const TROUBLESHOOTING = path.join(ROOT, 'docs', 'operations', 'troubleshooting.md');
const PRD = path.join(ROOT, 'docs', 'PRD.md');
const FEATURE = path.join(ROOT, 'docs', 'features', 'supervision-and-report.md');

/** The runbook section holding its repository word table and its run word table. */
const REPOSITORY_WORDS_HEADING = 'State words and what each one means';

/** The seven repository states, in the order `src/supervision/health.js` exports them. */
const REPOSITORY_STATES = [
  REPOSITORY_STATE_HEALTHY,
  REPOSITORY_STATE_NEVER_COLLECTED,
  REPOSITORY_STATE_DEGRADED,
  REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
  REPOSITORY_STATE_STALLED,
  REPOSITORY_STATE_UNAVAILABLE,
  REPOSITORY_STATE_UNREADABLE,
];

/** The four run states the health read reports for the most recent run. */
const RUN_STATES = [
  RUN_STATE_NEVER_RUN,
  RUN_STATE_UNCLOSED,
  RUN_STATE_COMPLETED,
  RUN_STATE_DEGRADED,
];

/**
 * Every word the health read can put in a `state` field, taken from the module's own
 * exported constants rather than copied out of a document. `degraded` is a repository
 * state and a run state, so the union is what a surface can be asked to render.
 */
const RETURNABLE_WORDS = /** @type {Set<string>} */ (new Set([
  ...REPOSITORY_STATES,
  ...RUN_STATES,
  SUMMARY_STATE_EMPTY,
]));

/**
 * The small integers the documents spell out in words rather than printing as digits.
 * A cap published as "ten" and a constant exported as 10 are the same claim, and the
 * reader who has to trust it should not have to know that.
 */
const SPELLED = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];

/** An em dash, spelled this way so a template literal can interpolate one. */
const EM_DASH = '\u2014';

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Flatten a document's line wrapping, so an assertion about a sentence does not depend
 * on where the prose happens to wrap.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One `##` section of a document, verbatim, so a table row still reads as a row. A
 * heading that is not there fails the test rather than matching the whole document.
 * @param {string} file
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function sectionText(file, heading) {
  const page = read(file);
  const marker = `## ${heading}\n`;
  assert.ok(page.includes(marker), `${path.basename(file)} has no "## ${heading}" section`);
  const body = page.slice(page.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * One `##` section of a document, flattened.
 * @param {string} file
 * @param {string} heading
 * @returns {string}
 */
function section(file, heading) {
  return flatten(sectionText(file, heading));
}

/**
 * The `text` of one `forge-requirement` block, read out of the feature document that
 * owns it. The requirement is the requirement: the prose around it may be reworded,
 * but the constraint is what the code is held to and what this suite compares.
 * @param {string} file
 * @param {string} id Requirement identifier, such as `RS-SUP-C06`.
 * @returns {string}
 */
function requirementText(file, id) {
  const page = read(file);
  const block = new RegExp(`\\{"id":"${id}","kind":"[^"]+","text":"([^"]*)"\\}`).exec(page);
  assert.ok(
    block !== null,
    `${path.basename(file)} no longer carries a forge-requirement block for ${id}, so the claim this ` +
      'suite protects has nowhere to be read from',
  );
  return block[1] ?? '';
}

/**
 * The number a document states in a phrase, whether it wrote it as digits or as an
 * English word. A document that stops publishing the figure at all fails here rather
 * than passing a comparison against nothing.
 * @param {string} text The sentence the figure appears in.
 * @param {RegExp} pattern Matches the figure's surrounding words; the capture is the figure.
 * @param {string} label How the sentence is described in a failure message.
 * @returns {number}
 */
function statedNumber(text, pattern, label) {
  const match = pattern.exec(text);
  assert.ok(match !== null, `${label} states no figure to compare`);
  const raw = (match[1] ?? '').trim();
  const digits = /^[\d,]+$/.test(raw) ? Number(raw.replaceAll(',', '')) : null;
  if (digits !== null) return digits;
  const spelled = SPELLED.indexOf(raw);
  assert.notEqual(
    spelled, -1,
    `${label} states "${raw}", which this suite cannot read as a number; spell it with a digit or an ` +
      `English word this repository uses (${SPELLED.join(', ')})`,
  );
  return spelled;
}

/**
 * The backticked state words in the first cell of every row of one table, found by the
 * table's own header cell rather than by position, so reordering a table is not a
 * failure and renaming a state word is. The walk stops where the table stops.
 * @param {string} body The section the table is in, verbatim.
 * @param {string} headerCell The header text of the state-word column.
 * @returns {string[]}
 */
function stateWordColumn(body, headerCell) {
  const rows = body
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()));
  const start = rows.findIndex((cells) => cells[1] === headerCell);
  assert.notEqual(
    start, -1,
    `no table in the section has a "${headerCell}" column; the columns it does have are ` +
      `${JSON.stringify(rows.map((cells) => cells[1] ?? ''))}`,
  );
  const words = [];
  for (const cells of rows.slice(start + 1)) {
    const word = /^`([a-z][a-z-]*)`$/.exec(cells[1] ?? '');
    if (word === null) {
      // The alignment row, and the first row of the next table, both end the table.
      if (words.length > 0) break;
      assert.match(cells[1] ?? '', /^:?-+:?$/,
        `a row of the "${headerCell}" table has no single state word in its first cell: ${JSON.stringify(cells[1])}`);
      continue;
    }
    words.push(word[1] ?? '');
  }
  assert.ok(words.length > 0, `the "${headerCell}" table lists no state words`);
  return words;
}

/**
 * The failure modes the runbook names a state word for, read from the `**State word:
 * \`word\`` markers its sections open with. A word in prose that the health read cannot
 * return is a capability nobody has, so each of these has to resolve.
 * @param {string} page
 * @returns {string[]}
 */
function namedStateWords(page) {
  return [...page.matchAll(/\*\*State word: `([a-z][a-z-]*)`/g)].map((match) => match[1] ?? '');
}

/**
 * The ISO day the given number of days before `day`, from the command's own exported
 * helper so the fixture's window cannot drift from the window the report will use.
 * @param {string} day
 * @param {number} count
 * @returns {string}
 */
function dayBefore(day, count) {
  return isoDayBefore(day, count);
}

/**
 * The whole archive a report reads, with every repository state the health read can
 * report written the way the product's own writers write it: `markUnavailable` for the
 * lifecycle mark, `recordFailure` for a recorded failure beside its run, and the
 * repository row's recorded last-success instant for the schedule.
 *
 * Every state is produced by a product writer rather than by hand-editing the archive,
 * so a state the health read cannot report is a test failure rather than a fixture.
 * @param {import('node:test').TestContext} t
 * @param {{ enrolled?: string[], seed?: (db: import('node:sqlite').DatabaseSync) => void }} [options]
 * @returns {Promise<import('./helpers/collect-home.js').CollectHome>}
 */
async function reportHome(t, options = {}) {
  const f = await createCollectHome(t, { enrolled: options.enrolled ?? ['owner/alpha'] });
  const db = await openArchive(f.databasePath);
  try {
    if (options.seed !== undefined) options.seed(db);
  } finally {
    db.close();
  }
  return f;
}

/** @param {number} ms @returns {string} */
function iso(ms) {
  return new Date(ms).toISOString();
}

// RS-SUP-C04 and RS-C12: the state words the troubleshooting runbook publishes are the
// words the one health read returns. A word in prose the code cannot produce is a false
// capability; a word the code produces that no document names is a word an operator will
// never be told about. Both directions are asserted here, so the page cannot drift in
// either direction without this failing.
test('every state word the troubleshooting runbook names is a word the health read can return', () => {
  const page = read(TROUBLESHOOTING);
  const words = sectionText(TROUBLESHOOTING, REPOSITORY_WORDS_HEADING);

  // Three places the page names a word: the repository table, the run table, and the
  // `**State word:` marker every failure-mode section opens with.
  const repositoryWords = stateWordColumn(words, 'State word');
  const runWords = stateWordColumn(words, 'Run word');
  const markers = namedStateWords(page);
  assert.ok(markers.length > 0, 'the troubleshooting runbook names no **State word: `word`** marker at all');

  const named = [...repositoryWords, ...runWords, ...markers];
  for (const word of named) {
    assert.ok(
      RETURNABLE_WORDS.has(word),
      `the troubleshooting runbook names the state word "${word}", which ${HEALTH_JS} cannot return; the ` +
        `words it can return are ${JSON.stringify([...RETURNABLE_WORDS].sort())}`,
    );
  }

  // And the page names the whole vocabulary, so no word the read can produce is one an
  // operator has never been told about. `not-connected` is the archive's own
  // pre-boundary word rather than a state, so it is not part of this comparison.
  assert.deepEqual(
    [...new Set(named)].sort(),
    [...RETURNABLE_WORDS].sort(),
    'the state words the troubleshooting runbook names are not the words the health read returns; ' +
      `the page names ${JSON.stringify([...new Set(named)].sort())} and ${HEALTH_JS} returns ` +
      `${JSON.stringify([...RETURNABLE_WORDS].sort())}`,
  );
  assert.equal(named.includes('not-connected'), false,
    '`not-connected` is the archive own pre-boundary word, not a state word the health read returns');
});

// RS-SUP-C04: the runbook publishes two lists - the words one repository carries and
// the words the run or the home carries - and each list has to be the right list. A
// repository word presented as a run word (or the reverse) sends an operator to the
// wrong section, so the labelling is asserted separately from the membership above.
test('the runbook labels the repository word list and the run word list the way the health read does', () => {
  const words = sectionText(TROUBLESHOOTING, REPOSITORY_WORDS_HEADING);

  const repositoryWords = stateWordColumn(words, 'State word');
  assert.deepEqual(
    [...repositoryWords].sort(),
    [...REPOSITORY_STATES].sort(),
    'the runbook table headed "State word" is not the repository vocabulary; it lists ' +
      `${JSON.stringify(repositoryWords)} and ${HEALTH_JS} exports ${JSON.stringify(REPOSITORY_STATES)}`,
  );

  const runWords = stateWordColumn(words, 'Run word');
  assert.deepEqual(
    [...runWords].sort(),
    [...RUN_STATES, SUMMARY_STATE_EMPTY].sort(),
    'the runbook table headed "Run word" is not the run vocabulary; it lists ' +
      `${JSON.stringify(runWords)} and ${HEALTH_JS} exports ${JSON.stringify([...RUN_STATES, SUMMARY_STATE_EMPTY])}`,
  );

  // `degraded` is both a repository state and a run state, so the two lists share it.
  // That overlap is deliberate and is the reason the page states both readings.
  assert.ok(repositoryWords.includes(RUN_STATE_DEGRADED) && runWords.includes(REPOSITORY_STATE_DEGRADED),
    'the page presents `degraded` as one word with one meaning; the health read uses it for both a ' +
      'repository and a run, and the page must name both readings');

  // The page says the second table describes the run or the home rather than a single
  // repository, and says how many words each table holds.
  const prose = flatten(words);
  assert.match(prose, /Five words describe the run or the home rather than a single repository/,
    'the runbook no longer says the second table describes the run or the home rather than a repository');
  assert.equal(runWords.length, 5,
    `the runbook's run table lists ${runWords.length} words and its own sentence calls it five`);
  assert.equal(repositoryWords.length, REPOSITORY_STATES.length,
    `the runbook's repository table lists ${repositoryWords.length} words and the health read has ` +
      `${REPOSITORY_STATES.length}`);
});

// RS-SUP-C04: PRD section 10 is the single list every surface draws its words from, so
// the words and the precedence order it publishes are the ones the module exports. This
// is the direction that stops a fifth vocabulary appearing anywhere.
test('the PRD state vocabulary and its precedence order are the ones the health read exports', () => {
  const states = flatten(section(PRD, '10. System States / Lifecycle'));

  // The repository list, in the paragraph that introduces it.
  const repository = /\*\*Repository:\*\* ([^.]+)\./.exec(states);
  assert.ok(repository !== null, 'docs/PRD.md section 10 no longer states the repository vocabulary');
  const listed = [...(repository[1] ?? '').matchAll(/`([a-z][a-z-]*)`/g)].map((match) => match[1] ?? '');
  assert.deepEqual(
    [...listed].sort(),
    [...REPOSITORY_STATES].sort(),
    'the repository vocabulary docs/PRD.md section 10 publishes is not the one the health read returns; ' +
      `the PRD lists ${JSON.stringify(listed)} and ${HEALTH_JS} exports ${JSON.stringify(REPOSITORY_STATES)}`,
  );

  // The precedence order, read from the sentence rather than from the list above it:
  // order is the claim, and a list cannot carry one.
  const precedence = /Precedence when several apply is ([^.]*)\./.exec(states);
  assert.ok(precedence !== null,
    'docs/PRD.md section 10 no longer states the order several repository states are resolved in');
  const order = (precedence[1] ?? '').split(/,\s*then\s+/).map((word) => word.trim()).filter((word) => word !== '');
  assert.deepEqual(
    order,
    [...REPOSITORY_STATE_PRECEDENCE],
    'the precedence order docs/PRD.md section 10 publishes is not the order the health read resolves in; ' +
      `the PRD says ${JSON.stringify(order)} and REPOSITORY_STATE_PRECEDENCE in ${HEALTH_JS} is ` +
      `${JSON.stringify([...REPOSITORY_STATE_PRECEDENCE])}`,
  );
  assert.equal(new Set(order).size, order.length, 'the published precedence names a state twice');

  // The run vocabulary, and the roll-up word beside it.
  const run = /\*\*Collection run:\*\* ([^.]+)\./.exec(states);
  assert.ok(run !== null, 'docs/PRD.md section 10 no longer states the collection-run vocabulary');
  const runWords = [...(run[1] ?? '').matchAll(/`([a-z][a-z-]*)`/g)].map((match) => match[1] ?? '');
  assert.deepEqual(
    [...new Set(runWords)].sort(),
    [...RUN_STATES].sort(),
    'the run vocabulary docs/PRD.md section 10 publishes is not the one the health read returns; the PRD ' +
      `lists ${JSON.stringify(runWords)} and ${HEALTH_JS} exports ${JSON.stringify(RUN_STATES)}`,
  );
  assert.match(states, new RegExp(`\\*\\*Archive roll-up:\\*\\* \`${SUMMARY_STATE_EMPTY}\` when nothing is enrolled`),
    `docs/PRD.md section 10 no longer names \`${SUMMARY_STATE_EMPTY}\` as the roll-up word for a home that has enrolled nothing`);

  // The stall threshold in the same section is the module's own number, and RS-SUP-C04
  // states it in words.
  const stall = /\*\*Stall rule:\*\* a repository is `([a-z][a-z-]*)` when its last recorded success is more than (\d+) hours old/.exec(states);
  assert.ok(stall !== null, 'docs/PRD.md section 10 no longer states the stall rule in a sentence of its own');
  assert.equal(stall[1], REPOSITORY_STATE_STALLED,
    `docs/PRD.md section 10 says the stall rule is about "${String(stall[1])}" and the health read's word for ` +
      `it is "${REPOSITORY_STATE_STALLED}"`);
  assert.equal(Number(stall[2]), STALL_THRESHOLD_HOURS,
    `docs/PRD.md section 10 states a ${String(stall[2])}-hour stall threshold and STALL_THRESHOLD_HOURS in ` +
      `src/supervision/journal.js is ${STALL_THRESHOLD_HOURS}`);
});

// RS-SUP-C06: the cap on named gap days is a published number, and it is the formatter's
// own constant. The figure is read out of the two documents that publish it and the
// arithmetic is observed from the formatter, so neither side can be moved alone.
test('the named-gap cap the documents state is the cap the formatter applies', () => {
  // RS-SUP-C06 in the feature document that owns the report.
  const requirement = requirementText(FEATURE, 'RS-SUP-C06');
  const fromFeature = statedNumber(
    requirement,
    /Named gap days are capped at (\S+) per series with the remainder counted/,
    'RS-SUP-C06 in docs/features/supervision-and-report.md',
  );
  assert.equal(
    fromFeature,
    MAX_NAMED_GAP_DAYS,
    `RS-SUP-C06 caps named gap days at ${fromFeature} per series and MAX_NAMED_GAP_DAYS in ${FORMAT_JS} is ` +
      `${MAX_NAMED_GAP_DAYS}`,
  );

  // The gap-rate row of the PRD's success metrics, which names the report itself.
  const gapRow = read(PRD).split('\n').find((line) => line.trimStart().startsWith('| Gap rate |'));
  assert.ok(gapRow !== undefined, 'docs/PRD.md no longer has a "Gap rate" row in its success metrics');
  const fromPrd = statedNumber(
    gapRow,
    /`report` names up to (\S+) gap days per series/,
    'the "Gap rate" row of docs/PRD.md section 11',
  );
  assert.equal(
    fromPrd,
    MAX_NAMED_GAP_DAYS,
    `the "Gap rate" row of docs/PRD.md section 11 names up to ${fromPrd} gap days per series and ` +
      `MAX_NAMED_GAP_DAYS in ${FORMAT_JS} is ${MAX_NAMED_GAP_DAYS}`,
  );

  // The published cap is also the figure the formatter uses as a cap, observed rather
  // than asserted: a run of missing days is named up to the cap and the rest counted,
  // and a shorter run is named in full so the cap never invents a remainder.
  const many = Array.from({ length: MAX_NAMED_GAP_DAYS + 5 }, (unused, index) => dayBefore('2026-10-02', index));
  const namedMany = describeDays(many);
  assert.equal(
    many.filter((day) => namedMany.includes(day)).length,
    MAX_NAMED_GAP_DAYS,
    `describeDays named ${many.filter((day) => namedMany.includes(day)).length} of ${many.length} missing days; ` +
      `MAX_NAMED_GAP_DAYS in ${FORMAT_JS} is ${MAX_NAMED_GAP_DAYS} and the remainder must be counted, not dropped`,
  );
  assert.ok(
    namedMany.includes(`and ${String(many.length - MAX_NAMED_GAP_DAYS)} more`),
    `describeDays did not count the ${String(many.length - MAX_NAMED_GAP_DAYS)} days past the cap; it printed ` +
      `${JSON.stringify(namedMany)}`,
  );
  const few = many.slice(0, MAX_NAMED_GAP_DAYS - 1);
  assert.equal(describeDays(few), few.join(', '),
    'a hole no longer than the cap must be named in full, with no invented remainder');
  assert.equal(describeDays([]), 'none', 'no missing days is stated as none, never as an empty list');

  // The same cap, reached through the coverage line a report prints, so the constant is
  // the one the printed line obeys.
  const calendarDays = Array.from({ length: MAX_NAMED_GAP_DAYS + 4 }, (unused, index) => dayBefore('2026-10-02', index));
  const stored = [calendarDays[0], calendarDays[calendarDays.length - 1]].map((day) => ({
    repositoryId: 1, metric: 'views', granularity: /** @type {'day'} */ ('day'), day, value: 1,
    source: /** @type {'collected'} */ ('collected'), collectedAt: `${day}T09:00:00.000Z`,
  }));
  const line = coverageLine({
    metric: 'views',
    granularity: 'day',
    series: { metric: 'views', granularity: 'day', rows: stored },
    calendarDays,
    firstStoredDay: calendarDays[0],
  });
  assert.ok(
    line.includes(`and ${String(calendarDays.length - stored.length - MAX_NAMED_GAP_DAYS)} more`),
    `the printed coverage line does not name the cap of ${MAX_NAMED_GAP_DAYS} and count the rest; it printed ` +
      `${JSON.stringify(line)}`,
  );
  assert.equal(/gaps/.test(line), true,
    `a series missing most of its range printed no gap sentence at all: ${JSON.stringify(line)}`);
});

// RS-SUP-C05 and RS-SUP-C06: a boundary and a gap are different facts, so the boundary
// block words each of its four situations separately and says no day at all when the
// archive records no boundary. Collapsing two of them is how a report starts placing a
// day it does not have.
test('the boundary block words each of its four situations and names no day without a boundary', () => {
  const from = '2026-09-19';
  const to = '2026-10-02';
  const inside = '2026-09-25';

  const absent = boundaryBlock(null, from, to);
  assert.equal(absent.length, 1, 'an absent boundary prints no line at all rather than one line saying so');
  assert.equal(
    /\d{4}-\d{2}-\d{2}/.test(absent[0] ?? ''),
    false,
    `an absent boundary printed a day: ${JSON.stringify(absent[0] ?? '')}`,
  );
  assert.equal(/window/.test(absent[0] ?? ''), false,
    `an absent boundary described a window it has no boundary to place against: ${JSON.stringify(absent[0] ?? '')}`);
  assert.match(String(absent[0]), /^ {2}provenance: /,
    'an absent boundary does not open with the provenance label every boundary line carries');

  // A blank record is an absent boundary, not a boundary on the empty string.
  assert.deepEqual(boundaryBlock('', from, to), absent,
    'an empty recorded boundary is worded differently from no boundary at all');

  const dated = {
    inside: boundaryBlock(inside, from, to),
    after: boundaryBlock('2026-10-09', from, to),
    before: boundaryBlock('2026-08-05', from, to),
  };
  for (const [situation, block] of Object.entries(dated)) {
    assert.equal(block.length, 1, `the "${situation}" boundary printed ${block.length} lines`);
    assert.match(String(block[0]), /^ {2}provenance: /,
      `the "${situation}" boundary line does not open with the provenance label every boundary line carries: ` +
        `${JSON.stringify(block[0] ?? '')}`);
    assert.equal(/\d{4}-\d{2}-\d{2}/.test(String(block[0])), true,
      `the "${situation}" boundary line names no day at all: ${JSON.stringify(block[0] ?? '')}`);
  }
  // Three dated situations, three different sentences: the day is the same in two of
  // them and the wording still differs, because where the day sits is the fact.
  const sentences = Object.values(dated).map((block) => String(block[0]));
  assert.equal(new Set(sentences).size, 3,
    `the three dated boundary wordings are ${JSON.stringify(sentences)}, so two of them are the same sentence`);
  assert.equal(new Set([...sentences, String(absent[0])]).size, 4,
    'the boundary block has fewer than four distinct wordings across its four situations');

  // The window is named where the day sits outside it, and the boundary inside the
  // window says what it means rather than comparing itself with the window.
  assert.ok(String(dated.before[0]).includes(`before this window of ${from} to ${to}`),
    `a boundary before the window does not say so: ${JSON.stringify(dated.before[0] ?? '')}`);
  assert.ok(String(dated.after[0]).includes(`after this window of ${from} to ${to}`),
    `a boundary after the window does not say so: ${JSON.stringify(dated.after[0] ?? '')}`);
  assert.ok(String(dated.inside[0]).startsWith('  provenance: reconstructed before'),
    `a boundary inside the window does not say the earlier days were reconstructed: ` +
      `${JSON.stringify(dated.inside[0] ?? '')}`);

  // And the four situations are the ones section 4 and RS-SUP-C05 name: a recorded
  // boundary beside the window, and no boundary at all.
  const design = section(FEATURE, '4. Command and Output Design');
  assert.match(design, /a boundary block/,
    'section 4 of docs/features/supervision-and-report.md no longer states that `--repo` adds a boundary block');
});

// RS-SUP-C05 and RS-C12: the sections section 4 publishes are the sections the command
// prints, and each of them is composed by the formatter's own exported function. The
// command is driven through the real entry point so the comparison is against what a
// terminal shows, not against a re-implementation of it.
test('the report prints the sections section 4 documents, in the words the formatter composes', async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const to = dayBefore(today, 30);
  const from = dayBefore(to, 13);
  const window14 = Array.from({ length: 14 }, (unused, index) => dayBefore(to, 13 - index));
  const refusal = 'GitHub HTTP 403: GitHub refused the star history for this token';
  const boundary = window14[6];

  const f = await reportHome(t, {
    seed(db) {
      upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: iso(Date.now()), enrolled: 1 });
      withTransaction(db, () => {
        for (const [offset, day] of window14.entries()) {
          // A value that rises day by day, so both comparisons have a real difference
          // and a real non-zero base: a percentage printed here is a percentage the
          // archive can support.
          for (const [metric, base] of /** @type {[string, number][]} */ ([
            ['clones', 1], ['unique-cloners', 1], ['unique-visitors', 10],
          ])) {
            upsertDayFact(db, {
              repositoryId: 1, metric, granularity: 'day', day, value: base + offset, source: 'collected',
              collectedAt: iso(Date.parse(`${day}T09:00:00.000Z`)),
            });
          }
        }
        // `views` is stored on two days of a fourteen-day range, so twelve days are
        // missing: more than the published cap, which is what puts the cap on screen.
        for (const day of [window14[0], window14[1]]) {
          upsertDayFact(db, {
            repositoryId: 1, metric: 'views', granularity: 'day', day, value: 5, source: 'collected',
            collectedAt: iso(Date.parse(`${day}T09:00:00.000Z`)),
          });
        }
        // The star series began before the window: a boundary, never a gap.
        for (const day of [dayBefore(window14[0], 20), dayBefore(window14[0], 19)]) {
          upsertDayFact(db, {
            repositoryId: 1, metric: 'stars', granularity: 'day', day, value: 1, source: 'backfill',
            collectedAt: iso(Date.parse(`${day}T09:00:00.000Z`)),
          });
        }
        for (const week of [window14[1], window14[8]]) {
          upsertDayFact(db, {
            repositoryId: 1, metric: 'commit-activity', granularity: 'week', day: week, value: 4,
            source: 'backfill', collectedAt: iso(Date.parse(`${week}T09:00:00.000Z`)),
          });
        }
        markBackfillRefused({ db, repositoryId: 1, reason: refusal, collectedAt: iso(Date.now()) });
      });
      stampFirstCollected(db, 1, { day: boundary, collectedAt: iso(Date.now()) });
    },
  });

  const result = await f.run(['report', '--repo', 'owner/alpha', '--from', from, '--to', to]);
  assert.equal(result.status, 0, result.stderr);
  const printed = lines(result.stdout);
  const body = result.stdout;

  // The health read over the same archive, and the formatter's own blocks composed
  // from it. Both are clock-independent for this fixture, so the command's output and
  // the module's output are the same text rather than two renderings of it.
  const db = await openArchive(f.databasePath);
  /** @type {import('../src/supervision/health.js').CollectionHealth} */
  let health;
  /** @type {import('../src/server/repo-data.js').RepositoryPage} */
  let page;
  /** @type {string[]} */
  let expectedCoverage = [];
  /** @type {string[]} */
  let expectedChange = [];
  const compared = comparedMetrics();
  try {
    health = collectionHealth({ db });
    page = readRepositoryPage({ db, owner: 'owner', name: 'alpha', from, to, clock: Date.now, today });
    expectedCoverage = page.series.map((series) => coverageLine({
      metric: series.metric,
      granularity: series.granularity,
      series,
      calendarDays: page.calendarDays,
      firstStoredDay: firstStoredDay(db, {
        repositoryId: 1, metric: series.metric, granularity: series.granularity,
      }),
    }));
    expectedChange = compared.flatMap((metric) => {
      const series = page.series.find((entry) => entry.metric === metric);
      const observations = (series?.rows ?? []).map((row) => ({ day: row.day, value: row.value }));
      return changeBlock(metric,
        sevenDayDelta({ metric, observations, range: { from, to } }),
        weekOverWeekDelta({ metric, observations, range: { from, to }, today }));
    });
  } finally {
    db.close();
  }
  assert.equal(page.status, 'known', 'the fixture archive does not hold the repository the report was asked for');

  // Section 4: "opens with its scope and a rule".
  assert.deepEqual(printed.slice(0, 2), header('owner/alpha'),
    'the report does not open with the scope and the rule section 4 describes');
  assert.match(String(printed[1]), /^-{72}$/,
    `the second line is not the rule the header prints: ${JSON.stringify(printed[1] ?? '')}`);

  // Section 4: "names the home and the instant it read".
  assert.match(body, new RegExp(`^home: ${f.home.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
    'the report does not name the home it read');
  assert.match(body, /^read at \d{4}-\d{2}-\d{2}T[\d:.]+Z \(\d{4}-\d{2}-\d{2}\)$/m,
    'the report does not name the instant it read');

  // Section 4: "the most recent run state with its counts".
  assert.ok(body.includes(runBlock(health).join('\n')),
    `the printed run block is not the formatter's runBlock output:\n${body}`);

  // Section 4: "the roll-up with `of N enrolled`".
  assert.ok(body.includes(summaryBlock(health.summary).join('\n')),
    `the printed roll-up is not the formatter's summaryBlock output:\n${body}`);
  assert.ok(body.includes(`of ${String(health.summary.enrolled)} enrolled`),
    `the roll-up does not say "of ${String(health.summary.enrolled)} enrolled" as section 4 states it does:\n${body}`);

  // Section 4: "one line per repository with its state word". The word is the binding
  // half of that sentence, and it is the repository's own word from the health read
  // rather than a paraphrase; the recorded last success, the failure streak and the
  // recorded failure kind travel beside it. The run block above is where the reason
  // sentence itself is printed, because `runBlock` prints `health.run.reason`.
  assert.ok(body.includes(repositoryLines(health.repositories).join('\n')),
    `the printed per-repository lines are not the formatter's repositoryLines output:\n${body}`);
  for (const entry of health.repositories) {
    assert.ok(
      printed.some((line) => line.startsWith(`  ${entry.repo} `) && line.includes(` ${entry.state} `)),
      `the line for ${entry.repo} does not carry the state word ${entry.state} the health read reported`,
    );
    assert.equal(printed.filter((line) => line.startsWith(`  ${entry.repo} `)).length, 1,
      `${entry.repo} is reported on ${String(printed.filter((line) => line.startsWith(`  ${entry.repo} `)).length)} ` +
      'lines; the report prints one line per enrolled repository');
  }

  // Section 4: "`--from` and `--to` narrow the window".
  assert.ok(body.includes(`coverage: owner/alpha ${from} to ${to}`),
    `the report does not print the window it was given:\n${body}`);

  // Section 4: "a coverage line per series". The series and their granularity are the
  // page read's own list, so a metric added to the archive has to be printed here.
  const coverage = body.slice(body.indexOf(`coverage: owner/alpha ${from} to ${to}`));
  assert.ok(coverage.includes(expectedCoverage.join('\n')),
    'the printed coverage lines are not the formatter\'s coverageLine output for the page\'s own series:\n' +
      `${body}\nexpected:\n${expectedCoverage.join('\n')}`);
  assert.equal(page.series.length, PAGE_METRICS.length,
    `the page read ${page.series.length} series and PAGE_METRICS names ${PAGE_METRICS.length}`);

  // RS-SUP-C06: a week-granularity series is described in weeks, never against a daily
  // calendar. The page's own granularity says which lines those are.
  for (const entry of PAGE_METRICS) {
    const label = new RegExp(`^ {2}${entry.metric} +`);
    const printedLine = printed.find((candidate) => label.test(candidate));
    assert.ok(printedLine !== undefined, `no coverage line was printed for ${entry.metric}, which PAGE_METRICS lists`);
    if (entry.granularity === 'week') {
      assert.match(String(printedLine), /\bweeks?\b/,
        `${entry.metric} is stored weekly and was not described in weeks: ${JSON.stringify(printedLine)}`);
      assert.equal(/days stored/.test(String(printedLine)), false,
        `${entry.metric} is a weekly series and was described in days: ${JSON.stringify(printedLine)}`);
    } else {
      assert.equal(/\bweeks?\b/.test(String(printedLine)), false,
        `${entry.metric} is a daily series and was described in weeks: ${JSON.stringify(printedLine)}`);
    }
  }

  // Section 4: "a refusal line".
  assert.deepEqual(refusalLine(refusal), [`  star history: absent ${EM_DASH} ${refusal}`],
    'the formatter no longer words a recorded star-history refusal the way the report prints it');
  assert.ok(body.includes(refusalLine(refusal)[0] ?? ''), `the recorded refusal is not printed:\n${body}`);

  // Section 4: "a boundary block".
  assert.ok(body.includes(boundaryBlock(boundary, from, to).join('\n')),
    `the printed boundary block is not the formatter's boundaryBlock output:\n${body}`);

  // Section 4: "four change blocks", and RS-SUP-C06's "absolute values are always
  // printed beside a percentage".
  const change = body.slice(body.indexOf(`\nchange: ${page.owner}/${page.name}\n`));
  assert.ok(change.includes(expectedChange.join('\n')),
    `the printed change blocks are not the formatter's changeBlock output:\n${body}\nexpected:\n${expectedChange.join('\n')}`);
  const changeBlocks = printed.filter((line) => /^ {2}[a-z][a-z-]*$/.test(line) && change.includes(`\n${line}\n`));
  assert.equal(changeBlocks.length, compared.length,
    `the report printed ${String(changeBlocks.length)} change blocks and ${REPORT_COMMAND} compares ` +
      `${String(compared.length)} metrics`);
  // The number of blocks section 4 publishes in words is that same number, so a fourth
  // block added to the command has to be documented there and vice versa.
  const published = statedNumber(
    section(FEATURE, '4. Command and Output Design'),
    /a refusal line, a boundary block and (\S+) change blocks/,
    'section 4 of docs/features/supervision-and-report.md',
  );
  assert.equal(
    published,
    compared.length,
    `section 4 of docs/features/supervision-and-report.md states that \`--repo\` adds ${String(published)} change ` +
      `blocks and ${REPORT_COMMAND} compares ${String(compared.length)} metrics`,
  );
  for (const label of ['seven-day', 'week-over-week']) {
    const rows = printed.filter((line) => line.trimStart().startsWith(`${label} `));
    assert.equal(rows.length, compared.length,
      `each compared metric must carry one ${label} row, and the report printed ${String(rows.length)}`);
  }
  const summaries = expectedChange.filter((line) => /^ {4}(seven-day|week-over-week)/.test(line));
  assert.equal(summaries.length, compared.length * 2,
    `the report printed ${String(summaries.length)} comparison sentences for ${String(compared.length)} ` +
      'compared metrics, which is two each');
  const withPercentage = summaries.filter((line) => /%/.test(line));
  assert.ok(withPercentage.length > 0,
    'no printed comparison carried a percentage, so the rule that one is never printed without its absolute ' +
      'value beside it would pass without proving anything');
  for (const line of withPercentage) {
    assert.match(line, /the difference is -?\d+/,
      `a printed comparison reported a percentage without the absolute difference beside it: ${JSON.stringify(line)}`);
  }
  // And the other half of the same rule: a comparison that reports no percentage says
  // why, so the figure is never dropped in silence beside a real absolute value.
  for (const line of summaries.filter((candidate) => !/%/.test(candidate))) {
    assert.match(line, /insufficient data|and no percentage is reported/,
      `a printed comparison carried no percentage and named no reason for omitting it: ${JSON.stringify(line)}`);
  }

  // The sections appear in the order section 4 lists them, so a section added to the
  // document and not to the output, or the other way round, is caught here.
  const labels = [
    '\nrun\n',
    `\nrepositories (${String(health.summary.enrolled)})\n`,
    `coverage: owner/alpha ${from} to ${to}`,
    '\n  provenance: ',
    `\nchange: ${page.owner}/${page.name}\n`,
  ];
  const at = labels.map((label) => body.indexOf(label));
  assert.equal(at.every((index) => index >= 0), true,
    `the report does not print every section section 4 lists; it printed:\n${body}`);
  assert.deepEqual([...at].sort((left, right) => left - right), at,
    'the report printed its sections out of the order section 4 states them in');
});

// RS-SUP-C05 and RS-C09: a report that read the archive succeeded, whatever states it
// reported. A scheduled digest must not fail the run because a repository needs
// attention, so this drives the real entry point once per state the health read can
// report and asserts the exit code is 0 for each of them.
test('a report that read the archive exits 0 while printing a degraded repository', async (t) => {
  const recent = iso(Date.now() - 2 * 60 * 60 * 1000);
  const stale = iso(Date.now() - (STALL_THRESHOLD_HOURS + 4) * 60 * 60 * 1000);
  const at = iso(Date.now() - 60 * 60 * 1000);

  /** A rate limit: recorded evidence, not a rejected credential, so the state is degraded. */
  const rateLimited = { status: 429, endpoint: '/repos/owner/alpha/traffic/clones' };
  /** A refused token: the one kind only a new credential leaves. */
  const refused = { status: 401, endpoint: '/repos/owner/alpha' };

  /** @type {{ name: string, word: string, seed: (db: import('node:sqlite').DatabaseSync) => void }[]} */
  const cases = [
    {
      name: REPOSITORY_STATE_HEALTHY,
      word: REPOSITORY_STATE_HEALTHY,
      seed(db) {
        upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: at, lastSuccessAt: recent, enrolled: 1 });
      },
    },
    {
      name: REPOSITORY_STATE_NEVER_COLLECTED,
      word: REPOSITORY_STATE_NEVER_COLLECTED,
      seed(db) {
        upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: at, enrolled: 1 });
      },
    },
    {
      name: REPOSITORY_STATE_DEGRADED,
      word: REPOSITORY_STATE_DEGRADED,
      seed(db) {
        upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: at, lastSuccessAt: recent, enrolled: 1 });
        createRunJournal({ db, clock: () => Date.parse(at) }).start();
        recordFailure({ db, repositoryId: 1, runId: runIdAt(db), error: rateLimited, collectedAt: at, repo: 'owner/alpha' });
      },
    },
    {
      name: REPOSITORY_STATE_STALLED,
      word: REPOSITORY_STATE_STALLED,
      seed(db) {
        upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: at, lastSuccessAt: stale, enrolled: 1 });
      },
    },
    {
      name: REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
      word: REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
      seed(db) {
        upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: at, lastSuccessAt: recent, enrolled: 1 });
        createRunJournal({ db, clock: () => Date.parse(at) }).start();
        recordFailure({ db, repositoryId: 1, runId: runIdAt(db), error: refused, collectedAt: at, repo: 'owner/alpha' });
      },
    },
    {
      name: REPOSITORY_STATE_UNAVAILABLE,
      word: REPOSITORY_STATE_UNAVAILABLE,
      seed(db) {
        upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: at, lastSuccessAt: recent, enrolled: 1 });
        withTransaction(db, () => markUnavailable({
          db, repositoryId: 1, reason: 'GitHub answered HTTP 404 for owner/alpha', collectedAt: at,
        }));
      },
    },
    {
      name: REPOSITORY_STATE_UNREADABLE,
      word: REPOSITORY_STATE_UNREADABLE,
      seed(db) {
        upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: at, lastSuccessAt: recent, enrolled: 1 });
        // The archive holds a success time this build cannot read, which is an unknown
        // state rather than evidence that the schedule stopped. No product writer
        // records an unparseable instant, so the row is written directly; the read
        // decides the word from what the column holds.
        db.prepare('UPDATE repositories SET last_success_at=? WHERE id=1').run('the day before yesterday');
      },
    },
  ];

  for (const entry of cases) {
    const f = await reportHome(t, { seed: entry.seed });
    const result = await f.run(['report']);

    assert.equal(
      result.status,
      0,
      `the report exited ${String(result.status)} while printing a ${entry.word} repository; RS-SUP-C05 says it ` +
        `exits 0 whenever it read the archive. stderr:\n${result.stderr}`,
    );
    const printed = lines(result.stdout);
    assert.ok(
      printed.some((line) => line.startsWith('  owner/alpha ') && line.includes(` ${entry.word} `)),
      `the report exited 0 but printed no ${entry.word} line for the repository it read:\n${result.stdout}`,
    );
    assert.match(result.stdout, new RegExp(`roll-up: 1 ${entry.word} of 1 enrolled`),
      `the roll-up does not count the ${entry.word} repository section 4 says it prints:\n${result.stdout}`);
    assert.deepEqual(f.stub.requests(), [],
      `the report made a request of any kind while reading a ${entry.word} archive: ${f.stub.paths().join(', ')}`);
    assert.equal(result.stdout.includes('credentials.json'), false,
      `the report named a credential path while reporting a ${entry.word} repository`);
  }
});

/**
 * The one run the archive holds, read back rather than reconstructed, because a
 * recorded failure belongs to the run that recorded it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string}
 */
function runIdAt(db) {
  const row = /** @type {{id: string}|undefined} */ (/** @type {unknown} */ (
    db.prepare('SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT 1').get()));
  assert.ok(row !== undefined, 'the fixture opened no run to attach its recorded failure to');
  return row.id;
}

/**
 * The metrics a report compares, read out of the command's own source because the
 * constant is module-private. Section 4 states how many change blocks the report adds,
 * and this is the list it is counting.
 * @returns {string[]}
 */
function comparedMetrics() {
  const source = read(path.join(ROOT, REPORT_COMMAND));
  const declaration = /const COMPARED_METRICS = (\[[^\]]*\]);/.exec(source);
  assert.ok(declaration !== null, `${REPORT_COMMAND} declares no COMPARED_METRICS literal to compare against`);
  return [...(declaration[1] ?? '').matchAll(/'([a-z][a-z-]*)'/g)].map((match) => match[1] ?? '');
}