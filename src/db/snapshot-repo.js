import { assertRepository, assertTimestamp } from './ops-repo.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {'referrers'|'popular_paths'} SnapshotKind */
/** @typedef {{repositoryId: number, runId: string, kind: SnapshotKind, label: string, title?: string|null, count: number, uniques: number, position: number, collectedAt: string}} SnapshotInput */
/** @typedef {Omit<SnapshotInput, 'title'> & {id: number, title: string|null}} Snapshot */
const columns = `id, repository_id AS repositoryId, run_id AS runId, kind, label, title,
  count, uniques, position, collected_at AS collectedAt`;

/**
 * Append one returned list entry, never upsert a label or assign a day. Capture
 * identity is its run plus collection time; positions preserve the vendor's order.
 * Callers wrap all entries in withTransaction when writing a whole capture.
 * @param {Database} db
 * @param {SnapshotInput} snapshot
 */
export function appendSnapshot(db, snapshot) {
  assertTimestamp(snapshot.collectedAt);
  return db.prepare(`INSERT INTO snapshots
    (repository_id, run_id, kind, label, title, count, uniques, position, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(snapshot.repositoryId, snapshot.runId, snapshot.kind, snapshot.label, snapshot.title ?? null,
      snapshot.count, snapshot.uniques, snapshot.position, snapshot.collectedAt);
}

/**
 * Return every stored entry of every capture for this repository/kind, oldest first.
 * Same labels and times are never deduplicated. Tied captures sort by run then list
 * position and insertion id, so repeated entries remain distinguishable.
 * @param {Database} db
 * @param {number} repositoryId
 * @param {SnapshotKind} kind
 * @returns {Snapshot[]}
 */
export function readSnapshotHistory(db, repositoryId, kind) {
  assertRepository(db, repositoryId);
  return /** @type {Snapshot[]} */ (/** @type {unknown} */ (db.prepare(`SELECT ${columns}
    FROM snapshots WHERE repository_id=? AND kind=? ORDER BY collected_at, run_id, position, id`)
    .all(repositoryId, kind)));
}

/**
 * Return all entries of the newest stored capture, not just its first label and
 * not a union of older lists. Ties select the latest inserted run deterministically.
 * No stored capture returns []; no invented capture or day dimension is added.
 * @param {Database} db
 * @param {number} repositoryId
 * @param {SnapshotKind} kind
 * @returns {Snapshot[]}
 */
export function readLatestCapture(db, repositoryId, kind) {
  assertRepository(db, repositoryId);
  return /** @type {Snapshot[]} */ (/** @type {unknown} */ (db.prepare(`SELECT ${columns}
    FROM snapshots WHERE repository_id=? AND kind=? AND (run_id, collected_at) =
      (SELECT run_id, collected_at FROM snapshots WHERE repository_id=? AND kind=?
        ORDER BY collected_at DESC, id DESC LIMIT 1)
    ORDER BY position, id`).all(repositoryId, kind, repositoryId, kind)));
}
