/**
 * The run-actions menu: the four things a maintainer does to an install they have already
 * configured, reached from the returning visit.
 *
 * Every action below runs a command the one registry already holds, resolved and dispatched
 * the way `src/cli.js` resolves and dispatches it, and handed the same context object the CLI
 * builds. That is what makes the request budget, the host allowlist, the credential loader,
 * the redaction, the state words and the exit codes the command's own rather than this menu's:
 * a copy of the logic is where all seven of them would start to drift (`RS-TUI-FR-05`).
 * Nothing in this module opens a socket, reads a credential, resolves a path or formats a
 * figure. `collect` owns the collection and the credential, `report` owns the report and the
 * health read it prints, and `serve` owns the server (`RS-TUI-C03`, `RS-C02`).
 *
 * Four decisions here have a wrong answer that looks right, so each is stated where it is made.
 *
 * One command module behind two report actions. The registry holds no health command, so the
 * health summary is delegated to the command that produces it rather than to a health reader
 * written here: the bare `report` prints the most recent run, the enrolled-set roll-up and one
 * line per enrolled repository, which is exactly what the health read in
 * `src/supervision/health.js` returned, and `--repo owner/name` adds one repository's recorded
 * coverage, its gap days and its change, which is the report. A second reader would be a second
 * vocabulary for the same states.
 *
 * The dashboard is started rather than awaited. `serve` resolves when it is signalled, so
 * awaiting it before asking anything would put the menu behind a server that never returns.
 * The action therefore watches the command's own printed output as it arrives: the address the
 * server reported is on the record before the operator is asked anything, no port is guessed,
 * and the answer stops the server through the stop path `serve` already owns.
 *
 * A failed action is a line, not an ending. The exit code is reported as the number the command
 * returned, the command's own message is printed unchanged, and the menu is offered again, so
 * one refused collection does not strand an operator who came here to read a report.
 *
 * Every state is a word. There is no colour and no symbol here or in the prompts this menu
 * draws from: the actions, the state words, the exit codes and the address are all text, so the
 * transcript reads the same under `NO_COLOR` and on a dumb terminal (`RS-TUI-C05`).
 */

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  EXIT_OPERATIONAL_FAILURE, EXIT_SUCCESS, EXIT_USAGE_ERROR, UsageError, resolveCommand,
} from '../commands/index.js';
import { loadConfig } from '../config/load.js';
import { redact } from '../credentials/redact.js';
import { resolveEnrollment } from '../enrollment/resolve.js';
import { resolveHomePaths } from '../paths.js';
import { closePromptSession, promptChoice, promptConfirm } from './prompts.js';

/** @typedef {import('./prompts.js').PromptChoice} PromptChoice */
/** @typedef {import('../commands/index.js').CommandContext} CommandContext */

/**
 * The menu in the order it is offered, so a caller that prints help text can name the
 * actions this module actually runs rather than a list written beside it that can drift.
 * Each row states the command it runs, because an action that named nothing would leave an
 * operator unable to reproduce it by hand. The numbers in the dispatch below are positions in
 * this array, counting from one.
 * @type {readonly string[]}
 */
export const RUN_ACTIONS_MENU = Object.freeze([
  'Collect now: run node src/cli.js collect once, for every enrolled repository.',
  'Print the report for one enrolled repository: run node src/cli.js report --repo owner/name, '
    + 'adding that repository\'s recorded coverage, its gap days and its change.',
  'Print the collection health summary: run node src/cli.js report, which prints the most recent run, '
    + 'the roll-up across the enrolled set and one line per enrolled repository. It reads the archive '
    + 'and contacts nothing.',
  'Start the dashboard: run node src/cli.js serve, which prints the address it is listening on and is '
    + 'stopped when this menu stops it.',
  'Return to the previous menu.',
]);

/**
 * @typedef {object} ActionRun
 * @property {string} name The registered command name that ran.
 * @property {string[]} args The arguments the registry resolved for it.
 * @property {number} exitCode Exactly what the command returned: 0, 1 or 2.
 * @property {string[]} out Every line it printed as output, in order.
 * @property {string[]} err Every line it printed as an error, in order.
 */

/**
 * @typedef {object} RunActionsOptions
 * @property {NodeJS.ReadableStream} input Read one line at a time from here, so a pipe can drive the menu.
 * @property {NodeJS.WritableStream} output Every line the menu and the commands it runs write goes here.
 * @property {NodeJS.ProcessEnv} [env] Environment the home, the configuration and the commands read,
 *   defaulting to `process.env`.
 * @property {string} [cwd] Directory a relative home is resolved against, defaulting to `process.cwd()`.
 */

/**
 * @typedef {{ status: 'completed', exitCode: 0, message: string, actions: number, failures: number }
 *   | { status: 'cancelled', exitCode: 1, message: string, actions: number, failures: number }
 *   | { status: 'failed', exitCode: 1, message: string, actions: number, failures: number }} RunActionsOutcome
 */

/** Anything that could open an escape sequence, stripped from a line that is not this module's own. */
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
/** Every control character, so one written line stays one written line. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * How long a stopping dashboard is given before the menu reports that it did not stop. The
 * signal this menu dispatches is the one the serve command already listens for, so the wait
 * ends immediately in every ordinary case; the bound exists because a menu that waits forever
 * on a server it cannot stop is worse than one that says so. The timer is unreferenced, so it
 * cannot hold the process open after the dashboard has stopped.
 */
const STOP_TIMEOUT_MS = 5_000;

/** A dashboard that did not report that it stopped, as distinct from one that ended. */
const NOT_STOPPED = Symbol('the dashboard did not report that it stopped');

/**
 * A single line with nothing in it that could move the cursor. Repository names and error text
 * come from a filesystem and from GitHub, so neither is something this module can vouch for;
 * the prompts module guards its own lines the same way.
 * @param {string} text
 * @returns {string}
 */
function plainLine(text) {
  return text.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHARACTER, ' ');
}

/**
 * @param {unknown} error
 * @returns {string} The failure's own message, redacted, for a line an operator reads.
 */
function safeMessage(error) {
  return redact(error instanceof Error ? error.message : String(error));
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} [pluralForm] The plural when the noun does not take a plain s.
 * @returns {string} `1 noun` or `3 nouns`, so a count and its unit read as one phrase.
 */
function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Ask one question until it is answered or the step is cancelled.
 *
 * No prompt asks twice: each one reads a line and returns either the answer or a refusal
 * naming what it expected. A refusal is a mistake in the answer rather than a decision to
 * stop, so the step asks again and the refusal stays on the record because the prompt already
 * wrote it. A cancellation is the operator's decision to stop the step.
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
 * The menu, the four actions and the one delegation path they share.
 *
 * Every field is set before the first prompt, so nothing in here re-resolves the home or
 * re-reads the environment: an action runs the command, and the command reads its own home
 * through `src/paths.js` and its own configuration through `src/config/load.js`.
 */
class RunActions {
  /**
   * @param {RunActionsOptions} options The streams and the environment the existing modules read.
   */
  constructor(options) {
    this.input = options.input;
    this.output = options.output;
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    /** @type {string | null} */
    this.home = null;
    this.actions = 0;
    this.failures = 0;
  }

  /**
   * One line of output, redacted and held to a single printable line, because everything
   * said here reaches the terminal through this stream rather than through the CLI's own.
   * @param {string} line
   * @returns {void}
   */
  say(line) {
    this.output.write(`${plainLine(redact(line))}\n`);
  }

  /**
   * @returns {string} What the visit ran, in one phrase.
   */
  actionSummary() {
    return this.actions === 0 ? 'no action was run' : `${plural(this.actions, 'action')} run`;
  }

  /**
   * The operator cancelled the menu itself. Nothing this menu does is half-written, so a
   * cancellation changes no file; it is still not a success, because the visit did not finish
   * what it opened.
   * @param {string} message What stopped the visit.
   * @returns {RunActionsOutcome}
   */
  cancelled(message) {
    this.say(`run actions stopped: ${message}; ${this.actionSummary()}`);
    return {
      status: 'cancelled',
      exitCode: EXIT_OPERATIONAL_FAILURE,
      message,
      actions: this.actions,
      failures: this.failures,
    };
  }

  /**
   * The operator asked to leave the menu. A visit that ran an action which failed is a
   * failure even when the operator walked away from it deliberately, because something they
   * asked for did not happen and the exit code is the only thing a script reads.
   * @returns {RunActionsOutcome}
   */
  left() {
    if (this.failures > 0) {
      this.say(`run actions: left the menu; ${this.actionSummary()}, and ${plural(this.failures, 'action')} `
        + 'reported a failure above');
      return {
        status: 'failed',
        exitCode: EXIT_OPERATIONAL_FAILURE,
        message: `${plural(this.failures, 'action')} reported a failure`,
        actions: this.actions,
        failures: this.failures,
      };
    }
    this.say(`run actions: left the menu; ${this.actionSummary()}`);
    return {
      status: 'completed',
      exitCode: EXIT_SUCCESS,
      message: 'the run-actions menu returned to the previous menu',
      actions: this.actions,
      failures: this.failures,
    };
  }

  /**
   * @param {string} message Why the visit could not start.
   * @returns {RunActionsOutcome}
   */
  failed(message) {
    this.say(`run actions: ${message}`);
    return {
      status: 'failed',
      exitCode: EXIT_OPERATIONAL_FAILURE,
      message,
      actions: this.actions,
      failures: this.failures,
    };
  }

  /**
   * State what this menu is over, before every menu. The home is named once, and the one line
   * that says which action can contact GitHub is here rather than implied, because every
   * other action here reads the archive and nothing else.
   * @returns {void}
   */
  reportState() {
    const enrolled = this.enrolled();
    this.say(`run actions: ${this.currentHome()}`);
    this.say(enrolled === null
      ? 'enrolled set: not read; each action below reports for itself what the loader made of it'
      : enrolled.length === 0
        ? 'enrolled set: empty, so there is nothing to collect and no repository to report on'
        : `enrolled set (${enrolled.length}): ${enrolled.join(', ')}`);
    this.say('Collect now is the only action that contacts GitHub; the rest read the archive and the '
      + 'dashboard reads only what it already holds');
  }

  /**
   * @returns {string} The resolved home. Only called once the visit has resolved one, which
   *   is why a refusal is reported before the first prompt rather than from here.
   */
  currentHome() {
    const home = this.home;
    if (home === null) throw new Error('the run-actions menu was asked for its home before it resolved one');
    return home;
  }

  /**
   * The repositories the product would collect, read through the existing loader and the
   * product's own enrolment resolver. `null` means the configuration could not be read, which
   * an action reports as a refusal naming the check rather than as an empty enrolled set: a
   * broken configuration and an install that watches nothing are different states.
   * @returns {string[] | null}
   */
  enrolled() {
    try {
      return resolveEnrollment(loadConfig({ env: this.env, cwd: this.cwd }));
    } catch {
      return null;
    }
  }

  /**
   * Run one registered command as this menu's action, through the context the CLI builds.
   *
   * The name and its arguments go through `resolveCommand` first, so the arguments are parsed
   * by the same resolution the entry point performs and a command that is not registered is a
   * refusal here rather than an import that quietly runs something the CLI no longer reaches.
   *
   * Output lines are written as the command prints them rather than after it returns, because
   * one command here does not return until it is stopped. Every line is collapsed to one
   * printable line and redacted, so a line that arrives on this stream rather than the CLI's
   * cannot carry a control character or a token-shaped value either (`RS-SEC-03`).
   * @param {string} name Registered command name.
   * @param {string[]} args The arguments that command receives.
   * @param {(line: string) => void} [onOutput] Called with each output line as it is printed.
   * @returns {Promise<ActionRun>}
   */
  async runCommand(name, args, onOutput) {
    const resolution = resolveCommand([name, ...args]);
    if (!resolution.ok) {
      throw new Error(`no command is registered under ${name}, so this menu cannot run it`);
    }
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    /** @param {string} message @returns {string} */
    const clean = (message) => plainLine(redact(message));
    /** @type {number | void} */
    let outcome;
    try {
      outcome = await resolution.definition.run(/** @type {CommandContext} */ ({
        name: resolution.name,
        args: resolution.args,
        env: this.env,
        cwd: this.cwd,
        print: (message) => {
          const line = clean(message);
          out.push(line);
          this.say(line);
          onOutput?.(line);
        },
        printError: (message) => {
          err.push(clean(message));
        },
      }));
    } catch (error) {
      // A `UsageError` is what the entry point would exit 2 on, and anything else is the
      // operational failure it would exit 1 on. Both are reported with the message the command
      // raised and never as a stack trace (`RS-C09`).
      if (error instanceof UsageError) {
        err.push(`error: ${clean(error.message)}`);
        return { name: resolution.name, args: resolution.args, exitCode: error.exitCode, out, err };
      }
      err.push(`error: ${resolution.name} failed: ${clean(safeMessage(error))}`);
      return {
        name: resolution.name, args: resolution.args, exitCode: EXIT_OPERATIONAL_FAILURE, out, err,
      };
    }
    return {
      name: resolution.name,
      args: resolution.args,
      exitCode: outcome === undefined || outcome === null ? EXIT_SUCCESS : Number(outcome),
      out,
      err,
    };
  }

  /**
   * Report what an action did, in the command's own vocabulary: its error lines are printed
   * exactly as the command wrote them, its exit code is reported as the number it returned,
   * and the menu is offered again. An exit code of 1 or 2 counts as a failure, because a menu
   * that called it a success would leave a script reading 0 for a collection that did not run.
   * @param {ActionRun} run
   * @returns {void}
   */
  report(run) {
    for (const line of run.err) this.say(line);
    this.actions += 1;
    const invocation = `node src/cli.js ${[run.name, ...run.args].join(' ')}`;
    if (run.exitCode === EXIT_SUCCESS) {
      this.say(`${run.name}: exited 0; the lines above are the lines ${invocation} printed`);
      return;
    }
    this.failures += 1;
    const state = run.exitCode === EXIT_USAGE_ERROR ? 'a usage error' : 'an operational failure';
    this.say(`${run.name}: exited ${run.exitCode}, which is ${state}; the lines above are the `
      + `command's own, and this menu is unchanged. Returning to the run menu.`);
  }

  /**
   * Collect now: the collect command, with none of the flags it accepts.
   *
   * The request budget, the credential read and the state words are the collect command's,
   * because the collect command is what runs. A menu that planned and collected itself would
   * be a second copy of the request policy, and the two would disagree about what a run costs.
   * @returns {Promise<ActionRun | null>}
   */
  async collectNow() {
    this.say('collect: running node src/cli.js collect now; the lines it prints are printed as they arrive');
    const run = await this.runCommand('collect', []);
    this.report(run);
    return run;
  }

  /**
   * Print the report for one enrolled repository.
   *
   * The repository is asked for because `--repo` needs a value, and it is offered from the
   * enrolled set the product's own resolver produced rather than from anything read here: a
   * report is not run for a repository this install does not watch, and the command refuses a
   * name that is not enrolled with exit 2 in any case.
   * @returns {Promise<ActionRun | null>}
   */
  async printReport() {
    const enrolled = this.enrolled();
    if (enrolled === null) {
      this.say('report: the configuration could not be read, so no repository was offered and no report '
        + 'was printed; run node src/cli.js config check to see what the loader made of it');
      return null;
    }
    if (enrolled.length === 0) {
      this.say('report: nothing is enrolled, so there is no repository to report on; the health summary '
        + 'reports on an empty enrolled set');
      return null;
    }
    const choice = await untilAnswered(() => promptChoice({
      input: this.input,
      output: this.output,
      message: 'Which repository should be reported? The report adds that repository\'s recorded coverage, '
        + 'its gap days and its change to the summary the archive holds.',
      choices: enrolled.map((name) => /** @type {PromptChoice} */ ({ label: name })),
    }));
    if (!choice.ok) {
      this.say(`report: ${choice.message}; no repository was reported on and nothing was printed`);
      return null;
    }
    const repo = enrolled[choice.index - 1];
    if (repo === undefined) {
      this.say(`report: refused: row ${String(choice.index)} named no enrolled repository, so nothing was printed`);
      return null;
    }
    const run = await this.runCommand('report', ['--repo', repo]);
    this.report(run);
    return run;
  }

  /**
   * Print the collection health summary for the enrolled set: the bare report command.
   *
   * That command reads the archive through the health read in `src/supervision/health.js` and
   * prints what it returned, so the state words and the roll-up here are the product's own. No
   * request is made and no credential is read, and that is the command's property rather than
   * a promise this menu makes on its behalf.
   * @returns {Promise<ActionRun>}
   */
  async printHealthSummary() {
    this.say('health: running node src/cli.js report; it reads the archive and makes no request');
    const run = await this.runCommand('report', []);
    this.report(run);
    return run;
  }

  /**
   * Stop the dashboard through the stop path `serve` already owns.
   *
   * The command resolves when it is signalled, so this dispatches that signal on `process`
   * rather than signalling the process: `process.kill` would also signal the operator's
   * terminal and Ctrl-C cannot be pressed where nothing is in the foreground. Nothing here
   * closes a socket or opens a port, so the server owner's module stays the only place that
   * does either.
   * @param {Promise<ActionRun>} serving The run that is still answering.
   * @returns {Promise<ActionRun | null>} The run the command ended with, or null when it did
   *   not report that it stopped.
   */
  async stopDashboard(serving) {
    this.say('dashboard: stopping it and returning to the run menu');
    process.emit('SIGINT');
    const stopped = /** @type {ActionRun | typeof NOT_STOPPED} */ (await Promise.race([
      serving,
      delay(STOP_TIMEOUT_MS, undefined, { ref: false }).then(() => NOT_STOPPED),
    ]));
    if (stopped === NOT_STOPPED) {
      // Waiting for a command that will not return would strand the menu behind a live server,
      // so the visit continues and says plainly that something is still answering.
      this.say('dashboard: the server did not report that it stopped, so it may still be answering; '
        + 'this menu cannot close it, and node src/cli.js serve stops with Ctrl-C');
      return null;
    }
    return stopped;
  }

  /**
   * Start the dashboard and offer a way back to the menu.
   *
   * The command is not awaited before the operator is asked anything: the serve command prints
   * the address it is listening on as its first output line, so the action waits for that line,
   * says that the dashboard is answering, and only then asks when it should stop. A command
   * that ended before printing anything is a start that failed, and its own message is what
   * says why. Nothing is drawn over the address and no address is invented for it
   * (`RS-TUI-C01`).
   * @returns {Promise<ActionRun | null>}
   */
  async startDashboard() {
    this.say('dashboard: running node src/cli.js serve; it prints the address it is listening on below');
    /** @type {() => void} */
    let announced = () => {};
    const reported = new Promise((resolve) => {
      announced = () => { resolve('listening'); };
    });
    const serving = this.runCommand('serve', [], announced);
    const first = await Promise.race([reported, serving.then(() => 'ended')]);

    if (first === 'ended') {
      // The command returned before it printed anything, so there is no address to report and
      // nothing to stop. Its own message says why.
      this.report(await serving);
      return null;
    }

    this.say('dashboard: the dashboard is answering now, at the address the server printed above. It reads '
      + 'the archive only, and it stops when this menu stops it; no request was made.');
    const answer = await untilAnswered(() => promptConfirm({
      input: this.input,
      output: this.output,
      message: 'Stop the dashboard and return to the run menu? It stops on any answer, because this menu '
        + 'cannot continue while the server holds the process open.',
      defaultValue: true,
    }));
    if (!answer.ok) {
      this.say(`dashboard: ${answer.message}; the dashboard is being stopped anyway, because the run menu `
        + 'cannot continue while it is answering');
    }
    const stopped = await this.stopDashboard(serving);
    if (stopped !== null) this.report(stopped);
    return stopped;
  }

  /**
   * Run the menu until the operator leaves it.
   * @returns {Promise<RunActionsOutcome>}
   */
  async visit() {
    try {
      this.home = resolveHomePaths({ env: this.env, cwd: this.cwd }).home;
    } catch (error) {
      return this.failed(`the home directory could not be resolved: ${safeMessage(error)}; `
        + 'no action was run and nothing was written');
    }
    for (;;) {
      this.reportState();
      const choice = await untilAnswered(() => promptChoice({
        input: this.input,
        output: this.output,
        message: 'What would you like to run?',
        choices: RUN_ACTIONS_MENU.map((label) => /** @type {PromptChoice} */ ({ label })),
      }));
      if (!choice.ok) return this.cancelled(choice.message);
      if (choice.index === RUN_ACTIONS_MENU.length) return this.left();
      switch (choice.index) {
        case 1:
          await this.collectNow();
          break;
        case 2:
          await this.printReport();
          break;
        case 3:
          await this.printHealthSummary();
          break;
        case 4:
          await this.startDashboard();
          break;
        default:
          // The prompt only returns a row it printed, so no other index can arrive.
          this.say('menu: no action matched that row, and nothing was run');
          break;
      }
    }
  }
}

/**
 * Open the run-actions menu on an install that is already configured.
 *
 * The menu changes nothing: it writes no file, takes no value and edits no configuration. Every
 * action it offers is a command an operator could have typed, and the exit code it returns is
 * 0 when the operator left the menu after actions that all succeeded, and 1 when the menu was
 * cancelled or an action reported a failure.
 * @param {RunActionsOptions} options The streams and the environment the existing modules read.
 * @returns {Promise<RunActionsOutcome>}
 */
export async function runActions(options) {
  const menu = new RunActions(options);
  try {
    return await menu.visit();
  } catch (error) {
    // A filesystem refusal, a module this menu composes, or a command that threw something
    // the entry point would also have reported as an operational failure. It is one line with
    // no credential material and never a stack trace.
    menu.say(`run actions failed: ${safeMessage(error)}`);
    return {
      status: 'failed',
      exitCode: EXIT_OPERATIONAL_FAILURE,
      message: safeMessage(error),
      actions: menu.actions,
      failures: menu.failures,
    };
  } finally {
    // The reader bound to this input stream keeps standard input resumed, which would hold the
    // process open after the last prompt.
    closePromptSession(options.input);
  }
}