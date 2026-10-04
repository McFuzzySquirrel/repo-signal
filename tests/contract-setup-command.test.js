import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { listCommands, resolveCommand } from '../src/commands/index.js';
import { SETUP_MENU } from '../src/commands/setup.js';
import { CREDENTIAL_FILE_MODE } from '../src/credentials/store.js';
import { CONFIG_FILE_NAME, CREDENTIALS_FILE_NAME, DATABASE_FILE_NAME } from '../src/paths.js';
import { CONFIG_MANAGER_MENU } from '../src/tui/config-manager.js';
import { RUN_ACTIONS_MENU } from '../src/tui/run-actions.js';
import { FIRST_RUN_STEPS } from '../src/tui/setup-wizard.js';

/**
 * The `setup` command, the two documents that describe it, and the registry that
 * decides whether it exists.
 *
 * `setup` is documented as the guided alternative to the six-command sequence, so
 * the documents and the command have to agree on four things: that the command is
 * registered at all, what it writes, how the token is entered, and what
 * `--non-interactive` prints. Every assertion below therefore reads a document as
 * text *and* the module or the registry as a module: a contract test that read only
 * the document would prove the document agrees with itself, which was never in
 * question (`RS-C12`).
 *
 * The direction of repair is the document's. A command that wrote another file, took
 * a token on the command line, or installed a schedule would be a change to the
 * behaviour the plan asked for, so this suite fails on the prose and names both sides
 * rather than softening an assertion to make a document pass.
 *
 * No test here reaches api.github.com and none uses a real token: the suite spawns
 * the entry point against a temporary home and reads source, so it needs no network.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');
const README = path.join(ROOT, 'README.md');
const SCHEDULING = path.join(ROOT, 'docs', 'operations', 'scheduled-collection.md');

const SETUP_MODULE = 'src/commands/setup.js';
const WIZARD_MODULE = 'src/tui/setup-wizard.js';
const PROMPTS_MODULE = 'src/tui/prompts.js';
const RUN_ACTIONS_MODULE = 'src/tui/run-actions.js';
const SCHEMA_MODULE = 'src/config/schema.js';

/** The README section the guided alternative is documented in. */
const SETUP_HEADING = 'Setup: the guided alternative to the six commands';
/** The README section carrying the six-command sequence `setup` replaces nothing of. */
const INSTALL_HEADING = 'Install and run: clone and go';
/** The README section whose table is the inventory of registered commands. */
const INVENTORY_HEADING = 'The registered commands';

/**
 * The six commands the first-run journey is documented as, in the order the README
 * lists them. One list, so the fenced block, the numbered items and the registry
 * lookup are asserted against the same six rather than against three literals that can
 * drift apart.
 * @type {readonly string[]}
 */
const SIX_COMMANDS = Object.freeze([
  'config init', 'config check', 'discover', 'collect --dry-run', 'collect', 'report',
]);

/**
 * The name each of the six steps is registered under, without its flag: the same six
 * commands, read the way the registry reads them.
 */
const SIX_REGISTERED = SIX_COMMANDS.map((command) => command.split(' ').filter((word) => !word.startsWith('-')).join(' '));

/**
 * English words for the small integers the README spells out rather than printing as
 * digits, so a sentence's count can be compared with the registry or with an exported
 * constant rather than with a number this file repeats.
 */
const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** A backtick, spelled this way so a template literal can interpolate one. */
const TICK = String.fromCharCode(96);

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(file, 'utf8');
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
 * One `##` section of a document, verbatim rather than flattened, so a fenced block
 * or a table row can still be read as itself. A heading that is not there fails the
 * test rather than silently matching the whole document.
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
  return next === -1 ? body : body.slice(0, next);
}

/**
 * Every fenced block of a document, in order.
 * @param {string} text
 * @returns {string[]}
 */
function fencedBlocks(text) {
  return [...text.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)].map((match) => match[1] ?? '');
}

/**
 * Spawn the real entry point and read the usage listing it generates from the command
 * registry, which is the only authority on which commands this build has.
 * @returns {Map<string, string>} Registered name to the whole line printed for it.
 */
function registeredCommands() {
  const result = spawnSync(process.execPath, [CLI, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `node src/cli.js --help exited ${String(result.status)}`);
  const lines = (result.stdout ?? '').split('\n');
  const start = lines.indexOf('Commands:');
  assert.notEqual(start, -1, `no Commands section in:\n${result.stdout ?? ''}`);
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const match = /^ {2}([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)(.*)$/.exec(line);
    if (match !== null) names.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  assert.ok(names.size > 0, 'the usage listing named no command');
  return names;
}

/**
 * The flags a page or a module documents, read from code spans so an em dash or a
 * horizontal rule is never mistaken for one.
 * @param {string} text
 * @returns {string[]}
 */
function documentedFlags(text) {
  return [...text.matchAll(/`(--[a-z-]+)`/g)].map((match) => match[1] ?? '');
}

/**
 * The registered command a typed invocation resolves to: the longest registered prefix
 * of its words, or undefined when no prefix is registered.
 * @param {string[]} words
 * @param {Set<string>} registered
 * @returns {string|undefined}
 */
function resolveTyped(words, registered) {
  for (let length = words.length; length >= 1; length -= 1) {
    const candidate = words.slice(0, length).join(' ');
    if (registered.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Run the real entry point for `setup` against a home inside a temporary directory, so
 * nothing this suite does can reach a real archive.
 * @param {string[]} args
 * @param {string} home Absolute path of a home that does not exist yet.
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function spawnSetup(args, home) {
  const result = spawnSync(process.execPath, [CLI, 'setup', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    input: '',
    env: { ...process.env, REPO_SIGNAL_HOME: home, NODE_OPTIONS: '' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Every repository-relative `.js` path inside a directory.
 * @param {string} directory Absolute path.
 * @returns {string[]}
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

/** @param {number} mode @returns {string} Octal with four digits, as an operator writes a file mode. */
function octal(mode) {
  return mode.toString(8).padStart(4, '0');
}

/**
 * The count a sentence spells in words, read against the word table rather than
 * against a number this file repeats.
 * @param {string} sentence The flattened section the sentence is in.
 * @param {RegExp} pattern Captures the word itself.
 * @param {string} what Which sentence, named in the failure message.
 * @returns {{ word: string, count: number }}
 */
function spelledCount(sentence, pattern, what) {
  const match = pattern.exec(sentence);
  assert.ok(match !== null, `${what} no longer spells its count in words; it reads: ${sentence}`);
  const word = (match[1] ?? '').toLowerCase();
  const count = SPELLED.indexOf(word);
  assert.notEqual(count, -1, `${what} spells "${word}", which is not a count this test can read`);
  return { word, count };
}

/**
 * A regular expression source matching a count a page may publish as a digit or as the
 * word for it, so the page is free to write `3` where an operator's prose would say
 * `three`.
 * @param {number} count
 * @returns {string}
 */
function countEither(count) {
  const word = SPELLED[count] ?? String(count);
  return `(?:${String(count)}|${word})`;
}

/** @returns {string} The first-run flow's own source, read once per call so a failure names it. */
function wizardText() {
  return read(path.join(ROOT, WIZARD_MODULE));
}

/**
 * A file name a module spells out, in any of the extensions a home file, an archive
 * file or a schedule file would carry. A dotted member access such as `process.env` is
 * not a file name, so `env` and the shell extensions are left out of the list: what
 * this catches is a *new file* someone added to the flow, which is the drift the
 * README's "and nothing else" would hide.
 */
const HOME_FILE_NAME = /\b([a-z0-9][a-z0-9_-]*\.(?:json|sqlite3?|cron|crontab|plist|service|timer|conf|yaml|yml|log))\b/gi;

// RS-TUI-FR-01 and RS-C12: the command is registered, and the registry is what says so.
// A sentence in the README is not evidence that `node src/cli.js setup` resolves.
test('setup is registered in the registry and appears in the generated command list', () => {
  const resolution = resolveCommand(['setup']);
  assert.equal(resolution.ok, true, `resolveCommand(['setup']) did not resolve: ${JSON.stringify(resolution)}`);
  assert.equal(resolution.ok ? resolution.name : '', 'setup', 'the resolved command is not named setup');

  const registered = listCommands().find((command) => command.name === 'setup');
  assert.ok(registered !== undefined, 'listCommands() names no setup command, so nothing registered it');
  assert.ok(registered.summary.trim().length > 0, 'setup is registered with an empty summary');
  assert.deepEqual(registered.usage.match(/--[a-z-]+/g) ?? [], ['--help', '--non-interactive'],
    `the registry advertises "${registered.usage}" as setup's usage, which is not the two flags the command accepts`);

  // The same fact read from the generated listing rather than the module, so the page
  // an operator reads and the registry cannot disagree.
  const usage = registeredCommands();
  const listed = usage.get('setup');
  assert.notEqual(listed, undefined,
    `the generated command list names no setup; it names ${[...usage.keys()].join(', ')}`);
  assert.ok((listed ?? '').startsWith(registered.usage),
    `the generated listing prints "${listed ?? ''}" for setup and the registry's usage is "${registered.usage}"`);
  assert.ok((listed ?? '').includes(registered.summary),
    `the generated listing prints "${listed ?? ''}" for setup and the registry's summary is ` +
      `"${registered.summary}"`);
});

// RS-TUI-FR-01: the two flags the registry advertises are the flags the command
// accepts, each answers without asking and without writing, and any other argument is
// a usage error. The home is asserted not to exist afterwards, because a command asked
// what it does must not leave a directory behind.
test('the two flags answer without asking and write no file, and any other argument is a usage error', (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'repo-signal-setup-contract-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));

  const helpHome = path.join(temporary, 'help-home');
  const help = spawnSetup(['--help'], helpHome);
  assert.equal(help.status, 0, `setup --help exited ${String(help.status)}: ${help.stderr}`);
  assert.match(help.stdout, /what a first run asks, and what a returning visit opens/,
    'setup --help did not print the steps of both visits');
  assert.equal(existsSync(helpHome), false, `setup --help created ${helpHome}; it reads no file and writes none`);

  const scriptHome = path.join(temporary, 'script-home');
  const script = spawnSetup(['--non-interactive'], scriptHome);
  assert.equal(script.status, 0, `setup --non-interactive exited ${String(script.status)}: ${script.stderr}`);
  assert.match(script.stdout, /the scriptable equivalent of every step/,
    'setup --non-interactive did not print the scriptable equivalent of every step');
  assert.equal(existsSync(scriptHome), false,
    `setup --non-interactive created ${scriptHome}; it reads no file and writes none`);

  // Every step of every menu is paired with something to run, so the printed script is
  // as long as the flow it scripts rather than a summary of it.
  const pairs = FIRST_RUN_STEPS.length + SETUP_MENU.length + CONFIG_MANAGER_MENU.length + RUN_ACTIONS_MENU.length;
  const scripted = (script.stdout.match(/^\s+script: /gm) ?? []).length;
  assert.equal(scripted, pairs,
    `setup --non-interactive printed ${scripted} scriptable equivalents for ${pairs} steps and menu rows ` +
      `(${String(FIRST_RUN_STEPS.length)} first-run steps, ${String(SETUP_MENU.length)} setup rows, ` +
      `${String(CONFIG_MANAGER_MENU.length)} configuration-manager rows, ${String(RUN_ACTIONS_MENU.length)} run ` +
      'action rows), so some step cannot be scripted');
  assert.match(script.stdout, /The token is never echoed, never printed and never accepted on a command line/,
    'the printed script no longer states the token claim the README repeats');

  // The two flag names are in the module as the literals its usage is generated from.
  const module = read(path.join(ROOT, SETUP_MODULE));
  for (const flag of ['--help', '--non-interactive']) {
    assert.ok(module.includes(`'${flag}'`),
      `${SETUP_MODULE} no longer accepts ${flag}, though the registry advertises it`);
  }

  const refused = spawnSetup(['--not-a-flag'], path.join(temporary, 'refused-home'));
  assert.equal(refused.status, 2,
    `setup --not-a-flag exited ${String(refused.status)}; an argument the command does not know is a usage error`);
  assert.match(refused.stderr, /setup does not know "--not-a-flag"/,
    'the usage error does not name the offending argument');
});

// RS-TUI-FR-07: the README names the command, its masked token entry and its
// non-interactive escape. The flags the section documents are compared with the flags
// the registry advertises, so a third flag cannot reach the command without the page
// either naming it or the registry stopping advertising it.
test('the README names the command, the masked token entry and the non-interactive flag', () => {
  const documented = flatten(section(README, SETUP_HEADING));
  assert.ok(documented.includes('node src/cli.js setup'), `"## ${SETUP_HEADING}" never names the command`);

  const registered = listCommands().find((command) => command.name === 'setup');
  assert.ok(registered !== undefined, 'the registry registers no setup command');
  const advertised = (registered.usage.match(/--[a-z-]+/g) ?? []).slice().sort();
  assert.deepEqual([...new Set(documentedFlags(documented))].sort(), advertised,
    `"## ${SETUP_HEADING}" documents flags this build does not advertise for setup, or omits one it does; ` +
      `the registry advertises ${JSON.stringify(advertised)}`);
  assert.match(documented, /\*\*`--help`\*\* prints the steps of both visits and exits `0`/,
    `"## ${SETUP_HEADING}" does not say what --help prints`);
  assert.match(documented, /\*\*`--non-interactive`\*\* prints the scriptable equivalent of every step/,
    `"## ${SETUP_HEADING}" does not say that --non-interactive prints the scriptable equivalent of every step`);
  assert.match(documented, /read no file and write none/,
    `"## ${SETUP_HEADING}" does not say that the two flags read no file and write none`);

  // The token: masked, never echoed, stored in the credential file at the mode the
  // product's own constant holds, and never accepted on a command line.
  assert.match(documented, /\*\*The token is entered masked and is never echoed\.\*\*/,
    `"## ${SETUP_HEADING}" does not state that the token is entered masked and is never echoed`);
  assert.ok(documented.includes(`mode ${TICK}${octal(CREDENTIAL_FILE_MODE)}${TICK}`),
    `"## ${SETUP_HEADING}" does not name the credential mode ${octal(CREDENTIAL_FILE_MODE)}`);
  assert.ok(documented.includes(`\`${CREDENTIALS_FILE_NAME}\``),
    `"## ${SETUP_HEADING}" does not name ${CREDENTIALS_FILE_NAME}, the only file the token is stored in`);
  assert.match(documented, /\*\*No command takes a token on the command line\*\*/,
    `"## ${SETUP_HEADING}" does not state that no command takes a token on the command line`);

  // And the flow installs nothing that would make the six commands beside it moot.
  assert.match(documented, /installs no timer and no schedule/,
    `"## ${SETUP_HEADING}" does not state that the flow installs no timer and no schedule`);
  assert.match(documented, /not a replacement|It replaces nothing/,
    `"## ${SETUP_HEADING}" does not present the command as an alternative rather than a replacement`);
  assert.match(documented, /every command in that list still works exactly as documented/,
    `"## ${SETUP_HEADING}" does not say that every command of the six-command sequence still works as documented`);
});

// RS-TUI-FR-07: what the page says the command writes is checked against what the
// modules write. The claim is two files in the home and nothing else, so the section
// has to name the two, and the flow's own code has to be the thing that names them.
test('the files the README says setup writes are the two files the flow writes, and the archive is not one', () => {
  const documented = flatten(section(README, SETUP_HEADING));
  assert.match(documented, /\*\*A first run writes two files in the home and nothing else\.\*\*/,
    `"## ${SETUP_HEADING}" does not state what a first run writes`);
  for (const name of [CONFIG_FILE_NAME, CREDENTIALS_FILE_NAME]) {
    assert.ok(documented.includes(`\`${name}\``), `"## ${SETUP_HEADING}" does not name ${name} as a file it writes`);
  }
  // The archive is collected into, not written by this flow, so a page that listed it
  // here would be describing a different command.
  assert.ok(!documented.includes(DATABASE_FILE_NAME),
    `"## ${SETUP_HEADING}" names ${DATABASE_FILE_NAME} as a file setup writes; the flow writes the configuration ` +
      'and the credential only');
  assert.doesNotMatch(documented, /archive\.sqlite3-(?:wal|shm)/,
    `"## ${SETUP_HEADING}" names a write-ahead side file, which belongs to the archive rather than to this flow`);
  assert.match(documented, /writes nothing outside the home/,
    `"## ${SETUP_HEADING}" does not say that nothing is written outside the home`);
  // RS-TUI-C04: an interrupted run writes nothing partial, and the claim is checked
  // against the whole-file write the flow uses for both of its files.
  const wizard = wizardText();
  assert.match(documented, /an interruption leaves no half-written file/,
    `"## ${SETUP_HEADING}" does not say that an interruption leaves no half-written file`);
  assert.match(wizard, /renameSync\(temporary, target\)/,
    `${WIZARD_MODULE} no longer writes each file whole through a temporary file and a rename`);

  // The same two files in the code: the wizard writes the configuration it assembled,
  // hands the token to the credential writer, and reaches the check and the collection
  // through the command modules the six-command sequence names.
  assert.match(wizard, /writeWholeFile\(paths\.configPath, document\)/,
    `${WIZARD_MODULE} no longer writes the configuration it assembled to paths.configPath`);
  assert.match(wizard, /saveCredentials\(\{ credentialsPath: paths\.credentialsPath, token \}\)/,
    `${WIZARD_MODULE} no longer hands the typed token to the credential writer for paths.credentialsPath`);
  assert.match(wizard, /runStep\('config check'/, `${WIZARD_MODULE} no longer runs the existing configuration check`);
  assert.match(wizard, /runStep\('collect'/, `${WIZARD_MODULE} no longer offers the first collection`);
  for (const file of [SETUP_MODULE, WIZARD_MODULE, RUN_ACTIONS_MODULE]) {
    const module = read(path.join(ROOT, file));
    assert.ok(!module.includes(DATABASE_FILE_NAME) && !module.includes('databasePath'),
      `${file} names the archive, so the README's claim that a first run writes two files is no longer the whole ` +
        'truth');
  }

  // Every write the flow performs lands on one of those two home paths, and the only
  // home file its own source names by name is one of the two: a third file - a
  // schedule, a log, an export - would make the page's "and nothing else" false.
  for (const file of [WIZARD_MODULE, 'src/tui/config-manager.js']) {
    // The call sites only: `function writeWholeFile(target, text)` is the declaration
    // of the helper, not a file the flow writes.
    const targets = [...read(path.join(ROOT, file)).matchAll(/(?<!function )writeWholeFile\(\s*([^,]+),/g)]
      .map((match) => (match[1] ?? '').trim());
    assert.ok(targets.length > 0, `${file} has no writeWholeFile call, so the two-file claim cannot be read`);
    for (const target of targets) {
      assert.match(target, /^(?:paths\.)?(?:configPath|credentialsPath)$/,
        `${file} writes "${target}", which is neither ${CONFIG_FILE_NAME} nor ${CREDENTIALS_FILE_NAME}; the ` +
          'README says a first run writes those two files and nothing else');
    }
  }
  for (const file of [SETUP_MODULE, ...javascriptFilesIn(path.join(ROOT, 'src', 'tui'))]) {
    for (const match of read(path.join(ROOT, file)).matchAll(HOME_FILE_NAME)) {
      const name = (match[1] ?? '').toLowerCase();
      assert.ok(name === CONFIG_FILE_NAME || name === CREDENTIALS_FILE_NAME,
        `${file} names "${name}", a third file the guided flow would write or read; the README says a first run ` +
          `writes ${CONFIG_FILE_NAME} and ${CREDENTIALS_FILE_NAME} and nothing else`);
    }
  }
});

// RS-TUI-C02: the claim that the token is masked and that no command takes one on the
// command line is a security claim, so it is asserted against the code rather than
// trusted: the field must mute the terminal around the line it reads, and no command
// module may accept a token flag.
test('the token claim is the code own claim to make: a muted field, and no command that takes a token', () => {
  const prompts = read(path.join(ROOT, PROMPTS_MODULE));
  const start = prompts.indexOf('export async function promptSecret');
  assert.notEqual(start, -1, `${PROMPTS_MODULE} exports no promptSecret`);
  const secret = prompts.slice(start);
  assert.match(secret, /muteTerminal\(\)/,
    `promptSecret in ${PROMPTS_MODULE} does not mute the terminal, so the masked field the README claims would echo`);
  assert.match(secret, /nothing was echoed/i,
    `promptSecret in ${PROMPTS_MODULE} no longer states that nothing was echoed`);

  const wizard = read(path.join(ROOT, WIZARD_MODULE));
  assert.match(wizard, /promptSecret\(\{/, `${WIZARD_MODULE} does not read the token through the masked field`);
  assert.match(wizard, /secrets\.push\(token\)/,
    `${WIZARD_MODULE} does not add the typed token to the redaction list before anything else could print it`);

  for (const file of javascriptFilesIn(path.join(ROOT, 'src', 'commands'))) {
    assert.doesNotMatch(read(path.join(ROOT, file)), /--token\b/,
      `${file} names a --token flag, so the README's claim that no command takes a token on the command line is ` +
        'false');
  }
});

// RS-TUI-FR-05 and RS-TUI-FR-07: the returning visit's run actions are commands this
// build registers, and the README names the same ones. A menu row offering a command
// that does not exist would be a capability the page then repeats.
test('the run-actions menu offers only registered commands, and the README names those same commands', () => {
  const registered = new Set(registeredCommands().keys());
  /** @type {Set<string>} */
  const offered = new Set();
  for (const row of RUN_ACTIONS_MENU) {
    for (const match of row.matchAll(/node src\/cli\.js ([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)/g)) {
      // A row names the command and then describes it in words, so the invocation is
      // resolved the way a typed one is rather than read as a whole phrase.
      const resolved = resolveTyped((match[1] ?? '').split(' '), registered);
      assert.notEqual(resolved, undefined,
        `${RUN_ACTIONS_MODULE} offers "${match[1] ?? ''}", which resolves to no registered command; this build ` +
          `registers ${[...registered].sort().join(', ')}`);
      offered.add(/** @type {string} */ (resolved));
    }
  }
  assert.ok(offered.size > 0, `RUN_ACTIONS_MENU in ${RUN_ACTIONS_MODULE} names no command, so the menu is vacuous`);
  for (const name of offered) {
    assert.ok(registered.has(name), `${RUN_ACTIONS_MODULE} offers "${name}", which is no longer registered`);
  }

  // The menu is the three rows SETUP_MENU holds, and the page says three because the
  // exported list says three.
  const documented = flatten(section(README, SETUP_HEADING));
  assert.match(documented, new RegExp(`\\b${countEither(SETUP_MENU.length)}-row menu`),
    `"## ${SETUP_HEADING}" does not describe the returning menu as the ${String(SETUP_MENU.length)} rows ` +
      `SETUP_MENU holds in ${SETUP_MODULE}`);
  assert.match(documented, /configuration manager|change what this install watches/i,
    `"## ${SETUP_HEADING}" does not name what the first menu row opens`);
  for (const name of [...offered].sort()) {
    assert.ok(documented.includes(name),
      `"## ${SETUP_HEADING}" does not name \`${name}\`, which the run-actions menu in ${RUN_ACTIONS_MODULE} runs`);
  }
});

// RS-TUI-FR-07: the README still documents the six-command sequence the guided flow
// replaces nothing of, in the order and with the roles it always had, and every one of
// the six is a command this build registers.
test('the README still documents the six-command sequence, in order, and each one is registered', () => {
  const install = section(README, INSTALL_HEADING);
  const block = fencedBlocks(install).find((text) => text.includes('node src/cli.js config init'));
  assert.ok(block !== undefined, `"## ${INSTALL_HEADING}" no longer has the fenced block that lists the six commands`);
  const expected = SIX_COMMANDS.map((command) => `node src/cli.js ${command}`);
  const listed = block.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  assert.deepEqual(listed, expected, `"## ${INSTALL_HEADING}" lists ${JSON.stringify(listed)} where the ` +
    `six-command sequence is ${JSON.stringify(expected)}`);

  // Each command still carries its own numbered role sentence, so dropping a step from
  // the sequence means deleting a documented command rather than a line of prose.
  const flat = flatten(install);
  SIX_COMMANDS.forEach((command, index) => {
    assert.ok(flat.includes(`${String(index + 1)}. **\`${command}\`**`),
      `"## ${INSTALL_HEADING}" no longer documents step ${String(index + 1)} of the sequence as \`${command}\``);
  });

  const registered = new Set(registeredCommands().keys());
  for (const name of SIX_REGISTERED) {
    assert.ok(registered.has(name), `the six-command sequence names \`${name}\`, which this build does not register`);
  }

  // The guided alternative is offered as an alternative, and the two halves of the
  // story are joined by a link rather than left to be found.
  assert.match(flat, /\*\*Or let `setup` ask you\.\*\*/,
    `"## ${INSTALL_HEADING}" no longer offers the guided alternative beside the six commands`);
  assert.match(flat, /It replaces nothing/,
    `"## ${INSTALL_HEADING}" does not say the guided flow replaces nothing`);
  const anchor = SETUP_HEADING.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  assert.ok(flat.includes(`[Setup](#${anchor})`),
    `"## ${INSTALL_HEADING}" does not link to "## ${SETUP_HEADING}", so the two halves of the story are unjoined`);
});

// RS-FND-CONTRACT-02's inventory, bound here to the registry: every command the
// registry registers is listed exactly once in the README's table, every command the
// table names is registered, and the sentence that says how many are runtime matches
// what the table holds. `setup` is the command that made these disagree.
test('the README inventory and the registered command list agree, including how many are runtime', () => {
  const inventory = flatten(section(README, INVENTORY_HEADING));
  const registered = [...registeredCommands().keys()].sort();
  assert.ok(registered.includes('setup'), 'this build registers no setup command, so the inventory cannot list it');

  const names = new Set(registered);
  for (const name of names) {
    const occurrences = inventory.split(`node src/cli.js ${name}`).length - 1;
    assert.equal(occurrences, 1, `the README lists "${name}" ${occurrences} times in the inventory, which must be ` +
      'exactly once');
  }
  for (const match of inventory.matchAll(/node src\/cli\.js ([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)/g)) {
    const resolved = resolveTyped((match[1] ?? '').split(' '), names);
    assert.ok(resolved !== undefined,
      `the README inventory names "${match[1] ?? ''}", which resolves to no registered command`);
  }

  // The classification sentence: the runtime commands it names, the setup and
  // maintenance commands it names, and the two counts it spells in words.
  const runtime = [...(/are the runtime: ([^.]+)\./.exec(inventory)?.[1] ?? '')
    .matchAll(/`([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)`/g)].map((match) => match[1] ?? '');
  const maintenance = [...(/The other\s+\S+\s+-\s+([^.]+?)\s+-\s+are setup and maintenance/.exec(inventory)?.[1] ?? '')
    .matchAll(/`([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)`/g)].map((match) => match[1] ?? '');
  assert.ok(runtime.length > 0, `"## ${INVENTORY_HEADING}" names no runtime command in its classification sentence`);
  assert.ok(maintenance.length > 0, `"## ${INVENTORY_HEADING}" names no setup or maintenance command`);
  assert.ok(maintenance.includes('setup'),
    `"## ${INVENTORY_HEADING}" does not list \`setup\` among the setup and maintenance commands`);

  const runtimeSpelled = spelledCount(inventory, /(\w+) of the registered commands are the runtime/,
    `the classification sentence of "## ${INVENTORY_HEADING}"`);
  const otherSpelled = spelledCount(inventory, /The other\s+(\S+)\s+-/, `the "the other ..." sentence of "## ${INVENTORY_HEADING}"`);
  assert.equal(runtimeSpelled.count, runtime.length, `"## ${INVENTORY_HEADING}" says ${runtimeSpelled.word} commands ` +
    `are the runtime and names ${JSON.stringify(runtime)}`);
  assert.equal(otherSpelled.count, maintenance.length, `"## ${INVENTORY_HEADING}" says "the other ` +
    `${otherSpelled.word}" and names ${JSON.stringify(maintenance)}`);
  assert.deepEqual([...runtime, ...maintenance].sort(), registered,
    `"## ${INVENTORY_HEADING}" classifies ${JSON.stringify([...runtime, ...maintenance].sort())} and this build ` +
      `registers ${JSON.stringify(registered)}; every registered command is named exactly once as one or the other`);
  assert.deepEqual(runtime.filter((name) => maintenance.includes(name)), [],
    `"## ${INVENTORY_HEADING}" names a command as both runtime and setup`);

  // The authority stays the registry, as the inventory's own sentence claims.
  assert.match(inventory, /--help` is the authority on which of them your build registers/,
    `"## ${INVENTORY_HEADING}" no longer names the registry as the authority on which commands a build has`);
});

// RS-TUI-FR-07: the runbook has to say the guided flow can set the collection hour and
// installs no schedule, because the rest of that page is a schedule the reader writes
// themselves. The claim is checked against the modules too: nothing in the command or
// the flows it mounts may name a scheduler.
test('the scheduling runbook states that the flow sets the collection hour and installs no schedule', () => {
  const raw = read(SCHEDULING);
  const page = flatten(raw);
  assert.ok(page.includes('node src/cli.js setup'), 'the runbook never names the setup command');
  assert.match(page, /\*\*the flow sets the hour and installs no schedule\*\*/,
    'the runbook does not state that the flow sets the collection hour and installs no schedule');
  assert.match(page, /no crontab line, no launchd plist, no systemd unit, no timer of any kind/,
    'the runbook does not say which schedulers the flow installs nothing for');
  assert.match(page, /the operating system still owns the daily run/,
    'the runbook does not say the operating system still owns the daily run');

  // The key the runbook names is the schema's own key, and the flow saves that key.
  assert.ok(page.includes('collectionHourUtc'), 'the runbook no longer names collectionHourUtc');
  assert.match(read(path.join(ROOT, SCHEMA_MODULE)), /collectionHourUtc/,
    `${SCHEMA_MODULE} no longer carries the collectionHourUtc key the runbook tells a reader to set`);
  assert.match(read(path.join(ROOT, WIZARD_MODULE)), /validateConfig\(\{ enrolled, collectionHourUtc \}\)/,
    `${WIZARD_MODULE} no longer saves the collection hour it asked for`);

  // And nothing the flow mounts installs one: no scheduler is named by the command or
  // by any module it opens.
  for (const file of [SETUP_MODULE, ...javascriptFilesIn(path.join(ROOT, 'src', 'tui'))]) {
    assert.doesNotMatch(read(path.join(ROOT, file)),
      /\b(?:crontab|launchctl|launchd|systemctl|systemd|OnCalendar|StartCalendarInterval)\b/,
      `${file} names a scheduler, so the runbook's claim that the flow installs no schedule is no longer true`);
  }

  // The claims this page already made about scheduling survive the edit.
  assert.match(page, /embeds \*\*no timer and no scheduler\*\*/, 'the runbook lost its no-timer statement');
  assert.match(page, /daily operation is the operating system's job/, 'the runbook lost its statement about who owns the daily run');
  assert.match(raw, /\| `node src\/cli\.js setup` \|/,
    'the runbook names the setup command in prose but not in its table of commands');
});
