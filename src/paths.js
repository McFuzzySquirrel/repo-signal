import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const HOME_DIRECTORY_MODE = 0o700;
export const CONFIG_FILE_NAME = 'config.json';
export const CREDENTIALS_FILE_NAME = 'credentials.json';
export const DATABASE_FILE_NAME = 'archive.sqlite3';

const DIRECTORY_NAME = 'repo-signal';
const GIT_MARKER_NAME = '.git';
const FALLBACK_RELATIVE_PATH = path.join('.local', 'share', DIRECTORY_NAME);
const GROUP_AND_OTHER_BITS = 0o077;
const ALL_PERMISSION_BITS = 0o777;

/**
 * @typedef {object} HomePathOptions
 * @property {NodeJS.ProcessEnv} [env] Environment to read, defaulting to `process.env`.
 * @property {string} [cwd] Directory a relative value is resolved against, defaulting to `process.cwd()`.
 */

/**
 * @typedef {object} HomePaths
 * @property {string} home Absolute, normalized home directory holding every durable file.
 * @property {string} configPath Absolute path of the configuration file inside the home.
 * @property {string} credentialsPath Absolute path of the credential file inside the home.
 * @property {string} databasePath Absolute path of the archive database inside the home.
 */

/** A refusal that names the resolved path, the observed cause and the next action. */
export class HomeDirectoryError extends Error {
  /**
   * @param {string} code Stable identifier a caller can branch on.
   * @param {string} message Cause and next action, with the resolved path named.
   */
  constructor(code, message) {
    super(message);
    this.name = 'HomeDirectoryError';
    this.code = code;
  }
}

/**
 * @param {unknown} error
 * @returns {string | null} The operating-system code, when the failure carries one.
 */
function systemErrorCode(error) {
  if (error instanceof Error) {
    const code = /** @type {Partial<NodeJS.ErrnoException>} */ (error).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/**
 * @param {unknown} error
 * @returns {string} The operating-system code when there is one, the message otherwise.
 */
function describeSystemError(error) {
  return systemErrorCode(error) ?? (error instanceof Error ? error.message : String(error));
}

/**
 * @param {number} mode Permission bits.
 * @returns {string} Octal form used in operator-facing messages, for example `0755`.
 */
function formatMode(mode) {
  return mode.toString(8).padStart(3, '0');
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string | null} The trimmed value, or null when the variable is unset or blank.
 */
function readPathVariable(env, name) {
  const value = env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `lstat` keeps a broken or redirected `.git` entry visible, which is exactly the
 * case the refusal has to catch.
 * @param {string} target
 * @returns {import('node:fs').Stats | null} null when nothing exists at the path.
 */
function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new HomeDirectoryError(
      'ERR_REPO_SIGNAL_HOME_UNREADABLE',
      `${target} could not be inspected (${describeSystemError(error)}); repo-signal must be able to check ` +
        'the home directory it was given, so it refuses to continue',
    );
  }
}

/**
 * The home directory `XDG_DATA_HOME` or `HOME` would produce, used only to name a
 * concrete next action in the git-root refusal.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {string}
 */
function defaultHomeDirectory(env, cwd) {
  const xdgDataHome = readPathVariable(env, 'XDG_DATA_HOME');
  if (xdgDataHome !== null) return path.resolve(cwd, xdgDataHome, DIRECTORY_NAME);
  const home = readPathVariable(env, 'HOME') ?? homedir();
  return path.resolve(cwd, home, FALLBACK_RELATIVE_PATH);
}

/**
 * Resolve the single home directory without touching the filesystem.
 *
 * Precedence is `REPO_SIGNAL_HOME`, then `XDG_DATA_HOME/repo-signal`, then
 * `~/.local/share/repo-signal`. A blank value is treated as unset so an exported
 * but empty variable cannot silently redirect state to the current directory.
 * @param {HomePathOptions} [options]
 * @returns {string} An absolute, normalized path.
 */
export function resolveHomeDirectory(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const explicitHome = readPathVariable(env, 'REPO_SIGNAL_HOME');
  if (explicitHome !== null) return path.resolve(cwd, explicitHome);

  const xdgDataHome = readPathVariable(env, 'XDG_DATA_HOME');
  if (xdgDataHome !== null) return path.resolve(cwd, xdgDataHome, DIRECTORY_NAME);

  const home = readPathVariable(env, 'HOME') ?? homedir();
  if (home === '') {
    throw new HomeDirectoryError(
      'ERR_REPO_SIGNAL_HOME_UNRESOLVED',
      'no home directory could be resolved: REPO_SIGNAL_HOME, XDG_DATA_HOME and HOME are all unset or blank, ' +
        'and the operating system reported no home. Set REPO_SIGNAL_HOME to a directory outside every work tree',
    );
  }
  return path.resolve(cwd, home, FALLBACK_RELATIVE_PATH);
}

/**
 * @param {string} home Absolute, normalized home directory.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {void}
 */
function refuseGitRoot(home, env, cwd) {
  if (lstatOrNull(path.join(home, GIT_MARKER_NAME)) === null) return;
  const suggested = defaultHomeDirectory(env, cwd);
  const nextAction =
    suggested === home
      ? `Remove the ${GIT_MARKER_NAME} entry, or point REPO_SIGNAL_HOME at a directory that is not a work tree`
      : `Set REPO_SIGNAL_HOME to ${suggested}, or point XDG_DATA_HOME at a directory outside every work tree`;
  throw new HomeDirectoryError(
    'ERR_REPO_SIGNAL_HOME_IN_GIT',
    `${home} contains a ${GIT_MARKER_NAME} entry, so it is a git repository root; repo-signal keeps its ` +
      `configuration, credentials and archive outside any work tree and refuses to start in it. ${nextAction}`,
  );
}

/**
 * Create the home directory when it is missing and hold it at mode 0700.
 * @param {string} home Absolute, normalized home directory.
 * @returns {void}
 */
export function ensureHomeDirectory(home) {
  const existing = lstatOrNull(home);
  if (existing !== null && !existing.isDirectory() && !existing.isSymbolicLink()) {
    throw new HomeDirectoryError(
      'ERR_REPO_SIGNAL_HOME_NOT_A_DIRECTORY',
      `${home} already exists and is not a directory, so it cannot hold the configuration, the credential ` +
        `file and the archive. Point REPO_SIGNAL_HOME at a directory that does not exist yet, or at a ` +
        `directory you own`,
    );
  }
  try {
    mkdirSync(home, { recursive: true, mode: HOME_DIRECTORY_MODE });
  } catch (error) {
    throw new HomeDirectoryError(
      'ERR_REPO_SIGNAL_HOME_UNWRITABLE',
      `${home} could not be created (${describeSystemError(error)}); create it by hand with mode 0700, or point ` +
        'REPO_SIGNAL_HOME at a directory the current user can write to',
    );
  }
  let observedMode = 0;
  try {
    observedMode = statSync(home).mode & ALL_PERMISSION_BITS;
  } catch (error) {
    throw new HomeDirectoryError(
      'ERR_REPO_SIGNAL_HOME_UNREADABLE',
      `${home} could not be inspected after it was created (${describeSystemError(error)}); repo-signal cannot ` +
        'confirm the mode it requires, so it refuses to continue',
    );
  }
  // `mkdir` applies the process umask to the requested mode and never adds bits,
  // so a freshly created directory is set explicitly; a directory that already
  // existed is only tightened, never loosened, by removing group and other access.
  const needsMode =
    existing === null ? observedMode !== HOME_DIRECTORY_MODE : (observedMode & GROUP_AND_OTHER_BITS) !== 0;
  if (!needsMode) return;
  try {
    chmodSync(home, HOME_DIRECTORY_MODE);
  } catch (error) {
    throw new HomeDirectoryError(
      'ERR_REPO_SIGNAL_HOME_MODE',
      `${home} is mode ${formatMode(observedMode)}, and repo-signal requires ${formatMode(HOME_DIRECTORY_MODE)} ` +
        `because it holds a 0600 credential file; the mode could not be set ` +
        `(${describeSystemError(error)}). Run: chmod 700 "${home}" as the owner of that directory`,
    );
  }
}

/**
 * Resolve the home directory, refuse a work-tree root, and return every path
 * derived from it. This is the only place those paths are decided.
 * @param {HomePathOptions} [options]
 * @returns {HomePaths}
 */
export function resolveHomePaths(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = resolveHomeDirectory({ env, cwd });
  refuseGitRoot(home, env, cwd);
  ensureHomeDirectory(home);
  return {
    home,
    configPath: path.join(home, CONFIG_FILE_NAME),
    credentialsPath: path.join(home, CREDENTIALS_FILE_NAME),
    databasePath: path.join(home, DATABASE_FILE_NAME),
  };
}
