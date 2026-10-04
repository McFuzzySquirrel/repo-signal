import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stampFirstCollected } from '../src/backfill/provenance.js';
import {
  CLONES_METRIC, UNIQUE_CLONERS_METRIC, UNIQUE_VISITORS_METRIC, VIEWS_METRIC,
} from '../src/collect/traffic.js';
import { validateConfig } from '../src/config/schema.js';
import { calendarDays, upsertDayFact } from '../src/db/day-series-repo.js';
import {
  appendRun, completeRun, openArchive, upsertRepository, withTransaction,
} from '../src/db/ops-repo.js';
import { appendSnapshot } from '../src/db/snapshot-repo.js';
import { resolveHomePaths } from '../src/paths.js';
import { STYLESHEET_HREF, escapeUrl } from '../src/server/html.js';
import { createRouter } from '../src/server/router.js';
import { CONTENT_SECURITY_POLICY, CONTENT_TYPE_HTML, securityHeaders } from '../src/server/security.js';
import {
  DEFAULT_MAX_URL_LENGTH, LOOPBACK_HOST, createRequestHandler, createServer, isLoopbackAddress,
} from '../src/server/server.js';
import {
  THEME_CONTENT_TYPE, THEME_TOKEN_FILE, THEME_STYLESHEET_PATH, auditDocument, skipLink,
} from '../src/server/views/a11y.js';
import {
  DEFAULT_WINDOW_DAYS, VIEW_ASSET_TABLE, VIEW_MOUNT_TABLE, VIEW_PATH_TABLE, VIEW_ROUTES,
  createViewRegistry,
} from '../src/server/views/index.js';
import {
  REPOSITORY_STATE_PRECEDENCE, RUN_STATE_COMPLETED, RUN_STATE_DEGRADED, RUN_STATE_NEVER_RUN,
  RUN_STATE_UNCLOSED, SUMMARY_STATE_EMPTY, statePhrase,
} from '../src/supervision/health.js';
import { recordFailure, recordSuccess } from '../src/supervision/repo-state-reporter.js';

/**
 * The documented dashboard claims, asserted against the server that serves them.
 *
 * RS-C12 makes this a product constraint rather than a nicety: the README, the privacy
 * note, the feature document and the health runbook all make promises about the
 * loopback dashboard, and every one of them is only true because some module in
 * `src/server/` behaves a particular way. The failure mode is specific and expensive
 * - a runbook documenting a header the server stopped sending, a privacy note claiming
 * no remote asset while a page grows a CDN link, a state word the health read cannot
 * return - and every other suite stays green through all of it.
 *
 * Every test here reads a document as text *and* the server as the thing it serves. A
 * test that read only the document would prove the document is self-consistent, which
 * was never in question. The direction of repair is the document's: where prose and
 * code disagreed, this suite reports the disagreement rather than moving a threshold, a
 * header, a route or a state word to make a suite green.
 *
 * The server is the product's own. `createServer` binds the real loopback socket,
 * `createRouter` maps the three routes, `createViewRegistry` mounts the pages and the
 * one asset in front of the router, and every page is fetched over real HTTP from the
 * real archive a temporary home holds. Only the clock is injected, so a page is a
 * function of what the archive recorded rather than of when the suite ran.
 *
 * Nothing here reaches a host. Every request is to a loopback server this file started,
 * and that is the only network the file performs.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */

/**
 * One answer off the wire, read whole so every assertion is about bytes rather than
 * about a status line.
 *
 * @typedef {object} AnsweredPage
 * @property {string} label What the request was for.
 * @property {string} pathname The path and query, relative to the server URL.
 * @property {number} status The status the server answered with.
 * @property {Headers} headers The response headers as they arrived.
 * @property {string} body The response body as text.
 */

/**
 * One answer from a hand-driven request, which is the only way to present the server
 * with a peer that did not arrive on loopback.
 *
 * @typedef {object} PeerAnswer
 * @property {number} status
 * @property {Record<string, string>} headers
 * @property {string} body
 * @property {number} viewCalls How many times the view handler ran.
 * @property {unknown[]} logged What the logger was given.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = path.join(ROOT, 'README.md');
const PRIVACY = path.join(ROOT, 'docs', 'operations', 'privacy.md');
const RUNBOOK = path.join(ROOT, 'docs', 'operations', 'troubleshooting.md');
const FEATURE = path.join(ROOT, 'docs', 'features', 'dashboard-server.md');
const PRD = path.join(ROOT, 'docs', 'PRD.md');
const SECURITY_SOURCE = path.join(ROOT, 'src', 'server', 'security.js');
const SERVER_SOURCE = path.join(ROOT, 'src', 'server', 'server.js');
const ROUTER_SOURCE = path.join(ROOT, 'src', 'server', 'router.js');
const HEALTH_VIEW_SOURCE = path.join(ROOT, 'src', 'server', 'views', 'health.js');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The reference day every fixture's window ends on, and when its reads are taken. */
const TODAY = '2026-10-02';
const READ_AT_MS = Date.parse('2026-10-02T12:00:00.000Z');

const OWNER = 'maintainer';
/** The one repository with stored days, a recorded boundary and a captured list. */
const CHARTED = 'archive';
/** An identity the archive does not hold, so the router refuses it with a 404. */
const UNKNOWN = 'never-enrolled';

/**
 * The words one enrolled repository can carry, plus the roll-up word for a home that
 * has enrolled nothing. Read from the health read's own exports rather than written
 * out here, so this file cannot become a second source of the vocabulary.
 *
 * @type {readonly string[]}
 */
const STATE_WORDS = Object.freeze([...REPOSITORY_STATE_PRECEDENCE, SUMMARY_STATE_EMPTY]);

/**
 * The words the run half of the health read can carry, from the same exports.
 *
 * @type {readonly string[]}
 */
const RUN_WORDS = Object.freeze([
  RUN_STATE_NEVER_RUN, RUN_STATE_UNCLOSED, RUN_STATE_COMPLETED, RUN_STATE_DEGRADED,
]);

/**
 * Every string the health page can show in place of a state: the words themselves and
 * the phrases {@link statePhrase} announces them as. Both directions come from the
 * read, so a state whose sentence is not its hyphenated form needs no table here.
 *
 * @type {ReadonlySet<string>}
 */
const STATE_PHRASES = new Set([...STATE_WORDS, ...STATE_WORDS.map(statePhrase)]);

/**
 * @param {string} file Absolute path.
 * @returns {string} The document's text.
 */
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
 * One `##` section of a document, with its line structure intact.
 * @param {string} file Absolute path.
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function sectionText(file, heading) {
  const text = read(file);
  const marker = `## ${heading}\n`;
  assert.ok(text.includes(marker), `${path.basename(file)} has no "## ${heading}" section`);
  const body = text.slice(text.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

/**
 * One `##` section of a document, flattened.
 * @param {string} file Absolute path.
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function section(file, heading) {
  return flatten(sectionText(file, heading));
}

/**
 * The text of one `forge-requirement` block, read from the document rather than
 * remembered: a requirement whose prose changed is asserted against its new wording.
 *
 * @param {string} file Absolute path of a feature document or the PRD.
 * @param {string} id Canonical requirement id.
 * @returns {string}
 */
function requirementText(file, id) {
  const text = read(file);
  for (const block of text.matchAll(/```forge-requirement\s*\n([\s\S]*?)```/g)) {
    const parsed = /** @type {{id?: string, text?: string}} */ (JSON.parse(block[1] ?? ''));
    if (parsed.id === id) {
      assert.equal(typeof parsed.text, 'string', `${id} declares no text to assert against`);
      return /** @type {string} */ (parsed.text);
    }
  }
  assert.fail(`${path.basename(file)} declares no ${id} requirement block`);
}

/**
 * Every JavaScript file under a directory, so an import claim covers the whole tree
 * rather than the file a reviewer happened to open.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function javascriptFiles(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files.sort();
}

/**
 * The content security policy a requirement's prose describes, parsed from that prose
 * rather than transcribed from the module. Each clause is read for the directive it
 * names and for the source it is limited to: a clause naming `self` is a directive
 * limited to this origin, and every other clause - including the ones worded "no
 * base-uri" - is the directive restricted to nothing.
 *
 * @param {string} requirement The requirement text.
 * @returns {Map<string, string>}
 */
function directivesFromRequirement(requirement) {
  /** @type {Map<string, string>} */
  const directives = new Map();
  for (const clause of requirement.split(/[;,]/)) {
    for (const [, name] of clause.matchAll(/\b([a-z]+-(?:src|uri|action|ancestors))\b/g)) {
      directives.set(/** @type {string} */ (name), /\bself\b/.test(clause) ? "'self'" : "'none'");
    }
  }
  assert.ok(directives.size > 0, 'the requirement names no content security policy directive');
  return directives;
}

/**
 * The policy the module exports, read the way a browser reads it: directive by
 * directive, with the source each one allows.
 *
 * @returns {Map<string, string>}
 */
function exportedPolicy() {
  /** @type {Map<string, string>} */
  const policy = new Map();
  for (const directive of CONTENT_SECURITY_POLICY.split(';')) {
    const [name, ...source] = directive.trim().split(/\s+/);
    assert.ok(name !== undefined && name !== '', `a directive of ${CONTENT_SECURITY_POLICY} has no name`);
    policy.set(name, source.join(' '));
  }
  return policy;
}

/**
 * The state words a runbook's tables name, in table order: the repository table first,
 * the run table second. A runbook that dropped, merged or reordered its tables fails
 * here rather than quietly narrowing the comparison.
 *
 * @param {string} runbookSection The runbook section with its line structure.
 * @returns {{ repository: string[], run: string[] }}
 */
function runbookStateTables(runbookSection) {
  const tables = runbookSection.split(/\n[ \t]*\n/).filter((block) => block.trimStart().startsWith('|'));
  assert.equal(tables.length, 2, `the health runbook names two state tables; it names ${String(tables.length)}`);
  /** @param {string} table @returns {string[]} */
  const words = (table) => [...table.matchAll(/\|\s*`([a-z][a-z-]*)`\s*\|/g)]
    .map((match) => /** @type {string} */ (match[1]));
  return { repository: words(/** @type {string} */ (tables[0])), run: words(/** @type {string} */ (tables[1])) };
}

/**
 * Every date this file's fixtures use, derived from one reference day and one read
 * instant, so every assertion is written against a computed day rather than a
 * remembered one and the window is the registry's own figure rather than a literal.
 *
 * @param {string} today ISO `YYYY-MM-DD`.
 * @param {number} nowMs Epoch milliseconds.
 * @returns {ArchivePlan}
 */
function planArchive(today, nowMs) {
  const from = new Date(Date.parse(`${today}T00:00:00.000Z`) - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS)
    .toISOString().slice(0, 10);
  const boundary = new Date(Date.parse(`${from}T00:00:00.000Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
  const hole = new Date(Date.parse(`${boundary}T00:00:00.000Z`) + 3 * DAY_MS).toISOString().slice(0, 10);
  return {
    today,
    nowMs,
    from,
    boundary,
    hole,
    window: calendarDays(from, today),
    recentAt: new Date(nowMs - 5 * HOUR_MS).toISOString(),
    staleAt: new Date(nowMs - 31 * HOUR_MS).toISOString(),
    failedAt: new Date(nowMs - 4 * HOUR_MS).toISOString(),
    backfilledAt: `${from}T06:00:00.000Z`,
    runOne: `${from}T06:00:00.000Z`,
    runTwo: `${today}T06:00:00.000Z`,
    query: `from=${from}&to=${today}`,
  };
}

/**
 * @typedef {object} ArchivePlan
 * @property {string} today The reference day the window ends on.
 * @property {number} nowMs The instant every health read is judged against.
 * @property {string} from The first day of the default window.
 * @property {string} boundary The recorded first collected day.
 * @property {string} hole The day inside the window no run ever recorded.
 * @property {string[]} window Every calendar day the window covers.
 * @property {string} recentAt A success five hours before the read: inside the threshold.
 * @property {string} staleAt A success thirty-one hours before the read: past the threshold.
 * @property {string} failedAt The instant the recorded failures were written.
 * @property {string} backfilledAt The instant the backfilled range was recorded.
 * @property {string} runOne When the first run began.
 * @property {string} runTwo When the second run began.
 * @property {string} query The query every page request carries, selecting the window.
 */

/** The one plan every fixture in this file shares. @type {ArchivePlan} */
const PLAN = planArchive(TODAY, READ_AT_MS);

/**
 * @param {string} name
 * @returns {string}
 */
function detailPath(name) {
  return `/repo/${escapeUrl(OWNER)}/${escapeUrl(name)}`;
}

/**
 * Enrol one repository, without touching anything else about it.
 *
 * @param {Database} db
 * @param {number} id
 * @param {string} name
 * @param {ArchivePlan} plan
 * @returns {void}
 */
function enrol(db, id, name, plan) {
  upsertRepository(db, { id, owner: OWNER, name, lastSeenAt: plan.recentAt, enrolled: 1 });
}

/**
 * The default seed: seven repositories covering the seven states the health read can
 * report, with stored traffic days, a recorded boundary and two captured lists on the
 * collected one, and a run that closed with every repository collected.
 *
 * @param {Database} db
 * @param {ArchivePlan} plan
 * @returns {void}
 */
function seedEveryState(db, plan) {
  appendRun(db, { id: 'run-1', startedAt: plan.runOne });
  appendRun(db, { id: 'run-2', startedAt: plan.runTwo });

  enrol(db, 1, CHARTED, plan);
  const stored = plan.window.filter((day) => day !== plan.hole);
  withTransaction(db, () => {
    for (const [index, day] of stored.entries()) {
      const backfilled = day < plan.boundary;
      /** @type {Array<[string, number]>} */
      const readings = [
        [CLONES_METRIC, 2 + (index % 7)],
        [UNIQUE_CLONERS_METRIC, 1 + (index % 4)],
        [VIEWS_METRIC, 30 + (index % 11)],
        [UNIQUE_VISITORS_METRIC, 5 + (index % 6)],
      ];
      for (const [metric, value] of readings) {
        upsertDayFact(db, {
          repositoryId: 1, metric, granularity: 'day', day, value,
          source: backfilled ? 'backfill' : 'collected',
          collectedAt: backfilled ? plan.backfilledAt : plan.recentAt,
        });
      }
    }
    // A stored referrer label is a URL in the archive, so it reaches the detail page
    // as text. It is the reason the remote-reference scan below reads attributes
    // rather than the whole document: a page may name a remote host as a stored
    // observation and must never reference one.
    appendSnapshot(db, {
      repositoryId: 1, runId: 'run-1', kind: 'referrers', label: 'https://news.example/post',
      count: 4, uniques: 2, position: 0, collectedAt: plan.runOne,
    });
    appendSnapshot(db, {
      repositoryId: 1, runId: 'run-2', kind: 'popular_paths', label: '/guide', title: 'Guide',
      count: 11, uniques: 6, position: 0, collectedAt: plan.runTwo,
    });
  });
  stampFirstCollected(db, 1, { day: plan.boundary, collectedAt: plan.recentAt });
  recordSuccess({ db, repositoryId: 1, collectedAt: plan.recentAt });

  enrol(db, 2, 'fresh', plan);

  enrol(db, 3, 'flaky', plan);
  recordSuccess({ db, repositoryId: 3, collectedAt: plan.recentAt });
  recordFailure({
    db, repositoryId: 3, runId: 'run-2', repo: `${OWNER}/flaky`, endpointType: 'traffic',
    error: { status: 429 }, collectedAt: plan.failedAt,
  });

  enrol(db, 4, 'lapsed', plan);
  recordSuccess({ db, repositoryId: 4, collectedAt: plan.recentAt });
  recordFailure({
    db, repositoryId: 4, runId: 'run-2', repo: `${OWNER}/lapsed`, endpointType: 'traffic',
    error: { status: 403 }, collectedAt: plan.failedAt,
  });

  enrol(db, 5, 'stale', plan);
  recordSuccess({ db, repositoryId: 5, collectedAt: plan.staleAt });

  upsertRepository(db, {
    id: 6, owner: OWNER, name: 'retired', lastSeenAt: plan.recentAt, enrolled: 1,
    lifecycle: 'unavailable',
    unavailableReason: `GitHub answered HTTP 404 for ${OWNER}/retired: the repository does not exist`,
  });

  enrol(db, 7, 'odd', plan);
  recordSuccess({ db, repositoryId: 7, collectedAt: plan.recentAt });
  // A recorded success this build cannot read, written as the raw value an archive that
  // predates the product's timestamp validation could hold. Every product write refuses
  // such a value, which is exactly why the `unreadable` state exists: the page needs a
  // word for an archive it cannot read rather than a stall invented from it.
  db.prepare('UPDATE repositories SET last_success_at=? WHERE id=?').run('the day before yesterday', 7);

  completeRun(db, 'run-2', {
    closedAt: plan.recentAt, status: 'completed', successCount: 5, failureCount: 0,
    requestCount: 31, durationMs: 4200,
  });
}

/**
 * @typedef {object} DashboardFixture
 * @property {Database} db The open archive every page reads.
 * @property {string} home The temporary home the product resolved.
 * @property {{url: string, close: () => Promise<void>}} server The real loopback server.
 * @property {ReturnType<typeof createViewRegistry>} registry The mounted view registry.
 * @property {() => number} viewCalls How many requests reached the view handler.
 */

/**
 * Start the product's own dashboard over a temporary archive, mounted exactly the way
 * `src/commands/serve.js` mounts it: the server factory in front, the view registry's
 * own pages and asset in front of the router, and the router owning the three routes
 * and every status it returns.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} prefix Distinguishes each fixture's temporary directory.
 * @param {(db: Database, plan: ArchivePlan) => void} [seed]
 * @returns {Promise<DashboardFixture>}
 */
async function dashboard(t, prefix, seed = seedEveryState) {
  const root = mkdtempSync(path.join(tmpdir(), `repo-signal-contract-server-${prefix}-`));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(root, 'home') } });
  const db = await openArchive(paths.databasePath);
  seed(db, PLAN);
  const registry = createViewRegistry({ db, clock: () => PLAN.nowMs, today: PLAN.today });
  const router = createRouter({ views: registry.views, hasRepository: registry.hasRepository });
  const answer = registry.answerOwnRoutes(router);
  let calls = 0;
  const server = await createServer({
    handler: (req) => {
      calls += 1;
      return answer(req);
    },
    logger: () => {},
  });
  t.after(async () => {
    await server.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, home: paths.home, server, registry, viewCalls: () => calls };
}

/**
 * Request one page and read the whole response.
 *
 * @param {{url: string}} server
 * @param {string} pathname
 * @param {RequestInit} [init]
 * @returns {Promise<AnsweredPage>}
 */
async function request(server, pathname, init) {
  const response = await fetch(`${server.url}${pathname}`, init);
  return {
    label: `${init === undefined ? 'GET' : /** @type {string} */ (init.method)} ${pathname}`,
    pathname,
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

/**
 * One request through `node:http`, so a method the fetch client refuses to carry -
 * TRACE and CONNECT among them - can still be offered to the server and refused by it.
 *
 * @param {string} url The server's URL.
 * @param {string} pathname The path and query.
 * @param {string} method
 * @returns {Promise<AnsweredPage>}
 */
function rawRequest(url, pathname, method) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const sent = http.request({ host: target.hostname, port: target.port, method, path: pathname }, (response) => {
      /** @type {Array<[string, string]>} */
      const flat = [];
      for (const [name, value] of Object.entries(response.headers)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (entry !== undefined) flat.push([name, entry]);
        }
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        label: `${method} ${pathname}`,
        pathname,
        status: response.statusCode ?? 0,
        headers: new Headers(flat),
        body,
      }));
    });
    sent.once('error', reject);
    sent.end();
  });
}

/**
 * Every answer the dashboard gives as a document: the three router routes, the health
 * page the registry mounts, the stylesheet it serves, and the two refusals the router
 * answers through the same shell.
 *
 * @param {{url: string}} server
 * @returns {Promise<AnsweredPage[]>}
 */
async function everyServedPage(server) {
  return [
    await request(server, `/?${PLAN.query}`),
    await request(server, `/repos?${PLAN.query}`),
    await request(server, `${detailPath(CHARTED)}?${PLAN.query}`),
    await request(server, `${detailPath(UNKNOWN)}?${PLAN.query}`),
    await request(server, `${detailPath(CHARTED)}?from=${PLAN.today}&to=${PLAN.from}`),
    await request(server, '/health'),
    await request(server, THEME_STYLESHEET_PATH),
  ];
}

/**
 * Every reference a document makes that a browser could resolve into a request: `href`,
 * `src` and `srcset`, in the double-quoted spelling the shell's escaping produces.
 *
 * @param {string} markup
 * @returns {string[]}
 */
function referencesOf(markup) {
  return [...markup.matchAll(/\b(?:href|src|srcset)\s*=\s*"([^"]*)"/g)]
    .map((match) => /** @type {string} */ (match[1]));
}

/**
 * The references that are neither a fragment nor a relative same-origin path: a
 * scheme, a protocol-relative host, a bare host - anything that would send a browser
 * to another machine.
 *
 * @param {string} markup
 * @returns {string[]}
 */
function offOriginReferences(markup) {
  return referencesOf(markup).filter((reference) => !/^(#|\/(?!\/))/.test(reference));
}

/**
 * The stylesheet with its comments removed. This file explains at length why it has no
 * `url()`, no `@import` and no `@font-face`, and a comment naming a forbidden construct
 * is not a declaration of one.
 *
 * @param {string} css
 * @returns {string}
 */
function declarationsOnly(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * The constructs that would let a page fetch something from a host or run something:
 * a script, an inline event handler, a nested or submitted document, or a fetched asset
 * declared in the markup itself.
 *
 * @param {string} markup
 * @returns {string[]} What was found, described rather than matched.
 */
function scriptOrRemoteConstructs(markup) {
  /** @type {Array<[RegExp, string]>} */
  const rules = [
    [/<script\b/i, 'a script element'],
    [/<[^>]+\son[a-z]+\s*=/i, 'an inline event handler'],
    [/javascript:/i, 'a javascript: reference'],
    [/<iframe|<embed|<object\b/i, 'a nested document'],
    [/<form\b|<input\b|<button\b/i, 'a submitted or interactive control'],
    [/@font-face|@import\b|url\(/i, 'a fetched asset declared in the markup'],
    [/<img\b|<image\b/i, 'an image'],
  ];
  /** @type {string[]} */
  const found = [];
  for (const [pattern, description] of rules) {
    const match = pattern.exec(markup);
    if (match !== null) found.push(`${description} (${JSON.stringify(match[0])})`);
  }
  return found;
}

/**
 * Drive one request through the handler without a socket, which is the only way to
 * present the server with a peer that did not arrive on loopback.
 *
 * @param {string} method
 * @param {string} url
 * @param {string|null} remoteAddress
 * @returns {Promise<PeerAnswer>}
 */
async function requestFromPeer(method, url, remoteAddress) {
  /** @type {unknown[]} */
  const logged = [];
  let calls = 0;
  const listener = createRequestHandler({
    logger: (error) => logged.push(error),
    handler: () => {
      calls += 1;
      return 'the view ran';
    },
  });
  const req = /** @type {any} */ ({ method, url, socket: { remoteAddress } });
  let status = 0;
  /** @type {Record<string, string>} */
  let headers = {};
  let body = '';
  const res = /** @type {any} */ ({
    headersSent: false,
    writeHead(/** @type {number} */ code, /** @type {Record<string, string>} */ value) {
      status = code;
      headers = value;
      this.headersSent = true;
    },
    end(/** @type {string|undefined} */ chunk) {
      body = chunk ?? '';
    },
  });
  await listener(req, res);
  return { status, headers, body, viewCalls: calls, logged };
}

// ---------------------------------------------------------------------------
// The four headers the privacy note names (RS-SRV-C02, RS-C11, RS-C12).
// ---------------------------------------------------------------------------

test('every served response carries the four headers the privacy note names, with the values src/server/security.js exports', async (t) => {
  // Arrange: the real server over a real archive, and the privacy note's own dashboard
  // section, so the header names and values on both sides are read rather than assumed.
  const f = await dashboard(t, 'headers');
  const note = section(PRIVACY, 'The dashboard');
  const named = [...note.matchAll(/`([A-Za-z][A-Za-z-]*): ([^`]+)`/g)]
    .map((match) => ({ name: /** @type {string} */ (match[1]), value: /** @type {string} */ (match[2]) }));
  assert.deepEqual(named, [
    { name: 'Cache-Control', value: 'no-store' },
    { name: 'Referrer-Policy', value: 'no-referrer' },
    { name: 'X-Content-Type-Options', value: 'nosniff' },
  ], 'docs/operations/privacy.md no longer names three headers with their values');
  assert.match(note, /content security policy of `default-src 'none'` with `script-src 'none'`/,
    'the privacy note no longer states the content security policy the server must send');

  // Act: every kind of answer the server produces - a document, an asset, both router
  // refusals, a method refusal, an over-long URL, the answer to HEAD, and the generic
  // 500 a throwing view produces.
  const thrown = await createServer({
    logger: () => {},
    handler: () => { throw new Error('a message no page may carry'); },
  });
  t.after(() => thrown.close());
  const answers = [
    await request(f.server, `/?${PLAN.query}`),
    await request(f.server, THEME_STYLESHEET_PATH),
    await request(f.server, '/not-a-page'),
    await request(f.server, `${detailPath(CHARTED)}?from=${PLAN.today}&to=${PLAN.from}`),
    await request(f.server, '/', { method: 'POST' }),
    await request(f.server, `/?pad=${'x'.repeat(DEFAULT_MAX_URL_LENGTH + 1)}`),
    await request(f.server, '/', { method: 'HEAD' }),
    await request(thrown, '/'),
  ];

  const exported = securityHeaders();
  assert.deepEqual(Object.keys(exported).sort(),
    ['Cache-Control', 'Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options'],
    'src/server/security.js no longer exports exactly the four headers the privacy note names');

  // Assert: every one of them, with the exported value, on every kind of answer.
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 404, 400, 405, 414, 200, 500],
    'the answers this test compares headers across are not the ones it asked for');
  for (const answer of answers) {
    for (const [name, value] of Object.entries(exported)) {
      assert.equal(answer.headers.get(name.toLowerCase()), value,
        `${answer.label} (${answer.status}) does not carry ${name}: ${value}`);
    }
    assert.equal(answer.headers.get('set-cookie'), null,
      `${answer.label}: the dashboard set a cookie, and it is unauthenticated`);
  }

  // The three values the note prints are the values on the wire, taken from the note
  // rather than from a second copy of them in this file.
  for (const { name, value } of named) {
    assert.equal(exported[name], value,
      `the privacy note says ${name} is ${value}; src/server/security.js sends ${String(exported[name])}`);
  }
  assert.equal(exported['Content-Security-Policy'], CONTENT_SECURITY_POLICY,
    'the header the note names as a policy is not the policy constant the module exports');
  for (const phrase of ["default-src 'none'", "script-src 'none'"]) {
    assert.ok(CONTENT_SECURITY_POLICY.includes(phrase),
      `the policy the privacy note names (${phrase}) is not in what the server sends: ${CONTENT_SECURITY_POLICY}`);
  }

  // The directives themselves are read out of the requirement that publishes them, so a
  // directive dropped from the policy or added to the requirement both fail here.
  const requirement = requirementText(FEATURE, 'RS-SRV-C02');
  assert.deepEqual(exportedPolicy(), directivesFromRequirement(requirement),
    `src/server/security.js's policy and the directives RS-SRV-C02 names disagree; the requirement says: ${requirement}`);
  assert.equal(exportedPolicy().size, new Set(exportedPolicy().keys()).size,
    'the exported policy names a directive twice');

  // The three header values and the content type are named by that same requirement, so
  // what was compared above is what the document asks for.
  for (const { name, value } of named) {
    assert.ok(requirement.includes(value),
      `RS-SRV-C02 does not name ${value}, which the privacy note names as ${name}`);
  }
  assert.match(requirement, /explicit UTF-8 HTML content type/,
    'RS-SRV-C02 no longer asks for an explicit UTF-8 HTML content type');
  assert.match(CONTENT_TYPE_HTML, /^text\/html; charset=utf-8$/,
    `the HTML content type is not the explicit UTF-8 type RS-SRV-C02 names: ${CONTENT_TYPE_HTML}`);
  assert.equal(answers[0].headers.get('content-type'), CONTENT_TYPE_HTML,
    'a served document is not served with the documented content type');

  // The one answer that is not an HTML document: the stylesheet carries its own type,
  // with the security headers on top of it rather than in place of it.
  assert.equal(answers[1].headers.get('content-type'), THEME_CONTENT_TYPE,
    'the stylesheet route no longer overrides the document content type with the one the asset mount declares');
  assert.equal(answers[6].body, '', 'HEAD answered with a body; it must carry the GET headers and no body');
  assert.equal(answers[6].headers.get('content-security-policy'), answers[0].headers.get('content-security-policy'),
    'HEAD did not answer with the headers GET answers with');
});

// ---------------------------------------------------------------------------
// No remote asset and no client-side script (RS-C03, RS-C11, README, privacy note).
// ---------------------------------------------------------------------------

test('no served page or the served stylesheet references a remote host, and none carries a script', async (t) => {
  // Arrange: every answer the dashboard gives, plus the claims that say why.
  const f = await dashboard(t, 'no-remote-asset');
  const pages = await everyServedPage(f.server);
  assert.deepEqual(pages.map((page) => page.status), [200, 200, 200, 404, 400, 200, 200],
    'the pages this test scans are not the pages it asked for');

  // The scanners are proved sensitive before they are trusted: a document built to break
  // each rule is reported as broken, so a green scan below is not an idle one.
  const hostile = '<a href="https://cdn.example.com/lib.js">x</a><a href="javascript:go()">y</a>'
    + '<script src="/local.js"></script><img src="/local.png">'
    + '<div onclick="go()" style="background: url(https://img.example.com/a.png)"></div>';
  assert.deepEqual(offOriginReferences(hostile), ['https://cdn.example.com/lib.js', 'javascript:go()'],
    'the off-origin rule no longer catches an absolute or scripted reference');
  assert.equal(scriptOrRemoteConstructs(hostile).length, 5,
    `the script rule no longer catches every construct; it found ${JSON.stringify(scriptOrRemoteConstructs(hostile))}`);
  assert.equal(declarationsOnly('/* a comment naming url() */ a { color: red; }').includes('url()'), false,
    'the comment stripper no longer removes a comment naming a forbidden construct');

  // Act and assert: for every document served, nothing resolves off-origin and nothing
  // can run. Each page's own stylesheet reference is what the attribute scan has to
  // find: without it the scan would have nothing to examine and would pass vacuously.
  for (const page of pages) {
    if (page.pathname === THEME_STYLESHEET_PATH) continue;
    assert.deepEqual(offOriginReferences(page.body), [],
      `${page.label}: every reference a browser could follow must be a fragment or a relative same-origin path`);
    assert.deepEqual(scriptOrRemoteConstructs(page.body), [],
      `${page.label}: the page carries a construct that could fetch or run something`);
    assert.deepEqual(referencesOf(page.body).filter((reference) => reference === STYLESHEET_HREF),
      [STYLESHEET_HREF],
      `${page.label}: the page does not link exactly the one local stylesheet, so the scan above had nothing to examine`);
  }

  // The stored referrer URL is what makes the attribute scan the right scan: the page
  // names a remote host as a recorded observation, and references none.
  const detail = pages[2];
  assert.ok(detail !== undefined && detail.body.includes('https://news.example/post'),
    'the detail page no longer prints the stored referrer URL, so the reference scan has nothing to be careful about');

  // The stylesheet is served from the file the registry mounts, so it is scanned as
  // bytes rather than as an attribute.
  const stylesheet = pages[6];
  assert.ok(stylesheet !== undefined, 'the stylesheet was not served at all');
  assert.deepEqual(scriptOrRemoteConstructs(declarationsOnly(stylesheet.body)), [],
    'the served stylesheet declares a fetched asset, a remote host or a script');
  for (const construct of ['url(', '@import', '@font-face', 'http://', 'https://', '//']) {
    assert.equal(declarationsOnly(stylesheet.body).includes(construct), false,
      `the served stylesheet contains ${construct}, which would fetch or name something off-origin`);
  }
  assert.equal(stylesheet.body, readFileSync(THEME_TOKEN_FILE, 'utf8'),
    'the served stylesheet is not the file src/ui/theme.css holds, so scanning that file would prove nothing');

  // The documents that say all of this, read for their own words.
  const readmeRow = read(README).split('\n').find((line) => line.includes('`node src/cli.js serve`'));
  assert.ok(readmeRow !== undefined, 'README.md names no row for `node src/cli.js serve`');
  assert.match(readmeRow, /`127\.0\.0\.1`/, 'the README no longer says the dashboard runs on 127.0.0.1');
  assert.match(readmeRow, /no client-side JavaScript/,
    'the README no longer says the dashboard sends no client-side JavaScript');
  const note = section(PRIVACY, 'The dashboard');
  assert.match(note, /It loads no remote asset and renders no JavaScript/,
    'the privacy note no longer states that the dashboard loads no remote asset and renders no JavaScript');
  assert.match(section(PRIVACY, 'What is never collected'), /The dashboard serves same-origin assets only/,
    'the privacy note no longer states that the dashboard serves same-origin assets only');
  assert.match(requirementText(PRD, 'RS-C03'), /remote font, remote image, CDN/,
    'RS-C03 no longer names a remote font, remote image and CDN as forbidden');
  assert.match(requirementText(PRD, 'RS-C11'), /sends no client-side JavaScript/,
    'RS-C11 no longer states that the dashboard sends no client-side JavaScript');
});

// ---------------------------------------------------------------------------
// Loopback only (RS-SRV-C01, privacy note, README, RS-C11).
// ---------------------------------------------------------------------------

test('a peer that is not loopback is refused with the header policy before any view runs, and the bind is 127.0.0.1', async (t) => {
  // Arrange: the handler itself, driven with a peer that did not arrive on loopback.
  const refused = await requestFromPeer('GET', '/', '198.51.100.23');
  assert.equal(refused.status, 403, 'a request from a routable address was served rather than refused');
  assert.equal(refused.viewCalls, 0, 'a view ran for a peer the server must refuse before routing');
  assert.deepEqual(refused.logged, [], 'a refused peer was logged as a view error');
  for (const [name, value] of Object.entries(securityHeaders())) {
    assert.equal(refused.headers[name], value,
      `the refusal carries no ${name}; the headers belong to the server, not to a page`);
  }
  assert.match(refused.body, /loopback/, 'the refusal page does not name the interface that refused it');
  assert.equal(refused.body.includes('198.51.100.23'), false,
    'the refusal page echoes the peer address back to the reader');

  // The predicate that decides is the one the socket handler uses, so a peer reachable
  // over IPv6 or an IPv4-mapped address is refused on the same rule.
  for (const address of ['198.51.100.23', '10.0.0.5', '::ffff:10.0.0.5', '0.0.0.0', '', null, undefined]) {
    assert.equal(isLoopbackAddress(/** @type {string} */ (address)), false,
      `${String(address)} was classified as loopback`);
  }
  for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackAddress(address), true, `${address} was refused as loopback`);
  }
  // The socket itself is destroyed rather than answered, which is stronger than the 403
  // and is the one part of the refusal no loopback request can observe, so the module
  // is read for it.
  assert.match(read(SERVER_SOURCE), /server\.on\('connection'[\s\S]*?isLoopbackAddress\(socket\.remoteAddress\)[\s\S]*?socket\.destroy\(\)/,
    'src/server/server.js no longer destroys a socket whose peer is not loopback');

  // The bind: the only host the factory listens on, and nothing that can change it.
  const f = await dashboard(t, 'loopback-bind');
  assert.equal(LOOPBACK_HOST, '127.0.0.1', 'the loopback host the factory exports is not 127.0.0.1');
  assert.equal(new URL(f.server.url).hostname, LOOPBACK_HOST,
    'the dashboard reported an address that is not the loopback host it binds');
  assert.ok(Number(new URL(f.server.url).port) > 0, 'the reported port is not a real listening port');
  assert.match(read(SERVER_SOURCE), /server\.listen\(0,\s*LOOPBACK_HOST/,
    'src/server/server.js no longer binds an ephemeral port on the loopback host');
  assert.equal(/process\.env/.test(read(SERVER_SOURCE)), false,
    'src/server/server.js reads the environment, so something could redirect the bind');

  // Configuration carries no bind address: the schema is closed, and a key that would
  // carry one is refused rather than ignored.
  assert.throws(() => validateConfig({ enrolled: [], host: '0.0.0.0' }), /unknown key/,
    'config.json would accept a host, so the bind address could be changed by configuration');
  assert.throws(() => validateConfig({ enrolled: [], bind: '0.0.0.0' }), /unknown key/,
    'config.json would accept a bind address');

  // The documents that say all of this.
  const note = section(PRIVACY, 'The dashboard');
  assert.match(note, /It binds to `127\.0\.0\.1` only/,
    'the privacy note no longer states that the dashboard binds to 127.0.0.1 only');
  assert.match(note, /The bind address cannot be changed through configuration/,
    'the privacy note no longer states that the bind address is not configurable');
  assert.match(note, /request arriving from a non-loopback address is refused rather than served/,
    'the privacy note no longer states that a non-loopback request is refused');
  assert.match(requirementText(PRD, 'RS-C11'), /binds to 127\.0\.0\.1 only/,
    'RS-C11 no longer states that the dashboard binds to 127.0.0.1 only');
});

// ---------------------------------------------------------------------------
// The method set (RS-SRV-C01, RS-C11).
// ---------------------------------------------------------------------------

test('only GET and HEAD are accepted: every other method is refused with an Allow header, and an over-long URL is refused', async (t) => {
  // Arrange: the real server over the real archive, with the view handler counted so a
  // refusal can be shown to happen before any page is read.
  const f = await dashboard(t, 'methods');
  const requirement = requirementText(FEATURE, 'RS-SRV-C01');
  assert.match(requirement, /answers only GET and HEAD/, 'RS-SRV-C01 no longer names the accepted method set');
  assert.match(requirement, /an Allow header/, 'RS-SRV-C01 no longer requires an Allow header on a refusal');
  // The two statuses are read out of the requirement's own prose rather than written
  // here, so a changed requirement changes what this test demands.
  const longStatus = /URL with (\d{3})/.exec(requirement)?.[1] ?? '';
  const methodStatus = /method with (\d{3})/.exec(requirement)?.[1] ?? '';
  assert.equal(longStatus, '414', `RS-SRV-C01 no longer states the over-long URL status; it states ${longStatus}`);
  assert.equal(methodStatus, '405', `RS-SRV-C01 no longer states the refused method status; it states ${methodStatus}`);

  // Act and assert: the two accepted methods, and HEAD's answer to the GET headers.
  const get = await request(f.server, '/');
  const head = await request(f.server, '/', { method: 'HEAD' });
  assert.equal(get.status, 200);
  assert.equal(head.status, 200, 'HEAD was not accepted on a route the router serves');
  assert.equal(head.body, '', 'HEAD answered with a body');
  assert.equal(head.headers.get('content-security-policy'), get.headers.get('content-security-policy'),
    'HEAD did not answer with the headers GET answers with');
  assert.equal(head.headers.get('content-type'), get.headers.get('content-type'),
    'HEAD did not answer with the content type GET answers with');
  assert.equal(f.viewCalls(), 2, 'the two accepted methods did not each reach the view exactly once');

  // Act and assert: every other method, refused with the Allow header and no view.
  // CONNECT is absent from this list on purpose: an HTTP/1.1 client that reads a
  // response to CONNECT treats it as a tunnel and drops the socket rather than handing
  // the status line back, so what it would show is the client's behaviour, not the
  // server's. The allowlist itself is read from the module for the same claim.
  const before = f.viewCalls();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    const refused = await rawRequest(f.server.url, '/', method);
    assert.equal(refused.status, Number(methodStatus), `${method} was not refused with ${methodStatus}`);
    assert.equal(refused.headers.get('allow'), 'GET, HEAD',
      `${method} carries no Allow header naming the accepted methods`);
    assert.match(refused.body, /Method not allowed/, `${method} was refused without saying so`);
    assert.equal(refused.headers.get('cache-control'), 'no-store', `${method} refusal is cacheable`);
    assert.equal(refused.headers.get('content-security-policy'), get.headers.get('content-security-policy'),
      `${method} refusal carries a different policy from the answers the server gives the methods it accepts`);
  }
  assert.equal(f.viewCalls(), before, 'a view ran for a refused method');

  // The allowlist itself, read from the module: six refused methods prove the set has no
  // room for another, but only the declaration shows the whole set at once. The Allow
  // header it answers with is checked against that same list rather than against a
  // string written here.
  const declaration = /const ALLOWED_METHODS = new Set\(\[([^\]]*)\]\)/.exec(read(SERVER_SOURCE));
  assert.ok(declaration !== null, 'src/server/server.js no longer declares its method allowlist as a Set literal');
  const accepted = [...(declaration[1] ?? '').matchAll(/'([A-Z]+)'/g)].map((match) => /** @type {string} */ (match[1]));
  assert.deepEqual(accepted, ['GET', 'HEAD'], 'the methods the server answers are not GET and HEAD and nothing else');

  // The over-long URL is refused before the router, so no page read it either.
  const long = await request(f.server, `/?pad=${'x'.repeat(DEFAULT_MAX_URL_LENGTH + 1)}`);
  assert.equal(long.status, Number(longStatus), 'an over-long URL was not refused with the documented status');
  assert.match(long.body, /Request URL too long/, 'the refusal does not say the URL was too long');
  assert.match(long.body, new RegExp(String(DEFAULT_MAX_URL_LENGTH)), 'the refusal does not name the limit it applied');
  assert.equal(f.viewCalls(), before, 'a view ran for an over-long URL');

  // The boundary is inclusive: a URL exactly at the limit is still served and one character
  // more is refused, so the limit is where the module says it is rather than one either
  // side of it. The probe is sent through `node:http` rather than `fetch`, which
  // normalises a path before it leaves the client and would move the boundary.
  const prefix = '?pad=';
  const atLimit = await rawRequest(f.server.url, `/${prefix}${'x'.repeat(DEFAULT_MAX_URL_LENGTH - prefix.length - 1)}`, 'GET');
  assert.equal(atLimit.status, 200,
    `a URL of exactly ${String(DEFAULT_MAX_URL_LENGTH)} characters was refused, so the limit is not where it is documented`);
  const pastLimit = await rawRequest(f.server.url, `/${prefix}${'x'.repeat(DEFAULT_MAX_URL_LENGTH - prefix.length)}`, 'GET');
  assert.equal(pastLimit.status, Number(longStatus),
    'a URL one character over the limit was not refused, so the limit is not where it is documented');
  assert.equal(f.viewCalls(), before + 1,
    'the request at the limit reached the view and the one character over it did not');

  assert.match(requirementText(PRD, 'RS-C11'), /answers GET and HEAD only/,
    'RS-C11 no longer states that the dashboard answers GET and HEAD only');
});

// ---------------------------------------------------------------------------
// Unauthenticated, and no credential reachable through the dashboard.
// ---------------------------------------------------------------------------

test('the dashboard is unauthenticated: no cookie, no challenge, and nothing it loads can read a credential', async (t) => {
  // Arrange: every answer the dashboard gives, header by header.
  const f = await dashboard(t, 'unauthenticated');
  const answers = await everyServedPage(f.server);
  const refused = await requestFromPeer('GET', '/', '198.51.100.23');
  answers.push({
    label: 'a non-loopback peer',
    pathname: '/',
    status: refused.status,
    headers: new Headers(refused.headers),
    body: refused.body,
  });

  // Assert: nothing in any answer asks the client to identify itself or stores
  // anything about the reader. The note's claim is that there is nothing to protect,
  // and these are the two headers that would carry such a thing.
  for (const answer of answers) {
    assert.equal(answer.headers.get('set-cookie'), null, `${answer.label}: the dashboard set a cookie`);
    assert.equal(answer.headers.get('www-authenticate'), null,
      `${answer.label}: the dashboard asked the client to authenticate`);
    assert.equal(answer.headers.get('authorization'), null,
      `${answer.label}: the dashboard sent an authorization header of its own`);
  }
  const stylesheet = answers[6];
  assert.ok(stylesheet !== undefined);
  assert.match(stylesheet.headers.get('content-security-policy') ?? '', /form-action 'none'/,
    'the policy no longer forbids submitting a form anywhere, which an unauthenticated page relies on');

  // Assert: no module the dashboard loads can read a credential. Every import under
  // `src/server/` is read, so a route added later cannot quietly import the store. The
  // redaction helper is the one credentials module allowed, and it exports redaction
  // rather than the token.
  const forbidden = /(?:\.\.\/)+(?:credentials\/(?!redact\.js)|github|config)\//;
  /** @type {string[]} */
  const credentialReaders = [];
  for (const file of javascriptFiles(path.join(ROOT, 'src', 'server'))) {
    for (const [, specifier] of read(file).matchAll(/from '([^']+)'/g)) {
      if (forbidden.test(specifier)) credentialReaders.push(`${path.relative(ROOT, file)} imports ${specifier}`);
    }
  }
  assert.deepEqual(credentialReaders, [],
    'a module the dashboard loads can reach the credential store, a configuration file or the GitHub client');
  assert.equal(read(SERVER_SOURCE).includes("from '../credentials/redact.js'"), true,
    'the server no longer redacts what it logs, so the redaction import allowance is unused');
  assert.equal(read(path.join(ROOT, 'src', 'credentials', 'redact.js')).includes('getToken'), false,
    'the redaction helper now reads the token, which the allowance above assumes it does not');

  // Assert: the documents that say so.
  const note = section(PRIVACY, 'The dashboard');
  assert.match(note, /It is unauthenticated because it is loopback-only/,
    'the privacy note no longer states that the dashboard is unauthenticated because it is loopback-only');
  assert.match(note, /no login, no session and no cookie/,
    'the privacy note no longer names the absence of a login, a session and a cookie');
  assert.match(note, /no credential is reachable through it/,
    'the privacy note no longer states that no credential is reachable through the dashboard');
  assert.match(section(PRIVACY, 'What is never collected'),
    /No account, no signup, no login, no session, no cookie/,
    'the privacy note no longer states that the dashboard collects no account, session or cookie');
  // The claim-to-file table names the module that enforces the policy, so that row
  // cannot point at a file that no longer holds it.
  const tableRow = read(PRIVACY).split('\n').find((line) => line.includes('`src/server/security.js`'));
  assert.ok(tableRow !== undefined, 'the privacy note no longer names src/server/security.js as enforcing a dashboard claim');
  assert.match(tableRow, /serves a restrictive policy/,
    'the row naming src/server/security.js no longer claims a restrictive policy');
  assert.equal(read(SECURITY_SOURCE).includes("script-src 'none'"), true,
    'src/server/security.js no longer holds the policy the privacy note names it as enforcing');
});

// ---------------------------------------------------------------------------
// The registry's three tables, and the router's own route table (RS-SRV-C04).
// ---------------------------------------------------------------------------

test('the registry mounts its pages and its one asset in front of the router, and the router serves nothing else from disk', async (t) => {
  // Arrange: the real server over the real archive.
  const f = await dashboard(t, 'mount-tables');
  const requirement = requirementText(FEATURE, 'RS-SRV-C04');
  assert.match(requirement, /mounts pages, paths and assets from three tables/,
    'RS-SRV-C04 no longer describes three tables');
  assert.match(requirement, /without extending the router's route table/,
    'RS-SRV-C04 no longer says the registry answers its own routes rather than extending the router\'s');

  // Assert: the three tables the requirement names are the three the module keeps, and
  // each one is the whole of what it is for.
  assert.deepEqual(Object.keys(VIEW_MOUNT_TABLE), [...VIEW_ROUTES],
    'the mount table and the route list name different routes, so a page is mounted for a route nobody dispatches');
  assert.deepEqual(VIEW_PATH_TABLE.map((entry) => entry.path), ['/health'],
    'the path table no longer mounts the collection health page at its own path');
  assert.deepEqual(VIEW_ASSET_TABLE.map((entry) => entry.path), [THEME_STYLESHEET_PATH],
    'the asset table no longer holds exactly the one stylesheet');

  // Assert: the registry answers its own routes in front of the router rather than the
  // router having learned them. The router's own source names neither path and knows
  // nothing about assets, so its route table is still the three routes its owner declared.
  const routerSource = read(ROUTER_SOURCE);
  for (const mounted of [...VIEW_PATH_TABLE.map((entry) => entry.path), ...VIEW_ASSET_TABLE.map((entry) => entry.path)]) {
    assert.equal(routerSource.includes(mounted), false,
      `src/server/router.js now names ${mounted}, so the router's route table was extended rather than mounted in front of it`);
  }
  assert.equal(routerSource.includes('assets'), false, 'src/server/router.js now knows about the asset directory');
  for (const route of ["'/'", "'/repos'", '/^\\/repo\\/([^/]+)\\/([^/]+)$/']) {
    assert.ok(routerSource.includes(route), `the router no longer answers ${route}`);
  }

  // Assert: all four are served, and the asset is the file on disk rather than a second
  // copy or a directory listing. The paths are the registry's own, so a path that moved
  // is a path this test reads rather than one written here.
  assert.equal(f.registry.healthPath, '/health', 'the registry no longer reports the path its health page is served from');
  assert.equal(f.registry.themePath, THEME_STYLESHEET_PATH,
    'the registry no longer reports the path the shell links its stylesheet to');
  const health = await request(f.server, f.registry.healthPath);
  assert.equal(health.status, 200, 'the health page the registry mounts is not served');
  const stylesheet = await request(f.server, f.registry.themePath);
  assert.equal(stylesheet.status, 200, 'the stylesheet the registry serves is not served');
  assert.equal(stylesheet.body, readFileSync(THEME_TOKEN_FILE, 'utf8'),
    'the served stylesheet is not the file src/ui/theme.css holds');

  // Assert: there is no static file server. A sibling of the stylesheet, the asset
  // directory itself, and files this repository holds all fall through to a 404.
  for (const pathname of ['/assets/other.css', '/assets/', '/src/paths.js', '/ui/theme.css', '/package.json']) {
    const answer = await request(f.server, pathname);
    assert.equal(answer.status, 404, `${pathname} was served; the dashboard has no static file server`);
  }

  // The document section the mount claim is published in.
  assert.match(section(FEATURE, '4. Command and Output Design'), /the local stylesheet/,
    'the feature document no longer says a served document links the local stylesheet');
});

// ---------------------------------------------------------------------------
// The window (RS-SRV-C04): a default, a kept bound, and a refusal in words.
// ---------------------------------------------------------------------------

test('a URL with no bound reads the default window ending today, a bound the URL carried is kept, and an inverted result is refused in words', async (t) => {
  // Arrange: the real server over the real archive.
  const f = await dashboard(t, 'window');
  const requirement = requirementText(FEATURE, 'RS-SRV-C04');
  assert.match(requirement, /defaults the window to the last fourteen days ending today/,
    'RS-SRV-C04 no longer states the default window');
  assert.match(requirement, /keeps a bound the URL carried/,
    'RS-SRV-C04 no longer states that a bound the URL carried is kept');
  assert.match(requirement, /refuses an inverted result in words rather than silently swapping the bounds/,
    'RS-SRV-C04 no longer states that an inverted result is refused in words');
  // The requirement spells the default window in words; the constant spells it in
  // digits. Translating the requirement's own figure here is what makes a changed
  // window fail rather than quietly becoming the new documented value.
  assert.equal(DEFAULT_WINDOW_DAYS, 14, 'the default window is no longer the fourteen days RS-SRV-C04 names');

  // Act and assert: no bound at all, so the registry's own default window answers. The
  // expected days are computed from the module's constant, so a changed window fails
  // here rather than being written into this file.
  const expectedFrom = new Date(Date.parse(`${PLAN.today}T00:00:00.000Z`) - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS)
    .toISOString().slice(0, 10);
  assert.equal(PLAN.from, expectedFrom, 'this fixture\'s window and the registry constant already disagree');
  assert.equal(PLAN.window.length, DEFAULT_WINDOW_DAYS,
    'the window this fixture derives is not the number of days the registry defaults to');
  const defaulted = await request(f.server, '/');
  assert.equal(defaulted.status, 200);
  assert.ok(defaulted.body.includes(`from ${PLAN.from} to ${PLAN.today}`),
    `a URL with no bound did not read the default window; it read ${JSON.stringify(defaulted.body.match(/Selected range:[^<]*/)?.[0])}`);

  // Act and assert: a bound the URL carried is kept exactly as it was given.
  const kept = await request(f.server, `/?from=${PLAN.boundary}&to=${PLAN.hole}`);
  assert.equal(kept.status, 200);
  assert.ok(kept.body.includes(`from ${PLAN.boundary} to ${PLAN.hole}`),
    `a bound the URL carried was not kept; the page read ${JSON.stringify(kept.body.match(/Selected range:[^<]*/)?.[0])}`);

  // Act and assert: both bounds given and inverted is refused by the router, in words,
  // naming both bounds rather than swapping them.
  const inverted = await request(f.server, `/?from=${PLAN.today}&to=${PLAN.from}`);
  assert.equal(inverted.status, 400, 'an inverted range was served rather than refused');
  assert.ok(inverted.body.includes('Inverted range'), 'the refusal does not say the range was inverted');
  assert.ok(inverted.body.includes(`from ${PLAN.today} is later than to ${PLAN.from}`),
    `the refusal does not name both bounds; it said ${JSON.stringify(inverted.body.match(/<p>[^<]*Inverted[^<]*<\/p>/)?.[0])}`);

  // Act and assert: a first day beyond today with no last day is the registry's own
  // inversion. It is refused in words on the page, and the bounds are not swapped to
  // make a window appear.
  const first = new Date(Date.parse(`${PLAN.today}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
  const refusedWindow = await request(f.server, `${detailPath(CHARTED)}?from=${first}`);
  assert.equal(refusedWindow.status, 200, 'a first day beyond today was refused at the socket rather than on the page');
  const refusal = /<p class="range-refusal"[^>]*>([^<]*)<\/p>/.exec(refusedWindow.body)?.[1];
  assert.ok(refusal !== undefined, 'the page refused nothing: an inverted window was rendered instead');
  const named = /No window covers (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(refusal);
  assert.ok(named, `the refusal does not name the window it refused: ${JSON.stringify(refusal)}`);
  const refusedFirstDay = /** @type {string} */ (named[1]);
  const refusedLastDay = /** @type {string} */ (named[2]);
  assert.equal(refusedFirstDay, first, 'the refusal does not name the first day the URL carried');
  assert.equal(refusedLastDay, PLAN.today, 'the refusal does not name the last day the window would have ended on');
  assert.ok(refusedFirstDay > refusedLastDay,
    'the refusal names a window that is not inverted, so the bounds were swapped somewhere');
});

// ---------------------------------------------------------------------------
// The state vocabulary (RS-AX-07, the health read, the health runbook).
// ---------------------------------------------------------------------------

test('every state word the health page prints is one the health read can return, and the health runbook names it', async (t) => {
  // Arrange: four archives, each in a state the health read reports differently, so the
  // page is rendered for every word it can print rather than for one convenient state.
  /** @type {Array<[string, DashboardFixture]>} */
  const fixtures = [
    ['every repository state', await dashboard(t, 'state-words-repositories', seedEveryState)],
    ['a home with nothing enrolled', await dashboard(t, 'state-words-empty', () => {})],
    ['a run that began and never closed', await dashboard(t, 'state-words-unclosed', (db, plan) => {
      appendRun(db, { id: 'run-open', startedAt: plan.runTwo });
    })],
    ['a run that closed with a failure', await dashboard(t, 'state-words-degraded-run', (db, plan) => {
      appendRun(db, { id: 'run-failed', startedAt: plan.runTwo });
      completeRun(db, 'run-failed', {
        closedAt: plan.recentAt, status: 'degraded', successCount: 1, failureCount: 1,
        requestCount: 5, durationMs: 800,
      });
    })],
  ];

  // Act: serve the health page for each and read the words it printed.
  /** @type {Set<string>} */
  const printed = new Set();
  /** @type {Set<string>} */
  const printedPhrases = new Set();
  /** @type {Set<string>} */
  const printedRunPhrases = new Set();
  for (const [label, fixture] of fixtures) {
    const page = await request(fixture.server, fixture.registry.healthPath);
    assert.equal(page.status, 200, `${label}: the health page was not served`);
    const attributes = [...page.body.matchAll(/\bdata-state="([^"]*)"/g)].map((match) => /** @type {string} */ (match[1]));
    assert.ok(attributes.length > 0, `${label}: the health page carries no state attribute for this scan to read`);
    for (const word of attributes) printed.add(word);
    for (const [, phrase] of page.body.matchAll(/<span class="state-word">([^<]*)<\/span>/g)) {
      printedPhrases.add(/** @type {string} */ (phrase));
    }
    const runReason = /<p class="run-state">Most recent recorded run: ([^<]*)<\/p>/.exec(page.body)?.[1] ?? '';
    assert.notEqual(runReason, '', `${label}: the health page states no run sentence`);
    printedRunPhrases.add(runReason.split(':')[0] ?? '');
  }

  // Assert: the page prints every word the read can return and no word it cannot. Both
  // directions matter - a page that stopped printing a state would leave it with no word
  // on it, and a page that printed a word of its own would be reporting a capability
  // the read does not have.
  assert.deepEqual([...printed].sort(), [...STATE_WORDS].sort(),
    'the words the health page printed are not exactly the health read\'s vocabulary: '
    + `${[...printed].sort().join(', ')} against ${[...STATE_WORDS].sort().join(', ')}`);
  for (const phrase of printedPhrases) {
    assert.ok(STATE_PHRASES.has(phrase) || RUN_WORDS.map(statePhrase).includes(phrase),
      `the health page announced the state "${phrase}", which is not a word the health read can return`);
  }
  assert.deepEqual([...printedRunPhrases].sort(), [...RUN_WORDS.map(statePhrase)].sort(),
    'the run sentence the health page printed is not one of the words the health read returns for a run');

  // Assert: every literal state the page's own module writes is a word the read can
  // return, so a branch added to the view cannot introduce an eighth word behind the
  // served pages' backs.
  for (const [, literal] of read(HEALTH_VIEW_SOURCE).matchAll(/data-state="([a-z-]+)"/g)) {
    assert.ok(STATE_WORDS.includes(/** @type {string} */ (literal)),
      `src/server/views/health.js writes data-state="${literal}", which the health read cannot return`);
  }

  // Assert: the health runbook names every word the page printed. The runbook is where
  // a reader matches a symptom to a cause, so a word on the page that the runbook does
  // not name is a symptom with no documented cause.
  const tables = runbookStateTables(sectionText(RUNBOOK, 'State words and what each one means'));
  const documented = new Set([...tables.repository, ...tables.run]);
  for (const word of printed) {
    assert.ok(documented.has(word),
      `the health page prints the state word ${word}, which docs/operations/troubleshooting.md does not name`);
  }
  for (const phrase of printedRunPhrases) {
    const word = RUN_WORDS.find((candidate) => statePhrase(candidate) === phrase);
    assert.ok(word !== undefined && documented.has(word),
      `the health page announces the run state "${phrase}", which the runbook does not name as a word`);
  }
  // Assert: every word the runbook names is one the read can return, so the runbook
  // cannot document a state the product does not have.
  for (const word of tables.repository) {
    assert.ok(/** @type {readonly string[]} */ (REPOSITORY_STATE_PRECEDENCE).includes(word),
      `docs/operations/troubleshooting.md names the repository state ${word}, which the health read cannot return`);
  }
  for (const word of tables.run) {
    assert.ok([...RUN_WORDS, SUMMARY_STATE_EMPTY].includes(word),
      `docs/operations/troubleshooting.md names the run word ${word}, which the health read cannot return`);
  }
  assert.equal(documented.size, STATE_WORDS.length + RUN_WORDS.length - 1,
    'the runbook names a different number of state words than the health read can return');
});

// ---------------------------------------------------------------------------
// The shape of a served document (feature document section 4).
// ---------------------------------------------------------------------------

test('every served document has one main landmark, a skip link first, and the footer stating loopback, no remote asset and no script', async (t) => {
  // Arrange: every document the registry and the router serve.
  const f = await dashboard(t, 'document-shape');
  /** @type {Array<[string, AnsweredPage]>} */
  const documents = [
    ['the index', await request(f.server, `/?${PLAN.query}`)],
    ['the repository list', await request(f.server, `/repos?${PLAN.query}`)],
    ['the detail page', await request(f.server, `${detailPath(CHARTED)}?${PLAN.query}`)],
    ['the health page', await request(f.server, '/health')],
    ['the unknown-repository refusal', await request(f.server, `${detailPath(UNKNOWN)}?${PLAN.query}`)],
    ['the inverted-range refusal', await request(f.server, `${detailPath(CHARTED)}?from=${PLAN.today}&to=${PLAN.from}`)],
  ];
  assert.deepEqual(documents.map(([, page]) => page.status), [200, 200, 200, 200, 404, 400],
    'the documents this test walks are not the documents it asked for');

  // The document's own claim, in the feature document's words.
  const design = section(FEATURE, '4. Command and Output Design');
  for (const phrase of ['a skip link as the first element', 'exactly one main landmark', 'the local stylesheet']) {
    assert.ok(design.includes(phrase), `docs/features/dashboard-server.md section 4 no longer claims ${phrase}`);
  }
  assert.match(design, /a footer stating that the page is served from loopback, loads no remote asset and runs no script/,
    'the feature document no longer describes the footer every served document carries');

  // Act and assert: for each document, the shell's own guarantees hold. The skip link is
  // compared with the one the shared helper renders rather than with a remembered
  // string, so the shell and the page cannot drift apart unnoticed.
  for (const [label, page] of documents) {
    const audit = auditDocument(page.body);
    assert.equal(audit.mainLandmarks, 1, `${label}: a served document carries ${audit.mainLandmarks} main landmarks`);
    assert.ok(audit.ids.includes('main'), `${label}: the main landmark has no id for the skip link to target`);
    assert.equal(audit.focusable[0]?.attributes.href, '#main',
      `${label}: the first focusable element is not the skip link`);
    assert.ok(page.body.includes(skipLink()), `${label}: the shell's own skip link is not on the page`);
    assert.equal(audit.lang, 'en', `${label}: the document declares no language`);
    assert.deepEqual(audit.titles.length, 1, `${label}: the document names no title, or names more than one`);
    assert.ok(audit.titles[0] !== '', `${label}: the document names an empty title`);
    assert.deepEqual(referencesOf(page.body).filter((reference) => reference === STYLESHEET_HREF),
      [STYLESHEET_HREF], `${label}: the document does not link exactly the one local stylesheet`);

    // The footer states the three claims in words rather than leaving them to the
    // headers, so a reader who reads the page is told what the page is.
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(page.body)?.[1];
    assert.ok(footer !== undefined, `${label}: the document carries no footer`);
    const words = footer.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    assert.match(words, /127\.0\.0\.1/, `${label}: the footer does not name the interface the page is served from`);
    assert.match(words, /remote asset/i, `${label}: the footer does not say the page loads no remote asset`);
    assert.match(words, /script/i, `${label}: the footer does not say the page runs no script`);
  }

  // The walkers this test used are proved sensitive against a document built to break
  // each rule, so a green walk above is not a walk that measures nothing.
  const broken = auditDocument('<html lang="en"><body><main id="main"><a href="/x">not a skip link</a></main>'
    + '<main id="second">a second landmark</main></body></html>');
  assert.equal(broken.mainLandmarks, 2, 'the landmark walk cannot see a second main landmark');
  assert.equal(broken.focusable[0]?.attributes.href, '/x',
    'the focusable walk cannot see that the skip link is no longer first');
});

// RS-C12: the contract suite the feature document's testing table promises is this
// file, so a renamed or deleted suite fails the promise rather than passing it.
test('the feature document names this contract task, and the file that answers it exists', () => {
  const strategy = section(FEATURE, '5. Testing Strategy');
  assert.match(strategy, /\| Contract \| Documented server claims against the implementation \|/,
    'docs/features/dashboard-server.md section 5 no longer has a contract row for the documented server claims');
  assert.match(strategy, /RS-SRV-CONTRACT-01/, 'the contract row no longer names the task that creates this suite');
  assert.ok(existsSync(fileURLToPath(import.meta.url)), 'this contract suite does not exist at the path it was run from');
  assert.match(requirementText(PRD, 'RS-C12'), /asserted by a named test file/,
    'RS-C12 no longer states the rule this suite exists to enforce');
});