# PRD: RepoSignal

## 1. Overview

**Product Name:** RepoSignal

**Summary:** RepoSignal is a local-first command-line tool and read-only web dashboard for a
single open-source maintainer. It polls the maintainer's own GitHub repositories once a day,
persists every observation immutably in a local SQLite archive, and renders that archive as
dated evidence. GitHub exposes clone and view traffic for a rolling 14-day window only; the
archive is the product, because it is the only place day 15 and later can exist. The tool
never claims a clone proves production use and never collapses signals into a popularity score.

**Target Platform:** A maintainer's own machine or home server. Node.js CLI with two runtime
subcommands, plus a server-rendered dashboard bound to `127.0.0.1`. Public source, MIT license,
no hosted service, no accounts, no telemetry.

**Key Constraints:**

- One fine-grained personal access token per install, held in a `0600` file, used for reads only.
- The traffic endpoints require `Administration` repository permission (read) for a fine-grained
  token, so a `403` persists until that permission is granted and the install accepts the upgrade.
- Outbound network access is limited to `api.github.com`.
- No bundler, no build step, no client-side framework, no chart library.
- The evidence must stay honest: gaps render as gaps, and no day is ever invented or carried forward.

**Historical Sources:** [IDEA.md](../IDEA.md) and
[docs/IDEA.md](IDEA.md) (grilled product idea, 2026-09-29),
[docs/research/repo-signal-research.txt](research/repo-signal-research.txt) (opening analysis).
Both are preserved inputs, not execution sources.

---

## 2. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-09-29 | forge-build-prd (headless) | Initial vision authored from the preserved idea and research notes |

---

## 3. Goals and Non-Goals

### 3.1 Goals

- Accumulate a continuous, day-resolution archive of a maintainer's own repositories that outlives
  GitHub's 14-day traffic window.
- Answer "is anyone actually using this work?" with dated, inspectable evidence rather than a verdict.
- Survive 90 unattended days: an idempotent collector, visible liveness, and explicit failure states.
- Stay legible to one person: no account setup, no dashboard-hosting, no score.

### 3.2 Non-Goals

- No adoption score, composite ranking, anomaly detection, threshold alerts, or generated narrative.
- No package-registry or container-registry connectors in v1.
- No multi-user support, no hosted service, no public signup, no sessions, no email or chat alerting.
- No comparison or leaderboard across other people's repositories.
- No mobile application, no desktop shell, no GitHub Enterprise Server support.
- No client-side JavaScript framework or interactive chart library.

---

## 4. Personas

| Persona | Description | Key Needs |
|---------|-------------|-----------|
| Solo maintainer | One person who owns a handful of personal GitHub repositories and works on them in spare hours | Whether the work is actually used, whether collection is still running, and evidence they can trust |
| Maintainer auditing their own tooling | The same person, six months later, asking "did that Reddit thread move clones but not stars?" | Deep history, honest gaps, per-day provenance |

No persona requires a second user, an organization administrator, or a shared workspace.

---

## 5. Research Findings

The opening analysis established the shape of the problem and is preserved unchanged in
`docs/research/repo-signal-research.txt`. Findings carried into this vision:

- GitHub repository traffic endpoints require write access to the repository and return a rolling
  14-day window; the response is "full clones", not fetches.
- A clone is materially different from a star or fork, but it still does not prove production use.
  The product must present it as evidence, not as an adoption verdict.
- Aggregating many signals into one popularity score is explicitly the wrong shape; a maintainer
  wants to see the individual signals and the momentum of each one.
- The two ideas the idea document rejected from the research draft are retained as non-goals:
  a coloured "adoption signals" verdict list, and a hosted multi-tenant connect flow.

---

## 6. Technical Architecture

### 6.1 Technology Stack

| Choice | Version | Status and reason |
|--------|---------|-------------------|
| Node.js | 22.13.0 or later; 24.21.0 (Active LTS "Krypton") recommended | `node:sqlite` lost its `--experimental-sqlite` flag in 22.13.0, so that is the hard floor; 24 is the supported line and the CI target |
| Module system | ESM (`"type": "module"`) | Required by `node:sqlite`, supported by every current Node release |
| Language | JavaScript with JSDoc types, `checkJs` | The idea requires a TypeScript project with no build step; JSDoc plus `tsc --noEmit` gives both |
| Type checker | TypeScript 7.0.2 (dev dependency) | Current stable; see Open Questions for the 6.0.3 fallback |
| Node type definitions | `@types/node` 24.x | Tracks the required runtime major |
| Storage | `node:sqlite` (`DatabaseSync`) | Built in, no native build step, release-candidate stability since Node 24.15.0 |
| HTTP client | global `fetch` with `AbortSignal` | Built in; no dependency |
| HTTP server | `node:http` | Built in; the dashboard is loopback-only and static |
| Test runner | `node:test` with a repository wrapper that fails on zero selected tests | Built in; guarantees a task's named test file really ran |
| GitHub REST API version | `X-GitHub-Api-Version: 2026-03-10` | Current supported version; `2022-11-28` remains supported until 2028-03-10 |
| Runtime dependencies | none | Required by the "git clone and run" constraint |

### 6.2 Project Structure

```
package.json                 ESM package, no runtime dependencies, scripts only
tsconfig.json                checkJs type checking, noEmit
scripts/run-tests.mjs        test wrapper that fails when zero tests were selected
src/cli.js                   composition root: argument parsing and command dispatch
src/commands/                one module per subcommand, registered in src/commands/index.js
src/paths.js                 home directory, config, credential and database path resolution
src/config/                  configuration schema, parsing and validation
src/credentials/             credential file loading, permission checks, redaction
src/github/                  transport, retry and rate-limit policy, endpoint clients
src/db/                      connection, migration runner, migrations, repositories
src/enrollment/              enrolled repository resolution
src/backfill/                first-connect backfill and provenance bookkeeping
src/collect/                 collection planning, traffic, snapshots, lifecycle, run orchestration
src/supervision/             failure classification, run journal, health surface
src/server/                  loopback HTTP server, router, data access, views
src/views/components/        pure rendering helpers, including the hand-rolled SVG chart
src/insight/                 deltas, divergence, change list
src/ui/theme.css             design tokens for the server-rendered pages
tests/                       unit and integration tests, mirrors the source layout
spikes/                      throwaway design artifacts kept as decision evidence
docs/operations/             runbooks, troubleshooting, release checklist
docs/reviews/                human review evidence files
```

### 6.3 Key APIs / Interfaces

| Interface | Contract |
|-----------|----------|
| `CredentialProvider` | `getToken(): Promise<string>`; the collector never learns where the token came from |
| `GitHubClient` | `request(method, path, {accept, query, allowRetries})`; enforces host allowlist, sends `Accept`, `Authorization`, `X-GitHub-Api-Version`, `User-Agent` |
| Traffic clients | `clones(repo, per)`, `views(repo, per)`, `referrers(repo)`, `popularPaths(repo)` returning normalized records with a UTC date |
| Statistics clients | `participation(repo)`, `commitActivity(repo)`, `stargazerStars(repo, onPage)`; `202 Accepted` surfaces as a retryable outcome, not an error |
| `Database` | `migrate()`, repositories for day series, snapshots, repository state, runs, errors and heartbeat |
| `collectRun(options)` | resolves enrollment, plans per-repository work, executes it, reports a run summary |
| `healthForHome(home)` | per-repository collection status for the dashboard and the CLI |
| `createServer(options)` | loopback HTTP server returning `{ url, close }`; the `serve` command is its only caller |
| View modules | `render(ctx): string` returning escaped HTML; registered in `src/server/views/index.js`, the view composition root |
| Chart and insight helpers | pure functions over observation arrays: no I/O, no clock, no globals |

### 6.4 External API Sources

Every external contract this product depends on was read from the vendor's own documentation
rather than assumed. Anything an implementer cannot verify from these pages is exercised by the
live integration check in the operations feature.

| Contract | Source |
|----------|--------|
| Traffic endpoints, 14-day window, day or week, top-ten lists | https://docs.github.com/en/rest/metrics/traffic |
| `Administration` repository permission (read) required by the traffic endpoints for a fine-grained token | https://docs.github.com/en/rest/metrics/traffic |
| Supported API versions and the `X-GitHub-Api-Version` header | https://docs.github.com/rest/overview/api-versions |
| Star timestamps through the star media type on the stargazer list | https://docs.github.com/rest/activity/starring |
| Statistics endpoints returning 202 while the cache compiles | https://docs.github.com/en/rest/metrics/statistics |
| `node:sqlite` availability, stability and defensive flag | https://nodejs.org/docs/latest-v24.x/api/sqlite.html |
| Node.js release lines and LTS status | https://nodejs.org/en/about/previous-releases |

---

## 7. Non-Functional Requirements

### 7.1 Shared Constraints

```forge-requirement
{"id":"RS-TC-01","kind":"constraint","text":"Ship as an ESM JavaScript package with JSDoc types checked by `tsc --noEmit`, with zero runtime dependencies, no bundler and no build step; the entry point is `node src/cli.js` after a clone."}
```

```forge-requirement
{"id":"RS-TC-02","kind":"constraint","text":"All durable state lives in one SQLite database accessed through `node:sqlite`, guarded by a forward-only migration runner; every fact row records the collection time that produced it and is never deleted by a product code path."}
```

```forge-requirement
{"id":"RS-TC-03","kind":"constraint","text":"All state lives under one home directory resolved from `REPO_SIGNAL_HOME`, then `XDG_DATA_HOME/repo-signal`, then `~/.local/share/repo-signal`; the directory is created with mode 0700 and the tool refuses to run when that directory is a git repository root."}
```

```forge-requirement
{"id":"RS-TC-04","kind":"constraint","text":"Every task's named validation command must be a repository-root command that exists by the end of that task; a command that proves nothing (an unconditional exit-zero script, a bare build, or an unconditional success message) is not an acceptable check."}
```

```forge-requirement
{"id":"RS-DU-01","kind":"constraint","text":"Collection is idempotent and restartable: re-running after an interruption converges on the same archive, a per-repository failure never aborts the rest of the run, and no partial run leaves a half-written fact row."}
```

```forge-requirement
{"id":"RS-DU-02","kind":"constraint","text":"A day that was never observed is rendered as a gap. It is never written as zero, never interpolated between neighbouring days, never carried forward, and never filled from another metric or another repository."}
```

```forge-requirement
{"id":"RS-HO-01","kind":"constraint","text":"The product shows evidence and states its limits. It emits no adoption score, no composite ranking, no anomaly claim, no threshold verdict, and no directional language such as increasing, surging or declining that the data does not support; a clone is described as a clone, never as adoption."}
```

```forge-requirement
{"id":"RS-SC-01","kind":"constraint","text":"Outbound requests are restricted to `api.github.com`; there is no telemetry, no analytics, no crash reporting, no update check, no font or asset download, and no request to any host introduced by a page."}
```

```forge-requirement
{"id":"RS-SC-02","kind":"constraint","text":"The access token is read only from a credential file with mode 0600, is never written to logs, stdout, error messages, exception messages, database rows, HTTP responses or process listings, and is transmitted only to `api.github.com`; a token-shaped value is redacted from any error surface."}
```

```forge-requirement
{"id":"RS-SC-03","kind":"constraint","text":"The dashboard binds to `127.0.0.1` only, cannot be re-bound through configuration, sends no cross-origin headers, sets `Cache-Control: no-store` and a restrictive content security policy, and loads no remote asset."}
```

```forge-requirement
{"id":"RS-SC-04","kind":"constraint","text":"The token is used for read operations only. The product never writes to a repository, never creates issues, pull requests, comments, releases or stars, and never mutates remote state."}
```

```forge-requirement
{"id":"RS-PR-01","kind":"constraint","text":"A dashboard page for six repositories over a 400-day range renders in under 500 ms after the database is open, and a `collect` run over six repositories completes in under 60 s excluding time spent honouring rate limits; the chart is a hand-rolled SVG with no charting dependency."}
```

### 7.2 Shared Product Requirements

```forge-requirement
{"id":"RS-VR-01","kind":"requirement","text":"RepoSignal accumulates a continuous, day-resolution archive of a maintainer's own enrolled repositories by polling GitHub on a schedule and persisting each observation immutably, so that history beyond the 14-day traffic window survives and stays queryable."}
```

```forge-requirement
{"id":"RS-VR-02","kind":"requirement","text":"Every rendered series states its provenance: a repository page shows which days were backfilled, which were collected, where the collected history begins, and that clones and views before the first collected day do not exist rather than being small."}
```

```forge-requirement
{"id":"RS-VR-03","kind":"requirement","text":"A maintainer can tell from the product alone whether collection is currently working: each enrolled repository exposes its last successful collection, its consecutive failure count, an explicit re-authentication state when the token is rejected, and a visible warning when scheduled collection has stopped."}
```

### 7.3 Shared Stories

```forge-requirement
{"id":"RS-ST-01","kind":"story","text":"As a solo maintainer I want to see whether people are actually using my repositories, not just starring them, so that I can judge whether to keep investing in the work."}
```

```forge-requirement
{"id":"RS-ST-02","kind":"story","text":"As a solo maintainer I want adoption history that outlives GitHub's 14-day window, so that questions about a past spike can be answered months later."}
```

```forge-requirement
{"id":"RS-ST-03","kind":"story","text":"As a solo maintainer I want the tool to admit what it does not know, so that I never mistake a gap or a small number for a real finding."}
```

```forge-requirement
{"id":"RS-ST-04","kind":"story","text":"As a solo maintainer I want to know that the collector is still running without reading logs, so that a silently dead archive is noticed within a day."}
```

### 7.4 Shared Definition Index

| ID | Kind | Priority | Owning document | Participating features |
|----|------|----------|-----------------|------------------------|
| RS-TC-01 | constraint | Must | This document | Foundation, Storage, GitHub API Client, Dashboard Server, Operations |
| RS-TC-02 | constraint | Must | This document | Storage, Backfill, Collection, Supervision |
| RS-TC-03 | constraint | Must | This document | Foundation, Operations |
| RS-TC-04 | constraint | Must | This document | All |
| RS-DU-01 | constraint | Must | This document | Collection, Supervision, Operations |
| RS-DU-02 | constraint | Must | This document | Storage, Collection, Chart and Insight, Dashboard Views |
| RS-HO-01 | constraint | Must | This document | Chart and Insight, Dashboard Views, Operations |
| RS-AX-01 | constraint | Must | [Section 9](#9. Accessibility) | Dashboard Views, Chart and Insight |
| RS-SP-01 | requirement | Must | This section | GitHub API Client, Repo Enrollment and Discovery |
| RS-SP-02 | requirement | Must | This section | GitHub API Client, Collection Supervision, Dashboard Views |
| RS-SP-03 | requirement | Must | This section | Foundation, Operations |
| RS-SP-04 | requirement | Must | This section | GitHub API Client, Operations |
| RS-SP-05 | requirement | Must | This section | GitHub API Client, Operations |
| RS-SP-06 | requirement | Must | This section | Local Dashboard Server |
| RS-SP-07 | requirement | Must | This section | Local Dashboard Server, Dashboard Views |
| RS-SP-08 | requirement | Must | This section | Operations and Open Source Posture |
| RS-AX-02 | requirement | Must | [Section 9](#9. Accessibility) | Dashboard Views |
| RS-AX-03 | requirement | Must | [Section 9](#9. Accessibility) | Chart and Insight, Dashboard Views |
| RS-AX-04 | requirement | Must | [Section 9](#9. Accessibility) | Chart and Insight, Dashboard Views |
| RS-AX-05 | requirement | Must | [Section 9](#9. Accessibility) | Dashboard Views |
| RS-AX-06 | requirement | Must | [Section 9](#9. Accessibility) | Dashboard Views |
| RS-AX-07 | requirement | Must | [Section 9](#9. Accessibility) | Dashboard Views |
| RS-SC-01 | constraint | Must | This document | GitHub API Client, Dashboard Views, Operations |
| RS-SC-02 | constraint | Must | This document | Foundation, GitHub API Client, Collection |
| RS-SC-03 | constraint | Must | This document | Dashboard Server, Dashboard Views |
| RS-SC-04 | constraint | Must | This document | GitHub API Client, Collection |
| RS-PR-01 | constraint | Should | This document | Dashboard Server, Chart and Insight |
| RS-VR-01 | requirement | Must | This document | Storage, Backfill, Collection |
| RS-VR-02 | requirement | Must | This document | Chart and Insight, Dashboard Views, Backfill |
| RS-VR-03 | requirement | Must | This document | Supervision, Dashboard Views |
| RS-ST-01 | story | Must | This document | Repo Enrollment, Dashboard Views |
| RS-ST-02 | story | Must | This document | Backfill, Collection |
| RS-ST-03 | story | Must | This document | Chart and Insight, Dashboard Views |
| RS-ST-04 | story | Must | This document | Supervision, Dashboard Views |

---

## 8. Security and Privacy

Threat model in one line: a local tool holding a repository-scoped token, on a maintainer's own
machine, that talks to one remote host.

```forge-requirement
{"id":"RS-SP-01","kind":"requirement","text":"The install documents and uses one fine-grained personal access token limited to the enrolled repositories, holding `Administration` repository permission (read) because the traffic endpoints require it; `Contents` is not required and is never requested."}
```

```forge-requirement
{"id":"RS-SP-02","kind":"requirement","text":"A 403 from a traffic endpoint is reported as a distinct permission state naming the missing permission, and the dashboard shows it as an action for the maintainer rather than as an empty chart or a generic error."}
```

```forge-requirement
{"id":"RS-SP-03","kind":"requirement","text":"The credential file and the database live outside any git work tree, with mode 0700 on the home directory and mode 0600 on the credential file; the tool refuses to start when the home directory is a git repository root."}
```

```forge-requirement
{"id":"RS-SP-04","kind":"requirement","text":"No outbound request is made to any host other than `api.github.com`, proven by a test over the transport allowlist and confirmed by the security review."}
```

```forge-requirement
{"id":"RS-SP-05","kind":"requirement","text":"No telemetry, analytics, crash reporting, update check, remote font or remote asset exists in the product; the outbound allowlist test is the mechanical guarantee."}
```

```forge-requirement
{"id":"RS-SP-06","kind":"requirement","text":"The dashboard is unauthenticated because it is loopback-only; a request arriving from a non-loopback address is refused rather than served, and the bind address cannot be changed through configuration."}
```

```forge-requirement
{"id":"RS-SP-07","kind":"requirement","text":"Every rendered page escapes repository names, referrer names and popular paths, so a hostile repository name cannot inject markup into the dashboard."}
```

```forge-requirement
{"id":"RS-SP-08","kind":"requirement","text":"GitHub's repository traffic data is GitHub's aggregate data. The README states plainly that this archive may not be redistributed, and the product performs no export, publish or share action."}
```

---

## 9. Accessibility

```forge-requirement
{"id":"RS-AX-01","kind":"constraint","text":"Dashboard pages meet WCAG 2.1 AA: semantic landmarks and headings, a skip link, keyboard-reachable controls, text contrast of at least 4.5:1, non-text contrast of at least 3:1, no meaning carried by colour alone, a tabular text alternative for every chart, and no motion beyond an instant state change."}
```

```forge-requirement
{"id":"RS-AX-02","kind":"requirement","text":"Every page declares its language, carries a unique title, has exactly one main landmark, offers a skip link to the main content, and uses a heading order that skips no level."}
```

```forge-requirement
{"id":"RS-AX-03","kind":"requirement","text":"Every chart is accompanied by a data table carrying the same values, reachable from the chart, so no information exists only inside a picture."}
```

```forge-requirement
{"id":"RS-AX-04","kind":"requirement","text":"A gap in a series is stated as a gap in the text alternative rather than omitted, because an omitted day reads as a zero day to a screen reader user."}
```

```forge-requirement
{"id":"RS-AX-05","kind":"requirement","text":"Colour tokens are defined once in `src/ui/theme.css` and their contrast ratios are asserted by a unit test, so a colour change cannot silently break the AA threshold."}
```

```forge-requirement
{"id":"RS-AX-06","kind":"requirement","text":"Interactive controls are reachable and operable by keyboard in a visible order, and every control has an accessible name that does not rely on a placeholder or an icon alone."}
```

```forge-requirement
{"id":"RS-AX-07","kind":"requirement","text":"The re-authentication, stalled-collection and empty states are announced as text, not only as a colour, badge or icon."}
```

---

## 10. System States / Lifecycle

| State | Entry condition | Product behaviour |
|-------|------------------|-------------------|
| Unconfigured | No configuration file | `collect` and `serve` explain how to run `config init` and stop; no network call is made |
| Configured, unconnected | Configuration present, no observations | Dashboard shows the empty state and the first-connect label; `collect` performs first-connect backfill then traffic collection |
| Collecting | A `collect` run is executing | Heartbeat row is written at start and end; per-repository state is recorded as it goes |
| Healthy | A run finished and every repository succeeded | Repository pages show the archive and the collection status |
| Degraded | At least one repository failed | The run still succeeds overall; failed repositories show their last success, failure count and reason |
| Needs re-authentication | The token was rejected (401) or lacks traffic permission (403) | Dashboard shows an explicit re-authenticate action naming the required permission; collection retries nothing until it changes |
| Stalled | No successful run within 26 hours | Dashboard shows a prominent stalled warning; this is the laptop-sleep failure mode |
| Repo unavailable | A repository is missing, renamed, transferred or archived | The repository is marked, not dropped, and the reason is visible in its history |
| Database needs migration | On-disk schema version is behind the code | `collect` and `serve` migrate automatically; `db status` reports the versions |

---

## 11. Analytics / Success Metrics

There is no product telemetry. These are measurements the maintainer takes by reading the archive
and the run journal, at or after 90 days.

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Unattended survival | 90 days with no manual intervention | Run journal has no gap wider than 26 hours |
| Archive completeness | Zero unexplained gaps | Per-repository gap count in the dashboard against known downtime |
| Window tolerability | The 14-day window proved workable | Maintainer judgement recorded in the 90-day write-up |
| Archive-only answers | At least three questions answered only because history exists | Maintainer's dated notes during the 90 days |
| Quiet-hours API budget | Traffic polling plus stats stays under 5000 requests per repository per year | Request counters in the run journal |

---

## 12. Dependencies and Risks

### 12.1 Dependencies

| Dependency | Type | Handling |
|------------|------|----------|
| GitHub REST API, version `2026-03-10` | External service | Pinned header, retry and rate-limit policy, and a human-run live integration check |
| A fine-grained personal access token with `Administration` read | Credential | Single install secret, `0600` file, explicit permission state in the dashboard |
| Node.js 24 LTS and its built-in `node:sqlite` | Runtime | Engine range pinned in `package.json`; the module is a release candidate, so the storage layer is the first thing re-checked on a Node major upgrade |
| The local clock and the machine staying awake | Environment | Heartbeat, stalled warning and catch-up guidance in the operations runbook |

### 12.2 Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Value is invisible for two weeks, and the archive only compounds if the schedule keeps running | The product is abandoned before it is useful | Durability is a v1 feature set, not housekeeping: heartbeat, stalled warning, idempotent re-run, operations runbook and a 90-day review |
| The 90-day calibration gap makes the honest insight layer look under-featured | Maintainer reaches for a score elsewhere | Minimum-volume floors and explicit insufficient-data states; named signals wait for real data |
| Small repositories are noise; three clones can move 300 percent | Misleading charts | Absolute values beside every percentage, insufficient-data states, and no directional verdicts |
| GitHub changes or removes a traffic endpoint or its media types | Collection silently stops | Typed failures, a live integration check against the real service, and a documented re-check step |
| `node:sqlite` is a release candidate | A Node major upgrade could change the API | The storage layer is isolated behind a repository interface, and the engine range is pinned to one LTS major |

---

## 13. Future Considerations

These are deliberately excluded from v1 and recorded so that the schema decision can be made with
the consequence in view.

| Item | Note |
|------|------|
| Ecosystem connectors (npm, PyPI, Docker Hub, NuGet) | Each is a new source of day-series rows and nothing else, once the GitHub-only path works end to end |
| OAuth or GitHub App credentials | The credential interface exists so the token source can be replaced without touching the collector |
| Opinionated named signals | Only after 90 days of real data to calibrate against, and only with explicit minimum-volume floors |
| Community signal backfill (issues, pull requests by pagination) | Expensive in API budget and fragile because of the `202` retry behaviour |
| Client-side interactivity | A small island earns its place only if server rendering proves genuinely painful |

---

## 14. Features

| # | Feature | File | Dependencies | Priority |
|---|---------|------|-------------|----------|
| 1 | Foundation and Runtime | [docs/features/foundation-and-runtime.md](features/foundation-and-runtime.md) | None | Must |
| 2 | Telemetry Storage and Migrations | [docs/features/telemetry-storage.md](features/telemetry-storage.md) | Foundation and Runtime | Must |
| 3 | GitHub API Client | [docs/features/github-api-client.md](features/github-api-client.md) | Foundation and Runtime | Must |
| 4 | Repo Enrollment and Discovery | [docs/features/repo-enrollment.md](features/repo-enrollment.md) | Foundation and Runtime, GitHub API Client | Must |
| 5 | First Connect Backfill | [docs/features/first-connect-backfill.md](features/first-connect-backfill.md) | Telemetry Storage and Migrations, GitHub API Client | Must |
| 6 | Traffic Collection Pipeline | [docs/features/traffic-collection.md](features/traffic-collection.md) | Telemetry Storage and Migrations, GitHub API Client, Repo Enrollment and Discovery, First Connect Backfill | Must |
| 7 | Collection Supervision | [docs/features/collection-supervision.md](features/collection-supervision.md) | Traffic Collection Pipeline | Must |
| 8 | Chart and Insight Rendering | [docs/features/chart-and-insight.md](features/chart-and-insight.md) | None | Must |
| 9 | Local Dashboard Server | [docs/features/dashboard-server.md](features/dashboard-server.md) | Foundation and Runtime, Telemetry Storage and Migrations | Must |
| 10 | Dashboard Views and Accessibility | [docs/features/dashboard-views.md](features/dashboard-views.md) | Local Dashboard Server, Chart and Insight Rendering | Must |
| 11 | Operations and Open Source Posture | [docs/features/operations-and-posture.md](features/operations-and-posture.md) | Foundation and Runtime, Telemetry Storage and Migrations, Collection Supervision | Must |

### Feature Dependency Graph

```
Foundation and Runtime (no prerequisites)
├── Telemetry Storage and Migrations
├── GitHub API Client
│   └── Repo Enrollment and Discovery
├── First Connect Backfill (Storage + API)
│   └── Traffic Collection Pipeline (Storage + API + Enrollment + Backfill)
│       └── Collection Supervision
└── Local Dashboard Server (Foundation + Storage)
    └── Dashboard Views and Accessibility (Server + Chart and Insight)

Chart and Insight Rendering is a pure-function feature with no prerequisites.
Operations and Open Source Posture depends on Foundation, Storage and Supervision,
and is the leaf that carries the human release gates.
```

---

## 15. Glossary

| Term | Definition |
|------|------------|
| Adoption | Deliberately not computed. The product never claims a clone is adoption |
| Acquisition | Clones and unique cloners as reported by GitHub, stored per day |
| Day series | A metric observed once per UTC day and keyed by repository, metric and date |
| Backfill | An observation reconstructed on first connect from a GitHub endpoint that carries history, marked `source = backfill` |
| Collected | An observation read from a live traffic endpoint on a later run, marked `source = collected` |
| Provenance boundary | The first day for which collected data exists, drawn as a visible boundary because everything before it is a different kind of evidence |
| Gap | A day inside the requested range with no stored observation; rendered as a gap |
| Snapshot | A timestamped, append-only capture of a top-10 list (referrers or popular paths) that has no day dimension to correct |
| Home | The single directory holding configuration, credentials and the database |
| Unique cloners | GitHub's count of distinct cloners, which the tool stores and never extrapolates |
| Fine-grained personal access token | A repository-scoped GitHub token; this install needs `Administration` read for traffic |
| 202 Accepted | The statistics endpoints' "cache is compiling" response, which the client retries with backoff |
| Stalled | No successful collection within 26 hours, the laptop-sleep failure mode |

---

## 16. Open Questions

Headless authoring: the interview was skipped and every gap is resolved with a recorded default
assumption. These stay open on purpose; each names the assumption the product ships with.

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | The idea asks for a TypeScript project and for no build step at the same time | Ship ESM JavaScript with JSDoc types checked by `tsc --noEmit`. A build step contradicts the "clone and run" promise, and JSDoc keeps the types without emitting |
| 2 | Does the dashboard read well? Undecidable without looking at it | A throwaway static page with hardcoded data for a spiking, a flat and a decaying repository is built in `spikes/`, reviewed by a human, and kept as decision evidence rather than deleted |
| 3 | Is a small repository worth charting? | Chart it, show absolute values beside percentages, and report insufficient data rather than hiding the repository |
| 4 | Do package-registry downloads deserve promotion into v1? | No. They stay a future source of day-series rows until the GitHub-only path is proven |
| 5 | TypeScript 7.0 is a new native compiler whose programmatic API is not complete | Use it for `tsc --noEmit` only. If its JSDoc checking misbehaves in this project, fall back to TypeScript 6.0.3, which is still supported |
| 6 | Which GitHub API version should be pinned? | `2026-03-10`, the current version. `2022-11-28` stays supported until 2028-03-10, and the pinned value is a single constant so it can move |
| 7 | Exact fine-grained permission required for every endpoint used | `Administration` read for the traffic endpoints per the GitHub documentation, `Metadata` read for repository listing. The live integration check confirms both against a real token |
| 8 | Does the execution environment reach the npm registry? | Yes. The only install step is the two development dependencies; the runtime itself installs nothing. If it is offline, the runtime tests still run and only `npm run typecheck` is unavailable |
| 9 | Where should the home directory live? | `XDG_DATA_HOME/repo-signal` or `~/.local/share/repo-signal`, never inside a work tree, overridable with `REPO_SIGNAL_HOME` for tests and CI |
| 10 | Which Node line does the build host actually provide? | Observed on the authoring host: Node 22.22.2. The engine range therefore starts at 22.13.0, the release where `node:sqlite` stopped needing a flag, and CI also runs the 24 LTS line |
| 11 | Who runs the daily schedule? | The operating system's scheduler, documented in the operations runbook. The collector embeds no timer, so a sleeping laptop cannot be masked by an in-process scheduler |
| 12 | What is the stall threshold? | 26 hours, slightly over one daily slot plus one missed slot, so a single missed run is visible without noise |
| 13 | Accessibility target for a single-user local tool | WCAG 2.1 AA on the dashboard pages, proven by deterministic structural tests plus a human keyboard and screen-reader pass |
| 14 | Should the soak gate be seven days or ninety days? | Seven consecutive unattended days is the release gate; the ninety-day measurement in section 11 is the maintainer's own later review, not a build task |
| 15 | Does the live GitHub check run in the engine or by hand? | By hand. A human review task carries the exact live commands, because the engine cannot hold a real token |
