import { readFileSync } from 'node:fs';
import { resolveHomePaths } from '../paths.js';
import { ConfigurationError, validateConfig } from './schema.js';

/**
 * Parse without exposing JSON parser excerpts, which could contain a token.
 * `$` names the document when malformed JSON prevents identifying a field.
 * @param {string} text JSON configuration text.
 * @returns {import('./schema.js').Configuration}
 */
export function parseConfig(text) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigurationError(
      'ERR_REPO_SIGNAL_CONFIG_PARSE', '$',
      'Configuration key $: malformed JSON; correct the JSON syntax in config.json and retry',
    );
  }
  return validateConfig(value);
}

/**
 * Load only the configuration path supplied by the single home-path resolver.
 * No credentials, repository discovery or enrollment precedence is involved.
 * @param {import('../paths.js').HomePathOptions} [options]
 * @returns {import('./schema.js').Configuration}
 */
export function loadConfig(options = {}) {
  const { configPath } = resolveHomePaths(options);
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = error instanceof Error
      ? /** @type {NodeJS.ErrnoException} */ (error).code : undefined;
    if (code === 'ENOENT') {
      throw new ConfigurationError(
        'ERR_REPO_SIGNAL_CONFIG_MISSING', '$',
        `Configuration key $: missing configuration file at ${configPath}; create config.json in this home and retry`,
      );
    }
    throw new ConfigurationError(
      'ERR_REPO_SIGNAL_CONFIG_READ', '$',
      `Configuration key $: cannot read ${configPath} (${code ?? 'filesystem error'}); ensure it is a regular file readable by the current user and retry`,
    );
  }
  return parseConfig(text);
}
