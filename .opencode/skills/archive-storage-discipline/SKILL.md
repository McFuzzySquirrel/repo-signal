---
name: archive-storage-discipline
description: "Writing and migrating the RepoSignal SQLite archive safely: the node:sqlite connection settings, forward-only migrations recorded with content checksums, last-write-wins day-series upsert carrying source and collection timestamp, append-only snapshot captures, one transaction per repository, no code path that deletes a fact row, and calendarDays for telling a stored zero from a missing day. Use when adding or changing anything under src/db/, when a write path could delete or densify a row, or when a read could invent a day."
---

# Skill: Archive Storage Discipline

The archive is the product. `RS-TC-02`, `RS-DB-CON-01`, `RS-COL-CON-01`, `RS-BKL-CON-01` and
`RS-DU-02` all restate the same handful of rules, and four specialists write through this layer.

Load the per-table write rules in [write-shape-rules.md](./references/write-shape-rules.md) when
adding a table or column, adding a read path, or deciding what a write is allowed to change.

## Process

### Step 1: Open the database with the documented settings

Open through `node:sqlite` with foreign keys enabled, write-ahead logging on and the defensive
flag set, and assert each of those three on the opened connection in a test. The engine floor is
Node 22.13.0, the release where `node:sqlite` stopped needing an experimental flag.

### Step 2: Migrate forward only, with checksums

Discover migration modules under `src/db/migrations` in lexical order, apply the ones whose version
is absent, and record each applied version with the checksum of its source text. Re-running performs
no write. A recorded migration whose checksum no longer matches its file aborts the run and names
both values. Expose a pending-version list so a caller can report before writing.

If a schema change is needed after a migration has been applied anywhere, then add the next
migration. Editing an applied migration turns every future run into a checksum abort.

### Step 3: Write days through the upsert with provenance

A day fact is keyed by repository, metric, granularity and day. A second write of the same key
replaces the value, carries the later collection timestamp, and leaves exactly one row. The `source`
column is restricted to `backfill` or `collected` by a check constraint, and the collection
timestamp is not nullable, so a row cannot claim to have been observed at no time.

### Step 4: Append snapshots, never merge them

Referrer and popular-path captures are append-only rows carrying the run identifier, the capture
time and the position in the returned list. Two captures of the same label on the same day are two
rows. A response with three entries writes three rows and is never padded to ten.

### Step 5: Commit per repository

Every write for one repository is one transaction, so a kill between repositories loses that
repository's work and nothing else. A per-repository failure never aborts the rest of the run, and a
partial run never leaves a half-written fact.

### Step 6: Never delete a fact row

No product code path deletes or rewrites a stored observation to make a chart look continuous. A
superseded value is replaced only by a newer write of the same key, with its collection timestamp
updated. A repository that disappears is marked unavailable with a reason, keeps its history, and is
excluded from later runs; a rename or transfer keeps the identity, records an alias, and updates the
canonical name.

### Step 7: Enumerate calendar days separately from stored rows

`calendarDays(from, to)` returns every day the range covers, and the range read returns stored rows
only. Callers compare the two to distinguish a stored zero from a day nobody measured. This
separation is the last structural defence against a densified series. If a caller genuinely needs a
dense array, then it must carry both values and render the difference as gaps; by default it does
not get one.

## Gotchas

- **A densifying range read is the central lie.** Filling missing days inside the read turns every
  hole into a zero and the chart renders a quiet fortnight. The read returns rows; the calendar comes
  from a separate call; the caller subtracts.
- **Editing an applied migration poisons every later run.** The checksum guard treats a changed file
  as tampering and aborts, which is the intended behaviour but reads as a mysterious startup
  failure. Add `002-...`; never edit `001-...`.
- **A uniqueness constraint on snapshots silently merges captures.** A unique key over
  repository, kind and label turns two runs on one day into one row and destroys the observation
  that these lists were captured twice. Only the day key may be unique.
- **Without `granularity` in the key, a week collides with a day.** Weekly development rows and daily
  traffic rows live in the same table; the granularity column in the primary key is what keeps a
  week-start day from overwriting a daily observation.
- **An upsert that does not touch the collection timestamp makes provenance wrong.** The row then
  reads as older than it is, and the backfilled-versus-collected boundary is drawn at the wrong
  place.
- **Deleting and reinserting a run row hides an abandoned run.** The run row is inserted at start and
  updated at completion so a run that never closed is detectable from the journal alone.
- **A snapshot must not be given a day.** These lists have no day dimension to correct, and stamping
  one invites a later fix that overwrites history.
- **A repository row is never deleted, only marked.** Removing it takes years of history with it,
  which is exactly the evidence the product exists to keep.
- **The layer is isolated for a reason.** `node:sqlite` is a release candidate, so a Node major
  upgrade is checked here first; the repository interface is the only surface the rest of the
  product is allowed to import.

## Validation

Self-check with a temporary migrated database; the constraint assertions run as direct SQL, because
an application-level check can be bypassed by a later edit:

- [ ] A test asserts `foreign_keys`, `journal_mode` and the defensive setting on the opened
      connection.
- [ ] A fresh temporary database migrates, reports no pending version afterwards, and a re-apply
      performs no write and keeps the recorded checksum.
- [ ] Changing a migration file after it was recorded aborts with both the expected and the actual
      checksum named.
- [ ] Writing the same repository, metric, granularity and day twice leaves one row carrying the
      later value and the later collection time.
- [ ] A `source` outside `backfill` and `collected`, and a write without a collection timestamp, are
      both rejected by the database itself.
- [ ] Two snapshot captures of the same referrer with different capture times both survive and the
      history read returns both.
- [ ] A range read over a window with a deliberate hole returns stored rows only, while
      `calendarDays` over the same window returns every day including the hole.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default a constraint asserted only in application code counts as
      unproven.
