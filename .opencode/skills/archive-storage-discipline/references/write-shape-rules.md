# Write shape rules per table

## Connection settings

| Setting | Set with | Proven by | Never |
|---------|----------|-----------|-------|
| `foreign_keys` | the `enableForeignKeyConstraints` driver option, or a `PRAGMA` | reading `PRAGMA foreign_keys` back from the opened connection | asserting only the options object that was passed in |
| `journal_mode` | the driver's journal-mode option | reading `PRAGMA journal_mode` back and asserting it is `wal` | assuming the default is write-ahead logging |
| defensive mode | the driver's defensive option, then set again on the opened handle | reading the connection's defensive state back after opening | a `PRAGMA`, an `exec()` call, or a comment; these leave the defensive configuration unset |
| extension loading | `allowExtension: false` | the open options | loading an extension from the archive's directory |

The engine floor is Node 24.12.0, the release that exposes the defensive option. The release that
dropped the `node:sqlite` experimental flag is older, so there the module imports, the option does not
exist, and the archive cannot be opened defensively. When the option is missing, opening raises a named
error carrying the running version and the floor, and opens no connection.

## Per-table rules

| Table | Key | Granularity | Conflict rule | Timestamp | Never |
|-------|-----|-------------|---------------|-----------|-------|
| repositories | stable identity | n/a | lifecycle and enrolment columns updated in place | last seen | Deleting the row; a vanished repository is marked unavailable with its first reason |
| repository aliases | repository plus alias | n/a | appended once per rename or transfer | recorded at | Being rewritten by a later rename; a mere respelling records no alias |
| day series | repository, metric, granularity, day | `day` or `week` | last write wins through the upsert, one row per key, stale writes apply nothing | non-null collection timestamp moved by every accepted write | A `DELETE`; a densified read; a day column outside the calendar |
| snapshots | run identifier, capture time, kind, position | none | append only; two captures of one label are two rows | capture time | A uniqueness constraint on the label; being assigned a day |
| runs | run identifier | n/a | inserted at start, updated at close, never deleted | started and closed | Delete-and-reinsert, which loses the start time |
| per-repository errors | repository plus run | n/a | appended per failure; the latest is the current state | failure time | Being derived from an absence of data |
| heartbeats | run identifier | n/a | written at start and close | both | Being inferred rather than recorded |
| backfill records | repository plus kind | n/a | one record per completed backfill, with the window actually available | completion time | Padding a short window to a full year; counting the boundary stamp as a backfill |
| schema migrations | version | n/a | applied once, checksum recorded | applied at | Reapplying a version; editing an applied file |

## Provenance columns

- `source` is restricted to `backfill` or `collected` by a check constraint rather than by application
  code, so an unexpected value is rejected by the database.
- `granularity` is part of the primary key, so a week-start day cannot overwrite a daily observation.
- Every fact table has a non-null collection timestamp, and an accepted write updates it.
- Evidence tables are `STRICT` and protected: every `DELETE` raises, and history tables reject `UPDATE`
  outright, so a correction must go through the day-series key with a strictly newer collection time.
- The provenance read states when backfill completed, which backfills ran, the first day for which
  collected data exists, and whether that first day is today. A repository with no collected day has no
  boundary, which is the first-connect state rather than a zero-length history.

## Read-path rules

1. A range read returns stored rows only, ordered by day.
2. The covered days come from a separate `calendarDays` call.
3. A caller that needs a dense series must carry both values and render the difference as gaps.
4. An unknown repository is reported as unknown, not as an empty one.
5. A snapshot history read returns every capture with its own capture time, never the latest one only.
6. The health read is a pure query over recorded state, with no network access, and returns the same
   shape for a home with no data.

## Constraint tests to keep

Assert each of these with direct SQL, because an application-level check can be bypassed by a future
edit:

- a duplicate day key overwrites rather than appending, and a stale write applies nothing;
- an unknown `source` is rejected;
- a missing collection timestamp is rejected;
- two captures of one label coexist;
- a foreign key to an unknown repository is rejected;
- a `DELETE` on an evidence table raises;
- an `UPDATE` on a history table raises.

## Migration runner refusals

The runner refuses, by name: a filename that is not `NNN-description.js` with a positive version, an
async `up` function, a thenable result, a duplicate version, a checksum mismatch, an applied migration
missing from code, and a pending migration behind the on-disk version. All of them are checked before any
write, so a refused run leaves the archive exactly as it was.

## Backup and restore

- Write-ahead logging adds two side files beside the archive file, so a file copy is not a backup.
- A backup goes through the driver's own backup so the side files are folded into one self-contained
  archive.
- A restore integrity-checks the source before it replaces anything, re-verifies the restored file and
  reports per-table row counts.
- `node scripts/backup-drill.mjs` performs the whole round trip against scratch homes and exits non-zero
  on any difference, and the pipeline runs it after the suite.

## Runtime re-check order

When a Node major upgrade is planned, re-check in this order: the connection settings, the migration
runner's checksum behaviour, the constraint enforcement the tests rely on, then the backup and restore
path. The repository interface is the boundary that keeps this check to one layer.