import { appendSnapshot } from '../db/snapshot-repo.js';
import { assertRepository, assertTimestamp, withTransaction } from '../db/ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('../github/traffic-client.js').ReferrerRecord} ReferrerRecord */
/** @typedef {import('../github/traffic-client.js').PopularPathRecord} PopularPathRecord */
/** @typedef {import('../db/snapshot-repo.js').SnapshotKind} SnapshotKind */
/** @typedef {{referrers: (repo: string) => Promise<ReferrerRecord[]>, popularPaths: (repo: string) => Promise<PopularPathRecord[]>}} ListClient */
/** @typedef {Array<'count'|'uniques'>} CountFields */
/** @typedef {{referrers: number, popularPaths: number, rows: number}} SnapshotSummary */

/**
 * Referrer and popular-path payloads are undated aggregates: GitHub serves a top-ten
 * list at request time with no day attached to it, so there is no key a second run
 * could correct and nothing to merge. Every capture is therefore appended whole,
 * stamped with the run that observed it, and the archive keeps them side by side.
 */
export const REFERRERS_KIND = /** @type {const} */ ('referrers');
export const POPULAR_PATHS_KIND = /** @type {const} */ ('popular_paths');

/** @type {CountFields} */
const COUNT_FIELDS = ['count', 'uniques'];

/** @type {Record<SnapshotKind, keyof SnapshotSummary>} */
const SUMMARY_FIELD = { referrers: 'referrers', popular_paths: 'popularPaths' };

/**
 * A capture is identified by the run that observed it, so a run without an identifier
 * cannot be appended. The run row's existence is the archive's foreign key, not a guess
 * made here.
 * @param {unknown} runId
 * @returns {void}
 */
function assertRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new TypeError('Snapshot capture requires the run identifier of the run that observed it');
  }
}

/**
 * Read one returned entry's stored fields, refusing anything the archive cannot hold
 * as it was returned. A missing title, label or count is a contract failure rather
 * than a value to default, and the returned numbers and title are never altered.
 * @param {ReferrerRecord | PopularPathRecord} entry
 * @param {SnapshotKind} kind
 * @param {number} position Zero-based index in the returned list.
 * @returns {{label: string, title: string|null}}
 */
function captureFields(entry, kind, position) {
  const list = kind === REFERRERS_KIND ? 'referrers' : 'popular paths';
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`Traffic ${list} entry must be a record`);
  }
  const labelField = kind === REFERRERS_KIND ? 'referrer' : 'path';
  const label = kind === REFERRERS_KIND ? entry.referrer : entry.path;
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError(`Traffic ${list} entry ${position} must carry a non-empty ${labelField}`);
  }
  for (const field of COUNT_FIELDS) {
    const value = entry[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Traffic ${list} entry ${position} must carry a non-negative integer ${field}`);
    }
  }
  if (kind === POPULAR_PATHS_KIND && typeof entry.title !== 'string') {
    throw new TypeError(`Traffic popular paths entry ${position} must carry the title GitHub returned`);
  }
  return { label, title: kind === POPULAR_PATHS_KIND ? /** @type {string} */ (entry.title) : null };
}

/**
 * Append one repository's returned lists as two captures.
 *
 * Every returned entry becomes one row carrying the run identifier, the capture time
 * and its position in the returned list, in the order GitHub ranked it. Nothing is
 * upserted, deduplicated or padded: a list of three writes three rows, and a second
 * run appends a second capture beside the first instead of correcting it. No day is
 * assigned, because these lists have no day dimension to correct.
 *
 * Synchronous and write-only, so a caller that must commit a repository's day rows
 * and its snapshots together can compose this inside one wider transaction; the
 * network reads belong to collectSnapshots.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.runId Run that observed this capture; it must already exist.
 * @param {ReferrerRecord[]} options.referrers
 * @param {PopularPathRecord[]} options.popularPaths
 * @param {string} options.collectedAt canonical UTC ISO timestamp for the whole capture
 * @returns {SnapshotSummary} Entries appended per kind and in total. Nothing is ever
 * revised, so an existing capture is never counted as applied a second time.
 */
export function writeSnapshotCaptures({ db, repositoryId, runId, referrers, popularPaths, collectedAt }) {
  assertTimestamp(collectedAt);
  assertRepository(db, repositoryId);
  assertRunId(runId);
  if (!Array.isArray(referrers) || !Array.isArray(popularPaths)) {
    throw new TypeError('Referrer and popular-path captures must both be returned lists');
  }

  /** @type {SnapshotSummary} */
  const summary = { referrers: 0, popularPaths: 0, rows: 0 };

  /** @param {SnapshotKind} kind @param {Array<ReferrerRecord | PopularPathRecord>} entries */
  const append = (kind, entries) => {
    for (const [position, entry] of entries.entries()) {
      const { label, title } = captureFields(entry, kind, position);
      appendSnapshot(db, { repositoryId, runId, kind, label, title, count: entry.count,
        uniques: entry.uniques, position, collectedAt });
      summary[SUMMARY_FIELD[kind]] += 1;
      summary.rows += 1;
    }
  };
  append(REFERRERS_KIND, referrers);
  append(POPULAR_PATHS_KIND, popularPaths);
  return summary;
}

/**
 * Collect the top referrers and top popular paths of one repository and append them
 * as two captures.
 *
 * Both lists are read before the transaction opens, because an archive transaction
 * is synchronous and must never hold a socket open; the appends then commit as a
 * single transaction, so a failure between two appends or a kill between
 * repositories leaves no half-written capture behind. This step decides nothing
 * about whether a run continues: it raises the failure and the run decides that. It
 * embeds no timer and reads no clock, because the collection time belongs to the run
 * that scheduled it.
 * @param {object} options
 * @param {Database} options.db
 * @param {number} options.repositoryId
 * @param {string} options.repo owner/name pair
 * @param {string} options.runId Run that observed these captures; it must already exist.
 * @param {ListClient} options.trafficClient
 * @param {string} options.collectedAt canonical UTC ISO timestamp for this run
 * @returns {Promise<SnapshotSummary>}
 */
export async function collectSnapshots({ db, repositoryId, repo, runId, trafficClient, collectedAt }) {
  assertTimestamp(collectedAt);
  assertRepository(db, repositoryId);
  assertRunId(runId);
  const referrers = await trafficClient.referrers(repo);
  const popularPaths = await trafficClient.popularPaths(repo);
  return withTransaction(db, () => writeSnapshotCaptures({
    db, repositoryId, runId, referrers, popularPaths, collectedAt,
  }));
}