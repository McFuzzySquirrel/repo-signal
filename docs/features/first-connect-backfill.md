# Feature: First Connect Backfill

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-VR-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-ST-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-BKL-FR-01 | This feature | owns |
| RS-BKL-FR-02 | This feature | owns |
| RS-BKL-FR-03 | This feature | owns |
| RS-BKL-FR-04 | This feature | owns |
| RS-BKL-CON-01 | This feature | owns |
| RS-BKL-ST-01 | This feature | owns |
| RS-BKL-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** First Connect Backfill
**ID Prefix:** RS-BKL
**Summary:** The history that GitHub will still hand over once, on first connect: full star
history, 52 weeks of development activity, and the provenance record that lets the dashboard say
where collected data begins.
**Dependencies:** Telemetry Storage and Migrations, GitHub API Client
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-BKL-ST-01","kind":"story","text":"As a solo maintainer I want my star history reconstructed on the day I connect, so that the first chart already has a left-hand side."}
```

```forge-requirement
{"id":"RS-BKL-ST-02","kind":"story","text":"As a solo maintainer I want the product to record where the collected history starts, so that I never read a short archive as a quiet project."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-BKL-FR-01","kind":"requirement","text":"Reconstruct the full star history on first connect by consuming every stargazer page, turning each star timestamp into a cumulative day-series value, and writing those rows with source backfill. Re-running the backfill must converge on the same rows rather than duplicating them, and days before the repository's first star must not be invented."}
```

```forge-requirement
{"id":"RS-BKL-FR-02","kind":"requirement","text":"Backfill 52 weeks of weekly commit activity and owner participation, writing them with the week granularity rather than the day granularity, and record a backfill entry stating the window that was actually available and whether it was shorter than a year."}
```

```forge-requirement
{"id":"RS-BKL-FR-03","kind":"requirement","text":"Record provenance per repository: when backfill completed, which backfills ran, the first day for which collected data exists, and whether that first collected day is today. Expose it as a single provenance read the dashboard can label from, so that a page can distinguish backfilled days, collected days and the days that were never available."}
```

```forge-requirement
{"id":"RS-BKL-CON-01","kind":"constraint","text":"Backfill never fabricates acquisition data. Clones, views, referrers and popular paths are not backfilled in any form, and no day between the first star and today is filled with a zero, a carry-forward or an estimate."}
```

```forge-requirement
{"id":"RS-BKL-FR-04","kind":"requirement","text":"Store the star level a collection already observes. Every collection resolves the repository through the GitHub client, which reads the repository's stargazer count, and that count is currently discarded; write it as a cumulative stars day fact for the collection's own UTC day with source collected, inside the same per-repository transaction as the traffic facts, so a star level can never commit without the traffic it was collected alongside and a rollback loses both. No additional request is made. A collected level replaces a reconstructed one for the same day under the archive's existing last-write-wins rule, a repeated collection on the same day leaves one row, and a level lower than the one stored is a real observation and is written rather than suppressed. The result is a star series that is continuous from the first collection onward instead of holding a row only on the days a star arrived, which is what lets a stars-versus-cloner reading pair its two series. The rows the backfill reconstructed before collection are left in place, and each day's provenance continues to be recorded through the existing source column rather than a new one."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-BKL-ST-01 | story | Must |
| RS-BKL-ST-02 | story | Must |
| RS-BKL-FR-01 | requirement | Must |
| RS-BKL-FR-02 | requirement | Must |
| RS-BKL-FR-03 | requirement | Must |
| RS-BKL-FR-04 | requirement | Must |
| RS-BKL-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

The backfill has no direct interface. Its visible effect is the provenance boundary the dashboard
draws: a marked line at the first collected day, a distinct legend entry for backfilled days, and
a first-connect label stating that the window before that line is "since connection, not history".

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-BKL-01 | Star history becomes cumulative day rows marked as backfill | github-integration-engineer | RS-API-04, RS-DB-03 | src/backfill/stars.js, tests/backfill-stars.test.js | cumulative curve, idempotent rerun, no invented leading days, sparse input | Development activity, provenance |
| RS-BKL-02 | A year of weekly development activity is stored as week rows | github-integration-engineer | RS-API-04, RS-DB-03 | src/backfill/development.js, tests/backfill-development.test.js | week granularity, short window flagged, 202 handled upstream | Star history, collection runs |
| RS-BKL-03 | Provenance answers where collected history begins | github-integration-engineer | RS-BKL-01, RS-BKL-02 | src/backfill/provenance.js, tests/provenance.test.js | first collected day, not-connected state, backfill record | Dashboard rendering |
| RS-BKL-04 | The star level a collection already fetched becomes a daily observation | collector-engineer | RS-BKL-01, RS-BKL-03, RS-COL-01, RS-API-04 | src/collect/lifecycle.js, src/collect/run.js, tests/collect-command.test.js | row written in the traffic transaction, idempotent per day, lower level stored | Request count, summary line, schema |

---

## 6. Implementation Tasks

### Phase 1: Reconstructable history

```forge-task
{
  "id": "RS-BKL-01",
  "title": "Reconstruct the full star history as cumulative day rows",
  "description": "Implement src/backfill/stars.js to consume every stargazer page from src/github/stars-client.js and write through src/db/day-series-repo.js, group the star timestamps by UTC day, and write a cumulative star count per day through the day-series repository with source backfill. Days before the first recorded star must be left absent rather than written as zero, and a repository with no stars yields no rows and no error. Re-running must converge: the same input produces the same rows through the upsert, never duplicates. The tests cover a dense history, a history with a multi-day gap between stars, a repository with no stars, and a second identical run asserted to leave the row count unchanged.",
  "ownerAgent": "github-integration-engineer",
  "dependencies": ["RS-API-04", "RS-DB-03"],
  "expectedOutputs": ["src/backfill/stars.js", "tests/backfill-stars.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/backfill-stars.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/first-connect-backfill.md#RS-BKL-FR-01", "docs/PRD.md#RS-VR-01"],
    "acceptanceCriteria": ["Three stars on two distinct days produce two rows whose values are the running total", "No row is written for a day before the first star", "A repository with no stars produces no rows and no error", "Running the backfill twice over the same input leaves the row count unchanged", "Every written row carries source backfill and a collection timestamp"],
    "constraints": ["Do not backfill clones, views, referrers or popular paths", "Do not interpolate or zero-fill a missing day"],
    "constraintRefs": ["docs/features/first-connect-backfill.md#RS-BKL-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-TC-02"],
    "references": ["docs/PRD.md#3.2 Non-Goals"]
  }
}
```

```forge-task
{
  "id": "RS-BKL-02",
  "title": "Backfill a year of weekly development activity",
  "description": "Implement src/backfill/development.js to fetch weekly commit activity and owner participation through src/github/stats-client.js, map them into day-series rows that carry the week granularity and a week-start day, and write them with source backfill. A 202 response is a normal retryable outcome handed to the existing retry policy, not a failure. When the endpoint returns fewer than 52 weeks, record a backfill entry with the window that was actually available and a truncated flag rather than padding the series. The tests cover a full 52-week response, a short response asserting the truncated flag and the stored window, and an empty response yielding no rows and a recorded backfill entry.",
  "ownerAgent": "github-integration-engineer",
  "dependencies": ["RS-API-04", "RS-DB-03"],
  "expectedOutputs": ["src/backfill/development.js", "tests/backfill-development.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/backfill-development.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/first-connect-backfill.md#RS-BKL-FR-02", "docs/PRD.md#RS-VR-01"],
    "acceptanceCriteria": ["A 52-week response produces 52 rows at week granularity whose first day is a week start", "A 20-week response produces 20 rows and a backfill record whose stored window is 20 weeks with the truncated flag set", "An empty response produces no rows and still records a backfill entry", "No development row is written at day granularity"],
    "constraints": ["Do not page through commit or issue history; the weekly statistics endpoints are the only source used", "Do not backfill acquisition metrics"],
    "constraintRefs": ["docs/features/first-connect-backfill.md#RS-BKL-CON-01", "docs/PRD.md#RS-TC-02"],
    "references": ["docs/PRD.md#13. Future Considerations"]
  }
}
```

### Phase 2: Provenance

```forge-task
{
  "id": "RS-BKL-03",
  "title": "Record and expose where collected history begins",
  "description": "Implement src/backfill/provenance.js as the one read the dashboard labels from. It must report, per repository, whether backfill has completed and which backfills ran, the first day for which collected data exists, and whether that day is today. A repository that has never had a successful collection must report not-connected rather than a first day, and stamping the first collected day must happen exactly once so a later run cannot move the boundary. Provide the function a collection run can call when it writes its first fact, and expose a not-connected state the dashboard can render as a first-connect label. The tests cover a repository never collected, a repository collected today, and a second stamp attempt leaving the original boundary in place.",
  "ownerAgent": "github-integration-engineer",
  "dependencies": ["RS-BKL-01", "RS-BKL-02"],
  "expectedOutputs": ["src/backfill/provenance.js", "tests/provenance.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/provenance.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/first-connect-backfill.md#RS-BKL-FR-03", "docs/PRD.md#RS-VR-02"],
    "acceptanceCriteria": ["A repository with no collected data reports not-connected and no first collected day", "The first collection stamps the day once and a second call leaves the original day unchanged", "A repository whose first collected day is today is reported as connected today", "The provenance read lists which backfill kinds have completed for the repository"],
    "constraints": ["Provenance records facts only; it renders nothing and imports no view module", "Do not infer a first collected day from the earliest stored row of any metric"],
    "constraintRefs": ["docs/features/first-connect-backfill.md#RS-BKL-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-TC-02"],
    "references": ["docs/PRD.md#10. System States / Lifecycle"]
  }
}
```

### Phase 3: The observed star level

```forge-task
{
  "id": "RS-BKL-04",
  "title": "Store the star level each collection already observes",
  "description": "The GitHub repository client reads stargazers_count on every resolve and src/collect/lifecycle.js discards it, so a collection throws away a cumulative star level it has already paid for. Widen RemoteRepository to carry that count, validated as a non-negative safe integer the way the client already validates it, and pass it through confirmRepository. Write it in src/collect/run.js as a stars day fact for the collection's own UTC day with source collected, inside the same transaction body that already calls recordIdentity, writeTrafficDays and writeSnapshotCaptures, so a star level can never commit without the traffic facts it was collected alongside and a rollback loses both. Make no additional request. A collected level must replace a reconstructed one for the same day under the existing last-write-wins upsert, a repeated collection on the same day must leave one row, and a level lower than the stored one must be written rather than suppressed, because a level that fell is a real observation. The rows the backfill reconstructed before collection are left untouched, and the collected summary line keeps counting traffic rows only so its counts do not change meaning. Note in src/insight/divergence.js that the stored star level is a snapshot taken at collection time while the traffic figures cover the whole day, so the ratio the reading reports is not strictly co-temporal.",
  "ownerAgent": "collector-engineer",
  "dependencies": ["RS-BKL-01", "RS-BKL-03", "RS-COL-01", "RS-API-04"],
  "expectedOutputs": ["src/collect/lifecycle.js", "src/collect/run.js", "src/insight/divergence.js", "tests/collect-command.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/collect-command.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/first-connect-backfill.md#RS-BKL-FR-04", "docs/features/chart-and-insight.md#RS-VIZ-FR-04"],
    "acceptanceCriteria": [
      "A collection writes a stars day fact for its own UTC day carrying the count the repository response held, with source collected and the collection timestamp",
      "That row is written in the same transaction as the traffic facts: a run that fails to write its traffic leaves no star row either",
      "A second collection on the same day leaves one stars row rather than adding another",
      "A count lower than the stored one for the same day is written, and the row still holds the lower value",
      "A stars row the backfill wrote for an earlier day is left exactly as it was",
      "The request count of a collection is unchanged by this write",
      "The collected summary line still reports the same written, revised and unchanged counts as before"
    ],
    "constraints": [
      "Make no additional request and add no runtime dependency",
      "Add no migration and no new column: provenance stays in the existing source column",
      "Do not change what the summary line counts"
    ],
    "constraintRefs": ["docs/features/first-connect-backfill.md#RS-BKL-CON-01", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-SC-02", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#8. Security and Privacy", "docs/features/chart-and-insight.md#RS-VIZ-FR-05"]
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Star history grouping, cumulative curve, idempotency | Stargazer client stub returning scripted pages |
| Unit | Weekly activity mapping and window recording | Statistics client stub returning 52, 20 and 0 week responses |
| Unit | Provenance reads and boundary stamping | In-process against a temporary migrated database |
| Human | Real endpoints and their media types | Live verification in the operations feature |

Key test scenarios:

1. Stars on two days produce a running total with no invented leading days.
2. A repeated backfill leaves the row count unchanged.
3. A 20-week statistics response is stored and flagged as truncated.
4. A repository with no collected data reports not-connected.
5. Stamping the first collected day twice keeps the original day.

---

## 8. Acceptance Criteria

1. First connect produces a star history that starts at the first star and is monotonic.
2. A year of weekly development activity is available as week rows, honestly flagged when short.
3. Clones, views, referrers and popular paths are never backfilled.
4. The dashboard can state the first collected day and the first-connect label from one read.
5. Re-running backfill never duplicates or rewrites a stored row.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should star history be paged fully on a 40,000-star repository? | Yes, with per_page at the maximum the endpoint allows and progress logged, because a truncated star curve would be a silent lie |
| 2 | What if a repository has more than 10,000 commits? | The weekly endpoints return zeros rather than failing; the truncated flag on the backfill record is what tells the maintainer the development signal is unreliable there |
| 3 | Should backfill re-run later to catch newly star-gated history? | No. Backfill is a first-connect operation; a later run is collection |
