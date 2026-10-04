# PRD: RepoSignal

## 1. Overview

**Product Name:** RepoSignal

**Summary:** RepoSignal is a local-first command-line tool and read-only dashboard that archives one
maintainer's own GitHub repository traffic as dated evidence, past the rolling 14-day window GitHub
itself serves. A daily collection run reads each enrolled repository once, writes every observation
immutably into one local SQLite archive, and renders that archive as dates, absolute values and
named gaps. The archive is the product: it is the only place day 15 and later can exist at all.

**Target Platform:** The maintainer's own machine or home server. A Node.js CLI with two runtime
commands, plus a server-rendered dashboard bound to `127.0.0.1`. Public source under MIT, no hosted
service, no account, no signup, no telemetry.

**Key Constraints:** Clone-and-run with no build step and no runtime dependency; exactly one outbound
host (`api.github.com`) reached with `GET` only; one fine-grained read-only personal access token held
in a `0600` file; evidence stays honest, so a day GitHub did not report stays absent and a small
volume produces an explicit insufficient-data result instead of a confident one.

**Document status:** This is the canonical record of what is built. Sections 1-13 and 15 describe the
product as it exists today, each claim traceable to a named module and a named test. Section 14 is the
decomposition into `docs/features/*.md`, which own the feature-level constraints and the executable
work. Requirements that are not yet built are `kind: "requirement"` blocks and always carry a task;
everything already built is recorded as `kind: "constraint"` or `kind: "story"`.

---

## 2. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-10-04 | forge-build-prd (interactive) | Initial canonical vision authored from the repository as built |

---

## 3. Goals and Non-Goals

### 3.1 Goals

- Accumulate a continuous, day-resolution archive of the maintainer's own repositories that outlives
  GitHub's 14-day traffic window.
- Answer "is anyone actually using this work?" with dated, inspectable evidence instead of a verdict.
- Survive long unattended stretches: an idempotent collector, a visible liveness signal, and an
  explicit state word for every failure mode.
- Stay legible to one person: no account setup, no dashboard hosting, no score, no alert channel.
- Keep every claim in the documentation mechanically checkable rather than merely asserted.

### 3.2 Non-Goals

- No adoption score, composite ranking, anomaly detection, threshold alert, or generated narrative.
- No comparison or leaderboard, including one limited to the maintainer's own repositories.
- No multi-user support, hosted service, public signup, session, email, or chat alerting.
- No desktop packaging, no mobile application, no GitHub Enterprise Server support.
- No client-side JavaScript framework, interactive chart library, or bundler.
- No package-registry or container-registry download connectors, and no issue or pull-request
  collection, in this product as built.

---

## 4. Personas

| Persona | Description | Key Needs |
|---------|-------------|-----------|
| Solo maintainer | One person who owns a handful of personal GitHub repositories and works on them in spare hours | Whether the work is actually used, whether collection is still running, and evidence they can trust |
| Maintainer auditing their own tooling | The same person, months later, asking whether a discussion thread moved clones but not stars | Deep history, honest gaps, per-day provenance, a readable reading of two signals side by side |

No persona needs a second user, an organization administrator, or a shared workspace.

```forge-requirement
{"id":"RS-ST-01","kind":"story","text":"As a solo maintainer, I want my own repository traffic collected once a day into a local archive, so that the history GitHub forgets is mine to keep."}
```

```forge-requirement
{"id":"RS-ST-02","kind":"story","text":"As a maintainer auditing my own tooling later, I want every stored day labelled as collected or backfilled and the boundary marked, so that reconstructed history is never read as observed history."}
```

```forge-requirement
{"id":"RS-ST-03","kind":"story","text":"As a maintainer whose schedule stopped, I want one state word per repository and one per run, so that I can tell whether the archive is stale without reading a log."}
```

```forge-requirement
{"id":"RS-ST-04","kind":"story","text":"As a maintainer reading a small repository, I want an explicit insufficient-data answer with a named reason, so that a confident-looking chart never outruns the numbers behind it."}
```

---

## 5. Research Findings

No external research document is preserved in this repository, so the evidence base is the repository
itself, and it is unusually explicit about its own currency:

- **Vendor contracts are recorded in code, not memory.** The GitHub REST API version header, the
  endpoint shapes, the day-window limit and the rate-limit header names each have a module constant, a
  refusal rule and a test; section 6.5 lists the vendor pages those contracts were read from.
- **Currency was re-verified for this document on 2026-10-04.** Node.js 24.21.0 ("Krypton") is the
  latest LTS release; 26.10.0 is the latest release but is still Current, and 22.x is in Maintenance
  LTS. TypeScript 7.0.2 is the latest stable release and is the version this repository declares.
  Nothing in `package.json` is behind or end-of-life.
- **The honest limits of the data are load-bearing, not disclaimers.** The 14-day provenance boundary,
  undated referrers, backfilled versus collected rows, small-repository noise and sleeping-machine
  gaps each have a rendering rule in `src/insight/*` and `src/views/components/line-chart.js`.
- **One vendor change already reshaped the product.** GitHub restricted the stargazer listing to
  admins and collaborators in July 2026, so the star history is reconstructed from the weekly
  history endpoint instead, and a refusal is recorded once rather than retried forever.
- **The absence of three review artefacts is a known gap, not an oversight.** The release checklist
  names them and states that no agent authors them; section 13 carries that forward.

---

## 6. Technical Architecture

### 6.1 Technology Stack

Versions verified on 2026-10-04 against vendor release pages.

| Choice | Version | Status and reason |
|--------|---------|-------------------|
| Node.js runtime | `>=24.12.0`, so 24.12.0 or later; developed and verified against `24.21.0` | The floor is a storage requirement: the archive is opened through `node:sqlite`'s `enableDefensive`, which earlier lines do not expose. 24.21.0 is the current LTS line ("Krypton") and the second CI matrix entry |
| Module system | ESM (`"type": "module"`) | Required by `node:sqlite`; supported by every current Node release |
| Language | JavaScript with JSDoc types checked by `tsc --noEmit` | Type safety with no build step and no transpiler |
| Type checker | TypeScript 7.0.2 (dev dependency) | Latest stable; the native port, 8x-12x faster than 6.x |
| Node type definitions | `@types/node` 24.x | Tracks the supported runtime major |
| Storage | `node:sqlite` `DatabaseSync`, `STRICT` tables, WAL | Built in, no native build step, defensive mode enabled and verified at open |
| HTTP client | global `fetch` with `AbortController` timeout | Built in; no dependency |
| HTTP server | `node:http` | Built in; the dashboard is loopback-only and static |
| Terminal input | `node:readline/promises` and `node:tty` | Built in; the interactive setup surface uses no library |
| Test runner | `node:test` with `scripts/run-tests.mjs` | Built in; the wrapper fails when zero tests were selected, so a named test file cannot silently pass |
| GitHub REST API version | `X-GitHub-Api-Version: 2026-03-10` | The version the transport sends; vendor page in section 6.5 |
| Runtime dependencies | none | Required by the clone-and-go constraint; `package.json` declares no `dependencies` entry |

### 6.2 Project Structure

```
package.json                 ESM package, no runtime dependencies, scripts only
tsconfig.json                checkJs type checking, noEmit
scripts/run-tests.mjs        test wrapper that fails when zero tests were selected
scripts/backup-drill.mjs     backup/restore rehearsal against a temporary home
src/cli.js                   composition root: global flags, dispatch, exit codes
src/commands/index.js        command registry; --help and dispatch are generated from it
src/commands/                one module per registered command
src/paths.js                 home, config, credential and archive path resolution
src/config/                  closed configuration schema and comment-tolerant loader
src/credentials/             credential file loading at 0600, token redaction
src/github/                  transport allowlist, retry and rate-limit policy, endpoint clients
src/db/                      guarded connection, migration runner, repositories, backup and restore
src/collect/                 run lifecycle, traffic days, snapshot captures
src/backfill/                first-connect star and development reconstruction, provenance
src/enrollment/              pure enrollment resolution
src/supervision/             run journal, failure classification, repository and archive health
src/insight/                 deltas, stars-versus-clones divergence, change list
src/report/                  pure plain-text report formatting
src/server/                  loopback HTTP server, router, page data layer, view registry
src/server/views/            index, repository list, repository detail, health, accessibility helpers
src/views/components/        SVG line chart with its data table
src/ui/theme.css             contrast-checked design tokens served as the only stylesheet
tests/                       58 node:test files, including tests/views and tests/integration
```

### 6.3 Key Interfaces

| Interface | Contract |
|-----------|----------|
| Command registry | `registerCommand`, `listCommands`, `resolveCommand`; one or two lower-case words, a summary, a `run` function, no duplicates. `--help`, dispatch and suggestions are all derived from it |
| `createHttpTransport` | Exposes `get(endpoint)` only; re-checks the host allowlist on every request; refuses redirects; returns the body unparsed |
| `createRetryPolicy` | Maps status to a typed failure kind, retries `429`, `5xx` and statistics `202` with equal-jitter backoff, honours `Retry-After` and an exhausted primary budget |
| `openArchive` | Guarded open plus migration; fails closed when defensive mode or WAL cannot be verified |
| `collectRun` | Dry run returns a plan with `requests=0` before the journal opens; a real run writes each repository in one transaction and never throws per repository |
| `collectionHealth` | One read returning per-repository states, the run state and a roll-up word |
| `createViewRegistry` | Mount table, path table and asset table; answers its own routes in front of the router and never extends the router's route table |
| `renderLineChart` | One figure containing the SVG, its caption, a legend and a data table; refuses contradictory provenance by name |

### 6.4 Shared Constraints

These apply to every feature. Each is owned here and referenced, never restated.

```forge-requirement
{"id":"RS-C01","kind":"constraint","text":"The product ships with zero runtime dependencies and no build, bundle or transpile step: a clone is the installation, and package.json declares no dependencies entry."}
```

```forge-requirement
{"id":"RS-C02","kind":"constraint","text":"The only outbound host the product may contact is api.github.com, every request is a GET, redirects are refused rather than followed, and the host is re-checked on every request rather than at import."}
```

```forge-requirement
{"id":"RS-C03","kind":"constraint","text":"No telemetry, analytics, crash or error reporting, update check, remote font, remote image, CDN or other remote asset exists in any build path."}
```

```forge-requirement
{"id":"RS-C04","kind":"constraint","text":"A day GitHub did not report is stored as absent: never written as zero, never interpolated, never carried forward from the previous day, and never filled from another metric or repository."}
```

```forge-requirement
{"id":"RS-C05","kind":"constraint","text":"The product produces no score, ranking, verdict, anomaly claim or firing threshold; absolute values sit beside percentages and an insufficient volume is reported as insufficient."}
```

```forge-requirement
{"id":"RS-C06","kind":"constraint","text":"GitHub aggregate traffic data may not be redistributed: no command exports, publishes or shares an archive, and the dashboard offers no download of one."}
```

```forge-requirement
{"id":"RS-C07","kind":"constraint","text":"Exactly one credential is held, in credentials.json at mode 0600, read-only, never printed on any surface, redacted from every error, with no environment-variable fallback and no automatic repair of the file mode."}
```

```forge-requirement
{"id":"RS-C08","kind":"constraint","text":"All durable state lives in one home directory resolved as REPO_SIGNAL_HOME, then XDG_DATA_HOME/repo-signal, then ~/.local/share/repo-signal, created at mode 0700, and the product refuses to start when the resolved home is a git work-tree root."}
```

```forge-requirement
{"id":"RS-C09","kind":"constraint","text":"Every command returns 0 on success, 1 on operational failure and 2 on a usage error; no other exit code is produced and no stack trace is printed."}
```

```forge-requirement
{"id":"RS-C10","kind":"constraint","text":"Evidence is append-only: deletions are refused by triggers, corrections require the same key and a newer collection time, and history tables reject updates outright."}
```

```forge-requirement
{"id":"RS-C11","kind":"constraint","text":"The dashboard binds to 127.0.0.1 only, answers GET and HEAD only, sends no client-side JavaScript, and sets a default-src none content security policy with no-store caching on every response."}
```

```forge-requirement
{"id":"RS-C12","kind":"constraint","text":"Every documented claim about the product is asserted by a named test file, so a later edit to prose or code cannot silently break the agreement between them."}
```

```forge-requirement
{"id":"RS-C13","kind":"constraint","text":"A stored day is labelled collected or backfilled, the first collected day is stamped exactly once, and the chart draws the provenance boundary only where the archive supports it."}
```

```forge-requirement
{"id":"RS-C14","kind":"constraint","text":"The supported runtime is Node.js 24.12.0 or later, because the archive requires node:sqlite defensive mode; a host below the floor is reported with the running version rather than failing inside the archive."}
```

---

## 7. Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| RS-NF-01 | Collection costs five GitHub requests per repository per run, plus a one-time backfill floor of at least three, and stays under 5000 requests per repository per year | Must |
| RS-NF-02 | A dry run contacts no host, reads no credential and writes nothing | Must |
| RS-NF-03 | The collector embeds no timer; the operating system owns the schedule | Must |
| RS-NF-04 | The dashboard serves every page from the archive with no client-side script | Must |
| RS-NF-05 | `npm run typecheck` passes on the JSDoc types, and `npm test` fails when it selects zero tests | Must |
| RS-NF-06 | Continuous integration runs typecheck, tests and the backup drill on the floor and the current LTS line | Must |
| RS-NF-07 | A collection run is idempotent: a replay writes nothing and a late replay cannot overwrite a newer day | Must |
| RS-NF-08 | The archive is defensively guarded, verified on open, and closed on every failure path | Must |
| RS-NF-09 | Backup and restore round-trip through a rehearsed drill that checks per-table counts | Should |
| RS-NF-10 | A single repository failure never aborts the run; it is recorded as evidence and the run reports degraded | Must |

---

## 8. Security and Privacy

| ID | Requirement | Priority |
|----|-------------|----------|
| RS-SEC-01 | One fine-grained personal access token scoped to the enrolled repositories, with `Administration repository permission (read)` as the permission that matters | Must |
| RS-SEC-02 | `Contents` is never requested and no write call exists; the token performs reads only | Must |
| RS-SEC-03 | The credential file is refused at any mode other than 0600, naming the observed mode | Must |
| RS-SEC-04 | Token-shaped values and bearer headers are redacted from every error surface, so a cron log is safe to keep | Must |
| RS-SEC-05 | The dashboard is unauthenticated and therefore loopback-only; non-loopback peers are refused and non-loopback sockets destroyed | Must |
| RS-SEC-06 | The token sits behind a credential interface so a different credential can replace it without changing the collector | Should |
| RS-PRIV-01 | Nothing leaves the machine except the read requests collection needs, and those go to one host | Must |
| RS-PRIV-02 | The archive is local, private and never redistributed; a backup is a copy, not a publication | Must |

The mechanism behind each of these is named in `docs/operations/privacy.md`, which maps every claim to
the file that enforces it. Transport enforcement is `src/github/http.js`; credential enforcement is
`src/credentials/store.js`; dashboard enforcement is `src/server/security.js`.

---

## 9. Accessibility

| ID | Requirement | Priority |
|----|-------------|----------|
| RS-A11Y-01 | Contrast-checked design tokens meet WCAG 2.1 AA: 4.5:1 for text, 3:1 for non-text | Must |
| RS-A11Y-02 | Every page opens with a skip link to the main landmark and exactly one main element | Must |
| RS-A11Y-03 | Every chart ships with a data table, a caption and a legend; no reading depends on colour | Must |
| RS-A11Y-04 | Heading levels do not skip, and every state is announced as a word as well as a class | Must |
| RS-A11Y-05 | No motion: the stylesheet contains no transition, animation, keyframes or remote import | Must |
| RS-A11Y-06 | The interactive terminal surface is fully operable from the keyboard and readable without colour | Must |

Accessibility is verified by `tests/views/a11y.test.js`, `tests/contrast.test.js` and
`tests/legibility-spike.test.js`. RS-A11Y-06 is the target the setup terminal interface must meet.

---

## 10. System States / Lifecycle

**Collection run:** `never-run` before the first row, `unclosed` while a run has no closing row,
`completed` when every repository ended in a recorded outcome, `degraded` when any repository failed
or became unavailable.

**Repository:** `healthy`, `never-collected`, `degraded`, `needs-re-authentication`, `stalled`,
`unavailable`, `unreadable`. Precedence when several apply is unavailable, then
needs-re-authentication, then unreadable, then stalled, then degraded, then never-collected, then
healthy. `needs-re-authentication` is reserved for an authentication rejection and a missing
permission, and names the permission rather than showing an empty chart.

**Stall rule:** a repository is `stalled` when its last recorded success is more than 26 hours old.
`never-collected` is not `stalled`: a repository that has never succeeded has no date to be late
against.

**Archive roll-up:** `empty` when nothing is enrolled; otherwise the highest-precedence non-zero
repository state. A roll-up needs attention for every state other than healthy, never-collected and
empty.

**Lifecycle of one day:** GitHub reports it, or GitHub does not. Reported days become rows labelled
with their source; unreported days remain absent. The first connect additionally stamps the boundary
day once, and later runs cannot move it.

---

## 11. Analytics / Success Metrics

The product measures nothing about its user, so success is read from the maintainer's own archive and
from the repository's own pipeline. There is no product-side analytics surface.

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Collected coverage | Every enrolled repository accumulates a stored day on every day the machine was awake | `report --repo` coverage lines name the recorded boundary and the gap days |
| Gap rate | Gaps are explained, never silently repaired | `report` names up to ten gap days per series; the dashboard repeats the count and says the days are unmeasured |
| Request budget | Five requests per repository per run, so under 5000 requests per repository per year | `collect --dry-run` prints the plan; `collect` prints the counted requests |
| Run liveness | No run stays unclosed, and a stalled repository is visible within 26 hours | `/health` and `collectionHealth` state words |
| Honest readings | Every below-threshold reading reports `insufficient` with a named reason | Insight modules return a discriminated union; the dashboard renders the reason |
| Documentation integrity | Every README, runbook and PRD claim under test stays true | `npm test`, including the contract suites that read the documents |
| Restore confidence | A backup restores and verifies without hand-editing | `node scripts/backup-drill.mjs` in CI |

---

## 12. Dependencies and Risks

### 12.1 Dependencies

- **GitHub REST API on `api.github.com`**, version header `2026-03-10`: repository identity, traffic
  clones and views, popular referrers and paths, stargazer history, participation and commit activity.
- **The traffic endpoints require `Administration repository permission (read)`** on a fine-grained
  token; a refusal persists until the permission is granted.
- **Star history requires no permission** and is the reason the same token still yields backfill
  after the stargazer listing was restricted.
- **The statistics endpoints can answer `202`** while their cache compiles, which is retried rather
  than stored as absent.
- **Node.js and `node:sqlite`**, including defensive mode, WAL and `STRICT` tables.
- **An operating-system scheduler** (cron, launchd or systemd) and a machine that is awake once a day.
- **POSIX file modes**, which is why the credential mode check is skipped on `win32` and why the home
  inventory is a POSIX statement.

### 12.2 Risks

| Risk | Effect | Mitigation as built |
|------|--------|---------------------|
| GitHub changes or withdraws a traffic endpoint | Traffic series stop filling; backfill may still work | Per-endpoint typed failure kinds, a recorded refusal that is never retried, and traffic that continues when star history is refused |
| GitHub restricts another endpoint | A series stops without warning | `stars-history absent` is printed on every collection line, so an absence is never read as a zero |
| Rate limiting | A run degrades or waits | Primary-budget and secondary-floor pacing, counted retries, and `rate-limited` as its own state |
| A sleeping machine | Real gaps, one per day missed | The gap is the finding: it is named, never repaired, and the run shows `unclosed` or `stalled` |
| A token without the traffic permission | Empty charts that look quiet | `needs-re-authentication` names the permission and the next command |
| Two collectors over one archive file | Days overwrite each other | The backup runbook states it plainly; the dashboard is read-only |
| `db restore` on a mistyped path | An empty archive that looks restored | The source is integrity-checked before anything is replaced, and the restore is re-verified |
| Archive growth over years | Disk pressure | Append-only storage with no pruning command, which is a deliberate omission rather than an oversight |
| No legal review of the redistribution position | An unresolved posture question | Stated conservatively in its own README section and carried to the open-source posture review |

---

## 13. Future Considerations

- **Setup terminal interface (authored as feature 11).** A `setup` command that configures RepoSignal
  interactively, so the six-command first run becomes one guided flow and configuration can be
  changed later without editing JSON.
- **Three human gates are named by the release checklist and are not recorded:** the live GitHub
  integration review, the unattended collection soak and the open-source posture review. No agent
  authors any of them. Only the posture review is authored here; the other two stay named in
  `docs/operations/release-checklist.md` until a human records them.
- **Signals not collected today:** package-registry and container-registry downloads, issue and
  pull-request activity, and watcher or fork growth as dated series. Each would need the same
  honesty rules before it earned a place.
- **A future migration** whenever the schema changes; the migration runner already refuses an applied
  migration that has gone missing from code.
- **A raised runtime floor** when Node.js 24 leaves LTS, keeping the same `enableDefensive` reason.

---

## 14. Features

| # | Feature | File | Dependencies | Priority |
|---|---------|------|-------------|----------|
| 1 | Foundation and Runtime | [features/foundation-and-runtime.md](features/foundation-and-runtime.md) | None | Must |
| 2 | GitHub API Client | [features/github-api-client.md](features/github-api-client.md) | Foundation and Runtime | Must |
| 3 | Archive Storage | [features/archive-storage.md](features/archive-storage.md) | Foundation and Runtime | Must |
| 4 | Enrollment and Collection | [features/enrollment-and-collection.md](features/enrollment-and-collection.md) | Foundation and Runtime, GitHub API Client, Archive Storage | Must |
| 5 | First-Connect Backfill | [features/first-connect-backfill.md](features/first-connect-backfill.md) | GitHub API Client, Archive Storage, Enrollment and Collection | Must |
| 6 | Collection Supervision and Report | [features/supervision-and-report.md](features/supervision-and-report.md) | Archive Storage, Enrollment and Collection | Must |
| 7 | Chart and Insight | [features/chart-and-insight.md](features/chart-and-insight.md) | Archive Storage | Must |
| 8 | Dashboard Server | [features/dashboard-server.md](features/dashboard-server.md) | Foundation and Runtime, Archive Storage, Collection Supervision and Report | Must |
| 9 | Dashboard Views | [features/dashboard-views.md](features/dashboard-views.md) | Dashboard Server, Chart and Insight, Archive Storage | Must |
| 10 | Operations and Posture | [features/operations-and-posture.md](features/operations-and-posture.md) | Foundation and Runtime, Archive Storage, Dashboard Views | Must |
| 11 | Setup Terminal UI | [features/setup-terminal-ui.md](features/setup-terminal-ui.md) | Foundation and Runtime, Enrollment and Collection, Collection Supervision and Report | Should |

### Feature Dependency Graph

```
Foundation and Runtime
├── GitHub API Client
├── Archive Storage
│   ├── Enrollment and Collection (also needs the client)
│   │   ├── First-Connect Backfill
│   │   └── Collection Supervision and Report
│   │       └── Dashboard Server (also needs the runtime)
│   │           └── Dashboard Views (also needs Chart and Insight)
│   └── Chart and Insight
└── Setup Terminal UI (also needs collection and supervision)
```

Every feature file owns the executable tasks of its own area. A dependency here means every task of
the dependency precedes every task of the dependent feature, so the setup interface follows the
runtime contract rather than racing it.

### Canonical Definition Index

Ownership is stated once. Traceability tables list these IDs and links, never their prose.

| ID | Kind | Owner |
|----|------|-------|
| RS-ST-01, RS-ST-02, RS-ST-03, RS-ST-04 | story | [this document](#4-personas) |
| RS-C01 to RS-C14 | constraint | [this document](#64-shared-constraints) |
| RS-NF-01 to RS-NF-10 | requirement-free summary row | [this document](#7-non-functional-requirements) |
| RS-SEC-01 to RS-SEC-06, RS-PRIV-01, RS-PRIV-02 | requirement-free summary row | [this document](#8-security-and-privacy) |
| RS-A11Y-01 to RS-A11Y-06 | requirement-free summary row | [this document](#9-accessibility) |
| RS-FND-* | constraint and story | [features/foundation-and-runtime.md](features/foundation-and-runtime.md) |
| RS-GHC-* | constraint and story | [features/github-api-client.md](features/github-api-client.md) |
| RS-STO-* | constraint and story | [features/archive-storage.md](features/archive-storage.md) |
| RS-COL-* | constraint and story | [features/enrollment-and-collection.md](features/enrollment-and-collection.md) |
| RS-BKL-* | constraint and story | [features/first-connect-backfill.md](features/first-connect-backfill.md) |
| RS-SUP-* | constraint, story and requirement | [features/supervision-and-report.md](features/supervision-and-report.md) |
| RS-INS-* | constraint and story | [features/chart-and-insight.md](features/chart-and-insight.md) |
| RS-SRV-* | constraint and story | [features/dashboard-server.md](features/dashboard-server.md) |
| RS-VWS-* | constraint and story | [features/dashboard-views.md](features/dashboard-views.md) |
| RS-OPS-* | constraint, story and requirement | [features/operations-and-posture.md](features/operations-and-posture.md) |
| RS-TUI-* | requirement, constraint and story | [features/setup-terminal-ui.md](features/setup-terminal-ui.md) |

### 6.5 External Contract Sources

Each external contract below was read from the vendor page named, and the module that depends on it
is shown so a later edit can re-verify one file rather than the whole product.

| Contract | Vendor page | Enforced in |
|----------|-------------|-------------|
| REST API version header and support window | https://docs.github.com/rest/overview/api-versions | `src/github/http.js` |
| Repository identity, stars, forks, watchers | https://docs.github.com/rest/repos/repos | `src/github/repo-client.js` |
| Traffic clones, views, popular referrers, popular paths | https://docs.github.com/rest/repos/traffic | `src/github/traffic-client.js` |
| Weekly stargazer history and its pagination cap | https://docs.github.com/rest/activity/starring | `src/github/stars-client.js` |
| Participation and commit activity, including `202` | https://docs.github.com/rest/metrics/activity | `src/github/stats-client.js` |
| Rate-limit headers and `Retry-After` | https://docs.github.com/rest/using-the-rest-api/rate-limits | `src/github/rate-limit.js` |
| Stargazer listing restriction | GitHub changelog entry dated 2026-06-30, cited from `src/github/retry.js` | `src/github/retry.js` |
| `node:sqlite`, defensive mode, WAL, `STRICT` | https://nodejs.org/api/sqlite.html | `src/db/connection.js` |
| Release schedule and LTS status | https://nodejs.org/en/about/previous-releases | `package.json` engines |

---

## 15. Glossary

| Term | Definition |
|------|------------|
| Archive | `archive.sqlite3` inside the home directory: day series, snapshots, run journal, health evidence |
| Backfill | A row reconstructed from an endpoint that carries history rather than read from a collection run |
| Collected | A row read from a traffic endpoint during a collection run |
| Boundary, provenance boundary | The first day RepoSignal collected itself, stamped once |
| Day series | One metric, one granularity, one day, one value, one source label |
| Deny list | Repository names that win over enrollment in either declaration order |
| Enrollment | The set of `owner/name` entries the maintainer chose to collect |
| Gap | A day inside a window with no stored value; unmeasured, not zero |
| Home | The single directory holding `config.json`, `credentials.json` and the archive, at mode 0700 |
| Insufficient | A reading below its data threshold, returned with a named reason instead of a number |
| Provenance | Whether a stored day was collected or backfilled, and where collection began |
| Snapshot capture | A referrer or popular path recorded at a collection time, with no day dimension |
| State word | A closed vocabulary describing a repository, a run or the archive, such as `stalled` |
| Transport | The single outbound path to GitHub, with its host allowlist, timeout and redirect refusal |

---

## 16. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | The README's inventory of non-runtime commands omits `report`, although the install sequence and every runbook use it | Treat it as a documentation defect; the command registry is the authority and the fix belongs to the runtime contract task |
| 2 | `discover` and `report` print a pointer to `--help` that those two commands reject, since only `serve` honours a post-name `--help` | Repair the pointers during the runtime contract task rather than changing global flag parsing |
| 3 | Two environment variables exist in code but appear in no document: the GitHub base URL override and the loopback transport gate | Name both in the privacy note during the client contract task, including that the gate is for tests |
| 4 | The home inventory lists three files, while WAL adds two side files beside the archive | Document the side files in the README and the backup runbook during the storage contract task |
| 5 | Two human gates named by the release checklist, the live integration and the unattended soak, are not authored as tasks here | They stay named in the release checklist and are recorded only by a human; authoring them is a separate decision |
| 6 | Whether the interactive setup surface belongs in the command registry as `setup` or under `config` | `setup`, because it also runs collection and reports the dashboard address |
| 7 | When to raise the runtime floor to Node.js 26 | Keep `>=24.12.0` while 24 is an LTS line, then raise with the same `enableDefensive` reason recorded |
| 8 | Whether the redistribution statement will ever get legal sign-off | The conservative reading stands: keep the archive local, and let the posture review record the decision |
| 9 | Whether `report` belongs in the two-runtime-command framing of the README | It is a runtime command that reads the archive; the README framing should say three, or move it to maintenance |
| 10 | When the archive schema earns migration 003 | Only when a change cannot be expressed by the existing tables and triggers; version 2 is current |