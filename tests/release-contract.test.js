import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CREDENTIAL_FILE_MODE } from '../src/credentials/store.js';
import {
  CONFIG_FILE_NAME,
  CREDENTIALS_FILE_NAME,
  DATABASE_FILE_NAME,
  HOME_DIRECTORY_MODE,
} from '../src/paths.js';
import { LOOPBACK_HOST } from '../src/server/server.js';
import { TRAFFIC_PERMISSION } from '../src/supervision/errors.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');
const README = path.join(ROOT, 'README.md');
const LICENSE = path.join(ROOT, 'LICENSE');
const PRIVACY = path.join(ROOT, 'docs', 'operations', 'privacy.md');

const DOCUMENTS = /** @type {{ name: string; file: string }[]} */ ([
  { name: 'README.md', file: README },
  { name: 'docs/operations/privacy.md', file: PRIVACY },
]);

/** The only host the tool is permitted to contact, and the only host these documents may name. */
const ALLOWED_HOST = 'api.github.com';

/** The loopback base a test enables explicitly; never reachable without that gate. */
const LOOPBACK_TEST_HOST = '127.0.0.1';

/**
 * Commands a document may name before their own task has run. Each value is the
 * sentence the document has to carry in that case, so the gap stays visible
 * instead of the assertion quietly accepting any unregistered name.
 */
const PENDING_COMMANDS = new Map([
  ['serve', 'does not include `serve`'],
]);

/**
 * Phrasings that would state an observation nobody made. A document that needs
 * a result to be useful names where the result is recorded instead.
 */
const UNOBSERVED_CLAIMS = /** @type {RegExp[]} */ ([
  /\ball tests pass/i,
  /\bthe (?:ci|pipeline|build|suite|tests?) (?:passed|is green|succeeded)/i,
  /\bapproved by\b/i,
  /\bsigned off\b/i,
  /\bwe (?:ran|verified|confirmed|tested|audited)\b/i,
  /\bthis (?:complies|is compliant|is certified|is audited)\b/i,
  /\bhas been (?:tested|validated|verified|reviewed) (?:live|against)\b/i,
  /\b(?:posture|live integration|soak) review (?:is|was|has been) (?:complete|completed|recorded|approved|done)\b/i,
  /\bis (?:legal|financial) advice\b/i,
  /\bwe (?:are|hold) no (?:liability|obligation)\b/i,
]);

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Flatten a document's line wrapping so an assertion about a sentence does not
 * depend on where the prose happens to wrap.
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One `##` section of a document, flattened. A heading that is not there fails
 * the test rather than silently matching the whole document.
 * @param {string} file
 * @param {string} heading Heading text without its `## `.
 * @returns {string}
 */
function section(file, heading) {
  const text = read(file);
  const marker = `## ${heading}\n`;
  assert.ok(text.includes(marker), `${path.basename(file)} has no "## ${heading}" section`);
  const body = text.slice(text.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return flatten(next === -1 ? body : body.slice(0, next));
}

/**
 * Spawn the real entry point and read the usage listing it generates from the
 * command registry, which is the only authority on which commands a build has.
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
 * Every `node src/cli.js ...` invocation a document spells out, split into
 * words. Words beginning with `-` are flags and are not part of the name.
 *
 * One invocation per line: a fenced block lists commands on consecutive lines,
 * and a pattern that runs past the newline would read five commands as one
 * unresolvable name.
 * @param {string} text
 * @returns {string[][]}
 */
function invocationsIn(text) {
  /** @type {string[][]} */
  const invocations = [];
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/src\/cli\.js((?: +[^\s`]+)+)/g)) {
      const words = (match[1] ?? '').trim().split(/ +/).filter((word) => !word.startsWith('-'));
      if (words.length > 0) invocations.push(words);
    }
  }
  return invocations;
}

/**
 * The longest registered prefix of a typed command line, or undefined when no
 * prefix is registered.
 * @param {string[]} words
 * @param {Set<string>} registered
 * @returns {string | undefined}
 */
function resolveTyped(words, registered) {
  for (let length = words.length; length >= 1; length -= 1) {
    const candidate = words.slice(0, length).join(' ');
    if (registered.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Every path git is tracking, so "no credential or database file is committed"
 * is answered by the index rather than by a filename convention.
 * @returns {string[]}
 */
function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `git ls-files exited ${String(result.status)}: ${result.stderr ?? ''}`);
  const listing = result.stdout ?? '';
  assert.notEqual(listing, '', 'git ls-files tracked nothing, so the hygiene assertions would be vacuous');
  return listing.split('\0').filter((entry) => entry !== '');
}

/**
 * @param {string} directory Absolute path.
 * @returns {string[]} Repository-relative paths of the `.js` files inside it.
 */
function javascriptFilesIn(directory) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) found.push(path.relative(ROOT, entryPath));
    }
  }
  return found.sort();
}

/** @param {number} mode @returns {string} Octal with four digits, the way refusals print it. */
function octal(mode) {
  return mode.toString(8).padStart(4, '0');
}

/** @param {number} mode @returns {string} Octal with three digits, as an operator would write it. */
function shortOctal(mode) {
  return mode.toString(8).padStart(3, '0');
}

/** A backtick, spelled this way so a template literal can interpolate one. */
const TICK = String.fromCharCode(96);

test('the README, the licence and the privacy note all exist and are not stubs', () => {
  for (const document of [...DOCUMENTS, { name: 'LICENSE', file: LICENSE }]) {
    assert.ok(statSync(document.file).isFile(), `${document.name} is not a file`);
    const text = read(document.file);
    assert.ok(text.length > 400, `${document.name} is ${text.length} characters, which is a stub`);
  }
  // The README kept the project's name and heading level a reader lands on.
  assert.match(read(README), /^# RepoSignal$/m);
});

test('the README states that a clone is not adoption and that no history is fabricated', () => {
  const readme = flatten(read(README));
  // The sentence a friendlier introduction would drop first.
  assert.match(readme, /\*\*A clone is not adoption\.\*\*/, 'the README no longer states that a clone is not adoption');
  assert.match(readme, /never calls it adoption/, 'the README must say the tool never calls a clone adoption');
  assert.match(readme, /does not tell you who ran your code/, 'the README must say what a clone does not prove');
  // The no-fabrication statement, in the words the requirement uses.
  assert.match(readme, /\*\*It fabricates no history\.\*\*/, 'the README no longer states that it fabricates no history');
  assert.match(readme, /never written as `0`, never interpolated between its neighbours, never carried forward/);
  assert.match(readme, /leaves the gaps as gaps/);
  assert.match(
    readme,
    /no adoption score, no composite ranking, no anomaly claim and no threshold/,
    'the README must state that the product emits no score, ranking, anomaly or threshold verdict',
  );
});

test('the README states that GitHub traffic data is GitHub aggregate data and may not be redistributed', () => {
  const readme = flatten(read(README));
  assert.match(
    readme,
    /\*\*GitHub's repository traffic data is GitHub's aggregate data\. This archive may not be redistributed\.\*\*/,
    'the README must state both halves of the data statement: whose data it is, and that it may not be redistributed',
  );
  assert.match(readme, /Do not publish an archive file/, 'the redistribution statement must be actionable');
  assert.match(readme, /RepoSignal itself performs no export, publish or share action/);
  // The same statement belongs in the licence file, because the licence grants
  // no right in the data.
  assert.match(flatten(read(LICENSE)), /may not be redistributed/);
});

test('the README names the permission the traffic endpoints require and no write permission', () => {
  const readme = flatten(read(README));
  assert.ok(
    readme.includes(`\`${TRAFFIC_PERMISSION}\``),
    `the README never spells out \`${TRAFFIC_PERMISSION}\`, the permission the product asks for`,
  );
  assert.match(readme, /`Contents` is not required and is never requested/);
  assert.match(readme, /\*\*It performs no write\.\*\*/, 'the README must state the token is used for reads only');
  assert.match(readme, /It performs no write\./);
  assert.match(readme, /never creates an issue, pull request, comment, release or star/);
  // The privacy note names the same permission, so the two documents cannot disagree.
  assert.ok(
    flatten(read(PRIVACY)).includes(`\`${TRAFFIC_PERMISSION}\``),
    'the privacy note does not spell out the required permission',
  );
});

test('the README names the supported Node range and it is the range package.json declares', () => {
  const metadata = JSON.parse(read(path.join(ROOT, 'package.json')));
  const range = /** @type {string} */ (metadata.engines?.node);
  assert.match(range, /^>=\d+\.\d+\.\d+$/, `engines.node is ${range}, which the test cannot read as a floor`);
  const floor = /** @type {string} */ (/^>=(\d+\.\d+\.\d+)$/.exec(range)?.[1]);
  const readme = flatten(read(README));
  assert.ok(readme.includes(range), `the README does not name the declared range ${range}`);
  assert.ok(readme.includes(floor), `the README does not name the supported floor ${floor}`);
  // The floor is a storage requirement, so the README has to say why, and the
  // PRD's recorded floor has to agree with the manifest rather than drift from it.
  assert.match(readme, /`enableDefensive`/, 'the README must say why the floor is a floor');
  const prd = flatten(read(path.join(ROOT, 'docs', 'PRD.md')));
  assert.ok(
    prd.includes(`${floor} or later`),
    `the PRD no longer records ${floor} as the supported floor, so the engine range has moved without a note`,
  );
});

test('the README names the home directory, its resolution order, its mode and the three files it holds', () => {
  const where = section(README, 'Where everything lives');
  assert.match(where, /`REPO_SIGNAL_HOME`/);
  assert.match(where, /`XDG_DATA_HOME\/repo-signal`/);
  assert.match(where, /`~\/\.local\/share\/repo-signal`/);
  assert.ok(
    where.includes(`mode ${TICK}${octal(HOME_DIRECTORY_MODE)}${TICK}`),
    `the README does not name the home directory mode ${octal(HOME_DIRECTORY_MODE)}`,
  );
  for (const name of [CONFIG_FILE_NAME, CREDENTIALS_FILE_NAME, DATABASE_FILE_NAME]) {
    assert.ok(where.includes(`\`${name}\``), `the README does not name ${name} as a file in the home`);
  }
  assert.match(where, /\*\*The archive lives at `archive\.sqlite3` inside that home directory\*\*/);
  assert.match(where, /refuses to start when the resolved home is a git repository root/);
  assert.match(where, /no state path outside the home exists/);

  // The credential mode is the product's own constant, not a number a writer chose.
  const token = section(README, 'The token');
  assert.ok(
    token.includes(`mode ${TICK}${octal(CREDENTIAL_FILE_MODE)}${TICK}`),
    `the README does not name the required credential mode ${octal(CREDENTIAL_FILE_MODE)}`,
  );
  assert.match(token, /refuses to read the file at any other mode/);
});

test('the README documents a clone-and-run path and introduces no build step', () => {
  const install = section(README, 'Install and run: clone and go');
  assert.match(install, /There is no install step/);
  assert.match(install, /git clone/);
  assert.match(install, /node src\/cli\.js --help/);
  assert.match(install, /declares no\s+`dependencies` entry at all/);
  // A build step is a product regression, not a documentation choice, so the
  // words that would introduce one are refused in the whole document.
  for (const forbidden of [/\bnpm run build\b/, /\bnpm run compile\b/, /\bwebpack\b/, /\bvite\b/, /\besbuild\b/, /\brollup\b/]) {
    assert.doesNotMatch(read(README), forbidden, `the README introduces ${String(forbidden)}`);
  }
  assert.match(flatten(read(README)), /No build step\./);
});

test('the README names every registered command once and states which are runtime', () => {
  const commands = section(README, 'The registered commands');
  const registered = registeredCommands();
  assert.match(commands, /`node src\/cli\.js collect`/, 'the README does not document the collector');
  assert.match(commands, /`node src\/cli\.js serve`/, 'the README does not document the dashboard command');
  assert.match(commands, /`node src\/cli\.js report`/, 'the README does not document the report command');
  // The authority for what a build has is the registry, not this page.
  assert.match(commands, /--help` is the authority on which of them your build registers/);
  assert.match(commands, /no timer and no scheduler/);
  // Three runtime commands: the README says how many, and names exactly those three as runtime.
  assert.match(commands, /Three of the registered commands are the runtime/);

  // Every command the registry registers is listed exactly once in the inventory,
  // and every command the README documents is registered - neither side may drift.
  const inventory = inSection(read(README), 'The registered commands');
  for (const name of registered) {
    const occurrences = inventory.split(`node src/cli.js ${name}`).length - 1;
    assert.equal(occurrences, 1, `the README lists "${name}" ${occurrences} times in the inventory`);
  }
  for (const match of inventory.matchAll(/node src\/cli\.js ([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)/g)) {
    const words = (match[1] ?? '').split(' ');
    const name = resolveTyped(words, registered);
    assert.ok(name !== undefined, `the README names "${match[1] ?? ''}", which resolves to no registered command`);
  }

  // The collector is the one command the collection story cannot be told without.
  assert.ok(registered.has('collect'), 'the README documents a collector this build does not register');
});

test('every command invocation a document spells out is one this build registers', () => {
  const registered = registeredCommands();
  for (const document of DOCUMENTS) {
    const text = read(document.file);
    const invocations = invocationsIn(text);
    assert.ok(invocations.length >= 5, `${document.name} names only ${invocations.length} command invocations`);
    for (const words of invocations) {
      if (resolveTyped(words, registered) !== undefined) continue;
      // A command named before its own task ran is not a defect in the document,
      // so the assertion names the gap instead of weakening itself: either the
      // command is registered, or the document has to say in words that this
      // build does not have it yet.
      const pending = PENDING_COMMANDS.get(words.join(' '));
      assert.ok(
        pending !== undefined,
        `${document.name} names "${words.join(' ')}", which resolves to no registered command; ` +
          `this build registers ${[...registered].sort().join(', ')}`,
      );
      assert.ok(
        flatten(text).includes(pending),
        `${document.name} names "${words.join(' ')}", which ${pending} has not registered yet, ` +
          'but the document presents it as available; say instead that this build does not have it',
      );
    }
  }
});

/**
 * The body of one `##` section of a document, flattened.
 * @param {string} text
 * @param {string} heading
 * @returns {string}
 */
function inSection(text, heading) {
  const marker = `## ${heading}\n`;
  assert.ok(text.includes(marker), `no "## ${heading}" section`);
  const body = text.slice(text.indexOf(marker) + marker.length);
  const next = body.search(/^## /m);
  return flatten(next === -1 ? body : body.slice(0, next));
}

test('the README states the honest limits of the archive rather than a summary of it', () => {
  const limits = section(README, 'The honest limits of the archive');
  // The traffic window is the vendor contract; the client enforces the same number.
  const traffic = read(path.join(ROOT, 'src', 'github', 'traffic-client.js'));
  const window = /maximum is (\d+)/.exec(traffic);
  assert.ok(window !== null, 'the traffic client no longer states the window it accepts');
  const days = window[1] ?? '';
  assert.ok(limits.includes(`${days} days`), `the README does not state the ${days}-day traffic window`);
  assert.match(limits, /provenance boundary/);
  assert.match(limits, /never claims to know when a referrer first appeared/);
  assert.match(limits, /explicit insufficient-data result/);
  assert.match(limits, /Absolute values are shown beside percentages|absolute values sit beside percentages/);
  assert.match(limits, /the gap is the finding/);
  // The limits the requirement names, said in the product's own terms.
  assert.match(limits, /Backfilled days are not collected days/);
  assert.match(limits, /A unique cloner is not a person you can count/);
  assert.match(limits, /This project publishes no compliance claim, no certification and no third-party assessment/);
});

test('the privacy note states that no telemetry exists and names the only outbound host', () => {
  const privacy = flatten(read(PRIVACY));
  assert.match(privacy, /There is \*\*no telemetry\*\* in this product/);
  assert.match(privacy, /No usage analytics, no page-view counting/);
  assert.match(privacy, /No crash reporting and no error reporting service/);
  assert.match(privacy, /No update check\./);
  assert.match(privacy, /No remote font, no remote image, no CDN, no stylesheet or script from another origin/);
  assert.match(privacy, /\*\*One host: `api\.github\.com`\.\*\*/, 'the privacy note must name the single permitted host');
  assert.match(privacy, /Every outbound request in this product is a `GET` to that host/);
  // Each claim must also point at the code that enforces it.
  assert.match(privacy, /`src\/github\/http\.js`/);
  assert.match(privacy, /`src\/credentials\/store\.js`/);
  assert.match(privacy, /`src\/credentials\/redact\.js`/);
  assert.match(privacy, /`src\/paths\.js`/);
  assert.match(privacy, /binds to `127\.0\.0\.1` only/);
  // The loopback bind address is the product's own constant, so the note cannot
  // drift from the server module.
  assert.ok(LOOPBACK_HOST === LOOPBACK_TEST_HOST, `the server binds to ${LOOPBACK_HOST}, not loopback`);
});

test('the privacy note states that the credential file holds a read-only token that is never printed', () => {
  const credential = section(PRIVACY, 'The credential file');
  assert.match(credential, /holds \*\*one read-only token\*\*/, 'the privacy note must state the credential is read-only');
  assert.ok(
    credential.includes(`mode ${TICK}${octal(CREDENTIAL_FILE_MODE)}${TICK} exactly`),
    `the privacy note does not name the credential mode ${octal(CREDENTIAL_FILE_MODE)}`,
  );
  assert.match(credential, /every request this tool makes is a `GET`/);
  assert.match(credential, /The token is never printed\./);
  assert.match(credential, /never repairs the mode for you/);
  assert.match(credential, /no second credential source/);
  // RS-SP-02's permission state is an action for the maintainer, not an empty chart.
  assert.match(flatten(read(PRIVACY)), /re-authentication state naming the required permission/);
});

test('both documents name the runbooks and the files they point a reader at', () => {
  const referenced = [
    'docs/operations/scheduled-collection.md',
    'docs/operations/troubleshooting.md',
    'docs/operations/backup-and-migrate.md',
    'docs/operations/privacy.md',
  ];
  for (const target of referenced) {
    assert.ok(
      read(README).includes(target),
      `README.md does not point the reader at ${target}, which this repository provides`,
    );
    assert.ok(statSync(path.join(ROOT, target)).isFile(), `${target} is referenced but is not a file`);
  }
  assert.match(flatten(read(README)), /doc\/reviews\/open-source-posture\.json|docs\/reviews\/open-source-posture\.json/);
});

test('neither document names an outbound host other than api.github.com', () => {
  for (const document of DOCUMENTS) {
    const text = read(document.file);
    for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      assert.equal(match[1], ALLOWED_HOST, `${document.name} names the host ${String(match[1])}`);
    }
    // A page must not tell a reader to fetch anything, which is how a remote
    // asset or an update check would get introduced.
    assert.doesNotMatch(text, /\bcurl\b|\bwget\b|\bnpm install\b|\bnpm i\b/);
  }
});

test('the transport still permits only api.github.com and the gated loopback stub, and only the transport makes an outbound request', () => {
  const transport = read(path.join(ROOT, 'src', 'github', 'http.js'));
  // Only the host the allowlist compares against counts. A vendor documentation
  // link in a comment names pages the maintainer may read, not hosts the tool
  // may contact, so comments are stripped before the host set is read.
  const code = transport
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  /** @type {Set<string>} */
  const hosts = new Set();
  for (const match of code.matchAll(/https?:\/\/([A-Za-z0-9.:-]+)/g)) hosts.add(match[1] ?? '');
  for (const match of code.matchAll(/hostname === '([^']+)'/g)) hosts.add(match[1] ?? '');
  assert.ok(hosts.size > 0, 'the transport names no host at all, so the allowlist could not be read');
  for (const host of hosts) {
    assert.ok(
      host === ALLOWED_HOST || host === LOOPBACK_TEST_HOST,
      `the transport names the host ${host}, which is neither ${ALLOWED_HOST} nor the gated loopback stub`,
    );
  }
  // A request is only ever GET, and a redirect never becomes a second request.
  assert.match(transport, /method: 'GET'/);
  assert.match(transport, /redirect: 'manual'/);
  assert.match(transport, /REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT/);

  // One module reaches the network, and nothing else in `src` even names fetch.
  const referencing = javascriptFilesIn(path.join(ROOT, 'src')).filter((file) => /\bfetch\b/.test(read(path.join(ROOT, file))));
  assert.deepEqual(referencing, ['src\\github\\http.js'.replace(/\\/g, '/')], 'another module in src names fetch');
  for (const file of javascriptFilesIn(path.join(ROOT, 'src'))) {
    assert.doesNotMatch(
      read(path.join(ROOT, file)),
      /from 'node:https'|require\('node:https'\)|\.request\(/,
      `${file} opens an outbound request outside the allowlisted transport`,
    );
  }
});

test('no credential, configuration, database or home-directory file is tracked in the repository', () => {
  const tracked = trackedFiles();
  /** @param {string} file */
  const basename = (file) => file.split('/').pop() ?? file;
  for (const file of tracked) {
    const name = basename(file);
    assert.ok(name !== CREDENTIALS_FILE_NAME, `the credential file ${file} is tracked`);
    assert.ok(name !== CONFIG_FILE_NAME, `the configuration file ${file} is tracked`);
    assert.ok(!/\.sqlite(3)?(-journal|-wal|-shm)?$/.test(name), `the archive file ${file} is tracked`);
    assert.ok(name !== DATABASE_FILE_NAME, `the archive file ${file} is tracked`);
    assert.ok(!name.endsWith('.bak'), `a backup copy ${file} is tracked`);
  }
  // The same names must be ignored, so a local run cannot stage one by accident.
  const ignore = read(path.join(ROOT, '.gitignore'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  for (const name of [CREDENTIALS_FILE_NAME, CONFIG_FILE_NAME]) {
    assert.ok(ignore.includes(name), `.gitignore does not cover ${name}`);
  }
  assert.ok(
    ignore.includes('*.sqlite3'),
    '.gitignore does not cover the archive extension, so a stray archive can be staged',
  );
  assert.ok(
    read(PRIVACY).includes('tests/release-contract.test.js'),
    'the privacy note must name the test that keeps these claims true',
  );
});

test('the licence file names the MIT licence with a copyright line, and the manifest agrees', () => {
  const licence = flatten(read(LICENSE));
  assert.match(licence, /^MIT License/, 'the licence file does not name the MIT licence');
  assert.match(licence, /Copyright \(c\) \d{4} \S+/, 'the licence file carries no copyright line');
  assert.match(licence, /Permission is hereby granted, free of charge/);
  assert.match(licence, /THE SOFTWARE IS PROVIDED "AS IS"/);
  const metadata = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.equal(metadata.license, 'MIT', 'package.json and the licence file disagree about the licence');
  assert.match(flatten(read(README)), /MIT\. See \[LICENSE\]\(LICENSE\)/);
});

test('neither document claims a test result, an approval or a compliance claim that was not observed', () => {
  for (const document of DOCUMENTS) {
    const text = read(document.file);
    for (const claim of UNOBSERVED_CLAIMS) {
      assert.doesNotMatch(text, claim, `${document.name} claims ${String(claim)}, which nobody observed`);
    }
    // A document names the gate that records a result instead of stating one.
    assert.match(
      text,
      /docs\/reviews\/open-source-posture\.json/,
      `${document.name} does not name the review that has to confirm the licence and the data statement`,
    );
    assert.match(
      text,
      /does not contain it yet|is not in this repository yet|none of them is\s+in this repository yet/,
      `${document.name} must say the posture review is not recorded yet rather than implying it is done`,
    );
  }
});

test('the release contract leaves a temporary home behind nothing for a later run to inherit', () => {
  // The document tests above spawn the entry point; proving the home they resolve
  // is disposable keeps the pattern this repository establishes for every suite.
  const home = mkdtempSync(path.join(tmpdir(), 'repo-signal-release-'));
  try {
    const result = spawnSync(process.execPath, [CLI, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, REPO_SIGNAL_HOME: home, NODE_OPTIONS: '' },
    });
    assert.equal(result.status, 0, `node src/cli.js --help exited ${String(result.status)} against a temporary home`);
    assert.match(result.stdout ?? '', /Usage:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
