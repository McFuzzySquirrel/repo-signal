# Feature: Archive Storage

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C08 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C10 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C14 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-NF-08 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-STO-ST-01 | This feature | owns |
| RS-STO-C01 | This feature | owns |
| RS-STO-C02 | This feature | owns |
| RS-STO-C03 | This feature | owns |
| RS-STO-C04 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Archive Storage
**ID Prefix:** RS-STO
**Summary:** The archive itself: a guarded `node:sqlite` connection that verifies its own pragmas, a
checksummed forward-only migration runner, `STRICT` tables protected by triggers that refuse
deletion and restrict corrections, day-series, snapshot and run-journal repositories, and a backup
and restore pair that integrity-checks the source before it replaces anything.
**Dependencies:** Foundation and Runtime
**Priority:** Must
**As-built status:** Built, covered by `tests/initial-schema.test.js`, `tests/migrate.test.js`,
`tests/ops-repo.test.js`, `tests/day-series-repo.test.js`, `tests/snapshot-repo.test.js`,
`tests/backup-drill.test.js` and `tests/db-command.test.js`. One documentary gap remains, recorded in
section 8.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-STO-ST-01 | Maintainer | every stored day to be append-only and correctable only by a later collection of the same key, so that the archive can be trusted as evidence rather than as a mutable cache | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-STO-C01","kind":"constraint","text":"Opening the archive fails closed when node:sqlite defensive mode is unavailable, naming the running Node version, and otherwise opens with foreign keys on, extensions off and defensive mode enabled, then reads both pragmas back and refuses to continue unless foreign_keys is 1 and journal_mode is wal."}
```

```forge-requirement
{"id":"RS-STO-C02","kind":"constraint","text":"Migrations are numbered three-digit files discovered by pattern, are applied inside an immediate transaction after re-inspecting under the writer lock, record a SHA-256 of their own source, and refuse an async up function, a thenable result, a duplicate version, a checksum mismatch, an applied migration missing from code, or a pending migration behind the on-disk version."}
```

```forge-requirement
{"id":"RS-STO-C03","kind":"constraint","text":"Evidence tables are STRICT and protected: every DELETE raises, history tables reject UPDATE outright, and a day-series correction must keep the repository, metric, granularity and day identical while carrying a strictly newer collection time."}
```

```forge-requirement
{"id":"RS-STO-C04","kind":"constraint","text":"A backup is produced through the driver's own backup so write-ahead side files are folded into one self-contained archive, and a restore integrity-checks the source before replacing anything, then re-verifies the restored file and reports per-table row counts."}
```

---

## 4. Schema

| Table | Purpose | Notable rules |
|-------|---------|---------------|
| `schema_migrations` | Applied versions with checksums | `CHECK (length(checksum) = 64)`; read-only status |
| `repositories` | Stable identity per enrolled repository | Lifecycle `active`/`unavailable`, enrollment flag, last seen, last success, consecutive failures, backfill refusal columns |
| `repository_aliases` | Renames and transfers | Append-only; the recorded time is never rewritten |
| `runs` | One collection run | Guarded close: a second close changes no row |
| `day_series` | Every metric, granularity, day, value and source | `source` is `backfill` or `collected`; correction only with a newer collection time |
| `snapshots` | Referrer and popular-path captures | Append-only, surrogate key, position preserved, no upsert by label |
| `repository_errors` | Per-repository failure evidence | Append-only |
| `heartbeats` | Liveness ticks per run | Primary key is the run id; a tick must be strictly newer and still open |
| `backfill_records` | One row per completed backfill kind | Append-only, nullable window, truncation flag |

Migration `001` creates the core schema, its indexes and every retention trigger. Migration `002` adds
the backfill-refusal columns to `repositories` rather than to `backfill_records`, because the
provenance read counts every row there as a completed backfill; recording a refusal as a completed
backfill would have been a lie in the one table that reports completions.

Day enumeration comes from the calendar alone, so a window is fully determined before any query runs.
Snapshots are read newest-first by run and collection time with ties broken by position, and a label
that repeats across collections is stored again rather than merged.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Schema shape, triggers, STRICT enforcement | Existing `tests/initial-schema.test.js` |
| Unit | Migration discovery, checksums, refusal cases, transactions | Existing `tests/migrate.test.js` |
| Unit | Run journal, heartbeats, errors, backfill records | Existing `tests/ops-repo.test.js` |
| Unit | Day facts, calendar enumeration, latest capture | Existing `tests/day-series-repo.test.js`, `tests/snapshot-repo.test.js` |
| Integration | Backup, restore, verify, row counts | Existing `tests/backup-drill.test.js`, plus the drill itself in CI |
| Contract | Documented home inventory against the schema | Created by task RS-STO-CONTRACT-01 |

Key scenarios: a delete on any evidence table raises; a correction with an older collection time
applies nothing; a migration whose source changed is refused by naming both checksums; a restore from
a corrupt copy is refused before the live archive is touched; a mistyped restore path leaves an empty
archive and is reported by its row counts rather than by success.

---

## 6. Implementation Tasks

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-STO-CONTRACT-01",
  "title": "Document the write-ahead side files and assert the home inventory against the schema",
  "description": "The connection sets journal_mode to wal, so `archive.sqlite3-wal` and `archive.sqlite3-shm` exist beside the archive, but the README's home inventory and the backup runbook both list only three files, and the restore path explicitly deletes the side files. Update the home inventory in `README.md` and in `docs/operations/backup-and-migrate.md` to name the two side files, state that they belong to the open archive rather than to a separate copy, and state that a restore removes them. Create `tests/contract-storage.test.js` asserting that the connection really does set WAL and foreign keys, that every table the schema creates is named in the backup drill's known row counts, and that both documents name the side files. Do not change the schema, the pragmas or the restore implementation, and do not add a prune or vacuum command.",
  "ownerAgent": "documentation-engineer",
  "dependencies": ["RS-FND-CONTRACT-02"],
  "expectedOutputs": ["README.md", "docs/operations/backup-and-migrate.md", "tests/contract-storage.test.js"],
  "validationCommands": ["npm test -- tests/contract-storage.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert the documented home inventory names the write-ahead side files the connection creates, and that the documented table list matches the schema"],
    "requirementRefs": [],
    "acceptanceCriteria": ["README.md and the backup runbook both name archive.sqlite3-wal and archive.sqlite3-shm and explain that a restore removes them", "A test asserts the connection verifies foreign_keys=1 and journal_mode=wal on open", "A test asserts every table in the schema appears in the backup drill's expected row counts", "tests/contract-storage.test.js reports more than zero executed tests"],
    "constraints": ["Do not modify src/db/connection.js or any migration", "Do not introduce a command that deletes or compacts evidence"],
    "constraintRefs": ["docs/features/archive-storage.md#RS-STO-C01", "docs/features/archive-storage.md#RS-STO-C04", "docs/PRD.md#RS-C10", "docs/PRD.md#RS-C12"],
    "references": ["docs/features/archive-storage.md#4. Schema", "docs/features/archive-storage.md#3. Functional Constraints"]
  }
}
```

---

## 7. Acceptance Criteria

1. The archive refuses to open rather than running without defensive mode, foreign keys or WAL.
2. Every stored day is correctable only by a newer collection of the identical key, and no evidence
   row can be deleted.
3. A migration that changed on disk, went missing from code or sits behind the on-disk version is
   refused before any write.
4. A backup is one self-contained file, and a restore refuses a corrupt source before touching the
   live archive.
5. Row counts are reported after a backup and a restore so a copy can be compared by content.
6. The home inventory in both documents matches what the connection actually creates.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | The archive has no pruning command, so years of daily rows accumulate | Keep it: pruning would delete evidence, and the backup runbook is where growth is discussed |
| 2 | Should `db backup` refuse a destination inside the home directory? | Not yet; the runbook states where copies belong and the drill proves the round trip |
| 3 | WAL side files mean a copy taken by file copy alone can be incomplete | Keep using the driver's backup, and keep the drill as the proof |