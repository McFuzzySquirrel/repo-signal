---
name: archive-storage-discipline
description: "Writing and migrating the RepoSignal SQLite archive safely: the node:sqlite connection settings including the enableDefensive guard that sets the RS-C14 runtime floor, three-digit forward-only migrations recorded with a SHA-256 of their own source, last-write-wins day-series upsert carrying source and collection timestamp, append-only evidence tables whose triggers refuse every delete, one transaction per repository, the driver's own backup for a self-contained copy, and calendarDays for telling a stored zero from a missing day. Use when adding or changing anything under src/db/, when a write path could delete or densify a row, or when a read could invent a day."
---

# Skill: Archive Storage Discipline

The archive is the product: it is the only place a day beyond GitHub's rolling window can exist.
`RS-C10` makes its evidence append-only, so the write shapes here are the highest-consequence decisions
in the codebase, and a densifying upsert silently invents the days the product exists to preserve.

Load [write-shape-rules.md](./references/write-shape-rules.md) when adding a table or a column, adding
a read path, deciding what a write is allowed to change, or opening or changing the connection
settings.

## Process

### Step 1: Open with the documented settings and fail closed

`src/db/connection.js` is the only place a connection is opened. It checks that
`DatabaseSync.prototype.enableDefensive` exists before it does anything else, and when it does not, it
raises an error naming the running Node version and the 24.12.0 floor and opens no connection at all.
That is the fail-closed behaviour `RS-C14` asks for: a host below the floor is reported with its
running version rather than failing somewhere inside the archive.

The floor is Node 24.12.0, the release that exposes `enableDefensive`. A host that can merely import
`node:sqlite` is therefore not proof that it can open the archive, because the release that dropped the
experimental flag is older than the release that exposes the defensive option.

When the option exists, the connection is opened with foreign key constraints on, defensive mode on and
extension loading off, the defensive mode is set again on the opened handle, and both pragmas are read
back. If `foreign_keys` is not 1 or `journal_mode` is not `wal`, then the archive refuses to continue
and the handle is closed rather than left open on a failure path, which is what `RS-NF-08` requires.

Two rules follow from the floor, and both are load-bearing rather than stylistic:

- **A `PRAGMA` is not a substitute.** Running a defensive-looking `PRAGMA` through `exec()` does not set
  the driver's defensive configuration; only the driver's own option does. A test proves the setting by
  reading it back from the opened connection, not by reading back the options object that was passed in.
- **A runtime without the API does not degrade.** Falling back to an undefended connection would leave
  every other rule in this package assuming a guarantee that is not on.

### Step 2: Migrate forward only, with checksums

Discover migration modules under `src/db/migrations` by their three-digit numbering in lexical order,
validate every recorded checksum before any write, and apply the pending versions inside an immediate
transaction after re-inspecting under the writer lock. Each applied version records the SHA-256 of its
own complete source text, so re-running performs no write.

The runner refuses seven things by name: a migration filename that is not `NNN-description.js` with a
positive version, an async `up` function, a thenable result, a duplicate version, a checksum mismatch,
an applied migration that has gone missing from code, and a pending migration behind the on-disk version.
If a schema change is needed after a migration has been applied anywhere, then add the next migration.
Editing an applied migration turns every later run into a checksum abort.

### Step 3: Write days through the upsert with provenance

A day fact is keyed by repository, metric, granularity and day. A second write of the same key
replaces the value, source and collection timestamp together, and leaves exactly one row. The `source`
column is restricted to `backfill` or `collected`, the granularity is part of the key, and the
collection timestamp is not nullable, so a row cannot claim to have been observed at no time.

A stale or equal write is a read-only no-op, because a correction requires a strictly newer collection
time. That is what makes a replayed run safe: it applies nothing rather than overwriting a newer day.

### Step 4: Append evidence, never merge or rewrite it

Referrer and popular-path captures are append-only rows carrying the run identifier, the capture time
and the position in the returned list. Two captures of the same label on the same day are two rows, and
a response with three entries writes three rows rather than being padded to ten. Every `DELETE` on an
evidence table raises, and history tables reject `UPDATE` outright, so the constraint is the database's
and not the application's.

### Step 5: Commit per repository

Every write for one repository is one transaction, so a kill between repositories loses that
repository's work and nothing else. A per-repository failure is recorded as evidence and never throws
out of the run, so a partial run never leaves a half-written fact and never becomes a collection crash.

### Step 6: Never delete a fact row

No product code path deletes a stored observation to make a chart look continuous. A repository that
disappears is marked unavailable with a reason, keeps its history and is excluded from later runs; a
rename or transfer keeps the identity, records an alias and updates the canonical name. The first
collected day is stamped exactly once by a conditional insert, so a later run cannot move the
provenance boundary.

### Step 7: Enumerate calendar days separately from stored rows

`calendarDays(from, to)` returns every day the range covers, and the range read returns stored rows only.
Callers compare the two to distinguish a stored zero from a day nobody measured, and the page data layer
carries both as two separate lists. This separation is the last structural defence against a densified
series. If a caller genuinely needs a dense array, then it must carry both values and render the
difference as gaps; by default it does not get one.

### Step 8: Back up through the driver, not by copying the file

Write-ahead logging adds two side files beside the archive, so copying the archive file alone captures
an incomplete database. A backup goes through the driver's own backup so the side files are folded into
one self-contained file, and a restore integrity-checks the source before it replaces anything, then
re-verifies the restored file and reports per-table row counts. `RS-PRIV-02` still applies: a backup is
a copy, never a publication.

## Gotchas

- **`node:sqlite` imports on the wrong line and only fails when the connection opens.** A host above the
  release that dropped the experimental flag but below the release exposing `enableDefensive` loads the
  module without complaint, so the error appears at the constructor as an unknown option. It reads as a
  product defect and it is not one; check `node -v` against the 24.12.0 floor first.
- **A defensively-looking `PRAGMA` is not the defensive flag.** It leaves the defensive configuration
  unset, a test that asserts the requested options rather than the connection's state still passes, and
  the archive then runs undefended while looking protected.
- **A densifying range read is the central lie.** Filling missing days inside the read turns every hole
  into a zero and the chart renders a quiet fortnight. The read returns rows, the calendar comes from a
  separate call, and the caller subtracts.
- **Editing an applied migration poisons every later run.** The checksum guard treats a changed file as
  tampering and aborts, which is the intended behaviour but reads as a mysterious startup failure. Add
  the next numbered migration; never edit an applied one.
- **A uniqueness constraint on snapshots silently merges captures.** A unique key over repository, kind
  and label turns two runs on one day into one row and destroys the observation that these lists were
  captured twice. Only the day key may be unique.
- **Without `granularity` in the key, a week collides with a day.** Weekly development rows and daily
  traffic rows live in the same table, so the granularity column is what keeps a week-start day from
  overwriting a daily observation.
- **An upsert that does not move the collection timestamp makes provenance wrong.** The row then reads
  as older than it is and the backfilled-versus-collected boundary is drawn in the wrong place.
- **Deleting and reinserting a run row hides an abandoned run.** The run row is inserted at start and
  updated at completion, so a run that never closed is detectable from the journal alone.
- **A snapshot must not be given a day.** These lists have no day dimension to correct, and stamping one
  invites a later fix that overwrites history.
- **A repository row is never deleted, only marked.** Removing it takes years of history with it, which
  is exactly the evidence the product exists to keep.
- **The layer is isolated for a reason.** The repository interface is the only surface the rest of the
  product is allowed to import, so a runtime re-check stays in one file.

## Validation

Self-check with a temporary migrated database; the constraint assertions run as direct SQL, because an
application-level check can be bypassed by a later edit:

- [ ] A test asserts `foreign_keys`, `journal_mode` and the defensive setting on the opened connection,
      reading each back rather than asserting the options that were passed in.
- [ ] Opening on a runtime without `enableDefensive` raises a named error carrying the running version
      and the 24.12.0 floor, and leaves no connection open.
- [ ] A fresh temporary database migrates, reports no pending version afterwards, and a re-apply performs
      no write and keeps the recorded checksum.
- [ ] Changing a migration file after it was recorded aborts with both the expected and the actual
      checksum named, and an applied migration missing from code aborts by name.
- [ ] Writing the same repository, metric, granularity and day twice leaves one row carrying the later
      value and the later collection time, and a stale write applies nothing.
- [ ] A `source` outside `backfill` and `collected`, and a write without a collection timestamp, are both
      rejected by the database itself.
- [ ] Two snapshot captures of the same label with different capture times both survive and the history
      read returns both.
- [ ] A `DELETE` on an evidence table raises, and an `UPDATE` on a history table raises.
- [ ] A range read over a window with a deliberate hole returns stored rows only, while `calendarDays`
      over the same window returns every day including the hole.
- [ ] `node scripts/backup-drill.mjs` exits zero, so the restore path is proven rather than asserted.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default a constraint asserted only in application code counts as
      unproven.