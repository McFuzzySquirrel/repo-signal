import { redact } from '../credentials/redact.js';
// The vendor fact - GitHub's July 2026 stargazer restriction and the changelog
// that records it - belongs to the transport layer, so the next step for it is
// spelled once there and classified here rather than drifted across both.
import { STARGAZERS_RESTRICTED_ACTION } from '../github/retry.js';

/**
 * Collection failure classification.
 *
 * This is the one place that decides what a collection failure *is*. Every failure it
 * sees becomes exactly one of six kinds, so the run, the CLI and the dashboard can
 * name a state instead of printing a raw exception. It is a pure function over what the
 * failure already carries: no clock, no archive, no request, no retry, and no decision
 * about whether a run continues. The run owns that.
 *
 * The transport policy already types what it saw - the HTTP status and, for a traffic
 * endpoint, the permission that endpoint needs - so a typed failure keeps the kind the
 * policy assigned. A failure reaching this module from elsewhere (a contract refusal
 * from a client, a database error, a thrown string) is placed by the evidence it
 * carries and otherwise lands in `unexpected`, which is an honest answer rather than a
 * guess: an unrecognised failure is still exactly one kind.
 *
 * Every message here is one line with no credential material, because it is both
 * printed by `collect` and stored against the repository.
 */

/**
 * @typedef {'authentication-rejected'|'permission-missing'|'repository-missing'
 *   |'rate-limited'|'transient'|'unexpected'} FailureKind
 * @typedef {'repository'|'traffic'|'statistics'|'stargazers'} EndpointType
 * @typedef {object} ClassifiedFailure
 * @property {FailureKind} kind Exactly one of the six kinds; never empty and never a guess.
 * @property {number|null} status HTTP status when the failure carries one, otherwise null.
 * @property {EndpointType|null} endpointType Which family of endpoint answered, when the failure names
 *   one. A traffic 403 and a repository 403 are the same kind but a different permission.
 * @property {string} action The next step, as its own sentence, naming a command that exists.
 * @property {string} message One single line: the status or the lead-in, what the failure means, and
 *   the action. Free of credential material.
 * @property {boolean} needsReauthentication True when only a new token resolves the state: the token
 *   was rejected (401) or it lacks the permission the endpoint requires (403).
 */

/** The whole typed set. A seventh kind is a schema change, not a new branch here. */
export const FAILURE_KINDS = /** @type {readonly FailureKind[]} */ (Object.freeze([
  'authentication-rejected', 'permission-missing', 'repository-missing', 'rate-limited', 'transient', 'unexpected',
]));

/**
 * The permission the traffic endpoints require of a fine-grained token, spelled once so the
 * permission state and the re-authentication state cannot drift apart. RS-SP-01 records that
 * `Contents` is never requested, so no other permission is named here.
 */
export const TRAFFIC_PERMISSION = 'Administration repository permission (read)';

/** @type {readonly FailureKind[]} */
const REAUTHENTICATION_KINDS = Object.freeze(['authentication-rejected', 'permission-missing']);

/**
 * The next step for each kind. Every sentence except the unexpected one names a
 * command this CLI actually registers, because an action the maintainer cannot
 * run is worse than a plain explanation. An unexpected failure has no known next
 * step, so it names the recorded detail instead of inventing a command.
 */
const RECONNECT_ACTION =
  'Replace the token in the home credential file (mode 0600) with a fine-grained token limited to the ' +
  `enrolled repositories that holds the ${TRAFFIC_PERMISSION}, then run node src/cli.js config check`;
const GRANT_TRAFFIC_PERMISSION_ACTION =
  `Grant the ${TRAFFIC_PERMISSION} to the token for this repository, accept the permission ` +
  'upgrade on GitHub, then run node src/cli.js collect';
const CHECK_REPOSITORY_ACCESS_ACTION =
  'Check the owner and name spelling and that the token can read the repository, run node src/cli.js discover ' +
  'to see the names GitHub serves this token, then re-enrol the correct name in the configuration';
const WAIT_FOR_RATE_LIMIT_ACTION =
  'Wait for GitHub to reset the rate limit for this token, then run node src/cli.js collect';
const COLLECT_AGAIN_LATER_ACTION =
  'Run node src/cli.js collect again later; a failed collection changes no stored day';
const ADOPT_CURRENT_NAME_ACTION =
  'Update the enrolled name in the configuration to the name GitHub now serves, then run ' +
  'node src/cli.js collect';
const UNEXPECTED_ACTION =
  'Read the failure detail recorded with this classification; it matches none of the six known kinds';

/**
 * GitHub answers a request for a renamed or transferred repository with a redirect, and this
 * transport refuses every redirect. That is the one transport code that explains itself, so it
 * is reported as an identity to adopt rather than as a local transport fault - and never as a
 * repository that disappeared, because a rename keeps the history it already has.
 */
const REDIRECT_CODE = 'ERR_TRANSPORT_REDIRECT';
const REDIRECT_DETAIL =
  'GitHub answered with a redirect, this collector follows no redirect, and the repository is no longer '
  + 'served under the enrolled name';

/** A request that never reached GitHub is transient; any other transport code is a local problem. */
const TRANSIENT_CODES = new Set(['ERR_TRANSPORT_TIMEOUT', 'ERR_TRANSPORT_NETWORK']);

/**
 * @param {unknown} value
 * @returns {value is FailureKind} Whether the value is one of the six kinds.
 */
export function isFailureKind(value) {
  return typeof value === 'string'
    && /** @type {readonly string[]} */ (FAILURE_KINDS).includes(value);
}

/**
 * Whether a state can only be left by replacing the token. Both the PRD's needs
 * re-authentication state and RS-SP-02's permission state are this one flag.
 * @param {unknown} kind
 * @returns {boolean}
 */
export function needsReauthentication(kind) {
  return isFailureKind(kind) && REAUTHENTICATION_KINDS.includes(kind);
}

/**
 * One printable line with no control characters and no token-shaped value, so it is safe to
 * print, to store against a repository, and to compare in a test.
 * @param {string} text
 * @param {readonly string[]} [secrets] Values the caller already knows are secret.
 * @returns {string}
 */
export function safeFailureMessage(text, secrets = []) {
  return redact(String(text), secrets)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {unknown} value
 * @returns {number|null} The status when it is an HTTP status code, otherwise null.
 */
function statusOf(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

/**
 * Which endpoint family answered, read from the path the failure carries. A `403` means different
 * things for a traffic endpoint (it needs the Administration read permission) and for a repository
 * endpoint (it cannot read the repository at all), so the permission message may name that
 * permission only where the evidence supports it.
 * @param {unknown} endpoint
 * @param {EndpointType|null} hint The caller's own knowledge of the endpoint it invoked, which wins.
 * @returns {{type: EndpointType|null, repo: string|null}}
 */
function locateEndpoint(endpoint, hint) {
  const path = typeof endpoint === 'string' ? endpoint.split(/[?#]/)[0] ?? '' : '';
  const marker = '/repos/';
  const at = path.indexOf(marker);
  if (at === -1) return { type: hint, repo: null };
  const rest = path.slice(at + marker.length);
  const [owner, name] = rest.split('/');
  const repo = owner === undefined || owner === '' || name === undefined || name === '' ? null : `${owner}/${name}`;
  const type = /\/traffic(\/|$)/.test(rest) ? 'traffic' : /\/stats(\/|$)/.test(rest) ? 'statistics'
    : /\/(?:stargazers|subscribers)(\/|$)/.test(rest) ? 'stargazers'
      : 'repository';
  return { type: hint ?? type, repo };
}

/**
 * @param {number} status
 * @returns {FailureKind|null} The kind the status alone proves, or null when it proves none.
 */
function kindForStatus(status) {
  if (status === 401) return 'authentication-rejected';
  if (status === 403) return 'permission-missing';
  if (status === 404) return 'repository-missing';
  if (status === 429) return 'rate-limited';
  // A 202 that survived the policy's own retries means the statistics cache is still
  // compiling. That is a normal state for a new repository, not a fault.
  if (status === 202 || (status >= 500 && status <= 599)) return 'transient';
  return null;
}

/**
 * @param {unknown} code Transport code, when the failure carries one.
 * @returns {FailureKind|null}
 */
function kindForTransportCode(code) {
  return typeof code === 'string' && TRANSIENT_CODES.has(code) ? 'transient' : null;
}

/**
 * What a kind means here, and what to do about it. An `unexpected` failure is described from the
 * failure itself rather than from this table, so the cause is never discarded.
 * @param {FailureKind} kind
 * @param {EndpointType|null} endpointType
 * @param {number|null} status
 * @returns {{detail: string, action: string}}
 */
function describeKind(kind, endpointType, status) {
  switch (kind) {
    case 'authentication-rejected':
      return {
        detail: 'the stored credential was rejected, so the token is expired, revoked, or was never '
          + 'accepted for this account',
        action: RECONNECT_ACTION,
      };
    case 'permission-missing':
      // Only a traffic endpoint requires the Administration read permission, so only a traffic
      // endpoint may report that permission as the one missing. The stargazer listing is a
      // third case again: GitHub restricts it to admins and collaborators, so no token
      // permission the maintainer can grant is what is missing.
      if (endpointType === 'traffic') {
        return {
          detail: `the token is missing the ${TRAFFIC_PERMISSION} that the traffic endpoints require`,
          action: GRANT_TRAFFIC_PERMISSION_ACTION,
        };
      }
      if (endpointType === 'stargazers') {
        return {
          detail: 'GitHub limits the stargazer listing to admins and collaborators, so this token cannot '
            + 'read it; the traffic endpoints this repository needs are unaffected',
          action: STARGAZERS_RESTRICTED_ACTION,
        };
      }
      return {
        detail: 'the token cannot read this endpoint; the '
          + `${TRAFFIC_PERMISSION} is required by the traffic endpoints only`,
        action: CHECK_REPOSITORY_ACCESS_ACTION,
      };
    case 'repository-missing':
      return {
        detail: 'GitHub does not serve this repository under this name, or the token cannot see it',
        action: CHECK_REPOSITORY_ACCESS_ACTION,
      };
    case 'rate-limited':
      return {
        detail: 'the request rate limit for this token is exhausted, so GitHub refused the request '
          + 'before serving it',
        action: WAIT_FOR_RATE_LIMIT_ACTION,
      };
    case 'transient':
      if (status === 202) {
        return {
          detail: 'the statistics cache is still compiling and GitHub has no data for it yet, which is a '
            + 'normal state for a repository GitHub has no statistics for',
          action: COLLECT_AGAIN_LATER_ACTION,
        };
      }
      return status === null
        ? { detail: 'the request did not complete, so GitHub never answered it', action: COLLECT_AGAIN_LATER_ACTION }
        : { detail: 'GitHub reported a temporary service failure', action: COLLECT_AGAIN_LATER_ACTION };
    default:
      return { detail: '', action: UNEXPECTED_ACTION };
  }
}

/**
 * The single-line detail an unrecognised failure carries. A classification that dropped its cause
 * would not be actionable, so the recorded message keeps the message the failure arrived with.
 * @param {{message?: unknown}} failure
 * @param {unknown} error The original thrown value.
 * @returns {string}
 */
function unexpectedDetail(failure, error) {
  const raw = error instanceof Error ? error.message
    : typeof error === 'string' ? error
      : typeof failure.message === 'string' ? failure.message
        : '';
  const text = safeFailureMessage(raw).replace(/\.+$/, '');
  return text === '' ? 'the failure carries no message to report' : text;
}

/**
 * Map one collection failure onto exactly one of the six kinds, with an action-oriented
 * message that names the next step for the two kinds the maintainer must act on.
 *
 * The kind the transport policy already assigned is used unchanged, because that component
 * saw the status and the endpoint family; otherwise the status, then the transport code, place
 * the failure, and anything unplaced is `unexpected`. Nothing here retries or decides that a
 * run stops.
 * @param {unknown} error The thrown value, or the failure a client reported.
 * @param {object} [options]
 * @param {string|null} [options.repo] `owner/name` the run was collecting, for the message.
 * @param {EndpointType|null} [options.endpointType] The caller's endpoint family, which wins over the path.
 * @param {readonly string[]} [options.secrets] Values redacted from every field.
 * @returns {ClassifiedFailure}
 */
export function classifyFailure(error, { repo = null, endpointType = null, secrets = [] } = {}) {
  const failure = /** @type {{kind?: unknown, status?: unknown, code?: unknown, action?: unknown,
   * endpoint?: unknown, message?: unknown}} */ (error ?? {});
  const status = statusOf(failure.status);
  const located = locateEndpoint(failure.endpoint, endpointType);
  const subject = typeof repo === 'string' && repo.trim() !== '' ? repo : located.repo ?? 'the enrolled repository';

  const fromStatus = status === null ? null : kindForStatus(status);
  /** @type {FailureKind} */
  const kind = isFailureKind(failure.kind) ? failure.kind
    : fromStatus ?? kindForTransportCode(failure.code) ?? 'unexpected';

  const described = describeKind(kind, located.type, status);
  // An unexpected failure keeps the cause it arrived with, and prefers the next step the
  // failure itself supplied; a known kind keeps this module's step, so one kind cannot be
  // printed with two different next steps.
  const transportAction = typeof failure.action === 'string' && failure.action.trim() !== ''
    ? failure.action
    : null;
  const detail = kind === 'unexpected'
    ? (failure.code === REDIRECT_CODE ? REDIRECT_DETAIL : unexpectedDetail(failure, error))
    : described.detail;
  const action = kind === 'unexpected'
    ? (failure.code === REDIRECT_CODE ? ADOPT_CURRENT_NAME_ACTION : transportAction ?? described.action)
    : described.action;
  const lead = status === null
    ? `Collection of ${subject} failed:`
    : `GitHub answered HTTP ${status} for ${subject}:`;
  const message = safeFailureMessage(`${lead} ${detail}. Next step: ${action}`, secrets);

  return {
    kind,
    status,
    endpointType: located.type,
    action: safeFailureMessage(action, secrets),
    message,
    needsReauthentication: needsReauthentication(kind),
  };
}
