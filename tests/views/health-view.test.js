import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { appendRun, openArchive, upsertRepository } from '../../src/db/ops-repo.js';
import { resolveHomePaths } from '../../src/paths.js';
import { escapeAttribute, escapeText, escapeUrl } from '../../src/server/html.js';
import { createRouter } from '../../src/server/router.js';
import { VIEW_PATH_TABLE, createViewRegistry } from '../../src/server/views/index.js';
import {
  HEALTH_PAGE_PATH, HEALTH_SECTION_ORDER, NO_FAILURE_TEXT, NOT_YET_CONNECTED_TEXT, NO_SUCCESS_TEXT,
  REAUTHENTICATE_ANCHOR, readCollectionHealthPage, renderCollectionHealthPage,
} from '../../src/server/views/health.js';
import { TRAFFIC_PERMISSION } from '../../src/supervision/errors.js';
import { collectionHealth } from '../../src/supervision/health.js';
import { recordFailure, recordSuccess } from '../../src/supervision/repo-state-reporter.js';

/**
 * The collection health page, mounted by the product's own registry and rendered by the
 * product's own shell and escaping helpers.
 *
 * The fixture archive holds one enrolled repository in every state the health read can
 * report, written through the product's own writes - identities through the repository
 * upsert, successes and failures through the supervision recorder - so a page that
 * renders plausibly over the wrong data still fails here. Nothing in this file renders
 * markup by hand: a test that escaped its own fixture would prove something about the
 * test rather than about the page.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../../src/server/views/health.js').HealthPageContext} HealthPageContext */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VIEW_FILE = path.join(ROOT, 'src', 'server', 'views', 'health.js');
const CLI = path.join(ROOT, 'src', 'cli.js');

/** The instant every health read in this file is taken at, and the day it resolves to. */
const READ_AT = '2026-10-02T12:00:00.000Z';
const READ_AT_MS = Date.parse(READ_AT);
const TODAY = '2026-10-02';

/** A success five hours before the read: inside the 26-hour threshold, so healthy. */
const RECENT_AT = '2026-10-02T07:00:00.000Z';
/** A success thirty hours before the read: past the threshold, so stalled. */
const STALE_AT = '2026-10-01T06:00:00.000Z';
/** The instant the two recorded failures were written. */
const FAILED_AT = '2026-10-02T08:00:00.000Z';
const RUN_ONE = '2026-09-20T06:00:00.000Z';

/** RS-SP-07: an identity whose stored spelling is markup, not a name. */
const HOSTILE_OWNER = 'own&er';
const HOSTILE_NAME = '"><script>alert(1)</script>';
const HOSTILE_LABEL = `${HOSTILE_OWNER}/${HOSTILE_NAME}`;

/**
 * The state each fixture repository is recorded in, by name. Every state the read can
 * report is here, so a state that stopped rendering would fail rather than go unnoticed.
 * @type {Readonly<Record<string, string>>}
 */
const EXPECTED_STATES = Object.freeze({
  'owner/alpha': 'healthy',
  'owner/fresh': 'never-collected',
  'owner/beta': 'degraded',
  'owner/gamma': 'needs-re-authentication',
  'owner/quiet': 'stalled',
  'owner/delta': 'unavailable',
  'owner/odd': 'unreadable',
  [HOSTILE_LABEL]: 'healthy',
});

/**
 * Write the archive: one enrolled repository per state, plus the identity whose stored
 * spelling is markup, plus the run row the recorded failures belong to.
 *
 * @param {Database} db
 * @returns {void}
 */
function seedEveryState(db) {
  appendRun(db, { id: 'run-1', startedAt: RUN_ONE });
  // healthy: a success recorded five hours before the read.
  upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: RECENT_AT, enrolled: 1 });
  recordSuccess({ db, repositoryId: 1, collectedAt: RECENT_AT });
  // never-collected: enrolled, and no run has ever registered it.
  upsertRepository(db, { id: 2, owner: 'owner', name: 'fresh', lastSeenAt: RUN_ONE, enrolled: 1 });
  // degraded: a success, then a failure nothing a new token leaves.
  upsertRepository(db, { id: 3, owner: 'owner', name: 'beta', lastSeenAt: RECENT_AT, enrolled: 1 });
  recordSuccess({ db, repositoryId: 3, collectedAt: RECENT_AT });
  recordFailure({
    db, repositoryId: 3, runId: 'run-1', repo: 'owner/beta', endpointType: 'traffic',
    error: { status: 429 }, collectedAt: FAILED_AT,
  });
  // needs-re-authentication: the traffic endpoint refused the credential.
  upsertRepository(db, { id: 4, owner: 'owner', name: 'gamma', lastSeenAt: FAILED_AT, enrolled: 1 });
  recordFailure({
    db, repositoryId: 4, runId: 'run-1', repo: 'owner/gamma', endpointType: 'traffic',
    error: { status: 403 }, collectedAt: FAILED_AT,
  });
  // stalled: a success recorded thirty hours before the read.
  upsertRepository(db, { id: 5, owner: 'owner', name: 'quiet', lastSeenAt: STALE_AT, enrolled: 1 });
  recordSuccess({ db, repositoryId: 5, collectedAt: STALE_AT });
  // unavailable: GitHub no longer serves it, and it also has a success inside the
  // threshold, so the single named state has to be the one with a next step.
  upsertRepository(db, {
    id: 6, owner: 'owner', name: 'delta', lastSeenAt: FAILED_AT, enrolled: 1,
    lifecycle: 'unavailable',
    unavailableReason: 'GitHub answered HTTP 404 for owner/delta: the repository does not exist',
  });
  recordSuccess({ db, repositoryId: 6, collectedAt: RECENT_AT });
  // unreadable: a recorded success time this build cannot parse, which is an unknown
  // state and never a stall.
  upsertRepository(db, {
    id: 7, owner: 'owner', name: 'odd', lastSeenAt: RECENT_AT, lastSuccessAt: RECENT_AT, enrolled: 1,
  });
  db.prepare('UPDATE repositories SET last_success_at=? WHERE id=7').run('the day before yesterday');
  // The hostile identity, collected like any other, so escaping is not the only thing
  // the page does with it.
  upsertRepository(db, { id: 8, owner: HOSTILE_OWNER, name: HOSTILE_NAME, lastSeenAt: RECENT_AT, enrolled: 1 });
  recordSuccess({ db, repositoryId: 8, collectedAt: RECENT_AT });
}

/**
 * @typedef {object} Fixture
 * @property {Database} db
 * @property {string} home
 * @property {string} databasePath
 * @property {ReturnType<typeof createViewRegistry>} registry
 * @property {(req: any) => Promise<{status: number, body: string}>} handle
 */

/**
 * A temporary home holding a migrated archive with every health state in it, mounted
 * through the product's registry and router: the handler is the one `serve` mounts, so
 * a page this file renders is the page the dashboard serves.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ seed?: boolean }} [options]
 * @returns {Promise<Fixture>}
 */
async function fixture(t, options = {}) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-health-view-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  t.after(() => db.close());
  if (options.seed !== false) seedEveryState(db);
  const registry = createViewRegistry({ db, clock: () => READ_AT_MS, today: TODAY });
  const router = createRouter({ views: registry.views, hasRepository: registry.hasRepository });
  return {
    db,
    home: paths.home,
    databasePath: paths.databasePath,
    registry,
    handle: registry.answerOwnRoutes(router),
  };
}

/**
 * Drive the mounted handler and read the whole document it renders.
 * @param {Fixture} f
 * @param {string} url
 * @returns {Promise<{status: number, body: string}>}
 */
async function request(f, url) {
  const response = await f.handle(/** @type {any} */ ({ url }));
  return typeof response === 'string' ? { status: 200, body: response } : response;
}

/**
 * Every table row of the health table, as its markup.
 * @param {string} body
 * @returns {string[]}
 */
function rowMarkups(body) {
  return [...body.matchAll(/<tr data-repository="[^"]*"[^>]*>[\s\S]*?<\/tr>/g)].map((match) => match[0]);
}

/**
 * The row for one repository, by its archived spelling. The lookup goes through the
 * escaped attribute the page itself carries, so a fixture that escaped nothing would
 * not find its own row.
 * @param {string} body
 * @param {string} repo
 * @returns {string}
 */
function rowFor(body, repo) {
  const row = rowMarkups(body).find((markup) => markup.includes(`data-repository="${escapeAttribute(repo)}"`));
  assert.ok(row !== undefined, `${repo} has a row; got ${JSON.stringify(rowMarkups(body))}`);
  return row;
}

/**
 * One cell of one row, addressed by the class the cell carries - the same class the
 * stylesheet will target, so the tests address cells the way the page is built.
 * @param {string} row
 * @param {string} className
 * @returns {string}
 */
function cell(row, className) {
  const cellMarkup = new RegExp(`<td class="${className}"[^>]*>[\\s\\S]*?</td>`).exec(row);
  assert.ok(cellMarkup !== null, `the row carries a ${className} cell; got ${JSON.stringify(row)}`);
  return cellMarkup[0];
}

/**
 * Every heading in the served markup, in document order, as its level.
 * @param {string} body
 * @returns {number[]}
 */
function headingLevels(body) {
  return [...body.matchAll(/<h([1-6])\b[^>]*>/g)].map((match) => Number(match[1]));
}

/**
 * Every addressable reference the served markup carries.
 * @param {string} body
 * @returns {string[]}
 */
function referencesOf(body) {
  return [...body.matchAll(/\b(?:href|src|srcset)\s*=\s*"([^"]*)"/g)].map((match) => match[1] ?? '');
}

/**
 * The document with every class attribute removed: what a reader - or a forced colours
 * mode - is left with when no styling applies at all.
 * @param {string} body
 * @returns {string}
 */
function withoutClasses(body) {
  return body.replaceAll(/\sclass="[^"]*"/g, '');
}

test('the health page is registered in the registry at a path of its own and answers it', async (t) => {
  // Arrange: the real registry over a real archive, mounted in front of the real router.
  const f = await fixture(t);

  // Act: the registry's own mount table, then a request for the page and for the routes
  // the router owns.
  assert.equal(VIEW_PATH_TABLE.length, 1, 'the registry owns exactly one page of its own');
  const [mount] = VIEW_PATH_TABLE;
  assert.equal(mount?.path, HEALTH_PAGE_PATH);
  assert.equal(mount?.path, '/health');
  assert.equal(mount?.route, 'health');
  assert.equal(mount?.read, readCollectionHealthPage, 'the page reads through its own module');
  assert.equal(mount?.render, renderCollectionHealthPage, 'the page renders through its own module');
  assert.equal(f.registry.healthPath, HEALTH_PAGE_PATH, 'the registry publishes the path it serves');

  const page = await request(f, HEALTH_PAGE_PATH);
  const trailing = await request(f, `${HEALTH_PAGE_PATH}/`);
  const index = await request(f, '/');
  const list = await request(f, '/repos');
  const unknown = await request(f, '/nowhere');

  // Assert: the page answers at its own path, and the router still owns every route and
  // every status it owns.
  assert.equal(page.status, 200);
  assert.match(page.body, /<h1>Collection health<\/h1>/, 'the health page is a page of its own');
  assert.equal(trailing.status, 200);
  assert.equal(trailing.body, page.body, 'a trailing slash folds to the same page');
  assert.equal(index.status, 200);
  assert.match(index.body, /<title>RepoSignal<\/title>/, 'the index is still the index');
  assert.equal(list.status, 200);
  assert.match(list.body, /<h1>Enrolled repositories<\/h1>/, 'the list is still the list');
  assert.equal(unknown.status, 404, 'the router still answers 404 for a path nobody mounted');
  assert.match(unknown.body, /No page matches/);
  const title = /<title>([^<]*)<\/title>/.exec(page.body)?.[1];
  assert.equal(title, 'Collection health - RepoSignal', 'the page carries its own unique title');
});

test('every enrolled repository gets a row and each state renders its own state word', async (t) => {
  // Arrange: the archive holds every state the health read can report.
  const f = await fixture(t);

  // Act: the page, and the one read the CLI shares over the same archive.
  const page = await request(f, HEALTH_PAGE_PATH);
  const health = collectionHealth({ db: f.db, clock: () => READ_AT_MS });

  // Assert: one row per enrolled repository, in the archive's own order, each carrying
  // the state word the read returned - the page and the command cannot disagree.
  assert.equal(page.status, 200);
  assert.deepEqual(health.repositories.map((entry) => [entry.repo, entry.state]),
    Object.entries(EXPECTED_STATES), 'the fixture holds one repository in every named state');
  const rows = rowMarkups(page.body);
  assert.equal(rows.length, Object.keys(EXPECTED_STATES).length, 'one row per enrolled repository');
  for (const entry of health.repositories) {
    const row = rowFor(page.body, entry.repo);
    assert.ok(row.includes(`data-state="${entry.state}"`), `${entry.repo} marks its state as ${entry.state}`);
    assert.ok(row.includes(`<span class="state-word">${entry.state}</span>`),
      `${entry.repo} announces its state word as text`);
    assert.ok(row.includes(escapeText(entry.reason)),
      `${entry.repo} carries the sentence the read wrote for it, un-reworded`);
  }

  // RS-AX-07: all seven named states are on the page as text, so no state exists only
  // as a colour, a badge or an icon.
  for (const state of ['healthy', 'never-collected', 'degraded', 'needs-re-authentication', 'stalled',
    'unavailable', 'unreadable']) {
    assert.match(page.body, new RegExp(`<span class="state-word">${state}</span>`),
      `the ${state} state renders its own state word`);
  }
});

test('a needs-re-authentication row names the Administration read permission in its action', async (t) => {
  // Arrange: the repository whose traffic endpoint refused the credential.
  const f = await fixture(t);

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);

  // Assert: the action cell names the permission the traffic endpoints require, and
  // links to guidance rendered on the page rather than to a remote host.
  const row = rowFor(page.body, 'owner/gamma');
  const action = cell(row, 'action');
  assert.ok(row.includes('data-state="needs-re-authentication"'));
  assert.ok(action.includes(escapeText(TRAFFIC_PERMISSION)),
    `the action names the permission; got ${JSON.stringify(action)}`);
  assert.ok(action.includes(`href="#${REAUTHENTICATE_ANCHOR}"`), 'the action links to the guidance on this page');
  assert.ok(page.body.includes(`id="${REAUTHENTICATE_ANCHOR}"`), 'the anchor the action links to exists on the page');
  assert.match(page.body, /<h2 id="re-authentication-heading">Re-authenticating with the traffic permission<\/h2>/,
    'the guidance is a labelled section a heading can be read from');
  assert.ok(referencesOf(page.body).every((reference) => /^(#|\/(?!\/))/.test(reference)),
    `every reference is a same-origin path or an anchor; got ${referencesOf(page.body).join(', ')}`);
  // RS-SP-02: the 403 is reported as its own state with this action, not as an error.
  const failure = cell(row, 'last-failure');
  assert.ok(failure.includes('Kind permission-missing'), 'the recorded failure names its own kind');
  assert.ok(failure.includes(escapeText(TRAFFIC_PERMISSION)),
    'the recorded failure message itself names the permission the archive stored');
});

test('a stalled row names the time of the last successful collection', async (t) => {
  // Arrange: the repository whose last success is past the 26-hour threshold.
  const f = await fixture(t);

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);

  // Assert: the warning names the recorded instant it stopped at, in the state cell, in
  // the last-success cell and in the action that names what to do.
  const row = rowFor(page.body, 'owner/quiet');
  assert.ok(row.includes('data-state="stalled"'));
  const lastSuccess = cell(row, 'last-success');
  assert.ok(lastSuccess.includes(`<time datetime="${STALE_AT}">${STALE_AT}</time>`),
    `the last-success cell carries the recorded instant; got ${JSON.stringify(lastSuccess)}`);
  const action = cell(row, 'action');
  assert.match(action, /Collection has stopped/, 'the warning is announced as text');
  assert.ok(action.includes(`<time datetime="${STALE_AT}">${STALE_AT}</time>`),
    'the warning names the time of the last successful collection');
  assert.ok(action.includes('scheduled-collection.md'), 'the action names the schedule to check');
  assert.ok(action.includes('node src/cli.js collect'), 'the action names a command that exists');
  const stored = /** @type {{last_success_at: string|null}} */ (/** @type {unknown} */ (
    f.db.prepare('SELECT last_success_at FROM repositories WHERE id=5').get()));
  assert.equal(stored.last_success_at, STALE_AT, 'the instant on the page is the one the archive recorded');
});

test('a never-collected repository reads as not yet connected and carries no failure action', async (t) => {
  // Arrange: the enrolled repository no run has ever registered.
  const f = await fixture(t);

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);

  // Assert: the row reads as not yet connected, says that nothing has failed, and offers
  // no remedy for a failure it never had. RS-SP-02's empty state, not a broken state.
  const row = rowFor(page.body, 'owner/fresh');
  assert.ok(row.includes('data-state="never-collected"'));
  assert.ok(row.includes(escapeText(NOT_YET_CONNECTED_TEXT)), 'the row reads as not yet connected');
  const action = cell(row, 'action');
  assert.equal(/<a\b/.test(action), false, 'a first-connect row offers no link to a remedy');
  assert.equal(action.includes(escapeText(TRAFFIC_PERMISSION)), false,
    'a repository that never ran is not asked for a permission');
  assert.equal(/re-authenticate/i.test(action), false, 'a first-connect row carries no re-authentication action');
  assert.equal(/Collection has stopped/.test(action), false, 'and no stalled warning');
  assert.match(action, /nothing has failed/, 'it says outright that nothing has failed');
  assert.ok(cell(row, 'last-failure').includes(escapeText(NO_FAILURE_TEXT)));
  assert.ok(cell(row, 'last-success').includes(escapeText(NO_SUCCESS_TEXT)));
  assert.ok(cell(row, 'failure-count').includes('data-count="0"'), 'a recorded zero, not a blank');
  // The read never calls it stalled, and neither does the page.
  const health = collectionHealth({ db: f.db, clock: () => READ_AT_MS });
  const fresh = health.repositories.find((entry) => entry.repo === 'owner/fresh');
  assert.equal(fresh?.stalled, false);
  assert.equal(fresh?.consecutiveFailures, 0);
});

test('a degraded row names the recorded streak and the most recent recorded failure', async (t) => {
  // Arrange: the repository whose last collection was rate limited.
  const f = await fixture(t);

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);

  // Assert: the counter and the evidence are both shown, in words as well as digits.
  const row = rowFor(page.body, 'owner/beta');
  assert.ok(row.includes('data-state="degraded"'));
  assert.ok(cell(row, 'failure-count').includes('1 consecutive recorded failure'),
    'the streak is stated as a recorded count');
  const failure = cell(row, 'last-failure');
  assert.ok(failure.includes('Kind rate-limited'), 'the failure names the kind the classifier recorded');
  assert.ok(failure.includes(FAILED_AT), 'the failure names the instant it was recorded');
  assert.ok(failure.includes('run-1'), 'the failure names the run that recorded it');
  assert.ok(cell(row, 'action').includes('node src/cli.js collect'), 'the action names a command that exists');
});

test('an unavailable repository is reported as recorded and not as a failure to fix', async (t) => {
  // Arrange: the repository GitHub no longer serves, which also has a recent success.
  const f = await fixture(t);

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);

  // Assert: the single named state is the one with a next step, and the page says why
  // there is nothing to collect rather than showing a failure count to repair.
  const row = rowFor(page.body, 'owner/delta');
  assert.ok(row.includes('data-state="unavailable"'), 'the state the read named is the one rendered');
  const action = cell(row, 'action');
  assert.match(action, /GitHub no longer serves this repository/);
  assert.match(action, /history already recorded is kept/);
  assert.equal(action.includes(escapeText(TRAFFIC_PERMISSION)), false,
    'a repository that vanished is not asked for a permission');
});

test('an unreadable recorded instant is shown as the text the archive holds, never as a datetime', async (t) => {
  // Arrange: the repository whose recorded success instant this build cannot parse.
  const f = await fixture(t);
  const stored = /** @type {{last_success_at: string|null}} */ (/** @type {unknown} */ (
    f.db.prepare('SELECT last_success_at FROM repositories WHERE id=7').get()));
  assert.equal(stored.last_success_at, 'the day before yesterday', 'the archive holds the unreadable value');

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);

  // Assert: the value is shown exactly as recorded, and never dressed up as a machine-
  // readable instant an assistive technology would try and fail to parse. The row is
  // also not read as stalled, which is the state the read refused to infer.
  const row = rowFor(page.body, 'owner/odd');
  assert.ok(row.includes('data-state="unreadable"'), 'the state is the one the read named');
  const lastSuccess = cell(row, 'last-success');
  assert.ok(lastSuccess.includes('the day before yesterday'), 'the recorded value is shown as recorded');
  assert.equal(/<time\b/.test(lastSuccess), false, 'an unreadable value is not a machine-readable instant');
  assert.equal(lastSuccess.includes('datetime="the day before yesterday"'), false,
    'and never appears in a datetime attribute');
  assert.ok(lastSuccess.includes('data-machine-readable="no"'), 'the page says the value is not machine-readable');
  assert.match(cell(row, 'action'), /cannot be read by this build/);
  assert.equal(/Collection has stopped/.test(row), false, 'an unreadable instant is not reported as a stall');
});

test('the page states the whole-archive roll-up, the last run and the instant it read', async (t) => {
  // Arrange: the same archive the CLI would report.
  const f = await fixture(t);

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);
  const health = collectionHealth({ db: f.db, clock: () => READ_AT_MS });

  // Assert: the roll-up sentence, the run sentence and the read instant are the read's
  // own words, and the breakdown names each state the read counted.
  assert.ok(page.body.includes(escapeText(health.summary.reason)), 'the roll-up sentence is the read\'s own');
  assert.ok(page.body.includes(escapeText(health.run.reason)), 'the run sentence is the read\'s own');
  assert.ok(page.body.includes(`<time datetime="${READ_AT}">${READ_AT}</time>`),
    'the page states the instant the health read was taken');
  assert.ok(page.body.includes(`${health.summary.enrolled} repositories enrolled in this archive`));
  assert.equal(health.summary.healthy, 2);
  for (const [state, count] of Object.entries({
    'needs re-authentication': health.summary.needsReauthentication,
    'never collected': health.summary.neverCollected,
    degraded: health.summary.degraded,
    stalled: health.summary.stalled,
    unavailable: health.summary.unavailable,
    unreadable: health.summary.unreadable,
  })) {
    assert.ok(page.body.includes(`<span class="state-word">${state}</span>: ${count} enrolled `),
      `the breakdown counts ${count} repositories reading as ${state}`);
  }
});

test('every state stays readable as text once every class attribute is removed', async (t) => {
  // Arrange: the page over the archive holding every state.
  const f = await fixture(t);

  // Act: the page, and the same page with no styling information at all.
  const page = await request(f, HEALTH_PAGE_PATH);
  const stripped = withoutClasses(page.body);
  const health = collectionHealth({ db: f.db, clock: () => READ_AT_MS });

  // Assert: each state word, each sentence the read wrote for it, and each action a
  // maintainer needs survive with every class gone, so no state was carried by a badge.
  for (const entry of health.repositories) {
    assert.ok(stripped.includes(`>${entry.state}<`), `${entry.repo} still names its state word`);
    assert.ok(stripped.includes(escapeText(entry.reason)),
      `${entry.repo} still carries the sentence behind its state word`);
  }
  assert.ok(stripped.includes(escapeText(TRAFFIC_PERMISSION)),
    'the permission a refused token needs survives losing every class');
  assert.ok(stripped.includes(escapeText(NOT_YET_CONNECTED_TEXT)),
    'the not-yet-connected wording survives losing every class');
  assert.match(stripped, /Collection has stopped/, 'the stalled warning survives losing every class');
  assert.ok(stripped.includes('1 consecutive recorded failure'), 'the recorded streak survives as text');
  assert.ok(stripped.includes('Last successful collection:'), 'the last-success column survives as text');
  assert.ok(stripped.includes('Kind rate-limited'), 'the recorded failure survives as text');
  // The state words are text, not attributes: no row's state is only in a class or a
  // data-attribute, because neither survives a forced colours mode.
  for (const entry of health.repositories) {
    assert.ok(withoutClasses(rowFor(page.body, entry.repo)).includes(`>${entry.state}<`),
      `${entry.repo} states its state in text, not only in a class`);
  }
});

test('a failure is never restated as a data gap', async (t) => {
  // Arrange: the archive holds recorded failures beside repositories with no failure.
  const f = await fixture(t);

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);

  // Assert: the word gap appears nowhere, so no row can have described a collection
  // failure as a missing day, and each failure is reported as the recorded failure it is.
  assert.equal(/gap/i.test(page.body), false,
    `no failure is described as a gap; got ${JSON.stringify(page.body)}`);
  for (const repo of ['owner/beta', 'owner/gamma']) {
    const row = rowFor(page.body, repo);
    assert.match(row, /data-kind=/, `${repo} reports a recorded failure with its kind`);
    assert.ok(!/unmeasured|missing day|no stored row/i.test(row),
      `${repo} never describes its recorded failure as absent data`);
  }
  // The page states the distinction in words, in the direction that is safe: a failed
  // collection changes no stored day.
  assert.match(page.body, /never described here as a day the archive does not hold/);
});

test('a repository name carrying markup is escaped in every context and raw nowhere', async (t) => {
  // Arrange: the archive holds an identity whose stored spelling is markup.
  const f = await fixture(t);

  // Act: the page.
  const page = await request(f, HEALTH_PAGE_PATH);

  // Assert: escaped per context, and the payload reaches the page as text in each one.
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(escapeText(HOSTILE_LABEL)), 'escaped in text context');
  assert.ok(page.body.includes(`data-repository="${escapeAttribute(HOSTILE_LABEL)}"`), 'attribute escaped');
  const href = `/repo/${escapeUrl(HOSTILE_OWNER)}/${escapeUrl(HOSTILE_NAME)}`;
  assert.ok(page.body.includes(`href="${escapeAttribute(href)}"`), 'percent-encoded in URL context');
  assert.equal(page.body.includes(HOSTILE_NAME), false, 'the raw name appears nowhere');
  assert.equal(/<script/i.test(page.body), false, 'no script element reaches the page');
  // The archive still holds the spelling a collector recorded.
  const stored = /** @type {{owner: string, name: string}} */ (/** @type {unknown} */ (
    f.db.prepare('SELECT owner, name FROM repositories WHERE id=8').get()));
  assert.equal(stored.owner, HOSTILE_OWNER);
  assert.equal(stored.name, HOSTILE_NAME);
});

test('the page carries no script, no handler, no remote reference, no colour and no motion', async (t) => {
  // Arrange: the page, its sections and the empty state of a second archive.
  const f = await fixture(t);
  const empty = await fixture(t, { seed: false });
  const pages = /** @type {Array<[string, {status: number, body: string}]>} */ ([
    ['populated', await request(f, HEALTH_PAGE_PATH)],
    ['empty', await request(empty, HEALTH_PAGE_PATH)],
  ]);

  for (const [label, page] of pages) {
    assert.equal(/<script/i.test(page.body), false, `${label}: no script element`);
    assert.equal(/<[^>]+\son[a-z]+\s*=/i.test(page.body), false, `${label}: no inline event handler`);
    assert.equal(/https?:\/\//i.test(page.body.replaceAll('http://127.0.0.1', '')), false,
      `${label}: the page names no remote host`);
    assert.equal(/@import|@font-face|url\(/i.test(page.body), false, `${label}: no imported font, style or image`);
    assert.equal(/<img\b|<iframe\b|<object\b/i.test(page.body), false, `${label}: no remote or embedded asset`);
    assert.equal(/transition\s*:|animation\s*:|@keyframes|scroll-behavior/i.test(page.body), false,
      `${label}: no motion`);
    assert.equal(/#[0-9a-f]{3,8}\b|\brgba?\(/i.test(page.body), false, `${label}: no colour literal in markup`);
    assert.ok(referencesOf(page.body).length > 0, `${label}: the page references its stylesheet`);
    for (const reference of referencesOf(page.body)) {
      assert.match(reference, /^(#|\/(?!\/))/, `${label}: every reference is relative or same-origin; got ${reference}`);
    }
  }
});

test('the page has one main landmark, a skip link first, a heading order with no gap, and a caption', async (t) => {
  // Arrange: the served page.
  const f = await fixture(t);
  const page = await request(f, HEALTH_PAGE_PATH);
  const body = page.body;

  // Assert: the structural contract RS-AX-01 requires, on served markup.
  assert.equal(body.match(/<main\b/g)?.length, 1, 'exactly one main landmark');
  const focusable = [...body.matchAll(/<a\b[^>]*>|<button\b[^>]*>|<input\b[^>]*>/g)][0]?.[0] ?? '';
  assert.match(focusable, /href="#main"/, 'the skip link is the first focusable element');
  assert.match(body, /<html lang="en">/, 'the language is declared');
  assert.equal(body.match(/<title>/g)?.length, 1, 'the page carries exactly one title');
  const levels = headingLevels(body);
  assert.deepEqual(levels, [1, ...HEALTH_SECTION_ORDER.map(() => 2)],
    'the heading order is the page heading followed by one heading per section');
  for (let index = 1; index < levels.length; index += 1) {
    const previous = /** @type {number} */ (levels[index - 1]);
    const current = /** @type {number} */ (levels[index]);
    assert.ok(current <= previous + 1, `heading level ${current} follows ${previous}, which skips a level`);
  }
  // Every section is a labelled landmark whose label exists, so the page can be
  // navigated by heading.
  const sections = [...body.matchAll(/<section class="health-section[^>]*data-section="([^"]*)"[^>]*>/g)];
  assert.deepEqual(sections.map((match) => match[1]), [...HEALTH_SECTION_ORDER],
    'the sections appear in the order the page declares as data');
  for (const section of sections) {
    const labelled = /aria-labelledby="([^"]*)"/.exec(section[0])?.[1];
    assert.ok(labelled !== undefined && body.includes(`id="${labelled}"`),
      `the section ${section[1]} names a heading that exists`);
  }
  // The table carries a caption and a header cell per column, so no cell depends on
  // knowing the product's internals.
  assert.match(body, /<table class="health">/);
  assert.match(body, /<caption>[^<]*<\/caption>/, 'the table carries a caption naming what it holds');
  assert.equal([...body.matchAll(/<th scope="col"[^>]*>/g)].length, 6, 'a header cell per column');
  assert.equal([...body.matchAll(/<th scope="row"/g)].length, Object.keys(EXPECTED_STATES).length,
    'each repository is a row header, so every cell is named without its row');
  // The page draws no chart, so it has no figure needing a table beside it.
  assert.equal(/<figure\b/i.test(body), false, 'no figure means no chart without its table');
});

test('the page is deterministic: the same archive and clock render byte-identical markup', async (t) => {
  // Arrange: one archive and one fixed clock, so any difference between two renders came
  // from the render itself.
  const f = await fixture(t);
  /** @type {HealthPageContext} */
  const ctx = {
    route: 'health',
    owner: null,
    name: null,
    from: null,
    to: null,
    links: {
      index: '/',
      list: '/repos',
      detail: (owner, name) => `/repo/${escapeUrl(owner)}/${escapeUrl(name)}`,
    },
  };

  // Act: read and render twice through the module, then serve the page twice.
  const first = renderCollectionHealthPage(ctx, readCollectionHealthPage({ db: f.db, clock: () => READ_AT_MS }));
  const second = renderCollectionHealthPage(ctx, readCollectionHealthPage({ db: f.db, clock: () => READ_AT_MS }));
  assert.equal(first, second, 'two renders of the same archive are byte-identical');
  const served = await request(f, HEALTH_PAGE_PATH);
  assert.equal(first, served.body, 'the rendered page is the page the handler serves');

  // The read is a pass-through of the one health read, unchanged.
  const health = collectionHealth({ db: f.db, clock: () => READ_AT_MS });
  const data = readCollectionHealthPage({ db: f.db, clock: () => READ_AT_MS });
  assert.deepEqual(data.repositories, health.repositories);
  assert.deepEqual(data.summary, health.summary);
  assert.deepEqual(data.run, health.run);
  assert.equal(data.readAt, READ_AT);
});

test('the page module reads no clock of its own and reaches no host', () => {
  // The source of the page module, asserted rather than trusted: a render function that
  // read the wall clock or opened a socket could not be a function of its arguments.
  const source = readFileSync(VIEW_FILE, 'utf8');
  assert.equal(/Date\.now\(|new Date\(/.test(source), false, 'the page reads no clock of its own');
  assert.equal(/Math\.random/.test(source), false, 'the page introduces no randomness');
  assert.equal(/(^|[^.\w])fetch\s*\(/.test(source), false, 'the page makes no request');
  assert.equal(source.includes('node:http'), false, 'the page imports no transport');
  assert.equal(/readFileSync|writeFileSync/.test(source), false, 'the page touches no file');
});

test('a home that has enrolled nothing reads as a first-connect state, not an empty table', async (t) => {
  // Arrange: a migrated archive with no enrolled repository at all.
  const empty = await fixture(t, { seed: false });

  // Act: the page.
  const page = await request(empty, HEALTH_PAGE_PATH);

  // Assert: the empty case is announced as text, in the read's own word and sentence.
  assert.equal(page.status, 200);
  const health = collectionHealth({ db: empty.db, clock: () => READ_AT_MS });
  assert.equal(health.summary.state, 'empty');
  assert.deepEqual(health.repositories, []);
  assert.ok(page.body.includes(escapeText(health.summary.reason)), 'the roll-up sentence is the read\'s own');
  assert.match(page.body, /No repository is enrolled/);
  assert.match(page.body, /That is the state of the archive, not a page that failed to load/);
  assert.equal(page.body.includes('<table'), false, 'an empty table is not the empty state');
  assert.equal(rowMarkups(page.body).length, 0);
  // The guidance is still on the page: a maintainer who enrolled nothing can still read
  // what a collection needs.
  assert.ok(page.body.includes(escapeText(TRAFFIC_PERMISSION)));
});

test('the dashboard serves the page over loopback through `node src/cli.js serve`', async (t) => {
  // Arrange: a temporary home seeded through the product's own writes, so the running
  // dashboard answers with an archive a real run could have produced.
  const root = mkdtempSync('/tmp/opencode/repo-signal-health-serve-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: home } });
  const db = await openArchive(paths.databasePath);
  seedEveryState(db);
  // The command opens the archive itself, exactly as it does for a real home, so this
  // test never shares a connection with the process it starts.
  db.close();

  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: '', REPO_SIGNAL_HOME: home },
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve printed no URL; stdout was ${stdout}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /^serve listening on (http:\/\/127\.0\.0\.1:\d+)$/m.exec(stdout);
      if (match === null) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited with ${code} before it reported a URL; stdout was ${stdout}`));
    });
  });

  // Act: request the health page and the list page from the running dashboard.
  const page = await fetch(`${url}${HEALTH_PAGE_PATH}`);
  const list = await fetch(`${url}/repos`);
  const body = await page.text();

  // Assert: the page the registry mounts is served over loopback, with its states as
  // text, alongside the routes the router still owns.
  assert.equal(new URL(url).hostname, '127.0.0.1', 'the dashboard binds loopback only');
  assert.ok(stdout.includes(`collection health: ${url}${HEALTH_PAGE_PATH}`),
    `the command printed the health page's URL; got ${stdout}`);
  assert.equal(page.status, 200, `the health page must be served; body was ${body.slice(0, 300)}`);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(body, /<h1>Collection health<\/h1>/);
  assert.match(body, /<table class="health">/, 'the served page is the table of enrolled repositories');
  // The running command reads the wall clock, so the states that depend on elapsed time
  // are the clock's to decide here. The two that do not are asserted: a refused token and
  // a repository no run has ever registered read the same through any clock.
  assert.equal(rowMarkups(body).length, Object.keys(EXPECTED_STATES).length,
    'every enrolled repository has a row in the served page');
  for (const state of ['never-collected', 'needs-re-authentication']) {
    assert.ok(body.includes(`<span class="state-word">${state}</span>`),
      `the served page states ${state} as text`);
  }
  assert.ok(body.includes(escapeText(TRAFFIC_PERMISSION)), 'the served action names the permission');
  assert.ok(body.includes(`href="#${REAUTHENTICATE_ANCHOR}"`), 'the served action links to the page\'s guidance');
  assert.equal(list.status, 200, 'the list page the router owns is still served');
  assert.match(await list.text(), /<h1>Enrolled repositories<\/h1>/);

  // Act and assert: a signal ends the command with the success code.
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0, 'the command exits 0 when it is signalled');
});