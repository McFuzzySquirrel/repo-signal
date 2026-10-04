/**
 * The first-run setup flow: an empty home to a saved, checked configuration.
 *
 * Every value this flow collects reaches the product through a module that already
 * owns it. The home comes from `src/paths.js`; the two private templates come from
 * the existing configuration initialiser in `src/commands/config.js`, which is the
 * only place that preflights and writes them; the token comes from the masked field
 * in `src/tui/prompts.js` and goes straight into the credential file the refusing
 * credential loader reads; the repository list comes from the discovery command's
 * own client, policy and deny-list filtering; the configuration comes from
 * `src/config/schema.js` and is read back through `src/config/load.js`; the check is
 * the configuration-check command; and the offered first collection is the collect
 * command itself. This module resolves no path, parses no configuration document,
 * validates no token shape and contacts nothing (`RS-TUI-C03`).
 *
 * Three rules shape the code below.
 *
 * The token is read once and never reaches an output function. The value the masked
 * field returns goes to the credential writer and nowhere else, and everything this
 * flow prints afterwards is passed through the shared redaction helper with that
 * value in the secrets list, so an error raised below the writer cannot print it
 * either (`RS-TUI-C02`).
 *
 * Nothing durable is written before an answer is complete. The templates are only
 * written when the operator agrees, the credential is written from the value that
 * was typed rather than from a partially built step, and the configuration is
 * written last, after a selection exists, so an interrupted run leaves the previous
 * files exactly as it found them.
 *
 * The flow reports state in words. There is no colour and no symbol: what was
 * written, what was refused and what is next are lines of text, so the transcript
 * reads the same under `NO_COLOR` and on a dumb terminal (`RS-TUI-C05`).
 *
 * One dependency the plan names does not exist yet, and this module does not hide it.
 * `RS-TUI-C02` says the token is stored by the existing credential writer, but
 * `src/credentials/store.js` exports the read-only loader and no writer, and
 * `src/commands/config.js` keeps its template writer private. The token therefore
 * reaches disk through the one named seam `saveCredentials`, whose default writes the
 * file whole at mode 0600 with the same refusal discipline the template writer uses: a
 * whole document through a temporary file and a rename, `O_EXCL` and `O_NOFOLLOW` on
 * that temporary file, and no read of the target's contents. When the credential owner
 * adds a writer, the seam takes it and nothing else here changes.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { collect } from '../commands/collect.js';
import { configCheck, configInit } from '../commands/config.js';
import { discover } from '../commands/discover.js';
import { loadConfig, parseConfig } from '../config/load.js';
import { DEFAULT_COLLECTION_HOUR_UTC, validateConfig } from '../config/schema.js';
import { redact } from '../credentials/redact.js';
import { CREDENTIAL_FILE_MODE } from '../credentials/store.js';
import { resolveHomePaths } from '../paths.js';
import { TRAFFIC_PERMISSION } from '../supervision/errors.js';
import {
  closePromptSession, promptConfirm, promptSecret, promptSelection, promptText,
} from './prompts.js';

/** @typedef {import('../commands/index.js').CommandContext} CommandContext */
/** @typedef {import('../config/schema.js').Configuration} Configuration */
/** @typedef {import('../paths.js').HomePaths} HomePaths */
/** @typedef {import('./prompts.js').PromptChoice} PromptChoice */
/** @typedef {import('./prompts.js').TextValidator} TextValidator */

/**
 * The steps in the order this flow asks them, so the command's own help text and
 * the transcript cannot describe a sequence the flow does not run.
 * @type {readonly string[]}
 */
export const FIRST_RUN_STEPS = Object.freeze([
  'State the resolved home and whether a configuration already exists.',
  'Offer to write both private templates at mode 0600 through the existing configuration initialiser.',
  `Ask for the GitHub token in a masked field that echoes nothing, naming the ${TRAFFIC_PERMISSION} it needs.`,
  'Run discovery through the existing discovery command and report how many repositories are reachable.',
  'Present those repositories as a numbered multiple selection, which refuses an empty selection.',
  'Ask for the collection hour, defaulting to the configured value or zero.',
  'Save the configuration through the existing schema and read it back through the existing loader.',
  'Run the existing configuration check and print the lines it prints.',
  'Offer the first collection, which runs the collect command and prints exactly what it prints.',
]);

/**
 * The existing command modules this flow runs as steps, keyed by the name the
 * registry registers them under. A step that ran its own collection or its own
 * check would drift from the command, so every one of them is reached here by name.
 * @type {Record<string, (context: CommandContext) => number | void | Promise<number | void>>}
 */
const STEPS = {
  'config init': configInit,
  'config check': configCheck,
  discover,
  collect,
};

/**
 * @typedef {object} CommandRun
 * @property {number} exitCode What the command returned.
 * @property {string[]} out Lines it printed as output, in order.
 * @property {string[]} err Lines it printed as errors, in order.
 */

/**
 * @typedef {object} DiscoveredRepository
 * @property {string} name The owner/name pair GitHub serves.
 * @property {string} visibility `public`, `private`, or `unknown` as the listing reported it.
 * @property {boolean} enrolled Whether the configuration already named it.
 * @property {boolean} administrationRead Whether the token holds the Administration read permission on it.
 */

/**
 * @typedef {object} HomeState
 * @property {boolean} configurationPresent Whether a configuration file is there, whatever its contents say.
 * @property {string} configurationVerdict One line saying whether it is there, and what the loader made of it.
 * @property {boolean} credentialsPresent Whether a credential file is there. Its contents are never read.
 */

/**
 * @typedef {object} FirstRunOptions
 * @property {NodeJS.ReadableStream} input Standard input as one readable stream, so a pipe can drive the flow.
 * @property {NodeJS.WritableStream} output Every line the flow writes goes here.
 * @property {NodeJS.ProcessEnv} [env] Environment the home, the configuration and the commands read, defaulting to `process.env`.
 * @property {string} [cwd] Directory a relative home is resolved against, defaulting to `process.cwd()`.
 * @property {(request: { credentialsPath: string, token: string }) => void | Promise<void>} [saveCredentials]
 *   Where the typed token goes. The flow never writes the token itself without going
 *   through this, so the write that holds the one credential is a single named seam.
 */

/**
 * @typedef {{ status: 'completed', exitCode: 0, message: string, enrolled: string[] }
 *   | { status: 'cancelled', exitCode: 1, message: string, enrolled: string[] }
 *   | { status: 'failed', exitCode: 1, message: string, enrolled: string[] }} FirstRunOutcome
 */

/** Anything that could open an escape sequence, stripped from a line that is not this module's own. */
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
/** Every control character, so one written line stays one written line. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * A single line with nothing in it that could move the cursor. Repository names come
 * from GitHub and error text comes from a filesystem, so neither is something this
 * module can vouch for; the prompts module guards its own lines the same way.
 * @param {string} text
 * @returns {string}
 */
function plainLine(text) {
  return text.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHARACTER, ' ');
}

/**
 * @param {unknown} error
 * @param {readonly string[]} secrets
 * @returns {string} The failure's own message with every known secret and token-shaped
 *   value redacted; the caller prints it through `plainLine`, which is what keeps it to
 *   one line.
 */
function safeMessage(error, secrets) {
  return redact(error instanceof Error ? error.message : String(error), secrets);
}

/**
 * Whether a path is there, without following whatever it points at.
 * @param {string} target
 * @returns {'ok'|'missing'|'unreadable'}
 */
function existingPathSync(target) {
  try {
    lstatSync(target);
    return 'ok';
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

/**
 * What the resolved home holds, read through the modules that own each answer: the
 * loader decides whether a configuration is valid, and the credential file's presence
 * is a filesystem fact whose contents this flow never reads (`RS-C07`).
 * @param {HomePaths} paths
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {readonly string[]} secrets
 * @returns {HomeState}
 */
function readHomeState(paths, env, cwd, secrets) {
  const credentialsPresent = existingPathSync(paths.credentialsPath) !== 'missing';
  /** @type {HomeState} */
  const state = { configurationPresent: false, configurationVerdict: '', credentialsPresent };
  try {
    const configuration = loadConfig({ env, cwd });
    state.configurationPresent = true;
    state.configurationVerdict =
      `present at ${paths.configPath}; the existing loader accepted it with ${configuration.enrolled.length} enrolled`;
  } catch (error) {
    const code = /** @type {{ code?: unknown }} */ (error)?.code;
    if (code === 'ERR_REPO_SIGNAL_CONFIG_MISSING') {
      state.configurationVerdict = `not present at ${paths.configPath}`;
      return state;
    }
    state.configurationPresent = true;
    state.configurationVerdict =
      `present at ${paths.configPath} but the existing loader refused it: ${safeMessage(error, secrets)}`;
  }
  return state;
}

/**
 * Run one existing command as a step of this flow, with the operator watching the
 * same lines the command prints when it is run from the command line. Every line is
 * collapsed to one printable line and redacted, because a command line reaches the
 * terminal through this flow's output stream rather than through the CLI's own.
 * @param {string} name Registered command name.
 * @param {string[]} args The arguments that command receives.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {readonly string[]} secrets
 * @returns {Promise<CommandRun>}
 */
async function runStep(name, args, env, cwd, secrets) {
  const step = STEPS[name];
  if (step === undefined) throw new TypeError(`no command is registered under ${name}`);
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  /** @param {string} message @returns {string} */
  const clean = (message) => plainLine(redact(message, secrets));
  const outcome = await step({
    name,
    args,
    env,
    cwd,
    print: (message) => { out.push(clean(message)); },
    printError: (message) => { err.push(clean(message)); },
  });
  return {
    exitCode: outcome === undefined || outcome === null ? 0 : Number(outcome),
    out,
    err,
  };
}

/**
 * Write one file whole: a temporary file in the same directory, then a rename over
 * the target. A run interrupted before the rename leaves whatever was there
 * untouched, and a reader never sees half a document (`RS-TUI-C04`). The temporary
 * file is opened with `O_EXCL` and `O_NOFOLLOW` and held at 0600, because the
 * process umask may add bits and a path that is a symlink is not the file this flow
 * was pointed at.
 *
 * The rename replaces the entry rather than following it, so the credential this
 * writes cannot be redirected somewhere else, and replacing is what lets the flow
 * overwrite the placeholder `config init` wrote moments earlier with the enrolment
 * the operator just assembled.
 * @param {string} target Absolute path the home resolver produced.
 * @param {string} text The complete document.
 * @returns {void}
 */
function writeWholeFile(target, text) {
  if (existingPathSync(target) === 'unreadable') {
    throw new Error(`${target} could not be inspected; nothing was written`);
  }
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.new`,
  );
  /** @type {number | undefined} */
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      CREDENTIAL_FILE_MODE,
    );
    fchmodSync(descriptor, CREDENTIAL_FILE_MODE);
    writeFileSync(descriptor, text, 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor is already unusable; the temporary file is what matters.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to remove when the temporary file was never created.
    }
    throw new Error(
      `${target} could not be written (${/** @type {NodeJS.ErrnoException} */ (error).code ?? 'filesystem error'}); ` +
        'nothing was written, and whatever was there before is unchanged',
    );
  }
}

/**
 * The repositories the discovery command reported, read from the `--json` payload it
 * publishes for piping. The command owns the request, the host allowlist, the retry
 * policy and the deny-list filtering; this reads the answer it already produced and
 * asks nothing of GitHub itself.
 * @param {string[]} lines Everything the command printed as output.
 * @returns {DiscoveredRepository[]}
 */
function readDiscoveryPayload(lines) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(lines.join('\n'));
  } catch {
    throw new Error('discovery did not print the JSON payload it documents for piping, so no repository could be read');
  }
  const records = /** @type {{ repositories?: unknown }} */ (value ?? {}).repositories;
  if (!Array.isArray(records)) {
    throw new Error('the discovery payload carried no repository list, so no repository could be read');
  }
  return records.map((record) => {
    const entry = /** @type {{ name?: unknown, visibility?: unknown, enrolled?: unknown,
      administrationRead?: unknown }} */ (record ?? {});
    if (typeof entry.name !== 'string' || !entry.name.includes('/')) {
      throw new Error('a discovery entry carried no owner/name pair, so no repository list can be trusted');
    }
    return {
      name: entry.name,
      visibility: typeof entry.visibility === 'string' ? entry.visibility : 'unknown',
      enrolled: entry.enrolled === true,
      administrationRead: entry.administrationRead === true,
    };
  });
}

/**
 * One repository as discovery states it, in the discovery table's own words and the
 * same order of states, so a state has one spelling wherever the operator reads it.
 * @param {DiscoveredRepository} repository
 * @returns {string}
 */
function discoveryLine(repository) {
  return `${repository.name} visibility=${repository.visibility} enrolled=${repository.enrolled ? 'yes' : 'no'} `
    + `administration-read=${repository.administrationRead ? 'yes' : 'no'}`;
}

/**
 * Accept an hour the schema accepts, and refuse it with the schema's own words. The
 * prompt owns only the shape of a typed hour; the range, and the sentence explaining
 * it, belong to the configuration schema every command reads through, so a second
 * rule cannot disagree with it.
 * @param {number} configuredHour The hour already in the configuration.
 * @returns {TextValidator}
 */
function collectionHourValidator(configuredHour) {
  return (value) => {
    // An empty answer takes the stated default, which is the configured hour on a
    // first run that inherited a template, and zero when there was nothing to inherit.
    if (value === '') return { ok: true, value: String(configuredHour) };
    const candidate = /^\d{1,2}$/u.test(value) ? Number(value) : Number.NaN;
    try {
      validateConfig({ enrolled: [], collectionHourUtc: candidate });
    } catch (error) {
      return {
        ok: false,
        message: `${safeMessage(error, [])}; type a whole hour from 0 through 23, or press Enter for ${configuredHour}`,
      };
    }
    return { ok: true, value };
  };
}

/**
 * Ask one question until it is answered or the step is cancelled.
 *
 * No prompt asks twice: each one reads a line and returns either the answer or a
 * refusal naming what it expected. A refusal is a mistake in the answer rather than a
 * decision to stop - a stray Enter on the selection, an hour of 24, a word where a
 * number was asked for - so the flow asks again, and the refusal stays on the record
 * because the prompt already wrote it. A cancellation is the operator's decision to
 * stop, and it ends the run with whatever was written so far untouched.
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
 * @param {string} message What stopped the run, in one sentence.
 * @param {string[]} [enrolled] What the run had already enrolled when it stopped.
 * @returns {FirstRunOutcome}
 */
function failed(message, enrolled = []) {
  return { status: 'failed', exitCode: 1, message, enrolled };
}

/**
 * @param {string} message Why the run was cancelled.
 * @param {string[]} [enrolled] What the run had already enrolled before the cancellation.
 * @returns {FirstRunOutcome}
 */
function cancelled(message, enrolled = []) {
  return { status: 'cancelled', exitCode: 1, message, enrolled };
}

/**
 * The first run: from a home with no configuration to a written, checked one.
 *
 * The flow is a straight line of questions, and each question is asked again when the
 * answer is refused and ended when it is cancelled, so a mistyped hour costs a line of
 * the transcript rather than the run. An answer of `completed` means the configuration
 * was written, read back through the existing loader and reported by the existing
 * check; `cancelled` and `failed` both mean the run did not finish, and say which step
 * stopped it.
 *
 * @param {FirstRunOptions} options The streams, the environment the existing modules read, and where the token goes.
 * @returns {Promise<FirstRunOutcome>}
 */
export async function runFirstRun(options) {
  const { input, output } = options;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  /** @type {string[]} */
  const secrets = [];
  /** @param {string} line @returns {void} */
  const say = (line) => { output.write(`${plainLine(redact(line, secrets))}\n`); };
  /** @param {CommandRun} run @returns {void} */
  const echo = (run) => {
    for (const line of [...run.out, ...run.err]) say(line);
  };

  try {
    /** @type {HomePaths} */
    let paths;
    try {
      paths = resolveHomePaths({ env, cwd });
    } catch (error) {
      say(`home: the home directory could not be resolved: ${safeMessage(error, secrets)}`);
      say('first run: nothing was written');
      return failed('the home directory could not be resolved');
    }

    const state = readHomeState(paths, env, cwd, secrets);
    say(`home: ${paths.home}`);
    say(`configuration: ${state.configurationVerdict}`);
    say(`credential file: ${state.credentialsPresent
      ? `present at ${paths.credentialsPath}`
      : `not present at ${paths.credentialsPath}`}`);

    // A home that already has a configuration is not a first run, and replacing it
    // would destroy an enrolment this flow never showed the operator. The refusal
    // happens before any prompt, so nothing is asked and nothing is written.
    if (state.configurationPresent) {
      say(`first run: a configuration already exists at ${paths.configPath}, so this flow writes nothing`);
      return failed('a configuration already exists at this home');
    }

    const writeTemplates = await untilAnswered(() => promptConfirm({
      input,
      output,
      message: `Write both private templates into ${paths.home} at mode 0600: config.json and credentials.json?`,
      defaultValue: !state.credentialsPresent,
    }));
    if (!writeTemplates.ok) {
      say(`first run stopped: ${writeTemplates.message}; nothing further was written`);
      return cancelled(writeTemplates.message);
    }
    if (writeTemplates.value) {
      const init = await runStep('config init', [], env, cwd, secrets);
      echo(init);
      if (init.exitCode !== 0) {
        say('first run stopped: the templates were not written, so nothing further was written');
        return failed('the configuration initialiser refused to write the templates');
      }
    } else {
      say(`templates: skipped; this flow will create ${paths.credentialsPath} itself and write no commented template`);
      if (!state.credentialsPresent) {
        say('first run stopped: discovery reads the deny list from config.json, so this flow needs a configuration file');
        say('first run: nothing was written');
        return failed('this flow needs a configuration file before it can list repositories');
      }
    }

    const tokenAnswer = await untilAnswered(() => promptSecret({
      input,
      output,
      message: `GitHub token: paste a fine-grained personal access token that holds the ${TRAFFIC_PERMISSION} `
        + 'on the repositories you want to watch. It is written to the credential file only, and is never shown again.',
    }));
    if (!tokenAnswer.ok) {
      say(`first run stopped: ${tokenAnswer.message}; nothing further was written`);
      return cancelled(tokenAnswer.message);
    }
    // The value goes from here to the writer and to the redaction list. It is not
    // passed to `say`, to any prompt, or to any command context.
    const token = tokenAnswer.value;
    secrets.push(token);
    const saveCredentials = options.saveCredentials
      ?? (({ credentialsPath, token: value }) => {
        writeWholeFile(credentialsPath, `${JSON.stringify({ token: value }, null, 2)}\n`);
      });
    try {
      await saveCredentials({ credentialsPath: paths.credentialsPath, token });
    } catch (error) {
      say(`credential: not written: ${safeMessage(error, secrets)}`);
      say('first run stopped: discovery needs a credential file, so nothing further was written');
      return failed('the credential file could not be written');
    }
    say(`credential: a token was stored at ${paths.credentialsPath} (mode 0600); its value is not shown here`);

    const discovery = await runStep('discover', ['--json'], env, cwd, secrets);
    if (discovery.exitCode !== 0) {
      echo(discovery);
      say('first run stopped: discovery reported a failure, so no repository was enrolled and no configuration was written');
      return failed('discovery failed');
    }
    /** @type {DiscoveredRepository[]} */
    let repositories;
    try {
      repositories = readDiscoveryPayload(discovery.out);
    } catch (error) {
      say(`discovery: ${safeMessage(error, secrets)}`);
      return failed('the discovery payload could not be read');
    }
    // The JSON payload is not echoed: it exists to be read by this step. What the
    // operator reads instead is the count and one line per repository, in the
    // discovery table's own words, so a state has one spelling wherever it appears.
    say(`discovery: ${repositories.length} repositories reachable with this token; `
      + 'only the Administration read state is shown, never the token or its scopes');
    for (const repository of repositories) say(discoveryLine(repository));
    if (repositories.length === 0) {
      say('first run stopped: no repository is reachable, so there is nothing to enroll and no configuration was written');
      return failed('no repository is reachable with this token');
    }

    const selection = await untilAnswered(() => promptSelection({
      input,
      output,
      message: 'Which repositories should this install watch? Everything else stays out of the configuration.',
      choices: repositories.map((repository) => /** @type {PromptChoice} */ ({ label: repository.name })),
    }));
    if (!selection.ok) {
      say(`first run stopped: ${selection.message}; no configuration was written`);
      return cancelled(selection.message);
    }
    /** @type {string[]} */
    const enrolled = [];
    for (const row of selection.indices) {
      const repository = repositories[row - 1];
      // The prompt returns rows it printed, so an index outside the list cannot be
      // reached; the check is here so a gap is a refusal rather than an undefined name.
      if (repository === undefined) {
        say(`first run stopped: row ${String(row)} named no repository; no configuration was written`);
        return failed('the selection named a row that was never printed');
      }
      enrolled.push(repository.name);
    }

    // The hour the configuration on disk already carries is the default the prompt
    // states, so a first run that inherited a template keeps the value the template
    // already had instead of quietly resetting it. The schema's own default is the
    // fallback, and it is the value the schema reads in that key's absence.
    let configuredHour = DEFAULT_COLLECTION_HOUR_UTC;
    try {
      configuredHour = loadConfig({ env, cwd }).collectionHourUtc;
    } catch {
      // Discovery already proved this configuration loads, so reaching here means the
      // schema default is the honest value to state.
    }
    const hourAnswer = await untilAnswered(() => promptText({
      input,
      output,
      message: `Collection hour (UTC): the hour a scheduled run should collect in. An empty answer takes `
        + `${configuredHour}, which is what this configuration already holds. This flow installs no schedule; `
        + 'your operating system owns that.',
      validate: collectionHourValidator(configuredHour),
    }));
    if (!hourAnswer.ok) {
      say(`first run stopped: ${hourAnswer.message}; no configuration was written`);
      return cancelled(hourAnswer.message);
    }
    const collectionHourUtc = Number(hourAnswer.value);

    /** @type {Configuration} */
    let configuration;
    /** @type {string} */
    let document;
    try {
      configuration = validateConfig({ enrolled, collectionHourUtc });
      document = `${JSON.stringify(configuration, null, 2)}\n`;
      // The loader is the gate: a document it refuses is not written, so what lands on
      // disk is exactly what every other command will read.
      parseConfig(document);
    } catch (error) {
      say(`configuration: not written: ${safeMessage(error, secrets)}`);
      return failed('the configuration the flow assembled was refused by the loader');
    }
    try {
      writeWholeFile(paths.configPath, document);
    } catch (error) {
      say(`configuration: not written: ${safeMessage(error, secrets)}`);
      return failed('the configuration file could not be written');
    }
    say(`configuration: written at ${paths.configPath} (mode 0600): ${enrolled.length} enrolled `
      + `(${enrolled.join(', ') || 'none'}), collection hour ${String(collectionHourUtc)} UTC`);

    /** @type {Configuration} */
    let reloaded;
    try {
      reloaded = loadConfig({ env, cwd });
    } catch (error) {
      say(`configuration: written but the existing loader refused it: ${safeMessage(error, secrets)}`);
      return failed('the written configuration does not load', enrolled);
    }
    say(`configuration: read back through the existing loader with ${reloaded.enrolled.length} enrolled`);

    const check = await runStep('config check', [], env, cwd, secrets);
    echo(check);
    if (check.exitCode !== 0) {
      say('first run stopped: the configuration check did not pass, so no collection was started');
      return failed('the configuration check did not pass', enrolled);
    }

    const first = await untilAnswered(() => promptConfirm({
      input,
      output,
      message: 'Collect now? This runs node src/cli.js collect once, against the repositories just enrolled.',
      defaultValue: false,
    }));
    if (!first.ok) {
      say(`first run stopped: ${first.message}; the configuration is saved and checked`);
      return cancelled(first.message, enrolled);
    }
    if (first.value) {
      const run = await runStep('collect', [], env, cwd, secrets);
      echo(run);
      say(`first run: the collection reported ${run.exitCode === 0 ? 'success' : 'a failure'}; the lines above are `
        + 'the lines node src/cli.js collect printed for this home');
      if (run.exitCode !== 0) {
        return failed('the offered first collection did not succeed', enrolled);
      }
    } else {
      say('first collection: skipped; nothing was collected, and the collection made no request');
    }

    say(`first run: complete; the configuration is at ${paths.configPath} and the credential at ${paths.credentialsPath}`);
    return { status: 'completed', exitCode: 0, message: 'the first run completed', enrolled };
  } catch (error) {
    // A read failure, a filesystem refusal or a module the flow depends on can all
    // surface here. It is reported as one line with no credential material, never as a
    // stack trace, and the credential is redacted because it is in the secrets list.
    say(`first run failed: ${safeMessage(error, secrets)}`);
    return failed(safeMessage(error, secrets));
  } finally {
    // The reader bound to this input stream keeps standard input resumed, which would
    // hold the process open after the last prompt.
    closePromptSession(input);
  }
}