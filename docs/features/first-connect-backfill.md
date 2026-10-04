# Feature: First-Connect Backfill

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C04 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C13 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-NF-01 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-BKL-ST-01 | This feature | owns |
| RS-BKL-C01 | This feature | owns |
| RS-BKL-C02 | This feature | owns |
| RS-BKL-C03 | This feature | owns |
| RS-BKL-C04 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** First-Connect Backfill
**ID Prefix:** RS-BKL
**Summary:** The history that exists before the first collection: a weekly star history converted
into cumulative day rows labelled `backfill`, a 52-week development reconstruction from the free
statistics endpoints, a refusal that is recorded once and never requested again, and the provenance
read that says where collection actually began.
**Dependencies:** GitHub API Client, Archive Storage, Enrollment and Collection
**Priority:** Must
**As-built status:** Built, covered by `tests/backfill-stars.test.js`,
`tests/backfill-development.test.js`, `tests/provenance.test.js` and the refusal assertions in
`tests/collect-lifecycle.test.js`. The documented provenance claims are not yet asserted by a test,
which is the single outstanding task below.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-BKL-ST-01 | Maintainer connecting for the first time | the star and development history the vendor already holds reconstructed into the archive, so that the first chart is not an empty fourteen days | Must |
| RS-BKL-ST-02 | Maintainer whose star history GitHub will not serve | the refusal recorded once and reported on every run, so that a missing series is never mistaken for a repository nobody starred | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-BKL-C01","kind":"constraint","text":"A weekly star history becomes cumulative day rows labelled backfill: weeks are ordered oldest first, a week that is not a positive whole number of days since the epoch is counted and skipped rather than shifted, a repeated week start is refused by name, and a day is emitted only when its cumulative count is non-zero."}
```

```forge-requirement
{"id":"RS-BKL-C02","kind":"constraint","text":"Development history is reconstructed from commit activity and participation as weekly rows labelled backfill, with the participation owner series anchored positionally to the commit-activity week starts so the two series cannot drift apart, and the record is marked truncated whenever fewer than 52 weeks were returned."}
```

```forge-requirement
{"id":"RS-BKL-C03","kind":"constraint","text":"A backfill that cannot complete writes its completed-backfill record for the parts that did complete, except when the statistics endpoint is still compiling, which writes nothing at all and is retried; the observed window is recorded with the record."}
```

```forge-requirement
{"id":"RS-BKL-C04","kind":"constraint","text":"A refused backfill is recorded on the repository with the first reason and the first refusal time, is never requested again, keeps the traffic half of the collection running, and is reported on every collection line as a star-history absence rather than left as a gap that would read as a zero."}
```

```forge-requirement
{"id":"RS-BKL-C05","kind":"constraint","text":"The first collected day is stamped exactly once by a conditional insert, so a later run cannot move the provenance boundary, and the provenance read reports whether the repository is connected, when collection began and which backfills completed, without counting the boundary stamp as a backfill."}
```

---

## 4. Data Shape

| Series | Metric | Granularity | Source | Built from |
|--------|--------|-------------|--------|------------|
| Star history | `stars` | day | `backfill` | weekly stargazer history, made cumulative |
| Star level | `stars` | day | `collected` | the identity response of every later collection, at no extra request |
| Development | `commit-activity` | week | `backfill` | commit activity totals |
| Development | `owner-participation` | week | `backfill` | the participation owner series, anchored to the same week starts |

The two sources share one metric key and are told apart by their source label, which is why every
reader has to carry provenance rather than assuming a day is observed. The boundary between them is
the first collected day, and it is the line the chart draws.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Cumulative star days, week alignment, repeated weeks, truncation | Existing `tests/backfill-stars.test.js` |
| Unit | Development weeks, positional anchoring, empty and compiling outcomes | Existing `tests/backfill-development.test.js` |
| Unit | Boundary stamp and provenance read | Existing `tests/provenance.test.js` |
| Unit | Refusal recording and its first-reason rule | Existing `tests/collect-lifecycle.test.js` |
| Integration | A first connect end to end against the stub | Existing `tests/integration/collect-e2e.test.js` |
| Contract | Documented provenance claims against the modules | Created by task RS-BKL-CONTRACT-01 |

Key scenarios: a star history whose weeks do not align to a day boundary skips and counts rather than
shifting a week; a participation series shorter than the commit activity produces no row for the
missing position; a repeated week start is refused; a statistics `202` writes no completed-backfill
record; a refused star history is not requested on the next run while development still runs.

---

## 6. Implementation Tasks

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-BKL-CONTRACT-01",
  "title": "Assert the documented provenance and refusal claims against the modules that keep them",
  "description": "The README and the runbooks state that backfilled days are labelled rather than collected, that the boundary is stamped once, and that a refused star history is recorded and reported rather than re-requested. No test asserts those sentences against the code that implements them. Create `tests/contract-backfill.test.js` asserting that the backfill modules write only source backfill rows, that the completed-backfill records the runbooks mention are exactly the rows the provenance read counts, that the refusal columns on a repository keep the first reason and are consulted by the plan so a refused history costs no request on a later run, and that the boundary stamp is written by a single conditional insert. Do not change any reconstruction rule, do not relabel a stored row, and do not make a refused backfill retryable.",
  "ownerAgent": "documentation-engineer",
  "dependencies": [],
  "expectedOutputs": ["tests/contract-backfill.test.js"],
  "validationCommands": ["npm test -- tests/contract-backfill.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert the documented provenance, boundary and single-refusal claims hold against the modules that implement them"],
    "requirementRefs": [],
    "acceptanceCriteria": ["A test proves the reconstruction modules write source backfill and never source collected", "A test proves a refused history keeps its first reason and is not requested again by a later plan", "A test proves the boundary stamp is a single conditional insert that a second run cannot move", "tests/contract-backfill.test.js reports more than zero executed tests"],
    "constraints": ["Do not modify src/backfill/* or the refusal columns", "Do not convert a backfilled row into a collected one"],
    "constraintRefs": ["docs/features/first-connect-backfill.md#RS-BKL-C04", "docs/features/first-connect-backfill.md#RS-BKL-C05", "docs/PRD.md#RS-C04", "docs/PRD.md#RS-C13", "docs/PRD.md#RS-C12"],
    "references": ["docs/features/first-connect-backfill.md#4. Data Shape", "docs/features/first-connect-backfill.md#3. Functional Constraints"]
  }
}
```

---

## 7. Acceptance Criteria

1. Every reconstructed row carries the backfill source, and no collected row is ever relabelled.
2. The first collected day is written once and cannot be moved by a later run.
3. A refused star history is recorded once, reported on every collection line, and never requested
   again, while traffic continues to be collected.
4. Development history is marked truncated whenever the vendor returned fewer than 52 weeks.
5. A statistics answer of "still compiling" writes no completed-backfill record and is retried.
6. Each documented provenance claim above is asserted by a named test.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | The star history endpoint has no permission control and could one day be restricted like the listing was | Keep the refusal path: it is already recorded once, reported and never retried |
| 2 | Should the participation series be stored when it is shorter than the commit series? | No: anchoring it positionally is the only way to keep the two series comparable |
| 3 | Star history is day-granular after conversion while development stays weekly | Keep it: day-level stars answer the stars-versus-cloners reading the dashboard makes |