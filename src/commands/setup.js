/**
 * `setup`: the interactive front door, and the composition root that mounts the flow.
 *
 * This module owns three things and nothing else: which visit a home gets, the two flags the
 * command accepts, and the exit code a visit's outcome maps to. Everything an operator reads
 * during a visit is printed by a module that already owns the work it describes - the first-run
 * flow, the configuration manager or the run-actions menu - and every value those modules read
 * reaches the product through the existing home resolver, configuration schema and loader,
 * credential writer, discovery command, collect command, report formatter and health read. This
 * command resolves no path of its own, parses no configuration document, validates no token,
 * redacts nothing the flows already redact, and contacts nothing (`RS-TUI-C03`).
 *
 * The decisions below have a wrong answer that looks right, so each is stated where it is made.
 *
 * The visit is chosen by looking at the home, never by a flag. The loader is asked for the
 * configuration; a home whose configuration file is missing gets the first-run flow, and every
 * other answer - a configuration that loads, or one the loader refuses - gets the returning visit.
 * A file that is present but broken is not a home nobody has set up, and the first-run flow would
 * refuse such a home before its first prompt anyway rather than replace a document it never showed
 * the operator.
 *
 * A standard input that is not a terminal is read rather than refused, and only a standard input
 * that carries nothing at all is refused. A pipe or a redirect is how this surface is driven
 * without a person, and a surface that could only be answered by a keyboard could neither be
 * scripted nor tested (`RS-A11Y-06`). What is refused is the case with no way to answer at all: a
 * run with no terminal and no script on standard input has nothing to read, so it prints the same
 * instructions the flow would have followed, names the flag that prints them without asking, and
 * exits 1 (`RS-TUI-FR-06`). The refusal happens before the home is resolved, because resolving the
 * home creates the directory.
 *
 * Both flags are answered before anything is touched. `--help` and `--non-interactive` print and
 * return 0 without resolving the home, reading a file or writing one, because a command that
 * documents itself must not leave a directory behind as a side effect of being asked what it does.
 *
 * One visit mounts one flow, and ends when that flow returns. The setup menu is offered once, and
 * whichever flow the operator opens finishes the visit. The alternative - returning to the setup menu
 * afterwards - is a better walk for a person at a terminal and a broken one for a script: a prompt
 * reader queues every line its stream offers, and a mounted flow closes the prompt session bound to
 * the stream it read when it returns, because a flow owns the lifetime of its own input, so the
 * answers a script had already delivered for the next question are discarded with that session.
 * Ending the visit is the one rule that holds on a terminal and in a script alike.
 *
 * The steps in the help and the script are read out of the modules that ask them. `FIRST_RUN_STEPS`,
 * `CONFIG_MANAGER_MENU` and `RUN_ACTIONS_MENU` are the lists those modules run, so help text written
 * beside them is a second statement of a sequence that can change; the only thing written here is
 * the command that does, without a question, what each step does with one. When a module gains or
 * loses a step, that pairing stops matching and the script refuses to print rather than describing
 * a step an operator cannot script.
 *
 * Every state is a word. There is no colour and no symbol in this command, in the flows it mounts or
 * in the prompts they draw from: rows, states, refusals and exit codes are all text, so the
 * transcript reads the same under `NO_COLOR` and on a dumb terminal (`RS-TUI-C05`).
 */

import process from 'node:process';
import { Readable, Writable } from 'node:stream';

import { loadConfig } from '../config/load.js';
import { redact } from '../credentials/redact.js';
import { resolveHomePaths } from '../paths.js';
import { TRAFFIC_PERMISSION } from '../supervision/errors.js';
import { CONFIG_MANAGER_MENU, runConfigManager } from '../tui/config-manager.js';
import { closePromptSession, promptChoice } from '../tui/prompts.js';
import { RUN_ACTIONS_MENU, runActions } from '../tui/run-actions.js';
import { FIRST_RUN_STEPS, runFirstRun } from '../tui/setup-wizard.js';
import { EXIT_OPERATIONAL_FAILURE, EXIT_SUCCESS, UsageError } from './index.js';

/** @typedef {import('./index.js').CommandContext} CommandContext */
/** @typedef {import('../paths.js').HomePathOptions} HomePathOptions */

/** The help flags this command accepts after its own name, as the entry point accepts them before one. */
const HELP_FLAGS = new Set(['-h', '--help']);

/** The flag that prints the scriptable equivalent of every step and asks nothing. */
const NON_INTERACTIVE_FLAG = '--non-interactive';

/**
 * The code `src/config/load.js` raises for a home that has no configuration file. It is written here
 * rather than imported because the loader publishes no constant for it, and a home with no
 * configuration is the one answer that decides which visit this command opens.
 */
const CONFIGURATION_MISSING = 'ERR_REPO_SIGNAL_CONFIG_MISSING';

/** Anything that could open an escape sequence, stripped from text that is not this module's own. */
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

/** Every control character, so one written line stays one written line. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * The menu a returning visit opens. Each row names the module it opens, because a row that named
 * nothing would leave an operator unable to reproduce the visit by hand. The dispatch below treats
 * the last row as the one that leaves, which is what the prompt's guarantee - it returns only a row
 * it printed - makes safe.
 * @type {readonly string[]}
 */
export const SETUP_MENU = Object.freeze([
  'Change what this install watches: open the configuration manager.',
  'Run an action: collect now, print the report or the collection health summary, or start the dashboard.',
  'Leave setup.',
]);

/**
 * What an operator runs instead of each first-run step, in the order `FIRST_RUN_STEPS` states the
 * steps. Two facts make some of these unavoidable as they are written: no command takes a token on
 * the command line, so the masked field has no command equivalent at all, and the configuration
 * check is both the step that saves and the step that validates, because the loader's own verdict on
 * the file is the only gate the product has.
 * @type {readonly string[]}
 */
const FIRST_RUN_EQUIVALENTS = Object.freeze([
  'node src/cli.js config check - prints the configuration and the credential verdicts with the resolved '
    + 'paths, and never the token. It exits 1 while config.json is missing, which is the state of a home '
    + 'before its first run.',
  'node src/cli.js config init - writes config.json and credentials.json into the home at mode 0600, and '
    + 'refuses to replace either one without --force.',
  `No command takes a token on the command line, so this step has nothing to run: write the token into `
    + 'credentials.json yourself as { "token": "..." } with the file at mode 0600, then run '
    + 'node src/cli.js config check to be told the file is a regular 0600 file with a non-empty token. '
    + 'Nothing prints the token, and no flag of any command reads one from you.',
  'node src/cli.js discover - lists every repository the token can reach with its Administration read '
    + 'state, applies the deny list, and makes the request this build is allowed to make. Add --json for '
    + 'the machine-readable payload the interactive flow reads.',
  'node src/cli.js discover prints ready-to-paste `enrolled` lines for the repositories that are not '
    + 'enrolled yet; paste the ones you want into config.json and run node src/cli.js config check. The '
    + 'interactive flow refuses an empty selection; the loader accepts an empty enrolled list, and an '
    + 'install that watches nothing collects nothing.',
  'Put "collectionHourUtc": 0 through 23 in config.json. It is the hour a collection belongs at; this '
    + 'product installs no timer and no schedule, so the operating system owns that.',
  'node src/cli.js config check - the loader is the gate, so validating the file with it is what a save '
    + 'through the schema would have to satisfy anyway.',
  'node src/cli.js config check - the same command as the previous step, because the check is the '
    + "loader's own verdict and there is no second way to ask for it.",
  'node src/cli.js collect - collects every enrolled repository once and exits.',
]);

/**
 * What an operator runs instead of each configuration-manager row, in the order
 * `CONFIG_MANAGER_MENU` states the rows. Every row is an edit to one file that the loader validates,
 * so the equivalent of every edit is the same file plus the one command that says whether it loads.
 * @type {readonly string[]}
 */
const CONFIG_MANAGER_EQUIVALENTS = Object.freeze([
  'node src/cli.js discover - the listing of reachable repositories; paste the lines you want into the '
    + '"enrolled" array in config.json.',
  'Delete that owner/name pair from the "enrolled" array in config.json.',
  'Set "enabled": { "owner/name": false } in config.json to stop collecting it and leave it enrolled. An '
    + 'enrolled repository with no entry of its own is enabled.',
  'Add or delete that owner/name pair in the "denyList" array in config.json. The deny list takes '
    + 'precedence over enrolment, and discovery filters against it.',
  'Set "collectionHourUtc" in config.json to an integer from 0 through 23.',
  'node src/cli.js discover - the refresh itself; it reads the deny list as the file stands now.',
  'Nothing to run. Leaving the menu writes nothing.',
]);

/**
 * What an operator runs instead of each run-actions row, in the order `RUN_ACTIONS_MENU` states the
 * rows. Every one of them is a command this build already registers, which is the whole point of the
 * menu: the request budget, the host allowlist, the state words and the exit codes are the command's
 * own because the command is what runs.
 * @type {readonly string[]}
 */
const RUN_ACTIONS_EQUIVALENTS = Object.freeze([
  'node src/cli.js collect - the only one of these that contacts GitHub.',
  'node src/cli.js report --repo owner/name',
  'node src/cli.js report - the most recent run, the roll-up across the enrolled set and one line per '
    + 'enrolled repository. It reads the archive and makes no request.',
  'node src/cli.js serve - prints the address it is listening on and stops with Ctrl-C.',
  'Nothing to run. Leaving the menu writes nothing.',
]);

/**
 * What an operator runs instead of each row of this command's own menu.
 * @type {readonly string[]}
 */
const SETUP_MENU_EQUIVALENTS = Object.freeze([
  'Edit config.json by hand and run node src/cli.js config check, which is the verdict the manager applies '
    + 'before it saves anything.',
  'Run one of the four commands the run-actions menu below lists directly.',
  'Nothing to run. Leaving setup writes nothing.',
]);

/**
 * @typedef {object} VisitStreams
 * @property {NodeJS.ReadableStream} input Read one line at a time from here, so a pipe can drive the visit.
 * @property {Writable} output Where every line a mounted module writes goes, line by line.
 * @property {() => void} close Releases everything this command attached to its own standard input.
 */

/**
 * @param {unknown} error
 * @returns {string} The failure's own message, redacted and held to one printable line, because the text
 *   reaches a terminal through this command rather than through a prompt that guards its own lines.
 */
function describeError(error) {
  return redact(error instanceof Error ? error.message : String(error))
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, ' ');
}

/**
 * @param {unknown} error
 * @returns {string | null} The stable code a `ConfigurationError` carries, or null for anything else.
 */
function configurationCode(error) {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = /** @type {{ code?: unknown }} */ (error).code;
  return typeof code === 'string' ? code : null;
}

/**
 * The command context as one writable stream. Every mounted module writes whole lines already, and a
 * line the prompts close on its own arrives as a lone newline, so the split here only has to hand
 * whole lines to the context and keep a partial tail until the next write.
 * @param {(message: string) => void} print The context's own output function.
 * @returns {Writable}
 */
function lineOutput(print) {
  /** @type {string} */
  let pending = '';
  return new Writable({
    /**
     * @param {Buffer | string} chunk
     * @param {BufferEncoding} _encoding
     * @param {(error?: Error | null) => void} callback
     * @returns {void}
     */
    write(chunk, _encoding, callback) {
      const lines = `${pending}${String(chunk)}`.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) print(line);
      callback();
    },
    /**
     * @param {(error?: Error | null) => void} callback
     * @returns {void}
     */
    final(callback) {
      if (pending !== '') {
        print(pending);
        pending = '';
      }
      callback();
    },
  });
}

/**
 * A pipe or a redirect as the readable stream the prompts read.
 *
 * The chunk that proved a script was arriving was read to tell a script from an empty stream, so it is
 * handed to this stream first and the rest of standard input follows it. Nothing here splits a line or
 * rewrites a byte: the prompt reader owns the line, because the module that asks a question owns what
 * ends one.
 * @param {NodeJS.ReadableStream} input Standard input, already resumed and past its first chunk.
 * @param {string} first The chunk that proved a script was arriving.
 * @returns {{ answers: Readable, close: () => void }}
 */
function scriptedAnswers(input, first) {
  /** @type {string[]} */
  const chunks = [first];
  let ended = false;
  /** @type {(() => void) | null} */
  let waiting = null;
  /** @returns {void} */
  const wake = () => {
    const resolve = waiting;
    waiting = null;
    resolve?.();
  };
  /** @param {Buffer | string} part @returns {void} */
  const onData = (part) => {
    chunks.push(String(part));
    wake();
  };
  /** @returns {void} */
  const onEnd = () => {
    ended = true;
    wake();
  };
  /** @param {unknown} error @returns {void} */
  const onError = (error) => {
    ended = true;
    chunks.push(String(error instanceof Error ? error.message : error));
    wake();
  };
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);
  input.on('error', onError);

  async function* everythingStandardInputHasToSay() {
    for (;;) {
      const chunk = chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (ended) return;
      await new Promise((resolve) => { waiting = () => { resolve(undefined); }; });
    }
  }

  return {
    answers: Readable.from(everythingStandardInputHasToSay()),
    close: () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      // Standard input would stay attached and resumed behind the visit, which is a
      // command that never exits; the stream is paused before the return.
      input.pause();
    },
  };
}

/**
 * Wait for the first thing standard input has to say, so a stream carrying a script can be told apart
 * from one with nothing on it. Nothing is lost: the chunk is handed to the stream the prompts read, so
 * the first answer of a script is still the first answer the visit receives.
 * @param {NodeJS.ReadableStream} input
 * @returns {Promise<string | null>} The first chunk, or null when standard input ended without one.
 */
function firstChunk(input) {
  return new Promise((resolve, reject) => {
    /** @returns {void} */
    const detach = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
    };
    /** @param {Buffer | string} chunk @returns {void} */
    const onData = (chunk) => {
      detach();
      input.pause();
      resolve(String(chunk));
    };
    /** @returns {void} */
    const onEnd = () => {
      detach();
      input.pause();
      resolve(null);
    };
    /** @param {unknown} error @returns {void} */
    const onError = (error) => {
      detach();
      input.pause();
      reject(error);
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

/**
 * Standard input as the mounted flows read it.
 *
 * A terminal is handed over untouched, because that is the stream the prompt primitives take their
 * terminal mode from. A pipe or a redirect is handed over as a readable stream, because the chunk that
 * proved a script was arriving has to reach the prompts before the rest of standard input follows it.
 * Standard input with nothing on it yields null, which the caller refuses.
 * @returns {Promise<VisitStreams | null>}
 */
async function visitStreams() {
  const output = lineOutput((message) => { process.stdout.write(`${message}\n`); });
  const stdin = process.stdin;
  if (stdin.isTTY === true) {
    return { input: stdin, output, close: () => { closePromptSession(stdin); } };
  }
  const chunk = await firstChunk(stdin);
  if (chunk === null) return null;
  const scripted = scriptedAnswers(stdin, chunk);
  return {
    input: scripted.answers,
    output,
    close: () => {
      closePromptSession(scripted.answers);
      scripted.close();
    },
  };
}

/**
 * Ask one question until it is answered or the visit is cancelled.
 *
 * No prompt asks twice: each one reads a line and returns either the answer or a refusal naming what
 * it expected. A refusal is a mistyped answer rather than a decision to stop - a stray Enter on the
 * menu is the case here - so the menu asks again, and the refusal is already on the record because the
 * prompt wrote it.
 * @template {{ ok: boolean, reason?: string }} S
 * @param {() => Promise<S>} ask One prompt, which returns its own typed result.
 * @returns {Promise<S>} The answer or the cancellation; a refusal never escapes.
 */
async function untilAnswered(ask) {
  for (;;) {
    const answer = await ask();
    if (answer.ok || answer.reason === 'cancelled') return answer;
  }
}

/**
 * Every step of both visits, printed from the lists the modules that ask them hold, so the help
 * cannot describe a sequence the flow does not run.
 * @param {CommandContext} context
 * @returns {void}
 */
function printSteps(context) {
  context.print('setup: what a first run asks, and what a returning visit opens.');
  context.print('');
  context.print('  node src/cli.js setup                     open the visit this home needs');
  context.print('  node src/cli.js setup --help              print these steps and exit 0');
  context.print(`  node src/cli.js setup ${NON_INTERACTIVE_FLAG}   print the scriptable equivalent of every step and exit 0,`);
  context.print('                                           reading no file and writing none');
  context.print('');
  context.print('A first run, on a home with no configuration file:');
  FIRST_RUN_STEPS.forEach((step, index) => { context.print(`  ${String(index + 1)}. ${step}`); });
  context.print('');
  context.print('A returning visit, on a home that already has a configuration file, opens this menu:');
  context.print(`  1) ${SETUP_MENU[0]}`);
  context.print('     which offers the configuration manager:');
  CONFIG_MANAGER_MENU.forEach((row, index) => { context.print(`     ${String(index + 1)}) ${row}`); });
  context.print(`  2) ${SETUP_MENU[1]}`);
  context.print('     which offers the run actions:');
  RUN_ACTIONS_MENU.forEach((row, index) => { context.print(`     ${String(index + 1)}) ${row}`); });
  context.print(`  3) ${SETUP_MENU[2]}`);
  context.print('');
  context.print('The visit is chosen by looking at the home, not by a flag. Every question is answered on one');
  context.print('line by typing the number it printed; q cancels the step; Ctrl-C ends the visit. One visit mounts');
  context.print('one of the two menus above and ends when it returns.');
}

/**
 * Refuse before printing half a script: a step with no command equivalent is a step an operator
 * cannot script, and printing it as though it were one is worse than saying so.
 * @param {readonly string[]} equivalents
 * @param {readonly string[]} steps
 * @param {string} owner What owns the step list.
 * @returns {void}
 */
function assertPaired(equivalents, steps, owner) {
  if (equivalents.length === steps.length) return;
  throw new Error(
    `${owner} asks ${String(steps.length)} step(s) and this command pairs ${String(equivalents.length)} of `
      + 'them with a scriptable equivalent; add or remove an entry so every step has one',
  );
}

/**
 * The scriptable equivalent of every step of both visits: what to run where a question would be asked.
 * Nothing here is read or written, so this branch of the command touches no file at all.
 * @param {CommandContext} context
 * @returns {void}
 */
function printScript(context) {
  assertPaired(FIRST_RUN_EQUIVALENTS, FIRST_RUN_STEPS, 'the first-run flow');
  assertPaired(CONFIG_MANAGER_EQUIVALENTS, CONFIG_MANAGER_MENU, 'the configuration manager');
  assertPaired(RUN_ACTIONS_EQUIVALENTS, RUN_ACTIONS_MENU, 'the run-actions menu');
  assertPaired(SETUP_MENU_EQUIVALENTS, SETUP_MENU, 'the setup menu');

  context.print('setup: the scriptable equivalent of every step, for a build with no terminal to answer in.');
  context.print('setup: this printed every step and read no file and wrote none; the visit itself is chosen by');
  context.print('looking at the home, so it is the home that says which of the two lists below applies.');
  context.print('');
  context.print(`A first run, on a home with no configuration file, and its ${String(FIRST_RUN_STEPS.length)} steps:`);
  FIRST_RUN_STEPS.forEach((step, index) => {
    context.print(`  ${String(index + 1)}. ${step}`);
    context.print(`     script: ${FIRST_RUN_EQUIVALENTS[index] ?? ''}`);
  });
  context.print('');
  context.print('A returning visit, on a home that already has a configuration file, opens this menu:');
  SETUP_MENU.forEach((row, index) => {
    context.print(`  ${String(index + 1)}) ${row}`);
    context.print(`     script: ${SETUP_MENU_EQUIVALENTS[index] ?? ''}`);
  });
  context.print('');
  context.print('The configuration manager that row 1 opens, row by row:');
  CONFIG_MANAGER_MENU.forEach((row, index) => {
    context.print(`  ${String(index + 1)}) ${row}`);
    context.print(`     script: ${CONFIG_MANAGER_EQUIVALENTS[index] ?? ''}`);
  });
  context.print('');
  context.print('The run-actions menu that row 2 opens, row by row:');
  RUN_ACTIONS_MENU.forEach((row, index) => {
    context.print(`  ${String(index + 1)}) ${row}`);
    context.print(`     script: ${RUN_ACTIONS_EQUIVALENTS[index] ?? ''}`);
  });
  context.print('');
  context.print('The token is never echoed, never printed and never accepted on a command line; it is read from');
  context.print('the 0600 credential file by the commands above. The collection hour above is an hour and not a');
  context.print('timer. The interactive flow asks for the token with the');
  context.print(`${TRAFFIC_PERMISSION} named in the prompt itself.`);
}

/**
 * The refusal a standard input that carries nothing earns: the same instructions the flow would have
 * followed, the next command to run instead, and the operational-failure code, because nothing was
 * asked and nothing was done.
 * @param {CommandContext} context
 * @returns {number}
 */
function refuseNonTerminal(context) {
  printSteps(context);
  context.printError('setup: standard input is not a terminal and carried nothing to answer with, so no question');
  context.printError('was asked, nothing was read and nothing was written');
  context.printError(`setup: run node src/cli.js setup ${NON_INTERACTIVE_FLAG} to print the scriptable`);
  context.printError('equivalent of every step without answering anything, or run node src/cli.js setup from a');
  context.printError('terminal to answer the questions as they are asked');
  return EXIT_OPERATIONAL_FAILURE;
}

/**
 * Which visit this home gets, asked of the loader rather than of a flag.
 * @param {CommandContext} context
 * @returns {'first run' | 'returning visit'}
 */
function visitFor(context) {
  try {
    loadConfig(/** @type {HomePathOptions} */ ({ env: context.env, cwd: context.cwd }));
  } catch (error) {
    if (configurationCode(error) === CONFIGURATION_MISSING) return 'first run';
  }
  return 'returning visit';
}

/**
 * The first run, mounted as it was written: the flow asks every question and the command reports how it
 * ended. A completed run exits 0 and names where to go next; a cancelled or failed run exits 1 with the
 * flow's own sentence, because neither wrote the configuration the visit was opened for.
 * @param {CommandContext} context
 * @param {VisitStreams} streams
 * @returns {Promise<number>}
 */
async function firstRun(context, streams) {
  const outcome = await runFirstRun({
    input: streams.input,
    output: streams.output,
    env: context.env,
    cwd: context.cwd,
  });
  if (outcome.status === 'completed') {
    context.print(
      `setup: the first run is complete with ${String(outcome.enrolled.length)} enrolled; run node src/cli.js setup `
      + 'again to change what this install watches, to collect now, or to start the dashboard',
    );
    return EXIT_SUCCESS;
  }
  context.printError(
    `setup: the first run ${outcome.status === 'cancelled' ? 'was cancelled' : 'did not finish'}: `
    + `${describeError(outcome.message)}; this visit ends with the operational-failure code`,
  );
  return EXIT_OPERATIONAL_FAILURE;
}

/**
 * @typedef {{ status: 'completed' | 'cancelled' | 'failed', message: string }} MountOutcome
 */

/**
 * @typedef {object} MountOptions
 * @property {NodeJS.ReadableStream} input
 * @property {NodeJS.WritableStream} output
 * @property {NodeJS.ProcessEnv} env
 * @property {string} cwd
 */

/**
 * Mount one flow and report how it ended. The three states the mounted flows return are mapped here
 * rather than by each of them, because the exit code is the command's contract and a flow has no
 * business choosing one for the command it is mounted in. A flow that came back is a success, including
 * one the operator walked away from deliberately; a cancelled or failed flow is an operational failure,
 * because something the operator asked for did not happen and a script reads the exit code, not the
 * transcript.
 * @param {CommandContext} context
 * @param {string} owner The row's own name for the flow that was mounted.
 * @param {(options: MountOptions) => Promise<MountOutcome>} flow
 * @param {MountOptions} options
 * @returns {Promise<number>}
 */
async function mount(context, owner, flow, options) {
  const outcome = await flow(options);
  if (outcome.status === 'completed') {
    context.print(`setup: ${owner} returned; this visit ends here and run node src/cli.js setup again for the other`);
    return EXIT_SUCCESS;
  }
  if (outcome.status === 'cancelled') {
    context.printError(`setup: ${owner} was cancelled: ${describeError(outcome.message)}; nothing further was written`);
    return EXIT_OPERATIONAL_FAILURE;
  }
  context.printError(
    `setup: ${owner} reported a failure above (${describeError(outcome.message)}), so this visit ends with the `
    + 'operational-failure code',
  );
  return EXIT_OPERATIONAL_FAILURE;
}

/**
 * The returning visit: this command's own menu over the two flows a returning visit reaches, which is the
 * whole reason it is a menu rather than a sequence. The row that leaves is the only one this command
 * answers itself; every other row mounts a flow and reports what came back, because a mounted flow owns
 * the input it read and nothing here can ask another question of it afterwards.
 * @param {CommandContext} context
 * @param {VisitStreams} streams
 * @param {string} home The resolved home, named once rather than re-resolved per menu.
 * @returns {Promise<number>}
 */
async function returningVisit(context, streams, home) {
  const options = {
    input: streams.input,
    output: streams.output,
    env: context.env,
    cwd: context.cwd,
  };
  context.print(`setup: the home at ${home} already has a configuration, so this is a returning visit`);
  context.print('setup: the configuration manager edits that file and saves it whole; the run actions are the');
  context.print('commands you could type by hand, run through the same context the entry point builds');
  const choice = await untilAnswered(() => promptChoice({
    input: streams.input,
    output: streams.output,
    message: 'What would you like to do?',
    choices: SETUP_MENU.map((label) => ({ label })),
  }));
  if (!choice.ok) {
    context.printError(`setup: stopped: ${describeError(choice.message)}; nothing was written by stopping`);
    return EXIT_OPERATIONAL_FAILURE;
  }
  if (choice.index === 1) return mount(context, 'the configuration manager', runConfigManager, options);
  if (choice.index === 2) return mount(context, 'the run-actions menu', runActions, options);
  // The prompt returns only a row it printed, so the row that leaves is the only case left.
  context.print('setup: left; leaving wrote nothing');
  return EXIT_SUCCESS;
}

/**
 * `setup`: open the visit this home needs.
 *
 * Two flags are accepted and nothing else. `--help` prints the steps of both visits and exits 0.
 * `--non-interactive` prints the scriptable equivalent of every step and exits 0, reading no file and
 * writing none. Any other argument, including a positional one, is a usage error, which the entry
 * point exits 2 on with the generated usage.
 * @param {CommandContext} context
 * @returns {Promise<number>} 0 when the visit ended as asked, 1 when it was refused, cancelled or failed.
 */
export async function setup(context) {
  /** @type {Set<string>} */
  const flags = new Set();
  for (const arg of context.args) {
    if (HELP_FLAGS.has(arg)) flags.add('--help');
    else if (arg === NON_INTERACTIVE_FLAG) flags.add(NON_INTERACTIVE_FLAG);
    else {
      throw new UsageError(
        redact(`setup does not know "${arg}"; run node src/cli.js setup --help for the two flags it accepts`),
      );
    }
  }
  // Both flags are answered before the home is resolved: resolving it creates the
  // directory, and a command that was asked what it does must not write anything.
  if (flags.has('--help')) printSteps(context);
  if (flags.has(NON_INTERACTIVE_FLAG)) printScript(context);
  if (flags.size > 0) return EXIT_SUCCESS;

  const streams = await visitStreams();
  if (streams === null) return refuseNonTerminal(context);
  try {
    let home;
    try {
      home = resolveHomePaths(/** @type {HomePathOptions} */ ({ env: context.env, cwd: context.cwd })).home;
    } catch (error) {
      context.printError(`setup: ${describeError(error)}; no visit was opened and nothing was written`);
      return EXIT_OPERATIONAL_FAILURE;
    }
    return visitFor(context) === 'first run'
      ? await firstRun(context, streams)
      : await returningVisit(context, streams, home);
  } finally {
    streams.close();
  }
}
