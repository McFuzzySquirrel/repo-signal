# Feature: Collection Supervision

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-03 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SP-02 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SUP-FR-01 | This feature | owns |
| RS-SUP-FR-02 | This feature | owns |
| RS-SUP-FR-03 | This feature | owns |
| RS-SUP-CON-01 | This feature | owns |
| RS-SUP-ST-01 | This feature | owns |
| RS-SUP-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Collection Supervision
**ID Prefix:** RS-SUP
**Summary:** Making a dead collector visible: a heartbeat, a run journal, a per-repository error
state, a re-authentication state, and a stalled warning that turns a sleeping laptop into
something the maintainer sees instead of something they guess about.
**Dependencies:** Traffic Collection Pipeline
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-SUP-ST-01","kind":"story","text":"As a solo maintainer I want the dashboard to tell me that collection stopped, so that a three-week-old archive is never discovered by accident."}
```

```forge-requirement
{"id":"RS-SUP-ST-02","kind":"story","text":"As a solo maintainer I want an expired token to surface as a re-authenticate action, so that an authentication failure is something I do rather than something I debug."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-SUP-FR-01","kind":"requirement","text":"Classify every collection failure into a small typed set: authentication rejected, traffic permission missing, repository missing, rate limited, transient, and unexpected. Record the classification, the message and the time against the repository, keep a consecutive-failure count that resets on success, and let the collector keep going so one bad repository cannot stop the night."}
```

```forge-requirement
{"id":"RS-SUP-FR-02","kind":"requirement","text":"Maintain a run journal and a heartbeat: write a run row and a heartbeat at the start of every run, update progress while it runs, close both at the end with status, counts and duration, and detect a run that never closed. A repository whose last successful collection is older than 26 hours is reported as stalled rather than healthy."}
```

```forge-requirement
{"id":"RS-SUP-FR-03","kind":"requirement","text":"Expose one health read that, per enrolled repository, returns its last successful collection, its consecutive failure count, whether it needs re-authentication, whether it is stalled, and the reason for the most recent failure, so the dashboard and the CLI present the same state."}
```

```forge-requirement
{"id":"RS-SUP-CON-01","kind":"constraint","text":"Supervision state is derived from recorded runs and failures, never inferred from the presence or absence of data. A quiet repository is quiet, not broken, and a stalled collector is a stated state rather than an absence of pages."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-SUP-ST-01 | story | Must |
| RS-SUP-ST-02 | story | Must |
| RS-SUP-FR-01 | requirement | Must |
| RS-SUP-FR-02 | requirement | Must |
| RS-SUP-FR-03 | requirement | Must |
| RS-SUP-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

The health read feeds two surfaces: a status line on the repository list and a dedicated health
view. Each repository shows one state word, the time of its last success, its consecutive failure
count, and, when relevant, the reason and the action to take. States are text first; a colour may
reinforce them but never replaces them.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-SUP-01 | Failures classify into typed states and persist per repository | collector-engineer | RS-API-02, RS-DB-03 | src/supervision/errors.js, src/supervision/repo-state-reporter.js, tests/supervision-errors.test.js | six kinds, counter reset, message retention | Heartbeat, health read |
| RS-SUP-02 | Runs leave a journal, a heartbeat and a stalled detection | collector-engineer | RS-SUP-01, RS-COL-03 | src/supervision/journal.js, src/collect/run.js, tests/supervision-journal.test.js | start and close rows, unclosed run detected, 26-hour rule | Health aggregation |
| RS-SUP-03 | One health read serves the dashboard and the CLI | collector-engineer | RS-SUP-02 | src/supervision/health.js, tests/supervision-health.test.js | healthy, degraded, needs-reauth, stalled, unavailable | Rendering, styling |

---

## 6. Implementation Tasks

### Phase 1: Failure state and run journal

```forge-task
{
  "id": "RS-SUP-01",
  "title": "Classify collection failures and persist per-repository error state",
  "description": "Implement src/supervision/errors.js, the single classifier the collection run and the transport policy both use, to map a transport or endpoint failure onto exactly one of six kinds: authentication rejected, traffic permission missing, repository missing, rate limited, transient, or unexpected, with an action-oriented message that names the next step for the first two. Implement src/supervision/repo-state-reporter.js to record the classification, the message and the time against the repository, to increment a consecutive-failure counter, and to reset that counter on a success. The reporter must be usable by src/collect/run.js without the run importing the classifier's internals, and it must not decide whether a run continues. The tests cover all six kinds, a counter that increments then resets, and a permission failure whose message names the missing permission.",
  "ownerAgent": "collector-engineer",
  "dependencies": ["RS-API-02", "RS-DB-03"],
  "expectedOutputs": ["src/supervision/errors.js", "src/supervision/repo-state-reporter.js", "tests/supervision-errors.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/supervision-errors.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/collection-supervision.md#RS-SUP-FR-01", "docs/PRD.md#RS-VR-03", "docs/PRD.md#RS-SP-02"],
    "acceptanceCriteria": ["Each of the six kinds is produced by a named test from a representative failure", "A permission failure message names the Administration read permission and the action to take", "Two consecutive failures report a count of two and a subsequent success resets it to zero", "The recorded message is retained for the most recent failure of a repository"],
    "constraints": ["No run orchestration in this task; the collector owns whether a run continues", "State is recorded, never inferred from stored observations"],
    "constraintRefs": ["docs/features/collection-supervision.md#RS-SUP-CON-01", "docs/PRD.md#RS-TC-02"],
    "references": ["docs/PRD.md#10. System States / Lifecycle"]
  }
}
```

```forge-task
{
  "id": "RS-SUP-02",
  "title": "Write the run journal and heartbeat into the collection run",
  "description": "Implement src/supervision/journal.js and wire it into src/collect/run.js, which this task modifies. A run must write its run row and a heartbeat before the first request, update progress as each repository finishes, and close both at the end with status, per-repository counts, duration and the request count. A run that never closed must be detectable from the journal alone, and a repository whose last successful collection is older than 26 hours must be reported as stalled rather than healthy. The wiring must not change the dry-run guarantee, and the dry run must still write nothing. The tests cover a clean run, a run that fails for one repository, an injected run that is abandoned before closing, and the 26-hour boundary with an injected clock.",
  "ownerAgent": "collector-engineer",
  "dependencies": ["RS-SUP-01", "RS-COL-03"],
  "expectedOutputs": ["src/supervision/journal.js", "src/collect/run.js", "tests/supervision-journal.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/supervision-journal.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/collection-supervision.md#RS-SUP-FR-02", "docs/PRD.md#RS-VR-03"],
    "acceptanceCriteria": ["A completed run leaves exactly one closed run row carrying status, counts, duration and request count", "A run row is written before the first request so an abandoned run is still visible", "A run abandoned before closing is reported as unclosed by a later read", "A repository last collected 25 hours ago is healthy and one last collected 27 hours ago is stalled, asserted with an injected clock", "A dry run writes no run row and no heartbeat"],
    "constraints": ["The clock is injected for tests", "Do not change collection behaviour, repository selection or exit codes in this task"],
    "constraintRefs": ["docs/features/collection-supervision.md#RS-SUP-CON-01", "docs/PRD.md#RS-DU-01", "docs/PRD.md#RS-TC-02"],
    "references": ["docs/PRD.md#10. System States / Lifecycle", "docs/PRD.md#11. Analytics / Success Metrics"]
  }
}
```

### Phase 2: The health read

```forge-task
{
  "id": "RS-SUP-03",
  "title": "Expose one health read for the dashboard and the CLI",
  "description": "Implement src/supervision/health.js as the single aggregation the dashboard and the CLI both read: for each enrolled repository return its last successful collection, its consecutive failure count, whether it needs re-authentication, whether it is stalled, whether it is unavailable, and the reason for the most recent failure, plus a run-level summary of the last run. A repository with no successful collection yet must be reported as never collected rather than stalled, so a first-connect install is not alarmed at. The read must be a pure query over recorded state with no network access, and must return the same shape for a home with no data. The tests cover healthy, never-collected, degraded, needs-re-authentication, stalled and unavailable repositories in one archive.",
  "ownerAgent": "collector-engineer",
  "dependencies": ["RS-SUP-02"],
  "expectedOutputs": ["src/supervision/health.js", "tests/supervision-health.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/supervision-health.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/collection-supervision.md#RS-SUP-FR-03", "docs/PRD.md#RS-VR-03", "docs/PRD.md#RS-AX-07"],
    "acceptanceCriteria": ["A repository with a recent success reports healthy with its last success time", "A repository with no success ever reports never-collected and is not reported as stalled", "A repository with an authentication failure reports needs-re-authentication with the reason", "A home with no run rows returns an empty repository list and a run summary of never run, without error", "No network call is made by the read, asserted by a test that runs it with the transport disabled"],
    "constraints": ["No rendering and no styling in this task", "Every state is a named value with a text reason, not a boolean or a colour"],
    "constraintRefs": ["docs/features/collection-supervision.md#RS-SUP-CON-01", "docs/PRD.md#RS-TC-01"],
    "references": ["docs/PRD.md#10. System States / Lifecycle"]
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Failure classification and per-repository state | Representative failures per kind against a temporary database |
| Unit | Journal, heartbeat and stall detection | Injected clock, including the 25 and 27 hour boundary |
| Unit | Health aggregation | One archive containing all six repository states |
| Integration | Supervision inside a real run | Asserted by the collection end-to-end test and the dashboard end-to-end test |
| Human | A week of unattended operation | Seven-day soak review in the operations feature |

Key test scenarios:

1. Each of the six failure kinds classifies exactly one way.
2. A failure counter increments and resets on success.
3. A run writes its row before the first request and closes at the end.
4. An abandoned run is detected as unclosed.
5. The 26-hour stall boundary behaves as documented on both sides.
6. A never-collected repository is not reported as stalled.

---

## 8. Acceptance Criteria

1. A run that dies silently is visible in the product as an unclosed run and, after 26 hours, as a stalled repository.
2. An expired or under-permissioned token produces a named re-authenticate state, not a generic error.
3. One failing repository never prevents the others from collecting.
4. The dashboard and the CLI read the same health read and cannot disagree.
5. A first-connect install is not alarmed at before its first successful run.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Is 26 hours the right stall threshold? | Yes for a daily schedule, because it flags one missed slot without crying wolf on a single late run; the constant is exported so it can change |
| 2 | Should the dashboard show request counts? | Yes, per run, because an unexpected jump is usually a paging bug |
| 3 | Should an authentication failure stop the whole run immediately? | Yes for authentication, because every remaining repository would fail the same way; per-repository failures of every other kind continue |
