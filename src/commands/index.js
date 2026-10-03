/**
 * The one registry every subcommand is reached through.
 *
 * `src/cli.js` resolves a command line against this module and is the only
 * caller that dispatches, so adding a command means registering its name here
 * and nothing else. Later features append their own subcommands here.
 */

import { collect } from './collect.js';
import { configCheck, configInit } from './config.js';
import { dbBackup, dbMigrate, dbRestore, dbStatus, dbVerify } from './db.js';
import { discover } from './discover.js';
import { serve } from './serve.js';

export const EXIT_SUCCESS = 0;
export const EXIT_OPERATIONAL_FAILURE = 1;
export const EXIT_USAGE_ERROR = 2;

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/;

/**
 * @typedef {object} CommandContext
 * @property {string} name Name the command was registered under.
 * @property {string[]} args Every token that followed the command name, verbatim: a subcommand parses its own flags.
 * @property {NodeJS.ProcessEnv} env Process environment the run was started with.
 * @property {string} cwd Working directory the run was started in.
 * @property {(message: string) => void} print Writes one line to standard output.
 * @property {(message: string) => void} printError Writes one line to standard error.
 */

/**
 * @typedef {object} CommandDefinition
 * @property {string} summary One line describing the command; the usage listing prints it.
 * @property {string} [usage] Argument shape printed after the name in the usage listing, for example `[--force]`.
 * @property {(context: CommandContext) => number | void | Promise<number | void>} run
 *   The work itself. Returning 0, 1 or 2 sets the process exit code, and returning nothing means success.
 *   A thrown `UsageError` exits 2; any other thrown value exits 1.
 */

/**
 * @typedef {object} RegisteredCommand
 * @property {string} name
 * @property {string} summary
 * @property {string} usage Argument shape after the name, or an empty string when the command takes no argument.
 */

/**
 * @typedef {object} ResolvedCommand
 * @property {true} ok
 * @property {string} name
 * @property {CommandDefinition} definition
 * @property {string[]} args
 */

/**
 * @typedef {object} UnresolvedCommand
 * @property {false} ok
 * @property {string} requested The words the operator typed, before any flag.
 * @property {string[]} suggestions Registered names that sit under what was typed, as in `config init` under `config`.
 */

/** @typedef {ResolvedCommand | UnresolvedCommand} CommandResolution */

/** @type {Map<string, CommandDefinition>} */
const registry = new Map();

/**
 * A refusal caused by the command line rather than by the state of the archive.
 * Throwing one from `run` exits 2, which is what a mistyped flag must do.
 */
export class UsageError extends Error {
  /**
   * @param {string} message Cause and next action, naming the offending flag or argument.
   * @param {{ exitCode?: number }} [options] Exit code to use, defaulting to the usage-error code.
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = options.exitCode ?? EXIT_USAGE_ERROR;
  }
}

/**
 * Add one subcommand. The name is one or two lower-case words separated by a
 * single space, matching how a command is typed on the command line.
 * @param {string} name
 * @param {CommandDefinition} definition
 * @returns {void}
 */
export function registerCommand(name, definition) {
  if (!COMMAND_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `a command name is lower-case words separated by single spaces, so "collect" and "config init" both fit, ` +
        `but ${JSON.stringify(name)} does not`,
    );
  }
  const summary = definition.summary;
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new TypeError(`the command ${name} needs a one-line summary, because the usage listing prints it`);
  }
  if (typeof definition.run !== 'function') {
    throw new TypeError(`the command ${name} needs a run function to dispatch to`);
  }
  if (registry.has(name)) {
    throw new TypeError(`the command ${name} is already registered, so this registration would shadow it`);
  }
  registry.set(name, definition);
}

/**
 * Every registered command, ordered by name, for the usage listing.
 * @returns {RegisteredCommand[]}
 */
export function listCommands() {
  return [...registry.entries()]
    .map(([name, definition]) => ({
      name,
      summary: definition.summary,
      usage: definition.usage ?? '',
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * @param {string[]} tokens Command-line tokens, starting at the subcommand name.
 * @returns {number} How many leading tokens are a name word rather than a flag.
 */
function leadingNameWordCount(tokens) {
  let count = 0;
  while (count < tokens.length && !tokens[count].startsWith('-')) count += 1;
  return count;
}

/**
 * @returns {number} The most words a registered name has, so resolution never
 *   guesses a shape the registry cannot hold.
 */
function longestRegisteredName() {
  let longest = 0;
  for (const name of registry.keys()) {
    longest = Math.max(longest, name.split(' ').length);
  }
  return longest;
}

/**
 * @param {string} requested
 * @returns {string[]} Registered names that sit under what was typed.
 */
function commandsUnder(requested) {
  const prefix = `${requested} `;
  return [...registry.keys()].filter((name) => name.startsWith(prefix)).sort();
}

/**
 * Resolve the subcommand at the head of a command line. The longest registered
 * name wins, so `db migrate` beats `db`, and every token after it is the
 * command's own argument to parse.
 * @param {string[]} tokens
 * @returns {CommandResolution}
 */
export function resolveCommand(tokens) {
  const wordCount = Math.min(leadingNameWordCount(tokens), longestRegisteredName());
  for (let words = wordCount; words >= 1; words -= 1) {
    const name = tokens.slice(0, words).join(' ');
    const definition = registry.get(name);
    if (definition !== undefined) {
      return { ok: true, name, definition, args: tokens.slice(words) };
    }
  }
  const requested = tokens.slice(0, leadingNameWordCount(tokens)).join(' ');
  return { ok: false, requested, suggestions: commandsUnder(requested) };
}

registerCommand('discover', {
  summary: 'List reachable repositories and print ready-to-paste configuration lines.',
  usage: '[--json] [--include-organizations]',
  run: discover,
});
registerCommand('collect', {
  summary: 'Collect every enrolled repository now, or plan the run without contacting GitHub.',
  usage: '[--dry-run] [--repo owner/name]',
  run: collect,
});
registerCommand('config init', {
  summary: 'Create private configuration and credential templates.',
  usage: '[--force]',
  run: configInit,
});
registerCommand('config check', {
  summary: 'Validate local configuration and credentials without printing the token.',
  run: configCheck,
});
registerCommand('db migrate', {
  summary: 'Apply pending archive migrations forward-only.',
  run: dbMigrate,
});
registerCommand('db status', {
  summary: 'Print the database path and on-disk schema version beside the code version.',
  run: dbStatus,
});
registerCommand('db verify', {
  summary: 'Run SQLite integrity_check over the archive and exit non-zero on failure.',
  run: dbVerify,
});
registerCommand('db backup', {
  summary: 'Write a consistent copy of the archive to a chosen path.',
  usage: '<path>',
  run: dbBackup,
});
registerCommand('db restore', {
  summary: 'Load a backup over the archive, re-verify it and print per-table counts.',
  usage: '<path>',
  run: dbRestore,
});
registerCommand('serve', {
  summary: 'Start the read-only dashboard on 127.0.0.1 and print the URL it is listening on.',
  usage: '[--port 0]',
  run: serve,
});
