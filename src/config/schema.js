/** The default is a UTC hour, not a scheduler: collection remains OS-managed. */
export const DEFAULT_COLLECTION_HOUR_UTC = 0;

/**
 * @typedef {object} Configuration
 * @property {string[]} enrolled Declared owner/name pairs, in declared order and case.
 * @property {string[]} denyList Declared exclusions; this module does not apply them.
 * @property {number} collectionHourUtc Integer UTC hour, defaulting to midnight (0).
 * @property {Record<string, boolean>} enabled Per-repository flags; enrolled entries default to true.
 */

/** Configuration errors never include file contents or rejected values. */
export class ConfigurationError extends Error {
  /**
   * @param {string} code Stable error kind for callers.
   * @param {string} key Offending key, or `$` for the document itself.
   * @param {string} message Cause and next action.
   */
  constructor(code, key, message) {
    // Until the credential boundary exists, keep even hostile key/path names
    // safe: JSON parser errors must never expose excerpts of configuration.
    const safe = (/** @type {string} */ text) => text
      .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[REDACTED]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ');
    super(safe(message));
    this.name = 'ConfigurationError';
    this.code = code;
    this.key = safe(key);
  }
}

/** @param {string} key @param {string} cause @returns {never} */
function invalid(key, cause) {
  throw new ConfigurationError(
    'ERR_REPO_SIGNAL_CONFIG_INVALID', key,
    `Configuration key ${key}: ${cause}; correct this key in config.json and retry`,
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {string} key @returns {string} */
function repositoryName(value, key) {
  if (typeof value !== 'string' || !/^[^/\s\u0000-\u001f\u007f]+\/[^/\s\u0000-\u001f\u007f]+$/u.test(value)) {
    invalid(key, 'expected a single nonempty owner/name pair without whitespace');
  }
  return value;
}

/** @param {unknown} value @param {string} key @returns {string[]} */
function repositoryList(value, key) {
  if (!Array.isArray(value)) invalid(key, 'expected an array of owner/name strings');
  return Array.from(value, (entry, index) => repositoryName(entry, `${key}[${index}]`));
}

/**
 * Closed input schema: { enrolled: string[], denyList?: string[],
 * collectionHourUtc?: number, enabled?: { [owner/name]: boolean } }.
 * Missing optional fields get explicit defaults. Names, order, duplicates and
 * deny-list overlaps are preserved: enrollment resolution belongs elsewhere.
 * @param {unknown} value Parsed JSON document.
 * @returns {Configuration} A fresh normalized object; input is never mutated.
 */
export function validateConfig(value) {
  if (!isObject(value)) invalid('$', 'expected a configuration object');
  const allowed = new Set(['enrolled', 'denyList', 'collectionHourUtc', 'enabled']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(key, 'unknown key');
  }
  if (!Object.hasOwn(value, 'enrolled')) invalid('enrolled', 'required repository list is missing');
  const enrolled = repositoryList(value.enrolled, 'enrolled');
  const denyList = Object.hasOwn(value, 'denyList') ? repositoryList(value.denyList, 'denyList') : [];
  const collectionHourUtc = Object.hasOwn(value, 'collectionHourUtc')
    ? value.collectionHourUtc : DEFAULT_COLLECTION_HOUR_UTC;
  if (typeof collectionHourUtc !== 'number' || !Number.isInteger(collectionHourUtc) || collectionHourUtc < 0 || collectionHourUtc > 23) {
    invalid('collectionHourUtc', 'expected an integer UTC hour from 0 through 23');
  }
  /** @type {Record<string, boolean>} */
  const enabled = Object.fromEntries(enrolled.map(repo => [repo, true]));
  if (Object.hasOwn(value, 'enabled')) {
    if (!isObject(value.enabled)) invalid('enabled', 'expected an object mapping owner/name keys to boolean flags');
    for (const [repo, flag] of Object.entries(value.enabled)) {
      const key = `enabled.${repo}`;
      repositoryName(repo, key);
      if (typeof flag !== 'boolean') invalid(key, 'expected a boolean enabled flag');
      enabled[repo] = flag;
    }
  }
  return { enrolled, denyList, collectionHourUtc, enabled };
}
