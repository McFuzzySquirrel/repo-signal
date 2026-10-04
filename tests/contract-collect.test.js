import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { markUnavailable } from '../src/collect/lifecycle.js';
import {
  BACKFILL_REQUESTS_FLOOR,
  RESOLUTION_REQUESTS_PER_REPOSITORY,
  TRAFFIC_REQUESTS_PER_REPOSITORY,
  planCollect,
} from '../src/collect/run.js';
import { validateConfig } from '../src/config/schema.js';
import { openArchive, upsertRepository, withTransaction } from '../src/db/ops-repo.js';
import { resolveHomePaths } from '../src/paths.js';
import { createCollectHome, outputLines as lines } from './helpers/collect-home.js';
import { starHistory } from './helpers/star-history.js';

/**
 * The documented request budget and the collection line vocabulary, asserted
 * against the collector that produces them.
 *
 * The direction of repair is the document's: a number printed in a runbook that
 * the collector no longer spends is a stale document, and a budget the collector
 * spends but the document does not name is an unreviewable one. So every figure
 * below is imported from `src/collect/run.js` or read off a real run against the
 * loopback GitHub stub, and never restated as a literal in this file.
 *
 * No test here reaches api.github.com and no test uses a real token: the
 * transport points at a 127.0.0.1 stub behind `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEDULING = path.join(ROOT, 'docs', 'operations', 'scheduled-collection.md');
const TROUBLESHOOTING = path.join(ROOT, 'docs', 'operations', 'troubleshooting.md');
const FEATURE = path.join(ROOT, 'docs', 'features', 'enrollment-and-collection.md');
const RUN_JS = 'src/collect/run.js';

/** The two runbooks whose published figures and vocabulary this suite protects. */
const PAGES = /** @type {{ name: string, file: string }[]} */ ([
  { name: 'docs/operations/scheduled-collection.md', file: SCHEDULING },
  { name: 'docs/operations/troubleshooting.md', file: TROUBLESHOOTING },
]);

/** The budget section of the scheduling runbook. */
const BUDGET_HEADING = 'The expected quiet-hours request budget';

/** Requests one steady-state run makes per repository: the two exported steps. */
const REQUESTS_PER_REPOSITORY_PER_RUN =
  RESOLUTION_REQUESTS_PER_REPOSITORY + TRAFFIC_REQUESTS_PER_REPOSITORY;

/**
 * One daily run a day for a leap year, which is how the runbook derives its
 * yearly figure from the per-run total.
 */
const RUNS_PER_YEAR = 366;

/**
 * English words for the small integers the feature document spells out rather
 * than printing as digits.
 */
const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Flatten a page's line wrapping, so an assertion about a sentence does not
 * depend on where the prose happens to wrap.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One `##` section of a page, verbatim rather than flattened, so a table row
 * can still be read as a row. A heading that is not there fails the test rather
 * than silently matching the whole page.
 * @param {string} file
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function section(file, heading) {
  const page = read(file);
  const marker = `## ${heading}\n`;
  assert.ok(page.includes(marker), `the page has no "## ${heading}" section`);
  const body = page.slice(page.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * The request figure one row of the runbook's budget table prints for a named
 * step. The row is found by its label rather than by its position, so reordering
 * the table is not a failure and retyping a step name is.
 * @param {RegExp} label Matches the step name in the row's first cell.
 * @returns {{ label: string, figure: string, why: string }}
 */
function budgetRow(label) {
  const rows = section(SCHEDULING, BUDGET_HEADING)
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'));
  const row = rows.find((line) => label.test((line.split('|')[1] ?? '').trim()));
  assert.ok(
    row !== undefined,
    `the "${BUDGET_HEADING}" table of docs/operations/scheduled-collection.md has no row whose ` +
      `step name matches ${String(label)}; the rows it does have are ` +
      `${JSON.stringify(rows.map((line) => (line.split('|')[1] ?? '').trim()))}`,
  );
  const cells = row.split('|').map((cell) => cell.trim());
  return { label: cells[1] ?? '', figure: cells[2] ?? '', why: cells[3] ?? '' };
}

/**
 * The number a table figure prints, with the cell's markdown emphasis removed.
 * @param {string} figureText
 * @returns {number|null}
 */
function figure(figureText) {
  const digits = /\d+/.exec(figureText.replace(/[*_`]/g, ''));
  return digits === null ? null : Number(digits[0]);
}

/**
 * The `requests=` or `requests>=` figure a printed line carries. A dry run
 * prints the plan's own floor, which is written with the `>=` the collector uses
 * when the stargazer page count is unknown.
 * @param {string} line
 * @returns {{ count: number, exact: boolean }}
 */
function requestsFigure(line) {
  const match = /requests(>=|=)(\d+)/.exec(line);
  assert.ok(match !== null, `no requests figure on the printed line: ${JSON.stringify(line)}`);
  return { count: Number(match[2]), exact: match[1] === '=' };
}

/**
 * The state a printed per-repository line reports: the word between the enrolled
 * owner/name pair and the rest of the line. The summary line and the scheduled
 * command examples carry no pair, so neither matches.
 * @param {string} line
 * @returns {string|null}
 */
function printedLineState(line) {
  const match = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+ ([a-z][a-z-]*)\b/.exec(line);
  return match === null ? null : /** @type {string} */ (match[1]);
}

/**
 * The per-repository line states a page shows an example of. A documented line
 * is one inside a fenced block that begins with an enrolled owner/name pair; its
 * second word is the state the run reported. A runbook that drops the example of
 * a state has stopped documenting that state, which is what this reports.
 * @param {string} text
 * @returns {Set<string>}
 */
function documentedExampleStates(text) {
  /** @type {Set<string>} */
  const states = new Set();
  for (const block of text.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)) {
    for (const line of (block[1] ?? '').split('\n')) {
      const state = printedLineState(line.trim());
      if (state !== null) states.add(state);
    }
  }
  return states;
}

/**
 * The identity response, the four traffic endpoints and the first-connect
 * backfill, scripted against the loopback stub. `vanished` answers 404 for the
 * resolution of a named pair, and `failing` answers 403 on that pair's traffic
 * clones, which is the permission refusal the troubleshooting runbook shows.
 * @param {import('./helpers/stub-github-server.mjs').StubGitHub} stub
 * @param {{ vanished?: string[], failing?: string|null }} [options]
 */
function scriptCollection(stub, options = {}) {
  const vanished = new Set((options.vanished ?? []).map((repo) => repo.toLowerCase()));
  const failing = (options.failing ?? '').toLowerCase();
  stub.route('GET /repos/:owner/:name', (request) => {
    const pair = request.path.slice('/repos/'.length);
    if (vanished.has(pair.toLowerCase())) return { status: 404, json: { message: 'Not Found' } };
    const [owner, name] = pair.split('/');
    return {
      json: {
        id: 4242, name, full_name: `${owner}/${name}`, owner: { login: owner, type: 'User' },
        stargazers_count: 3, forks_count: 1, watchers_count: 3,
      },
    };
  });
  const days = Array.from({ length: 14 }, (unused, index) => {
    const day = new Date(Date.parse('2026-09-19T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10);
    return { day, count: index, uniques: 1, views: index + 30 };
  });
  const total = (/** @type {'count'|'uniques'|'views'} */ which) =>
    days.reduce((sum, day) => sum + day[which], 0);
  stub.route('GET /repos/:owner/:name/traffic/clones', (request) => (
    request.path.toLowerCase().startsWith(`/repos/${failing}/`) && failing !== ''
      ? { status: 403, json: { message: 'Requires Administration repository permission (read)' } }
      : {
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
  stub.route('GET /repos/:owner/:name/stargazers/history*', () => ({ json: starHistory(1) }));
  stub.route('GET /repos/:owner/:name/stats/commit_activity', () => ({ json: [] }));
  stub.route('GET /repos/:owner/:name/stats/participation', () => ({ json: { all: [1, 2], owner: [1, 1] } }));
}

/**
 * The `requests=` the summary line reports for a run: the number of requests the
 * run asked the policy for, which is the counted budget and not the attempt
 * count.
 * @param {string} stdout
 * @returns {number}
 */
function summaryRequests(stdout) {
  const summary = lines(stdout).find((line) => line.startsWith('summary '));
  assert.ok(summary !== undefined, `no summary line was printed:\n${stdout}`);
  const match = /requests=(\d+)/.exec(summary);
  assert.ok(match !== null, `the summary line carries no requests figure: ${JSON.stringify(summary)}`);
  return Number(match[1]);
}

// RS-COL-C03 and RS-C12: the runbook's budget table, its per-run total, its
// yearly figure and its three per-repository request figures are the collector's
// own constants. A mismatch is the finding; the document is the side to correct,
// because the budget is what the plan asked for and the behaviour is tested
// elsewhere.
test('the scheduling runbook prints the request budget the collector constants produce', () => {
  const resolution = budgetRow(/^Repository resolution$/);
  assert.equal(
    figure(resolution.figure),
    RESOLUTION_REQUESTS_PER_REPOSITORY,
    `the "${resolution.label}" row of the "${BUDGET_HEADING}" table prints ${resolution.figure} per ` +
      `repository and RESOLUTION_REQUESTS_PER_REPOSITORY in ${RUN_JS} is ${RESOLUTION_REQUESTS_PER_REPOSITORY}`,
  );

  const traffic = budgetRow(/^Traffic$/);
  assert.equal(
    figure(traffic.figure),
    TRAFFIC_REQUESTS_PER_REPOSITORY,
    `the "${traffic.label}" row of the "${BUDGET_HEADING}" table prints ${traffic.figure} per ` +
      `repository and TRAFFIC_REQUESTS_PER_REPOSITORY in ${RUN_JS} is ${TRAFFIC_REQUESTS_PER_REPOSITORY}`,
  );

  const total = budgetRow(/^\*\*Total per daily run\*\*$/);
  assert.equal(
    figure(total.figure),
    REQUESTS_PER_REPOSITORY_PER_RUN,
    `the "${total.label}" row prints ${total.figure} and the two steps above it add to ` +
      `${REQUESTS_PER_REPOSITORY_PER_RUN} in ${RUN_JS}`,
  );

  // The backfill row is a floor over an unknown stargazer page count, so the
  // document has to present it as one; an exact figure here would be a lie.
  const backfill = budgetRow(/^First-connect backfill$/);
  assert.equal(
    figure(backfill.figure),
    BACKFILL_REQUESTS_FLOOR,
    `the "${backfill.label}" row prints ${backfill.figure} and BACKFILL_REQUESTS_FLOOR in ${RUN_JS} ` +
      `is ${BACKFILL_REQUESTS_FLOOR}`,
  );
  assert.match(
    backfill.figure,
    new RegExp(`^at least\\s+${BACKFILL_REQUESTS_FLOOR}\\s*,\\s*once$`),
    `the "${backfill.label}" row must present ${BACKFILL_REQUESTS_FLOOR} as a floor that happens once, ` +
      `not as an exact per-run count; it prints ${JSON.stringify(backfill.figure)}`,
  );

  // The row's own explanation has to name one endpoint per counted request, so a
  // fourth traffic endpoint cannot be added without the document saying so.
  const kinds = traffic.why.split(/,| and /).map((kind) => kind.trim()).filter((kind) => kind !== '');
  assert.equal(
    kinds.length,
    TRAFFIC_REQUESTS_PER_REPOSITORY,
    `the "${traffic.label}" row explains itself as "${traffic.why}", naming ${kinds.length} endpoints, and ` +
      `TRAFFIC_REQUESTS_PER_REPOSITORY in ${RUN_JS} is ${TRAFFIC_REQUESTS_PER_REPOSITORY}`,
  );
});

// RS-COL-C03 and RS-C12: the one sentence that says where each published figure comes
// from. Without it the table is a number an operator cannot check; with it, every
// figure resolves to the exported constant that owns it, and a constant that is
// renamed or removed fails here rather than leaving the runbook pointing at nothing.
// The table rows are bound to the constants by the test above; this test covers the
// provenance sentence and the two totals it explains.
test('the budget section names the constant behind each figure it prints', () => {
  const budget = flatten(section(SCHEDULING, BUDGET_HEADING));
  assert.match(
    budget,
    new RegExp(RUN_JS.replace(/\//g, '\\/')),
    `"## ${BUDGET_HEADING}" names no module for its figures to come from; it should say where each number ` +
      `is defined, which is ${RUN_JS}`,
  );
  for (const constant of [
    'RESOLUTION_REQUESTS_PER_REPOSITORY', 'TRAFFIC_REQUESTS_PER_REPOSITORY', 'BACKFILL_REQUESTS_FLOOR',
  ]) {
    assert.match(
      budget,
      new RegExp(`\\\`${constant}\\\``),
      `"## ${BUDGET_HEADING}" names none of the constants its figures come from; it never names ${constant}`,
    );
    assert.match(
      read(path.join(ROOT, RUN_JS)),
      new RegExp(`export const ${constant}\\b`),
      `${RUN_JS} no longer exports ${constant}, so the runbook names a constant that is gone`,
    );
  }
  assert.match(
    budget,
    /tests\/contract-collect\.test\.js/,
    `"## ${BUDGET_HEADING}" does not name the test that recomputes these figures from the constants`,
  );

  // The prose total and the table it sits above must be the same figure, and both
  // must be the sum of the two exported steps.
  const total = budgetRow(/^\*\*Total per daily run\*\*$/);
  assert.ok(
    budget.includes(`**${figure(total.figure)} requests per repository per run**`),
    `"## ${BUDGET_HEADING}" states a per-run total in prose that differs from the ${total.figure} its own ` +
      `table prints; RESOLUTION_REQUESTS_PER_REPOSITORY + TRAFFIC_REQUESTS_PER_REPOSITORY in ${RUN_JS} ` +
      `is ${REQUESTS_PER_REPOSITORY_PER_RUN}`,
  );

  // The sentence calls the yearly figure the per-run total for one run a day over a
  // leap year, so the figure it publishes is that multiplication and not a round
  // number someone chose for readability.
  const perYear = REQUESTS_PER_REPOSITORY_PER_RUN * RUNS_PER_YEAR;
  assert.ok(
    budget.includes(perYear.toLocaleString('en-US')),
    `"## ${BUDGET_HEADING}" does not publish the yearly figure the same sentence derives, ` +
      `${REQUESTS_PER_REPOSITORY_PER_RUN} requests for ${RUNS_PER_YEAR} runs a day over a leap year, which ` +
      `is ${perYear.toLocaleString('en-US')}`,
  );
});

// The feature document the plan points at for the output design spells the same
// budget out in words, and those words are the same constants.
test('the feature document budget sentence states the same figures in words', () => {
  const design = flatten(section(FEATURE, '4. Command and Output Design'));
  const sentence = /The budget is the part worth stating plainly: ([^.]+)\./.exec(design);
  assert.ok(
    sentence !== null,
    '"## 4. Command and Output Design" of docs/features/enrollment-and-collection.md no longer states ' +
      'the budget in a sentence of its own',
  );
  const stated = sentence[1] ?? '';
  const perRun = SPELLED[REQUESTS_PER_REPOSITORY_PER_RUN];
  const floor = SPELLED[BACKFILL_REQUESTS_FLOOR];
  assert.ok(
    perRun !== undefined && floor !== undefined,
    `the constants in ${RUN_JS} left the range this document spells out in words ` +
      `(${REQUESTS_PER_REPOSITORY_PER_RUN} and ${BACKFILL_REQUESTS_FLOOR}); a reader of the feature ` +
      'document cannot be shown the digit instead without editing that document',
  );
  assert.match(
    stated,
    new RegExp(`\\b${perRun} requests per repository per run\\b`),
    `docs/features/enrollment-and-collection.md states "${stated}" and the collector's own total is ` +
      `${REQUESTS_PER_REPOSITORY_PER_RUN} requests per repository per run`,
  );
  assert.match(
    stated,
    new RegExp(`\\bat least ${floor} once\\b`),
    `docs/features/enrollment-and-collection.md states "${stated}" and BACKFILL_REQUESTS_FLOOR in ` +
      `${RUN_JS} is ${BACKFILL_REQUESTS_FLOOR}`,
  );
});

// RS-COL-C03: the budget is one identity request plus the four traffic requests,
// and the backfill floor is added to that total exactly once - not once per
// endpoint, not twice. The three figures are observed here on real runs, so a
// constant that stopped being what the collector spends fails even if the
// runbook agrees with the constant.
test('the documented budget is one identity plus four traffic requests, with the backfill floor added once', async (t) => {
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptCollection(f.stub);

  // Before anything is stored, the plan carries the backfill floor.
  const firstPlan = await f.run(['collect', '--dry-run']);
  assert.equal(firstPlan.status, 0, firstPlan.stderr);
  const floorLine = /** @type {string} */ (lines(firstPlan.stdout)[0]);
  const firstConnect = requestsFigure(floorLine);
  assert.equal(firstConnect.exact, false,
    `the first-connect plan must be a floor, not an exact count: ${JSON.stringify(floorLine)}`);
  assert.equal(f.stub.requests().length, 0, 'a dry run must not contact GitHub at all');

  // The first run spends the identity request, the backfill and the traffic.
  const first = await f.run(['collect']);
  assert.equal(first.status, 0, first.stderr);

  // The backfill has completed, so the next plan is the exact per-run total.
  f.stub.reset();
  const steadyPlan = await f.run(['collect', '--dry-run']);
  const steadyLine = /** @type {string} */ (lines(steadyPlan.stdout)[0]);
  const steady = requestsFigure(steadyLine);
  assert.equal(steady.exact, true, `the steady-state plan is an exact count: ${JSON.stringify(steadyLine)}`);

  // And the run itself makes exactly the requests the two constants describe.
  const steadyRun = await f.run(['collect']);
  assert.equal(steadyRun.status, 0, steadyRun.stderr);
  const paths = f.stub.paths();
  const resolutions = paths.filter((candidate) => /^\/repos\/[^/]+\/[^/]+$/.test(candidate));
  const traffic = paths.filter((candidate) => candidate.includes('/traffic/'));
  assert.equal(
    resolutions.length,
    RESOLUTION_REQUESTS_PER_REPOSITORY,
    `the run resolved ${resolutions.length} repositories and RESOLUTION_REQUESTS_PER_REPOSITORY in ` +
      `${RUN_JS} is ${RESOLUTION_REQUESTS_PER_REPOSITORY}; it requested ${paths.join(', ')}`,
  );
  assert.equal(
    traffic.length,
    TRAFFIC_REQUESTS_PER_REPOSITORY,
    `the run read ${traffic.length} traffic endpoints and TRAFFIC_REQUESTS_PER_REPOSITORY in ${RUN_JS} ` +
      `is ${TRAFFIC_REQUESTS_PER_REPOSITORY}; it requested ${paths.join(', ')}`,
  );
  assert.equal(
    summaryRequests(steadyRun.stdout),
    REQUESTS_PER_REPOSITORY_PER_RUN,
    `the summary line counts ${summaryRequests(steadyRun.stdout)} requests for a repository whose backfill ` +
      `is complete, and the two exported steps in ${RUN_JS} add to ${REQUESTS_PER_REPOSITORY_PER_RUN}`,
  );

  // The floor is the difference between the two plans, once.
  assert.equal(
    firstConnect.count - steady.count,
    BACKFILL_REQUESTS_FLOOR,
    `the first-connect plan counted ${firstConnect.count} requests and the steady-state plan ` +
      `${steady.count}, a difference of ${firstConnect.count - steady.count}; BACKFILL_REQUESTS_FLOOR in ` +
      `${RUN_JS} is ${BACKFILL_REQUESTS_FLOOR} and must be added exactly once`,
  );

  // And the runbook prints the figures those two plans actually produced.
  const budget = flatten(section(SCHEDULING, BUDGET_HEADING));
  assert.ok(
    budget.includes(`requests>=${firstConnect.count}`),
    `"## ${BUDGET_HEADING}" does not print requests>=${firstConnect.count} for a repository that has never ` +
      `been collected; a dry run on an empty archive printed ${JSON.stringify(floorLine)}`,
  );
  assert.ok(
    budget.includes(`requests=${steady.count}`),
    `"## ${BUDGET_HEADING}" does not print requests=${steady.count} for a repository that has; a dry run ` +
      `after the first collection printed ${JSON.stringify(steadyLine)}`,
  );
});

// RS-COL-C03: a repository the archive recorded unavailable is planned at zero
// requests, at the plan level and on the printed line, and no later run asks
// about it. The runbook's `requests=0` claim is asserted against both.
test('a repository the archive marked unavailable is planned at zero requests', async (t) => {
  // The plan itself, decided from the archive and the configuration alone.
  const root = mkdtempSync('/tmp/opencode/repo-signal-collect-contract-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = await openArchive(resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } }).databasePath);
  t.after(() => db.close());
  upsertRepository(db, { id: 1, owner: 'owner', name: 'alpha', lastSeenAt: '2026-10-01T00:00:00.000Z', enrolled: 1 });
  const reason = 'GitHub answered HTTP 404 for owner/alpha: check the name and the token';
  withTransaction(db, () => markUnavailable({ db, repositoryId: 1, reason, collectedAt: '2026-10-02T00:00:00.000Z' }));

  const [planned] = planCollect({ db, config: validateConfig({ enrolled: ['owner/alpha'] }) });
  assert.ok(planned !== undefined, 'the enrolled repository was not planned at all');
  assert.equal(planned.skipped, true, 'a repository the archive marked unavailable must be planned as skipped');
  assert.equal(planned.requests, 0,
    `planCollect plans ${planned.requests} requests for a repository the archive already marked ` +
      `unavailable, and RS-COL-C03 in docs/features/enrollment-and-collection.md skips it at zero`);
  assert.equal(planned.exactRequests, true, 'zero requests is exact, never a floor');
  assert.equal(planned.backfill, false, 'a skipped repository runs no backfill');
  assert.equal(planned.unavailableReason, reason, 'the reason the archive recorded travels with the plan');

  // And the printed line, driven through the real entry point.
  const f = await createCollectHome(t, { enrolled: ['owner/alpha'] });
  scriptCollection(f.stub, { vanished: ['owner/alpha'] });
  const marked = await f.run(['collect']);
  assert.equal(marked.status, 1, 'a run that marked a repository unavailable exits 1');

  f.stub.reset();
  const plan = await f.run(['collect', '--dry-run']);
  assert.equal(plan.status, 0, plan.stderr);
  const plannedLine = /** @type {string} */ (lines(plan.stdout)[0]);
  const plannedRequests = requestsFigure(plannedLine);
  assert.equal(plannedRequests.count, 0, `the printed plan is ${JSON.stringify(plannedLine)}`);
  assert.equal(
    f.stub.requests().length,
    0,
    'a dry run over a marked repository must not re-confirm the marking over the network',
  );

  const later = await f.run(['collect']);
  assert.equal(later.status, 0, later.stderr);
  const laterLine = /** @type {string} */ (lines(later.stdout)[0]);
  assert.match(laterLine, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+ skipped lifecycle=\S+/,
    `a repository the archive already marked is reported as skipped: ${JSON.stringify(laterLine)}`);
  assert.deepEqual(f.stub.paths(), [],
    `a repository marked unavailable was requested again: ${f.stub.paths().join(', ')}`);
  assert.equal(summaryRequests(later.stdout), 0, `the run counted requests for a skipped repository:\n${later.stdout}`);

  const budget = flatten(section(SCHEDULING, BUDGET_HEADING));
  assert.ok(
    budget.includes('requests=0'),
    `"## ${BUDGET_HEADING}" no longer states that a repository the archive marked unavailable costs nothing`,
  );
});

// RS-C12: the state words a runbook shows on a collection line are the states a
// run actually returns, and the feature document enumerates exactly the states a
// run or a plan prints. A word in prose the code cannot produce is a false
// capability, and a state the code produces that no document names is a word an
// operator will never be told about.
test('the documented per-repository line states are exactly the states a run returns', async (t) => {
  const f = await createCollectHome(t, { enrolled: ['owner/alpha', 'owner/beta'] });
  scriptCollection(f.stub);
  const plannedLine = /** @type {string} */ (lines((await f.run(['collect', '--dry-run'])).stdout)[0]);

  scriptCollection(f.stub, { failing: 'owner/beta' });
  const mixed = await f.run(['collect']);
  assert.equal(mixed.status, 1, 'a run with one failing repository exits 1');

  scriptCollection(f.stub, { vanished: ['owner/alpha', 'owner/beta'] });
  const vanished = await f.run(['collect']);
  assert.equal(vanished.status, 1, 'a run that marked both repositories unavailable exits 1');
  const later = await f.run(['collect']);
  assert.equal(later.status, 0, later.stderr);

  /** @type {Set<string>} Every state the collector printed, the plan's own line included. */
  const printed = new Set();
  /** @type {Set<string>} The states a repository outcome carries, which a run returns. */
  const outcomes = new Set();
  // Only a dry run prints `planned`; no real run returns it as an outcome.
  const planState = printedLineState(plannedLine);
  assert.ok(planState !== null, `the dry run printed no per-repository line: ${JSON.stringify(plannedLine)}`);
  printed.add(planState);
  for (const stdout of [mixed.stdout, vanished.stdout, later.stdout]) {
    for (const line of lines(stdout)) {
      const state = printedLineState(line);
      if (state === null) continue;
      printed.add(state);
      outcomes.add(state);
    }
  }

  // Every outcome state the runs produced is one a runbook shows an example of,
  // and every state a runbook shows is one a run produced.
  /** @type {Set<string>} */
  const documented = new Set();
  for (const page of PAGES) {
    for (const state of documentedExampleStates(read(page.file))) {
      documented.add(state);
      assert.ok(
        printed.has(state),
        `${page.name} shows the per-repository line "${state}", which no run printed; the lines observed ` +
          `were ${JSON.stringify([...printed].sort())}`,
      );
    }
  }
  assert.ok(documented.size > 0, 'neither runbook shows a single per-repository collection line');
  for (const state of outcomes) {
    assert.ok(
      documented.has(state),
      `a run returned the per-repository state "${state}" and no runbook shows an example of it; the ` +
        `documents show ${JSON.stringify([...documented].sort())}`,
    );
  }
  assert.deepEqual(
    [...documented].sort(),
    [...outcomes].sort(),
    'the per-repository line states the runbooks document are not the states a run returns; ' +
      `documented ${JSON.stringify([...documented].sort())}, observed ${JSON.stringify([...outcomes].sort())}`,
  );

  // And the feature document's own enumeration is the printed vocabulary, planned
  // line included, so a state added to the collector has to be documented there.
  const design = flatten(section(FEATURE, '4. Command and Output Design'));
  const sentence = /Per-repository lines are ([^.]+)\./.exec(design);
  assert.ok(
    sentence !== null,
    '"## 4. Command and Output Design" of docs/features/enrollment-and-collection.md no longer enumerates ' +
      'the per-repository line states in a sentence of its own',
  );
  const enumerated = new Set([...(sentence[1] ?? '').matchAll(/`([a-z][a-z-]*)`/g)].map((match) => match[1] ?? ''));
  assert.deepEqual(
    [...enumerated].sort(),
    [...printed].sort(),
    `"${sentence[0]}" enumerates ${JSON.stringify([...enumerated].sort())} and the collector printed ` +
      `${JSON.stringify([...printed].sort())}; the collector is what RS-COL-C03 and section 4 describe, ` +
      'so a state appearing in one and not the other is the finding',
  );
});