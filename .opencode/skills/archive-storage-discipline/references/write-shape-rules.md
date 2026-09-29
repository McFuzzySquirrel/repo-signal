# Write shape rules per table

| Table | Key | Granularity | Conflict rule | Timestamp | Never |
|-------|-----|-------------|---------------|-----------|-------|
| repositories | stable identity | n/a | Lifecycle and enrolment columns are updated in place | last seen | Deleting the row; a vanished repository is marked unavailable with a reason |
| repository aliases | repository plus alias | n/a | Appended once per rename or transfer | recorded at | Being rewritten by a later rename |
| day series | repository, metric, granularity, day | `day` or `week` | Last write wins through the upsert, one row per key | non-null collection timestamp, updated by every write | A `DELETE`; a densified read; a day column outside the calendar |
| snapshots | run identifier, capture time, kind, position | none | Append only; two captures of one label are two rows | capture time | A uniqueness constraint on the label; being assigned a day |
| runs | run identifier | n/a | Inserted at start, updated at close, never deleted | started and closed | Delete-and-reinsert, which loses the start time |
| per-repository errors | repository plus run | n/a | Appended per failure; the latest is the current state | failure time | Being derived from an absence of data |
| heartbeats | run identifier | n/a | Written at start and close | both | Being inferred rather than recorded |
| backfill records | repository plus kind | n/a | One record per completed backfill, with the window actually available | completion time | Padding a short window to a full year |

## Provenance columns

- `source` is restricted to `backfill` or `collected` by a check constraint, not by application
  code, so an unexpected value is rejected by the database.
- `granularity` is part of the primary key so a week-start day cannot overwrite a daily observation.
- Every fact table has a non-null collection timestamp, and a write updates it.
- The provenance read states when backfill completed, which backfills ran, the first day for which
  collected data exists, and whether that first day is today. A repository with no collected day has
  no boundary, which is the first-connect state, not a zero-length history.

## Read-path rules

1. A range read returns stored rows only, ordered by day.
2. The covered days come from a separate `calendarDays` call.
3. A caller that needs a dense series must carry both values and render the difference as gaps.
4. An unknown repository is reported as unknown, not as an empty one.
5. A snapshot history read returns every capture with its own capture time, newest last or newest
   first as the caller states, never the latest one only.
6. The health read is a pure query over recorded state, with no network access, and returns the same
   shape for a home with no data.

## Constraint tests to keep

Assert each of these with direct SQL, because an application-level check can be bypassed by a
future edit:

- duplicate day key overwrites rather than appending;
- unknown `source` is rejected;
- missing collection timestamp is rejected;
- two captures of one label coexist;
- a foreign key to an unknown repository is rejected.

## Node major upgrade

`node:sqlite` is a release candidate and the engine range is pinned to one LTS line. When a major
upgrade is planned, re-check in this order: the connection settings, the migration runner's
checksum behaviour, the constraint enforcement relied on by the tests, then the backup and restore
path. The repository interface is the boundary that keeps this check to one layer.
