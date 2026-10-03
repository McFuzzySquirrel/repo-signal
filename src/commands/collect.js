import { loadConfig } from '../config/load.js';
import { redact } from '../credentials/redact.js';
import { loadCredentials } from '../credentials/store.js';
import { openArchive } from '../db/ops-repo.js';
import { createCredentialProvider } from '../github/credential-provider.js';
import { createHttpTransport } from '../github/http.js';
import { createRetryPolicy } from '../github/retry.js';
import { resolveHomePaths } from '../paths.js';
import {
  BACKFILL_FIRST_CONNECT, BACKFILL_SKIPPED, RUN_STATUS_DEGRADED, CollectScopeError, collectRun,
  resolveCollectScope,
} from '../collect/run.js';
import { EXIT_OPERATIONAL_FAILURE, EXIT_SUCCESS, UsageError } from './index.js';

/** @typedef {import('../collect/run.js').CollectSummary} CollectSummary */
/** @typedef {import('../collect/run.js').RepositoryOutcome} RepositoryOutcome */
/** @typedef {import('../collect/run.js').PlannedRepository} PlannedRepository */

const USAGE = 'run node src/cli.js collect [--dry-run] [--repo owner/name]';

/**
 * @param {unknown} error
 * @param {readonly string[]} [secrets]
 * @returns {string} A single-line message safe to print.
 */
function safeMessage(error, secrets = []) {
  return redact(error instanceof Error ? error.message : String(error), secrets)
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * Parse the command's own flags. A mistyped flag, a repeated flag or a malformed
 * repository name is a usage error, never a collection decision.
 * @param {string[]} args
 * @returns {{ dryRun: boolean, repo: string|null }}
 */
function parseCollectArgs(args) {
  let dryRun = false;
  let sawRepo = false;
  /** @type {string|null} */
  let repo = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      if (dryRun) throw new UsageError(redact(`collect was given --dry-run twice; ${USAGE}`));
      dryRun = true;
    } else if (arg === '--repo') {
      if (sawRepo) throw new UsageError(redact(`collect was given --repo twice; ${USAGE}`));
      sawRepo = true;
      const value = args[index + 1];
      if (value === undefined) throw new UsageError(redact(`collect --repo needs an owner/name pair; ${USAGE}`));
      repo = value;
      index += 1;
    } else if (arg.startsWith('--repo=')) {
      if (sawRepo) throw new UsageError(redact(`collect was given --repo twice; ${USAGE}`));
      sawRepo = true;
      repo = arg.slice('--repo='.length);
    } else {
      throw new UsageError(redact(`collect does not know "${arg}"; ${USAGE}`));
    }
  }
  if (repo !== null && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new UsageError(redact(`collect --repo ${repo} is not an owner/name pair; ${USAGE}`));
  }
  return { dryRun, repo };
}

/**
 * One planned line per repository: what it would collect and whether the
 * first-connect backfill would run before it. The request count is a floor when
 * GitHub would return more stargazer pages than the single one the plan assumed.
 * A repository the archive already marked unavailable is planned as skipped, with
 * the reason it was marked and no request at all.
 * @param {PlannedRepository} planned
 * @returns {string}
 */
function plannedLine(planned) {
  if (planned.skipped) {
    return `${planned.repo} skipped lifecycle=unavailable requests=0 ${planned.unavailableReason ?? ''}`.trimEnd();
  }
  const backfill = planned.backfill ? BACKFILL_FIRST_CONNECT : BACKFILL_SKIPPED;
  const requests = planned.exactRequests ? `requests=${planned.requests}` : `requests>=${planned.requests}`;
  return `${planned.repo} planned backfill=${backfill} ${requests}`;
}

/**
 * The lifecycle change this run recorded, named so a renamed or transferred
 * repository reads as what happened to it rather than as a silent address change.
 * @param {RepositoryOutcome} outcome
 * @returns {string}
 */
function identityNote(outcome) {
  const change = outcome.identity;
  if (change === null || !change.aliasRecorded) return '';
  const words = [
    ...(change.renamed ? ['renamed'] : []),
    ...(change.transferred ? ['transferred'] : []),
  ].join(' and ');
  return ` ${words} ${change.previousOwner}/${change.previousName} -> ${change.repo}`;
}

/**
 * One line per collected repository: the days collected, what was written and
 * what was revised, the appended snapshot rows, the backfill step and any rename or
 * transfer. Nothing here is a verdict about the repository; it is what the archive
 * now holds. A repository GitHub no longer serves is reported as unavailable with
 * the reason it gave, and one an earlier run marked is reported as skipped.
 * @param {RepositoryOutcome} outcome
 * @returns {string}
 */
function collectedLine(outcome) {
  const backfill = outcome.backfill === null ? BACKFILL_SKIPPED : BACKFILL_FIRST_CONNECT;
  if (outcome.state === 'unavailable') {
    return `${outcome.repo} unavailable ${outcome.unavailableReason ?? ''}`.trimEnd();
  }
  if (outcome.state === 'skipped') {
    return `${outcome.repo} skipped lifecycle=unavailable ${outcome.unavailableReason ?? ''}`.trimEnd();
  }
  if (outcome.state === 'failed' || outcome.traffic === null) {
    const kind = outcome.failure?.kind ?? 'unexpected';
    // The endpoint is named so a failure among the several a run makes can be
    // located without inferring it from a request count.
    const endpoint = outcome.failure?.endpoint === undefined ? '' : ` endpoint=${outcome.failure.endpoint}`;
    return `${outcome.repo} failed ${kind} backfill ${backfill}${endpoint} ${outcome.failure?.message ?? ''}`.trimEnd();
  }
  const traffic = outcome.traffic;
  return `${outcome.repo} ok ${traffic.days} days written ${traffic.written} revised ${traffic.revised} ` +
    `unchanged ${traffic.unchanged} snapshots ${outcome.snapshots?.rows ?? 0} backfill ${backfill}` +
    backfillRefusalNote(outcome) +
    identityNote(outcome);
}

/**
 * What the stargazer listing cost this repository, when GitHub refused it. The
 * traffic this line reports is real; the star history is genuinely absent, and
 * saying so is the difference between a gap and a zero.
 * @param {RepositoryOutcome} outcome
 * @returns {string}
 */
function backfillRefusalNote(outcome) {
  const refusal = outcome.backfillRefusal;
  if (typeof refusal !== 'string' || refusal === '') return '';
  return ` stars-history absent ${refusal}`;
}

/**
 * The single summary line: the counts, the run identifier that matches the run
 * row, and the status. A dry run reports that it wrote nothing and ran nothing.
 * @param {CollectSummary} summary
 * @returns {string}
 */
function summaryLine(summary) {
  const totals = summary.totals;
  if (summary.mode === 'dry-run') {
    const backfill = summary.plan.filter((planned) => planned.backfill).length;
    return `summary mode=dry-run run=none planned=${totals.repositories} backfill=${backfill} requests=0 ` +
      'duration_ms=0 status=planned';
  }
  return `summary run=${summary.runId} repositories=${totals.repositories} ok=${totals.ok} failed=${totals.failed} ` +
    `unavailable=${totals.unavailable} skipped=${totals.skipped} days=${totals.days} rows=${totals.rows} ` +
    `written=${totals.written} revised=${totals.revised} unchanged=${totals.unchanged} ` +
    `snapshots=${totals.snapshots} backfilled=${totals.backfilled} requests=${totals.requests} ` +
    `duration_ms=${totals.durationMs} status=${summary.status}`;
}

/**
 * `collect`: resolve the enrolled set, plan the work, collect each repository
 * independently, write a run record and report a summary. It supports an
 * immediate manual run, a single-repository filter, and a dry run that plans
 * without contacting GitHub. Every printed line passes the redaction helper; a
 * repository that fails is reported and the rest of the run continues, and one
 * GitHub no longer serves is reported as unavailable with the reason it gave, so
 * the command exits `1` while the run record is still complete.
 * @param {import('./index.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function collect(context) {
  const options = parseCollectArgs(context.args);
  /** @type {string[]} */
  const secrets = [];
  /** @param {string} message @returns {string} */
  const clean = (message) => redact(message, secrets).replace(/[\u0000-\u001f\u007f]/g, ' ');

  const homeOptions = { env: context.env, cwd: context.cwd };
  /** @type {import('node:sqlite').DatabaseSync|null} */
  let db = null;
  try {
    const paths = resolveHomePaths(homeOptions);
    /** @type {import('../config/schema.js').Configuration} */
    let config;
    try {
      config = loadConfig(homeOptions);
    } catch (error) {
      if (/** @type {{code?: string}} */ (error).code !== 'ERR_REPO_SIGNAL_CONFIG_MISSING') throw error;
      context.printError(clean(`collect: no configuration file at ${paths.configPath}`));
      context.printError(clean('collect: run node src/cli.js config init, enroll repositories, then run collect again'));
      return EXIT_OPERATIONAL_FAILURE;
    }

    // The filter is checked against the enrolled set before anything is opened
    // or read, so a wrong name costs no credential read, no archive and no request.
    resolveCollectScope({ config, filter: options.repo });

    /**
     * The request policy is built only for a real run, so a dry run never reads
     * the credential file, never constructs a transport and never opens a socket.
     * @type {ReturnType<typeof createRetryPolicy>|null}
     */
    let policy = null;
    if (!options.dryRun) {
      const credentials = loadCredentials(paths);
      const token = await credentials.getToken();
      if (token !== '') secrets.push(token);
      const credentialProvider = createCredentialProvider(credentials);
      const baseUrl = context.env.REPO_SIGNAL_GITHUB_BASE_URL?.trim();
      const transport = createHttpTransport({
        credentialProvider,
        ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }),
      });
      policy = createRetryPolicy({ transport });
    }

    db = await openArchive(paths.databasePath);
    const summary = await collectRun({
      db,
      config,
      policy: policy ?? undefined,
      filter: options.repo,
      dryRun: options.dryRun,
      secrets,
    });
    if (summary.mode === 'dry-run') {
      for (const planned of summary.plan) context.print(clean(plannedLine(planned)));
    } else {
      for (const outcome of summary.outcomes) context.print(clean(collectedLine(outcome)));
    }
    context.print(clean(summaryLine(summary)));
    return summary.status === RUN_STATUS_DEGRADED ? EXIT_OPERATIONAL_FAILURE : EXIT_SUCCESS;
  } catch (error) {
    // A filter naming a repository the enrolled set does not contain is a
    // mistake in the command line rather than a collection failure, so it keeps
    // the usage exit code and the usage text.
    if (error instanceof CollectScopeError) throw new UsageError(clean(error.message));
    context.printError(clean(`collect failed: ${safeMessage(error, secrets)}`));
    return EXIT_OPERATIONAL_FAILURE;
  } finally {
    if (db !== null) db.close();
  }
}
