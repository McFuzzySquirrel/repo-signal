/**
 * The configuration manager: the menu a returning visit opens.
 *
 * This module changes what an existing install watches and refuses to be the thing that
 * decides what a first run should collect. The home comes from `src/paths.js`, the
 * configuration is read through `src/config/load.js`, every edit is checked against
 * `src/config/schema.js` and read back through the loader, and the repository list comes
 * from the discovery command in `src/commands/discover.js`, which owns the client, the
 * retry policy, the host allowlist and its own deny-list filtering. Nothing here parses a
 * configuration document into a private shape, resolves a path of its own, validates a
 * repository name with a rule of its own, or contacts GitHub (`RS-TUI-C03`).
 *
 * Four rules shape the code below, and each one exists because the alternative is a bug
 * nobody would find until a maintainer's data was wrong.
 *
 * Disabling is not removing. A repository the operator wants to stop collecting stays in
 * the enrolled set with `enabled: false`, because enrolment is the set they chose and the
 * flag is what the collector reads; dropping the name would silently discard that choice.
 *
 * The deny list wins, and it is shown before the enrolment is edited rather than after.
 * A repository the deny list names is never offered for removal, because removing it
 * would change nothing: the enrolment would still be there and still not be collected,
 * and the operator would be left believing otherwise. The names it holds are printed as
 * part of the edit, so the absence of a row is explained rather than mysterious.
 *
 * Each edit is saved on its own and saved whole. The schema normalizes the document, the
 * loader is the gate that decides whether it may be written, and the bytes reach disk
 * through a temporary file and a rename, so an interruption at any prompt leaves the
 * previous configuration exactly as it was (`RS-TUI-C04`). Nothing is buffered until the
 * operator leaves the menu, because a menu that only saves at the end cannot say which
 * of its edits survived.
 *
 * Every state is a word. There is no colour and no symbol: the enrolled set, the flags,
 * the deny list, the collection hour and each refusal are lines of text, so the
 * transcript reads the same under `NO_COLOR` and on a dumb terminal (`RS-TUI-C05`).
 *
 * Two boundaries this module cannot own, stated rather than hidden.
 *
 * The discovery list is filtered by the discovery command against the deny list as it
 * stood when the command ran, so a repository denied later in the same visit can still
 * be named by a list this manager already holds. The manager therefore re-checks the
 * deny list itself before it applies an edit, which is the case where a denied
 * repository could otherwise be enrolled from a stale list.
 *
 * No module in the tree exports a whole-file writer, so this one writes its own
 * configuration the way the first-run flow writes its own: a temporary file in the same
 * directory held at 0600, then a rename over the target. Extracting one shared writer is
 * a change to modules this task does not own; until then the two writers are held to the
 * same discipline and the same test.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { discover } from '../commands/discover.js';
import { loadConfig, parseConfig } from '../config/load.js';
import { validateConfig } from '../config/schema.js';
import { redact } from '../credentials/redact.js';
import { CREDENTIAL_FILE_MODE } from '../credentials/store.js';
import { resolveHomePaths } from '../paths.js';
import { closePromptSession, promptChoice, promptSelection, promptText } from './prompts.js';

/** @typedef {import('../config/schema.js').Configuration} Configuration */
/** @typedef {import('../paths.js').HomePaths} HomePaths */
/** @typedef {import('./prompts.js').PromptChoice} PromptChoice */
/** @typedef {import('./prompts.js').TextValidator} TextValidator */

/**
 * The menu in the order it is offered, so the command's help can name the actions this
 * module actually runs rather than a list written beside it that can drift. The numbers
 * in the dispatch below are positions in this array, counting from one.
 * @type {readonly string[]}
 */
export const CONFIG_MANAGER_MENU = Object.freeze([
  'Add repositories to the enrolled set from the discovery list.',
  'Remove a repository from the enrolled set.',
  'Turn a repository off or on without removing it from the enrolled set.',
  'Add a repository to the deny list, or remove a deny entry.',
  'Change the collection hour.',
  'Refresh the discovery list.',
  'Return to the previous menu.',
]);

/**
 * @typedef {object} DiscoveredRepository
 * @property {string} name The owner/name pair the discovery command reported.
 * @property {string} visibility `public`, `private`, or `unknown` as the listing reported it.
 * @property {boolean} administrationRead Whether the token holds the Administration read permission on it.
 *   The discovery command's own words, so a state has one spelling wherever it is read.
 */

/**
 * @typedef {object} ConfigManagerOptions
 * @property {NodeJS.ReadableStream} input Read one line at a time from here, so a pipe can drive the manager.
 * @property {NodeJS.WritableStream} output Every line the manager writes goes here.
 * @property {NodeJS.ProcessEnv} [env] Environment the existing modules read, defaulting to `process.env`.
 * @property {string} [cwd] Directory a relative home is resolved against, defaulting to `process.cwd()`.
 * @property {() => Promise<DiscoveredRepository[]>} [listRepositories]
 *   The discovery list, defaulting to the discovery command's own `--json` payload. It is a
 *   named seam so a test can present a list the command filtered against an older deny list.
 * @property {(request: { configPath: string, document: string, configuration: Configuration })
 *   => void | Promise<void>} [saveConfiguration]
 *   Where a validated configuration document goes. Defaults to the whole-file write below, so
 *   every durable write this module makes passes through one place a test can observe or fail.
 */

/**
 * @typedef {{ status: 'completed', exitCode: 0, message: string, enrolled: string[] }
 *   | { status: 'cancelled', exitCode: 1, message: string, enrolled: string[] }
 *   | { status: 'failed', exitCode: 1, message: string, enrolled: string[] }} ConfigManagerOutcome
 */

/** Anything that could open an escape sequence, stripped from a line that is not this module's own. */
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
/** Every control character, so one written line stays one written line. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * A single line with nothing in it that could move the cursor. Repository names come from
 * GitHub and messages come from a filesystem, so neither is something this module can
 * vouch for; the prompts module guards its own lines the same way.
 * @param {string} text
 * @returns {string}
 */
function plainLine(text) {
  return text.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHARACTER, ' ');
}

/**
 * @param {unknown} error
 * @returns {string} The failure's own message, redacted, for a line the operator reads.
 */
function safeMessage(error) {
  return redact(error instanceof Error ? error.message : String(error));
}

/**
 * Case-folded identity for repository names. The loader, the enrolment resolver and the
 * discovery command all compare case-insensitively, so a comparison made here has to be
 * the same one or the manager would deny a repository the product still collects.
 * @param {string} name
 * @returns {string}
 */
function identity(name) {
  return name.toLowerCase();
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
 * Write one file whole: a temporary file in the same directory, then a rename over the
 * target. A run interrupted before the rename leaves whatever was there untouched, and a
 * reader never sees half a document (`RS-TUI-C04`).
 *
 * The temporary file is opened with `O_EXCL` and `O_NOFOLLOW` and held at the one file
 * mode this tree exports, because the process umask may add bits and a path that is a
 * symlink is not the file this manager was pointed at. The rename replaces the entry
 * rather than following it, so the configuration cannot be redirected somewhere else.
 * @param {string} target Absolute path the home resolver produced.
 * @param {string} text The complete document.
 * @returns {void}
 */
function writeWholeFile(target, text) {
  if (existingPathSync(target) === 'unreadable') {
    throw new Error(`${target} could not be inspected; nothing was written`);
  }
  const temporary = path.join(
    path.dirname(target),
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
 * One repository in the discovery table's own words and the same order of states, so a
 * state has one spelling wherever the operator reads it.
 * @param {DiscoveredRepository} repository
 * @param {boolean} enrolled Whether the configuration this manager holds names it.
 * @returns {string}
 */
function repositoryLine(repository, enrolled) {
  return `${repository.name} visibility=${repository.visibility} enrolled=${enrolled ? 'yes' : 'no'} `
    + `administration-read=${repository.administrationRead ? 'yes' : 'no'}`;
}

/**
 * The repositories the discovery command reported, read from the `--json` payload it
 * publishes for piping. The command owns the request, the host allowlist, the retry
 * policy and its own deny-list filtering; this reads the answer it already produced and
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
    const entry = /** @type {{ name?: unknown, visibility?: unknown, administrationRead?: unknown }} */ (record ?? {});
    if (typeof entry.name !== 'string' || !entry.name.includes('/')) {
      throw new Error('a discovery entry carried no owner/name pair, so no repository list can be trusted');
    }
    return {
      name: entry.name,
      visibility: typeof entry.visibility === 'string' ? entry.visibility : 'unknown',
      administrationRead: entry.administrationRead === true,
    };
  });
}

/**
 * The document this manager saves: the configuration as it stands, with the enabled flags
 * rebuilt as one entry per enrolled repository in declared order.
 *
 * Rebuilding the map is what stops a key left behind by a removed repository from silently
 * disabling the same repository the next time it is enrolled, and it means the saved file
 * says exactly which flags belong to the enrolment rather than accumulating history.
 * @param {Configuration} configuration
 * @returns {Configuration}
 */
function withFlagsForEnrolledSet(configuration) {
  return {
    enrolled: [...configuration.enrolled],
    denyList: [...configuration.denyList],
    collectionHourUtc: configuration.collectionHourUtc,
    enabled: Object.fromEntries(
      configuration.enrolled.map((name) => [name, configuration.enabled[name] !== false]),
    ),
  };
}

/**
 * The deny entry that names a repository, or null when none does. A refusal names the
 * entry itself rather than a rule, because the operator has to be able to find it.
 * @param {readonly string[]} denyList
 * @param {string} name
 * @returns {string | null}
 */
function denyEntryFor(denyList, name) {
  return denyList.find((entry) => identity(entry) === identity(name)) ?? null;
}

/**
 * Accept an hour the schema accepts, and refuse it with the schema's own words. The prompt
 * owns only the shape of a typed hour; the range and the sentence explaining it belong to
 * the configuration schema every command reads through, so a second rule cannot disagree.
 * @param {number} configuredHour The hour already in the configuration.
 * @returns {TextValidator}
 */
function collectionHourValidator(configuredHour) {
  return (value) => {
    // An empty answer takes the stated default, which is the hour the configuration
    // already holds rather than a reset to zero.
    if (value === '') return { ok: true, value: String(configuredHour) };
    const candidate = /^\d{1,2}$/u.test(value) ? Number(value) : Number.NaN;
    try {
      validateConfig({ enrolled: [], collectionHourUtc: candidate });
    } catch (error) {
      return {
        ok: false,
        message: `${safeMessage(error)}; type a whole hour from 0 through 23, or press Enter for ${configuredHour}`,
      };
    }
    return { ok: true, value };
  };
}

/**
 * Ask one question until it is answered or the step is cancelled.
 *
 * No prompt asks twice: each one reads a line and returns either the answer or a refusal
 * naming what it expected. A refusal is a mistake in the answer rather than a decision to
 * stop - a menu number that is not listed, an empty selection, an hour of 24 - so the step
 * asks again and the refusal stays on the record because the prompt already wrote it. A
 * cancellation is the operator's decision to stop the step, and it returns to the menu
 * with nothing saved.
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
 * @param {number} count
 * @param {string} singular
 * @param {string} [pluralForm] The plural when the noun does not take a plain s.
 * @returns {string} `1 noun` or `3 nouns`, so a count and its unit read as one phrase.
 */
function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The menu, the edits and the save path. Every field is set before the first prompt, so
 * nothing in here needs to re-resolve the home or re-read the configuration: an edit is
 * applied to what the loader last accepted and the loader is asked again after the write.
 */
class ConfigurationManager {
  /**
   * @param {ConfigManagerOptions} options The streams, the environment the existing modules read, and the two seams.
   */
  constructor(options) {
    this.input = options.input;
    this.output = options.output;
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.write = options.saveConfiguration
      ?? (({ configPath, document }) => { writeWholeFile(configPath, document); });
    this.listRepositories = options.listRepositories ?? (() => this.discoverRepositories());
    /** @type {HomePaths | null} */
    this.paths = null;
    /** @type {Configuration | null} */
    this.configuration = null;
    /** @type {DiscoveredRepository[]} */
    this.repositories = [];
    this.listed = false;
    this.saved = 0;
    this.failures = 0;
  }

  /**
   * One line of output, redacted and held to a single printable line, because everything
   * the manager says reaches the terminal through this stream rather than through the CLI's.
   * @param {string} line
   * @returns {void}
   */
  say(line) {
    this.output.write(`${plainLine(redact(line))}\n`);
  }

  /**
   * The configuration as the loader last accepted it.
   * @returns {Configuration}
   */
  current() {
    const configuration = this.configuration;
    const paths = this.paths;
    if (configuration === null || paths === null) {
      throw new Error('the configuration manager was asked to edit before it opened a home');
    }
    return configuration;
  }

  /**
   * @returns {string[]} The enrolled set as it stands, for the outcome and the exit line.
   */
  enrolled() {
    return this.configuration === null ? [] : [...this.configuration.enrolled];
  }

  /**
   * @returns {string} What the visit did to the configuration, in one phrase.
   */
  savedSummary() {
    if (this.saved === 0) return 'no edit was saved';
    return `${plural(this.saved, 'edit')} saved`;
  }

  /**
   * @param {string} message What stopped the visit.
   * @returns {ConfigManagerOutcome}
   */
  cancelled(message) {
    this.say(`configuration manager stopped: ${message}; ${this.savedSummary()}; the cancelled step changed nothing`);
    return { status: 'cancelled', exitCode: 1, message, enrolled: this.enrolled() };
  }

  /**
   * The operator asked to leave the menu. A visit that could not save an edit is a failure
   * even when the operator walked away from it deliberately, because something they asked
   * for did not happen and the exit code is the only thing a script reads.
   * @returns {ConfigManagerOutcome}
   */
  left() {
    if (this.failures > 0) {
      this.say(`configuration manager: left the menu; ${this.savedSummary()}, and ${plural(this.failures, 'edit')} could not be saved`);
      return {
        status: 'failed',
        exitCode: 1,
        message: `${plural(this.failures, 'edit')} could not be saved`,
        enrolled: this.enrolled(),
      };
    }
    this.say(`configuration manager: left the menu; ${this.savedSummary()}`);
    return {
      status: 'completed',
      exitCode: 0,
      message: 'the configuration manager returned to the previous menu',
      enrolled: this.enrolled(),
    };
  }

  /**
   * @param {string} message Why the visit could not start.
   * @returns {ConfigManagerOutcome}
   */
  failed(message) {
    this.say(`configuration manager: ${message}`);
    return { status: 'failed', exitCode: 1, message, enrolled: this.enrolled() };
  }

  /**
   * Resolve the home and read the configuration through the existing loader. A manager
   * with no configuration to change has nothing to manage, and saying so is better than
   * creating a configuration as a side effect of asking what one holds.
   * @returns {Promise<ConfigManagerOutcome | null>} The refusal, or null when the manager may open its menu.
   */
  async open() {
    /** @type {HomePaths} */
    let paths;
    try {
      paths = resolveHomePaths({ env: this.env, cwd: this.cwd });
    } catch (error) {
      return this.failed(`the home directory could not be resolved: ${safeMessage(error)}; nothing was written`);
    }
    this.paths = paths;
    try {
      this.configuration = loadConfig({ env: this.env, cwd: this.cwd });
    } catch (error) {
      const code = /** @type {{ code?: unknown }} */ (error)?.code;
      if (code === 'ERR_REPO_SIGNAL_CONFIG_MISSING') {
        return this.failed(`there is no configuration at ${paths.configPath}, so this manager has nothing to change and wrote nothing`);
      }
      return this.failed(`the existing loader refused the configuration at ${paths.configPath}: ${safeMessage(error)}; nothing was written`);
    }
    return null;
  }

  /**
   * State the configuration as it stands, before every menu. The enrolled set is printed
   * with each repository's flag as a word, the deny list with its entries, and the
   * collection hour with the sentence that says who owns the schedule: this flow sets a
   * value in a file and installs nothing (`RS-NF-03`).
   * @returns {void}
   */
  reportState() {
    const configuration = this.current();
    const paths = this.currentPaths();
    this.say(`configuration: ${paths.configPath}`);
    if (configuration.enrolled.length === 0) {
      this.say('enrolled: none; nothing is collected by this install yet');
    } else {
      const listed = configuration.enrolled.map((name) => (
        `${name} (${configuration.enabled[name] === false ? 'disabled' : 'enabled'})`
      ));
      this.say(`enrolled (${configuration.enrolled.length}): ${listed.join(', ')}`);
      const blocked = configuration.enrolled.filter((name) => denyEntryFor(configuration.denyList, name) !== null);
      if (blocked.length > 0) {
        this.say(`enrolled and denied (${blocked.length}): ${blocked.join(', ')}; the deny list takes precedence, so these are not collected`);
      }
    }
    this.say(configuration.denyList.length === 0
      ? 'deny list: empty'
      : `deny list (${configuration.denyList.length}): ${configuration.denyList.join(', ')}`);
    this.say(`collection hour: ${configuration.collectionHourUtc} UTC; this manager sets the hour only and installs no schedule, your operating system owns that`);
    this.say(this.listed
      ? `discovery list: ${this.repositories.length} repositories reachable in this visit`
      : 'discovery list: not fetched in this visit yet');
  }

  /**
   * @returns {HomePaths} The resolved home. Only called once the manager has opened it.
   */
  currentPaths() {
    const paths = this.paths;
    if (paths === null) throw new Error('the configuration manager was asked for its home before it resolved one');
    return paths;
  }

  /**
   * Run the discovery command with its own `--json` flag and capture what it printed. The
   * command owns the request, the credential, the allowlist and the policy; this only reads
   * the lines it produced.
   * @returns {Promise<{ exitCode: number, out: string[], err: string[] }>}
   */
  async runDiscoveryCommand() {
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    const exitCode = await discover({
      name: 'discover',
      args: ['--json'],
      env: this.env,
      cwd: this.cwd,
      print: (message) => { out.push(plainLine(redact(message))); },
      printError: (message) => { err.push(plainLine(redact(message))); },
    });
    return { exitCode, out, err };
  }

  /**
   * The default discovery list: what the discovery command published for piping, read from
   * the lines it printed. Its failure is raised rather than returned, so the caller has one
   * place to report every way the list could not be had.
   * @returns {Promise<DiscoveredRepository[]>}
   */
  async discoverRepositories() {
    const run = await this.runDiscoveryCommand();
    if (run.exitCode !== 0) {
      for (const line of run.err) this.say(line);
      throw new Error(`the discovery command reported exit ${run.exitCode}, so no repository list was read`);
    }
    return readDiscoveryPayload(run.out);
  }

  /**
   * State the reachable repositories the way the discovery table states them, with the
   * enrolment answered by the configuration this manager holds rather than by the payload,
   * which was filtered against whatever the configuration held when the command ran.
   * @returns {void}
   */
  reportRepositories() {
    const configuration = this.current();
    const enrolled = new Set(configuration.enrolled.map(identity));
    this.say(`discovery: ${plural(this.repositories.length, 'repository', 'repositories')} reachable; only the Administration read state is shown, never the token or its scopes`);
    for (const repository of this.repositories) {
      this.say(repositoryLine(repository, enrolled.has(identity(repository.name))));
    }
  }

  /**
   * Fetch the discovery list and hold it for the visit. The seam is the only way this
   * module learns what is reachable, so a failure is reported as one line and the visit
   * keeps whatever it already knew.
   * @returns {Promise<boolean>} Whether a list is now held.
   */
  async fetchRepositories() {
    /** @type {DiscoveredRepository[]} */
    let parsed;
    try {
      parsed = await this.listRepositories();
    } catch (error) {
      this.say(`discovery: ${safeMessage(error)}`);
      return false;
    }
    this.repositories = parsed;
    this.listed = true;
    this.reportRepositories();
    return true;
  }

  /**
   * @returns {Promise<boolean>} Whether a discovery list is held, fetching one only when the visit has none.
   */
  async ensureRepositories() {
    if (this.listed) return true;
    this.say('discovery: fetching the repository list; the discovery command owns the request and the policy');
    return this.fetchRepositories();
  }

  /**
   * @returns {Promise<void>}
   */
  async refreshDiscovery() {
    const held = this.repositories;
    const wasListed = this.listed;
    this.repositories = [];
    this.listed = false;
    if (await this.fetchRepositories()) {
      this.say(`discovery: refreshed; ${plural(this.repositories.length, 'repository', 'repositories')} reachable`);
      return;
    }
    // A failed refresh keeps the list the visit already held, because the operator has
    // already read it and replacing it with nothing would be a second, quieter change.
    this.repositories = held;
    this.listed = wasListed;
    this.say('discovery: the refresh failed, so the list this visit already held is unchanged and nothing was saved');
  }

  /**
   * Save one edit, or refuse it. The schema normalizes the document, the loader is the gate
   * that decides whether it may be written at all, and the loader is asked again afterwards
   * so the manager continues from what was accepted rather than from what was intended.
   * @param {Configuration} next The configuration after this edit.
   * @param {string} what One line describing the edit, for the transcript.
   * @returns {Promise<boolean>} Whether the edit reached disk.
   */
  async save(next, what) {
    const paths = this.currentPaths();
    /** @type {Configuration} */
    let normalized;
    /** @type {string} */
    let document;
    try {
      normalized = validateConfig(next);
      document = `${JSON.stringify(normalized, null, 2)}\n`;
      // The loader is the gate: a document it refuses is never written, so what lands on
      // disk is exactly what every other command will read.
      parseConfig(document);
    } catch (error) {
      this.failures += 1;
      this.say(`configuration: not saved: ${safeMessage(error)}; ${paths.configPath} is unchanged`);
      return false;
    }
    try {
      await this.write({ configPath: paths.configPath, document, configuration: normalized });
    } catch (error) {
      this.failures += 1;
      this.say(`configuration: not saved: ${safeMessage(error)}; ${paths.configPath} is unchanged`);
      return false;
    }
    /** @type {Configuration} */
    let reloaded;
    try {
      reloaded = loadConfig({ env: this.env, cwd: this.cwd });
    } catch (error) {
      this.failures += 1;
      this.say(`configuration: saved at ${paths.configPath}, but the existing loader refused it: ${safeMessage(error)}`);
      return false;
    }
    this.configuration = reloaded;
    this.saved += 1;
    this.say(`configuration: saved at ${paths.configPath} (mode 0600): ${what}`);
    this.say(`configuration: the existing loader read it back with ${plural(reloaded.enrolled.length, 'enrolled repository')}`
      + ` (${reloaded.enrolled.join(', ') || 'none'}), ${reloaded.denyList.length} deny entries, collection hour ${reloaded.collectionHourUtc} UTC`);
    return true;
  }

  /**
   * Add repositories to the enrolled set from the discovery list. Only repositories that
   * are neither enrolled nor denied are offered, and the deny list is applied once more
   * when the selection is applied, so the refusal does not depend on the rows having been
   * filtered: the list this visit holds was fetched against the deny list as it stood
   * before any edit made here.
   * @returns {Promise<void>}
   */
  async addEnrollment() {
    const configuration = this.current();
    if (!(await this.ensureRepositories())) return;
    const enrolled = new Set(configuration.enrolled.map(identity));
    const denied = new Set(configuration.denyList.map(identity));
    const offer = this.repositories.filter((repository) => (
      !enrolled.has(identity(repository.name)) && !denied.has(identity(repository.name))
    ));
    const already = this.repositories.filter((repository) => enrolled.has(identity(repository.name)));
    const blocked = this.repositories.filter((repository) => denied.has(identity(repository.name)));
    if (already.length > 0) {
      this.say(`already enrolled (${already.length}): ${already.map((repository) => repository.name).join(', ')}`);
    }
    for (const repository of blocked) {
      const entry = denyEntryFor(configuration.denyList, repository.name);
      this.say(`denied: ${repository.name} is named by the deny entry ${String(entry)}; remove that entry before enrolling it`);
    }
    if (offer.length === 0) {
      this.say('add: nothing to offer; every reachable repository is already enrolled or on the deny list, and nothing was saved');
      return;
    }
    const selection = await untilAnswered(() => promptSelection({
      input: this.input,
      output: this.output,
      message: 'Which repositories should be added to the enrolled set? Enrolling adds to what this install collects; it removes nothing.',
      choices: offer.map((repository) => /** @type {PromptChoice} */ ({ label: repository.name })),
    }));
    if (!selection.ok) {
      this.say(`add: ${selection.message}; the enrolled set is unchanged`);
      return;
    }
    /** @type {string[]} */
    const added = [];
    /** @type {string[]} */
    const refusals = [];
    for (const row of selection.indices) {
      const repository = offer[row - 1];
      if (repository === undefined) {
        refusals.push(`row ${String(row)} named no repository, so it cannot be enrolled`);
        continue;
      }
      const name = repository.name;
      // Applied here as well as in the offer, so a repository that arrived through a list
      // this visit fetched before the deny list changed is refused here rather than saved.
      const entry = denyEntryFor(configuration.denyList, name);
      if (entry !== null) {
        refusals.push(`${name} is denied by the deny entry ${entry}, so it cannot be enrolled`);
        continue;
      }
      if (enrolled.has(identity(name))) {
        refusals.push(`${name} is already enrolled`);
        continue;
      }
      enrolled.add(identity(name));
      added.push(name);
    }
    for (const refusal of refusals) this.say(`refused: ${refusal}`);
    if (added.length === 0) {
      this.say('add: nothing was added and nothing was saved');
      return;
    }
    await this.save(
      withFlagsForEnrolledSet({
        ...configuration,
        enrolled: [...configuration.enrolled, ...added],
        // A repository being enrolled is one this install now watches, so its flag is set
        // explicitly: a key left behind by an earlier removal must not carry a stale false.
        enabled: { ...configuration.enabled, ...Object.fromEntries(added.map((name) => [name, true])) },
      }),
      `added ${plural(added.length, 'repository')} to the enrolled set: ${added.join(', ')}`,
    );
  }

  /**
   * Remove repositories from the enrolled set. A repository the deny list names is not
   * offered, and the deny list is printed as part of this edit so the absent row has a
   * stated reason: removing a denied repository would change nothing, because the enrolment
   * would remain and the deny list would still win.
   * @returns {Promise<void>}
   */
  async removeEnrollment() {
    const configuration = this.current();
    // The deny list is printed as part of this edit, and so is the flag each row carries,
    // because a row the deny list holds back has to have a reason the operator can read
    // rather than an absence they have to work out.
    this.say(`deny list as it stands (${configuration.denyList.length}): ${configuration.denyList.join(', ') || 'empty'}`);
    this.say(`enrolled set as it stands (${configuration.enrolled.length}): ${configuration.enrolled.map((name) => (
      `${name} (${configuration.enabled[name] === false ? 'disabled' : 'enabled'})`
    )).join(', ') || 'none'}`);
    const removable = configuration.enrolled.filter((name) => denyEntryFor(configuration.denyList, name) === null);
    const blocked = configuration.enrolled.filter((name) => denyEntryFor(configuration.denyList, name) !== null);
    for (const name of blocked) {
      const entry = denyEntryFor(configuration.denyList, name);
      this.say(`not removable here: ${name} is named by the deny entry ${String(entry)}; it is not collected because of that entry, so removing the enrolment would change nothing. Remove the deny entry first and it becomes removable.`);
    }
    if (removable.length === 0) {
      this.say(`remove: nothing is removable; ${configuration.enrolled.length === 0
        ? 'nothing is enrolled'
        : 'every enrolled repository is on the deny list'}, and nothing was saved`);
      return;
    }
    const selection = await untilAnswered(() => promptSelection({
      input: this.input,
      output: this.output,
      message: 'Which repositories should be removed from the enrolled set? Removing one drops the choice that was made to watch it; to keep it enrolled and stop collecting it, use the flag instead.',
      choices: removable.map((name) => /** @type {PromptChoice} */ ({ label: name })),
    }));
    if (!selection.ok) {
      this.say(`remove: ${selection.message}; the enrolled set is unchanged`);
      return;
    }
    /** @type {string[]} */
    const removed = [];
    /** @type {string[]} */
    const refusals = [];
    for (const row of selection.indices) {
      const name = removable[row - 1];
      if (name === undefined) {
        refusals.push(`row ${String(row)} named no repository, so it cannot be removed`);
        continue;
      }
      removed.push(name);
    }
    for (const refusal of refusals) this.say(`refused: ${refusal}`);
    if (removed.length === 0) {
      this.say('remove: nothing was removed and nothing was saved');
      return;
    }
    const remaining = configuration.enrolled.filter((name) => !removed.some((gone) => identity(gone) === identity(name)));
    this.say(`remove: ${removed.join(', ')} ${removed.length === 1 ? 'is' : 'are'} being removed from the enrolled set,`
      + ' not turned off; to keep the enrolment and stop collecting it, use the flag instead');
    await this.save(
      withFlagsForEnrolledSet({ ...configuration, enrolled: remaining }),
      `removed ${plural(removed.length, 'repository')} from the enrolled set: ${removed.join(', ')}`,
    );
  }

  /**
   * Turn one enrolled repository off or on without removing it. The enrolment is the set
   * the maintainer chose and the flag is what the collector reads, so a toggle here touches
   * one key and leaves the name in place; that difference is stated in the prompt and again
   * in the transcript.
   * @returns {Promise<void>}
   */
  async toggleEnabled() {
    const configuration = this.current();
    if (configuration.enrolled.length === 0) {
      this.say('flag: nothing is enrolled, so there is no flag to change, and nothing was saved');
      return;
    }
    const denied = new Set(configuration.denyList.map(identity));
    const choice = await untilAnswered(() => promptChoice({
      input: this.input,
      output: this.output,
      message: 'Which repository should change? Turning one off keeps it enrolled and stops it being collected; that is not the same as removing it.',
      choices: configuration.enrolled.map((name) => /** @type {PromptChoice} */ ({
        label: `${name} - currently ${configuration.enabled[name] === false ? 'disabled' : 'enabled'}`
          + `${denied.has(identity(name)) ? ', and on the deny list, so it is not collected either way' : ''}`,
      })),
    }));
    if (!choice.ok) {
      this.say(`flag: ${choice.message}; no flag changed`);
      return;
    }
    const name = configuration.enrolled[choice.index - 1];
    if (name === undefined) {
      this.say(`refused: row ${String(choice.index)} named no enrolled repository, so no flag changed`);
      return;
    }
    const enabled = configuration.enabled[name] === false;
    await this.save(
      withFlagsForEnrolledSet({ ...configuration, enabled: { ...configuration.enabled, [name]: enabled } }),
      `${name} is now ${enabled ? 'enabled' : 'disabled'} and stays in the enrolled set`
        + `${enabled ? '' : ', so it is no longer collected'}`,
    );
  }

  /**
   * Add a repository to the deny list or remove an entry from it. Both take effect through
   * the same save as an enrolment change, and neither touches the enrolled set: the deny
   * list takes precedence over enrolment by design, so denying an enrolled repository
   * leaves the enrolment alone and stops the collection.
   * @returns {Promise<void>}
   */
  async editDenyList() {
    const choice = await untilAnswered(() => promptChoice({
      input: this.input,
      output: this.output,
      message: 'Which change to the deny list?',
      choices: [
        { label: 'Add a repository to the deny list' },
        { label: 'Remove an entry from the deny list' },
      ],
    }));
    if (!choice.ok) {
      this.say(`deny list: ${choice.message}; the deny list is unchanged`);
      return;
    }
    if (choice.index === 1) await this.addDenyEntry();
    else await this.removeDenyEntry();
  }

  /**
   * Candidates are the enrolled set first, then whatever discovery reached in this visit,
   * so the common case needs no request at all and no repository this manager has not seen
   * can be denied from here.
   * @param {Configuration} configuration
   * @returns {string[]}
   */
  denyCandidates(configuration) {
    const denied = new Set(configuration.denyList.map(identity));
    /** @type {string[]} */
    const candidates = [];
    for (const name of configuration.enrolled) {
      if (!denied.has(identity(name))) candidates.push(name);
    }
    for (const repository of this.repositories) {
      if (!denied.has(identity(repository.name))
        && !candidates.some((candidate) => identity(candidate) === identity(repository.name))) {
        candidates.push(repository.name);
      }
    }
    return candidates;
  }

  /**
   * @returns {Promise<void>}
   */
  async addDenyEntry() {
    const configuration = this.current();
    const candidates = this.denyCandidates(configuration);
    if (candidates.length === 0) {
      this.say(`deny list: nothing to add; it already names every repository this manager knows about`
        + `${this.listed ? '' : ', and no discovery list has been fetched in this visit'}`);
      return;
    }
    const choice = await untilAnswered(() => promptChoice({
      input: this.input,
      output: this.output,
      message: 'Which repository should the deny list name? Candidates are the enrolled set and the repositories discovery reached in this visit.',
      choices: candidates.map((name) => /** @type {PromptChoice} */ ({ label: name })),
    }));
    if (!choice.ok) {
      this.say(`deny list: ${choice.message}; the deny list is unchanged`);
      return;
    }
    const name = candidates[choice.index - 1];
    if (name === undefined) {
      this.say(`refused: row ${String(choice.index)} named no repository, so the deny list is unchanged`);
      return;
    }
    const enrolled = configuration.enrolled.some((entry) => identity(entry) === identity(name));
    await this.save(
      withFlagsForEnrolledSet({ ...configuration, denyList: [...configuration.denyList, name] }),
      `the deny list now names ${name}`,
    );
    if (enrolled) {
      this.say(`deny list: ${name} is still enrolled and is no longer collected, because the deny list takes precedence over enrolment`);
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async removeDenyEntry() {
    const configuration = this.current();
    if (configuration.denyList.length === 0) {
      this.say('deny list: it is empty, so there is no entry to remove, and nothing was saved');
      return;
    }
    const choice = await untilAnswered(() => promptChoice({
      input: this.input,
      output: this.output,
      message: 'Which deny entry should be removed? A repository it named becomes collectable again if it is still enrolled.',
      choices: configuration.denyList.map((name) => /** @type {PromptChoice} */ ({
        label: configuration.enrolled.some((entry) => identity(entry) === identity(name))
          ? `${name} - enrolled, so removing this entry makes it collectable again`
          : name,
      })),
    }));
    if (!choice.ok) {
      this.say(`deny list: ${choice.message}; the deny list is unchanged`);
      return;
    }
    const name = configuration.denyList[choice.index - 1];
    if (name === undefined) {
      this.say(`refused: row ${String(choice.index)} named no deny entry, so the deny list is unchanged`);
      return;
    }
    const remaining = configuration.denyList.filter((_entry, position) => position + 1 !== choice.index);
    await this.save(
      withFlagsForEnrolledSet({ ...configuration, denyList: remaining }),
      `the deny list no longer names ${name}`,
    );
  }

  /**
   * Change the collection hour. An empty answer keeps the hour the configuration already
   * holds, and the prompt says that the operating system still owns the schedule.
   * @returns {Promise<void>}
   */
  async changeCollectionHour() {
    const configuration = this.current();
    const answer = await untilAnswered(() => promptText({
      input: this.input,
      output: this.output,
      message: `Collection hour (UTC): the hour a scheduled run should collect in. An empty answer keeps ${configuration.collectionHourUtc}.`
        + ' This manager sets the hour only and installs no schedule; your operating system owns that.',
      validate: collectionHourValidator(configuration.collectionHourUtc),
    }));
    if (!answer.ok) {
      this.say(`collection hour: ${answer.message}; the configured hour is unchanged`);
      return;
    }
    const collectionHourUtc = Number(answer.value);
    await this.save(
      withFlagsForEnrolledSet({ ...configuration, collectionHourUtc }),
      `the collection hour is ${collectionHourUtc} UTC`,
    );
  }

  /**
   * Run the menu until the operator leaves it.
   * @returns {Promise<ConfigManagerOutcome>}
   */
  async visit() {
    const refusal = await this.open();
    if (refusal !== null) return refusal;
    this.say(`configuration manager: ${this.currentPaths().home}`);
    for (;;) {
      this.reportState();
      const choice = await untilAnswered(() => promptChoice({
        input: this.input,
        output: this.output,
        message: 'What would you like to change in this configuration?',
        choices: CONFIG_MANAGER_MENU.map((label) => /** @type {PromptChoice} */ ({ label })),
      }));
      if (!choice.ok) return this.cancelled(choice.message);
      if (choice.index === CONFIG_MANAGER_MENU.length) return this.left();
      switch (choice.index) {
        case 1:
          await this.addEnrollment();
          break;
        case 2:
          await this.removeEnrollment();
          break;
        case 3:
          await this.toggleEnabled();
          break;
        case 4:
          await this.editDenyList();
          break;
        case 5:
          await this.changeCollectionHour();
          break;
        case 6:
          await this.refreshDiscovery();
          break;
        default:
          // The prompt only returns a row it printed, so no other index can arrive.
          this.say('menu: no action matched that row and nothing was saved');
          break;
      }
    }
  }
}

/**
 * Open the returning-visit menu on a home that already has a configuration.
 *
 * The manager changes what this install watches and nothing else: it does not write
 * templates, take a token, collect, report or serve. `completed` means the operator left
 * the menu with every edit they asked for saved and read back through the existing loader;
 * `cancelled` means a prompt was cancelled and no edit after that point was applied; and
 * `failed` means an edit could not be saved, which the transcript says so.
 * @param {ConfigManagerOptions} options The streams, the environment the existing modules read, and the two seams.
 * @returns {Promise<ConfigManagerOutcome>}
 */
export async function runConfigManager(options) {
  const manager = new ConfigurationManager(options);
  try {
    return await manager.visit();
  } catch (error) {
    // A read failure, a filesystem refusal or a module this manager composes can all
    // surface here. It is reported as one line with no credential material and never as a
    // stack trace, and the configuration is whatever the loader last accepted.
    manager.say(`configuration manager failed: ${safeMessage(error)}`);
    return {
      status: 'failed',
      exitCode: 1,
      message: safeMessage(error),
      enrolled: manager.enrolled(),
    };
  } finally {
    // The reader bound to this input stream keeps standard input resumed, which would hold
    // the process open after the last prompt.
    closePromptSession(options.input);
  }
}