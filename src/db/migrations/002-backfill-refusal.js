/**
 * Record that a repository's first-connect backfill was refused, without ever
 * inventing a backfill.
 *
 * A refusal is deliberately kept beside the repository identity rather than in
 * `backfill_records`: the provenance read counts every row in that table as a
 * completed backfill, so writing a refusal there would report history that was
 * never reconstructed. These columns are nullable, so an archive written before
 * this migration reads as never refused, and no existing row is rewritten,
 * densified or removed.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export function up(db) {
  db.exec(`
    ALTER TABLE repositories ADD COLUMN backfill_refused_at TEXT;
    ALTER TABLE repositories ADD COLUMN backfill_refused_reason TEXT;
  `);
}