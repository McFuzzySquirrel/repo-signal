/**
 * @typedef {import('../config/schema.js').Configuration} Configuration
 */

/** @param {string} repository @returns {string} Case-folded identity for comparison. */
function identity(repository) {
  return repository.toLowerCase();
}

/** @param {Record<string, boolean>} enabled @param {string} repository @returns {boolean} */
function isEnabled(enabled, repository) {
  const target = identity(repository);
  for (const [key, flag] of Object.entries(enabled)) {
    if (identity(key) === target) return flag !== false;
  }
  return true;
}

/**
 * The only definition of which repositories this install collects. Pure:
 * no network, no filesystem, no clock.
 * - deny list wins over enrollment in either declaration order, case-insensitively
 * - entries whose enabled flag is false are dropped
 * - duplicates differing only by case collapse to the first declared form
 * - survivors keep declared order and their normalized owner/name spelling
 * @param {Configuration} config
 * @returns {string[]} The enrolled repositories to collect.
 */
export function resolveEnrollment(config) {
  const denied = new Set(config.denyList.map(identity));
  const seen = new Set();
  const survivors = [];
  for (const declared of config.enrolled) {
    const key = identity(declared);
    if (denied.has(key)) continue;
    if (!isEnabled(config.enabled, declared)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const slash = declared.indexOf('/');
    survivors.push(`${declared.slice(0, slash)}/${declared.slice(slash + 1)}`);
  }
  return survivors;
}
