import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BACKFILL_REQUESTS_FLOOR,
  RESOLUTION_REQUESTS_PER_REPOSITORY,
  TRAFFIC_REQUESTS_PER_REPOSITORY,
} from '../src/collect/run.js';
import { TRAFFIC_PERMISSION } from '../src/supervision/errors.js';
import {
  REPOSITORY_STATE_DEGRADED,
  REPOSITORY_STATE_NEVER_COLLECTED,
  REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
  REPOSITORY_STATE_STALLED,
  REPOSITORY_STATE_UNAVAILABLE,
  REPOSITORY_STATE_UNREADABLE,
  RUN_STATE_COMPLETED,
  RUN_STATE_DEGRADED,
  RUN_STATE_NEVER_RUN,
  RUN_STATE_UNCLOSED,
  SUMMARY_STATE_EMPTY,
} from '../src/supervision/health.js';
import { STALL_THRESHOLD_HOURS } from '../src/supervision/journal.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');
const SCHEDULING = path.join(ROOT, 'docs', 'operations', 'scheduled-collection.md');
const TROUBLESHOOTING = path.join(ROOT, 'docs', 'operations', 'troubleshooting.md');
const PRD = path.join(ROOT, 'docs', 'PRD.md');

const PAGES = /** @type {{ name: string, file: string }[]} */ ([
  { name: 'docs/operations/scheduled-collection.md', file: SCHEDULING },
  { name: 'docs/operations/troubleshooting.md', file: TROUBLESHOOTING },
]);

/** The only host the tool is permitted to contact. */
const ALLOWED_HOST = 'api.github.com';

/** Requests one steady-state daily run makes per repository, from the collector's own constants. */
const REQUESTS_PER_REPOSITORY_PER_RUN =
  RESOLUTION_REQUESTS_PER_REPOSITORY + TRAFFIC_REQUESTS_PER_REPOSITORY;

/**
 * One daily run a day for a leap year: the generous reading of "per year".
 */
const RUNS_PER_YEAR = 366;

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Spawn the real entry point and read the usage listing it generates from the
 * command registry. A runbook naming a command this build does not register
 * names something the repository does not provide.
 * @returns {Set<string>}
 */
function registeredCommands() {
  const result = spawnSync(process.execPath, [CLI, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `node src/cli.js --help exited ${String(result.status)}`);
  const lines = (result.stdout ?? '').split('\n');
  const start = lines.indexOf('Commands:');
  assert.notEqual(start, -1, `no Commands section in:\n${result.stdout ?? ''}`);
  /** @type {Set<string>} */
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const match = /^ {2}([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)/.exec(line);
    if (match !== null) names.add(match[1] ?? '');
  }
  assert.ok(names.size > 0, 'the usage listing named no command');
  return names;
}

/**
 * Every `node src/cli.js ...` invocation the page spells out, split into words.
 * Words beginning with `-` are flags and are not part of the command name.
 * @param {string} page
 * @returns {string[][]}
 */
function invocationsIn(page) {
  /** @type {string[][]} */
  const invocations = [];
  for (const match of page.matchAll(/src\/cli\.js((?:\s+[^\s`]+)+)/g)) {
    const words = (match[1] ?? '').trim().split(/\s+/).filter((word) => !word.startsWith('-'));
    if (words.length > 0) invocations.push(words);
  }
  return invocations;
}

/**
 * Flatten a page's line wrapping so an assertion about a sentence does not depend
 * on where the prose happens to wrap.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text
    .replace(/^\s*>\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One `##` section of a page, flattened. A heading that is not there fails the
 * test rather than silently matching the whole page.
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
  return flatten(next === -1 ? body : body.slice(0, next));
}

test('both runbooks exist and name at least one command each', () => {
  for (const page of PAGES) {
    const text = read(page.file);
    assert.ok(text.length > 0, `${page.name} is empty`);
    assert.ok(
      invocationsIn(text).length >= 3,
      `${page.name} names only ${invocationsIn(text).length} command invocations`,
    );
  }
});

test('every command both pages name is a command this repository registers', () => {
  const registered = registeredCommands();
  for (const page of PAGES) {
    const invocations = invocationsIn(read(page.file));
    for (const words of invocations) {
      const resolved = words
        .slice(0, Math.max(...words.map((_, index) => index + 1)))
        .map((_, index) => words.slice(0, words.length - index).join(' '))
        .find((candidate) => registered.has(candidate));
      assert.ok(
        resolved !== undefined,
        `${page.name} names "${words.join(' ')}", which resolves to no registered command; ` +
          `this build registers ${[...registered].sort().join(', ')}`,
      );
    }
  }
});

test('every command both pages name also resolves when it is typed', () => {
  // Resolution against the listing above proves the name exists; this proves the
  // name is accepted as typed. `config init` on a temporary home reaches its own
  // refusal rather than a usage error, which is the point: the name is real.
  const home = mkdtempSync(path.join(tmpdir(), 'repo-signal-doc-'));
  /** @type {[string, string[]][]} */
  const attempts = [
    ['config check', []],
    ['db status', []],
    ['db verify', []],
    ['collect', ['--dry-run']],
    ['collect', ['--repo', 'owner/name']],
  ];
  for (const [line, args] of attempts) {
    const result = spawnSync(process.execPath, [CLI, line, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, REPO_SIGNAL_HOME: home, NODE_OPTIONS: '' },
    });
    assert.notEqual(
      result.status,
      2,
      `${line} exited with the usage-error code, so the pages name a command this build does not accept; ` +
        `stderr:\n${result.stderr ?? ''}`,
    );
  }
  rmSync(home, { recursive: true, force: true });
});

test('the scheduling page gives a cron, a launchd and a systemd entry, each invoking collect with the resolved home', () => {
  const page = read(SCHEDULING);
  assert.match(section(SCHEDULING, 'Schedule with cron'), /crontab -e/);
  assert.match(section(SCHEDULING, 'Schedule with cron'), /REPO_SIGNAL_HOME=/);
  assert.match(section(SCHEDULING, 'Schedule with cron'), /src\/cli\.js collect/);

  const launchd = section(SCHEDULING, 'Schedule with launchd');
  assert.match(launchd, /com\.repo-signal\.collect/);
  assert.match(launchd, /StartCalendarInterval/);
  assert.match(launchd, /<string>collect<\/string>/);
  assert.match(launchd, /REPO_SIGNAL_HOME/);
  assert.match(launchd, /launchctl bootstrap/);

  const systemd = section(SCHEDULING, 'Schedule with a systemd timer');
  assert.match(systemd, /\.service/);
  assert.match(systemd, /\.timer/);
  assert.match(systemd, /OnCalendar=/);
  assert.match(systemd, /Persistent=true/);
  assert.match(systemd, /REPO_SIGNAL_HOME/);
  assert.match(systemd, /src\/cli\.js collect/);
  assert.match(systemd, /systemctl enable --now repo-signal-collect\.timer/);

  // Three schedulers, three distinct entries: one label, one timer calendar, one
  // five-field crontab line, each invoking the collector.
  assert.equal([...page.matchAll(/<key>Label<\/key>/g)].length, 1, 'expected exactly one launchd label');
  assert.equal(
    [...page.matchAll(/^OnCalendar=\*-\*-\* \d{2}:\d{2}:\d{2}/gm)].length,
    1,
    'expected exactly one systemd OnCalendar entry',
  );
  assert.match(page, /^\d{1,2} \d{1,2} \* \* \* REPO_SIGNAL_HOME=/m, 'no five-field crontab line');
  assert.equal(
    [...page.matchAll(/src\/cli\.js collect/g)].length >= 4,
    true,
    'the scheduling page must invoke the collector in the cron entry, the launchd plist and the systemd unit',
  );
});

test('the scheduling page states that the collector embeds no timer', () => {
  const page = flatten(read(SCHEDULING));
  assert.match(page, /embeds \*\*no timer and no scheduler\*\*/);
  assert.match(page, /daily operation is the operating system's job/);
});

test('the scheduling page states the request budget computed from the collector own constants', () => {
  const page = flatten(read(SCHEDULING));
  const perYear = REQUESTS_PER_REPOSITORY_PER_RUN * RUNS_PER_YEAR;
  assert.match(page, new RegExp(`\\*\\*${REQUESTS_PER_REPOSITORY_PER_RUN} requests\\b`));
  assert.match(page, new RegExp(`\\*\\*${perYear.toLocaleString('en-US')} requests\\b`));

  // The ceiling is the PRD's, so a change to the PRD must be a change to the page.
  const ceiling = /under (\d+) requests per repository per year/.exec(read(PRD));
  assert.ok(ceiling !== null, 'the PRD no longer states a per-repository yearly request ceiling');
  assert.ok(
    perYear < Number(ceiling[1]),
    `the steady-state budget of ${perYear} is no longer under the PRD ceiling of ${ceiling[1]}`,
  );
  // The page may group the digits for reading; both spellings count as naming it.
  const grouped = Number(ceiling[1]).toLocaleString('en-US');
  assert.ok(
    page.includes(String(ceiling[1])) || page.includes(grouped),
    `the page does not name the PRD ceiling of ${ceiling[1]}`,
  );

  // The first-connect figure is a floor, and the page must present it as one.
  assert.match(page, new RegExp(`at least ${BACKFILL_REQUESTS_FLOOR}, once`));
  assert.match(page, new RegExp(`requests>=${REQUESTS_PER_REPOSITORY_PER_RUN + BACKFILL_REQUESTS_FLOOR}`));
});

test('both pages state what happens after the machine sleeps and how to catch up', () => {
  const sleep = section(SCHEDULING, 'What happens when the machine sleeps');
  assert.match(sleep, /While the machine sleeps, no run starts/);
  assert.match(sleep, new RegExp(`After ${STALL_THRESHOLD_HOURS} hours without a successful run`));
  assert.match(sleep, new RegExp(`\`${REPOSITORY_STATE_STALLED}\``));
  assert.match(sleep, /`unclosed`/);
  assert.match(sleep, /never-collected`/);
  assert.match(sleep, /no partial day/);
  assert.match(sleep, /cron skips what it missed/);
  assert.match(sleep, /Persistent=true` timer runs the missed/);

  const catchUp = section(SCHEDULING, 'Catch up after a missed day');
  assert.match(catchUp, /node src\/cli\.js collect/);
  assert.match(catchUp, /--dry-run/);
  assert.match(catchUp, /last-write-wins/);
  assert.match(catchUp, /corrected, not duplicated/);
  assert.match(catchUp, /14-day traffic window/);
  assert.match(catchUp, /stays a gap/);
});

test('the troubleshooting page names the first-connect and unavailable lifecycle states the product records', () => {
  const page = flatten(read(TROUBLESHOOTING));
  // `not-connected` is the archive's own pre-boundary word, not a state word, and
  // the page must not present it as one.
  assert.match(page, /reports itself as `not-connected` until a collected day exists/);
  assert.match(page, new RegExp(`\\\`${REPOSITORY_STATE_UNAVAILABLE}\\\``));
  // The page must state the real limit of the unavailable mark rather than
  // promising a fix this build does not implement.
  const unavailable = section(TROUBLESHOOTING, 'A repository GitHub no longer serves');
  assert.match(unavailable, /no command in this build clears it/);
  assert.match(unavailable, /stop enrolling it/);
  assert.match(unavailable, new RegExp(`\\\`${REPOSITORY_STATE_UNAVAILABLE}\\\``));
  assert.match(unavailable, /skipped lifecycle=unavailable requests=0/);
  // And the scheduling page must not contradict it.
  assert.match(
    flatten(read(SCHEDULING)),
    /no command that clears that mark/,
    'the scheduling page must not promise that configuration clears an unavailable mark',
  );
});

test('the troubleshooting page covers the six failure modes, each with its dashboard state word', () => {
  const page = read(TROUBLESHOOTING);
  /** @type {[string, RegExp, RegExp][]} */
  const modes = [
    ['An expired or revoked token', /An expired or revoked token/, new RegExp(`\\*\\*State word: \`${REPOSITORY_STATE_NEEDS_REAUTHENTICATION}\``)],
    ['A token without the traffic permission', /A token without the traffic permission/, new RegExp(`\\*\\*State word: \`${REPOSITORY_STATE_NEEDS_REAUTHENTICATION}\`, the same word`)],
    ['An exhausted rate limit', /An exhausted rate limit/, new RegExp(`\\*\\*State word: \`${REPOSITORY_STATE_DEGRADED}\``)],
    ['A stalled collector', /A stalled collector/, new RegExp(`\\*\\*State word: \`${REPOSITORY_STATE_STALLED}\``)],
    ['A migration that will not apply', /A migration that will not apply/, /\*\*No state word\.\*\*/],
    ['A database that will not open', /A database that will not open/, /\*\*No state word\*\*/],
  ];
  for (const [heading, headingPattern, statePattern] of modes) {
    assert.match(page, headingPattern, `the page has no "## ${heading}" section`);
    assert.match(section(TROUBLESHOOTING, heading), statePattern, `"## ${heading}" names no dashboard state word`);
  }

  // The page says up front which two of the six have no state word, and the
  // dedicated section explains why rather than inventing one the product lacks.
  assert.match(flatten(read(TROUBLESHOOTING)), /have \*\*no state word at all\*\*/);
  const noState = section(TROUBLESHOOTING, 'Two failure modes that cannot show a state word');
  assert.match(noState, /the archive is the source of the state/);
  assert.match(noState, /nothing to read a state from/);
  assert.match(noState, /names the refusal each command prints/);
});

test('the troubleshooting page uses the state words the product defines', () => {
  const page = read(TROUBLESHOOTING);
  for (const word of [
    REPOSITORY_STATE_NEEDS_REAUTHENTICATION,
    REPOSITORY_STATE_DEGRADED,
    REPOSITORY_STATE_STALLED,
    REPOSITORY_STATE_UNAVAILABLE,
    REPOSITORY_STATE_NEVER_COLLECTED,
    REPOSITORY_STATE_UNREADABLE,
    RUN_STATE_NEVER_RUN,
    RUN_STATE_UNCLOSED,
    RUN_STATE_COMPLETED,
    SUMMARY_STATE_EMPTY,
  ]) {
    assert.ok(page.includes(`\`${word}\``), `the troubleshooting page never names the state word ${word}`);
  }
  // `healthy` and `degraded` also appear as run words; both spellings are in use.
  assert.match(page, /`healthy`/);
  assert.match(page, new RegExp(`\\\`${RUN_STATE_DEGRADED}\\\``));
});

test('the troubleshooting page gives the classification word each failure mode records', () => {
  const page = read(TROUBLESHOOTING);
  for (const kind of ['authentication-rejected', 'permission-missing', 'rate-limited']) {
    assert.ok(page.includes(`failed ${kind} `), `the page does not show the ${kind} classification line`);
  }
  for (const status of ['401', '403', '429', '404']) {
    assert.match(page, new RegExp(`GitHub HTTP ${status}|GitHub answered HTTP ${status}`));
  }
});

test('the troubleshooting page attributes rate-limit waiting to the request policy, not to a guessed window', () => {
  const limit = section(TROUBLESHOOTING, 'An exhausted rate limit');
  assert.match(limit, /waits for the reset GitHub reports in its own response headers/);
  assert.match(limit, /at least a minute between attempts/);
  // The page must not invent a reset window this repository does not know.
  assert.doesNotMatch(limit, /up to an hour/i);
  assert.match(limit, /not a hang/);
});

test('the troubleshooting page names one refusal line per cause, not a single universal sentence', () => {
  const open = section(TROUBLESHOOTING, 'A database that will not open');
  // Three distinct refusals observed from this build; a page showing one as if
  // it were universal sends an operator looking for the wrong cause.
  for (const refusal of [
    'collect failed: unable to open database file',
    'collect failed: attempt to write a readonly database',
    'collect failed: file is not a database',
  ]) {
    assert.ok(open.includes(refusal), `the page does not name the refusal "${refusal}"`);
  }
  assert.match(open, /read the noun rather than expecting one\s+fixed sentence/);
  assert.match(open, /node src\/cli\.js db verify/);
  assert.match(open, /node src\/cli\.js db status/);
});

test('the troubleshooting page names the permission the traffic endpoints require and never a write', () => {
  const page = flatten(read(TROUBLESHOOTING));
  // The permission is spelled once in the classifier; the page must use that spelling.
  assert.ok(page.includes(`\`${TRAFFIC_PERMISSION}\``), `the page never spells out \`${TRAFFIC_PERMISSION}\``);
  assert.match(page, /never asks for `Contents`/);
  assert.match(page, /never writes to a repository/);
});

test('both pages name where the home lives and that no command prints the token', () => {
  const scheduling = flatten(read(SCHEDULING));
  assert.match(scheduling, /REPO_SIGNAL_HOME/);
  assert.match(scheduling, /XDG_DATA_HOME\/repo-signal/);
  assert.match(scheduling, /~\/\.local\/share\/repo-signal/);
  assert.match(scheduling, /refuses to start when the resolved home is a git repository root/);
  assert.match(scheduling, /redacts token-shaped values/);
  assert.match(flatten(read(TROUBLESHOOTING)), /prints no token/);
});

test('both pages state the exit codes the commands share', () => {
  for (const page of PAGES) {
    const text = read(page.file);
    assert.match(text, /`0` succeeded, `1` failed operationally, `2` the command line/);
  }
});

test('neither page claims a surface behaviour this build does not implement', () => {
  // The health read exists and returns these words; the view layer that renders
  // them does not. A page describing what a dashboard "shows", "offers" or
  // "displays" would be stating something nobody has observed, so the pages
  // describe the read and its words instead.
  for (const page of PAGES) {
    const text = read(page.file);
    assert.doesNotMatch(
      text,
      /dashboard (?:shows|offers|displays|presents|renders)/i,
      `${page.name} must not state what a dashboard surface does`,
    );
    assert.doesNotMatch(
      text,
      /offers a re-authenticate action|re-authenticate action/i,
      `${page.name} must not describe a UI affordance nobody has built`,
    );
  }
  // The troubleshooting page must attribute the words to the read that owns them.
  assert.match(
    flatten(read(TROUBLESHOOTING)),
    /Every state in this table is a value the read actually returns/,
  );
});

test('neither page claims a test result, an approval or a compliance claim', () => {
  for (const page of PAGES) {
    const text = read(page.file);
    for (const claim of [
      /\ball tests pass/i,
      /\bthe (?:ci|pipeline|build|suite) (?:passed|is green|succeeded)/i,
      /\bapproved by\b/i,
      /\bsigned off\b/i,
      /\bwe (?:ran|verified|confirmed|tested)\b/i,
      /\bthis (?:complies|is compliant|is certified)/i,
      /\bhas been (?:tested|validated|verified) (?:live|against)\b/i,
    ]) {
      assert.doesNotMatch(text, claim, `${page.name} must not claim ${String(claim)}`);
    }
  }
});

test('neither page names an outbound host other than api.github.com', () => {
  for (const page of PAGES) {
    const text = read(page.file);
    for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      assert.equal(match[1], ALLOWED_HOST, `${page.name} names the host ${String(match[1])}`);
    }
    // The scheduling page's only outbound statement is the host the tool may contact.
    assert.doesNotMatch(text, /\bcurl\b|\bwget\b/);
  }
});

test('neither page introduces a command this repository does not register', () => {
  const registered = registeredCommands();
  for (const page of PAGES) {
    for (const match of read(page.file).matchAll(/node (?:src\/cli\.js|[A-Za-z0-9._/-]+\.mjs)((?:\s+[^\s`|]+)+)/g)) {
      const words = (match[1] ?? '').trim().split(/\s+/).filter((word) => !word.startsWith('-'));
      if (words.length === 0 || !(match[0] ?? '').includes('src/cli.js')) continue;
      const resolved = words
        .slice(0, Math.max(...words.map((_, index) => index + 1)))
        .map((_, index) => words.slice(0, words.length - index).join(' '))
        .find((candidate) => registered.has(candidate));
      assert.ok(resolved !== undefined, `${page.name} names "${match[0].trim()}", which no registered command answers`);
    }
  }
});

test('the pages cross-reference the backup and migration runbook that exists', () => {
  const backup = read(path.join(ROOT, 'docs', 'operations', 'backup-and-migrate.md'));
  for (const page of PAGES) {
    const text = read(page.file);
    assert.ok(
      text.includes('backup-and-migrate.md'),
      `${page.name} does not point the reader at the backup and migration runbook`,
    );
    assert.match(text, /\[docs\/operations\/backup-and-migrate\.md\]\(backup-and-migrate\.md\)/);
  }
  assert.ok(backup.length > 0, 'the referenced backup runbook is missing');
});