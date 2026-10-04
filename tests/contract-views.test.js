import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stampFirstCollected } from '../src/backfill/provenance.js';
import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../src/collect/traffic.js';
import { calendarDays, upsertDayFact } from '../src/db/day-series-repo.js';
import {
  appendRun, completeRun, openArchive, upsertRepository, withTransaction,
} from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';
import { escapeUrl } from '../src/server/html.js';
import { createRouter } from '../src/server/router.js';
import { HEALTH_SECTION_ORDER } from '../src/server/views/health.js';
import { createViewRegistry } from '../src/server/views/index.js';
import {
  DETAIL_SECTION_ORDER,
  NO_STORED_VALUE_TEXT as DETAIL_NO_STORED_VALUE_TEXT,
} from '../src/server/views/repo-detail.js';
import {
  NO_STORED_VALUE_TEXT as LIST_NO_STORED_VALUE_TEXT,
  TRAFFIC_COLUMNS,
} from '../src/server/views/repo-list.js';
import { GAP_CELL_TEXT } from '../src/views/components/line-chart.js';
import { TRAFFIC_PERMISSION } from '../src/supervision/errors.js';
import {
  REPOSITORY_STATE_DEGRADED,
  REPOSITORY_STATE_HEALTHY,
  REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
  REPOSITORY_STATE_NEVER_COLLECTED,
  REPOSITORY_STATE_PRECEDENCE,
  REPOSITORY_STATE_STALLED,
  REPOSITORY_STATE_UNAVAILABLE,
  REPOSITORY_STATE_UNREADABLE,
  RUN_STATE_COMPLETED,
  RUN_STATE_DEGRADED,
  RUN_STATE_NEVER_RUN,
  RUN_STATE_UNCLOSED,
  SUMMARY_STATE_EMPTY,
  statePhrase,
} from '../src/supervision/health.js';
import { recordFailure, recordSuccess } from '../src/supervision/repo-state-reporter.js';

/**
 * Section 4 of `docs/features/dashboard-views.md`, the citation of it in the detail page
 * module, and the sentences the pages print, asserted against the modules that own them.
 *
 * `src/server/views/repo-detail.js` names this document and section 4 as the authority for
 * the order in which the detail page renders its sections, and the README promises that a
 * day the archive does not hold is named rather than drawn as a zero. Nothing checked that
 * either claim: a section renamed, a section dropped from the list, a citation renumbered
 * out from under the code or a gap sentence reworded would leave every other suite green
 * while the document and the product stopped agreeing.
 *
 * Every test here reads a document as text *and* the product as the thing that renders
 * it. A test that read only the document would prove the document is self-consistent,
 * which was never in question. The direction of repair is the document's: where the prose
 * and the code disagreed, this suite names both sides and moves neither, and the two
 * defects it did find are reported with both values rather than edited away - the section
 * order, the rendered wording and the state vocabulary are all fixed behaviour.
 *
 * The pages are the product's own: `createViewRegistry` mounts them, `createRouter`
 * dispatches the three routes and the registry answers `/health` in front of it, all over
 * a real migrated archive a temporary home holds. Only the clock is injected, so a page is
 * a function of what the archive recorded rather than of when the suite ran. Every
 * repository, day, failure and unavailable row is written through the product's own
 * writers, and no request in this file reaches a host.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const FEATURE_RELATIVE = 'docs/features/dashboard-views.md';
const FEATURE = path.join(ROOT, 'docs', 'features', 'dashboard-views.md');
const PRD_RELATIVE = 'docs/PRD.md';
const PRD = path.join(ROOT, 'docs', 'PRD.md');
const README = path.join(ROOT, 'README.md');
const DETAIL_SOURCE_RELATIVE = 'src/server/views/repo-detail.js';
const DETAIL_SOURCE = path.join(ROOT, 'src', 'server', 'views', 'repo-detail.js');

/**
 * The heading the code's citation names: section 4 of the feature document, by number
 * and title. A document that renumbers or renames the section its source files cite is
 * failing this suite, which is the point - the citation is a claim about a heading that
 * still exists.
 */
const DETAIL_DESIGN_HEADING = '4. Page and Section Design';
const DETAIL_DESIGN_NUMBER = 4;

/** The requirement blocks section 3 publishes, read as the JSON they are written in. */
const GAP_REQUIREMENT = 'RS-VWS-C03';
const STATE_REQUIREMENT = 'RS-VWS-C02';

/** The PRD sections this suite reads a claim out of. */
const GLOSSARY_HEADING = '15. Glossary';
const STATES_HEADING = '10. System States / Lifecycle';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The day before an ISO day, so a window that stops short of a hole is stated in terms of
 * the hole rather than by a second date written into a test.
 * @param {string} day
 * @returns {string}
 */
function dayBefore(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** The reference day every page resolves a default window to, and the instant it is read at. */
const TODAY = '2026-10-02';
const READ_AT_MS = Date.parse('2026-10-02T12:00:00.000Z');
const OWNER = 'maintainer';
const RUN_ONE = '2026-09-19T06:00:00.000Z';
const RUN_TWO = '2026-10-02T06:00:00.000Z';
/** A third run that begins after the second closed, and never closes. */
const RUN_THREE = '2026-10-02T07:00:00.000Z';
const RECENT_AT = new Date(READ_AT_MS - 5 * HOUR_MS).toISOString();
const STALE_AT = new Date(READ_AT_MS - 31 * HOUR_MS).toISOString();
const FAILED_AT = new Date(READ_AT_MS - 4 * HOUR_MS).toISOString();

/** The four traffic metrics, in the archive's own order. */
const TRAFFIC_METRICS = [CLONES_METRIC, UNIQUE_CLONERS_METRIC, VIEWS_METRIC, UNIQUE_VISITORS_METRIC];

/**
 * Every word a repository can report, the run words, and the roll-up word: read from the
 * health read's own exports rather than written out here, so this file cannot become a
 * second source of the vocabulary. `degraded` is both a repository state and a run state,
 * so the union is what a surface can be asked to render.
 */
const RETURNABLE_WORDS = /** @type {ReadonlySet<string>} */ (new Set([
  ...REPOSITORY_STATE_PRECEDENCE, ...[RUN_STATE_NEVER_RUN, RUN_STATE_UNCLOSED, RUN_STATE_COMPLETED,
    RUN_STATE_DEGRADED], SUMMARY_STATE_EMPTY,
]));

/** The four run words, kept apart because a run sentence is announced in a different place. */
const RUN_WORDS = Object.freeze([
  RUN_STATE_NEVER_RUN, RUN_STATE_UNCLOSED, RUN_STATE_COMPLETED, RUN_STATE_DEGRADED,
]);

/**
 * @typedef {object} ArchivePlan
 * @property {string} today The reference day the window ends on, and the day a route with
 *   no bound resolves to.
 * @property {number} nowMs The instant every health read is judged against.
 * @property {string} from The first day of the default window.
 * @property {string} query The query every page request carries, selecting the window.
 * @property {string[]} window Every calendar day the window covers.
 * @property {string} archiveHole The one interior day no run recorded for `archive`.
 * @property {string} patchyHoleA The first of the two interior days no run recorded for `patchy`.
 * @property {string} patchyHoleB The second of them.
 */

/** @returns {ArchivePlan} */
function planArchive() {
  const from = '2026-09-19';
  const to = TODAY;
  return {
    today: to,
    nowMs: READ_AT_MS,
    from,
    query: `from=${from}&to=${to}`,
    window: calendarDays(from, to),
    archiveHole: '2026-09-26',
    patchyHoleA: '2026-09-21',
    patchyHoleB: '2026-09-28',
  };
}

/** The one plan every fixture in this file shares. @type {ArchivePlan} */
const PLAN = planArchive();

/**
 * How a count of gap days is written in a sentence, so the assertion can name the figure
 * the page is expected to print.
 * @param {number} count
 * @returns {string}
 */
function countedDays(count) {
  return `${String(count)} ${count === 1 ? 'day' : 'days'}`;
}

/**
 * The value one stored day carries for one metric, by the day's position in the window.
 * A test knows these numbers because it wrote them, so a page that summed where it should
 * show a last value - or the other way round - is a failure rather than a difference of
 * wording.
 * @type {Readonly<Record<string, (index: number) => number>>}
 */
const STORED_VALUE = Object.freeze({
  [CLONES_METRIC]: (/** @type {number} */ index) => 10 + index,
  [UNIQUE_CLONERS_METRIC]: (/** @type {number} */ index) => 4 + (index % 3),
  [VIEWS_METRIC]: (/** @type {number} */ index) => 100 + index * 5,
  [UNIQUE_VISITORS_METRIC]: (/** @type {number} */ index) => 20 + (index % 4),
});

/**
 * What one repository holds. Nine repositories, one per state the health read can report
 * plus two more whose stored days are shaped to make the gap sentences countable.
 *
 * | repository | what it holds |
 * |------------|---------------|
 * | `archive` | every day of the window but one, all four metrics, healthy |
 * | `clones-only` | every day of the window, one metric only: three absent series |
 * | `patchy` | every day of the window but two: a second gap count to compare |
 * | `fresh` | enrolled and never collected: the first-connect detail page |
 * | `flaky` | a recorded 429: degraded |
 * | `lapsed` | a recorded 403 on traffic: needs-re-authentication |
 * | `stale` | a success thirty-one hours old: stalled |
 * | `retired` | a lifecycle the archive marked unavailable |
 * | `odd` | a recorded success this build cannot read: unreadable |
 */

/** The repository whose detail page carries the gap, and the two whose cells do not. */
const CHARTED = 'archive';
const CLONES_ONLY = 'clones-only';
const PATCHY = 'patchy';
const FRESH = 'fresh';
const FLAKY = 'flaky';
const LAPSED = 'lapsed';
const STALE = 'stale';
const RETIRED = 'retired';
const ODD = 'odd';

/**
 * The days of the window each repository holds nothing for, so a count a page prints is
 * compared with the count this file wrote rather than with a number typed into a test. A
 * repository absent from this table holds every day of the window and has no gap to count.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const GAP_DAYS = Object.freeze({
  [CHARTED]: [PLAN.archiveHole],
  [PATCHY]: [PLAN.patchyHoleA, PLAN.patchyHoleB],
});

/**
 * The stored days of the window for one repository: everything the window holds but its gaps.
 * @param {string} name
 * @returns {string[]}
 */
function storedDays(name) {
  return PLAN.window.filter((day) => !(GAP_DAYS[name] ?? []).includes(day));
}

/**
 * How many days of the window one repository holds nothing for. The figure is read off this
 * file's own gap table rather than typed into an assertion, so a page that prints the wrong
 * count cannot pass by agreeing with a number the test happened to write.
 * @param {string} name
 * @returns {number}
 */
function gapsOf(name) {
  return (GAP_DAYS[name] ?? []).length;
}

/** Every repository the seed enrols, with the state its evidence puts it in. */
const ENROLLED = [
  { name: CHARTED, state: REPOSITORY_STATE_HEALTHY },
  { name: CLONES_ONLY, state: REPOSITORY_STATE_HEALTHY },
  { name: PATCHY, state: REPOSITORY_STATE_HEALTHY },
  { name: FRESH, state: REPOSITORY_STATE_NEVER_COLLECTED },
  { name: FLAKY, state: REPOSITORY_STATE_DEGRADED },
  { name: LAPSED, state: REPOSITORY_STATE_NEEDS_REAUTHENTICATION },
  { name: STALE, state: REPOSITORY_STATE_STALLED },
  { name: RETIRED, state: REPOSITORY_STATE_UNAVAILABLE },
  { name: ODD, state: REPOSITORY_STATE_UNREADABLE },
];

/** @param {string} file @returns {string} */
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
 * One `##` section of a document, verbatim. A heading that is not there fails the test
 * rather than matching the whole document by accident, which is what a citation
 * renumbered away from section 4 needs.
 * @param {string} file
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function sectionText(file, heading) {
  const page = read(file);
  const marker = `## ${heading}\n`;
  assert.ok(page.includes(marker), `${heading} is not a section of the document this suite read`);
  const body = page.slice(page.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * The document's own numbering, read from its headings: section number to the heading it
 * publishes. The code's citation is resolved through this rather than trusted, so a
 * renumbered section is a failure that names where it went.
 * @param {string} file
 * @returns {Map<number, string>}
 */
function documentSections(file) {
  const headings = new Map();
  for (const match of read(file).matchAll(/^## (\d+)\. (.+)$/gm)) {
    headings.set(Number(match[1] ?? ''), match[2] ?? '');
  }
  assert.ok(headings.size > 0, 'the document this suite read publishes no numbered section for a citation to resolve against');
  return headings;
}

/**
 * One requirement block from section 3 of the feature document, parsed as the JSON it is
 * written in rather than matched as prose - so a document that reformats the block is
 * reported by the parser rather than silently read as a missing claim.
 * @param {string} id
 * @returns {string}
 */
function requirementText(id) {
  const page = read(FEATURE);
  const pattern = new RegExp(`\\{"id":"${id}","kind":"[a-z-]+","text":"((?:[^"\\\\]|\\\\.)*)"\\}`);
  const match = pattern.exec(page);
  assert.ok(match !== null, `${FEATURE_RELATIVE} publishes no ${id} requirement block for this suite to assert`);
  return JSON.parse(`"${match[1] ?? ''}"`);
}

/**
 * The wording the PRD's glossary publishes for one term: the row's own words after its
 * last semicolon, which is where a definition states the short form it is known by. The
 * pages print this clause verbatim, so it is read out of the document rather than typed
 * here - a glossary edited away from what the pages print fails the assertion that
 * follows it instead of passing on a string both sides happen to share.
 * @param {string} term
 * @returns {string}
 */
function glossaryClause(term) {
  const row = sectionText(PRD, GLOSSARY_HEADING).split('\n')
    .find((line) => new RegExp(`^\\|\\s*${term}\\s*\\|`).test(line));
  assert.ok(row !== undefined, `${PRD_RELATIVE} section ${GLOSSARY_HEADING} has no glossary row for ${term}`);
  const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
  const definition = cells[cells.length - 1] ?? '';
  const clause = (definition.split(';').pop() ?? '').trim();
  assert.notEqual(clause, '',
    `the glossary row for ${term} states no short form after a semicolon; it reads ${JSON.stringify(definition)}`);
  return clause;
}

/**
 * The clause RS-VWS-C03 publishes for an absent series, split into the words either side
 * of its demonstrative. The requirement states the fact in prose - "no stored value in
 * the range" - while a page states it with the demonstrative that fits the page it is on
 * ("no stored value in this range"), so both halves are the requirement's own words and
 * only the word between them belongs to the page.
 * @returns {{before: string, after: string}}
 */
function absentSeriesWords() {
  const phrase = /no stored value in (the|this) range/.exec(requirementText(GAP_REQUIREMENT));
  assert.ok(phrase !== null,
    `${FEATURE_RELATIVE} no longer publishes the absent-series wording ${GAP_REQUIREMENT} is asserted for; it reads ` +
      JSON.stringify(requirementText(GAP_REQUIREMENT)));
  const words = (phrase[0] ?? '').split(' ');
  return {
    before: words.slice(0, words.length - 2).join(' '),
    after: words.slice(words.length - 1).join(' '),
  };
}

/**
 * Whether a printed sentence carries a requirement's own words, in order, with only the
 * demonstrative free to differ.
 * @param {string} printed What a page printed.
 * @param {{before: string, after: string}} words
 * @returns {boolean}
 */
function carriesWords(printed, words) {
  const start = printed.indexOf(words.before);
  return start !== -1 && printed.indexOf(words.after, start + words.before.length) !== -1;
}

/**
 * The documentation comment block a position in a source file sits inside, as one flat
 * string. The citation this suite protects lives in one of these, so it is read from the
 * file rather than remembered; the block is found by its own delimiters rather than by
 * walking lines, so a comment that ends on the line the position falls in is still read.
 * @param {string} source
 * @param {number} at Index inside the comment, or of the declaration below it.
 * @returns {string}
 */
function commentAt(source, at) {
  const open = source.lastIndexOf('/**', at);
  assert.notEqual(open, -1, `no documentation comment opens above index ${String(at)} of this source file`);
  const close = source.indexOf('*/', open);
  assert.notEqual(close, -1, 'the documentation comment above that position is never closed');
  return flatten(source.slice(open + 3, close)
    .split('\n')
    .map((line) => line.trim().replace(/^\*\s?/, ''))
    .join(' '));
}

/**
 * The nine section entries section 4 publishes, in the order it lists them: the ordinal as
 * written, the bold label, and the description after the em dash.
 * @returns {{ordinal: number, label: string, description: string}[]}
 */
function designItems() {
  const design = sectionText(FEATURE, DETAIL_DESIGN_HEADING);
  const numbered = design.match(/^\d+\.\s+/gm) ?? [];
  const items = [...design.matchAll(/^(\d+)\.\s+\*\*(.+?)\*\*\s+\u2014\s+(.+)$/gm)]
    .map((match) => ({
      ordinal: Number(match[1] ?? ''),
      label: (match[2] ?? '').trim(),
      description: (match[3] ?? '').trim(),
    }));
  assert.equal(items.length, numbered.length,
    `${FEATURE_RELATIVE} section ${DETAIL_DESIGN_HEADING} lists ${numbered.length} numbered sections and this suite ` +
      `read ${items.length} of them as "N. **Label** \u2014 description"; the labels it could not read are ` +
      JSON.stringify(numbered));
  return items;
}

/** The key a section carries, written as the words section 4 names it in. @param {string} key */
function keyAsWords(key) {
  return key.replaceAll('-', ' ');
}

/**
 * The `h2` sections of a served document, in document order, as the key each one labels
 * itself with. Every section is a labelled landmark whose heading id is its own key, so this
 * is the order the module exported as it reached a reader.
 * @param {string} body
 * @returns {string[]}
 */
function sectionKeys(body) {
  return [...body.matchAll(/<h2 id="([a-z-]+)-heading"/g)].map((match) => match[1] ?? '');
}

/**
 * Every state a served document prints: the element's own `data-state`, the state word it
 * shows inside that element, and the reason beside it. Both halves of RS-VWS-C02 are read
 * from the same markup, because the requirement is about one element carrying a word, an
 * attribute and a sentence together.
 * @param {string} body
 * @returns {{attribute: string, word: string, reason: string, markup: string}[]}
 */
function stateSentences(body) {
  const pattern = /<(\w+)[^>]*\bdata-state="([^"]*)"[^>]*>\s*<span class="state-word">([^<]*)<\/span>\s*<span class="state-reason">([^<]*)<\/span>/g;
  return [...body.matchAll(pattern)].map((match) => ({
    attribute: match[2] ?? '',
    word: match[3] ?? '',
    reason: match[4] ?? '',
    markup: match[0] ?? '',
  }));
}

/**
 * One list row: the cells of the repository's row, keyed by the metric each value cell
 * names, plus the gap cell and the state cell.
 * @param {string} body
 * @param {string} repo `owner/name` as the row names it.
 * @returns {{row: string, cells: Map<string, {state: string, figure: string, note: string}>,
 *   gap: string, gapState: string, state: string, reason: string}}
 */
function listRow(body, repo) {
  const row = new RegExp(`<tr data-repository="${repo}">([\\s\\S]*?)</tr>`).exec(body)?.[1] ?? '';
  assert.notEqual(row, '', `no list row names ${repo}; the rows on this page are ` +
    JSON.stringify([...body.matchAll(/<tr data-repository="([^"]*)"/g)].map((match) => match[1] ?? '')));
  /** @type {Map<string, {state: string, figure: string, note: string}>} */
  const cells = new Map();
  for (const [, metric, state, cell] of row.matchAll(
    /<td class="value(?: value-missing)?" data-metric="([^"]*)" data-state="([^"]*)">([\s\S]*?)<\/td>/g)) {
    cells.set(metric ?? '', {
      state: state ?? '',
      figure: /<span class="figure(?: figure-missing)?">([^<]*)<\/span>/.exec(cell ?? '')?.[1] ?? '',
      note: /<span class="figure-note">([^<]*)<\/span>/.exec(cell ?? '')?.[1] ?? '',
    });
  }
  const gap = /<td class="coverage" data-state="[^"]*">([\s\S]*?)<\/td>/.exec(row)?.[1] ?? '';
  const gapState = /<td class="coverage" data-state="([^"]*)"/.exec(row)?.[1] ?? '';
  const state = /<span class="state-word">([^<]*)<\/span>/.exec(row)?.[1] ?? '';
  const reason = /<span class="state-reason">([^<]*)<\/span>/.exec(row)?.[1] ?? '';
  return { row, cells, gap, gapState, state, reason };
}

/**
 * The coverage sentence the detail page prints under its numbers, for the gaps in the
 * window.
 * @param {string} body
 * @returns {{state: string, text: string}}
 */
function detailCoverage(body) {
  const found = /<p class="coverage" data-state="([^"]*)">([\s\S]*?)<\/p>/.exec(body);
  return { state: found?.[1] ?? '', text: found?.[2] ?? '' };
}

/**
 * The text alternative a chart states: the caption the component renders beside the plot,
 * read whole rather than as one sentence, because the gap sentence is one of several.
 * @param {string} body
 * @param {string} metric
 * @returns {string}
 */
function chartCaption(body, metric) {
  const caption = new RegExp(`<figcaption class="chart-caption" id="chart-${metric}-caption">([\\s\\S]*?)</figcaption>`)
    .exec(body)?.[1] ?? '';
  assert.notEqual(caption, '', `the ${metric} figure is rendered; the page must carry a caption beside every chart`);
  return caption;
}

/**
 * The row the chart's own table prints for one day of the window.
 * @param {string} body
 * @param {string} metric
 * @param {string} day
 * @returns {string}
 */
function chartRow(body, metric, day) {
  const table = new RegExp(`<table class="chart-table" id="chart-${metric}-table">([\\s\\S]*?)</table>`)
    .exec(body)?.[1] ?? '';
  const row = new RegExp(`<tr class="(chart-row(?: chart-row-gap)?)"><th scope="row">${day}</th>([\\s\\S]*?)</tr>`)
    .exec(table)?.[0] ?? '';
  assert.notEqual(row, '', `the ${metric} table prints no row for ${day}`);
  return row;
}

/**
 * The one sentence in a text alternative that carries the published clause, so the
 * assertion is about that sentence rather than about a substring somewhere in a caption.
 * @param {string} text
 * @param {string} clause
 * @returns {string}
 */
function clauseSentence(text, clause) {
  const sentence = text.split(/(?<=\.)\s+/)
    .find((candidate) => candidate.includes(clause));
  assert.ok(sentence !== undefined, `no sentence here carries the published clause ${JSON.stringify(clause)}; the text is ` +
    JSON.stringify(text));
  return sentence;
}

/**
 * @param {Database} db
 * @param {number} id
 * @param {string} name
 * @param {string} lastSeenAt
 */
function enrol(db, id, name, lastSeenAt) {
  upsertRepository(db, { id, owner: OWNER, name, lastSeenAt, enrolled: 1 });
}

/**
 * Write one stored day of the named metrics, at the value the window's position gives it,
 * the way a run or a first-connect backfill writes them.
 * @param {Database} db
 * @param {number} repositoryId
 * @param {string} day
 * @param {'backfill'|'collected'} source
 * @param {readonly string[]} metrics
 */
function writeDays(db, repositoryId, day, source, metrics) {
  const index = PLAN.window.indexOf(day);
  for (const metric of metrics) {
    upsertDayFact(db, {
      repositoryId, metric, granularity: 'day', day,
      value: (STORED_VALUE[metric] ?? (() => 1))(index),
      source, collectedAt: RECENT_AT,
    });
  }
}

/**
 * The default seed: nine repositories covering the seven states the health read can report,
 * with stored traffic days shaped so the gap sentences are countable, and a run that closed
 * with every repository collected.
 *
 * `archive` is stamped with a boundary inside its window, so the days before it are
 * reconstructed on first connect and the days after it are collected - which is the shape
 * the provenance section has to tell apart.
 * @param {Database} db
 */
function seedEveryState(db) {
  appendRun(db, { id: 'run-1', startedAt: RUN_ONE });
  appendRun(db, { id: 'run-2', startedAt: RUN_TWO });

  withTransaction(db, () => {
    enrol(db, 1, CHARTED, RUN_ONE);
    for (const day of storedDays(CHARTED)) {
      writeDays(db, 1, day, day >= PLAN.archiveHole ? 'collected' : 'backfill', TRAFFIC_METRICS);
    }
    // One metric only, every day of the window: three absent series and a complete
    // coverage cell, which is the other half of the gap claim.
    enrol(db, 2, CLONES_ONLY, RUN_ONE);
    for (const day of PLAN.window) writeDays(db, 2, day, 'collected', [CLONES_METRIC]);
    // Two holes rather than one, so the count a page prints has to be the count rather
    // than the only number available.
    enrol(db, 3, PATCHY, RUN_ONE);
    for (const day of storedDays(PATCHY)) writeDays(db, 3, day, 'collected', TRAFFIC_METRICS);
    enrol(db, 4, FRESH, RUN_ONE);
    enrol(db, 5, FLAKY, RUN_ONE);
    enrol(db, 6, LAPSED, RUN_ONE);
    enrol(db, 7, STALE, RUN_ONE);
    upsertRepository(db, {
      id: 8, owner: OWNER, name: RETIRED, lastSeenAt: RECENT_AT, enrolled: 1,
      lifecycle: 'unavailable',
      unavailableReason: `GitHub answered HTTP 404 for ${OWNER}/${RETIRED}: the repository does not exist`,
    });
    enrol(db, 9, ODD, RUN_ONE);
  });

  stampFirstCollected(db, 1, { day: PLAN.archiveHole, collectedAt: RECENT_AT });
  stampFirstCollected(db, 2, { day: PLAN.from, collectedAt: RECENT_AT });
  stampFirstCollected(db, 3, { day: PLAN.from, collectedAt: RECENT_AT });
  recordSuccess({ db, repositoryId: 1, collectedAt: RECENT_AT });
  recordSuccess({ db, repositoryId: 2, collectedAt: RECENT_AT });
  recordSuccess({ db, repositoryId: 3, collectedAt: RECENT_AT });
  recordFailure({
    db, repositoryId: 5, runId: 'run-2', repo: `${OWNER}/${FLAKY}`, endpointType: 'traffic',
    error: { status: 429 }, collectedAt: FAILED_AT,
  });
  recordSuccess({ db, repositoryId: 6, collectedAt: RECENT_AT });
  recordFailure({
    db, repositoryId: 6, runId: 'run-2', repo: `${OWNER}/${LAPSED}`, endpointType: 'traffic',
    error: { status: 403 }, collectedAt: FAILED_AT,
  });
  recordSuccess({ db, repositoryId: 7, collectedAt: STALE_AT });
  recordSuccess({ db, repositoryId: 9, collectedAt: RECENT_AT });
  // A recorded success this build cannot read, written as the raw value an archive that
  // predates the product's timestamp validation could hold. Every product write refuses
  // such a value, which is why the `unreadable` state exists.
  db.prepare('UPDATE repositories SET last_success_at=? WHERE id=?').run('the day before yesterday', 9);
  completeRun(db, 'run-2', {
    closedAt: RECENT_AT, status: 'completed', successCount: 5, failureCount: 0,
    requestCount: 31, durationMs: 4200,
  });
}

/**
 * The same archive with a third run that began and never closed, so the run word the index
 * page announces is the one an interrupted run produces rather than the one a closed run
 * does.
 * @param {Database} db
 */
function seedOpenRun(db) {
  seedEveryState(db);
  appendRun(db, { id: 'run-3', startedAt: RUN_THREE });
}

/**
 * @typedef {object} ArchiveFixture
 * @property {Database} db The open archive every page read.
 * @property {(url: string) => Promise<{status: number, body: string}>} page Render one URL.
 */

/**
 * A temporary home holding a migrated archive, with the product's own registry in front of
 * the product's own router: the index, the list and the detail pages through the router, the
 * health page through the registry's own route.
 * @param {import('node:test').TestContext} t
 * @param {string} prefix Distinguishes each fixture's temporary directory.
 * @param {(db: Database) => void} [seed]
 * @returns {Promise<ArchiveFixture>}
 */
async function archive(t, prefix, seed = seedEveryState) {
  const root = mkdtempSync(`/tmp/opencode/repo-signal-contract-views-${prefix}-`);
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  seed(db);
  const registry = createViewRegistry({ db, clock: () => PLAN.nowMs, today: PLAN.today });
  const router = createRouter({ views: registry.views, hasRepository: registry.hasRepository });
  const answer = registry.answerOwnRoutes(router);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    page: /** @type {(url: string) => Promise<{status: number, body: string}>} */ (
      async (/** @type {string} */ url) => {
        const response = await answer(/** @type {any} */ ({ url }));
        return typeof response === 'string' ? { status: 200, body: response } : response;
      }),
  };
}

/** @param {string} name @returns {string} */
function detailUrl(name) {
  return `/repo/${escapeUrl(OWNER)}/${escapeUrl(name)}?${PLAN.query}`;
}

/** @param {string} name @returns {string} */
function repoPath(name) {
  return `${OWNER}/${name}`;
}

// RS-C12 and this feature's acceptance criterion 6: the order section 4 publishes is the
// order the module exports. The correspondence is the module's own section keys read as
// prose - `clones-against-stars` is "Clones against stars" - so a key that is renamed, a
// label that is reworded and a section that is dropped each fail here rather than becoming
// a difference of phrasing nobody compares.
test('section 4 lists the nine detail sections in the order the module exports', () => {
  const items = designItems();

  // The list is the whole of the published order: a section that is dropped, added or
  // duplicated is a count that no longer matches the export.
  assert.equal(items.length, DETAIL_SECTION_ORDER.length,
    `${FEATURE_RELATIVE} section ${DETAIL_DESIGN_HEADING} lists ${items.length} sections and ${DETAIL_SOURCE_RELATIVE} ` +
      `exports DETAIL_SECTION_ORDER with ${DETAIL_SECTION_ORDER.length} ` +
      `(${JSON.stringify([...DETAIL_SECTION_ORDER])}); the document lists ${JSON.stringify(items.map((item) => item.label))}`);

  for (const [index, key] of DETAIL_SECTION_ORDER.entries()) {
    const item = items[index];
    assert.ok(item !== undefined,
      `section ${DETAIL_DESIGN_NUMBER} of ${FEATURE_RELATIVE} has no entry for ${key}, the section ` +
        `${DETAIL_SOURCE_RELATIVE} renders at position ${String(index + 1)}`);
    assert.equal(item.ordinal, index + 1,
      `section ${DETAIL_DESIGN_NUMBER} of ${FEATURE_RELATIVE} numbers ${item.label} as ${String(item.ordinal)}, which ` +
        `is position ${String(index + 1)} of the order ${DETAIL_SOURCE_RELATIVE} exports`);
    assert.equal(item.label.toLowerCase(), keyAsWords(key),
      `section ${DETAIL_DESIGN_NUMBER} of ${FEATURE_RELATIVE} names "${item.label}" at position ${String(index + 1)}, ` +
        `which is the section ${DETAIL_SOURCE_RELATIVE} exports as ${key} and renders as "${keyAsWords(key)}"`);
    assert.notEqual(item.description, '',
      `section ${DETAIL_DESIGN_NUMBER} of ${FEATURE_RELATIVE} names ${item.label} with no description of what it shows, ` +
        'which is the half of the entry that says what a reader will find there');
  }

  // The sentence that introduces the list is the claim that this order is the page's own.
  const introduction = flatten(sectionText(FEATURE, DETAIL_DESIGN_HEADING).split('\n').slice(0, 3).join(' '));
  assert.ok(/this order is the order the page renders/.test(introduction),
    `${FEATURE_RELATIVE} section ${DETAIL_DESIGN_HEADING} no longer states that the list it publishes is the order the ` +
      `page renders; it reads ${JSON.stringify(introduction)}`);
});

// RS-C12, and this task's constraint that the citation is not removed: the code names this
// document and section 4 as the authority for the order, so the citation is resolved - source
// comment to section number to the heading the document gives that number - and the section
// it lands on is the one that publishes the order.
test('the detail module still cites this document, and the citation resolves to the section that carries the order', () => {
  const source = read(DETAIL_SOURCE);
  const declaration = 'export const DETAIL_SECTION_ORDER';
  const at = source.indexOf(declaration);
  assert.notEqual(at, -1, `${DETAIL_SOURCE_RELATIVE} no longer exports DETAIL_SECTION_ORDER, so the citation this suite protects has nothing to sit on`);
  const comment = commentAt(source, at);

  assert.ok(comment.includes(FEATURE_RELATIVE),
    `the documentation comment above DETAIL_SECTION_ORDER in ${DETAIL_SOURCE_RELATIVE} no longer names ${FEATURE_RELATIVE}; ` +
      `it reads ${JSON.stringify(comment)}`);
  const reference = /\u00a7\s*(\d+)|\bsection (\d+)/.exec(comment);
  assert.ok(reference !== null,
    `the documentation comment above DETAIL_SECTION_ORDER in ${DETAIL_SOURCE_RELATIVE} cites ${FEATURE_RELATIVE} without ` +
      `naming a section number; it reads ${JSON.stringify(comment)}`);
  const cited = Number(reference[1] ?? reference[2] ?? '');

  // Resolved through the document's own numbering rather than assumed.
  const headings = documentSections(FEATURE);
  const resolved = headings.get(cited);
  assert.equal(`${String(cited)}. ${resolved ?? ''}`, DETAIL_DESIGN_HEADING,
    `${DETAIL_SOURCE_RELATIVE} cites ${FEATURE_RELATIVE} section ${String(cited)} for DETAIL_SECTION_ORDER, but that ` +
      `document numbers its sections ${JSON.stringify([...headings])}`);
  assert.equal(cited, DETAIL_DESIGN_NUMBER,
    `${DETAIL_SOURCE_RELATIVE} cites ${FEATURE_RELATIVE} section ${String(cited)} for DETAIL_SECTION_ORDER, and this ` +
      `suite holds that claim to section ${String(DETAIL_DESIGN_NUMBER)}`);
  // And the section the citation lands on is the one that publishes the order, so a
  // section that keeps its number but loses the list cannot pass.
  assert.deepEqual(designItems().map((item) => item.label.toLowerCase()),
    [...DETAIL_SECTION_ORDER].map(keyAsWords),
    `the list ${FEATURE_RELATIVE} section ${String(cited)} publishes is not the order ${DETAIL_SOURCE_RELATIVE} exports`);

  // The module's own header still states the rule that the order is the page, and points at
  // the list rather than restating it.
  const header = commentAt(source, source.indexOf('The repository detail page:'));
  assert.ok(header.includes('DETAIL_SECTION_ORDER'),
    `the header comment of ${DETAIL_SOURCE_RELATIVE} no longer points at DETAIL_SECTION_ORDER; it reads ` +
      JSON.stringify(header));
  // And the comment it reads for the citation is the one directly above the export, so a
  // comment moved to the top of the file cannot stand in for the citation's own.
  assert.equal(commentAt(source, at), comment,
    `the comment this suite read for the citation of ${FEATURE_RELATIVE} in ${DETAIL_SOURCE_RELATIVE} is not the one ` +
      'immediately above DETAIL_SECTION_ORDER');
});

// The rendered order is the documented order: the page is asked, not the export read a
// second time. Every section is asserted present, in position, because a section the page
// dropped and the export forgot would agree with each other and with nothing else.
test('the page renders its nine sections in the order section 4 lists', async (t) => {
  const f = await archive(t, 'section-order');

  const detail = await f.page(detailUrl(CHARTED));
  assert.equal(detail.status, 200, `the ${CHARTED} detail page was not served`);

  const rendered = sectionKeys(detail.body);
  assert.deepEqual(rendered, [...DETAIL_SECTION_ORDER],
    `the ${CHARTED} detail page rendered ${JSON.stringify(rendered)} and ${DETAIL_SOURCE_RELATIVE} exports ` +
      `${JSON.stringify([...DETAIL_SECTION_ORDER])}`);
  assert.deepEqual(rendered.map((key) => keyAsWords(key)),
    designItems().map((item) => item.label.toLowerCase()),
    `the sections ${CHARTED} rendered, in the order it rendered them, are not the sections ${FEATURE_RELATIVE} section ` +
      `${DETAIL_DESIGN_NUMBER} publishes`);

  // Each section is the labelled landmark its own key names, so a section that kept its
  // heading but lost its identity is a failure here rather than a reading difficulty.
  for (const key of DETAIL_SECTION_ORDER) {
    assert.ok(detail.body.includes(`data-section="${key}"`),
      `the ${CHARTED} detail page has no section labelled ${key}; it rendered ${JSON.stringify(rendered)}`);
  }
});

// RS-VWS-C03's first clause and the README's promise that a day the archive does not hold is
// named rather than written as a zero. The clause the pages print is read out of the PRD's
// own glossary row, so a glossary edited away from the pages - or pages reworded away from
// the glossary - fails with both sides named.
test('the gap sentence the pages print is the clause the PRD publishes, with the count and the named days', async (t) => {
  const clause = glossaryClause('Gap');
  const f = await archive(t, 'gap-wording');

  // The README's own half of the claim: a gap is stored as absent, never as a zero.
  const promises = flatten(read(README));
  assert.ok(promises.includes('It is never written as `0`'),
    'README.md no longer states that an unreported day is never written as `0`, which is the promise these sentences carry');

  // The detail page's coverage line: the count, the days by name, and the clause.
  const detail = await f.page(detailUrl(CHARTED));
  const coverage = detailCoverage(detail.body);
  assert.equal(coverage.state, 'gap',
    `the ${CHARTED} detail page printed a coverage line for the state ${JSON.stringify(coverage.state)} rather than a gap`);
  assert.ok(coverage.text.includes(countedDays(gapsOf(CHARTED))),
    `the ${CHARTED} coverage line does not name the count of unmeasured days; it reads ${JSON.stringify(coverage.text)}`);
  assert.ok(coverage.text.includes(PLAN.archiveHole),
    `the ${CHARTED} coverage line does not name the day nobody measured; it reads ${JSON.stringify(coverage.text)}`);
  assert.ok(coverage.text.trimEnd().endsWith(`${clause}.`),
    `the ${CHARTED} coverage line ends ${JSON.stringify(coverage.text.slice(-40))} and ${PRD_RELATIVE} section ` +
      `${GLOSSARY_HEADING} publishes ${JSON.stringify(clause)} as the short form of a gap`);
  assert.equal(coverage.text.includes('<span class="figure"'), false,
    'the coverage line carries a figure cell, so a gap and a measurement read the same');

  // A second repository with two holes, so the count printed is the count rather than the
  // only number this file's first fixture could offer.
  const patchy = detailCoverage((await f.page(detailUrl(PATCHY))).body);
  assert.ok(patchy.text.includes(countedDays(gapsOf(PATCHY))),
    `the ${PATCHY} coverage line does not name the count of its unmeasured days; it reads ${JSON.stringify(patchy.text)}`);
  for (const day of GAP_DAYS[PATCHY] ?? []) {
    assert.ok(patchy.text.includes(day), `the ${PATCHY} coverage line does not name ${day}; it reads ${JSON.stringify(patchy.text)}`);
  }
  assert.ok(patchy.text.trimEnd().endsWith(`${clause}.`),
    `the ${PATCHY} coverage line ends ${JSON.stringify(patchy.text.slice(-40))} and the PRD publishes ${JSON.stringify(clause)}`);

  // The list page's own gap cell, for the same two repositories.
  const list = await f.page(`/repos?${PLAN.query}`);
  assert.equal(list.status, 200, 'the list page was not served');
  for (const name of [CHARTED, PATCHY]) {
    const gapDays = GAP_DAYS[name] ?? [];
    const row = listRow(list.body, repoPath(name));
    assert.equal(row.gapState, 'gap', `the ${name} row marked its coverage ${JSON.stringify(row.gapState)} rather than a gap`);
    assert.ok(row.gap.includes(countedDays(gapDays.length)),
      `the ${name} row does not name the count of its gap days; it reads ${JSON.stringify(row.gap)}`);
    for (const day of gapDays) {
      assert.ok(row.gap.includes(day), `the ${name} row does not name ${day}; it reads ${JSON.stringify(row.gap)}`);
    }
    assert.ok(row.gap.trimEnd().endsWith(`${clause}.`),
      `the ${name} row ends ${JSON.stringify(row.gap.slice(-40))} and the PRD publishes ${JSON.stringify(clause)}`);
  }

  // The chart's text alternative says the same thing about the same day, and the cell in
  // its own table holds the module's gap wording rather than a number.
  const caption = chartCaption(detail.body, CLONES_METRIC);
  const sentence = clauseSentence(caption, clause);
  assert.ok(sentence.includes(PLAN.archiveHole),
    `the clones chart's gap sentence does not name ${PLAN.archiveHole}; it reads ${JSON.stringify(sentence)}`);
  assert.ok(sentence.includes(countedDays(gapsOf(CHARTED))),
    `the clones chart's gap sentence does not name the count of unmeasured days; it reads ${JSON.stringify(sentence)}`);
  assert.equal(/\d/.test(GAP_CELL_TEXT), false,
    `the chart's gap cell wording ${JSON.stringify(GAP_CELL_TEXT)} carries a digit, so a gap and a measurement read alike`);
  const row = chartRow(detail.body, CLONES_METRIC, PLAN.archiveHole);
  assert.ok(row.includes('chart-row-gap'),
    `the clones table's row for ${PLAN.archiveHole} is not marked as a gap; it reads ${JSON.stringify(row)}`);
  assert.ok(row.includes(GAP_CELL_TEXT),
    `the clones table's row for ${PLAN.archiveHole} does not carry the gap wording ${JSON.stringify(GAP_CELL_TEXT)}; it ` +
      `reads ${JSON.stringify(row)}`);
  assert.equal(/<td>0<\/td>/.test(row), false,
    `the clones table wrote a zero for ${PLAN.archiveHole}, which the README says it never does`);

  // And the other reading of the same cell: a window inside the collected range but before
  // the day nobody measured is complete coverage, not a gap sentence with an empty list.
  const clean = await f.page(`/repos?from=${PLAN.from}&to=${dayBefore(PLAN.archiveHole)}`);
  const cleanRow = listRow(clean.body, repoPath(CHARTED));
  assert.equal(cleanRow.gapState, 'complete',
    `a window in which ${CHARTED} holds every day was reported as ${JSON.stringify(cleanRow.gapState)}`);
  assert.equal(cleanRow.gap.includes(clause), false,
    `a window with no gap printed the gap clause anyway; it reads ${JSON.stringify(cleanRow.gap)}`);
});

// RS-VWS-C03's second and third clauses: an absent series prints the documented sentence
// rather than an empty figure, and a repository or a home with nothing stored prints an empty
// state in words rather than an empty table. The wording is the requirement's own phrase, so
// a document or a view that stops saying it fails on both sides.
test('an absent series prints the documented sentence, and nothing stored prints an empty state in words', async (t) => {
  const words = absentSeriesWords();
  const requirement = requirementText(GAP_REQUIREMENT);

  // The document still publishes all three clauses: the gap sentence, the absent series and
  // the empty state. Two suites' worth of behaviour rides on this block.
  assert.match(requirement, /unmeasured[\s\S]*zero/,
    `${FEATURE_RELATIVE} no longer states that the days a gap names are unmeasured rather than zero; ` +
      `${GAP_REQUIREMENT} reads ${JSON.stringify(requirement)}`);
  assert.match(requirement, /empty state in words[\s\S]*empty table/,
    `${FEATURE_RELATIVE} no longer states that a repository with nothing stored prints an empty state in words rather ` +
      `than an empty table; ${GAP_REQUIREMENT} reads ${JSON.stringify(requirement)}`);

  // Both view modules own their own copy of the sentence, and both carry the requirement's
  // words with the page's own demonstrative between them.
  for (const [printed, where] of [
    [DETAIL_NO_STORED_VALUE_TEXT, `${DETAIL_SOURCE_RELATIVE}`],
    [LIST_NO_STORED_VALUE_TEXT, 'src/server/views/repo-list.js'],
  ]) {
    assert.ok(carriesWords(printed, words),
      `${where} prints ${JSON.stringify(printed)} for an absent series and ${FEATURE_RELATIVE} section 3 publishes ` +
        `${JSON.stringify(`${words.before} ... ${words.after}`)}; the page's demonstrative is the only word free to differ`);
  }

  const f = await archive(t, 'absent-series');

  // The detail page for a repository the archive has never collected: four absent series,
  // each printed in words, and no chart at all.
  const fresh = await f.page(detailUrl(FRESH));
  assert.equal(fresh.status, 200, `the ${FRESH} detail page was not served`);
  const missing = [...fresh.body.matchAll(/<span class="figure figure-missing">([^<]*)<\/span>/g)]
    .map((match) => match[1] ?? '');
  assert.equal(missing.length, TRAFFIC_METRICS.length,
    `the ${FRESH} detail page printed ${String(missing.length)} absent-series cells for ${String(TRAFFIC_METRICS.length)} ` +
      `charted metrics; they read ${JSON.stringify(missing)}`);
  for (const [index, printed] of missing.entries()) {
    assert.ok(carriesWords(printed, words),
      `the ${FRESH} detail page's absent-series cell for ${TRAFFIC_METRICS[index] ?? ''} reads ${JSON.stringify(printed)} ` +
        `and the requirement publishes ${JSON.stringify(`${words.before} ... ${words.after}`)}`);
  }
  assert.equal(fresh.body.includes('<figure'), false,
    `the ${FRESH} detail page drew a chart for a repository with nothing stored, so the absence reads as a measurement`);
  assert.equal(/<span class="figure">0<\/span>/.test(fresh.body), false,
    `the ${FRESH} detail page wrote a figure of zero for a repository with nothing stored`);
  assert.ok(fresh.body.includes('data-state="first-connect"'),
    'the never-collected detail page does not state that it is a first connect');

  // The list page: the four absent series of the never-collected repository, and the three
  // of the one that stored clones alone.
  const list = await f.page(`/repos?${PLAN.query}`);
  /** @type {Array<[string, number]>} */
  const absentSeries = [[FRESH, TRAFFIC_METRICS.length], [CLONES_ONLY, TRAFFIC_METRICS.length - 1]];
  for (const [name, absent] of absentSeries) {
    const row = listRow(list.body, repoPath(name));
    const missingCells = [...row.cells.values()]
      .filter((cell) => cell.state === 'missing')
      .map((cell) => cell.figure);
    assert.equal(missingCells.length, absent,
      `the ${name} row printed ${String(missingCells.length)} absent-series cells and ${String(absent)} metrics hold no ` +
        `stored day in the window; they read ${JSON.stringify(missingCells)}`);
    for (const printed of missingCells) {
      assert.ok(carriesWords(printed, words),
        `the ${name} row prints ${JSON.stringify(printed)} where the requirement publishes ` +
          `${JSON.stringify(`${words.before} ... ${words.after}`)}`);
    }
    assert.equal(/>0</.test(row.row), false,
      `the ${name} row wrote a bare zero where a metric holds no stored day`);
  }

  // A home with nothing enrolled: words, and no table where the rows would have been.
  const empty = await archive(t, 'nothing-enrolled', () => {});
  const emptyList = await empty.page(`/repos?${PLAN.query}`);
  assert.equal(emptyList.status, 200, 'the list page of a home with nothing enrolled was not served');
  assert.equal(/<table\b/.test(emptyList.body), false,
    'the list page of a home with nothing enrolled rendered a table, where RS-VWS-C03 requires an empty state in words');
  assert.match(emptyList.body, /<section class="empty-state">/,
    'the list page of a home with nothing enrolled does not mark the empty state it is in');
  assert.equal(/<tbody>\s*<\/tbody>/.test(emptyList.body), false,
    'the list page of a home with nothing enrolled rendered an empty table body');
  const spoken = /<section class="empty-state">([\s\S]*?)<\/section>/.exec(emptyList.body)?.[1] ?? '';
  assert.notEqual(flatten(spoken.replace(/<[^>]*>/g, ' ')), '',
    'the empty state the list page renders carries no words at all');
  // The index page states the same absence as the roll-up word the health read returns.
  const emptyIndex = await empty.page(`/?${PLAN.query}`);
  const rollUp = /<p class="state-sentence">([^<]*)<\/p>/.exec(emptyIndex.body)?.[1] ?? '';
  assert.ok(rollUp.startsWith(`${statePhrase(SUMMARY_STATE_EMPTY)}: `),
    `the index page of a home with nothing enrolled states ${JSON.stringify(rollUp)} and the health read's roll-up word ` +
      `is ${JSON.stringify(SUMMARY_STATE_EMPTY)}`);
});

// RS-VWS-C02, and the state vocabulary PRD section 10 publishes: a state travels as a word
// as well as a data attribute, and beside its reason, on every page that prints one. Both
// directions are asserted - a page that printed a word the health read cannot return would
// be reporting a capability the product does not have, and a state the read can return but
// no page names would be one a maintainer is never told about.
test('every state word a view renders is a word the health read can return, with its reason beside it', async (t) => {
  // The document's own claim, read out of section 3.
  const requirement = requirementText(STATE_REQUIREMENT);
  assert.match(requirement, /every state is rendered as a state word with its reason beside it/,
    `${FEATURE_RELATIVE} section 3 no longer states that every state is rendered as a state word with its reason beside ` +
      `it; ${STATE_REQUIREMENT} reads ${JSON.stringify(requirement)}`);

  // PRD section 10 is the one published list: repository states, run states, roll-up word.
  const states = sectionText(PRD, STATES_HEADING);
  const repository = backticked(/^\*\*Repository:\*\*\s*(.+?\.)/ms, states, 'Repository');
  const run = backticked(/^\*\*Collection run:\*\*\s*(.+?\.)/ms, states, 'Collection run');
  const rollUp = backticked(/^\*\*Archive roll-up:\*\*\s*(.+?\.)/ms, states, 'Archive roll-up');
  assert.deepEqual(repository.slice().sort(), [...REPOSITORY_STATE_PRECEDENCE].slice().sort(),
    `${PRD_RELATIVE} section ${STATES_HEADING} names the repository states ${JSON.stringify(repository)} and the health ` +
      `read returns ${JSON.stringify([...REPOSITORY_STATE_PRECEDENCE])}`);
  assert.deepEqual(run.slice().sort(), [...RUN_WORDS].slice().sort(),
    `${PRD_RELATIVE} section ${STATES_HEADING} names the run states ${JSON.stringify(run)} and the health read returns ` +
      `${JSON.stringify([...RUN_WORDS])}`);
  assert.deepEqual(rollUp, [SUMMARY_STATE_EMPTY],
    `${PRD_RELATIVE} section ${STATES_HEADING} names the roll-up words ${JSON.stringify(rollUp)} and the health read ` +
      `exports ${JSON.stringify(SUMMARY_STATE_EMPTY)}`);

  const f = await archive(t, 'state-words');

  // Every page that prints a state prints the word, the attribute and the reason together,
  // and the word is one the health read can return.
  const list = await f.page(`/repos?${PLAN.query}`);
  const detail = await f.page(detailUrl(CHARTED));
  const health = await f.page('/health');
  /** @type {string[]} */
  const printed = [];
  /** @type {Array<[string, {status: number, body: string}]>} */
  const served = [['the list', list], ['the detail page', detail], ['the health page', health]];
  for (const [label, page] of served) {
    assert.equal(page.status, 200, `${label} was not served`);
    const sentences = stateSentences(page.body);
    assert.ok(sentences.length > 0, `${label} printed no state as a word, so this scan had nothing to read`);
    for (const sentence of sentences) {
      assert.equal(sentence.attribute, sentence.word,
        `${label} printed the state word ${JSON.stringify(sentence.word)} inside an element whose data-state is ` +
          `${JSON.stringify(sentence.attribute)}; RS-VWS-C02 requires the word and the attribute to be one state`);
      assert.ok(RETURNABLE_WORDS.has(sentence.word),
        `${label} printed the state word ${JSON.stringify(sentence.word)}, which the health read cannot return; the read ` +
          `returns ${JSON.stringify([...RETURNABLE_WORDS].sort())}`);
      assert.ok(sentence.reason.startsWith(`${statePhrase(sentence.word)}: `),
        `${label} printed the reason ${JSON.stringify(sentence.reason.slice(0, 60))} for the state ` +
          `${JSON.stringify(sentence.word)} without beginning with that state in words, so the state and its sentence can ` +
          'be read apart');
      // Nothing but colour carried this: strip every class and the words are still there.
      const unstyled = flatten(sentence.markup.replaceAll(/\sclass="[^"]*"/g, '').replace(/<[^>]*>/g, ' '));
      assert.ok(unstyled.includes(sentence.word) && unstyled.includes(sentence.reason),
        `${label} printed the state ${JSON.stringify(sentence.word)} only through a class attribute; with every class ` +
          `removed the text left is ${JSON.stringify(unstyled)}`);
      printed.push(sentence.word);
    }
  }

  // Both directions for the repository vocabulary: the pages print exactly the states the
  // health read can return for a repository, and each state's own repository prints that
  // word again as its detail page's collection state.
  const expected = [...REPOSITORY_STATE_PRECEDENCE].sort();
  const observed = [...new Set(printed)].sort();
  assert.deepEqual(observed, expected,
    `the states the pages printed are ${JSON.stringify(observed)} and the health read can return ` +
      `${JSON.stringify(expected)} for a repository`);
  for (const { name, state } of ENROLLED) {
    const page = await f.page(detailUrl(name));
    const words = stateSentences(page.body).map((sentence) => sentence.word);
    assert.ok(words.includes(state),
      `the ${name} detail page printed the state words ${JSON.stringify(words)} and the archive records ${name} as ` +
        `${JSON.stringify(state)}`);
  }

  // The index page announces the roll-up and the run in words, through the health read's own
  // sentences, over an archive with a closed run, an interrupted one and none at all.
  const open = await archive(t, 'state-words-open-run', seedOpenRun);
  const none = await archive(t, 'state-words-no-run', () => {});
  /** @type {string[]} */
  const spokenRunWords = [];
  /** @type {Array<[string, ArchiveFixture]>} */
  const runs = [['a closed run', f], ['an open run', open], ['no run at all', none]];
  for (const [label, fixture] of runs) {
    const page = await fixture.page(`/?${PLAN.query}`);
    assert.equal(page.status, 200, `the index page over ${label} was not served`);
    const summary = /<p class="state-sentence">([^<]*)<\/p>/.exec(page.body)?.[1] ?? '';
    const runSentence = /<p class="run-state">([^<]*)<\/p>/.exec(page.body)?.[1] ?? '';
    assert.notEqual(summary, '', `the index page over ${label} states no roll-up sentence`);
    assert.notEqual(runSentence, '', `the index page over ${label} states no run sentence`);
    const summaryPhrase = summary.split(':')[0] ?? '';
    const summaryWords = [SUMMARY_STATE_EMPTY, ...REPOSITORY_STATE_PRECEDENCE].map(statePhrase);
    assert.ok(summaryWords.includes(summaryPhrase),
      `the index page over ${label} announced the roll-up as ${JSON.stringify(summaryPhrase)}, which is not a word the ` +
        `health read returns for an archive; it returns ${JSON.stringify(summaryWords)}`);
    const runPhrase = runSentence.split(':')[0] ?? '';
    assert.ok(RUN_WORDS.map(statePhrase).includes(runPhrase),
      `the index page over ${label} announced the run as ${JSON.stringify(runPhrase)}, which is not a word the health read ` +
        `returns for a run; it returns ${JSON.stringify(RUN_WORDS.map(statePhrase))}`);
    spokenRunWords.push(runPhrase);
  }
  assert.deepEqual(spokenRunWords, [statePhrase(RUN_STATE_COMPLETED), statePhrase(RUN_STATE_UNCLOSED),
    statePhrase(RUN_STATE_NEVER_RUN)],
  `the index page announced the run as ${JSON.stringify(spokenRunWords)} over a closed run, an open run and no run at all`);
});

/**
 * The backticked words of one PRD section 10 sentence, read from the document's own line
 * rather than written here. The sentence is read up to its own closing full stop, because a
 * sentence that wrapped over two lines still names its whole vocabulary and the second line
 * belongs to it rather than to the next.
 * @param {RegExp} pattern Anchored at the start of the sentence it names, ending at its stop.
 * @param {string} states The section, verbatim.
 * @param {string} label The sentence being read, for the failure message.
 * @returns {string[]}
 */
function backticked(pattern, states, label) {
  const sentence = flatten(pattern.exec(states)?.[1] ?? '');
  const words = [...sentence.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? '');
  assert.ok(words.length > 0,
    `${PRD_RELATIVE} section ${STATES_HEADING} states no backticked word for the ${label} sentence; it reads ` +
      JSON.stringify(sentence));
  return words;
}

// Section 4 publishes three more claims: the detail order's rationale (which the order
// itself carries), the one-line summary per repository on the index and list, and the shape
// of the health page. Each is read here as a claim about the pages rather than as prose.
test('the rest of section 4 describes the list columns and the health page as they render', async (t) => {
  const design = flatten(sectionText(FEATURE, DETAIL_DESIGN_HEADING));
  for (const phrase of ['summed clones and views over the window',
    'last unique-cloner and unique-visitor value with the day it was recorded',
    'the named gap days', 'the state word with its reason',
    'one roll-up word at the top, then every repository\'s state and reason',
    'the repositories that need re-authentication and the permission they need']) {
    assert.ok(design.includes(phrase),
      `${FEATURE_RELATIVE} section ${DETAIL_DESIGN_HEADING} no longer claims ${JSON.stringify(phrase)}`);
  }

  const f = await archive(t, 'section-four-rest');
  const list = await f.page(`/repos?${PLAN.query}`);
  assert.equal(list.status, 200, 'the list page was not served');

  // One line per repository: a row each, for every enrolled repository, each ending in the
  // state word with the reason beside it.
  const rows = [...list.body.matchAll(/<tr data-repository="([^"]*)">/g)].map((match) => match[1] ?? '');
  assert.deepEqual(rows, ENROLLED.map((entry) => repoPath(entry.name)),
    `the list page printed ${String(rows.length)} rows and the archive holds ` +
      `${String(ENROLLED.length)} enrolled repositories; they are ${JSON.stringify(rows)}`);
  for (const { name, state } of ENROLLED) {
    const row = listRow(list.body, repoPath(name));
    assert.equal(row.state, state,
      `the ${name} row prints the state word ${JSON.stringify(row.state)} and the archive records ${name} as ` +
        `${JSON.stringify(state)}`);
    assert.ok(row.reason.startsWith(`${statePhrase(state)}: `),
      `the ${name} row prints the reason ${JSON.stringify(row.reason.slice(0, 60))} without its own state in words, so ` +
        'the state and its sentence can be read apart');
  }

  // The four metric columns, each read by the rule section 4 states for it and not by the
  // rule the column's own kind declares: the document names which metrics are summed over
  // the window and which are the last stored value, so a column that changed its rule
  // without the document following is a failure here rather than a self-consistent page.
  const claim = /summarise each repository in one line: ([\s\S]*?)\./.exec(design)?.[1] ?? '';
  // The sentence is one claim per comma-separated clause: the summed metrics, the per-day
  // uniques, then the gap days and the state word in the clause that carries both.
  const rules = claim.split(', the ');
  assert.equal(rules.length, 3,
    `${FEATURE_RELATIVE} section ${DETAIL_DESIGN_NUMBER} no longer states the three clauses a list row summarises; the ` +
      `sentence reads ${JSON.stringify(claim)}`);
  const stored = storedDays(CHARTED);
  for (const column of TRAFFIC_COLUMNS) {
    // The clause is read from the document by the column's own kind, so both sides of the
    // binding below come from somewhere other than the module that produced the cell.
    const clause = rules[column.kind === 'sum' ? 0 : 1] ?? '';
    // A metric is named in prose where the code names it in a key, so the key is read as its
    // own words: a hyphen is a space and the plural the archive stores is the singular a
    // sentence uses. The plural is optional and has to end the word, so a summed `clones`
    // cannot be satisfied by the `cloner` inside `unique-cloner`.
    const words = `${column.metric.replace(/s$/, '').replaceAll('-', '[- ]')}s?(?![a-z])`;
    assert.ok(new RegExp(words).test(clause),
      `${FEATURE_RELATIVE} section ${DETAIL_DESIGN_NUMBER} publishes the ${column.kind} rule as ` +
        `${JSON.stringify(clause)}, which does not name ${column.metric}, and src/server/views/repo-list.js applies the ` +
        `${column.kind} rule to that column`);
    const expected = column.kind === 'sum'
      ? stored.reduce((total, day) => total + (STORED_VALUE[column.metric] ?? (() => 1))(PLAN.window.indexOf(day)), 0)
      : (STORED_VALUE[column.metric] ?? (() => 1))(PLAN.window.indexOf(stored[stored.length - 1] ?? PLAN.from));
    const cell = listRow(list.body, repoPath(CHARTED)).cells.get(column.metric);
    assert.ok(cell !== undefined,
      `the ${CHARTED} row has no cell for ${column.metric}; section ${DETAIL_DESIGN_NUMBER} publishes a column for every ` +
        'charted metric');
    assert.equal(cell.figure, String(expected),
      `the ${CHARTED} row prints ${JSON.stringify(cell.figure)} for ${column.metric}, a ${column.kind} column, and the ` +
        `${String(stored.length)} stored days this suite wrote come to ${String(expected)}`);
    if (column.kind === 'last') {
      // The day the value belongs to is the last stored day, read off this file's own gap
      // table rather than from the URL the request happened to carry.
      const lastStored = stored[stored.length - 1] ?? PLAN.from;
      assert.ok(cell.note.includes(lastStored),
        `the ${CHARTED} row's ${column.metric} cell does not name ${lastStored}, the last day with a stored row; it reads ` +
          `${JSON.stringify(cell.note)}`);
    }
    assert.ok(list.body.includes(`<th scope="col">${column.group}: ${column.label}</th>`),
      `the list page has no column heading for ${column.metric}; it reads ${JSON.stringify(column.label)}`);
  }

  // The health page: the roll-up first, then every repository's state and reason, then the
  // re-authentication section naming the permission those rows need.
  const health = await f.page('/health');
  assert.equal(health.status, 200, 'the health page was not served');
  assert.deepEqual(sectionKeys(health.body), [...HEALTH_SECTION_ORDER],
    `the health page rendered ${JSON.stringify(sectionKeys(health.body))} and src/server/views/health.js exports ` +
      `${JSON.stringify([...HEALTH_SECTION_ORDER])}`);
  const rollUpFirst = /<section class="health-section health-whole-archive"[\s\S]*?<span class="state-word">([^<]*)<\/span>/
    .exec(health.body)?.[1] ?? '';
  assert.ok(RETURNABLE_WORDS.has(rollUpFirst),
    `the health page's roll-up section opens with ${JSON.stringify(rollUpFirst)}, which the health read cannot return`);
  const rowsWithStates = stateSentences(health.body).length;
  assert.equal(rowsWithStates, ENROLLED.length,
    `the health page printed ${String(rowsWithStates)} state sentences and the archive holds ` +
      `${String(ENROLLED.length)} enrolled repositories`);
  const reauthentication = /<section class="health-section health-re-authentication"[\s\S]*?<\/section>/.exec(health.body)?.[0] ?? '';
  assert.notEqual(reauthentication, '', 'the health page rendered no re-authentication section');
  assert.ok(reauthentication.includes(TRAFFIC_PERMISSION),
    `the health page's re-authentication section does not name the permission a repository needs; it reads ` +
      `${JSON.stringify(reauthentication.slice(0, 200))} and the permission is ${JSON.stringify(TRAFFIC_PERMISSION)}`);
});