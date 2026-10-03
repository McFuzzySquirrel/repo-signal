# Troubleshooting runbook

This page is for the maintainer whose daily collection stopped producing data. It maps seven failure
modes to the state word the product reports for each, or says plainly where the product has no state
word to report, so a symptom can be matched to a cause without guessing, and it gives the next
command to run.

Read it in this order: find the **state word** in the table below, then read the section named for
that word. The word is the product's own; it is defined once in `src/supervision/health.js` and the
failure classification behind it once in `src/supervision/errors.js`.
`tests/troubleshooting-contract.test.js` reads those words out of the product's own constants and
asserts this page uses them, so a renamed state breaks the test rather than your trust.

Every RepoSignal command named below is a command this repository provides; the same test resolves
each one against the command registry. Commands belonging to your operating system (`chmod`,
`systemctl`, `journalctl`) are the machine's own. This page reports no test result, no approval and
no compliance claim: it describes what the commands print and what to do next.

Run every RepoSignal command from a checkout of this repository. Exit codes are the same everywhere:
`0` succeeded, `1` failed operationally, `2` the command line was wrong.

---

## State words and what each one means

Each word below is a state, not a severity and not a colour. The health read that produces them
reports each one as a word beside a sentence that begins with the same word in plain English, so the
word is what you can match on - in a dashboard page that renders the read, or in a terminal
conversation about what the archive holds. Every state in this table is a value the read actually
returns; none of them is a prediction about what some surface will eventually print.

| State word | What it means | Go to |
|------------|---------------|-------|
| `needs-re-authentication` | The stored credential was refused and only a new token leaves this state | [An expired or revoked token](#an-expired-or-revoked-token), [A token without the traffic permission](#a-token-without-the-traffic-permission) |
| `degraded` | One or more collections failed in a row, while the schedule itself is intact | [An exhausted rate limit](#an-exhausted-rate-limit) |
| `stalled` | No successful collection within the 26-hour threshold, so scheduled collection has stopped | [A stalled collector](#a-stalled-collector) |
| `unavailable` | The repository is missing, renamed, transferred or archived, and is marked rather than dropped | [A repository GitHub no longer serves](#a-repository-github-no-longer-serves) |
| `never-collected` | No successful collection has been recorded yet, so there is no schedule to judge | [First run has not succeeded yet](#first-run-has-not-succeeded-yet) |
| `unreadable` | A recorded collection time this build cannot read, so the schedule cannot be judged | [A recorded time this build cannot read](#a-recorded-time-this-build-cannot-read) |
| `healthy` | The last collection succeeded inside the threshold and no failure is outstanding | nothing to do |

Five words describe the run or the home rather than a single repository. They come from the same
read, so a surface that renders it shows them beside the repository list:

| Run word | What it means |
|----------|---------------|
| `never-run` | no run has ever been journalled in this home |
| `unclosed` | a run began and never closed: it is either in progress or was killed |
| `completed` | the last run finished with every repository succeeded |
| `degraded` | the last run finished with at least one repository failed |
| `empty` | the roll-up word for a home that has enrolled nothing at all |

Three of the seven failure modes below - a configuration file that will not load, a migration that
will not apply and a database that will not open - have **no state word at all**, because each one
breaks something the health read itself depends on. They are named as refusals by the commands
instead. See
[Three failure modes that cannot show a state word](#three-failure-modes-that-cannot-show-a-state-word).

---

## An expired or revoked token

**State word: `needs-re-authentication`.** The word means the stored credential was refused and that
only a new token leaves it. Collection does not retry a refused credential, because retrying it only
spends requests without changing the answer.

**What you see.** GitHub answers `401` for every request. `collect` prints one line per repository
naming the failure kind, and the run's status word is `degraded`:

```
owner/name failed authentication-rejected backfill skipped GitHub HTTP 401: Re-authenticate with a valid GitHub token
```

The summary line ends `status=degraded`, and `collect` exits `1`.

**Why it happens.** Fine-grained personal access tokens are short-lived, and a token can be revoked,
expired, or regenerated without you. This build cannot tell those apart from the archive: it records
that the credential was refused, not why it was refused.

**What to do.**

1. Write a new fine-grained token, scoped to the enrolled repositories, holding the
   `Administration repository permission (read)` that the traffic endpoints require. That string is
   the one the classifier prints, so it is what you will match against in the log.
2. Replace the token in the home's `credentials.json` and hold the file at mode `0600` exactly. The
   tool refuses to read it otherwise and names the mode it observed.
3. Check the file without printing the token:

   ```
   node src/cli.js config check
   ```

   `config check` validates the file's mode and shape. It reads no credential beyond that and prints
   no token, so it is safe to paste its output into a report.
4. Collect again. The state leaves `needs-re-authentication` only on a **successful** collection, so
   check that the run's status word is `completed` and not merely that the command returned.

```
node src/cli.js collect
```

**If `config check` passes but collection still fails with `401`**, the file is well formed and the
token behind it is still wrong: the token you pasted is the one GitHub is refusing. Nothing in the
archive can narrow this further.

---

## A token without the traffic permission

**State word: `needs-re-authentication`, the same word as an expired token.** The two causes are
deliberately one state, because one action leaves both: a token that is accepted but under-permissioned
and a token that is refused are both fixed by a credential with the right permission. The failure
*kind* recorded against the repository distinguishes them, and the read reports that kind beside
the state as the most recent failure.

**What you see.** GitHub answers `403` for the traffic endpoints while the repository and statistics
endpoints may still succeed. `collect` prints:

```
owner/name failed permission-missing backfill skipped endpoint=/repos/owner/name/traffic/clones?per=day GitHub HTTP 403: Grant Administration repository permission (read), accept the permission upgrade, and reconnect
```

**Read the endpoint before the permission.** A collection makes several requests per repository and a
failure names the endpoint that answered it, so `endpoint=.../traffic/clones` is a traffic permission
problem while `endpoint=.../stargazers/history` is not a permission problem at all. See
[A star history GitHub will not serve](#a-star-history-github-will-not-serve).

**Why it happens.** The traffic endpoints - clones, views, referrers and popular paths - require the
`Administration repository permission (read)`, so a token without it is rejected on exactly those
four endpoints. A repository can then look partly collected: history is present from before the
token changed, and nothing new arrives.

**What to do.**

1. On the token's settings page, grant `Administration` at read for each enrolled repository. Accept
   the permission upgrade GitHub asks you to confirm.
2. Collect again:

   ```
   node src/cli.js collect
   ```

3. Confirm the repository's state word returns to `healthy`.

**The one permission that matters.** `Administration repository permission (read)` is the only
permission this tool asks for; it never asks for `Contents` and never writes to a repository. If you
are being asked for write access, the answer is no, and that is not a configuration this tool
produces.

---

## A star history GitHub will not serve

**No state word, because nothing failed.** The repository collects normally and its state word stays
`healthy`; the star series is simply absent, and the collection line says so on every run rather than
leaving a gap that would read as a zero. This is the one answer on this page with no state word that
is not a failure mode at all, which is why it is not counted among the
[three that cannot show one](#three-failure-modes-that-cannot-show-a-state-word).

**What you see.** The per-repository line ends with the reason:

```
owner/name ok 14 days written 56 revised 0 unchanged 0 snapshots 3 backfill first-connect stars-history absent GitHub HTTP 403: GitHub refused the star history for this token, so star history is unavailable; collection continues without it, and re-enrol the repository once the token can read it
```

**Why it happens.** In July 2026 GitHub limited the public stargazer listing,
`/repos/{owner}/{repo}/stargazers`, to admins and collaborators, because those lists were being used
to collect users for spam. GitHub may answer with a `403` or with an empty list.

This tool no longer reads that listing. The first-connect backfill reads
`/repos/{owner}/{repo}/stargazers/history`, which the restriction did not cover and which answers an
unauthenticated caller, so an ordinary token reads star history normally and no extra permission is
needed. If you see this message at all, the *history* endpoint was refused too - which is not a
permission your token lacks, and granting every permission this tool uses will not change it.

**What to do.** Nothing, for the traffic data - it is already collected. The star series before the
refusal cannot be reconstructed, and this tool does not invent it.

If you later get a token GitHub answers, the refusal is recorded once and the history is not asked
again. Nothing in this build clears that record, so restoring star history means restoring an archive
from before the refusal.

---

## An exhausted rate limit

**State word: `degraded`, while the schedule is intact.** A rate-limited repository failed, so the run
is degraded - but a repository that collected successfully inside the last 26 hours is still on its
schedule. The read reports the consecutive failure count and the most recent failure beside the
word, so a rate limit shows as a growing streak rather than as a stall.

**What you see.** GitHub answers `429`, or the primary budget is already exhausted before the
request. `collect` prints:

```
owner/name failed rate-limited backfill skipped GitHub HTTP 429: Wait for the GitHub rate limit to reset before collecting again
```

**Why it happens.** The token's request budget for the hour is spent. A single daily run costs about
5 requests per repository, so an ordinary schedule does not reach this; the usual causes are a second
schedule entry installed by accident, `RunAtLoad` left enabled, a manual catch-up run repeated in a
loop, or a repository being enrolled many times over.

**What to do.**

1. Wait for GitHub to reset the budget. The run does not fail fast on a limit: the request policy
   waits for the reset GitHub reports in its own response headers before it gives up, and it waits
   at least a minute between attempts, so a rate-limited run finishes more slowly than a normal one
   and its `duration_ms` in the `summary` line is the honest record of how long it took. A scheduler
   slot can therefore be occupied past the time you asked for; that is the run waiting, not a hang.
2. Count your daily runs before adding another. The request budget per run is documented in
   [docs/operations/scheduled-collection.md](scheduled-collection.md); more than one daily entry
   multiplies it.
3. If the streak keeps growing without your schedule running more often, one scheduled entry is
   failing on a token it cannot authenticate, and the cause is a credential problem from one of the
   two sections above, not the limit.

---

## A stalled collector

**State word: `stalled`,** and beside it the elapsed time since the last successful collection and
the reason sentence. Stalled means the **schedule** has stopped, not that a repository failed: it is
the laptop-sleep failure mode, and it is reported only when no successful run has been recorded
within the 26-hour threshold.

**What you see.** No new lines in the collection log for two days or more. The run journal shows the
gap. If a run was in flight when the machine slept, the last run's word is `unclosed`, because the
archive cannot distinguish a run in progress from a killed process.

**Why it happens.** The machine was asleep or shut down; the schedule entry was never installed; the
entry names the wrong interpreter, checkout or home; the entry is installed but disabled; or the
process is being killed by a supervisor.

**What to do.**

1. Confirm the archive is intact and knows what version it is:

   ```
   node src/cli.js db status
   node src/cli.js db verify
   ```

2. Collect once by hand. This is safe to repeat and converges; it is the same command the schedule
   runs, and a day inside GitHub's traffic window is corrected rather than duplicated:

   ```
   node src/cli.js collect
   ```

3. Read the exit code and the `summary` line. A `stalled` repository returns to `healthy` after one
   **successful** collection; if it returns to `degraded`, the schedule is fixed and one of the four
   failures below is what the run is now telling you.

4. Reinstall or re-enable the schedule entry. What each scheduler does with a missed run differs, and
   the runbook states it per scheduler:
   [docs/operations/scheduled-collection.md](scheduled-collection.md).

**A stalled repository is not an emergency and is not data loss.** The gap is a real gap and stays a
gap: days outside GitHub's 14-day traffic window cannot be recovered by catching up, and nothing
should be written into the archive by hand to close one. The recovery path for the days GitHub still
serves is to collect again.

---

## A configuration file that will not load

**No state word.** This failure happens before any repository state can be computed: the health read
begins by reading `config.json` to learn which repositories exist, so a configuration it cannot parse
leaves nothing to report a state from. The refusal names the cause, and every command that reads the
configuration refuses the same way.

**What you see.** Both commands that read the configuration - `discover` and `collect` - exit `1` with
one line:

```
discover failed: Configuration key $: malformed JSON; correct the JSON syntax in config.json and retry
```

The `$` names the document as a whole rather than one field. When the document parses but a value is
wrong, the message names that key instead, such as `Configuration key enrolled[0]: expected a single
nonempty owner/name pair without whitespace`.

**What to do.** Validate the file the way the commands read it:

```
node src/cli.js config check
```

`configuration ok` means `discover` and `collect` will read the same file the same way: the check calls
the loader they call, so its verdict is theirs rather than a second opinion. `configuration failed`
names the offending key.

Two mistakes account for most of these refusals. A whole-line `//` comment is **not** one of them:
`config init` writes a commented template and every command that reads `config.json` accepts those
comments, so leave them or delete them as you prefer. An inline `//` after a value and a trailing
comma are both refused, everywhere, by every command.

**To go back to the templates.** `config init --force` replaces **both** files, including
`credentials.json`, so copy your token somewhere safe before you run it:

```
node src/cli.js config init --force
```

---

## A migration that will not apply

**No state word.** This failure happens before any repository state can be computed: `collect` opens
the archive and applies pending migrations before it reads or writes a single fact, so a migration
that fails produces a refusal from the command, not a state on a repository. What you see is a
non-zero exit and one line naming the cause.

**What you see.**

```
db status failed: Applied migration 2 is missing from code (on-disk version 2, code version 1); restore the original migration files or use matching newer code
```

or, for a migration that is merely pending and not yet applied:

```
migration pending: yes (1)
```

**Why it happens.** The archive was written by a build newer than the one you are running, so a
migration this build does not have is recorded as applied. Or an applied migration's file has
changed since it was applied, and the recorded checksum no longer matches. Migrations in this
repository are **forward-only** and checksummed for exactly this reason: an archive edited behind the
code's back is not repairable by editing it further.

**What to do.**

1. **Do not edit the archive.** The refusal is the protection. Read the message: it names the applied
   migration version and both schema versions.
2. Compare the two versions:

   ```
   node src/cli.js db status
   ```

3. Take a copy before changing anything:

   ```
   node src/cli.js db backup "$HOME/repo-signal-backups/before-migrate.sqlite3"
   ```

4. If the on-disk version is **behind** the code, the migration is simply pending and
   `collect` applies it for you on the next run; `node src/cli.js db migrate` applies it explicitly.
   Then verify:

   ```
   node src/cli.js db verify
   ```

5. If the on-disk version is **newer** than the code, restore the migration files for the build that
   wrote the archive, or run a newer build that has them. Leave the archive alone. This is the one
   case where the answer is to change the code, not the data.

---

## A database that will not open

**No state word**, for the same reason as a failed migration: the health read needs the archive, and
the archive is what cannot be opened. The refusal names the file, the path or the mode, which is the
evidence you need.

**What you see.** Every command that opens the archive exits `1` and names the cause on one line.
The wording after the colon is the underlying error's, so read the noun rather than expecting one
fixed sentence. Three you will meet, one per cause:

```
collect failed: unable to open database file
```

for a path that cannot be opened at all,

```
collect failed: attempt to write a readonly database
```

for a home the current user cannot write to, and

```
collect failed: file is not a database
```

for a file sitting at the archive path that is not a SQLite database. `db status` and `db verify` name
the same cause for the same path.

**Why it happens.** The home directory is not readable or writable by the current user; the archive
file was replaced by something that is not a database, for example by a mistaken restore from an
unrelated file; the disk is full; the file is locked by another process on some platforms; or the
Node build in use is older than the engine floor and its `node:sqlite` cannot open this archive at
all, which is reported as a runtime API mismatch rather than as a data fault.

**What to do.**

1. Establish which file is meant, from the path the command prints:

   ```
   node src/cli.js db status
   ```

2. Check ownership and permissions on the home. It is created `0700` and the tool refuses to proceed
   if it cannot confirm that:

   ```
   ls -ld "$HOME/.local/share/repo-signal"
   chmod 700 "$HOME/.local/share/repo-signal"
   ```

3. Check that the runtime in use is the one you expect, and that it meets the engine floor:

   ```
   node -v
   ```

   A build older than the floor imports `node:sqlite` successfully and then fails inside the storage
   layer, which reads as a product defect rather than a runtime mismatch. Check the version before
   investigating the archive.

4. Check the archive itself:

   ```
   node src/cli.js db verify
   ```

5. If the file is corrupt or was overwritten, restore a known-good copy. The full procedure, and the
   warning that a restore replaces the current archive, are in
   [docs/operations/backup-and-migrate.md](backup-and-migrate.md):

   ```
   node src/cli.js db restore "$HOME/repo-signal-backups/archive-2026-10-02.sqlite3"
   ```

---

## Three failure modes that cannot show a state word

An expired token, a missing permission, an exhausted limit and a stalled schedule all leave the
archive readable, so the health read can report a state for them. A configuration file that will not
load, a migration that will not apply and a database that will not open do not: the archive is the
source of the state, and when it cannot be opened, or when the configuration naming the repositories
cannot be read, there is nothing to read a state from. Rather than invent a word for them, this page
names the refusal each command prints, which is where the evidence actually is.

If you are reading state words and none of the seven above is present while collection is visibly
not happening, that itself is a symptom: look for a refusal in the collection log and check whether
the archive opens at all.

---

## A repository GitHub no longer serves

**State word: `unavailable`,** with the reason GitHub gave recorded beside it. A renamed, transferred
or archived repository is **marked, not dropped**: every fact ever written under its identity stays
in the archive, and later runs skip it without making a request. Unlike the four failures above, a
new token does not leave this state.

**What to see.** `collect` prints:

```
owner/name unavailable GitHub answered HTTP 404 for owner/name: GitHub does not serve this repository under this name, or the token cannot see it
```

and a later run prints the same repository as skipped, at no request cost:

```
owner/name skipped lifecycle=unavailable requests=0 GitHub answered HTTP 404 for owner/name: GitHub does not serve this repository under this name, or the token cannot see it
```

**What to do.** Find the name GitHub currently serves for this token and update the enrolled name in
`config.json` to that name:

```
node src/cli.js discover
node src/cli.js collect
```

`discover` prints the repositories this token can reach along with configuration lines the loader
accepts. A repository that is still reachable under its old name was not renamed; one that no longer
appears may have been renamed, transferred, or made private.

**The mark itself is permanent in this build, and that is a limitation worth knowing.** The archive
records `unavailable` on the repository's own row, and no command in this build clears it: fixing the
configuration does not un-skip a repository the archive has already marked, and re-registering the
name does not either. So a repository marked by a transient condition - a token that briefly could
not see it, for example - keeps its history and costs nothing, but also keeps reporting
`unavailable`. What you can do is stop enrolling it, which takes it out of the daily request count
entirely, and rely on the history already stored. This is recorded here rather than papered over,
because a runbook that promised a one-line fix for this state would be wrong.

---

## First run has not succeeded yet

**State word: `never-collected`,** which is deliberately **not** `stalled`. There is no recorded
schedule to judge, so the archive does not claim one is broken. If you are seeing this on every
repository, the question is why the first run has not completed, and the three sections above cover
the causes: a refused token, a missing permission, or a home that will not open.

A repository that has never been collected has no traffic history in the archive either. The first
successful collection performs the first-connect backfill and stamps the provenance boundary, and
the archive reports itself as `not-connected` until a collected day exists. The days before that
boundary are a different kind of evidence, not a failure to collect them.

---

## A recorded time this build cannot read

**State word: `unreadable`.** A recorded collection time exists but this build cannot parse it, so the
schedule cannot be judged and the repository is reported as unknown rather than as stalled. This is
rare, and it is an honest answer rather than a guess: the archive reports what it can read.

**What to do.** Confirm the archive is intact with `node src/cli.js db verify` and check the two
schema versions with `node src/cli.js db status`. If both agree and the time still cannot be read,
collect again to record a fresh success:

```
node src/cli.js collect
```

---

## When you have worked through the sections

Check the three things that are true regardless of the cause:

```
node src/cli.js config check
node src/cli.js db status
node src/cli.js db verify
```

And before you close the incident, take a backup. The archive is the only copy of years of history,
and the runbook for that is
[docs/operations/backup-and-migrate.md](backup-and-migrate.md):

```
node src/cli.js db backup "$HOME/repo-signal-backups/archive-2026-10-02.sqlite3"
```

If the fix turned out to be a schedule problem rather than a data problem, the scheduling runbook is
the one that owns it:
[docs/operations/scheduled-collection.md](scheduled-collection.md).

---

## Commands named on this page

| Command | What it is for |
|---------|----------------|
| `node src/cli.js collect` | collect every enrolled repository now |
| `node src/cli.js collect --dry-run` | plan the run without contacting GitHub |
| `node src/cli.js collect --repo owner/name` | collect one enrolled repository |
| `node src/cli.js config check` | validate configuration and credentials without printing the token |
| `node src/cli.js config init` | create the configuration and credential templates |
| `node src/cli.js db status` | read the database path and the schema versions |
| `node src/cli.js db verify` | run SQLite's integrity check over the archive |
| `node src/cli.js db migrate` | apply pending archive migrations forward-only |
| `node src/cli.js db backup <path>` | write a consistent copy of the archive |
| `node src/cli.js db restore <path>` | load a copy over the archive, re-verify it, print its counts |
| `node src/cli.js discover` | list repositories this token can reach, with pasteable configuration lines |
| `node src/cli.js report` | print a written summary of what the archive holds, without contacting GitHub |
| `node src/cli.js report --repo owner/name` | add one repository's coverage, gap days and change to that summary |

Every command in this table exists in this repository today; `tests/troubleshooting-contract.test.js`
resolves each one against the command registry and fails if this page names one that does not.