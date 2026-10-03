import process from 'node:process';

import { redact } from '../credentials/redact.js';
import { openArchive } from '../db/ops-repo.js';
import { resolveHomePaths } from '../paths.js';
import { createRouter } from '../server/router.js';
import { createServer } from '../server/server.js';
import { createViewRegistry } from '../server/views/index.js';
import { EXIT_OPERATIONAL_FAILURE, EXIT_SUCCESS, UsageError } from './index.js';

/**
 * `serve`: start the read-only dashboard on the loopback interface and hold the
 * process open while it is answering.
 *
 * The command composes three modules that each own one decision and none of them
 * owns another: the server factory binds `127.0.0.1` and sets the security headers,
 * the router maps the three routes and refuses an unknown repository or a malformed
 * range before a view runs, and the view registry decides which page module answers
 * which route. This command resolves the home, opens the archive through the guarded
 * connection, mounts the registry's own pages in front of the router, and prints the
 * URL the factory actually listened on - never a configured default, because a printed
 * port the process is not listening on is the one lie an operator cannot see through.
 *
 * The command reads the archive and nothing else: no configuration file, no
 * credential, no outbound request and no GitHub client, so a dashboard on a home
 * with no token still serves every page its archive can answer.
 */

/** @typedef {import('node:sqlite').DatabaseSync} Database */

const USAGE = 'run node src/cli.js serve [--port 0]';
const HELP_FLAGS = new Set(['-h', '--help']);
const PORT_PATTERN = /^\d{1,5}$/;
const MAX_PORT = 65_535;

const HELP_TEXT = [
  'Usage:',
  '  node src/cli.js serve [--port 0]',
  '',
  'Starts the read-only dashboard on 127.0.0.1 with the view registry mounted, and',
  'prints the URL it is actually listening on. The port flag is accepted so a test',
  'can ask for an ephemeral port; 0 is the only value this build honours, because',
  'the server binds an ephemeral loopback port and takes no fixed one.',
  '',
  'Exit codes:',
  '  0  the dashboard closed on a signal',
  '  1  the dashboard could not start',
  '  2  the command line was a usage error',
].join('\n');

/**
 * @param {unknown} error
 * @returns {string} A single-line message safe to print.
 */
function safeMessage(error) {
  return redact(error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * Parse the command's own flags. A mistyped flag, a repeated flag, a missing value
 * or a port this build cannot bind is a usage error: an operator who typed a port
 * wants to be told it was refused rather than to be handed a different one.
 *
 * @param {string[]} args
 * @returns {{ help: boolean, port: number }}
 */
function parseServeArgs(args) {
  /** @type {number} */
  let port = 0;
  let sawPort = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (HELP_FLAGS.has(arg)) return { help: true, port };
    /** @type {string|undefined} */
    let value;
    if (arg === '--port') {
      if (sawPort) throw new UsageError(redact(`serve was given --port twice; ${USAGE}`));
      value = args[index + 1];
      if (value === undefined) throw new UsageError(redact(`serve --port needs a port number; ${USAGE}`));
      index += 1;
    } else if (arg.startsWith('--port=')) {
      if (sawPort) throw new UsageError(redact(`serve was given --port twice; ${USAGE}`));
      value = arg.slice('--port='.length);
    } else {
      throw new UsageError(redact(`serve does not know "${arg}"; ${USAGE}`));
    }
    if (!PORT_PATTERN.test(value)) {
      throw new UsageError(redact(`serve --port "${value}" is not a port number; ${USAGE}`));
    }
    const parsed = Number(value);
    if (parsed > MAX_PORT) {
      throw new UsageError(redact(`serve --port ${parsed} is above the highest port ${MAX_PORT}; ${USAGE}`));
    }
    if (parsed !== 0) {
      throw new UsageError(redact(`serve --port ${parsed} cannot be honoured: this dashboard binds an ephemeral `
        + 'port on 127.0.0.1 and takes no fixed port, so 0 is the only value it accepts. The URL it is '
        + `listening on is printed when it starts; ${USAGE}`));
    }
    sawPort = true;
    port = parsed;
  }
  return { help: false, port };
}

/**
 * Resolve until the process is asked to stop. A dashboard holds no timer and no
 * scheduler, so a signal is the only thing that ends it; each handler removes both
 * of them so a second signal is the process's own default rather than a second
 * close of the same server.
 *
 * @returns {Promise<number>} The exit code the command ends with.
 */
function untilStopped() {
  const signals = /** @type {const} */ (['SIGINT', 'SIGTERM']);
  return new Promise((resolve) => {
    const stop = () => {
      for (const signal of signals) process.removeListener(signal, stop);
      resolve(EXIT_SUCCESS);
    };
    for (const signal of signals) process.once(signal, stop);
  });
}

/**
 * `serve`: open the archive, mount the view registry behind the router, start the
 * loopback server and print where it is listening. It returns when a signal ends
 * it, so the process lives exactly as long as the dashboard is answering.
 *
 * A home that cannot be resolved or an archive that cannot be migrated is an
 * operational failure and exits 1 with the reason named; a mistyped flag is a usage
 * error and exits 2.
 *
 * @param {import('./index.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function serve(context) {
  const options = parseServeArgs(context.args);
  if (options.help) {
    context.print(HELP_TEXT);
    return EXIT_SUCCESS;
  }

  /** @type {Database|null} */
  let db = null;
  /** @type {{url: string, close: () => Promise<void>}|null} */
  let server = null;
  try {
    const paths = resolveHomePaths({ env: context.env, cwd: context.cwd });
    db = await openArchive(paths.databasePath);
    const today = new Date().toISOString().slice(0, 10);
    const registry = createViewRegistry({ db, today });
    const router = createRouter({ views: registry.views, hasRepository: registry.hasRepository });
    // The router dispatches the three routes it owns and every status it returns. The
    // pages the registry mounts at a path of its own - the collection health page today
    // - are answered in front of it, so adding a page stays a change in the registry
    // plus that page's view module and never an edit to the router.
    server = await createServer({ handler: registry.answerOwnRoutes(router) });

    // The URL the factory returned is the only address and port this command reports.
    context.print(redact(`serve listening on ${server.url}`));
    context.print(redact(`repository list: ${server.url}/repos`));
    context.print(redact(`collection health: ${server.url}${registry.healthPath}`));
    // The stylesheet is served by the registry's own asset route rather than by a
    // static file server, and it is printed so a 404 on it is a one-line check.
    context.print(redact(`stylesheet: ${server.url}${registry.themePath}`));
    context.print(redact(`archive: ${paths.databasePath}`));
    context.print('stop with Ctrl-C; the dashboard only reads the archive while it is open');

    const exitCode = await untilStopped();
    await server.close();
    server = null;
    db.close();
    db = null;
    return exitCode;
  } catch (error) {
    context.printError(redact(`serve failed: ${safeMessage(error)}`));
    return EXIT_OPERATIONAL_FAILURE;
  } finally {
    if (server !== null) await server.close();
    if (db !== null) db.close();
  }
}