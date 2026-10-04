import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COMMIT_ACTIVITY_METRIC,
  DEVELOPMENT_GRANULARITY,
  DEVELOPMENT_KIND,
  DEVELOPMENT_SOURCE,
  EXPECTED_WEEKS,
  OWNER_PARTICIPATION_METRIC,
  backfillDevelopment,
} from '../src/backfill/development.js';
import {
  CONNECTED,
  FIRST_COLLECTED_KIND,
  NOT_CONNECTED,
  readProvenance,
  stampFirstCollected,
} from '../src/backfill/provenance.js';
import { STARS_GRANULARITY, STARS_METRIC, STARS_SOURCE, backfillStars } from '../src/backfill/stars.js';
import { isBackfillRefused, markBackfillRefused } from '../src/collect/lifecycle.js';
import {
  BACKFILL_FIRST_CONNECT,
  BACKFILL_REQUESTS_FLOOR,
  BACKFILL_SKIPPED,
  RESOLUTION_REQUESTS_PER_REPOSITORY,
  TRAFFIC_REQUESTS_PER_REPOSITORY,
  planCollect,
} from '../src/collect/run.js';
import { TRAFFIC_SOURCE } from '../src/collect/traffic.js';
import { validateConfig } from '../src/config/schema.js';
import { readDaySeries } from '../src/db/day-series-repo.js';
import { getRepository, openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { STARGAZERS_RESTRICTED_ACTION } from '../src/github/retry.js';
import { resolveHomePaths } from '../src/paths.js';
import { createCollectHome, outputLines as lines } from './helpers/collect-home.js';

/**
 * The documented provenance and refusal claims, asserted against the modules that
 * keep them.
 *
 * Three sentences carry the whole feature: the README's "Backfilled days are not
 * collected days", the README's "the refusal is recorded once and reported on every
 * line", and the boundary a first collection stamps. A runbook sentence that drifts
 * from the module behind it is the failure this file exists to make impossible to
 * ship, so every assertion below reads a document as text *and* a module as a
 * module: a suite that only compared documents would pass while the product moved.
 *
 * The direction of repair is the document's. Nothing here changes a reconstruction
 * rule, a source label, a refusal column or a stamp; where a sentence and a module
 * disagree the failure names both sides so the reader knows which one to correct.
 *
 * No test reaches api.github.com and none uses a real token: the runs that need
 * GitHub are driven through `node src/cli.js` against a loopback stub behind
 * REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = path.join(ROOT, 'README.md');
const TROUBLESHOOTING = path.join(ROOT, 'docs', 'operations', 'troubleshooting.md');
const SCHEDULING = path.join(ROOT, 'docs', 'operations', 'scheduled-collection.md');
const FEATURE = path.join(ROOT, 'docs', 'features', 'first-connect-backfill.md');
const PROVENANCE_MODULE = path.join(ROOT, 'src', 'backfill', 'provenance.js');
const LIFECYCLE_MODULE = 'src/collect/lifecycle.js';
const RUN_MODULE = 'src/collect/run.js';
const STARS_MODULE = 'src/backfill/stars.js';
const DEVELOPMENT_MODULE = 'src/backfill/development.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('./helpers/stub-github-server.mjs').StubGitHub} StubGitHub */

/** The headings this suite reads its sentences out of. */
const LIMITS = 'The honest limits of the archive';
const TOKEN = 'The token';
const INSTALL = 'Install and run: clone and go';
const STAR_HISTORY_RUNBOOK = 'A star history GitHub will not serve';
const FIRST_RUN = 'First run has not succeeded yet';
const CATCH_UP = 'Catch up after a missed day';
const DATA_SHAPE = '4. Data Shape';

/** The first day of the fourteen-day traffic window the stub serves, unshifted. */
const WINDOW_START = '2026-09-19';
const WINDOW_DAYS = 14;
const LATER_WINDOW_START = '2026-09-20';

/**
 * A UTC midnight the reconstructed history is built from: a Sunday in 2020, far
 * enough in the past that a reconstructed day can never collide with the day a
 * collection stamps its own star level on.
 */
const HISTORY_BASE = Date.parse('2020-06-07T00:00:00Z') / 1000;

/**
 * One stargazer-history week, Sunday first, in the shape GitHub serves.
 * @param {number} daysAgo Days ago the week began.
 * @param {number[]} days Seven daily counts.
 * @returns {{week: number, total: number, days: number[]}}
 */
function starWeek(daysAgo, days) {
  return { week: HISTORY_BASE - daysAgo * 86_400, total: days.reduce((sum, day) => sum + day, 0), days };
}

/** Three stars on two distinct days, served newest week first as GitHub serves them. */
const STAR_HISTORY = [
  starWeek(0, [0, 0, 0, 0, 0, 0, 0]),
  starWeek(14, [0, 0, 0, 0, 2, 0, 0]),
  starWeek(21, [0, 0, 0, 1, 0, 0, 0]),
];

/** Two weeks of commit activity: fewer than a year, so the record is truncated. */
const COMMIT_ACTIVITY = [21, 14].map((weeksAgo, index) => ({
  week: HISTORY_BASE - weeksAgo * 86_400, total: 4 + index, days: [1, 2, 0, 1, 0, 0, 0],
}));
const PARTICIPATION = { all: [10, 12], owner: [3, 4] };

const FIRST_AT = '2026-10-04T09:00:00.000Z';
const LATER_AT = '2026-10-05T09:00:00.000Z';

/**
 * The reason the transport records when even the star history endpoint is refused.
 * Built from the policy's own exported sentence rather than repeated here, so a
 * change to that sentence cannot leave this suite asserting yesterday's words.
 */
const REFUSAL_REASON = `GitHub HTTP 403: ${STARGAZERS_RESTRICTED_ACTION}`;

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Flatten a page's line wrapping, so an assertion about a sentence does not depend
 * on where the prose happens to wrap.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One `##` section of a page, verbatim rather than flattened, so a table row can
 * still be read as a row. A heading that is not there fails the test rather than
 * silently matching the whole page.
 * @param {string} file
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function section(file, heading) {
  const page = read(file);
  const marker = `## ${heading}\n`;
  assert.ok(page.includes(marker), `${file} has no "## ${heading}" section`);
  const body = page.slice(page.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * The text of one `forge-requirement` block in a feature document, by its id. The
 * requirement is the feature's own authority for the sentence, so a document edit
 * that drops the claim fails here rather than leaving the assertion describing a
 * sentence that no longer exists.
 * @param {string} file
 * @param {string} id
 * @returns {string}
 */
function requirement(file, id) {
  const blocks = [...read(file).matchAll(/```forge-requirement\n([\s\S]*?)```/g)];
  const block = blocks.find((found) => (found[1] ?? '').includes(`"id":"${id}"`));
  assert.ok(block !== undefined, `${path.basename(file)} carries no forge-requirement ${id}`);
  return String(JSON.parse((block[1] ?? '').trim()).text);
}

/**
 * One row of the feature document's data-shape table, as its four named cells.
 * @param {string} row
 * @returns {{series: string, metric: string, granularity: string, source: string}}
 */
function dataShapeRow(row) {
  const cells = row.split('|').map((cell) => cell.trim());
  return {
    series: cells[1] ?? '',
    metric: (cells[2] ?? '').replace(/`/g, ''),
    granularity: (cells[3] ?? '').replace(/`/g, ''),
    source: (cells[4] ?? '').replace(/`/g, ''),
  };
}

/**
 * Every body row of the data-shape table, which is the feature's own inventory of
 * what is stored and under which source label.
 * @returns {ReturnType<typeof dataShapeRow>[]}
 */
function dataShapeRows() {
  const rows = section(FEATURE, DATA_SHAPE)
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|') && !/^\|[\s-]+\|/.test(line.trim()))
    .slice(1)
    .map(dataShapeRow);
  assert.ok(rows.length > 0, `"## ${DATA_SHAPE}" of ${path.basename(FEATURE)} holds no series rows`);
  return rows;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} label
 * @returns {Promise<Database>}
 */
async function archiveWith(t, label) {
  const root = mkdtempSync(`/tmp/opencode/repo-signal-${label}-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = await openArchive(resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } })
    .databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: FIRST_AT, enrolled: 1 });
  return db;
}

/**
 * @param {Database} db
 * @param {string} [where]
 * @returns {number}
 */
function count(db, where = '') {
  return Number(db.prepare(`SELECT count(*) AS n FROM day_series ${where}`).get()?.n);
}

/**
 * The star history the first-connect backfill reads, and the two statistics
 * endpoints the development half reads.
 * @param {StubGitHub} stub
 * @param {{ refuseStars?: boolean }} [options] `refuseStars` answers the history
 *   endpoint with the 403 GitHub serves when it will not release even that one.
 */
function scriptHistory(stub, options = {}) {
  stub.route('GET /repos/:owner/:name/stargazers/history*', () => (options.refuseStars === true
    ? { status: 403, json: { message: 'Resource not accessible by personal access token' } }
    : { json: STAR_HISTORY }));
  stub.route('GET /repos/:owner/:name/stats/commit_activity', () => ({ json: COMMIT_ACTIVITY }));
  stub.route('GET /repos/:owner/:name/stats/participation', () => ({ json: PARTICIPATION }));
}

/**
 * The identity response and the four traffic endpoints. `offset` shifts the whole
 * window forward by that many days, which is how GitHub rolls its window on and how
 * a later run's earliest returned day differs from the first run's.
 * @param {StubGitHub} stub
 * @param {{ offset?: number }} [options]
 */
function scriptTraffic(stub, options = {}) {
  const offset = options.offset ?? 0;
  const days = Array.from({ length: WINDOW_DAYS }, (unused, index) => {
    const day = new Date(Date.parse(`${WINDOW_START}T00:00:00Z`) + (index + offset) * 86_400_000)
      .toISOString().slice(0, 10);
    return { day, count: index, uniques: 1 + index, views: 30 + index };
  });
  const total = (/** @type {'count'|'uniques'|'views'} */ which) =>
    days.reduce((sum, day) => sum + day[which], 0);
  stub.route('GET /repos/:owner/:name', (request) => {
    const [owner, name] = request.path.slice('/repos/'.length).split('/');
    return {
      json: {
        id: 4242, name, full_name: `${owner}/${name}`, owner: { login: owner, type: 'User' },
        stargazers_count: 3, forks_count: 1, watchers_count: 3,
      },
    };
  });
  stub.route('GET /repos/:owner/:name/traffic/clones', () => ({
    json: {
      count: total('count'), uniques: total('uniques'),
      clones: days.map((day) => ({ timestamp: `${day.day}T00:00:00Z`, count: day.count, uniques: day.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/views', () => ({
    json: {
      count: total('views'), uniques: total('uniques'),
      views: days.map((day) => ({ timestamp: `${day.day}T00:00:00Z`, count: day.views, uniques: day.uniques })),
    },
  }));
  stub.route('GET /repos/:owner/:name/traffic/popular/referrers', () => ({ json: [{ referrer: 'example.org', count: 12, uniques: 7 }] }));
  stub.route('GET /repos/:owner/:name/traffic/popular/paths', () => ({ json: [{ path: '/', title: 'RepoSignal', count: 30, uniques: 18 }] }));
}

/**
 * @param {StubGitHub} stub
 * @param {{ offset?: number, refuseStars?: boolean }} [options]
 */
function scriptCollection(stub, options = {}) {
  scriptTraffic(stub, options);
  scriptHistory(stub, options);
}

/**
 * Run both first-connect reconstruction modules against an archive, served by the
 * fixtures the stub would serve. Nothing here stamps a boundary or writes a
 * collected row: the point is what the two reconstruction modules alone store.
 * @param {Database} db
 */
async function reconstruct(db) {
  await backfillStars({
    db,
    repositoryId: 1,
    repo: 'owner/alpha',
    starsClient: {
      /** @param {string} repo @param {(weeks: typeof STAR_HISTORY, page: number, endpoint: string) => void} onPage */
      async starHistory(repo, onPage) {
        onPage(STAR_HISTORY, 1, `/repos/${repo}/stargazers/history?page=1`);
        return { pages: 1, weeks: STAR_HISTORY.length, truncated: false };
      },
    },
    collectedAt: FIRST_AT,
  });
  await backfillDevelopment({
    db,
    repositoryId: 1,
    repo: 'owner/alpha',
    statsClient: {
      commitActivity: async () => ({ kind: 'data', weeks: COMMIT_ACTIVITY }),
      participation: async () => ({ kind: 'data', ...PARTICIPATION }),
    },
    collectedAt: FIRST_AT,
  });
}

/**
 * The per-repository line a run printed for one enrolled pair, or an assertion
 * failure naming the whole output when there is none.
 * @param {string} stdout
 * @param {string} repo
 * @returns {string}
 */
function repositoryLine(stdout, repo) {
  const found = lines(stdout).find((line) => line.startsWith(`${repo} `));
  assert.ok(found !== undefined, `no line for ${repo} was printed:\n${stdout}`);
  return found;
}

// RS-C13 and the feature document's own "Data Shape" table: a reconstructed row is
// labelled backfill and a collected row is labelled collected, and the two share a
// metric key precisely because the label is what tells them apart. The README states
// the labels, the table states which series carries which, and the modules own both
// constants - so a reconstruction that started writing a collected row, or a README
// that renamed a label, fails here naming the sentence and the module.
test('the reconstruction modules write source backfill and never source collected', async (t) => {
  const limits = flatten(section(README, LIMITS));
  const documented = /Those rows are stored as `([a-z]+)`; rows a later run reads from the traffic endpoints are stored as `([a-z]+)`/
    .exec(limits);
  assert.ok(
    documented !== null,
    `the "${LIMITS}" list of README.md no longer says which source label a reconstructed row and a collected ` +
      'row carry; it should say "Those rows are stored as `backfill`; rows a later run reads from the traffic ' +
      `endpoints are stored as \`collected\`", which is what ${STARS_MODULE} and ${DEVELOPMENT_MODULE} write`,
  );
  assert.equal(documented[1], STARS_SOURCE,
    `README.md says a reconstructed row is stored as "${String(documented[1])}" and STARS_SOURCE in ${STARS_MODULE} ` +
      `is "${STARS_SOURCE}"`);
  assert.equal(documented[1], DEVELOPMENT_SOURCE,
    `README.md says a reconstructed row is stored as "${String(documented[1])}" and DEVELOPMENT_SOURCE in ` +
      `${DEVELOPMENT_MODULE} is "${DEVELOPMENT_SOURCE}"`);
  assert.equal(documented[2], TRAFFIC_SOURCE,
    `README.md says a collected row is stored as "${String(documented[2])}" and TRAFFIC_SOURCE in ` +
      `src/collect/traffic.js is "${TRAFFIC_SOURCE}"`);

  // The feature document's table is the same claim per series, so every row of it
  // resolves to a metric key, a granularity and a source the modules export.
  const rows = dataShapeRows();
  /** @type {Record<string, string>} */
  const granularityOf = {
    [STARS_METRIC]: STARS_GRANULARITY,
    [COMMIT_ACTIVITY_METRIC]: DEVELOPMENT_GRANULARITY,
    [OWNER_PARTICIPATION_METRIC]: DEVELOPMENT_GRANULARITY,
  };
  /** @type {Record<string, string>} */
  const reconstructedWith = {
    [STARS_METRIC]: STARS_SOURCE,
    [COMMIT_ACTIVITY_METRIC]: DEVELOPMENT_SOURCE,
    [OWNER_PARTICIPATION_METRIC]: DEVELOPMENT_SOURCE,
  };
  assert.deepEqual(
    [...new Set(rows.map((row) => row.metric))].sort(),
    [STARS_METRIC, COMMIT_ACTIVITY_METRIC, OWNER_PARTICIPATION_METRIC].sort(),
    `"## ${DATA_SHAPE}" of ${path.basename(FEATURE)} lists metrics ` +
      `${JSON.stringify([...new Set(rows.map((row) => row.metric))].sort())} and the backfill modules export ` +
      `${JSON.stringify([STARS_METRIC, COMMIT_ACTIVITY_METRIC, OWNER_PARTICIPATION_METRIC].sort())}`,
  );
  for (const row of rows) {
    const written = reconstructedWith[row.metric] ?? null;
    assert.ok(written !== null,
      `"## ${DATA_SHAPE}" lists the metric "${row.metric}", which no backfill module writes`);
    assert.equal(row.granularity, granularityOf[row.metric] ?? '',
      `"## ${DATA_SHAPE}" gives ${row.metric} the granularity "${row.granularity}" and the module writes ` +
        `"${granularityOf[row.metric] ?? ''}"`);
    // The one row the document labels collected is the star level every later
    // collection records; every other row is a reconstruction.
    const expected = row.source === TRAFFIC_SOURCE ? TRAFFIC_SOURCE : written;
    assert.equal(row.source, expected,
      `"## ${DATA_SHAPE}" gives ${row.metric} the source "${row.source}" and the module that writes it ` +
        `writes "${expected}"`);
  }
  assert.equal(
    rows.filter((row) => row.source === TRAFFIC_SOURCE).length,
    1,
    `"## ${DATA_SHAPE}" names ${rows.filter((row) => row.source === TRAFFIC_SOURCE).length} collected series; ` +
      `README.md names exactly one, the star level \`${rows.find((row) => row.source === TRAFFIC_SOURCE)?.series ?? ''}\``,
  );

  // And the behaviour, read off a real archive: both reconstruction modules run, and
  // every row they leave behind carries the backfill label and no collected label.
  const db = await archiveWith(t, 'contract-backfill-source');
  const range = { repositoryId: 1, from: '2019-01-01', to: '2021-12-31' };
  await reconstruct(db);

  const stored = [
    ...readDaySeries(db, { ...range, metric: STARS_METRIC, granularity: STARS_GRANULARITY }),
    ...readDaySeries(db, { ...range, metric: COMMIT_ACTIVITY_METRIC, granularity: DEVELOPMENT_GRANULARITY }),
    ...readDaySeries(db, { ...range, metric: OWNER_PARTICIPATION_METRIC, granularity: DEVELOPMENT_GRANULARITY }),
  ];
  assert.ok(stored.length > 0, 'neither reconstruction module wrote a row, so there is nothing to check');
  for (const row of stored) {
    const expected = row.metric === STARS_METRIC ? STARS_SOURCE : DEVELOPMENT_SOURCE;
    assert.equal(row.source, expected,
      `${row.metric} on ${row.day} is stored with source "${row.source}" and the module that wrote it writes ` +
        `"${expected}"; README.md says a reconstructed row is stored as \`${documented[1]}\``);
  }
  const sources = db.prepare('SELECT DISTINCT source FROM day_series ORDER BY source')
    .all().map((row) => String(row.source));
  assert.deepEqual(sources, [DEVELOPMENT_SOURCE],
    `the reconstruction modules left sources ${JSON.stringify(sources)} in day_series, and README.md says a ` +
      `reconstructed row is stored as \`${String(documented[1])}\` and never as \`${String(documented[2])}\``);
  const collectedRows = count(db, `WHERE source='${TRAFFIC_SOURCE}'`);
  assert.equal(collectedRows, 0,
    `a reconstruction wrote ${collectedRows} collected rows; only a collection may store one, and no ` +
      'collection has run in this fixture');
});

// RS-BKL-C04: a refused star history is recorded on the repository with the first
// reason and the first refusal time, is never requested again, keeps the traffic
// half of the collection running, and is reported on every collection line. The
// README states the recording and the reporting, the troubleshooting runbook states
// that the history is not asked again, and the plan and the repository columns own
// the behaviour.
test('a refused history keeps its first reason and is not requested again by a later plan', async (t) => {
  const token = flatten(section(README, TOKEN));
  const recorded = /If GitHub ever refuses the history too, the tool records that, says so on every collection line \(`([^`]+)`\) rather than leaving a gap to be read as a zero, and collects traffic as normal\./
    .exec(token);
  assert.ok(
    recorded !== null,
    `the "${TOKEN}" section of README.md no longer states that a refused star history is recorded and reported on ` +
      'every collection line rather than left as a gap that reads as a zero; that sentence is what ' +
      'src/commands/collect.js prints and what src/collect/run.js keeps',
  );
  // The line's own words, taken from the document rather than restated here.
  const absence = recorded[1].replace(/\s*\.\.\.$/, '');
  assert.notEqual(absence, recorded[1],
    `README.md documents the collection line as ${JSON.stringify(recorded[1])}; it has to name the words the ` +
      'line prints, so a formatter that changed them fails here instead of in a maintainer\'s terminal');
  assert.equal(flatten(section(TROUBLESHOOTING, STAR_HISTORY_RUNBOOK))
    .includes('the refusal is recorded once and the history is not asked again'), true,
  `"## ${STAR_HISTORY_RUNBOOK}" of docs/operations/troubleshooting.md no longer states that the refusal is ` +
    `recorded once and the history is not asked again, which is what isBackfillRefused in ${LIFECYCLE_MODULE} ` +
    'and planCollect in src/collect/run.js do');

  // The plan, decided from the archive and the configuration alone: a refused history
  // costs exactly the backfill floor and nothing else, and the repository keeps
  // collecting. Every figure is an exported constant, never a literal.
  const db = await archiveWith(t, 'contract-backfill-refusal');
  const config = validateConfig({ enrolled: ['owner/alpha'] });
  const [firstPlan] = planCollect({ db, config });
  assert.ok(firstPlan !== undefined, 'the enrolled repository was not planned at all');
  assert.equal(firstPlan.requests,
    RESOLUTION_REQUESTS_PER_REPOSITORY + TRAFFIC_REQUESTS_PER_REPOSITORY + BACKFILL_REQUESTS_FLOOR,
    `a repository with no recorded refusal is planned at ${firstPlan.requests} requests and the three exported ` +
      `constants in ${RUN_MODULE} add to ` +
      `${RESOLUTION_REQUESTS_PER_REPOSITORY + TRAFFIC_REQUESTS_PER_REPOSITORY + BACKFILL_REQUESTS_FLOOR}`);
  assert.equal(isBackfillRefused(getRepository(db, 1)), false,
    'the repository reads as never refused before any refusal was recorded');

  withTransaction(db, () => markBackfillRefused({ db, repositoryId: 1, reason: REFUSAL_REASON, collectedAt: FIRST_AT }));
  const [refusedPlan] = planCollect({ db, config });
  assert.ok(refusedPlan !== undefined, 'the enrolled repository was not planned at all');
  assert.equal(refusedPlan.requests,
    firstPlan.requests - BACKFILL_REQUESTS_FLOOR,
    `a refused star history is planned at ${refusedPlan.requests} requests, which is ` +
      `${firstPlan.requests - BACKFILL_REQUESTS_FLOOR} when the refused listing costs the BACKFILL_REQUESTS_FLOOR ` +
      `floor of ${BACKFILL_REQUESTS_FLOOR} in ${RUN_MODULE} and nothing else`);
  assert.equal(refusedPlan.skipped, false,
    'a refused backfill is not a disappearance: the traffic half must keep running');
  assert.equal(refusedPlan.backfill, true,
    'the development half of the first-connect backfill still runs after the star history was refused');

  // The columns keep the first reason and the first refusal time.
  withTransaction(db, () => markBackfillRefused({ db, repositoryId: 1, reason: 'a later and different reason',
    collectedAt: LATER_AT }));
  const stored = getRepository(db, 1);
  assert.equal(isBackfillRefused(stored), true, 'the recorded refusal is no longer read as one');
  assert.equal(stored.backfillRefusedReason, REFUSAL_REASON,
    `the repository row carries "${String(stored.backfillRefusedReason)}" after a second refusal and markBackfillRefused ` +
      `in ${LIFECYCLE_MODULE} keeps the first reason`);
  assert.equal(stored.backfillRefusedAt, FIRST_AT,
    `the refusal time moved to "${String(stored.backfillRefusedAt)}"; the first refusal time is the one the column owns`);
  assert.equal(readProvenance(db, 1).backfillCompleted, false,
    'a refusal is recorded beside the repository, never as a completed backfill in backfill_records');

  // The same claim through the real entry point: the absence is named on the line on
  // both runs, the traffic is collected on both, and the second run never asks again.
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptCollection(f.stub, { refuseStars: true });
  const first = await f.run(['collect']);
  assert.equal(first.status, 0, `a refused star history is not a failed collection: ${first.stderr}`);
  const firstLine = repositoryLine(first.stdout, 'owner/alpha');
  assert.ok(firstLine.includes(`${absence} ${REFUSAL_REASON}`),
    `README.md documents the line as carrying "${recorded[1]}" and the run printed ${JSON.stringify(firstLine)}`);
  assert.match(firstLine, /^owner\/alpha ok \d+ days written \d+/,
    `the traffic half kept running on a refused star history: ${JSON.stringify(firstLine)}`);
  assert.equal(f.stub.paths().filter((observed) => observed.includes('/stargazers')).length, 1,
    'the first connect asks the star history exactly once');

  f.stub.reset();
  const second = await f.run(['collect']);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(f.stub.paths().filter((observed) => observed.includes('/stargazers')), [],
    `the refused star history was requested again: ${f.stub.paths().filter((observed) => observed.includes('/stargazers')).join(', ')}`);
  const secondLine = repositoryLine(second.stdout, 'owner/alpha');
  assert.ok(secondLine.includes(`${absence} ${REFUSAL_REASON}`),
    `README.md says the absence is reported on every collection line and the second run printed ` +
      `${JSON.stringify(secondLine)}`);
  assert.match(secondLine, /^owner\/alpha ok \d+ days /,
    `the second run collected no traffic for a repository whose star history was refused: ${JSON.stringify(secondLine)}`);

  f.archive((archive) => {
    const row = /** @type {{at: string, reason: string}} */ (/** @type {unknown} */ (
      archive.prepare('SELECT backfill_refused_at AS at, backfill_refused_reason AS reason FROM repositories')
        .get()));
    assert.equal(String(row.reason), REFUSAL_REASON,
      'the archive stored a different reason than the one both runs printed');
    assert.match(String(row.at), /^\d{4}-\d{2}-\d{2}T/,
      `the refusal columns carry no canonical time: ${JSON.stringify(row)}`);
    assert.equal(count(archive, `WHERE source='${TRAFFIC_SOURCE}' AND metric<>'stars'`),
      WINDOW_DAYS * 4,
      'the collected traffic rows are missing from an archive whose star history was refused');
    assert.equal(count(archive, `WHERE source='${STARS_SOURCE}' AND metric='${STARS_METRIC}'`), 0,
      'a refused star history invented reconstructed star rows');
  });
});

// RS-BKL-C05 and RS-C13: the first collected day is stamped exactly once by a
// conditional insert, so a later run cannot move the provenance boundary, and the
// provenance read reports it without counting the stamp as a backfill. The feature
// requirement and the troubleshooting runbook state it; the module owns the
// statement that makes it true.
test('the boundary stamp is a single conditional insert that a second run cannot move', async (t) => {
  const constraint = requirement(FEATURE, 'RS-BKL-C05');
  assert.match(constraint, /stamped exactly once by a conditional insert/,
    'RS-BKL-C05 of docs/features/first-connect-backfill.md no longer states that the first collected day is ' +
      'stamped exactly once by a conditional insert, which is what src/backfill/provenance.js does');
  assert.match(constraint, /a later run cannot move the provenance boundary/,
    'RS-BKL-C05 of docs/features/first-connect-backfill.md no longer states that a later run cannot move the ' +
      'provenance boundary');
  assert.match(flatten(section(TROUBLESHOOTING, FIRST_RUN)),
    /The first successful collection performs the first-connect backfill and stamps the provenance boundary/,
    `"## ${FIRST_RUN}" of docs/operations/troubleshooting.md no longer states that the first successful ` +
      'collection stamps the provenance boundary');
  assert.match(flatten(section(README, INSTALL)),
    /Each block names the recorded boundary, so reconstructed days are never mistaken for observed ones/,
    `the "${INSTALL}" section of README.md no longer states that each report block names the recorded ` +
      'boundary, which is boundaryBlock in src/report/format.js');
  assert.match(flatten(section(SCHEDULING, CATCH_UP)),
    /\*\*It does not re-run the first-connect backfill\.\*\* That step runs once, on the first successful collection of a repository/,
    `"## ${CATCH_UP}" of docs/operations/scheduled-collection.md no longer states that the first-connect ` +
      `backfill runs once, which is what BACKFILL_FIRST_CONNECT and BACKFILL_SKIPPED in ${RUN_MODULE} print`);

  // The shape of the statement itself: one insert, conditional, and nothing that
  // could rewrite or remove a stamp that is already there.
  const module = read(PROVENANCE_MODULE);
  const inserts = [...module.matchAll(/INSERT INTO backfill_records/g)];
  assert.equal(inserts.length, 1,
    `src/backfill/provenance.js writes backfill_records with ${inserts.length} statements; RS-BKL-C05 says the ` +
      'boundary is stamped exactly once by a conditional insert');
  const statement = module.slice(/** @type {number} */ (inserts[0]?.index));
  assert.match(statement, /WHERE NOT EXISTS \(SELECT 1 FROM backfill_records WHERE repository_id=\? AND kind=\?\)/,
    'the boundary insert in src/backfill/provenance.js is not the conditional one RS-BKL-C05 names');
  assert.match(statement, new RegExp(`run\\(repositoryId, FIRST_COLLECTED_KIND,`),
    'the conditional insert in src/backfill/provenance.js does not bind the boundary kind the read looks for');
  for (const forbidden of ['UPDATE backfill_records', 'DELETE FROM backfill_records', 'INSERT OR REPLACE']) {
    assert.ok(!module.includes(forbidden),
      `src/backfill/provenance.js contains "${forbidden}", so a later run could move or remove a stamped boundary`);
  }
  assert.match(module, /kind<>\?/,
    'the provenance read no longer excludes a kind from the backfill list, so the boundary stamp could be ' +
      'counted as a completed backfill');
  assert.match(module, /\.all\(repositoryId, FIRST_COLLECTED_KIND\)/,
    'the provenance read no longer excludes the boundary kind specifically, which RS-BKL-C05 requires');

  // The module, called twice with different days: the second call cannot move it.
  const db = await archiveWith(t, 'contract-backfill-boundary');
  assert.deepEqual(stampFirstCollected(db, 1, { day: WINDOW_START, collectedAt: FIRST_AT }),
    { day: WINDOW_START, stamped: true });
  assert.deepEqual(stampFirstCollected(db, 1, { day: LATER_WINDOW_START, collectedAt: LATER_AT }),
    { day: WINDOW_START, stamped: false },
    `a second stampFirstCollected call moved the boundary to ${LATER_WINDOW_START}; a conditional insert cannot`);
  const after = readProvenance(db, 1, { today: LATER_WINDOW_START });
  assert.equal(after.firstCollectedDay, WINDOW_START);
  assert.equal(after.firstCollectedAt, FIRST_AT);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM backfill_records WHERE kind=?')
    .get(FIRST_COLLECTED_KIND)?.n), 1,
  'the archive holds more than one boundary stamp for one repository');
  assert.equal(after.backfillKinds.includes(FIRST_COLLECTED_KIND), false,
    `the boundary stamp was counted as a completed backfill: ${JSON.stringify(after.backfillKinds)}`);

  // And through the real entry point: the second run's window begins a day later, so
  // a stamp that could move would report the later day. The archive and the report
  // both keep the first one.
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptCollection(f.stub, { offset: 0 });
  const first = await f.run(['collect']);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(repositoryLine(first.stdout, 'owner/alpha').includes(`backfill ${BACKFILL_FIRST_CONNECT}`),
    `the first run did not perform the first-connect backfill: ${JSON.stringify(first.stdout)}`);
  scriptCollection(f.stub, { offset: 1 });
  const second = await f.run(['collect']);
  assert.equal(second.status, 0, second.stderr);
  const secondLine = repositoryLine(second.stdout, 'owner/alpha');
  assert.ok(secondLine.includes(`backfill ${BACKFILL_SKIPPED}`),
    `"## ${CATCH_UP}" of docs/operations/scheduled-collection.md says the first-connect backfill runs once, and ` +
      `the second run printed ${JSON.stringify(secondLine)}`);
  f.archive((archive) => {
    const stamps = Number(archive.prepare('SELECT count(*) AS n FROM backfill_records WHERE kind=?')
      .get(FIRST_COLLECTED_KIND)?.n);
    assert.equal(stamps, 1, `two collections left ${stamps} boundary stamps on one repository`);
    const stamp = /** @type {{day: string, collectedAt: string}} */ (/** @type {unknown} */ (
      archive.prepare('SELECT window_from AS day, collected_at AS collectedAt FROM backfill_records WHERE kind=?')
        .get(FIRST_COLLECTED_KIND)));
    assert.equal(String(stamp.day), WINDOW_START,
      `the second run's window began on ${LATER_WINDOW_START} and the recorded boundary moved to ` +
        `${String(stamp.day)}; a later run cannot move the provenance boundary`);
  });

  const reported = await f.run(['report', '--repo', 'owner/alpha']);
  assert.equal(reported.status, 0, reported.stderr);
  const provenanceLines = lines(reported.stdout).filter((line) => line.startsWith('  provenance:'));
  assert.equal(provenanceLines.length, 1,
    `README.md says each report block names the recorded boundary and the report printed ` +
      `${JSON.stringify(provenanceLines)}`);
  assert.ok(/** @type {string} */ (provenanceLines[0]).includes(WINDOW_START),
    `README.md says each report block names the recorded boundary ${WINDOW_START} and the report printed ` +
      `${JSON.stringify(provenanceLines[0])}`);
});

// RS-BKL-C05: the provenance read reports which backfills completed "without
// counting the boundary stamp as a backfill", so the completed-backfill records the
// feature document describes are exactly the rows that read counts. The runbook's
// claim that a first successful collection stamps the boundary is the same claim.
test('the completed-backfill records are exactly the rows the provenance read counts', async (t) => {
  const constraint = requirement(FEATURE, 'RS-BKL-C05');
  assert.match(constraint, /which backfills completed, without counting the boundary stamp as a backfill/,
    'RS-BKL-C05 of docs/features/first-connect-backfill.md no longer states that the provenance read reports ' +
      'which backfills completed without counting the boundary stamp as a backfill');
  const shape = flatten(section(FEATURE, DATA_SHAPE));
  assert.match(shape,
    /The two sources share one metric key and are told apart by their source label, which is why every reader has to carry provenance rather than assuming a day is observed\./,
    `"## ${DATA_SHAPE}" of ${path.basename(FEATURE)} no longer states that the two sources share one metric key ` +
      'and are told apart by their source label');
  assert.match(shape, /The boundary between them is the first collected day, and it is the line the chart draws\./,
    `"## ${DATA_SHAPE}" of ${path.basename(FEATURE)} no longer names the first collected day as the boundary ` +
      'between the two sources');

  // A first connect, driven through the real entry point so the records are the
  // ones the run writes rather than the ones this file writes.
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptCollection(f.stub);
  const collected = await f.run(['collect']);
  assert.equal(collected.status, 0, collected.stderr);

  f.archive((archive) => {
    const recorded = archive.prepare('SELECT kind FROM backfill_records ORDER BY kind')
      .all().map((row) => String(row.kind));
    const stampRows = recorded.filter((kind) => kind === FIRST_COLLECTED_KIND);
    assert.equal(stampRows.length, 1,
      `the first connect wrote ${stampRows.length} boundary stamps; it writes exactly one`);

    const provenance = readProvenance(archive, 1, { today: new Date().toISOString().slice(0, 10) });
    assert.deepEqual(provenance.backfillKinds, [DEVELOPMENT_KIND],
      `the provenance read counts ${JSON.stringify(provenance.backfillKinds)} completed backfills and the ` +
        `archive holds the records ${JSON.stringify(recorded)}`);
    assert.deepEqual(provenance.backfills.map((backfill) => backfill.kind), provenance.backfillKinds,
      'the per-kind list and the kind list are read from different rows');
    assert.equal(provenance.backfillCompleted, true,
      'a completed development backfill is not reported as completed');
    assert.equal(provenance.backfillKinds.includes(FIRST_COLLECTED_KIND), false,
      'the boundary stamp was counted as a completed backfill');
    assert.equal(
      Number(archive.prepare('SELECT count(*) AS n FROM backfill_records').get()?.n),
      provenance.backfills.length + stampRows.length,
      'the archive holds backfill records the provenance read does not report, or reports backfills it does not hold',
    );
    assert.deepEqual(provenance.backfills.map((backfill) => backfill.truncated), [true],
      'a two-week development reconstruction is not recorded as truncated');
    assert.equal(provenance.backfills[0]?.windowFrom,
      new Date(/** @type {number} */ (COMMIT_ACTIVITY[0]?.week) * 1000).toISOString().slice(0, 10),
      'the recorded window does not start at the first week the vendor returned');
    assert.equal(provenance.backfills[0]?.windowTo,
      new Date(/** @type {number} */ (COMMIT_ACTIVITY.at(-1)?.week) * 1000).toISOString().slice(0, 10),
      'the recorded window does not end at the last week the vendor returned');
    assert.equal(provenance.state, CONNECTED, `a stamped repository reads as ${provenance.state}`);

    // The series the data-shape table names are stored, under the label it names, and
    // the one metric key both sources share carries both.
    for (const row of dataShapeRows().filter((series) => series.source !== TRAFFIC_SOURCE)) {
      const rows = Number(archive.prepare('SELECT count(*) AS n FROM day_series WHERE metric=? AND source=?')
        .get(row.metric, row.source)?.n);
      assert.ok(rows > 0,
        `"## ${DATA_SHAPE}" gives ${row.metric} the source "${row.source}" and the archive holds ${rows} ` +
          'reconstructed rows for it');
    }
    assert.deepEqual(
      archive.prepare('SELECT DISTINCT source FROM day_series WHERE metric=? ORDER BY source').all(STARS_METRIC)
        .map((row) => String(row.source)),
      [STARS_SOURCE, TRAFFIC_SOURCE].sort(),
      'the metric key the data-shape table says the two sources share does not carry both labels',
    );
  });

  // The documented 52 weeks is the module's own figure, so the truncation flag this
  // record carries is compared to the constant that owns it.
  const truncation = requirement(FEATURE, 'RS-BKL-C02');
  assert.match(truncation, new RegExp(`fewer than ${EXPECTED_WEEKS} weeks were returned`),
    `RS-BKL-C02 of ${path.basename(FEATURE)} does not state the ${EXPECTED_WEEKS}-week figure that ` +
      `EXPECTED_WEEKS in ${DEVELOPMENT_MODULE} owns`);
  assert.equal(COMMIT_ACTIVITY.length < EXPECTED_WEEKS, true,
    `this fixture served ${COMMIT_ACTIVITY.length} weeks, which is not fewer than ${EXPECTED_WEEKS}, so it ` +
      'cannot prove the truncated flag');

  // A repository the archive holds reconstructed rows for but has never stamped
  // reads as never collected, which is the runbook's answer for a first run that
  // has not succeeded yet.
  const db = await archiveWith(t, 'contract-backfill-unstamped');
  await reconstruct(db);
  const unstamped = readProvenance(db, 1, { today: WINDOW_START });
  assert.equal(unstamped.firstCollectedDay, null);
  assert.equal(unstamped.state, NOT_CONNECTED,
    `a repository holding reconstructed rows but no stamp reads as ${unstamped.state}`);
  assert.deepEqual(unstamped.backfillKinds, [DEVELOPMENT_KIND],
    'the completed-backfill records this fixture wrote are not the rows the provenance read counts');
});
