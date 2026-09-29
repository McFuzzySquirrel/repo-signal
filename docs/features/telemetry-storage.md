# Feature: Telemetry Storage and Migrations

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-VR-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-VR-03 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DB-FR-01 | This feature | owns |
| RS-DB-FR-02 | This feature | owns |
| RS-DB-FR-03 | This feature | owns |
| RS-DB-FR-04 | This feature | owns |
| RS-DB-CON-01 | This feature | owns |
| RS-DB-ST-01 | This feature | owns |
| RS-DB-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Telemetry Storage and Migrations
**ID Prefix:** RS-DB
**Summary:** The archive itself: one SQLite file, a forward-only migration runner, a schema that
distinguishes day facts from undated snapshots, and the query surface the dashboard reads.
**Dependencies:** Foundation and Runtime
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-DB-ST-01","kind":"story","text":"As a solo maintainer I want observations stored once and never rewritten by a repair routine, so that a correction from GitHub is visible as a later write rather than as a silent change."}
```

```forge-requirement
{"id":"RS-DB-ST-02","kind":"story","text":"As a solo maintainer I want to know which days simply were not measured, so that a hole in the archive is never read as a quiet week."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-DB-FR-01","kind":"requirement","text":"Open one SQLite database through `node:sqlite` with foreign keys enabled, write-ahead logging and the defensive flag on, and apply forward-only migrations recorded with their version and content checksum so an already-applied migration is never silently reapplied or skipped."}
```

```forge-requirement
{"id":"RS-DB-FR-02","kind":"requirement","text":"Create the initial schema with these tables: repositories with lifecycle and enrolment columns, repository aliases for renames and transfers, day series keyed by repository, metric, granularity and day with last-write-wins upsert and a `source` restricted to backfill or collected, append-only snapshots for referrers and popular paths carrying a run identifier, runs, per-repository errors, heartbeats, and backfill records. Every fact table requires a non-null collection timestamp, and no product code path deletes a fact row."}
```

```forge-requirement
{"id":"RS-DB-FR-03","kind":"requirement","text":"Expose a repository layer that writes day series through the upsert, appends snapshots without merging them, appends runs, errors, heartbeats and backfill records, lists enrolled repositories, reads a metric over an inclusive day range, and returns the list of calendar days a range covers so a caller can tell a stored zero from a missing day."}
```

```forge-requirement
{"id":"RS-DB-FR-04","kind":"requirement","text":"Provide a `db` command group reachable from the process entry point with `migrate`, `status`, `verify`, `backup` and `restore`, where status reports the on-disk schema version beside the code's version, verify runs SQLite's integrity check, and backup produces a restorable copy that restore can load and re-verify."}
```

```forge-requirement
{"id":"RS-DB-CON-01","kind":"constraint","text":"No product code path deletes or rewrites a stored observation to make a chart look continuous; a superseded value is replaced only by a newer write of the same key, and the write's collection time is updated with it."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-DB-ST-01 | story | Must |
| RS-DB-ST-02 | story | Must |
| RS-DB-FR-01 | requirement | Must |
| RS-DB-FR-02 | requirement | Must |
| RS-DB-FR-03 | requirement | Must |
| RS-DB-FR-04 | requirement | Must |
| RS-DB-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

`db status` prints the database path, the code's schema version, the on-disk version, and
whether a migration is pending, one fact per line. `db verify` prints the integrity-check result
and exits non-zero on failure. Neither command prints row contents, so a backup can be taken
without leaking a repository name into a terminal history.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|----------|-------|------------------------|-------------------|---------|------------|
| RS-DB-01 | A database opens, migrates forward once, and refuses a tampered migration | data-engineer | Node 22.13 with node:sqlite | src/db/connection.js, src/db/migrate.js, tests/migrate.test.js | apply, no-op re-apply, pending detection, checksum mismatch | The schema itself, any query |
| RS-DB-02 | The archive schema exists with enforced keys, provenance and append-only snapshots | data-engineer | RS-DB-01 | src/db/migrations/001-core-schema.js, tests/initial-schema.test.js | key and check constraints asserted through direct SQL | Repository functions, CLI |
| RS-DB-03 | Writes and range reads work and expose calendar days without inventing values | data-engineer | RS-DB-02 | src/db/day-series-repo.js, src/db/snapshot-repo.js, src/db/ops-repo.js, tests/day-series-repo.test.js, tests/snapshot-repo.test.js, tests/ops-repo.test.js | upsert overwrite, append accumulation, gap distinction | Rendering, collection |
| RS-DB-04 | `db` commands including backup and restore work through the entry point | data-engineer | RS-DB-03, RS-FND-03 | src/db/backup.js, src/commands/db.js, src/commands/index.js, tests/db-command.test.js | migrate, status, verify, backup, restore each exit 0 on a temporary home | Documentation, scheduling |

---

## 6. Implementation Tasks

### Phase 1: Connection and migration runner

```forge-task
{
  "id": "RS-DB-01",
  "title": "Open the database and apply migrations forward only",
  "description": "Implement src/db/connection.js to open the archive with node:sqlite using foreign keys, write-ahead logging and the defensive flag, and implement src/db/migrate.js to discover migration modules under src/db/migrations in lexical order, apply the ones whose version is absent, and record each applied version with the checksum of its source text. Re-running must be a no-op, a migration whose recorded checksum no longer matches its file must abort with both values named, and the runner must expose a pending-version list so a caller can report before writing. The unit test drives a temporary database through apply, re-apply and checksum-mismatch cases and asserts the recorded migration rows.",
  "ownerAgent": "data-engineer",
  "dependencies": ["RS-FND-01"],
  "expectedOutputs": ["src/db/connection.js", "src/db/migrate.js", "tests/migrate.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/migrate.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/telemetry-storage.md#RS-DB-FR-01"],
    "acceptanceCriteria": ["A temporary database migrates from empty to the current version and reports no pending migration afterwards", "Applying a recorded migration again performs no write and keeps its recorded checksum", "Changing a migration file after it was recorded aborts with a message naming the expected and the actual checksum", "A test asserts foreign_keys, journal_mode and the defensive setting on the opened connection"],
    "constraints": ["Do not create the core tables in this task; the migration framework and its bookkeeping only", "No third-party SQLite binding may be introduced"],
    "constraintRefs": ["docs/PRD.md#RS-TC-01", "docs/PRD.md#RS-TC-02", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#6.2 Project Structure", "docs/PRD.md#6.3 Key APIs / Interfaces"]
  }
}
```

```forge-task
{
  "id": "RS-DB-02",
  "title": "Create the core archive schema",
  "description": "Add src/db/migrations/001-core-schema.js creating the archive tables: repositories with lifecycle and enrolment columns, repository aliases for renames and transfers, day_series keyed by repository, metric, granularity and day with a last-write-wins upsert, a source restricted to backfill or collected, and a non-null collection timestamp; append-only snapshots for referrers and popular paths carrying the run identifier; runs; per-repository errors; heartbeats; and backfill records. Snapshots must have no uniqueness constraint that would merge two captures of the same label, because they are append-only. The test asserts each key and check constraint by direct SQL: a duplicate day key overwrites, an unknown source is rejected, a missing collection timestamp is rejected, and two captures of the same referrer coexist with distinct collection times.",
  "ownerAgent": "data-engineer",
  "dependencies": ["RS-DB-01"],
  "expectedOutputs": ["src/db/migrations/001-core-schema.js", "tests/initial-schema.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/initial-schema.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/telemetry-storage.md#RS-DB-FR-02", "docs/PRD.md#RS-VR-01"],
    "acceptanceCriteria": ["A test inserts the same repository, metric, granularity and day twice and observes one row carrying the later value and the later collection time", "An insert with a source outside backfill and collected is rejected by the database", "An insert without a collection timestamp is rejected by the database", "Two snapshot captures of the same referrer label with different collection times both survive and the query returns two rows"],
    "constraints": ["No repository or query function is written in this task", "No code path may delete a fact row"],
    "constraintRefs": ["docs/features/telemetry-storage.md#RS-DB-CON-01", "docs/PRD.md#RS-TC-02", "docs/PRD.md#RS-DU-02"],
    "references": ["docs/PRD.md#6.2 Project Structure"]
  }
}
```

### Phase 2: Repository layer and the database command group

```forge-task
{
  "id": "RS-DB-03",
  "title": "Implement the archive repository and gap-preserving range reads",
  "description": "Implement the read and write surface over the schema, opening the database through src/db/connection.js: src/db/day-series-repo.js writes a day fact through the upsert and reads a metric over an inclusive day range; src/db/snapshot-repo.js appends a capture and reads the latest capture and the capture history for a kind; src/db/ops-repo.js upserts repositories and aliases, appends runs, errors, heartbeats and backfill records, and lists enrolled repositories. Expose calendarDays(from, to) so a caller can distinguish a stored zero from a day that was never measured; the range read itself must return only stored rows. The tests cover an overwrite inside a re-collected window, snapshot accumulation across runs, a range containing a deliberate hole, and a run appended then updated at completion.",
  "ownerAgent": "data-engineer",
  "dependencies": ["RS-DB-02"],
  "expectedOutputs": ["src/db/day-series-repo.js", "src/db/snapshot-repo.js", "src/db/ops-repo.js", "tests/day-series-repo.test.js", "tests/snapshot-repo.test.js", "tests/ops-repo.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/day-series-repo.test.js tests/snapshot-repo.test.js tests/ops-repo.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/telemetry-storage.md#RS-DB-FR-03", "docs/PRD.md#RS-VR-02", "docs/PRD.md#RS-VR-03"],
    "acceptanceCriteria": ["Writing a day fact twice for the same key leaves one row with the second value and the second collection time", "A range read over a window containing a deliberate hole returns only the stored rows, and calendarDays over the same window returns every day including the hole", "Two collection runs append two snapshots for the same referrer label and the history read returns both capture times", "A run row is inserted at start and updated at completion without deleting its start time"],
    "constraints": ["Do not invent, interpolate or default a missing day in any read path", "Do not add rendering or network behaviour in this task"],
    "constraintRefs": ["docs/features/telemetry-storage.md#RS-DB-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-TC-02"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces"]
  }
}
```

```forge-task
{
  "id": "RS-DB-04",
  "title": "Expose the db command group with backup, restore and verification",
  "description": "Add src/db/backup.js and src/commands/db.js and register the group in src/commands/index.js so `db migrate`, `db status`, `db verify`, `db backup` and `db restore` are reachable from the process entry point. status prints the database path, the code's schema version, the on-disk version and whether a migration is pending, and never prints row contents. verify runs the SQLite integrity check and exits non-zero on failure. backup uses the node:sqlite backup facility to write a consistent copy to a chosen path; restore loads such a copy, re-runs the integrity check and reports the row counts per table so an operator can compare them. The tests spawn `node src/cli.js` against a temporary home.",
  "ownerAgent": "data-engineer",
  "dependencies": ["RS-DB-03", "RS-FND-03"],
  "expectedOutputs": ["src/db/backup.js", "src/commands/db.js", "src/commands/index.js", "tests/db-command.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/db-command.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/telemetry-storage.md#RS-DB-FR-04"],
    "acceptanceCriteria": ["tests/db-command.test.js runs `node src/cli.js db migrate`, `db status`, `db verify`, `db backup` and `db restore` against a temporary home and asserts exit code 0 for each", "A backup taken after inserting known rows restores into a fresh home and the restored table counts match the original", "Restoring a truncated file is detected and exits non-zero with the integrity-check message", "db status reports a pending migration when the on-disk version is behind the code's version"],
    "constraints": ["Do not document the runbook in this task; the operations feature owns documentation", "backup and restore must not print observation values or repository names"],
    "constraintRefs": ["docs/PRD.md#RS-TC-02", "docs/PRD.md#RS-TC-04", "docs/PRD.md#RS-SC-02"],
    "references": ["docs/PRD.md#7.4 Shared Definition Index"]
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Migration application, checksum detection, constraint enforcement | Direct SQL against a temporary database through the Node test runner |
| Unit | Repository reads and writes, calendar day enumeration | In-process calls against a migrated temporary database |
| Entry point | The `db` command group including backup and restore | Spawn `node src/cli.js db ...` in a temporary home |
| Human | Backup and migration procedure | Exercised in the operations runbook drill |

Key test scenarios:

1. Fresh database migrates; re-running changes nothing; a tampered migration file aborts.
2. A day fact written twice yields one row with the newer value and newer collection time.
3. An unknown `source` value and a missing collection timestamp are both rejected by the database itself.
4. Two captures of the same referrer label survive as two snapshot rows.
5. A range read over a deliberate hole returns stored rows only, while `calendarDays` returns the hole.
6. Backup, then restore into a fresh home, then compare table counts.

---

## 8. Acceptance Criteria

1. A brand-new home directory becomes a migrated, writable archive with one command and no manual SQL.
2. Re-collected days correct themselves in place and keep the newer collection time.
3. Referrers and popular paths accumulate as timestamped snapshots rather than being overwritten.
4. A missing day is enumerable as a day the range covers but has no row for.
5. A backup taken by the tool restores into a clean home with identical table counts and a passing integrity check.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should weekly statistics share the day-series table or get their own? | Share it, with an explicit `granularity` column in the primary key, so a weekly bucket can never collide with a daily one |
| 2 | Should a repository row be deleted when a repository disappears? | No. It is marked unavailable with a lifecycle value, because a deleted repository's history is still evidence |
| 3 | How large can the archive grow? | Six repositories at one row per metric per day is roughly 4,400 rows a year; no partitioning or retention policy is needed, and none is built |
