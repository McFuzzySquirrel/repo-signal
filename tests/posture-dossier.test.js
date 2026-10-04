import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { listCommands } from '../src/commands/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOSSIER = path.join(ROOT, 'docs', 'reviews', 'open-source-posture-dossier.md');

/**
 * The review artefact itself. No agent writes it, so the dossier may only ever
 * name it as the place a decision is recorded, and this suite reads its presence
 * rather than assuming it.
 */
const REVIEW_ARTEFACT = 'docs/reviews/open-source-posture.json';

/**
 * The four positions the posture review has to decide, in the order the dossier
 * presents them. The ids are the dossier's own, so a renamed or dropped position
 * fails here rather than quietly reducing the review to three questions.
 */
const POSITIONS = ['licence', 'redistribution', 'token', 'privacy-note'];

/** The only two marks a position may carry. Neither of them resolves it. */
const STATUS_MARKS = ['confirmed by documentation', 'contested'];

/**
 * One citation inside a dossier cell: a backticked repository-relative path, an
 * optional backticked heading, and an optional verbatim quotation. A citation is
 * the unit the dossier is checked by, so a paragraph that cites a file without
 * the heading or the sentence it is there for is a citation that proves less.
 */
const CITATION = /`([^`]+)`(?:\s*`([^`]+)`)?(?:\s*(?:—|-|:)\s*)?(?:"([^"]*)")?/g;

/** A citation of a test file, in the cell shape `tests/x.test.js` test "the name". */
const NAMED_TEST = /`([^`]+)`\s*test\s+"([^"]+)"/g;

/** The three quote characters a `test(...)` call may use around its name. */
const QUOTE = `['"${String.fromCharCode(96)}]`;

/**
 * Phrasings that would turn a gathered dossier into an attestation: an approval,
 * a result nobody ran, a compliance claim, or a decision this page must not make.
 */
const UNATTESTED_CLAIMS = /** @type {RegExp[]} */ ([
  /\bapproved by\b/i,
  /\bhas been approved\b/i,
  /\bsigned off (?:by|on)\b/i,
  /\bwe (?:ran|verified|confirmed|tested|audited|certify|attest|conclude)\b/i,
  /\b(?:this|the) dossier (?:confirms|approves|certifies|establishes|decides|resolves)\b/i,
  /\b(?:posture|redistribution|licen[cs]e|privacy|token) review (?:is|was|has been) (?:complete|completed|recorded|approved|done|passed|satisfied)\b/i,
  /\bthe reviewer (?:has |)(?:approved|confirmed|passed|signed|recorded|cleared)\b/i,
  /\bis (?:legal|financial) advice\b/i,
  /\bthis (?:complies|is compliant|is certified|is audited)\b/i,
  /\b(?:lawful|unlawful|legally (?:compliant|permitted|forbidden|required|advisable))\b/i,
  /\bthe position is (?:sound|unsound|wrong|right|correct|incorrect|acceptable|unacceptable)\b/i,
  /\ball tests pass\b/i,
  /\bthe (?:ci|pipeline|build|suite|tests?) (?:passed|is green|succeeded)\b/i,
  /\bhas been (?:tested|validated|verified|reviewed) (?:live|against)\b/i,
]);

/**
 * A phrasing that would narrow the redistribution statement into something a
 * reader could act on the other way. The project's own words are
 * `may not be redistributed`; a softer modal, or a condition, is a different
 * position wearing the same heading.
 */
const SOFTENED_STATEMENT = /** @type {RegExp[]} */ ([
  /\bshould not be redistributed\b/i,
  /\b(?:generally|usually|ideally|preferably) (?:not|never) be redistributed\b/i,
  /\bmay be redistributed (?:if|when|unless|where)\b/i,
  /\bneed not be redistributed\b/i,
  /\bnot necessarily redistributed\b/i,
  /\bmay be shared with\b/i,
  /\bno restriction on redistribution\b/i,
  /\bare not (?:a|your) (?:personal|private) (?:data|facts)\b/i,
]);

/** Command names that would read as moving the archive somewhere else. */
const PUBLISHING_NAME = /\b(?:export|publish|share|upload|download|sync|mirror)\b/;

/** Summaries that would describe a command as sending the archive anywhere. */
const PUBLISHING_SUMMARY = /\b(?:export|publish|share|upload|download|sync|mirror|redistribut)/i;

/**
 * @typedef {object} Citation
 * @property {string} file Repository-relative path, as backticked in the dossier.
 * @property {string | null} heading The heading it is read at, or null for a whole file.
 * @property {string | null} quote The sentence quoted from there, or null.
 */

/**
 * One position block of the dossier: the two-cell table that opens with its
 * `Position` row, keyed by field label.
 *
 * @typedef {object} Position
 * @property {string} heading The dossier heading the block sits under.
 * @property {string} id The position's stable name.
 * @property {Map<string, string>} fields Field label to value cell.
 */

/**
 * @param {string} file Absolute path.
 * @returns {string}
 */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flatten a document's line wrapping, so an assertion about a sentence does not
 * depend on where the prose happens to wrap.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Every citation in one dossier cell, in the order it is written.
 * @param {string} cell
 * @returns {Citation[]}
 */
function citationsIn(cell) {
  /** @type {Citation[]} */
  const found = [];
  for (const match of cell.matchAll(CITATION)) {
    found.push({ file: match[1] ?? '', heading: match[2] ?? null, quote: match[3] ?? null });
  }
  return found;
}

/**
 * The cells of one markdown table row, or an empty array for a line that is not
 * a row.
 * @param {string} line
 * @returns {string[]}
 */
function cellsOf(line) {
  if (!line.startsWith('|')) return [];
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

/**
 * A cell's label with its backticks removed, so a field is found whether or not
 * the writer marked it as code.
 * @param {string} cell
 * @returns {string}
 */
function label(cell) {
  return cell.replaceAll('`', '').trim();
}

/**
 * Every markdown table row of a document, as cell arrays. A separator row is not
 * a row of content, and neither is a one-cell fragment of prose.
 * @param {string} text
 * @returns {string[][]}
 */
function tableRows(text) {
  /** @type {string[][]} */
  const rows = [];
  for (const line of text.split('\n')) {
    const cells = cellsOf(line);
    if (cells.length < 2) continue;
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * The four position blocks, in document order. A block is the two-cell table
 * whose first row names the position; the index and the field-name table beside
 * it also have a `Position` cell, and neither carries a backticked id.
 * @param {string} text The dossier.
 * @returns {Position[]}
 */
function positionBlocks(text) {
  /** @type {Position[]} */
  const blocks = [];
  /** @type {Position | null} */
  let current = null;
  let heading = '';
  for (const line of text.split('\n')) {
    const headingMatch = /^#{1,6} (.+)$/.exec(line);
    if (headingMatch !== null) {
      heading = headingMatch[1] ?? '';
      current = null;
    }
    const cells = cellsOf(line);
    if (cells.length < 2) continue;
    const key = label(cells[0] ?? '');
    if (key === 'Position' && cells.length === 2 && (cells[1] ?? '').startsWith('`')) {
      current = { heading, id: label(cells[1] ?? ''), fields: new Map() };
      current.fields.set('Position', cells[1] ?? '');
      blocks.push(current);
      continue;
    }
    if (current !== null && !current.fields.has(key)) {
      current.fields.set(key, cells.slice(1).join(' | ').trim());
    }
  }
  return blocks;
}

/**
 * The dossier's index table: one row per position, naming where it lives and how
 * it is marked.
 * @param {string} text
 * @returns {Map<string, { statedIn: string; status: string }>}
 */
function indexTable(text) {
  /** @type {Map<string, { statedIn: string; status: string }>} */
  const index = new Map();
  for (const cells of tableRows(text)) {
    const [position, question, statedIn, status] = cells;
    // The index is the one four-column table whose first cell is a backticked
    // position id. The header row beside it names the columns, and the position
    // blocks below are two-column, so neither is read as a position.
    if (cells.length !== 4 || !(position ?? '').startsWith('`')) continue;
    if (question === undefined || statedIn === undefined || status === undefined) continue;
    index.set(label(position ?? ''), { statedIn, status });
  }
  return index;
}

/**
 * The heading a citation names, with any leading hashes the writer used removed.
 * @param {Citation} citation
 * @returns {string}
 */
function headingText(citation) {
  return (citation.heading ?? '').replace(/^#+\s*/, '').trim();
}

/**
 * The body of the heading a citation names, up to the next heading of any level.
 * A heading that is not there fails here rather than matching the whole document.
 * @param {Citation} citation
 * @returns {string}
 */
function citedScope(citation) {
  const file = path.join(ROOT, citation.file);
  const heading = headingText(citation);
  if (heading === '') return read(file);
  const lines = read(file).split('\n');
  const marker = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`).test(line));
  assert.notEqual(marker, -1, `${citation.file} has no "${heading}" heading`);
  const body = [];
  for (const line of lines.slice((marker ?? 0) + 1)) {
    if (/^#{1,6}\s+/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * Every citation the dossier makes in a `Stated in` or `Also stated in` cell, the
 * index included: a citation is checked wherever it is written, so an index that
 * drifted away from its position fails as loudly as the position does.
 * @param {string} text
 * @returns {Citation[]}
 */
function everyCitation(text) {
  /** @type {Citation[]} */
  const found = [];
  for (const cells of tableRows(text)) {
    const key = label(cells[0] ?? '');
    if (key !== 'Stated in' && key !== 'Also stated in') continue;
    for (const citation of citationsIn(cells.slice(1).join(' | '))) found.push(citation);
  }
  return found;
}

/**
 * Every quotation the dossier attributes to a place: each position's own claim,
 * and every sentence quoted from an `Also stated in` citation.
 * @param {Position[]} blocks
 * @returns {Citation[]}
 */
function everyQuotation(blocks) {
  /** @type {Citation[]} */
  const quotes = [];
  for (const block of blocks) {
    const claim = block.fields.get('The claim, in the project\'s own words') ?? '';
    const statedIn = citationsIn(block.fields.get('Stated in') ?? '');
    const citation = statedIn[0];
    assert.ok(citation !== undefined, `the ${block.id} position states it in no file`);
    quotes.push({ ...citation, quote: claim.replace(/^"|"$/g, '') });
    for (const other of citationsIn(block.fields.get('Also stated in') ?? '')) quotes.push(other);
  }
  return quotes;
}

/**
 * The test citations of one `Asserted by` cell, each with the test it names. Every
 * backticked span in that cell has to be one of them, or an unparsed citation
 * would sit in a cell nothing checks.
 * @param {string} cell
 * @param {string} position The position the cell belongs to, for the failure message.
 * @returns {{ file: string; name: string }[]}
 */
function namedTestsIn(cell, position) {
  /** @type {{ file: string; name: string }[]} */
  const named = [];
  for (const match of cell.matchAll(NAMED_TEST)) named.push({ file: match[1] ?? '', name: match[2] ?? '' });
  const spans = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  assert.equal(spans.length, named.length,
    `the ${position} position names ${spans.length} files under Asserted by but describes ${named.length} of them as tests`);
  for (const span of spans) {
    assert.ok(span.startsWith('tests/'), `${span} is named as a test that asserts the ${position} position, and is not a test file`);
  }
  return named;
}

const dossier = read(DOSSIER);
const blocks = positionBlocks(dossier);
const flat = flatten(dossier);

// RS-OPS-FR-02: a dossier the reviewer can read. It gathers the four positions
// with their sources, and it is not the review artefact a person writes.
test('the dossier exists, says what it is, and is not the review artefact', () => {
  assert.ok(statSync(DOSSIER).isFile(), 'docs/reviews/open-source-posture-dossier.md is not a file');
  assert.ok(dossier.length > 400, `the dossier is ${dossier.length} characters, which is a stub`);
  // It has to read as evidence for a person rather than as a decision: the two
  // sentences a reader relies on are the gate it feeds and the file the decision
  // is recorded in.
  assert.match(flat, /evidence, not a decision/, 'the dossier does not say it decides nothing');
  assert.ok(dossier.includes(REVIEW_ARTEFACT), `the dossier does not name ${REVIEW_ARTEFACT}, where the decision is recorded`);
  assert.match(flat, /`RS-OPS-REV-01`/, 'the dossier does not name the gate it feeds');
  // The review artefact is a person's file. While it is absent the dossier has to
  // say so beside the artefact's own name; once it exists the dossier must stop
  // describing it as unrecorded. The claim is read from the text around each
  // mention rather than from whole lines, because the prose wraps mid-sentence,
  // and only explicit absence wording counts: what the dossier says about the
  // evidence a test cannot replace is not a claim that the file is missing.
  const windows = [...flat.matchAll(new RegExp(escapeRegExp(REVIEW_ARTEFACT), 'g'))]
    .map((match) => flat.slice(Math.max(0, (match.index ?? 0) - 120), (match.index ?? 0) + REVIEW_ARTEFACT.length + 260));
  assert.ok(windows.length > 0, `the dossier never names ${REVIEW_ARTEFACT}`);
  const absence = /does not contain|is not recorded|not recorded|is missing|has not been/;
  const claiming = windows.filter((window) => absence.test(window));
  const present = statSync(path.join(ROOT, REVIEW_ARTEFACT), { throwIfNoEntry: false }) !== undefined;
  if (present) {
    assert.deepEqual(claiming, [], `${REVIEW_ARTEFACT} exists, so the dossier no longer describes it as absent`);
  } else {
    assert.ok(claiming.length > 0, `the dossier must say ${REVIEW_ARTEFACT} is absent beside its name rather than implying the gate is behind us`);
  }
});

// RS-OPS-FR-02: all four positions, each with a file, a heading, a claim, a test
// and a mark. A dossier missing one is a review with a missing question.
test('the dossier carries all four positions, each with a file, a heading, a claim, a test and a mark', () => {
  assert.deepEqual(
    blocks.map((block) => block.id),
    POSITIONS,
    `the dossier's positions are ${blocks.map((block) => block.id).join(', ')}, which are not the four the review has to decide`,
  );

  for (const block of blocks) {
    assert.notEqual(block.heading, '', `the ${block.id} position sits under no heading of its own, so a reader cannot find it`);
    for (const field of ['Position', 'The question the reviewer answers', 'The claim, in the project\'s own words', 'Stated in', 'Asserted by', 'Status']) {
      const value = block.fields.get(field);
      assert.ok(value !== undefined && value !== '', `the ${block.id} position has no "${field}" row`);
    }
    // RS-OPS-FR-02 names a file and a heading, so a position that names only a
    // file leaves the reviewer reading the whole document.
    const statedIn = citationsIn(block.fields.get('Stated in') ?? '');
    assert.equal(statedIn.length, 1, `the ${block.id} position names ${statedIn.length} places it is stated in`);
    assert.ok(statedIn[0]?.heading, `the ${block.id} position names a file but no heading to read it at`);
    assert.match(
      block.fields.get('The claim, in the project\'s own words') ?? '',
      /^".+"$/,
      `the ${block.id} position does not quote the claim it is asking a reviewer to confirm`,
    );
    assert.ok(
      namedTestsIn(block.fields.get('Asserted by') ?? '', block.id).length > 0,
      `the ${block.id} position names no test that asserts it`,
    );
  }
});

// RS-C12 and the dossier's own promise: a citation that stops resolving is a
// citation the reviewer cannot follow, so the file has to exist.
test('every file the dossier cites exists in this repository', () => {
  const citations = everyCitation(dossier);
  assert.ok(citations.length >= 8, `the dossier cites ${citations.length} files, which is too few to gather four positions`);
  for (const citation of citations) {
    const target = statSync(path.join(ROOT, citation.file), { throwIfNoEntry: false });
    assert.ok(target?.isFile() === true, `the dossier cites ${citation.file}, which is not a file in this repository`);
  }
});

// RS-C12: a renamed heading leaves the reviewer reading the whole document instead
// of the position, so the heading is checked rather than the file alone.
test('every heading the dossier cites is still at that heading in the file it names', () => {
  const cited = everyCitation(dossier).filter((citation) => citation.heading !== null);
  assert.ok(cited.length >= 8, `the dossier cites only ${cited.length} headings`);
  for (const citation of cited) {
    const heading = headingText(citation);
    assert.notEqual(heading, '', `the dossier cites ${citation.file} with an empty heading`);
    const found = read(path.join(ROOT, citation.file))
      .split('\n')
      .some((line) => new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`).test(line));
    assert.ok(found, `${citation.file} has no "${heading}" heading for the position the dossier cites it for`);
  }
});

// RS-OPS-C04 and RS-C06: the sentences a reviewer has to confirm are quoted, and
// each quotation is checked against the heading it is attributed to, so a rewritten
// document cannot leave the dossier quoting something it no longer says.
test('every sentence the dossier quotes is present, in full, at the heading it is attributed to', () => {
  const quotes = everyQuotation(blocks);
  assert.ok(quotes.length >= 20, `the dossier quotes ${quotes.length} sentences, which is too few to gather four positions`);
  for (const citation of quotes) {
    const quoted = (citation.quote ?? '').trim();
    assert.notEqual(quoted, '', `the dossier cites ${citation.file} without quoting what it says there`);
    assert.ok(
      flatten(citedScope(citation)).includes(quoted),
      `the dossier quotes "${quoted}" from ${citation.file}` +
        `${citation.heading === null ? '' : ` at "${headingText(citation)}"`}, which is not what that document says there`,
    );
  }
});

// RS-OPS-FR-01 is the review, and no test stands in for it. The dossier names the
// tests that hold each position, and those tests have to exist and declare the
// test the dossier names.
test('every test the dossier names exists and declares the named test', () => {
  const named = blocks.flatMap((block) =>
    namedTestsIn(block.fields.get('Asserted by') ?? '', block.id).map((entry) => ({ position: block.id, ...entry })),
  );
  assert.ok(named.length >= 8, `the dossier names ${named.length} tests across four positions`);
  for (const entry of named) {
    const target = statSync(path.join(ROOT, entry.file), { throwIfNoEntry: false });
    assert.ok(target?.isFile() === true,
      `the ${entry.position} position names ${entry.file} as the test that asserts it, and this repository has no such test`);
    const declared = new RegExp(`\\btest\\(\\s*${QUOTE}${escapeRegExp(entry.name)}${QUOTE}`);
    assert.ok(declared.test(read(path.join(ROOT, entry.file))),
      `${entry.file} does not declare the test "${entry.name}" the dossier names for the ${entry.position} position`);
  }
});

// RS-OPS-FR-02: each position is marked, and a mark is not a decision. A position
// resolved here would be a posture decision no agent may make.
test('each position carries one of the two marks, and the index agrees with the block it indexes', () => {
  const index = indexTable(dossier);
  assert.equal(index.size, POSITIONS.length, `the dossier's index lists ${index.size} positions rather than ${POSITIONS.length}`);
  for (const block of blocks) {
    const status = label(block.fields.get('Status') ?? '');
    assert.ok(STATUS_MARKS.includes(status), `the ${block.id} position is marked "${status}", which is neither mark`);
    // The index and the block are one claim written twice, so a reader who only
    // reads the index and this test must not come away with different answers.
    const row = index.get(block.id);
    assert.ok(row !== undefined, `the index does not list the ${block.id} position`);
    assert.equal(label(row.status), status, `the index and the ${block.id} position disagree about its mark`);
    assert.equal(
      citationsIn(row.statedIn)[0]?.file,
      citationsIn(block.fields.get('Stated in') ?? '')[0]?.file,
      `the index and the ${block.id} position disagree about the file it lives in`,
    );
  }
  for (const id of POSITIONS) {
    assert.ok(index.has(id), `the index does not list the ${id} position`);
  }
});

// RS-C06: the dossier carries the project's own statement in full, and does not
// narrow it into a modal a reader could act on the other way.
test('the dossier states the redistribution position in the project\'s own words and does not narrow it', () => {
  // Both halves, exactly as README.md states them: whose data it is, and the
  // prohibition. A dossier quoting one would leave the reviewer guessing.
  assert.ok(
    flat.includes('GitHub\'s repository traffic data is GitHub\'s aggregate data. This archive may not be redistributed.'),
    'the dossier does not carry the redistribution statement in the project\'s own words',
  );
  assert.match(flat, /no command exports, publishes or shares an archive/, 'the dossier does not name the no-export constraint');
  assert.match(flat, /dashboard offers no download of one|no archive download/, 'the dossier does not name the no-download constraint');
  for (const softened of SOFTENED_STATEMENT) {
    assert.doesNotMatch(flat, softened, `the dossier narrows the redistribution statement with "${String(softened)}"`);
  }
  // A backup is a copy rather than a redistribution: the one thing the statement
  // does not forbid. Losing it would overstate the position instead of weakening it.
  assert.match(flat, /is a copy, not a redistribution/, 'the dossier drops the distinction between a copy and a redistribution');
});

// A dossier that gathers evidence must not also record a result, an approval or a
// compliance claim. A suite passing proves a sentence is still in a document; it
// is not evidence that a position is right.
test('the dossier names no approval, no observed result and no compliance claim, and says where a decision goes', () => {
  for (const claim of UNATTESTED_CLAIMS) {
    assert.doesNotMatch(dossier, claim, `the dossier states ${String(claim)}, which is an observation or a decision nobody made`);
  }
  // The two halves of a person reading this: what a passing suite is not, and
  // where the decision is written down.
  assert.match(flat, /a passing suite is evidence that a sentence is still in a document/,
    'the dossier must say a passing test suite is not evidence for a position');
  assert.ok(flat.includes(`belong in \`${REVIEW_ARTEFACT}\``), 'the dossier must say the decision belongs in the review artefact');
});

// RS-OPS-C04 and RS-C06 are also a claim about the product's shape, not only about
// a document. The registry is the authority on what a command can be asked to do,
// so the command set is read rather than taken from the prose.
test('no registered command exports, publishes, shares or uploads an archive', () => {
  const commands = listCommands();
  assert.ok(commands.length > 0, 'the command registry is empty, so the check would be vacuous');
  for (const command of commands) {
    assert.doesNotMatch(command.name, PUBLISHING_NAME, `the registry has a command called "${command.name}", which reads as publishing the archive`);
    assert.doesNotMatch(command.summary, PUBLISHING_SUMMARY, `the command "${command.name}" describes itself as "${command.summary}"`);
  }
  // `db backup` is the one command that writes a copy, and it says so in words
  // rather than in an action: a copy is what the redistribution statement allows.
  const backup = commands.find((command) => command.name === 'db backup');
  assert.ok(backup !== undefined, 'the registry no longer has a db backup command');
  assert.match(backup.summary, /copy/i, 'db backup no longer describes what it writes as a copy');
  assert.doesNotMatch(backup.summary, /upload|publish|share/i, 'db backup describes itself as publishing something');
});