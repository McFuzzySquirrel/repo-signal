# Scheduled collection runbook

This page is for the maintainer who wants the archive to fill itself without anyone remembering to
run it. It gives a working daily schedule entry for cron, for launchd and for a systemd timer, the
request budget each daily run is expected to cost, what a sleeping machine does to the schedule, and
how to catch up after a missed day.

RepoSignal's collector embeds **no timer and no scheduler**. `collect` runs once and exits; daily
operation is the operating system's job. That is why this page exists, and why nothing here installs
a timer for you: a schedule entry you can read is worth more than a timer you cannot see.

Every RepoSignal command named below is a command this repository provides;
`tests/troubleshooting-contract.test.js` resolves each one against the command registry and
computes the request budget below from the collector's own constants, so this page cannot drift away
from the code while still reading correctly. Commands belonging to the operating system (`crontab`,
`launchctl`, `systemctl`, `journalctl`, `chmod`) are the machine's own and are not the repository's
to provide. This page reports no test result, no approval and no compliance claim; it describes what
to install and what the commands print when they run.

---

## What the daily run is

Run every command below from a checkout of this repository, with the home directory you want it to
use.

```
node src/cli.js collect
```

`collect` resolves the enrolled set, collects each repository independently, writes a run row, and
prints one line per repository followed by one `summary ...` line. It exits `0` when every
repository succeeded and `1` when at least one failed or GitHub no longer serves a repository; the
run record is complete either way. A repository that fails never aborts the rest of the run.

Two flags shape the daily run:

```
node src/cli.js collect --dry-run
node src/cli.js collect --repo owner/name
```

`--dry-run` plans the run and prints what it would collect without contacting GitHub: it reads no
credential, opens no socket, writes nothing and reports `requests=0`. Use it to see the plan and its
request floor before the first real run. `--repo owner/name` restricts the run to one enrolled
repository, which is useful for a manual catch-up of a single repository.

The only other RepoSignal commands this page needs are `config init` and `config check` (to create
and validate a home) and the `db` commands (to check, migrate, verify and back up the archive).
`node src/cli.js setup` will create and check that home for you one question at a time, and it can
record the collection hour discussed below - but it installs no schedule, so a schedule entry is
still something you write yourself; see
[Before you install a schedule entry](#before-you-install-a-schedule-entry).

---

## Before you install a schedule entry

**Give the schedule an explicit home.** A scheduler does not inherit the shell you installed it
from. `collect` resolves its home in this order: `REPO_SIGNAL_HOME`, then
`XDG_DATA_HOME/repo-signal`, then `~/.local/share/repo-signal`. Set `REPO_SIGNAL_HOME` in the entry
itself, so the schedule cannot silently collect into a different archive than the one you configured.

**Keep the home outside every work tree.** The tool refuses to start when the resolved home is a git
repository root, so a home inside this checkout is refused by design rather than repaired.

**Use absolute paths.** A scheduler runs with a working directory you do not choose and with a
minimal environment: no `nvm` or `asdf` shell function, no relative path. Every entry below names
the interpreter and the checkout by absolute path.

**Match the configured hour.** `collectionHourUtc` in `config.json` records the UTC hour you intend
to collect in; the collector reads no clock to defer a run, so it is a statement of intent, not a
scheduler. Choose the same hour in the schedule entry and in `config.json`, or one of the two will
be a lie. The default is `0`, midnight UTC. `node src/cli.js setup` will ask you for that hour and
save it into `config.json` for you, and that is the whole of its relationship with scheduling:
**the flow sets the hour and installs no schedule** - no crontab line, no launchd plist, no systemd
unit, no timer of any kind - so the entries below are still yours to write and the operating system
still owns the daily run.

**Send the output somewhere durable.** A scheduler's own mail is not a log you can read next year.
The entries below redirect to a file you choose, outside every work tree. The collector redacts
token-shaped values from every line it prints, so a log is safe to keep, but it does contain
repository names and failure sentences.

**Decide the hour before you install, not after a rate limit teaches it to you.** The daily request
budget is small enough that an accidental second daily entry doubles it for nothing.

---

## The expected quiet-hours request budget

A steady-state daily run costs a small, fixed number of requests per repository:

| Step | Requests per repository | Why |
|------|-------------------------|-----|
| Repository resolution | 1 | every repository is resolved once before any fact is written |
| Traffic | 4 | clones, views, referrers and popular paths |
| **Total per daily run** | **5** | the number in the table above, added |
| First-connect backfill | at least 3, once | one stargazer page per page GitHub returns, plus the two statistics endpoints |

Those step counts are constants in `src/collect/run.js`, and `tests/troubleshooting-contract.test.js`
recomputes this table from them: **5 requests per repository per run**, and about **1,830 requests
per repository per year** at one run a day. The quiet-hours budget the project commits to is under
**5,000** requests per repository per year, so a daily run sits comfortably inside it with room for
a first-connect backfill and for a catch-up run or two.

Every figure above is a constant the collector exports from `src/collect/run.js`: the resolution step
is `RESOLUTION_REQUESTS_PER_REPOSITORY`, the four traffic endpoints are `TRAFFIC_REQUESTS_PER_REPOSITORY`,
the backfill floor is `BACKFILL_REQUESTS_FLOOR`, the per-run total is the first two added, and the
yearly figure is that total times one run a day for a leap year, which `tests/contract-collect.test.js`
recomputes from those constants.

Three honest qualifications:

- **The first connect costs more.** The backfill's own count is a floor over an unknown number of
  stargazer pages, so `collect --dry-run` prints `requests>=8` for a repository that has never been
  collected and exactly `requests=5` for one that has. It happens once per repository.
- **A statistics endpoint that is still compiling is retried inside the request policy.** The
  `requests=` count on the summary line is the number of requests the run asked for; a `202` that
  the policy retried is one counted request and more than one HTTP attempt. The counted figure is
  the budget; the real attempt count is occasionally higher.
- **A repository the archive has marked unavailable costs nothing.** It is planned as
  `requests=0` and skipped by every later run. This build has no command that clears that mark, so
  a repository GitHub stopped serving stays marked; see
  [docs/operations/troubleshooting.md](troubleshooting.md) for what that costs you.

Where the figure is read from: the `requests=` field on the `summary` line `collect` prints, and the
request counter recorded against the run in the run journal. Both are per run, so a yearly total is
the sum you read yourself.

---

## Schedule with cron

A crontab entry. Replace the interpreter path, the checkout path and the home path with your own,
then install it:

```
crontab -e
```

The entry itself, one line, at 03:17 UTC every day:

```
17 3 * * * REPO_SIGNAL_HOME=/home/you/.local/share/repo-signal /usr/bin/node /srv/repo-signal/src/cli.js collect >> /home/you/repo-signal-collect.log 2>&1
```

If your machine keeps crontabs for system users instead, the same line works in
`/etc/cron.d/repo-signal`, with six fields (add the user name after the schedule, before the
command):

```
17 3 * * * you REPO_SIGNAL_HOME=/home/you/.local/share/repo-signal /usr/bin/node /srv/repo-signal/src/cli.js collect >> /home/you/repo-signal-collect.log 2>&1
```

Notes for cron specifically:

- **`17 3` is local time, not UTC.** If your machine's timezone is not UTC, either set the hour to
  the UTC hour you configured in `collectionHourUtc` (shifted by your offset) or schedule in UTC and
  accept the local reading.
- **A sleeping machine simply misses the run.** cron does not queue a job it could not start.
  Nothing is collected while the machine is asleep and nothing is collected on wake; see
  [what happens when the machine sleeps](#what-happens-when-the-machine-sleeps).
- **`%` is special in a crontab command.** The entry above contains none; if you extend it with a
  date-stamped log name, escape it as `\%`.
- **A non-zero exit is not retried by cron.** A `degraded` run exits `1` and the next day's entry
  runs anyway, which is the behaviour you want: the archive converges on the next successful run.

---

## Schedule with launchd

On macOS the scheduler is `launchd`. Write the plist below as
`~/Library/LaunchAgents/com.repo-signal.collect.plist`, replacing the interpreter path, the checkout
and the home path with your own:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.repo-signal.collect</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/srv/repo-signal/src/cli.js</string>
    <string>collect</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/srv/repo-signal</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REPO_SIGNAL_HOME</key>
    <string>/Users/you/Library/Application Support/repo-signal</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/Users/you/repo-signal-collect.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/repo-signal-collect.log</string>
</dict>
</plist>
```

Load and enable it:

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.repo-signal.collect.plist
launchctl enable gui/$(id -u)/com.repo-signal.collect
```

Check what launchd thinks it has, and run one collection now rather than waiting until tomorrow:

```
launchctl print gui/$(id -u)/com.repo-signal.collect
launchctl kickstart -k gui/$(id -u)/com.repo-signal.collect
```

Notes for launchd specifically:

- **`WorkingDirectory` is not optional here.** The command names `src/cli.js` relative to the
  checkout, so without it the job cannot find its own entry point.
- **The XML declaration is the only header the parser needs.** No DOCTYPE line is required, and
  leaving it out keeps the only host named anywhere in this page the one host the tool contacts.
- **`RunAtLoad` is false on purpose.** It is the switch that would run a collection at every login,
  which quietly doubles the daily budget on a machine that is opened often.
- **The calendar interval is local time**, the same caveat as cron.
- **A missed interval is launchd's business, not the tool's.** launchd's documented behaviour is to
  run a `StartCalendarInterval` job after the machine wakes rather than skipping it. Confirm what
  your macOS version and your power settings do by watching the log after a deliberate sleep; the
  catch-up procedure below is the answer either way.

---

## Schedule with a systemd timer

Two units: a service that runs the command once, and a timer that asks for it daily. Install them as
a system unit (write them into `/etc/systemd/system/`) or as a user unit (write them into
`~/.config/systemd/user/` and use `systemctl --user` throughout, as below).

`repo-signal-collect.service`:

```ini
[Unit]
Description=RepoSignal daily collection
Documentation=file:///srv/repo-signal/docs/operations/scheduled-collection.md

[Service]
Type=oneshot
Environment=REPO_SIGNAL_HOME=/var/lib/repo-signal
WorkingDirectory=/srv/repo-signal
ExecStart=/usr/bin/node /srv/repo-signal/src/cli.js collect
StandardOutput=append:/var/log/repo-signal-collect.log
StandardError=append:/var/log/repo-signal-collect.log
```

`repo-signal-collect.timer`:

```ini
[Unit]
Description=Run RepoSignal collection once a day

[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
AccuracySec=1min
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
```

Enable and inspect the timer:

```
systemctl daemon-reload
systemctl enable --now repo-signal-collect.timer
systemctl list-timers repo-signal-collect.timer
```

Run one collection now, and read the journal after any run:

```
systemctl start repo-signal-collect.service
journalctl -u repo-signal-collect.service -n 50 --no-pager
```

Notes for systemd specifically:

- **`Persistent=true` is the catch-up switch.** systemd records a missed activation and runs it once
  the machine is back, so a laptop that slept through the hour collects after it wakes.
- **`OnCalendar` is local time unless you say otherwise.** Write `OnCalendar=*-*-* 03:17:00 UTC` to
  pin it to the hour you put in `collectionHourUtc`.
- **`RandomizedDelaySec` spreads the start** when many machines run the same entry. It does not add
  requests.
- **A user unit stops when your session ends.** Add `loginctl enable-linger you` if the collection
  must survive logout, or install the units system-wide instead.
- **A non-zero exit is visible, not silent.** The service is `oneshot`, so its result is the unit's
  result; `systemctl status repo-signal-collect.service` shows it.

---

## What happens when the machine sleeps

Nothing in RepoSignal compensates for a sleeping machine, and that is deliberate. The collector has
no timer, so there is no in-process loop to keep a promise that a suspended process cannot keep:

- **While the machine sleeps, no run starts.** No scheduler can start a process on a suspended
  machine, and the tool is not running to notice anything.
- **A run that was in flight when the machine slept is simply gone.** The run row stays open, and the
  health read reports that last run as `unclosed` - the same word it would use for a run that is
  still going, because the archive cannot tell the two apart. Nothing is half-written: a repository's
  facts and its success stamp commit together, so an interrupted run leaves the days it committed
  and no partial day.
- **After 26 hours without a successful run, the state word is `stalled`.** That threshold is the
  product's definition of the laptop-sleep failure mode, and it is why 26 rather than 24: one
  missed day is still inside the threshold, two are not.
- **A repository that has never been collected is `never-collected`, which is not `stalled`.** A
  first-connect install has nothing to judge a schedule against, and saying otherwise would alarm
  you about a repository that simply has not run yet.
- **What happens on wake depends on the scheduler, not on the tool**: cron skips what it missed,
  launchd runs the missed calendar interval, and a `Persistent=true` timer runs the missed
  activation once. Confirm yours by watching the log after a deliberate sleep, and catch up by hand
  when in doubt.

---

## Catch up after a missed day

Catching up is one command:

```
node src/cli.js collect
```

Collection is idempotent and restartable, so a catch-up run is safe in the situations a missed day
actually produces:

- **A day it already holds is corrected, not duplicated.** A day row is keyed by repository, metric
  and UTC day and is written last-write-wins; re-running inside the 14-day traffic window corrects
  those days instead of adding a second version of them.
- **A run that was interrupted converges.** Nothing needs cleaning up, no partial row needs
  removing, and a repository that failed last time is simply attempted again.
- **One repository failing again does not stop the others.**

What a catch-up cannot do, stated plainly:

- **It cannot reach further back than GitHub's traffic window.** The traffic endpoints return 14
  days, so a catch-up repairs days inside that window. A gap older than the window stays a gap, and
  a gap is the honest record of a machine that was asleep.
- **It does not re-run the first-connect backfill.** That step runs once, on the first successful
  collection of a repository, and the star history it reconstructs does not need repeating.
- **It never invents a day.** Nothing here writes a zero for a day GitHub did not report, and you
  should not repair a gap by hand: the gap is the finding.

Practical order after a missed day: `node src/cli.js collect --dry-run` to see what a run would
collect, `node src/cli.js collect` to collect, and `node src/cli.js db verify` afterwards if you want
the archive checked. To catch up one repository only, use `--repo owner/name`.

---

## Verify the entry you installed

1. **Run one collection by hand with the same environment the entry sets**, including
   `REPO_SIGNAL_HOME`, and read the exit code and the `summary` line. A `degraded` status or exit
   `1` means at least one repository failed; the per-repository line names which and why, and
   `docs/operations/troubleshooting.md` maps that line to a cause.
2. **Confirm the archive is the one you configured** with `node src/cli.js db status`, which prints
   the database path beside the schema versions.
3. **Then let the scheduler take over** and check its own evidence after the first scheduled run:
   the log file you redirected to, `systemctl list-timers` on a systemd machine, `launchctl print` on
   macOS, or the cron log on a machine where cron is the scheduler.
4. **One day later, check that the second run happened.** A schedule that ran once and stopped is the
   common failure, and only the machine's own evidence shows it.

The state of the collection itself is read from the archive rather than from the log: the health read
in `src/supervision/health.js` is the one place that decides what state a repository is in, and
`docs/operations/troubleshooting.md` names the word each failure mode carries there. Reading it does
not need a schedule, a network connection or a token.

**To read that state as a written summary, run `report`.** It prints the most recent run's state word
and counts, one line per enrolled repository and the roll-up, and with `--repo owner/name` one
repository's recorded coverage, its named gap days and its change:

```
node src/cli.js report
node src/cli.js report --repo owner/name
```

It makes no request, reads no credential and creates no file, so it costs nothing to run and is safe
to redirect into the same log as the collection. It exits `0` whenever it read the archive, whatever
states it reports: a scheduled `report` is a reading, not an assertion, so it does not fail the run
because a repository needs attention. Use it as a weekly digest rather than as a monitor.

---

## Commands named on this page

| Command | What it is for |
|---------|----------------|
| `node src/cli.js collect` | collect every enrolled repository now |
| `node src/cli.js collect --dry-run` | plan the run without contacting GitHub |
| `node src/cli.js collect --repo owner/name` | collect one enrolled repository |
| `node src/cli.js config init` | create the configuration and credential templates |
| `node src/cli.js config check` | validate them without printing the token |
| `node src/cli.js setup` | ask the home the questions it needs, including the collection hour; installs no schedule |
| `node src/cli.js db status` | read the database path and the schema versions |
| `node src/cli.js db verify` | run SQLite's integrity check over the archive |
| `node src/cli.js report` | print a written summary of what the archive holds |
| `node src/cli.js report --repo owner/name` | add one repository's coverage, gap days and change |

Exit codes are the same everywhere: `0` succeeded, `1` failed operationally, `2` the command line
was wrong. `node src/cli.js --help` prints the commands this build registers.

A backup of the archive is the other half of running this for years, and it has its own runbook:
[docs/operations/backup-and-migrate.md](backup-and-migrate.md).