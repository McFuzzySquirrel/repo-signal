const TOKEN_SHAPE = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+)/g;
const BEARER_VALUE = /(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/gi;
export const REDACTED = '[REDACTED]';

/**
 * Sanitize text before it becomes an error, log line or persisted message.
 * Known secrets also cover opaque credentials without a recognizable prefix.
 * This returns text, not the original error object (which may carry headers).
 * @param {string} message
 * @param {readonly string[]} [secrets]
 * @returns {string}
 */
export function redact(message, secrets = []) {
  let result = message;
  for (const secret of secrets) {
    if (secret !== '') result = result.split(secret).join(REDACTED);
  }
  return result.replace(TOKEN_SHAPE, REDACTED).replace(BEARER_VALUE, `$1${REDACTED}`);
}
