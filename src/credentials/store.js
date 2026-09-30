import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { resolveHomePaths } from '../paths.js';
import { redact } from './redact.js';

export const CREDENTIAL_FILE_MODE = 0o600;

/**
 * Structural interface consumed by the later HTTP credential provider.
 * The token is captured privately, not stored in an enumerable property.
 * @typedef {object} CredentialProvider
 * @property {() => string} getToken Only the HTTP transport should call this.
 */

/** Credential configuration failures never retain raw JSON or a raw cause. */
export class CredentialConfigurationError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(redact(message));
    this.name = 'CredentialConfigurationError';
    this.code = code;
  }
}

/**
 * Read and validate credentials from the path supplied by paths.js. No network,
 * environment-token fallback, logging, credential writes or permission repair.
 * @param {Pick<import('../paths.js').HomePaths, 'credentialsPath'>} [paths]
 * @returns {CredentialProvider}
 */
export function loadCredentials(paths = resolveHomePaths()) {
  const file = paths.credentialsPath;
  /** @type {number | undefined} */
  let descriptor;
  let text;
  try {
    descriptor = openSync(file, 'r');
    // Inspect and read the same open file, avoiding a path replacement between
    // the permission check and the read. Never read the body of an unsafe file.
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new CredentialConfigurationError(
        'ERR_CREDENTIAL_FILE_TYPE',
        `${file} is not a regular credential file; create credentials.json as a regular file with mode 0600`,
      );
    }
    const mode = stats.mode & 0o7777;
    if (process.platform !== 'win32' && mode !== CREDENTIAL_FILE_MODE) {
      const observed = mode.toString(8).padStart(4, '0');
      throw new CredentialConfigurationError(
        'ERR_CREDENTIAL_FILE_MODE',
        `${file} has mode ${observed}; credentials require exactly 0600. Set this file's mode to 0600 as its owner`,
      );
    }
    text = readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (error instanceof CredentialConfigurationError) throw error;
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    throw new CredentialConfigurationError(
      code === 'ENOENT' ? 'ERR_CREDENTIAL_FILE_MISSING' : 'ERR_CREDENTIAL_FILE_UNREADABLE',
      code === 'ENOENT'
        ? `${file} is missing; create credentials.json with a non-empty token and mode 0600`
        : `${file} cannot be read; check that the current user has permission to read this file and traverse its home directory`,
    );
  } finally {
    if (descriptor !== undefined) {
      // A raw filesystem exception can carry the path. Sanitize this boundary too.
      try {
        closeSync(descriptor);
      } catch {
        throw new CredentialConfigurationError(
          'ERR_CREDENTIAL_FILE_CLOSE',
          `${file} could not be closed after reading; check the filesystem and retry`,
        );
      }
    }
  }

  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse messages can quote credential contents; never retain them.
    throw new CredentialConfigurationError(
      'ERR_CREDENTIAL_JSON', `${file} contains malformed JSON; fix credentials.json without logging its contents`,
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CredentialConfigurationError(
      'ERR_CREDENTIAL_SCHEMA', `${file} must contain a JSON object with a token key; correct the credential file`,
    );
  }
  if (!Object.hasOwn(value, 'token')) {
    throw new CredentialConfigurationError(
      'ERR_CREDENTIAL_TOKEN_MISSING', `${file} is missing the token key; add a non-empty token string`,
    );
  }
  const token = /** @type {{token: unknown}} */ (value).token;
  if (typeof token !== 'string') {
    throw new CredentialConfigurationError(
      'ERR_CREDENTIAL_TOKEN_TYPE', `${file} has a non-string token key; replace it with a non-empty string`,
    );
  }
  if (token.trim() === '') {
    throw new CredentialConfigurationError(
      'ERR_CREDENTIAL_TOKEN_EMPTY', `${file} has an empty token key; supply a non-empty token string`,
    );
  }
  return Object.freeze({ getToken: () => token });
}
