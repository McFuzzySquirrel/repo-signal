# RepoSignal

A local-first command-line tool and read-only dashboard that keeps your own GitHub repository
traffic as dated evidence, past the point where GitHub stops serving it.

GitHub reports clone and view traffic for a rolling 14-day window and then forgets it. RepoSignal
collects the repositories you enrolled, once a day, writes every observation into one local SQLite
archive, and leaves the gaps as gaps. The archive is the product: it is the only place day 15 and
later can exist at all.

- **No build step.** Clone it and run `node src/cli.js`. There is no bundler, no transpiler, no
  build script and no runtime dependency.
- **No hosted service, no account, no signup.** Everything durable lives in one home directory on
  your own machine.
- **No telemetry of any kind.** Nothing leaves your machine except the read requests collection
  needs, and those go to one host: `api.github.com`. See [the privacy note](docs/operations/privacy.md).
- **No score.** There is no adoption score, no ranking, no verdict, no alert and no leaderboard.
  There are numbers with dates, and the gaps between them.

---

## What a clone is not

**A clone is not adoption.** GitHub counts clones and unique cloners for your repository. It does
not tell you who ran your code, in production or at all: someone can clone a repository to read one
file, to look at it, or by accident. RepoSignal shows the counter GitHub reports and never calls it
adoption, because that is a claim the data cannot carry.

Three more things this tool deliberately does not do:

- **It fabricates no history.** A day GitHub did not report is stored as absent and stays absent. It
  is never written as `0`, never interpolated between its neighbours, never carried forward from the
  day before, and never filled in from another metric or another repository.
- **It decides nothing.** There is no adoption score, no composite ranking, no anomaly claim and no
  threshold that fires. Absolute values are shown beside percentages, and where the volume is too small to say
  anything the product reports the data as insufficient rather than drawing a line through it.
- **It compares no repository to another person's.** The archive holds the repositories you
  enrolled, and nothing else.

---

## The honest limits of the archive

Read this before you trust a chart; it is the difference between evidence and a story.

1. **History from before you connected does not exist, and is not small.** The traffic endpoints
   return 14 days and no more. On the day you connect you get those 14 days; day 15 onward is what
   RepoSignal collected itself. Days before that provenance boundary are not zeros and not quiet
   weeks - they are not observations at all.
2. **Backfilled days are not collected days.** On first connect, RepoSignal reconstructs a star
   history and a year of weekly development activity from endpoints that carry history. Those rows
   are stored as `backfill`; rows a later run reads from the traffic endpoints are stored as
   `collected`. Every series states which is which, and where the collected history begins.
3. **A unique cloner is not a person you can count.** Clones, unique cloners, views and unique
   visitors are GitHub's own counters, kept exactly as GitHub reported them. The tool does not
   extrapolate from them.
4. **Referrers and popular paths have no dates.** GitHub serves a top-ten list for each and no day
   dimension, so the archive stores them as timestamped snapshots and never claims to know when a
   referrer first appeared.
5. **Small repositories are mostly noise.** Three clones can move a percentage by a hundred points.
   That is why absolute values sit beside percentages and why a small volume produces an explicit
   insufficient-data result instead of a confident one.
6. **The archive records what was collected, not what was missed.** A day lost to a sleeping laptop
   is a gap, and the run journal records what the collector was doing when it could not run. It does
   not reconstruct the day, and you should not repair a gap by hand: the gap is the finding.
7. **Nothing here is an audit.** This project publishes no compliance claim, no certification and no
   third-party assessment. What you can check is in the repository: every command this page names is
   resolved against the command registry by a test, and every statement above has a test of its own.

---

## Requirements

- **Node.js 24.12.0 or later.** `package.json` declares the supported range as
  `"engines": { "node": ">=24.12.0" }`, and the 24.21.0 Active LTS line is what this project is
  developed and recommended against. The floor is a storage requirement, not a preference: the
  archive is opened through `node:sqlite`'s `enableDefensive`, which earlier release lines do not
  expose. A host below the floor imports the module and then fails inside the archive code, which
  reads like a product fault; check `node -v` before investigating anything else.
- **One fine-grained personal access token.** See [The token](#the-token) below.
- **A machine that is awake once a day.** The collector embeds no timer, so the operating system
  runs the schedule; see
  [docs/operations/scheduled-collection.md](docs/operations/scheduled-collection.md).

---

## Install and run: clone and go

There is no install step. The runtime is ESM JavaScript with JSDoc types and zero dependencies, so
a clone is the installation:

```
git clone <the URL of this repository>
cd repo-signal
node src/cli.js --help
```

`--help` prints the commands your build registers, generated from the command registry rather than
from this page. Nothing in this repository compiles before it runs: `package.json` declares no
`dependencies` entry at all. Its two `devDependencies` (the TypeScript checker and the Node type
definitions) exist only so `npm run typecheck` can check the JSDoc types, and running the tool does
not need them.

The five steps to a working archive:

```
node src/cli.js config init
node src/cli.js config check
node src/cli.js discover
node src/cli.js collect --dry-run
node src/cli.js collect
```

1. **`config init`** writes two `0600` templates into the home: `config.json` and
   `credentials.json`. It prints the paths it wrote. Use `--force` to replace both templates
   deliberately.
2. **`config check`** validates the configuration against the schema and validates that the
   credential file is a regular file with mode `0600` and a non-empty token. It prints no token and
   does not contact GitHub.
3. **`discover`** lists the repositories your token can reach and prints a configuration block you
   can paste into `config.json` to enrol the ones you want. It prints permission state, never the
   token and never its scopes.
4. **`collect --dry-run`** plans the run and prints what it would collect without contacting
   GitHub: no credential read, no socket, no write, `requests=0`.
5. **`collect`** does the collection: one request per repository for identity, four for the traffic
   endpoints, and a first-connect backfill the first time a repository is collected. It prints one
   line per repository and a `summary` line, and exits `0` when every repository succeeded.

Editing the templates: `config.json` takes `enrolled` (the repositories you chose, as `owner/name`),
an optional `denyList` that wins over enrollment, an optional `collectionHourUtc` recording the UTC
hour you intend to collect in, and an optional per-repository `enabled` map. The `config init`
template carries whole-line `//` comments, and every command that reads `config.json` accepts them
- `config check` included - so leave them in place or delete them as you prefer. An inline `//`
after a value and a trailing comma are refused everywhere. Leave the credential template's
placeholder token in place until you have a real one - local validation is not authentication, and
the placeholder is deliberately not a GitHub token.

---

## The token

RepoSignal needs exactly one credential, and it is used for reads only.

- **A fine-grained personal access token**, scoped to the repositories you enrolled. It is the only
  secret this tool holds.
- **The one permission that matters is `Administration repository permission (read)`**, because the
  traffic endpoints require it. It is scoped per repository, so the token cannot read anything else
  of yours. `Contents` is not required and is never requested; if a tool asks you for write access,
  the answer is no.
- **Star history comes from an endpoint no permission controls.** The first-connect backfill reads the
  repository's weekly star history, not its stargazer listing: GitHub limited that listing to admins
  and collaborators in July 2026, and a token that reads everything else can still be refused it. The
  history endpoint was not included, so the backfill works with the same token as everything else -
  and it needs no special scope. If GitHub ever refuses the history too, the tool records that, says
  so on every collection line (`stars-history absent ...`) rather than leaving a gap to be read as a
  zero, and collects traffic as normal.
- **It lives in `credentials.json` in the home directory with mode `0600`, exactly.** The tool
  refuses to read the file at any other mode - `0644` and `0666` are both refused with the mode it
  observed named in the message - and it never repairs the mode for you.
- **It is never printed.** It does not appear in standard output, in an error message, in an
  exception, in a log line, in a database row, in a rendered page or in a process listing. Token-
  shaped values are redacted from every error surface, so a cron log is safe to keep.
- **It performs no write.** Every request is a `GET`. The tool never writes to a repository and
  never creates an issue, pull request, comment, release or star. Repositories GitHub no longer
  serves are recorded as unavailable rather than deleted.

If GitHub answers `401` or `403`, the product reports a re-authentication state naming the missing
permission rather than an empty chart; `docs/operations/troubleshooting.md` maps each cause to the
state word and the next command.

---

## The two runtime commands

| Command | What it does |
|---------|--------------|
| `node src/cli.js collect` | Reads every enrolled repository once and writes the observations into the archive. It runs once and exits; it embeds no timer and no scheduler. |
| `node src/cli.js serve` | Starts the read-only dashboard on `127.0.0.1`, serving the archive as server-rendered HTML with no client-side JavaScript. |

Everything else in the registry is setup or maintenance: `config init`, `config check`, `discover`,
`db status`, `db verify`, `db migrate`, `db backup` and `db restore`. They are documented in the
runbooks below. `node src/cli.js --help` is the authority on which of them your build registers; a
build whose registry does not include `serve` has the collector without the dashboard, and every
other instruction on this page still applies.

Exit codes are the same for every command: `0` succeeded, `1` failed operationally, `2` the command
line was a usage error.

---

## Where everything lives

All durable state is in one home directory, resolved in this order:

1. `REPO_SIGNAL_HOME`, when it is set to a non-blank value
2. `XDG_DATA_HOME/repo-signal`
3. `~/.local/share/repo-signal`

The home is created with mode `0700` and holds three files:

| File | What it is |
|------|------------|
| `config.json` | the repositories you enrolled, the optional deny list, the UTC collection hour and per-repository flags |
| `credentials.json` | your token, read only at mode `0600` |
| `archive.sqlite3` | the archive: every day-series fact, every snapshot capture, the run journal and the collection health evidence |

**The archive lives at `archive.sqlite3` inside that home directory** and nowhere else - no state
path outside the home exists, and the tool refuses to start when the resolved home is a git
repository root, so a credential and an archive cannot be committed into a work tree by accident.
`node src/cli.js db status` prints the resolved database path beside both schema versions.

Nothing else is written outside your checkout: there is no cache directory, no log directory, no
configuration in your shell profile and no file in the operating system's application directory.

---

## This archive may not be redistributed

**GitHub's repository traffic data is GitHub's aggregate data. This archive may not be
redistributed.**

That sentence is the project's own position on its own data, and it is stated here rather than in
a footnote because the archive is derived entirely from GitHub's aggregate counters. It means:

- **Do not publish an archive file.** Not as a release asset, not in a gist, not in a repository,
  not in a package, and not as a download from the dashboard.
- **Do not build a public comparison or leaderboard out of it**, including one that only shows your
  own repositories, because the numbers in it are GitHub's aggregate figures rather than yours to
  circulate.
- **RepoSignal itself performs no export, publish or share action.** There is no command that
  uploads, sends, shares or posts anything, and there is no hosted copy of your archive.
- **A backup is not a publication.** A copy you keep for yourself, in the same private posture as
  the home it came from, is a copy rather than a redistribution. Where to keep copies is in
  [docs/operations/backup-and-migrate.md](docs/operations/backup-and-migrate.md).

This is a statement of position, not legal advice, and nobody has yet signed it off: the review
artefact that confirms the licence, this data statement, the token description and the privacy note
is `docs/reviews/open-source-posture.json`, and this repository does not contain it yet. Treat the
conservative reading - keep it local - as the operative one.

---

## No telemetry, and no analytics

RepoSignal has **no telemetry**, no usage analytics, no crash reporting, no error reporting service,
no update check, no remote font, no remote image, no CDN and no remote asset of any kind. The only
outbound host the product is permitted to contact is `api.github.com`, enforced in code by the
transport's allowlist rather than by convention. Nothing is measured about you, because there is
nothing in this repository that could send it anywhere.

[docs/operations/privacy.md](docs/operations/privacy.md) is the longer version: what leaves your
machine, what is stored, what is never collected, and where each of those claims is enforced in the
source.

---

## Documentation

| Page | Read it when |
|------|--------------|
| [docs/operations/scheduled-collection.md](docs/operations/scheduled-collection.md) | you want the daily run to happen without you: a cron, launchd or systemd entry, the request budget, what a sleeping machine does, and how to catch up |
| [docs/operations/troubleshooting.md](docs/operations/troubleshooting.md) | collection stopped: six failure modes, each with the state word the product reports and the next command to run |
| [docs/operations/backup-and-migrate.md](docs/operations/backup-and-migrate.md) | you want the archive to survive a disk: where copies belong, how to restore one, how to move an archive to another machine |
| [docs/operations/privacy.md](docs/operations/privacy.md) | you want to know exactly what is stored, what leaves your machine, and what is never collected |
| [docs/PRD.md](docs/PRD.md) | you want the product's decisions and their reasons, including the vendor pages each external contract was read from |

---

## Licence

MIT. See [LICENSE](LICENSE) for the full text.

The licence covers the software in this repository. It grants no right in the data the archive holds,
which is why the redistribution statement above is stated separately and in its own section.
