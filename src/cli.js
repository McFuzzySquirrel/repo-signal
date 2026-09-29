import process from 'node:process';

import {
  EXIT_OPERATIONAL_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  UsageError,
  listCommands,
  resolveCommand,
} from './commands/index.js';

/**
 * @typedef {import('./commands/index.js').CommandContext} CommandContext
 * @typedef {import('./commands/index.js').CommandDefinition} CommandDefinition
 */

const HELP_FLAGS = new Set(['-h', '--help']);
const MINIMUM_NAME_COLUMN = 12;

/**
 * Consume the global flags that appear before the subcommand name. A flag after
 * a name belongs to that subcommand, so `config init --force` reaches `config
 * init` with `--force` intact and `config` is not mistaken for a global flag.
 * @param {string[]} argv Arguments after the entry-point path.
 * @returns {{ help: boolean, rest: string[] }} Whether usage was asked for, and the tokens that follow the flags.
 */
function parseGlobalFlags(argv) {
  /** @type {string[]} */
  const rest = [];
  let help = false;
  let beforeSubcommand = true;
  for (const token of argv) {
    if (!beforeSubcommand || !token.startsWith('-')) {
      beforeSubcommand = false;
      rest.push(token);
      continue;
    }
    if (!HELP_FLAGS.has(token)) {
      throw new UsageError(
        `${token} is not a global flag of node src/cli.js; the only global flag is --help, ` +
          'and any other option belongs to the subcommand it follows',
      );
    }
    help = true;
  }
  return { help, rest };
}

/**
 * @param {unknown} error
 * @returns {string} The message an operator reads, never a stack trace.
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {number | null} The exit code the error asks for, or null when it asks for none.
 */
function requestedExitCode(error) {
  if (typeof error !== 'object' || error === null || !('exitCode' in error)) return null;
  const requested = /** @type {{ exitCode?: unknown }} */ (error).exitCode;
  if (
    requested === EXIT_SUCCESS ||
    requested === EXIT_OPERATIONAL_FAILURE ||
    requested === EXIT_USAGE_ERROR
  ) {
    return requested;
  }
  return null;
}

/**
 * @returns {string} The usage text, generated from the registry so it names the commands that exist.
 */
function usageText() {
  const commands = listCommands();
  const labels = commands.map((command) => (command.usage === '' ? command.name : `${command.name} ${command.usage}`));
  const column = labels.reduce((widest, label) => Math.max(widest, label.length), MINIMUM_NAME_COLUMN);
  const lines = [
    'Usage:',
    '  node src/cli.js <command> [options]',
    '  node src/cli.js --help',
    '',
    'Commands:',
  ];
  if (commands.length === 0) {
    lines.push('  none is registered in this build');
  } else {
    commands.forEach((command, index) => {
      const label = labels[index] ?? command.name;
      lines.push(`  ${label.padEnd(column)}  ${command.summary}`);
    });
  }
  lines.push(
    '',
    'Global flags:',
    '  -h, --help     Print this usage and exit 0',
    '',
    'Exit codes:',
    '  0  the command succeeded',
    '  1  the command failed operationally',
    '  2  the command line was a usage error',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * @param {unknown} error
 * @returns {number} Always the usage-error exit code, after printing the reason and the usage.
 */
function reportUsageError(error) {
  process.stderr.write(`error: ${describeError(error)}\n`);
  process.stderr.write(usageText());
  return EXIT_USAGE_ERROR;
}

/**
 * @param {number | void | null} outcome What the command returned.
 * @param {string} name
 * @returns {number} The exit code that outcome maps to.
 */
function exitCodeOf(outcome, name) {
  if (outcome === undefined || outcome === null) return EXIT_SUCCESS;
  if (outcome === EXIT_SUCCESS || outcome === EXIT_OPERATIONAL_FAILURE || outcome === EXIT_USAGE_ERROR) {
    return outcome;
  }
  if (typeof outcome !== 'number') {
    process.stderr.write(`error: ${name} returned a ${typeof outcome} instead of an exit code\n`);
  } else {
    process.stderr.write(`error: ${name} returned the unsupported exit code ${outcome}; a command returns 0, 1 or 2\n`);
  }
  return EXIT_OPERATIONAL_FAILURE;
}

/**
 * @param {string} name
 * @param {CommandDefinition} definition
 * @param {CommandContext} context
 * @returns {Promise<number>} The exit code the process ends with.
 */
async function invokeCommand(name, definition, context) {
  /** @type {number | void} */
  let outcome;
  try {
    outcome = await definition.run(context);
  } catch (error) {
    if (requestedExitCode(error) === EXIT_USAGE_ERROR) return reportUsageError(error);
    process.stderr.write(`error: ${name} failed: ${describeError(error)}\n`);
    return EXIT_OPERATIONAL_FAILURE;
  }
  return exitCodeOf(outcome, name);
}

/**
 * The composition root: parse the global flags, resolve the subcommand from the
 * registry, and map the outcome to 0 success, 1 operational failure or 2 usage
 * error. This is the only module that dispatches a command.
 * @param {string[]} argv Arguments after the entry-point path.
 * @returns {Promise<number>} The exit code the process ends with.
 */
async function run(argv) {
  /** @type {{ help: boolean, rest: string[] }} */
  let parsed;
  try {
    parsed = parseGlobalFlags(argv);
  } catch (error) {
    return reportUsageError(error);
  }
  if (parsed.help) {
    process.stdout.write(usageText());
    return EXIT_SUCCESS;
  }
  if (parsed.rest.length === 0) {
    return reportUsageError(new UsageError('no subcommand was named, so there is nothing to run'));
  }
  const resolution = resolveCommand(parsed.rest);
  if (!resolution.ok) {
    const detail =
      resolution.suggestions.length > 0
        ? `the commands it holds are ${resolution.suggestions.join(', ')}`
        : 'run node src/cli.js --help for the commands this build registers';
    return reportUsageError(new UsageError(`unknown command "${resolution.requested}"; ${detail}`));
  }
  return invokeCommand(resolution.name, resolution.definition, {
    name: resolution.name,
    args: resolution.args,
    env: process.env,
    cwd: process.cwd(),
    print: (message) => {
      process.stdout.write(`${message}\n`);
    },
    printError: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
}

process.exitCode = await run(process.argv.slice(2));
