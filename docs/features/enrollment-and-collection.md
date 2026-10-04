# Feature: Enrollment and Collection

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C04 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-NF-01 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-NF-02 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-NF-07 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-NF-10 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-COL-ST-01 | This feature | owns |
| RS-COL-C01 | This feature | owns |
| RS-COL-C02 | This feature | owns |
| RS-COL-C03 | This feature | owns |
| RS-COL-C04 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Enrollment and Collection
**ID Prefix:** RS-COL
**Summary:** Choosing what to watch and reading it once a day: `discover` lists what the token can
reach and prints a configuration block the config parser has already proven loadable; enrollment
resolution applies the deny list and the per-repository flag; `collect` plans, dry-runs, and then
reads every enrolled repository once, writing identity, four traffic metrics, the star level and
snapshot captures in one transaction per repository.
**Dependencies:** Foundation and Runtime, GitHub API Client, Archive Storage
**Priority:** Must
**As-built status:** Built, covered by `tests/enrollment.test.js`, `tests/discover-command.test.js`,
`tests/collect-command.test.js`, `tests/collect-lifecycle.test.js`, `tests/collect-traffic.test.js`,
`tests/collect-snapshots.test.js` and `tests/integration/collect-e2e.test.js`.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-COL-ST-01 | Maintainer | the daily run to read each enrolled repository exactly once and stay idempotent when it runs twice, so that a schedule that fires twice costs nothing and loses nothing | Must |
| RS-COL-ST-02 | Maintainer | a planning mode that contacts nothing, so that I can see what a run would cost before letting it spend requests | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-COL-C01","kind":"constraint","text":"Enrollment resolution is pure and preserves declared order and spelling: the deny list wins in either declaration order and case-insensitively, an enabled flag of false removes a repository, case-only duplicates collapse to the first declared form, and nothing is read from disk, the clock or the network."}
```

```forge-requirement
{"id":"RS-COL-C02","kind":"constraint","text":"A dry run plans without reading a credential, opening a socket or writing anything, reports requests=0 and duration 0, and returns before the run journal is opened; the request policy, transport and credential are constructed only when the run is real."}
```

```forge-requirement
{"id":"RS-COL-C03","kind":"constraint","text":"Collection reads one repository identity request plus four traffic requests, adding a backfill floor of at least three requests only when the identity has no completed backfill and the star history has not already been refused; a repository recorded unavailable is skipped at zero requests."}
```

```forge-requirement
{"id":"RS-COL-C04","kind":"constraint","text":"Repositories are collected sequentially and each one is written in a single transaction that stores the confirmed identity, the returned traffic days, the star level observed that day, the snapshot captures and the success record; a repository that fails is recorded as evidence and never throws out of the run."}
```

```forge-requirement
{"id":"RS-COL-C05","kind":"constraint","text":"Only days GitHub returned are stored: a returned zero is stored as an observed zero, a day absent from the response is never written, never carried forward and never filled from another metric, and a stale replay applies nothing because the correction requires a newer collection time."}
```

```forge-requirement
{"id":"RS-COL-C06","kind":"constraint","text":"A rename or transfer is recorded as an alias and reported on the collection line, a mere respelling records no alias, an unavailable state is set only for a not-found answer and keeps its first reason, and a recorded backfill refusal is never requested again."}
```

---

## 4. Command and Output Design

Per-repository lines are `skipped`, `planned`, `ok`, `unavailable` or `failed`, and each carries the
lifecycle, the request count, the day and row counts, the snapshot count and the backfill state.
`ok` adds the star-history absence when GitHub refused that history, and adds the rename or transfer
when one happened. The run ends with a `summary` line carrying the run id, per-state repository
counts, days, rows, written, revised, unchanged, snapshots, backfilled rows, requests, duration and
the run status `completed` or `degraded`.

The budget is the part worth stating plainly: five requests per repository per run, plus at least
three once. A retried statistics answer is still one counted request with more than one attempt, and
that distinction is documented rather than hidden.

`discover` prints permission state, never the token and never its scopes, and prints its
configuration block only after the config parser has loaded it.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Enrollment resolution | Existing `tests/enrollment.test.js` |
| Unit | Run planning, dry run, per-repository outcomes | Existing `tests/collect-command.test.js` and `tests/collect-lifecycle.test.js` |
| Unit | Traffic day writes, snapshot appends | Existing `tests/collect-traffic.test.js`, `tests/collect-snapshots.test.js` |
| Integration | A full run against the loopback GitHub stub | Existing `tests/integration/collect-e2e.test.js` |
| Contract | Documented budget and line vocabulary against the code | Created by task RS-COL-CONTRACT-01 |

Key scenarios: a deny-listed repository is collected even when enrollment lists it first; a dry run
performs zero requests and writes nothing; a second run on the same day reports the days as unchanged
and writes nothing; a day missing from the response leaves a gap rather than a zero; a 404 marks the
repository unavailable and the next plan skips it at zero requests.

---

## 6. Implementation Tasks

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-COL-CONTRACT-01",
  "title": "Assert the documented request budget and collection line vocabulary against the code",
  "description": "The scheduled-collection runbook states the per-repository request budget, the backfill floor and the fact that a retried statistics answer is one counted request, and the troubleshooting runbook names the state words a collection line can carry. None of those numbers is tied to the code that produces them. Create `tests/contract-collect.test.js` that imports the budget constants from `src/collect/run.js` and asserts the numbers the runbooks print, that the per-repository line states named in the documents are exactly the outcome states the run produces, and that the documented budget equals one identity plus four traffic requests with the backfill floor added exactly once. Extend `docs/operations/scheduled-collection.md` with the one sentence that names where each number comes from. Do not change the budget, the plan or the line format, and do not add a request to any collection path.",
  "ownerAgent": "documentation-engineer",
  "dependencies": [],
  "expectedOutputs": ["tests/contract-collect.test.js", "docs/operations/scheduled-collection.md"],
  "validationCommands": ["npm test -- tests/contract-collect.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert the request budget, the backfill floor and the outcome-state vocabulary the documents publish are the values the collector produces"],
    "requirementRefs": [],
    "acceptanceCriteria": ["A test imports the budget constants and compares them with the figures printed in the scheduled-collection runbook", "A test asserts the documented outcome states equal the states a run can return", "A test asserts an unavailable repository is planned at zero requests", "tests/contract-collect.test.js reports more than zero executed tests"],
    "constraints": ["Do not change any request the collector makes or the format of a collection line", "Do not soften a documented number to match the code; a mismatch is the finding"],
    "constraintRefs": ["docs/features/enrollment-and-collection.md#RS-COL-C03", "docs/features/enrollment-and-collection.md#RS-COL-C04", "docs/PRD.md#RS-C12"],
    "references": ["docs/features/enrollment-and-collection.md#4. Command and Output Design", "docs/features/enrollment-and-collection.md#3. Functional Constraints"]
  }
}
```

---

## 7. Acceptance Criteria

1. A dry run contacts nothing, writes nothing and reports `requests=0`.
2. A real run costs five requests per repository per run, plus the backfill floor exactly once.
3. A repository is stored in one transaction, and a failure in one repository degrades the run
   without losing the others.
4. A day GitHub did not return is absent afterwards, never zero and never carried forward.
5. Running twice in one day changes nothing the second time.
6. The documented budget and line vocabulary are asserted by a named test against the code constants.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Collection is strictly sequential; should repositories be collected in parallel? | No: one failed repository must not change another repository's day, and the budget is easier to reason about sequentially |
| 2 | Should a day with no traffic at all be stored as an explicit zero? | The vendor already returns that day with a zero, and it is stored; only an absent day stays absent |
| 3 | The star level is stored from the identity response at no extra request; should forks and watchers follow it? | Not yet; each new series needs its own honest-gap and provenance decision |