import {
  closeSync, constants, fchmodSync, fstatSync, ftruncateSync,
  lstatSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
import { resolveHomePaths } from '../paths.js';
import { loadConfig, parseConfig } from '../config/load.js';
import { CREDENTIAL_FILE_MODE, loadCredentials } from '../credentials/store.js';
import { redact } from '../credentials/redact.js';
import { UsageError } from './index.js';

const CONFIG_TEMPLATE = `{
  // Explicit opt-in only: add owner/name strings to enroll repositories.
  "enrolled": [],
  // Exclusions take precedence over enrollment.
  "denyList": [],
  // UTC hour from 0 to 23; scheduling is managed by your operating system.
  "collectionHourUtc": 0,
  // Optional owner/name-to-boolean overrides; enrolled repositories default to true.
  "enabled": {}
}
`;
// This is deliberately not a GitHub token. Local validation is not authentication.
const CREDENTIAL_TEMPLATE = '{\n  "token": "REPLACE_WITH_YOUR_GITHUB_TOKEN"\n}\n';

/** @param {unknown} error @returns {string} */
function safeMessage(error) {
  return redact(error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** @param {string} file @returns {import('node:fs').Stats | null} */
function existingFile(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Do not follow symlinks, truncate non-files, or expose old credentials while
 * replacing them. Exclusive creation also protects the no-force race window.
 * @param {string} file
 * @param {string} template
 * @param {boolean} force
 */
function writeTemplate(file, template, force) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (force ? 0 : constants.O_EXCL);
  const descriptor = openSync(file, flags, CREDENTIAL_FILE_MODE);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${redact(file)} is not a regular file; choose another home`);
    fchmodSync(descriptor, CREDENTIAL_FILE_MODE);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, template, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/** @param {import('./index.js').CommandContext} context @returns {number} */
export function configInit(context) {
  if (context.args.length > 1 || (context.args.length === 1 && context.args[0] !== '--force')) {
    throw new UsageError(redact('config init accepts only --force; run node src/cli.js config init [--force]'));
  }
  const force = context.args[0] === '--force';
  try {
    const paths = resolveHomePaths({ env: context.env, cwd: context.cwd });
    // Check both before writing either, including dangling symlinks. Force
    // authorizes replacing regular files, not redirecting or truncating devices.
    for (const file of [paths.configPath, paths.credentialsPath]) {
      const existing = existingFile(file);
      if (existing === null) continue;
      if (!force) throw new Error(`${redact(file)} already exists; use --force only to explicitly replace both templates`);
      if (!existing.isFile()) throw new Error(`${redact(file)} is not a regular file; choose another home`);
    }
    writeTemplate(paths.configPath, CONFIG_TEMPLATE, force);
    writeTemplate(paths.credentialsPath, CREDENTIAL_TEMPLATE, force);
    context.print(safeMessage(`configuration template created: ${paths.configPath} (0600)`));
    context.print(redact('configuration comments: config check accepts whole-line // annotations; remove them for strict JSON consumers'));
    context.print(safeMessage(`credential template created: ${paths.credentialsPath} (0600)`));
    context.print(redact('credential setup: replace the non-secret placeholder in credentials.json before connecting to GitHub'));
    return 0;
  } catch (error) {
    context.printError(`config init failed: ${safeMessage(error)}`);
    return 1;
  }
}

/**
 * The shared loader owns strict JSON and schema validation. The init template
 * additionally permits whole-line // annotations; no inline comments, trailing
 * commas, or edits to string values are accepted by this command adapter.
 * @param {import('../paths.js').HomePathOptions} options
 * @param {string} file
 */
function checkConfiguration(options, file) {
  try {
    loadConfig(options);
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code !== 'ERR_REPO_SIGNAL_CONFIG_PARSE') throw error;
    const text = readFileSync(file, 'utf8');
    parseConfig(text.replace(/^[\t ]*\/\/[^\r\n]*/gm, ''));
  }
}

/** @param {import('./index.js').CommandContext} context @returns {number} */
export function configCheck(context) {
  if (context.args.length !== 0) {
    throw new UsageError(redact('config check accepts no arguments; run node src/cli.js config check'));
  }
  const options = { env: context.env, cwd: context.cwd };
  let paths;
  try {
    paths = resolveHomePaths(options);
  } catch (error) {
    context.print(`home failed: ${safeMessage(error)}`);
    context.print(redact('config check: failed'));
    return 1;
  }
  let failed = false;
  try {
    checkConfiguration(options, paths.configPath);
    context.print(redact('configuration ok: syntax and schema valid'));
  } catch (error) {
    failed = true;
    context.print(`configuration failed: ${safeMessage(error)}`);
  }
  try {
    // Never retrieve, enumerate, or print the provider's private token.
    loadCredentials(paths);
    context.print(redact('credentials ok: regular file, mode 0600 and non-empty token string; GitHub authentication not checked'));
  } catch (error) {
    failed = true;
    context.print(`credentials failed: ${safeMessage(error)}`);
  }
  context.print(redact(`config check: ${failed ? 'failed' : 'ok'}`));
  return failed ? 1 : 0;
}
