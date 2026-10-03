import { redact } from '../credentials/redact.js';
import { loadConfig } from '../config/load.js';
import { openArchive } from '../db/ops-repo.js';
import { firstStoredDay } from '../db/day-series-repo.js';
import { resolveEnrollment } from '../enrollment/resolve.js';
import { collectionHealth } from '../supervision/health.js';
import { readRepositoryPage } from '../server/repo-data.js';
import { sevenDayDelta, weekOverWeekDelta } from '../insight/deltas.js';
import { resolveHomePaths } from '../paths.js';
import {
  changeBlock, coverageLine, header, refusalLine, repositoryLines, runBlock, summaryBlock,
} from '../report/format.js';
import { EXIT_OPERATIONAL_FAILURE, EXIT_SUCCESS, UsageError } from './index.js';

/**
 * The days a default report covers. Fourteen is not an arbitrary window: it is the
 * span of GitHub's own traffic window, so the days a report says carry no value are
 * days the archive was ever able to hold, rather than days that had already rolled
 * out of GitHub's reach before collection began.
 */
export const REPORT_DEFAULT_DAYS = 14;

/** Metrics a per-repository report reads a comparison for. */
const COMPARED_METRICS = ['clones', 'unique-cloners', 'views', 'unique-visitors'];

/**
 * @param {string} value
 * @returns {boolean}
 */
function isIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * The flags this command accepts. Anything else is a usage error, so a mistyped flag
 * cannot be silently ignored and quietly change what the report covers.
 * @param {string[]} args
 * @returns {{repo: string|null, from: string|null, to: string|null}}
 */
export function parseReportArgs(args) {
  /** @type {{repo: string|null, from: string|null, to: string|null}} */
  const options = { repo: null, from: null, to: null };
  /** @type {Map<string, string[]>} */
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = /** @type {string} */ (args[index]);
    if (arg !== '--repo' && arg !== '--from' && arg !== '--to') {
      throw new UsageError(redact(
        `report does not know "${arg}"; run node src/cli.js report --help for its flags`));
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(redact(`${arg} needs a value; run node src/cli.js report --help for its flags`));
    }
    const seen = values.get(arg) ?? [];
    seen.push(value);
    values.set(arg, seen);
    index += 1;
  }
  for (const [flag, seen] of values) {
    if (seen.length > 1) {
      throw new UsageError(redact(`${flag} was given more than once; supply it once`));
    }
  }
  options.repo = values.get('--repo')?.[0] ?? null;
  options.from = values.get('--from')?.[0] ?? null;
  options.to = values.get('--to')?.[0] ?? null;
  if (options.repo !== null && options.repo.split('/').length !== 2) {
    throw new UsageError(redact(
      `--repo needs one owner/name pair; got "${options.repo}". Run node src/cli.js report --help for its flags`));
  }
  for (const flag of ['--from', '--to']) {
    const value = flag === '--from' ? options.from : options.to;
    if (value !== null && !isIsoDay(value)) {
      throw new UsageError(redact(`${flag} needs an ISO day such as 2026-01-31; got "${value}"`));
    }
  }
  if (options.from !== null && options.to !== null && options.from > options.to) {
    throw new UsageError(redact(`--from ${options.from} is later than --to ${options.to}`));
  }
  return options;
}

/**
 * `report`: print a plain-text written summary of what the archive already holds.
 *
 * It reads the archive and nothing else: no request is made, no credential is read
 * and no figure is computed here, so every number it prints is a number the archive
 * holds. The bare command reports the most recent run and the enrolled-set roll-up;
 * `--repo` adds one repository's recorded coverage, its gaps and its change.
 *
 * It exits 0 whenever it read the archive, whatever states it reports. A scheduled
 * run should not fail because a repository is degraded - the state words are the
 * news, and a non-zero exit would say the report itself failed. An unknown flag and
 * a `--repo` naming a repository that is not enrolled are mistakes in the command
 * line, so they keep the usage exit code.
 * @param {import('./index.js').CommandContext} context
 * @returns {Promise<number>}
 */
export async function report(context) {
  const options = parseReportArgs(context.args);
  /** @param {string} message @returns {string} */
  const clean = (message) => redact(message).replace(/[\u0000-\u001f\u007f]/g, ' ');
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
      context.printError(clean(`report: no configuration file at ${paths.configPath}`));
      context.printError(clean('report: run node src/cli.js config init, enroll repositories, then run report again'));
      return EXIT_OPERATIONAL_FAILURE;
    }

    // Checked against the enrolled set before the archive is opened, so a wrong
    // name costs no read at all. The report widens nothing: it never enrolls.
    if (options.repo !== null) assertEnrolled(config, options.repo);

    db = await openArchive(paths.databasePath);
    const clock = Date.now;
    const today = new Date(clock()).toISOString().slice(0, 10);
    const health = collectionHealth({ db, clock });

    for (const line of header(options.repo === null ? 'the enrolled set' : options.repo)) {
      context.print(clean(line));
    }
    context.print(clean(`home: ${paths.home}`));
    context.print(clean(`read at ${health.readAt} (${today})`));
    for (const line of runBlock(health)) context.print(clean(line));
    for (const line of summaryBlock(health.summary)) context.print(clean(line));
    for (const line of repositoryLines(health.repositories)) context.print(clean(line));

    if (options.repo !== null) {
      const [owner, name] = options.repo.split('/');
      // The default window ends today and spans GitHub's own traffic window, so a
      // day the report calls empty is one the archive could have held.
      const to = options.to ?? today;
      const from = options.from ?? isoDayBefore(to, REPORT_DEFAULT_DAYS - 1);
      const page = readRepositoryPage({ db, owner, name, from, to, clock, today });
      context.print(clean(''));
      context.print(clean(`coverage: ${page.owner}/${page.name} ${from} to ${to}`));
      if (page.status === 'known') {
        const id = /** @type {number} */ (page.repository?.id);
        for (const series of page.series) {
          const first = firstStoredDay(db, {
            repositoryId: id, metric: series.metric, granularity: series.granularity,
          });
          context.print(clean(coverageLine({
            metric: series.metric, granularity: series.granularity, series,
            calendarDays: page.calendarDays, firstStoredDay: first,
          })));
        }
        for (const line of refusalLine(page.repository?.backfillRefusedReason ?? null)) {
          context.print(clean(line));
        }
        context.print(clean(''));
        context.print(clean(`change: ${page.owner}/${page.name}`));
        for (const metric of COMPARED_METRICS) {
          const series = page.series.find((entry) => entry.metric === metric);
          const observations = (series?.rows ?? []).map((row) => ({ day: row.day, value: row.value }));
          const range = { from, to };
          for (const line of changeBlock(metric,
            sevenDayDelta({ metric, observations, range }),
            weekOverWeekDelta({ metric, observations, range, today }))) {
            context.print(clean(line));
          }
        }
      } else {
        context.print(clean(`  no archive holds ${page.owner}/${page.name}`));
      }
    }
    return EXIT_SUCCESS;
  } catch (error) {
    // A refusal about the command line keeps the usage exit code; only a failure to
    // read the archive is this command's own operational failure.
    if (error instanceof UsageError) throw error;
    context.printError(clean(`report failed: ${error instanceof Error ? error.message : String(error)}`));
    return EXIT_OPERATIONAL_FAILURE;
  } finally {
    db?.close();
  }
}

/**
 * The ISO day the given number of days before `day`, counted inclusively from it.
 * @param {string} day ISO `YYYY-MM-DD`.
 * @param {number} count Days to move back.
 * @returns {string}
 */
export function isoDayBefore(day, count) {
  const time = Date.parse(`${day}T00:00:00.000Z`) - count * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * A repository the report was asked about that the enrolled set does not contain is a
 * mistake in the command line, not a state of the archive, so it keeps the usage exit
 * code and names the set that would have worked. Checked before the archive is opened,
 * so a wrong name costs no read at all.
 * @param {import('../config/schema.js').Configuration} config
 * @param {string} repo One `owner/name` pair.
 * @returns {void}
 */
function assertEnrolled(config, repo) {
  const enrolled = resolveEnrollment(config);
  if (enrolled.some((name) => name.toLowerCase() === repo.toLowerCase())) return;
  const set = enrolled.length === 0 ? 'empty' : enrolled.join(', ');
  throw new UsageError(redact(
    `report --repo ${repo} is not an enrolled repository; the enrolled set is ${set}`));
}