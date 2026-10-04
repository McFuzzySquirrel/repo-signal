# Backup and migration runbook

This page is for the operator who expects to keep an archive for years. It says where the
archive lives, where copies of it should live, how to restore one into a fresh home, how to
move one to another machine, and what to do when the code is newer than the archive.

Run every command below from the repository root. Every command named here exists in this
repository today; `tests/backup-drill.test.js` resolves each one against the command
registry, so a page naming a command that no longer exists fails the test suite rather than
misleading a stranger. This page reports no test result, no approval and no compliance
claim; it describes what to run and what the commands say when they run.

---

## Where the archive lives

All durable state is in one home directory, resolved in this order:

1. `REPO_SIGNAL_HOME`, when it is set to a non-blank value
2. `XDG_DATA_HOME/repo-signal`
3. `~/.local/share/repo-signal`

The home is created with mode `0700` and holds three files of its own, plus the two write-ahead
side files the archive keeps beside itself while it is open:

| File | What it is |
|------|------------|
| `config.json` | the enrolled repository list, an optional deny list, an optional per-repository flag and the UTC collection hour |
| `credentials.json` | the access token; the tool refuses to read it unless its mode is exactly `0600` |
| `archive.sqlite3` | the archive: every day-series fact, snapshot entry and run journal row |
| `archive.sqlite3-wal` | the archive's write-ahead log: the part of the archive not yet checkpointed into `archive.sqlite3`, present while the archive is open |
| `archive.sqlite3-shm` | the shared-memory index that belongs to that log, present while the archive is open |

**The two side files belong to the open archive, not to a separate copy.** They are not a backup and
not a second archive: while the archive is open they hold the pages written since the last
checkpoint, so a plain file copy of `archive.sqlite3` on its own can miss the most recent writes.
A clean shutdown folds the log back into the archive and takes both side files with it. A restore
removes them, because `node src/cli.js db restore` replaces the archive the log belonged to; the
warning box below says so at the point where it matters. That is the whole reason a copy is taken
through `db backup`, which folds the log into one self-contained file, and it is why you should not
assemble a backup by copying files out of a home yourself.

RepoSignal refuses to start when the resolved home is a git repository root, so the home
must sit outside every work tree, including this repository's own checkout. `REPO_SIGNAL_HOME`
is the way to keep a second archive on the same machine, for example while rehearsing a
restore.

## Where copies should live

A backup copy is the whole archive in one self-contained file, and it should be treated as
the private data it is: RepoSignal has no export, publish or share action, and neither should
you. Keep copies like this:

- **Outside the home directory.** A copy is a backup of the archive, not part of it. Keeping
  copies out of the home keeps a mistaken `db restore` from overwriting a copy with the live
  archive, and keeps one directory's permissions from having to cover both.
- **Outside every git work tree.** Never commit a copy and never leave one inside a checkout.
  A copy is the archive itself, so keep it in the same private posture as the home it came
  from.
- **On a different medium from the machine.** A copy next to the archive protects you from a
  mistaken command; a copy on another disk or another machine protects you from the disk.
- **At least one copy you control**, kept somewhere the machine's own failure cannot take.
  Decide where that is before you need it, and keep more than one generation: a copy taken
  after a bad collection is still a bad copy.
- **Named for when it was taken**, so a restore is a decision you can date, for example
  `archive-2026-10-02.sqlite3`.

Create the copy directory yourself, once, outside every work tree. `db backup` writes the file
path you name and does not create directories: naming a directory that does not yet exist
fails with `db backup failed: unable to open database file`.

A copy carries the archive and nothing else. It never contains `config.json` or
`credentials.json`, so a restored home needs its own configuration and its own token.

---

## Prove the procedure before you trust it

`scripts/backup-drill.mjs` performs the whole procedure below on scratch directories it
creates in the system temporary directory and deletes afterwards. It never touches your real
home, your real archive or the network.

```
node scripts/backup-drill.mjs
```

The drill creates a scratch home, writes a small known dataset through the repositories,
takes a backup of it with the database command, restores that copy into a second scratch
home, runs the integrity check there, and compares the per-table row counts of the two
homes. It exits `0` only when every table agrees and exits non-zero on any difference, so
the exit code is the answer to "does the restore path still work?".

Its output is narrow on purpose: scratch paths, table names, row counts and any refusal a
command printed. It prints no observation value, no repository name and no token.

```
node scripts/backup-drill.mjs --keep
```

The same drill, leaving the scratch directories behind and printing where they are, for when
you want to look at a restored archive yourself.

```
node scripts/backup-drill.mjs /path/to/archive-2026-10-02.sqlite3
```

Rehearse one copy you already have: it is restored into a fresh scratch home, verified, and
its per-table counts are compared with the counts the copy itself reports. A copy that fails
its integrity check is reported and the drill exits non-zero without writing anything into
the rehearsal home. Use this on a copy you are about to trust, and on any copy you just
received from somewhere else.

---

## Take a backup of a real archive

```
node src/cli.js db verify
node src/cli.js db backup "$HOME/repo-signal-backups/archive-2026-10-02.sqlite3"
```

`db verify` runs SQLite's integrity check over the archive in your home and exits non-zero if
it finds anything wrong. Fix that before backing up: a copy of a damaged archive is a damaged
copy.

`db backup` writes a consistent copy to the path you name. The copy is a single
self-contained file: write-ahead log state is folded into it, so the file can be moved on its
own and verified on its own. The command then prints the path it wrote, followed by one
`table: count` line per table, those counts being the row counts of the archive it copied.

Keep that listing beside the copy, or in whatever you already use to remember what you
backed up. Those counts are what you compare a restore against, and they are the whole
comparison: nothing in this repository's output carries an observation value, and neither
should your notes.

To back up a home that is not the default one, prefix the command with the home it resolves,
for example `REPO_SIGNAL_HOME=/srv/repo-signal-archive node src/cli.js db backup ...`.

---

## A restore replaces the current archive

> **`node src/cli.js db restore <copy>` overwrites `<home>/archive.sqlite3`, and deletes the
> sibling `archive.sqlite3-wal` and `archive.sqlite3-shm` files.** There is no undo, no
> timestamped previous version kept for you and no confirmation prompt. Everything
> collected since the copy was taken is gone from that home. Take a `db backup` first, or
> restore into a fresh home when you are not certain.

`db restore` does check the copy before it replaces anything: a copy that fails its integrity
check is refused, the command exits non-zero, and the target home is left without an archive
rather than with a broken one. That check protects you from a corrupt copy, not from a
mistyped path. Given a path that does not exist, the command creates an empty archive there
and reports a successful restore with no per-table counts at all, so make sure the copy is
where you think it is before you restore it. Rehearsing the copy first with
`node scripts/backup-drill.mjs <copy>` refuses a path it cannot read and refuses an archive
with no tables in it.

---

## Restore into a fresh home

1. **Decide which home you are restoring into.** If the archive you are replacing still holds
   anything you want, take a backup of it first (`db backup`), because the restore replaces it.

2. **Point `REPO_SIGNAL_HOME` at a directory that does not exist yet**, outside every work
   tree. The tool creates it with mode `0700` on first use and refuses to run inside a git
   repository. For example, export `REPO_SIGNAL_HOME=/srv/repo-signal-restored` before the
   commands below, or leave the variable unset to use the default home.

3. **Restore the copy:**

   ```
   node src/cli.js db restore "$HOME/repo-signal-backups/archive-2026-10-02.sqlite3"
   ```

   The command prints the copy it loaded, `integrity check: ok`, and the per-table row counts
   of the archive it just wrote.

4. **Compare those counts with the listing taken when the copy was made.** Any difference
   means the copy you are holding is not the archive you backed up. Do not collect into that
   home until the counts agree.

5. **Verify the archive in its new home:**

   ```
   node src/cli.js db verify
   ```

6. **Read the schema version, and migrate if the code is ahead:**

   ```
   node src/cli.js db status
   node src/cli.js db migrate
   ```

   `db status` prints `schema version (code)`, `schema version (on disk)` and whether a
   migration is pending. When it says `migration pending: yes`, run `db migrate` and then
   `db verify` again.

7. **Recreate the configuration and the credential.** A backup copy carries the archive only,
   so the fresh home has no `config.json` and no `credentials.json`:

   ```
   node src/cli.js config init
   node src/cli.js config check
   ```

   `config init` writes both templates with the modes the tool requires, and `config check`
   validates them without printing the token. Fill in your repositories and paste your token
   into `credentials.json`, then make sure its mode is `0600` exactly.

8. **Only then point your schedule at the new home**, and let the next collection run there.

---

## Move an archive to another machine

Moving is how you recover onto a replacement machine or relocate an archive that must live
elsewhere. It is not a way to run two collectors over one history: the archive is one local
file, and a day-series row is corrected last-write-wins per repository, metric and day, so two
machines writing the same archive overwrite each other's days instead of merging them.

On the machine that holds the archive:

```
node src/cli.js db verify
node src/cli.js db backup "$HOME/repo-signal-backups/archive-2026-10-02.sqlite3"
node scripts/backup-drill.mjs "$HOME/repo-signal-backups/archive-2026-10-02.sqlite3"
```

Keep the printed per-table listing; it is the evidence of what you are about to move.

Then transfer that one file, out of band, with whatever transfer tool you already trust. The
archive is self-contained, so nothing else in the home has to travel with it. Do not transfer
`credentials.json`: the token belongs to the machine that holds it, and the destination
machine needs its own.

On the destination machine:

```
node src/cli.js db restore "/path/to/transferred/archive-2026-10-02.sqlite3"
node src/cli.js db verify
node src/cli.js db status
node src/cli.js db migrate
node src/cli.js config init
node src/cli.js config check
```

Set `REPO_SIGNAL_HOME` for those commands if you do not want the default home, and run them
from a checkout of this repository with the destination home somewhere else entirely. Compare
the counts `db restore` printed with the listing from the source machine. Once the
destination home verifies and its counts agree, point the schedule at it and stop collecting
into the old home. Keep the old home until the destination has collected successfully at
least once; deleting it is your decision, and nothing here will do it for you.

---

## When the code's schema version is ahead of the archive

`db status` is the command that tells you the two versions apart. Its output has one line per
version, with the database path on the first line as your machine resolves it:

```
database: <your home>/archive.sqlite3
schema version (code): 2
schema version (on disk): 0
migration pending: yes (1, 2)
```

Migrations in this repository are forward-only, so a newer build brings pending work with it
and the fix is to apply that work, never to edit the archive:

1. **Back up the archive first.** `db migrate` changes its schema, and this is the only copy
   of your history until you make another:

   ```
   node src/cli.js db backup "$HOME/repo-signal-backups/before-migrate-2026-10-02.sqlite3"
   ```

   Keep the printed row counts. They are what you compare after migrating.

2. **Apply the pending migrations:**

   ```
   node src/cli.js db migrate
   ```

3. **Verify, then compare counts:**

   ```
   node src/cli.js db verify
   node src/cli.js db backup "$HOME/repo-signal-backups/after-migrate-2026-10-02.sqlite3"
   ```

   A migration may add tables, columns and bookkeeping rows, so the per-table listings before
   and after can differ in exactly those tables. Your day-series, snapshot, error and
   heartbeat counts must not change. If a fact count changed, take the copy from step 1 back
   with `db restore` and report it.

4. **The other direction.** When the on-disk version is *newer* than the code, `db status` and
   `db migrate` both fail and say so, naming the applied migration this build does not have:
   `db migrate failed: Applied migration 7 is missing from code (on-disk version 7, code
   version 1); restore the original migration files or use matching newer code`. Nothing is
   written in that case. Restore the migration files for the build that wrote the archive, or
   run a newer build that has them, and leave the archive alone. Editing the archive to make
   the versions agree destroys evidence and is never the answer.

---

## Commands named on this page

| Command | What it is for |
|---------|----------------|
| `node scripts/backup-drill.mjs` | run the whole drill on scratch directories |
| `node scripts/backup-drill.mjs <copy>` | rehearse one backup copy that already exists |
| `node src/cli.js db verify` | integrity check over the archive in the resolved home |
| `node src/cli.js db backup <path>` | write a consistent copy and print its per-table row counts |
| `node src/cli.js db restore <path>` | load a copy over the archive, re-verify it, print its counts |
| `node src/cli.js db status` | read the on-disk schema version beside the code version |
| `node src/cli.js db migrate` | apply pending archive migrations forward-only |
| `node src/cli.js config init` | create private configuration and credential templates |
| `node src/cli.js config check` | validate them without printing the token |

Exit codes are the same everywhere: `0` succeeded, `1` failed operationally, `2` the command
line was wrong. `node src/cli.js --help` prints the commands this build registers.