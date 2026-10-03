# Project Progress

## Current State
**Phase**: DASHBOARD-VIEWS-AND-ACCESSIBILITY-1
**Status**: In Progress
**Validation Gaps**: 54 unverified check(s) - see "Validation Gaps"
**Last Updated**: 2026-10-03T15:35:09.459Z
**Run ID**: 68703c92-c4cf-4b9a-837e-c16d453b3deb
**Harness**: opencode
**Execution Mode**: auto

## Completed Tasks
- [x] Phase FOUNDATION-AND-RUNTIME-1, Task RS-FND-01: Create the runnable package, type-check config and fail-on-empty test wrapper (@platform-engineer)
  - Files: package.json, tsconfig.json, .gitignore, package-lock.json, scripts/run-tests.mjs, scripts/fixtures/empty-suite/sample.js, scripts/fixtures/passing-suite/passing.test.js, tests/run-tests.test.js
- [x] Phase FOUNDATION-AND-RUNTIME-1, Task RS-FND-02: Resolve the home directory and the paths derived from it (@platform-engineer)
  - Files: src/paths.js, tests/paths.test.js
- [x] Phase FOUNDATION-AND-RUNTIME-1, Task RS-FND-03: Build the CLI composition root and command registry (@platform-engineer)
  - Files: src/cli.js, src/commands/index.js, tests/cli.test.js, docs/engine-control.json, docs/reviews/RS-UI-REV-01-console-review.md, docs/reviews/dashboard-accessibility.json
- [x] Phase FOUNDATION-AND-RUNTIME-2, Task RS-FND-04: Parse and validate the configuration file under a closed schema (@platform-engineer)
  - Files: src/config/schema.js, src/config/load.js, tests/config.test.js
- [x] Phase FOUNDATION-AND-RUNTIME-2, Task RS-FND-05: Load the credential file with a 0600 check and redact token-shaped values (@platform-engineer)
  - Files: src/credentials/store.js, src/credentials/redact.js, tests/credentials.test.js
- [x] Phase FOUNDATION-AND-RUNTIME-2, Task RS-FND-06: Expose the config init and config check subcommands (@platform-engineer)
  - Files: src/commands/config.js, src/commands/index.js, tests/config-command.test.js
- [x] Phase FOUNDATION-AND-RUNTIME-3, Task RS-FND-REV-01: Human review of the foundation security and privacy posture
  - Files: docs/reviews/foundation-security.json
- [x] Phase TELEMETRY-STORAGE-AND-MIGRATIONS-1, Task RS-DB-01: Open the database and apply migrations forward only (@data-engineer)
  - Files: src/db/connection.js, src/db/migrate.js, tests/migrate.test.js
- [x] Phase TELEMETRY-STORAGE-AND-MIGRATIONS-1, Task RS-DB-02: Create the core archive schema (@data-engineer)
  - Files: src/db/migrations/001-core-schema.js, tests/initial-schema.test.js
- [x] Phase TELEMETRY-STORAGE-AND-MIGRATIONS-2, Task RS-DB-03: Implement the archive repository and gap-preserving range reads (@data-engineer)
  - Files: src/db/day-series-repo.js, src/db/snapshot-repo.js, src/db/ops-repo.js, tests/day-series-repo.test.js, tests/snapshot-repo.test.js, tests/ops-repo.test.js
- [x] Phase TELEMETRY-STORAGE-AND-MIGRATIONS-2, Task RS-DB-04: Expose the db command group with backup, restore and verification (@data-engineer)
  - Files: src/db/backup.js, src/commands/db.js, src/commands/index.js, tests/db-command.test.js
- [x] Phase GITHUB-API-CLIENT-1, Task RS-API-01: Build the credential provider and the allowlisted HTTP transport (@github-integration-engineer)
  - Files: src/github/credential-provider.js, src/github/http.js, tests/github-http.test.js
- [x] Phase GITHUB-API-CLIENT-1, Task RS-API-02: Implement the rate-limit and retry policy (@github-integration-engineer)
  - Files: src/github/rate-limit.js, src/github/retry.js, tests/github-retry.test.js
- [x] Phase GITHUB-API-CLIENT-2, Task RS-API-03: Normalize the four traffic endpoints (@github-integration-engineer)
  - Files: src/github/traffic-client.js, tests/traffic-client.test.js
- [x] Phase GITHUB-API-CLIENT-2, Task RS-API-04: Add the repository, stargazer and statistics clients (@github-integration-engineer)
  - Files: src/github/repo-client.js, src/github/stars-client.js, src/github/stats-client.js, tests/repo-client.test.js, tests/stars-client.test.js, tests/stats-client.test.js
- [x] Phase REPO-ENROLLMENT-AND-DISCOVERY-1, Task RS-ENR-01: Resolve the enrolled repository set with deny-list precedence (@cli-engineer)
  - Files: src/enrollment/resolve.js, tests/enrollment.test.js
- [x] Phase REPO-ENROLLMENT-AND-DISCOVERY-2, Task RS-ENR-02: Expose the discover command with pasteable configuration lines (@cli-engineer)
  - Files: src/commands/discover.js, src/commands/index.js, tests/discover-command.test.js
- [x] Phase FIRST-CONNECT-BACKFILL-1, Task RS-BKL-01: Reconstruct the full star history as cumulative day rows (@github-integration-engineer)
  - Files: src/backfill/stars.js, tests/backfill-stars.test.js
- [x] Phase FIRST-CONNECT-BACKFILL-1, Task RS-BKL-02: Backfill a year of weekly development activity (@github-integration-engineer)
  - Files: src/backfill/development.js, tests/backfill-development.test.js
- [x] Phase FIRST-CONNECT-BACKFILL-2, Task RS-BKL-03: Record and expose where collected history begins (@github-integration-engineer)
  - Files: src/backfill/provenance.js, tests/provenance.test.js
- [x] Phase TRAFFIC-COLLECTION-PIPELINE-1, Task RS-COL-01: Write collected traffic days through the archive upsert (@collector-engineer)
  - Files: src/collect/traffic.js, tests/collect-traffic.test.js
- [x] Phase TRAFFIC-COLLECTION-PIPELINE-1, Task RS-COL-02: Append referrer and popular-path captures as snapshots (@collector-engineer)
  - Files: src/collect/snapshots.js, tests/collect-snapshots.test.js
- [x] Phase TRAFFIC-COLLECTION-PIPELINE-2, Task RS-COL-03: Expose the collect command with dry run, filter and per-repository isolation (@collector-engineer)
  - Files: src/collect/run.js, src/commands/collect.js, src/commands/index.js, tests/collect-command.test.js, tests/helpers/stub-github-server.mjs, tests/config-command.test.js
- [x] Phase TRAFFIC-COLLECTION-PIPELINE-2, Task RS-COL-04: Mark renamed, transferred and vanished repositories instead of failing (@collector-engineer)
  - Files: src/collect/lifecycle.js, tests/collect-lifecycle.test.js, src/collect/run.js, src/commands/collect.js, tests/collect-command.test.js, tests/helpers/collect-home.js
- [x] Phase TRAFFIC-COLLECTION-PIPELINE-3, Task RS-COL-05: Verify the collection pipeline end to end against a local GitHub stub (@qa-engineer)
  - Files: tests/integration/collect-e2e.test.js
- [x] Phase COLLECTION-SUPERVISION-1, Task RS-SUP-01: Classify collection failures and persist per-repository error state (@collector-engineer)
  - Files: src/supervision/errors.js, src/supervision/repo-state-reporter.js, tests/supervision-errors.test.js
- [x] Phase COLLECTION-SUPERVISION-1, Task RS-SUP-02: Write the run journal and heartbeat into the collection run (@collector-engineer)
  - Files: src/supervision/journal.js, src/collect/run.js, tests/supervision-journal.test.js
- [x] Phase COLLECTION-SUPERVISION-2, Task RS-SUP-03: Expose one health read for the dashboard and the CLI (@collector-engineer)
  - Files: src/supervision/health.js, tests/supervision-health.test.js
- [x] Phase CHART-AND-INSIGHT-RENDERING-1, Task RS-VIZ-00: Build a throwaway legibility spike with three shaped histories (@ui-engineer)
  - Files: spikes/dashboard-legibility.html, tests/legibility-spike.test.js
- [x] Phase CHART-AND-INSIGHT-RENDERING-1, Task RS-VIZ-REV-01: Human review of the legibility spike and the chart order it decides
  - Files: docs/reviews/dashboard-legibility-spike.json
- [x] Phase CHART-AND-INSIGHT-RENDERING-2, Task RS-VIZ-01: Compute seven-day and week-over-week deltas honestly (@insight-engineer)
  - Files: src/insight/deltas.js, tests/insight-deltas.test.js
- [x] Phase CHART-AND-INSIGHT-RENDERING-2, Task RS-VIZ-02: Compute the stars-versus-clones divergence without a verdict (@insight-engineer)
  - Files: src/insight/divergence.js, tests/insight-divergence.test.js
- [x] Phase CHART-AND-INSIGHT-RENDERING-2, Task RS-VIZ-03: Produce a flat dated list of what changed (@insight-engineer)
  - Files: src/insight/changes.js, tests/insight-changes.test.js
- [x] Phase CHART-AND-INSIGHT-RENDERING-3, Task RS-VIZ-04: Render a metric series as SVG with gaps drawn as breaks (@ui-engineer)
  - Files: src/views/components/line-chart.js, tests/line-chart.test.js
- [x] Phase CHART-AND-INSIGHT-RENDERING-3, Task RS-VIZ-05: Annotate the chart with the provenance boundary and legend (@ui-engineer)
  - Files: src/views/components/line-chart.js, tests/provenance.test.js
- [x] Phase LOCAL-DASHBOARD-SERVER-1, Task RS-SRV-01: Create the loopback server with strict response headers (@server-engineer)
  - Files: src/server/server.js, src/server/security.js, tests/server.test.js
- [x] Phase LOCAL-DASHBOARD-SERVER-1, Task RS-SRV-02: Route the three pages and escape every dynamic value (@server-engineer)
  - Files: src/server/router.js, src/server/html.js, tests/router.test.js, tests/html.test.js
- [x] Phase LOCAL-DASHBOARD-SERVER-2, Task RS-SRV-03: Build the page data layer over the archive (@server-engineer)
  - Files: src/server/repo-data.js, tests/repo-data.test.js
- [x] Phase LOCAL-DASHBOARD-SERVER-2, Task RS-SRV-04: Exercise the running server end to end with a stub view registry (@qa-engineer)
  - Files: tests/integration/server-e2e.test.js
- [x] Phase DASHBOARD-VIEWS-AND-ACCESSIBILITY-1, Task RS-UI-01: Mount the view registry and expose the serve command (@ui-engineer)
  - Files: src/server/views/index.js, src/server/views/repo-list.js, src/commands/serve.js, src/commands/index.js, tests/views/repo-list.test.js, tests/serve-command.test.js, tests/config-command.test.js
- [x] Phase DASHBOARD-VIEWS-AND-ACCESSIBILITY-1, Task RS-UI-02: Render the repository detail page in the reviewed order (@ui-engineer)
  - Files: src/server/views/repo-detail.js, src/server/views/index.js, tests/views/repo-detail.test.js, tests/views/repo-list.test.js
- [x] Phase DASHBOARD-VIEWS-AND-ACCESSIBILITY-1, Task RS-UI-03: Render the collection health page with text states (@ui-engineer)
  - Files: src/server/views/health.js, src/server/views/index.js, tests/views/health-view.test.js, src/commands/serve.js
- [x] Phase OPERATIONS-AND-OPEN-SOURCE-POSTURE-1, Task RS-OPS-01: Build the backup drill and the backup and migration runbook (@platform-engineer)
  - Files: docs/operations/backup-and-migrate.md, scripts/backup-drill.mjs, tests/backup-drill.test.js
- [x] Phase OPERATIONS-AND-OPEN-SOURCE-POSTURE-1, Task RS-OPS-02: Write the unattended operation and troubleshooting runbooks (@platform-engineer)
  - Files: docs/operations/scheduled-collection.md, docs/operations/troubleshooting.md, tests/troubleshooting-contract.test.js
- [x] Phase OPERATIONS-AND-OPEN-SOURCE-POSTURE-2, Task RS-OPS-03: Publish the README, the licence and the privacy note (@platform-engineer)
  - Files: README.md, LICENSE, docs/operations/privacy.md, tests/release-contract.test.js
- [x] Phase OPERATIONS-AND-OPEN-SOURCE-POSTURE-2, Task RS-OPS-04: Add continuous integration and the release checklist (@platform-engineer)
  - Files: .github/workflows/ci.yml, docs/operations/release-checklist.md, tests/ci-contract.test.js

## Current Task
- None currently running

## Remaining
- [ ] Phase DASHBOARD-VIEWS-AND-ACCESSIBILITY-2: Phase 2: Accessibility contract and end-to-end verification
- [ ] Phase DASHBOARD-VIEWS-AND-ACCESSIBILITY-3: Phase 3: Human journey and accessibility review
- [ ] Phase OPERATIONS-AND-OPEN-SOURCE-POSTURE-3: Phase 3: Human gates

## Blockers
- None

## Validation Gaps
- Task RS-FND-01: Wrapper behaviour verified on Node 22.22.2 only; the 24.21.0 line named in the PRD is not available on this host
- Task RS-FND-02: No node_modules was present in this sandbox, so npm ci was run before typecheck
- Task RS-FND-02: Verified on Node 22.22.2 only; the 24 LTS line named in the PRD is not available on this host
- Task RS-FND-04: Validation ran on Node 22.22.2; Node 24 was not exercised.
- Task RS-FND-05: Validated on Node 22.22.2; Node 24 was not tested.
- Task RS-FND-06: Validated on Node 22.22.2; Node 24 was not exercised.
- Task RS-API-03: Tests use injected responses; real-service behavior was not live-verified.
- Task RS-API-04: Tests use injected responses; no network calls were made.
- Task RS-BKL-02: Tests use an injected statistics client stub; real-service behavior (including week-start alignment) was not live-verified; RS-OPS-LIVE-01 remains a human gate.
- Task RS-BKL-03: No external GitHub contract is asserted by this task's tests because provenance reads only local SQLite and makes no network call, so nothing external was assumed or verified here.
- Task RS-BKL-03: RS-OPS-LIVE-01 remains an open human gate; no live token check was performed and none is claimed.
- Task RS-BKL-03: Who decides when a first collection counts as successful stays with collector-engineer: stampFirstCollected accepts the day the caller supplies and does not itself verify that a collection succeeded.
- Task RS-COL-01: No live GitHub request was made and no real token was used; traffic response shapes follow the traffic-client contract and the vendor documentation already recorded for RS-API-03, so real-service behaviour remains unverified and RS-OPS-LIVE-01 stays an open human gate.
- Task RS-COL-03: No live GitHub request was made and no real token was used. Endpoint response shapes follow the traffic, stargazer and statistics client contracts already recorded in the repository, so real-service behaviour remains unverified and RS-OPS-LIVE-01 stays an open human gate; no human review file was created or claimed.
- Task RS-COL-04: No live GitHub request was made and no real token was used, so rename, transfer and 404 handling is verified only against the local stub's response shapes; RS-OPS-LIVE-01 stays an open human gate and no human review file was created or claimed.
- Task RS-COL-05: Endpoint behaviour is verified against the local stub's scripted response shapes only: a real rename redirect, a real statistics 202 or a real rate limit was never exercised, and the retry backoff under test is the shared policy's own 500-1000 ms jitter, which is why the 202 test takes about a second.
- Task RS-COL-05: The sixty-second budget assertion is only meaningful as a regression guard on a loopback stub; it cannot predict real-service timing, where rate-limit waits dominate and are explicitly excluded from the requirement.
- Task RS-SUP-01: Classification is verified against the local transport's scripted response shapes only; no request reached api.github.com and no real token was used, so real-service status/header shapes remain unverified behind the RS-OPS-LIVE-01 human gate.
- Task RS-SUP-01: Nothing in docs/reviews/ was created or claimed, and no gap in existing data was hand-repaired.
- Task RS-SUP-02: No live GitHub request was made and no real token was used; behaviour is verified against the local loopback stub and a scripted in-process policy, so real-service response shapes remain unverified behind the RS-OPS-LIVE-01 human gate.
- Task RS-SUP-02: Nothing in docs/reviews/ was created or claimed, and no gap in existing data was hand-repaired.
- Task RS-SUP-03: No live GitHub request was made and no real token was used; every state was produced against a scripted in-process policy and the local loopback transport conventions, so real-service status and header shapes remain unverified behind the RS-OPS-LIVE-01 human gate.
- Task RS-SUP-03: No rendering and no CLI wiring was in scope and none was written; the dashboard and the CLI consuming this read are later tasks, so the claim that the two surfaces cannot disagree is asserted at the module boundary (one repository read equals the whole read's entry) rather than through a spawned command.
- Task RS-SUP-03: Nothing in docs/reviews/ was created or claimed, and no gap in existing data was hand-repaired.
- Task RS-VIZ-00: Tests were run on Node 22.22.2, the version on this host; the Node 24.21.0 line named in the PRD was not available
- Task RS-VIZ-02: Tests ran on the Node version installed on this host; the Node 24 line named in the PRD was not available
- Task RS-VIZ-03: Tests were run on the Node version available on this host; the Node 24.12.0+ line named in package.json engines was not checked separately
- Task RS-VIZ-05: Tests ran on the Node 24.15.0 installed on this host; the 24.12.0+ floor in package.json engines was not separately checked
- Task RS-VIZ-05: No styling work is included: the legend and boundary classes are emitted with no colour literal, and src/ui/theme.css plus the /assets/theme.css route remain RS-UI-04's to own
- Task RS-SRV-03: No live GitHub request was made and no real token was used; globalThis.fetch is refused for the whole test file and the module is asserted to contain no fetch call or HTTP import.
- Task RS-SRV-03: No rendering and no CLI wiring was in scope and none was written, so the claim that the running server cannot disagree with this read is asserted at the module boundary (page data equals the owned reads' output) rather than through a spawned command.
- Task RS-SRV-03: Nothing in docs/reviews/ was created or claimed, and no review gate was self-served.
- Task RS-SRV-04: The view content is a stub by task design, so assertions about the page's markup describe what the product's shell, escaping helpers and page read produce when composed, not the product views that RS-UI-01/02 will add; those arrive with their own tests.
- Task RS-SRV-04: No live GitHub request and no real token were used; the only host this suite can reach is its own loopback server, enforced by a fetch guard that is itself probed.
- Task RS-UI-01: No live GitHub request and no real token were used; serve imports no credential store and no configuration module, and the only host any test reached was its own loopback server.
- Task RS-UI-01: The accessibility assertions here are structural on the rendered markup; the mechanical RS-AX contract (landmarks, heading order, table pairing, contrast ratios against theme tokens) is RS-UI-04's to assert once the stylesheet exists.
- Task RS-UI-01: The repository-list table's numbers were verified against a temporary home seeded through the product's own writes; no human has judged whether the page answers the maintainer's question, which is RS-UI-REV-01's gate and was neither created nor claimed.
- Task RS-UI-02: No human has judged whether the page answers the maintainer's question; that is RS-UI-REV-01's gate, and nothing in docs/reviews/ was created or claimed
- Task RS-UI-02: No live GitHub request and no real token were used; the only host any test reached was its own loopback server
- Task RS-UI-02: The contrast half of RS-AX-01 (theme token ratios) cannot be checked until RS-UI-04 supplies src/ui/theme.css; the structural assertions here cover landmarks, heading order and table pairing on the served markup
- Task RS-UI-03: No live GitHub request and no real token were used; every state came from a scripted archive written through the product's own writes, and the only host reached over HTTP was the test's own loopback dashboard
- Task RS-UI-03: Elapsed-time-dependent states in the spawned-serve test are the wall clock's to decide, so that test asserts the two clock-independent states (needs-re-authentication, never-collected), the row count and the served markup rather than every state word
- Task RS-UI-03: Whether the page answers the maintainer's question, its keyboard pass and its screen-reader pass are RS-UI-REV-01's human gate; no file in docs/reviews/ was created, edited or claimed
- Task RS-UI-03: Tests ran on the Node 24.15.0 installed here; package.json's engines floor of 24.12.0 was not separately checked
- Task RS-OPS-01: No real archive, no real credential and no network were involved: every check ran against scratch homes in the system temporary directory and spawned commands that make no outbound request, so the drill proves the restore path, not the behaviour of a live collection.
- Task RS-OPS-02: No real GitHub request was made and no real token was used. The 401/403/429 refusal lines quoted in the page are transcribed from the classifier's own message templates in src/supervision/errors.js and src/github/retry.js, not from a live response, so real-service wording remains unverified behind the RS-OPS-LIVE-01 human gate.
- Task RS-OPS-02: The cron, launchd and systemd entries are written against the documented behaviour of those three schedulers; only the systemd timer's semantics were cross-checked against the repository's own conventions. No schedule was installed or observed firing on any machine.
- Task RS-OPS-02: Nothing in docs/reviews/ was created or claimed.
- Task RS-OPS-03: No live GitHub request and no real token were involved in this task; `serve` was exercised only as a name, and no dashboard command exists to run. The privacy note's request-count figures are the collector's own documented constants, not a measured run.
- Task RS-OPS-03: The licence, the data statement and the privacy note are unconfirmed by the human posture review, so publishing them is a human decision this task cannot make.
- Task RS-OPS-03: No host other than api.github.com was contacted; the transport allowlist and the `GET`-only claim are verified by reading src/github/http.js and by the existing tests/github-http.test.js, not by observing a live run.
- Task RS-OPS-04: No GitHub Actions run, no GitHub token and no live API call were involved. The pipeline's own execution on ubuntu-latest is unobserved; every behavioural claim about it is asserted against the file's text and against the same four commands run locally.
- Task RS-OPS-04: RS-SP-05's mechanical guarantee remains tests/github-http.test.js, which this task did not modify; the CI contract test asserts that test still exists and still names api.github.com, and that the workflow adds no host of its own.
- Task RS-OPS-04: The checklist deliberately states no test result and no approval; the matrix, drill and type check are observed locally on one host, not on GitHub's runners.

## Notes
- Workflow engine run 68703c92-c4cf-4b9a-837e-c16d453b3deb
- Harness: opencode
