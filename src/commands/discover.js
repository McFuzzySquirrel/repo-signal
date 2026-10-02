import { createCredentialProvider } from '../github/credential-provider.js';
import { createHttpTransport } from '../github/http.js';
import { createRetryPolicy } from '../github/retry.js';
import { redact } from '../credentials/redact.js';
import { loadCredentials } from '../credentials/store.js';
import { loadConfig, parseConfig } from '../config/load.js';
import { resolveHomePaths } from '../paths.js';
import { UsageError } from './index.js';

const DEFAULT_BASE_URL = 'https://api.github.com/';

/** @param {string | null} header @returns {string | null} */
function nextPage(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (match !== null && match[2] === 'next') return match[1];
  }
  return null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} error @returns {string} */
function safeMessage(error) {
  return redact(error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * The ready-to-paste configuration document for the unenrolled repositories.
 * Written as a fenced block in table mode and as `configLines` in JSON mode;
 * both forms load through src/config/load.js without edits.
 * @param {string[]} names
 * @returns {string[]} Lines of the document, one per line.
 */
function configDocumentLines(names) {
  const lines = ['{', '  "enrolled": ['];
  names.forEach((name, index) => {
    lines.push(`    ${JSON.stringify(name)}${index < names.length - 1 ? ',' : ''}`);
  });
  lines.push('  ]', '}');
  return lines;
}

/** Parse the fenced block, proving the printed lines are loader-acceptable.
 * @param {string[]} lines
 */
function assertLoadableDocument(lines) {
  parseConfig(lines.join('\n'));
}

/** @param {import('./index.js').CommandContext} context @returns {Promise<number>} */
export async function discover(context) {
  /** @type {Set<string>} */
  const flags = new Set();
  for (const arg of context.args) {
    if (arg === '--json' || arg === '--include-organizations') flags.add(arg);
    else throw new UsageError(redact(`discover does not know "${arg}"; run node src/cli.js discover --help for its flags`));
  }
  const asJson = flags.has('--json');
  const includeOrganizations = flags.has('--include-organizations');

  let token = '';
  const secrets = () => (token === '' ? [] : [token]);
  try {
    const options = { env: context.env, cwd: context.cwd };
    const paths = resolveHomePaths(options);
    const config = loadConfig(options);
    const credentials = loadCredentials(paths);
    token = await credentials.getToken();
    const credentialProvider = createCredentialProvider(credentials);
    const baseUrl = context.env.REPO_SIGNAL_GITHUB_BASE_URL?.trim() || DEFAULT_BASE_URL;
    const transport = createHttpTransport({ credentialProvider, baseUrl });
    const policy = createRetryPolicy({ transport });

    /** @type {Array<Record<string, unknown>>} */
    const records = [];
    /** @type {string | null} */
    let endpoint = includeOrganizations
      ? '/user/repos?per_page=100'
      : '/user/repos?type=owner&per_page=100';
    while (endpoint !== null) {
      const current = endpoint;
      const response = await policy.get(current, { endpointType: 'repository' });
      if (response.status !== 200) {
        throw new Error(`GitHub HTTP ${response.status}: Check the repository listing endpoint contract before retrying`);
      }
      /** @type {unknown} */
      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new Error('GitHub listing response must be valid JSON');
      }
      if (!Array.isArray(payload)) throw new Error('GitHub listing response must be an array');
      for (const entry of payload) {
        if (!isRecord(entry) || typeof entry.full_name !== 'string') {
          throw new Error('GitHub listing entry must be a record with a full_name');
        }
        records.push(entry);
      }
      const next = nextPage(response.headers.get('link'));
      // A hostile Link target is refused by the transport allowlist, so hand it through.
      endpoint = next;
    }

    /** @type {Set<string>} */
    const denied = new Set(config.denyList.map((name) => name.toLowerCase()));
    /** @type {Set<string>} */
    const enrolled = new Set(config.enrolled.map((name) => name.toLowerCase()));
    /** @type {Array<{ name: string, visibility: string, enrolled: boolean, administrationRead: boolean }>} */
    const repositories = [];
    for (const record of records) {
      const name = /** @type {string} */ (record.full_name);
      if (denied.has(name.toLowerCase())) continue;
      const permissions = isRecord(record.permissions) ? record.permissions : {};
      repositories.push({
        name,
        visibility: typeof record.visibility === 'string' ? record.visibility : 'unknown',
        enrolled: enrolled.has(name.toLowerCase()),
        administrationRead: permissions.admin === true,
      });
    }
    const unenrolled = repositories.filter((repo) => !repo.enrolled).map((repo) => repo.name);
    const configLines = configDocumentLines(unenrolled);
    // The printed block must load unchanged; prove it before printing.
    assertLoadableDocument(configLines);

    if (asJson) {
      context.print(redact(JSON.stringify({ repositories, configLines }, null, 2), secrets()));
      return 0;
    }
    context.print(redact(`discover: ${repositories.length} repositories reachable; ${denied.size > 0 ? 'deny list applied; ' : ''}only Administration read state is shown, never the token or its scopes`, secrets()));
    for (const repo of repositories) {
      context.print(redact(
        `${repo.name} visibility=${repo.visibility} enrolled=${repo.enrolled ? 'yes' : 'no'} administration-read=${repo.administrationRead ? 'yes' : 'no'}`,
        secrets(),
      ));
    }
    context.print(redact('configuration lines to paste for the repositories that are not enrolled:', secrets()));
    context.print('```');
    for (const line of configLines) context.print(redact(line, secrets()));
    context.print('```');
    return 0;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    context.printError(redact(`discover failed: ${safeMessage(error)}`, secrets()));
    return 1;
  }
}
