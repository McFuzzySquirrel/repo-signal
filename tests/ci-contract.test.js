import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CREDENTIAL_FILE_MODE } from '../src/credentials/store.js';
import { HOME_DIRECTORY_MODE } from '../src/paths.js';
import { TRAFFIC_PERMISSION } from '../src/supervision/errors.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const CHECKLIST = path.join(ROOT, 'docs', 'operations', 'release-checklist.md');
const README = path.join(ROOT, 'README.md');
const LOCKFILE = path.join(ROOT, 'package-lock.json');
const MIGRATIONS = path.join(ROOT, 'src', 'db', 'migrations');
const WRAPPER = path.join(ROOT, 'scripts', 'run-tests.mjs');
const DRILL = path.join(ROOT, 'scripts', 'backup-drill.mjs');
const CLI = path.join(ROOT, 'src', 'cli.js');

/** The two files this task owns, plus the two the pipeline reads to keep them true. */
const AUTHORED = [
  ['.github/workflows/ci.yml', WORKFLOW],
  ['docs/operations/release-checklist.md', CHECKLIST],
];

/** The only host the tool is permitted to contact, and the only host a build may name. */
const ALLOWED_HOST = 'api.github.com';

/** Read-only GitHub actions this workflow is allowed to use. */
const ALLOWED_ACTIONS = new Set(['actions/checkout@v4', 'actions/setup-node@v4']);

/**
 * Steps that would deploy, publish, upload or release something. The pipeline is
 * verification only: a tag is a person's decision, so none of these may appear in it.
 */
const FORBIDDEN_PIPELINE_STEPS = /** @type {RegExp[]} */ ([
  /npm\s+publish/,
  /npm\s+pack\b/,
  /\bnpx\s+semver-release/,
  /\bgh\s+release\b/,
  /\bgh\s+api\b/,
  /\bgit\s+push\b/,
  /\bdocker\b/,
  /actions\/upload-artifact/,
  /actions\/download-artifact/,
  /actions\/deploy-pages/,
  /actions\/upload-release-asset/,
  /action-gh-release/,
  /\bwrite-all\b/,
  /\bid-token\b/,
  /\benvironment:\s*\w/,
]);

/**
 * Phrasings that would state a result, an approval or a compliance claim nobody
 * observed. A document that needs one names the artefact that has to hold it instead.
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
]);

/**
 * The statements the README must still make, in the words both documents use. Each
 * pattern has to match `README.md` and the release checklist, so a later edit cannot
 * drop a statement from one and leave the other claiming it.
 *
 * @type {[string, RegExp][]}
 */
const README_STATEMENTS = [
  ['a clone is not adoption', /A clone is not adoption/],
  ['no fabricated history', /fabricates no history/],
  ['gaps stay gaps', /leaves the gaps as gaps/],
  ['no adoption score', /no adoption score/],
  ['the token performs no write', /It performs no write/],
  ['the data statement', /may not be redistributed/],
  ['no telemetry', /no telemetry/i],
  ['the only outbound host', new RegExp(ALLOWED_HOST.replace(/\./g, '\\.'))],
  ['the required permission', new RegExp(escapeRegExp(TRAFFIC_PERMISSION))],
];

/**
 * The three human gates. Each is named by its task id, by the words a person would use
 * for it, and by the artefact a reviewer writes; none of the artefacts exists yet, and the
 * checklist has to say so rather than implying the gate is behind us.
 *
 * @type {{ id: string, name: RegExp, artefact: string }[]}
 */
const HUMAN_GATES = [
  {
    id: 'RS-OPS-LIVE-01',
    name: /live integration check/i,
    artefact: 'docs/reviews/github-live-integration.json',
  },
  {
    id: 'RS-OPS-SOAK-01',
    name: /seven-day soak/i,
    artefact: 'docs/reviews/collection-soak.json',
  },
  {
    id: 'RS-OPS-REV-01',
    name: /open-source posture review/i,
    artefact: 'docs/reviews/open-source-posture.json',
  },
];

/** @param {string} text @returns {string} */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {number} mode @returns {string} Octal with four digits, the way refusals print it. */
function octal(mode) {
  return mode.toString(8).padStart(4, '0');
}

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Flatten a document's line wrapping so an assertion about a sentence does not depend on
 * where the prose happens to wrap.
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
 * One `##` section of a document, flattened. A heading that is not there fails the test
 * rather than silently matching the whole document.
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

/** @returns {{ scripts: Record<string, string>, engines: { node?: string }, license?: string }} */
function manifest() {
  const metadata = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.equal(typeof metadata, 'object', 'package.json did not parse into an object');
  return metadata;
}

/** @returns {string} The engine floor package.json declares, without its comparison operator. */
function declaredFloor() {
  const range = /** @type {string} */ (manifest().engines?.node);
  assert.match(range, /^>=\d+\.\d+\.\d+$/, `engines.node is ${range}, which this test cannot read as a floor`);
  return /** @type {string} */ (/^>=(\d+\.\d+\.\d+)$/.exec(range)?.[1]);
}

/** @returns {string} The engine range exactly as package.json spells it. */
function declaredRange() {
  return /** @type {string} */ (manifest().engines?.node);
}

/**
 * Every entry of the workflow's Node matrix. The key-only line is the matrix declaration;
 * the `node-version: ${{ ... }}` line inside `with:` carries a value and is not one.
 * @param {string} workflow
 * @returns {string[]}
 */
function matrixNodeVersions(workflow) {
  /** @type {string[]} */
  const versions = [];
  const lines = workflow.split('\n');
  const declaration = /^(\s*)node-version:\s*$/;
  const start = lines.findIndex((line) => declaration.test(line));
  assert.notEqual(start, -1, 'the workflow declares no `node-version:` matrix');
  const indent = /** @type {string} */ (declaration.exec(lines[start] ?? '')?.[1]).length;
  for (const line of lines.slice(start + 1)) {
    const item = new RegExp(`^\\s{${indent + 2}}-\\s*['"]?([^'"]+?)['"]?\\s*$`).exec(line);
    if (item === null) {
      if (line.trim() !== '') break;
      continue;
    }
    versions.push(/** @type {string} */ (item[1]));
  }
  assert.ok(versions.length > 0, 'the `node-version:` matrix lists no version');
  return versions;
}

/**
 * The highest numbered migration, which is the schema version this build ships.
 * @returns {number}
 */
function codeSchemaVersion() {
  /** @type {number[]} */
  const versions = [];
  for (const name of readdirSync(MIGRATIONS)) {
    const version = /^(\d+)-/.exec(name)?.[1];
    if (version !== undefined) versions.push(Number(version));
  }
  assert.ok(versions.length > 0, `${MIGRATIONS} holds no numbered migration`);
  return Math.max(...versions);
}

/** @returns {string} The migration file that carries the code schema version. */
function latestMigrationFile() {
  const version = codeSchemaVersion();
  const name = readdirSync(MIGRATIONS).find((entry) => entry.startsWith(`${String(version).padStart(3, '0')}-`));
  assert.ok(name !== undefined, `no migration file carries version ${version}`);
  return name;
}

/**
 * Spawn the real entry point and read the usage listing it generates from the command
 * registry, which is the only authority on which commands a build has.
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
 * Every command invocation a document spells out: `node src/cli.js ...` for the product
 * and `node scripts/...mjs` for a repository script.
 * @param {string} text
 * @returns {string[]}
 */
function invocationsIn(text) {
  /** @type {string[]} */
  const invocations = [];
  // One invocation per line: a pattern that ran past a newline would read two commands
  // written on consecutive lines as one unresolvable name.
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/node (src\/cli\.js|scripts\/[A-Za-z0-9._/-]+\.mjs)((?:\s+[^\s`|]+)*)/g)) {
      const words = /** @type {string} */ (match[2] ?? '')
        .trim()
        .split(/\s+/)
        .filter((word) => !word.startsWith('-'));
      if (words.length > 0) invocations.push(`${/** @type {string} */ (match[1])} ${words.join(' ')}`);
    }
  }
  return invocations;
}

test('the workflow and the release checklist both exist and are not stubs', () => {
  for (const [name, file] of AUTHORED) {
    assert.ok(existsSync(file), `${name} does not exist`);
    assert.ok(statSync(file).isFile(), `${name} is not a file`);
    assert.ok(read(file).length > 400, `${name} is ${read(file).length} characters, which is a stub`);
  }
});

test('the workflow performs a clean install, the type check and the repository test command', () => {
  const workflow = read(WORKFLOW);
  const scripts = manifest().scripts;

  // A clean install means the lock file, not whatever node_modules happened to hold.
  assert.match(workflow, /^\s*run: npm ci\s*$/m, 'the workflow does not run `npm ci`');
  assert.ok(existsSync(LOCKFILE), 'the workflow runs a clean install but package-lock.json is not committed');
  assert.doesNotMatch(workflow, /\bnpm install\b/, '`npm install` ignores the committed lock file');

  // Both script names come from package.json, so renaming either fails here rather than
  // leaving the pipeline running a command that no longer exists.
  const typecheckScript = Object.keys(scripts).find((name) => name === 'typecheck');
  assert.ok(typecheckScript !== undefined, 'package.json declares no typecheck script');
  assert.match(workflow, new RegExp(`^\\s*run: npm run ${escapeRegExp(typecheckScript)}\\s*$`, 'm'));
  assert.equal(scripts[typecheckScript], 'tsc --noEmit', 'the typecheck script is not `tsc --noEmit`');

  const testScript = Object.keys(scripts).find((name) => name === 'test');
  assert.ok(testScript !== undefined, 'package.json declares no test script');
  assert.match(workflow, new RegExp(`^\\s*run: npm ${escapeRegExp(testScript)}\\s*$`, 'm'));

  // The repository's test command is the wrapper, and the wrapper is what fails on an
  // empty selection. Asserting `npm test` alone would not prove either half.
  assert.equal(scripts[testScript], 'node scripts/run-tests.mjs', 'the test script is not the verification wrapper');
  assert.ok(existsSync(WRAPPER), 'scripts/run-tests.mjs does not exist');
  assert.match(read(WRAPPER), /no tests were selected/, 'the wrapper no longer refuses an empty selection');
  assert.doesNotMatch(workflow, /node --test/, 'the workflow bypasses the wrapper with the bare runner');
});

test('the lock file states the same Node floor as package.json', () => {
  // The lock file is what `npm ci` installs from, so a floor it states that
  // package.json does not is a floor the pipeline appears to support. 22.13.0 is
  // the release that dropped the experimental SQLite flag, not the one that
  // exposes `enableDefensive`; on that line the module imports and the archive
  // then fails to open. Only package.json may set the floor, and the lock file
  // has to agree with it.
  const engines = manifest().engines;
  assert.ok(engines !== undefined && typeof engines.node === 'string',
    'package.json declares no Node range, so there is no floor to keep');
  const lock = JSON.parse(read(LOCKFILE));
  const locked = lock.packages?.['']?.engines;
  assert.deepEqual(locked, engines,
    `package-lock.json states ${JSON.stringify(locked)} but package.json states ` +
    `${JSON.stringify(engines)}; regenerate the lock file with ` +
    '`npm install --package-lock-only` rather than editing it');
  // The floor itself is a storage requirement, not a preference, so it is asserted
  // here as well as in the release checklist: it is the release that exposes the
  // defensive driver option the archive connection depends on.
  assert.match(engines.node, /^>=24\.12\.0$/);
});

test('the workflow runs the four steps in order, the drill last', () => {
  const workflow = read(WORKFLOW);
  const positions = ['run: npm ci', 'run: npm run typecheck', 'run: npm test', 'run: node scripts/backup-drill.mjs'].map(
    (step) => {
      const index = workflow.indexOf(step);
      assert.notEqual(index, -1, `the workflow never runs ${step}`);
      return index;
    },
  );
  const sorted = [...positions].sort((left, right) => left - right);
  assert.deepEqual(positions, sorted, 'the pipeline runs its steps out of order');
  assert.ok(existsSync(DRILL), 'the pipeline runs scripts/backup-drill.mjs, which does not exist');
  assert.equal(
    [...workflow.matchAll(/run: node scripts\/backup-drill\.mjs/g)].length,
    1,
    'the drill runs exactly once per matrix entry',
  );
});

test('the workflow matrix covers two Node versions including the supported floor', () => {
  const workflow = read(WORKFLOW);
  const versions = matrixNodeVersions(workflow);
  assert.equal(versions.length, 2, `the matrix lists ${versions.join(', ')}, which is not two Node lines`);

  const floor = declaredFloor();
  assert.ok(versions.includes(floor), `the matrix omits the supported floor ${floor} that package.json declares`);

  const other = versions.find((version) => version !== floor);
  assert.ok(other !== undefined, 'the matrix lists the floor twice');
  for (const version of versions) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${version} is not a pinned version; a floating alias cannot be verified`);
    const major = Number(version.split('.')[0]);
    const floorMajor = Number(floor.split('.')[0]);
    assert.equal(major, floorMajor, `the matrix runs ${version}, a different major from the floor ${floor}`);
    assert.ok(version >= floor, `${version} is below the supported floor ${floor}`);
  }
  // The second line is the current 24 LTS line, which the PRD records by name.
  assert.notEqual(other, floor);
  assert.ok(flatten(read(path.join(ROOT, 'docs', 'PRD.md'))).includes(other), `the PRD no longer records ${other}`);

  // The matrix has to be the version setup-node installs, or the two entries prove nothing.
  assert.match(workflow, /node-version: \$\{\{ matrix\.node-version \}\}/);
  assert.match(workflow, /fail-fast: false/, 'one failing Node line must not hide the other');
});

test('the pipeline needs no token and no secret of any kind', () => {
  const workflow = read(WORKFLOW);
  for (const forbidden of [
    /secrets\./,
    /\$\{\{\s*secrets/,
    /\bGITHUB_TOKEN\b/,
    /\btoken:\s*\S/,
    /\bpassword/i,
    /\bcredentials\.json\b/,
    /npm\s+--token/,
  ]) {
    assert.doesNotMatch(workflow, forbidden, `the pipeline references ${String(forbidden)}`);
  }
  // Read-only is the whole credential surface: the checkout reads and nothing writes.
  const permissions = /permissions:\n((?:\s+[^\n]*\n)+)/.exec(workflow);
  assert.ok(permissions !== null, 'the workflow declares no permissions block');
  const granted = /** @type {string} */ (permissions[1])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  assert.deepEqual(granted, ['contents: read'], `the pipeline asks for ${granted.join(', ')}`);
});

test('the pipeline deploys, publishes and releases nothing', () => {
  const workflow = read(WORKFLOW);
  for (const step of FORBIDDEN_PIPELINE_STEPS) {
    assert.doesNotMatch(workflow, step, `the pipeline contains ${String(step)}`);
  }
  // Verification is the whole job: the only third-party code it runs is the two
  // read-only actions that set up the job.
  /** @type {string[]} */
  const used = [];
  for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) used.push(match[1] ?? '');
  assert.ok(used.length >= 2, 'the workflow uses no action at all, so it cannot check out or set up Node');
  for (const action of used) {
    assert.ok(ALLOWED_ACTIONS.has(action), `the pipeline uses ${action}, which is not one of ${[...ALLOWED_ACTIONS].join(', ')}`);
  }
  // No trigger turns a push into a release, and no job publishes on a schedule.
  assert.doesNotMatch(workflow, /^\s*tags:/m, 'a tag trigger would run the pipeline as if a tag were a release step');
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.match(workflow, /^\s*pull_request:\s*$/m, 'the workflow does not verify pull requests');
});

test('the pipeline adds no outbound request and names no host', () => {
  const workflow = read(WORKFLOW);
  for (const match of workflow.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
    assert.equal(match[1], ALLOWED_HOST, `the pipeline names the host ${String(match[1])}`);
  }
  for (const forbidden of [/\bcurl\b/, /\bwget\b/, /\bfetch\s*\(/, /node -e\b/]) {
    assert.doesNotMatch(workflow, forbidden, `the pipeline contains ${String(forbidden)}`);
  }
  // RS-SP-05's mechanical guarantee is the allowlist test; it must still be the thing
  // that proves it, so the pipeline is not a second place a host could be added.
  const allowlist = read(path.join(ROOT, 'tests', 'github-http.test.js'));
  assert.ok(allowlist.includes(ALLOWED_HOST), 'the allowlist test no longer names the single permitted host');
  assert.ok(flatten(read(CHECKLIST)).includes('tests/github-http.test.js'), 'the checklist does not name the allowlist test');
});

test('the pipeline keeps every state path outside the work tree', () => {
  const workflow = read(WORKFLOW);
  assert.match(
    workflow,
    /REPO_SIGNAL_HOME: \$\{\{ runner\.temp \}\}/,
    'the pipeline does not point the home at a path outside the checkout',
  );
  // The drill creates its own scratch homes; nothing may write into the workspace.
  assert.doesNotMatch(workflow, /REPO_SIGNAL_HOME:\s*\./, 'the pipeline resolves the home inside the checkout');
});

test('the release checklist names the schema version this build ships', () => {
  const version = codeSchemaVersion();
  const ships = section(CHECKLIST, 'What ships with the tag');
  assert.match(ships, /Schema version \(code\)/);
  assert.ok(ships.includes(`\`${version}\``), `the checklist does not name the shipped schema version ${version}`);
  assert.ok(
    ships.includes(latestMigrationFile()),
    `the checklist does not name the migration file that carries version ${version}`,
  );
  // The version is read from the repository, not trusted: `db status` is the command that
  // prints it, and it exists in this build.
  assert.match(flatten(read(CHECKLIST)), /node src\/cli\.js db status/);
  assert.match(ships, new RegExp(`src/db/migrations/`));
});

test('the release checklist names the supported Node range and the line the pipeline also runs', () => {
  const ships = section(CHECKLIST, 'What ships with the tag');
  const range = declaredRange();
  const floor = declaredFloor();
  assert.ok(ships.includes(`\`${range}\``), `the checklist does not name the declared range ${range}`);
  assert.ok(ships.includes(floor), `the checklist does not name the supported floor ${floor}`);
  assert.ok(ships.includes('package.json'), 'the checklist does not say where the range is authoritative');

  const verified = matrixNodeVersions(read(WORKFLOW));
  for (const version of verified) {
    assert.ok(ships.includes(version), `the checklist does not name the verified Node line ${version}`);
  }
  // The floor is a storage requirement, so the checklist has to say why rather than
  // presenting it as a preference.
  assert.match(flatten(read(CHECKLIST)), /`enableDefensive`/);
});

test('the release checklist names the licence and the file that carries it', () => {
  const ships = section(CHECKLIST, 'What ships with the tag');
  const licence = /** @type {string} */ (manifest().license);
  assert.equal(licence, 'MIT', `package.json declares the licence ${licence}, which this test cannot read as MIT`);
  assert.ok(ships.includes(licence), `the checklist does not name the ${licence} licence`);
  assert.ok(ships.includes('LICENSE'), 'the checklist does not point at the licence file');
  assert.ok(statSync(path.join(ROOT, 'LICENSE')).isFile(), 'LICENSE does not exist');
  assert.match(flatten(read(CHECKLIST)), /grants no right in the data/i);
});

test('the release checklist names every statement the README must still make, and the README still makes it', () => {
  const checklist = flatten(read(CHECKLIST));
  const readme = flatten(read(README));
  for (const [label, pattern] of README_STATEMENTS) {
    assert.match(readme, pattern, `README.md no longer states ${label}, so the checklist cannot claim it does`);
    assert.match(checklist, pattern, `the release checklist does not name ${label}`);
  }
  // Two of the statements are about the credential file's modes, read from the product's
  // own constants rather than from a number a writer chose.
  for (const mode of [HOME_DIRECTORY_MODE, CREDENTIAL_FILE_MODE]) {
    const pattern = new RegExp(`mode \`${octal(mode)}\``);
    assert.match(readme, pattern, `README.md no longer names mode ${octal(mode)}`);
    assert.match(checklist, pattern, `the release checklist does not name mode ${octal(mode)}`);
  }
  // The Node range is one of the statements, read from the manifest so it cannot drift.
  assert.ok(checklist.includes(declaredRange()));
  // Each statement has a test that keeps it true, and the checklist says so.
  assert.ok(checklist.includes('tests/release-contract.test.js'), 'the checklist does not name the README contract test');
  assert.ok(
    existsSync(path.join(ROOT, 'tests', 'release-contract.test.js')),
    'the checklist names a README contract test this repository does not have',
  );
});

test('the release checklist names all three human gates and where each one is recorded', () => {
  const text = read(CHECKLIST);
  const flattened = flatten(text);
  for (const gate of HUMAN_GATES) {
    assert.ok(text.includes(gate.id), `the checklist never names the gate ${gate.id}`);
    assert.match(flattened, gate.name, `the checklist never names ${gate.id} in words`);
    assert.ok(text.includes(gate.artefact), `the checklist never names ${gate.artefact}, the artefact ${gate.id} writes`);

    // The `Recorded?` column has to match reality: a gate whose artefact is absent must
    // read as unrecorded, and one whose artefact exists must not still read that way.
    const lines = text.split('\n').filter((line) => line.includes(gate.artefact));
    assert.ok(lines.length > 0, `no line of the checklist names ${gate.artefact}`);
    const present = existsSync(path.join(ROOT, gate.artefact));
    if (present) {
      assert.ok(
        lines.every((line) => !/not recorded/i.test(line)),
        `${gate.artefact} is in the repository but the checklist still calls ${gate.id} unrecorded`,
      );
    } else {
      assert.ok(
        lines.some((line) => /not recorded/i.test(line)),
        `the checklist must say ${gate.id} is not recorded while ${gate.artefact} is absent`,
      );
    }
  }
  const missing = HUMAN_GATES.filter((gate) => !existsSync(path.join(ROOT, gate.artefact)));
  if (missing.length === HUMAN_GATES.length) {
    assert.match(
      flattened,
      /None of those three files is in this repository yet/,
      'the checklist must say the three gate artefacts are absent rather than implying they are done',
    );
  }
  // The gates are a person's work: no agent writes them and no test stands in for them.
  assert.match(flattened, /No agent authors these three files/);
  assert.doesNotMatch(flattened, /automate[sd]? the human gates/, 'the checklist offers to automate the human gates');
});

test('every command the release checklist names exists in this repository', () => {
  const text = read(CHECKLIST);
  const registered = registeredCommands();
  const invocations = invocationsIn(text);
  assert.ok(invocations.length >= 3, `the checklist names only ${invocations.length} command invocations`);

  for (const invocation of invocations) {
    // A bare `node src/cli.js` with no subcommand is the entry point itself, and a bare
    // `node scripts/x.mjs` is a repository script; both only have to exist on disk.
    const words = invocation.split(/\s+/).slice(1).filter((word) => !word.startsWith('-'));
    if (words.length === 0) {
      assert.ok(
        existsSync(path.join(ROOT, invocation)),
        `the checklist names \`${invocation}\`, which this repository does not provide`,
      );
      continue;
    }
    if (invocation.startsWith('src/cli.js')) {
      const resolved = words
        .map((_, index) => words.slice(0, words.length - index).join(' '))
        .find((candidate) => candidate !== '' && registered.has(candidate));
      assert.ok(
        resolved !== undefined,
        `the checklist names "${invocation}", which resolves to no registered command; ` +
          `this build registers ${[...registered].sort().join(', ')}`,
      );
      continue;
    }
    // A repository script has to be a file, and its name has to be the one the pipeline runs.
    const file = words[0] ?? invocation;
    assert.ok(existsSync(path.join(ROOT, file)), `the checklist names ${file}, which this repository does not provide`);
  }

  // The npm scripts it names are the manifest's own, so renaming one breaks this page.
  const scripts = manifest().scripts;
  for (const match of text.matchAll(/npm (?:run )?([a-z][a-z0-9-]*)/g)) {
    const name = match[1] ?? '';
    if (name === 'ci') continue; // npm's own clean install, checked against the lock file above
    assert.ok(
      /** @type {Record<string, string>} */ (scripts)[name] !== undefined,
      `the checklist names \`npm ${name}\`, which package.json does not declare`,
    );
  }
});

test('the release checklist names the pipeline it depends on and the drill that runs there', () => {
  const checklist = flatten(read(CHECKLIST));
  const pipeline = section(CHECKLIST, 'What the pipeline runs');
  assert.ok(checklist.includes('.github/workflows/ci.yml'), 'the checklist does not name the workflow file');
  assert.ok(statSync(WORKFLOW).isFile(), 'the checklist names a workflow this repository does not have');
  for (const step of ['npm ci', 'npm run typecheck', 'npm test', 'node scripts/backup-drill.mjs']) {
    assert.ok(pipeline.includes(step), `the pipeline section does not name ${step}`);
  }
  assert.match(pipeline, /exits non-zero when it selected zero tests/, 'the checklist does not say the wrapper fails on an empty selection');
  assert.match(pipeline, /Do not tag|do not tag/, 'the checklist does not say what a failed step means for a tag');
  assert.ok(checklist.includes('docs/operations/backup-and-migrate.md'), 'the checklist does not point at the backup runbook');
  assert.ok(
    statSync(path.join(ROOT, 'docs', 'operations', 'backup-and-migrate.md')).isFile(),
    'the checklist points at a backup runbook this repository does not have',
  );
});

test('neither the workflow nor the checklist claims a result, an approval or a compliance claim', () => {
  for (const [name, file] of AUTHORED) {
    const text = read(file);
    for (const claim of UNOBSERVED_CLAIMS) {
      assert.doesNotMatch(text, claim, `${name} claims ${String(claim)}, which nobody observed`);
    }
    // Neither file tells a reader to fetch anything, which is how a remote asset, an
    // update check or a second outbound host would be introduced.
    assert.doesNotMatch(text, /\bcurl\b|\bwget\b|\bnpm install\b/);
    for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      assert.equal(match[1], ALLOWED_HOST, `${name} names the host ${String(match[1])}`);
    }
  }
});

test('the workflow file is the shape the repository host expects', () => {
  const workflow = read(WORKFLOW);
  assert.doesNotMatch(workflow, /\t/, 'the workflow contains a tab; YAML forbids it for indentation');
  for (const key of ['name:', 'on:', 'permissions:', 'jobs:', 'steps:']) {
    assert.match(workflow, new RegExp(`^\\s*${escapeRegExp(key)}`, 'm'), `the workflow has no ${key} key`);
  }
  // Every step does something: a step with neither `uses:` nor `run:` is a no-op that
  // reads as a passing verification.
  const lines = workflow.split('\n');
  const stepStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*- name:\s/.test(line))
    .map(({ index }) => index);
  assert.ok(stepStarts.length >= 5, `the workflow declares only ${stepStarts.length} named steps`);
  for (const [position, start] of stepStarts.entries()) {
    const end = stepStarts[position + 1] ?? lines.length;
    const body = lines.slice(start, end).join('\n');
    assert.match(body, /^\s*(?:uses|run):/m, `the step "${/** @type {string} */ (lines[start] ?? '').trim()}" does nothing`);
  }
});
