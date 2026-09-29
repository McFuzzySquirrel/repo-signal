# Feature: Traffic Collection Pipeline

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-ST-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SC-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SC-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-PR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-COL-FR-01 | This feature | owns |
| RS-COL-FR-02 | This feature | owns |
| RS-COL-FR-03 | This feature | owns |
| RS-COL-FR-04 | This feature | owns |
| RS-COL-CON-01 | This feature | owns |
| RS-COL-ST-01 | This feature | owns |
| RS-COL-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Traffic Collection Pipeline
**ID Prefix:** RS-COL
**Summary:** The daily act of asking GitHub what happened, writing each answer into the archive,
surviving an interruption, and surviving a repository that has been renamed, transferred or
deleted.
**Dependencies:** Telemetry Storage and Migrations, GitHub API Client, Repo Enrollment and Discovery, First Connect Backfill
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-COL-ST-01","kind":"story","text":"As a solo maintainer I want a collection run I can put in cron and never think about again, so that the archive grows without me."}
```

```forge-requirement
{"id":"RS-COL-ST-02","kind":"story","text":"As a solo maintainer I want a renamed or deleted repository to be marked rather than to crash my run, so that one bad repository does not cost me a night of history."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-COL-FR-01","kind":"requirement","text":"Collect clone and view traffic for each enrolled repository and write each returned day through the day-series upsert with source collected and the run's collection time, so that GitHub's revision of its own 14-day window corrects the archive in place on the next run instead of accumulating a second value."}
```

```forge-requirement
{"id":"RS-COL-FR-02","kind":"requirement","text":"Capture referrers and popular paths as append-only snapshots stamped with the run identifier and the collection time, never merging two captures, because these lists have no day dimension to correct."}
```

```forge-requirement
{"id":"RS-COL-FR-03","kind":"requirement","text":"Provide the `collect` command, reachable from the process entry point, that resolves the enrolled set, plans the work, runs each repository independently, writes a run record, and returns a summary with a non-zero exit code when any repository failed. It must support an immediate run for a manual spike check, a single-repository filter, and a dry run that plans without contacting GitHub. Every log line must be structured and free of credential material."}
```

```forge-requirement
{"id":"RS-COL-FR-04","kind":"requirement","text":"Handle repository lifecycle change during a run: a renamed or transferred repository keeps its identity, gains an alias row, and is collected under its new name; a repository that no longer exists is marked unavailable with the reason and is excluded from later runs without deleting its history."}
```

```forge-requirement
{"id":"RS-COL-CON-01","kind":"constraint","text":"A failure in one repository never aborts the run, and an interrupted run never leaves a half-written fact: every write for a repository is committed as one transaction, so a kill between repositories loses that repository's work and nothing else."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-COL-ST-01 | story | Must |
| RS-COL-ST-02 | story | Must |
| RS-COL-FR-01 | requirement | Must |
| RS-COL-FR-02 | requirement | Must |
| RS-COL-FR-03 | requirement | Must |
| RS-COL-FR-04 | requirement | Must |
| RS-COL-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

`collect` prints one line per repository in the form `owner/name ok 14 days` or
`owner/name failed <kind>`, a final summary line with the counts and the run identifier, and
nothing else. `--dry-run` prints the same plan with the word `planned` instead of `ok` and makes
no network call and no write. The run identifier is printed so a maintainer can find the run row
in the database.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-COL-01 | Traffic days are written through the upsert with run provenance | collector-engineer | RS-API-03, RS-DB-03, RS-BKL-03 | src/collect/traffic.js, tests/collect-traffic.test.js | in-place revision, window re-collection, transaction boundary | Snapshots, command surface |
| RS-COL-02 | Referrers and paths accumulate as timestamped snapshots | collector-engineer | RS-API-03, RS-DB-03 | src/collect/snapshots.js, tests/collect-snapshots.test.js | two runs two captures, rank and count kept, no merge | Day series, command surface |
| RS-COL-03 | The collect command plans, runs and reports without leaking the token | collector-engineer | RS-COL-01, RS-COL-02, RS-ENR-01, RS-FND-03 | src/collect/run.js, src/commands/collect.js, src/commands/index.js, tests/collect-command.test.js, tests/helpers/stub-github-server.mjs | dry run, filter, per-repo isolation, exit codes, no token in logs | Supervision hooks, lifecycle marking |
| RS-COL-04 | Renames, transfers and disappearances are marked, not fatal | collector-engineer | RS-COL-03 | src/collect/lifecycle.js, tests/collect-lifecycle.test.js | rename keeps history, transfer updates owner, 404 marks unavailable | Failure classification, heartbeat |
| RS-COL-05 | The whole pipeline is verifiable without a live token | qa-engineer | RS-COL-03, RS-COL-04 | tests/integration/collect-e2e.test.js | two-run idempotency, snapshot counts, 202 then 200, mixed success | Production behaviour changes |

---

## 6. Implementation Tasks

### Phase 1: Traffic and snapshot capture

```forge-task
{
  "id": "RS-COL-01",
  "title": "Write collected traffic days through the archive upsert",
  "description": "Implement src/collect/traffic.js to fetch clones and views for one repository through src/github/traffic-client.js and write every returned day through src/db/day-series-repo.js with source collected, the run's collection time and day granularity, inside a single transaction per repository so an interruption cannot leave half a repository written. Because GitHub returns the same rolling window every day, a re-run inside the same window must revise the existing days in place through the upsert rather than creating a second value, and the last write wins. Return a small summary of how many days were written and how many were revisions. The tests cover a first collection, a second collection over an overlapping window asserting the row count is unchanged, and a repository whose window is entirely empty.",
  "ownerAgent": "collector-engineer",
  "dependencies": ["RS-API-03", "RS-DB-03", "RS-BKL-03"],
  "expectedOutputs": ["src/collect/traffic.js", "tests/collect-traffic.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/collect-traffic.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/traffic-collection.md#RS-COL-FR-01", "docs/PRD.md#RS-VR-01"],
    "acceptanceCriteria": ["A first collection writes one row per returned day with source collected and a collection timestamp", "A second collection over an overlapping window leaves the total row count unchanged and the revised value visible", "A repository with an empty window writes no rows and reports zero without error", "The written days and the revisions are counted in the returned summary"],
    "constraints": ["Writes for one repository are one transaction; a failure leaves no partial repository write", "No missing day is created, defaulted or interpolated"],
    "constraintRefs": ["docs/features/traffic-collection.md#RS-COL-CON-01", "docs/PRD.md#RS-DU-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-TC-02"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces"]
  }
}
```

```forge-task
{
  "id": "RS-COL-02",
  "title": "Append referrer and popular-path captures as snapshots",
  "description": "Implement src/collect/snapshots.js to fetch the top referrers and the top popular paths through src/github/traffic-client.js and append them as snapshot rows through src/db/snapshot-repo.js carrying the run identifier, the capture time and the position in the returned list, all inside the same per-repository transaction the day series uses. Two runs on the same day must produce two captures, not one merged list, because these payloads have no day dimension and therefore nothing to correct. Preserve the count and uniques values and the popular-path title exactly as returned. The tests cover a first run, a second run asserting both captures survive with distinct capture times, and a response with fewer than ten entries.",
  "ownerAgent": "collector-engineer",
  "dependencies": ["RS-API-03", "RS-DB-03"],
  "expectedOutputs": ["src/collect/snapshots.js", "tests/collect-snapshots.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/collect-snapshots.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/traffic-collection.md#RS-COL-FR-02", "docs/PRD.md#RS-VR-01"],
    "acceptanceCriteria": ["Two runs produce two captures of the same referrer with distinct capture times and both survive", "A popular-path capture keeps the returned path title and count unchanged", "A response with three entries writes three rows and no padding to ten", "Every snapshot row carries the run identifier and the capture time"],
    "constraints": ["Snapshot captures are append-only and are never merged or replaced", "Do not assign a day to a snapshot; they have no day dimension"],
    "constraintRefs": ["docs/features/traffic-collection.md#RS-COL-CON-01", "docs/PRD.md#RS-TC-02", "docs/PRD.md#RS-DU-02"],
    "references": ["docs/PRD.md#6.2 Project Structure"]
  }
}
```

### Phase 2: The collect command and lifecycle handling

```forge-task
{
  "id": "RS-COL-03",
  "title": "Expose the collect command with dry run, filter and per-repository isolation",
  "description": "Implement src/collect/run.js as the orchestration that resolves the enrolled set through src/enrollment/resolve.js and records the run through src/db/ops-repo.js, opens a run record, runs each repository independently by calling the traffic step in src/collect/traffic.js and the snapshot step in src/collect/snapshots.js inside a per-repository failure boundary, closes the run record and returns a summary; then add src/commands/collect.js and register it in src/commands/index.js so it is reachable from the process entry point. On a repository whose backfill has not completed, run the first-connect backfill from src/backfill/stars.js, src/backfill/development.js and src/backfill/provenance.js before collecting its traffic, and skip that step for a repository already backfilled, so one command takes a new install from nothing to a labelled archive. Support an immediate manual run, a single-repository filter, and a dry run that plans and prints without any network call or write. A repository that fails must not stop the others, and the command must exit non-zero when any repository failed while still writing a complete run record. Every log line must be structured and pass through credential redaction. Add tests/helpers/stub-github-server.mjs, a scriptable local GitHub stub used by the test, and drive the whole command through `node src/cli.js collect` in the test.",
  "ownerAgent": "collector-engineer",
  "dependencies": ["RS-COL-01", "RS-COL-02", "RS-ENR-01", "RS-FND-03", "RS-BKL-01", "RS-BKL-02", "RS-BKL-03"],
  "expectedOutputs": ["src/collect/run.js", "src/commands/collect.js", "src/commands/index.js", "tests/collect-command.test.js", "tests/helpers/stub-github-server.mjs"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/collect-command.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/traffic-collection.md#RS-COL-FR-03"],
    "acceptanceCriteria": ["`node src/cli.js collect --dry-run` prints one planned line per enrolled repository, makes no network call and writes no fact row", "`node src/cli.js collect --repo owner/name` collects only that repository and exits 0", "A run where one repository fails still collects the others, prints a failure line, writes a complete run record and exits 1", "A repository with no backfill record is backfilled and then collected in the same run, and a second run skips the backfill step", "A dry run reports the backfill step it would perform without performing it", "Every printed line passes the redaction helper and the captured stdout contains no token-shaped value", "The printed run identifier matches the run row written for that run"],
    "constraints": ["No heartbeat or error-state recording in this task; supervision owns those", "Only the local transport override may be used by the test stub"],
    "constraintRefs": ["docs/features/traffic-collection.md#RS-COL-CON-01", "docs/PRD.md#RS-SC-02", "docs/PRD.md#RS-SC-04", "docs/PRD.md#RS-DU-01", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces", "docs/features/traffic-collection.md#RS-COL-ST-01"]
  }
}
```

```forge-task
{
  "id": "RS-COL-04",
  "title": "Mark renamed, transferred and vanished repositories instead of failing",
  "description": "Implement src/collect/lifecycle.js and wire it into src/collect/run.js, which this task modifies: before writing a repository's facts, confirm the repository still resolves and compare the returned owner and name with the stored one. Resolve the repository through src/github/repo-client.js before writing any fact. A rename or a transfer keeps the same stored identity, records an alias row, updates the canonical name and continues collecting. A repository that no longer exists is marked unavailable with the reason, is excluded from later runs, and keeps all of its history; the run continues with the remaining repositories and reports the marking as a repository outcome rather than a crash. The tests cover a rename, a transfer, a not-found response, and a run mixing a healthy repository with a vanished one.",
  "ownerAgent": "collector-engineer",
  "dependencies": ["RS-COL-03"],
  "expectedOutputs": ["src/collect/lifecycle.js", "tests/collect-lifecycle.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/collect-lifecycle.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/traffic-collection.md#RS-COL-FR-04", "docs/PRD.md#RS-VR-01"],
    "acceptanceCriteria": ["A renamed repository keeps its stored identifier, gains an alias row and is collected under the new name", "A transferred repository updates its owner while keeping its stored identifier and history", "A not-found response marks the repository unavailable with the reason and a later run excludes it", "A run mixing a healthy and a vanished repository collects the healthy one and exits with the marking reported"],
    "constraints": ["Never delete a repository row or any of its history", "Do not add retry or backoff logic; the transport policy owns that"],
    "constraintRefs": ["docs/features/traffic-collection.md#RS-COL-CON-01", "docs/PRD.md#RS-TC-02"],
    "references": ["docs/PRD.md#10. System States / Lifecycle"]
  }
}
```

### Phase 3: End-to-end verification without a live token

```forge-task
{
  "id": "RS-COL-05",
  "title": "Verify the collection pipeline end to end against a local GitHub stub",
  "description": "Add tests/integration/collect-e2e.test.js, an integration test that drives the real entry point twice against the local GitHub stub over a temporary home with a real migrated database, and asserts the properties that only an end-to-end run can show: the first run writes day rows and one snapshot capture per repository, a second run over the same window leaves the day rows unchanged while adding a second capture, a statistics endpoint answering 202 then 200 is survived rather than stored, and a run mixing a failing and a succeeding repository still records a complete run. Reuse the stub helper created with the command; extend it if a needed response is missing. This task adds tests only and must not change production behaviour to make a test pass.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["RS-COL-03", "RS-COL-04"],
  "expectedOutputs": ["tests/integration/collect-e2e.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/integration/collect-e2e.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/traffic-collection.md#RS-COL-FR-03"],
    "acceptanceCriteria": ["The first run's day row count equals the number of days the stub returned, asserted against the database", "The second run leaves the day row count unchanged and the snapshot row count doubled", "A statistics endpoint answering 202 then 200 results in stored weekly rows and no error", "A mixed run records a complete run row with both the success and failure counts", "The whole test completes without reaching api.github.com and without a real token"],
    "constraints": ["Tests only; if a production change is needed, report it rather than editing src", "The local transport override is the only permitted network path in this test"],
    "constraintRefs": ["docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-TC-04", "docs/PRD.md#RS-DU-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-PR-01"],
    "references": ["docs/PRD.md#7.4 Shared Definition Index"]
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Traffic day writes, snapshot appends | Client stubs and a temporary migrated database |
| Entry point | The collect command, dry run, filter, isolation, exit codes | Spawn `node src/cli.js collect` against the local GitHub stub |
| Unit | Lifecycle marking | Renamed, transferred and not-found responses scripted in the stub |
| Integration | Two full runs, statistics 202, mixed outcomes | One integration test over a temporary home and a real database |
| Human | The real API, real token, real permissions | Live verification in the operations feature |

Key test scenarios:

1. First run writes the returned days; second run over the same window changes no row count.
2. Two runs produce two snapshot captures rather than one merged capture.
3. Dry run plans without a socket and without a write.
4. One failing repository does not stop the others and still yields a complete run record.
5. A renamed repository keeps its history; a vanished one is marked and skipped afterwards.
6. A statistics endpoint answering 202 then 200 is survived, not stored as data.

---

## 8. Acceptance Criteria

1. `collect` is safe to run twice in a row: the second run changes no existing day value's row identity and corrects values in place.
2. A run that is killed mid-way leaves no half-written repository.
3. Referrer and popular-path captures accumulate as timestamped snapshots.
4. A renamed, transferred or deleted repository is marked, never fatal, and never loses history.
5. No token-shaped value appears in any output of a successful or a failed run.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should a run collect repositories in parallel? | No. Six sequential repositories stay well inside the rate limit, and a sequential run keeps the transaction story simple |
| 2 | What should the exit code be when some repositories failed? | 1, with the run record still complete, so a scheduler can alert on it while the successful repositories are already stored |
| 3 | Should `--dry-run` show the planned API call count? | Yes, per repository, so the maintainer can see the cost before running for real |
| 4 | Should a run write the run record before any request? | Yes, at start, so a hard kill still leaves evidence that a run began |
