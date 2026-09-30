/**
 * Create the archive's identity, observation and operational evidence tables.
 * Day corrections use ON CONFLICT(repository_id, metric, granularity, day)
 * DO UPDATE SET value=excluded.value, source=excluded.source,
 * collected_at=excluded.collected_at WHERE excluded.collected_at > day_series.collected_at.
 * Collection times are canonical UTC ISO strings, so their ordering is chronological.
 * Snapshots have only a surrogate key: neither a label nor a capture is unique.
 * No table cascades deletion; evidence is retained when lifecycle state changes.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export function up(db) {
  db.exec(`
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'unavailable')),
      unavailable_reason TEXT,
      enrolled INTEGER NOT NULL DEFAULT 0 CHECK (enrolled IN (0, 1)),
      last_seen_at TEXT NOT NULL,
      last_success_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)
    ) STRICT;

    CREATE TABLE repository_aliases (
      repository_id INTEGER NOT NULL REFERENCES repositories(id),
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, owner, name)
    ) STRICT;

    CREATE TABLE runs (
      id TEXT PRIMARY KEY NOT NULL,
      started_at TEXT NOT NULL,
      closed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      duration_ms INTEGER CHECK (duration_ms >= 0)
    ) STRICT;

    CREATE TABLE day_series (
      repository_id INTEGER NOT NULL REFERENCES repositories(id),
      metric TEXT NOT NULL,
      granularity TEXT NOT NULL CHECK (granularity IN ('day', 'week')),
      day TEXT NOT NULL,
      value INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('backfill', 'collected')),
      collected_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, metric, granularity, day)
    ) STRICT;

    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repositories(id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL CHECK (kind IN ('referrers', 'popular_paths')),
      label TEXT NOT NULL,
      title TEXT,
      count INTEGER NOT NULL,
      uniques INTEGER NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      collected_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE repository_errors (
      id INTEGER PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repositories(id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      collected_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE heartbeats (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
      started_at TEXT NOT NULL,
      closed_at TEXT,
      collected_at TEXT NOT NULL,
      completed_repositories INTEGER NOT NULL DEFAULT 0 CHECK (completed_repositories >= 0)
    ) STRICT;

    CREATE TABLE backfill_records (
      id INTEGER PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repositories(id),
      kind TEXT NOT NULL,
      window_from TEXT,
      window_to TEXT,
      truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
      collected_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX snapshots_history ON snapshots (repository_id, kind, collected_at, id);
    CREATE INDEX repository_errors_history ON repository_errors (repository_id, collected_at, id);
    CREATE INDEX backfill_records_history ON backfill_records (repository_id, kind, collected_at, id);

    CREATE TRIGGER day_series_newer_correction BEFORE UPDATE ON day_series
    WHEN NEW.repository_id IS NOT OLD.repository_id
      OR NEW.metric IS NOT OLD.metric OR NEW.granularity IS NOT OLD.granularity
      OR NEW.day IS NOT OLD.day OR NEW.collected_at <= OLD.collected_at
    BEGIN
      SELECT RAISE(ABORT, 'day_series corrections require the same key and a newer collection time');
    END;
  `);

  // These schema guards also protect evidence from accidental direct-SQL writes.
  for (const table of ['repositories', 'repository_aliases', 'runs', 'day_series',
    'snapshots', 'repository_errors', 'heartbeats', 'backfill_records']) {
    db.exec(`CREATE TRIGGER ${table}_retain BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table} evidence cannot be deleted'); END;`);
  }
  for (const table of ['repository_aliases', 'snapshots', 'repository_errors', 'backfill_records']) {
    db.exec(`CREATE TRIGGER ${table}_append_only BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table} evidence is append-only'); END;`);
  }
}
