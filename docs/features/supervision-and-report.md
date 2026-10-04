# Feature: Collection Supervision and Report

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C04 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C09 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-NF-10 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-ST-03 | [Vision](../PRD.md#4-personas) | participates |
| RS-SUP-ST-01 | This feature | owns |
| RS-SUP-ST-02 | This feature | owns |
| RS-SUP-C01 | This feature | owns |
| RS-SUP-C02 | This feature | owns |
| RS-SUP-C03 | This feature | owns |
| RS-SUP-C04 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Collection Supervision and Report
**ID Prefix:** RS-SUP
**Summary:** The evidence that says whether collection is still happening, and the plain-text reading
of what the archive holds: a run journal with a heartbeat written before the first request, a
failure classifier that turns a transport or policy error into one of six kinds with a named next
command, per-repository state that survives a restart, and the `report` command that prints the same
facts to a terminal and to a cron log.
**Dependencies:** Archive Storage, Enrollment and Collection
**Priority:** Must
**As-built status:** Built, covered by `tests/supervision-journal.test.js`,
`tests/supervision-errors.test.js`, `tests/supervision-health.test.js` and
`tests/report-command.test.js`.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-SUP-ST-01 | Maintainer whose schedule stopped | one state word and a next command for every failure mode, so that I know whether to fix a token, grant a permission or wake a machine | Must |
| RS-SUP-ST-02 | Maintainer reading a cron log | a report that names the run state, the recorded boundary and the gap days in words, so that I never have to open a browser to know what the archive holds | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-SUP-C01","kind":"constraint","text":"A run journal writes the run row and its heartbeat in one transaction before the first request, refuses to open twice, closes the run row even when the heartbeat could not tick, and reports a tick whose clock has not advanced as unrecorded with a named reason rather than faking a time."}
```

```forge-requirement
{"id":"RS-SUP-C02","kind":"constraint","text":"A failure is classified into exactly one of authentication-rejected, permission-missing, repository-missing, rate-limited, transient or unexpected; the classifier prefers the typed kind from the transport or policy, places a bare status, then a bare transport code, redacts the message, and every non-unexpected action names a registered command."}
```

```forge-requirement
{"id":"RS-SUP-C03","kind":"constraint","text":"Recording a failure appends error evidence and raises the consecutive-failure counter as one unit, recording a success resets the counter and the last-success time while keeping the evidence, and a supervision write that itself fails is swallowed so it can never turn into a collection crash."}
```

```forge-requirement
{"id":"RS-SUP-C04","kind":"constraint","text":"Repository health is a closed vocabulary of healthy, never-collected, degraded, needs-re-authentication, stalled, unavailable and unreadable, resolved by a fixed precedence, with stalled meaning a last success more than 26 hours old and unreadable meaning a recorded time the build cannot parse; every state carries a reason that begins with the state phrase."}
```

```forge-requirement
{"id":"RS-SUP-C05","kind":"constraint","text":"The report command contacts no host, reads no credential, exits 0 whenever it read the archive whatever states it reports, and prints the run state, the roll-up, one line per enrolled repository and, for one repository, its coverage per series, its named gap days, its star-history refusal, its recorded boundary and its change blocks."}
```

```forge-requirement
{"id":"RS-SUP-C06","kind":"constraint","text":"Named gap days are capped at ten per series with the remainder counted, absolute values are always printed beside a percentage, and a week-granularity series is described in weeks rather than days."}
```

---

## 4. Command and Output Design

`report` opens with its scope and a rule, names the home and the instant it read, prints the most
recent run state with its counts, the roll-up with `of N enrolled`, and one line per repository with
its state word and reason. With `--repo` it adds a coverage line per series, a refusal line, a
boundary block and four change blocks. `--from` and `--to` narrow the window; the command refuses a
repository outside the enrolled set before opening the archive.

`collectionHealth` is the single read the dashboard and the CLI share. It reports the instant read,
each repository's state and reason, the run word with its unclosed-run count, and a roll-up word
that is `empty` when nothing is enrolled. A repository is `unreadable` rather than `stalled` when
its recorded time cannot be parsed, because a value the build cannot read is a different problem
from one that is late.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Journal start, progress, close, heartbeat ticks, stall maths | Existing `tests/supervision-journal.test.js` |
| Unit | Classification of every status and transport code | Existing `tests/supervision-errors.test.js` |
| Unit | State precedence, phrases, roll-up | Existing `tests/supervision-health.test.js` |
| Unit | Report argument parsing and rendered output | Existing `tests/report-command.test.js` |
| Contract | Documented report shape against the formatter | Created by task RS-SUP-CONTRACT-01 |
| Integration | Health page and running server | Existing `tests/integration/dashboard-e2e.test.js` |

Key scenarios: a journal that cannot tick still closes its run row; a 403 names the traffic permission
rather than saying "forbidden"; a heartbeat older than the opening tick is refused; a repository with
no recorded success is `never-collected` and not `stalled`; a report over an archive holding nothing
still exits 0.

---

## 6. Implementation Tasks

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-SUP-CONTRACT-01",
  "title": "Assert the documented report shape and state vocabulary against the formatter and health read",
  "description": "The README and the runbooks describe what `report` prints, the state words it can print, and the cap on named gap days, and the dashboard's health page promises the same vocabulary. Those descriptions are not tied to `src/report/format.js` or `src/supervision/health.js`. Create `tests/contract-report.test.js` asserting that every state word the troubleshooting runbook names is one the health read can return, that the run and repository word lists match the constants, that the named-gap cap the documents state equals the formatter's, that the boundary block has a wording for each of its four boundary situations and none for an absent boundary, and that a report which read the archive exits 0 whatever states it printed. Do not change the formatter, the state vocabulary or the exit code, and do not rename a state word that a runbook or a view already prints.",
  "ownerAgent": "documentation-engineer",
  "dependencies": [],
  "expectedOutputs": ["tests/contract-report.test.js"],
  "validationCommands": ["npm test -- tests/contract-report.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert the documented report output shape and state vocabulary match the formatter and the health read"],
    "requirementRefs": [],
    "acceptanceCriteria": ["A test asserts every state word named in the troubleshooting runbook is a word the health read can return", "A test asserts the named-gap cap in the documents equals the formatter constant", "A test asserts a report that read the archive exits 0 while printing a degraded repository", "tests/contract-report.test.js reports more than zero executed tests"],
    "constraints": ["Do not modify src/report/format.js or src/supervision/health.js", "Do not add a state word to one place and not the other"],
    "constraintRefs": ["docs/features/supervision-and-report.md#RS-SUP-C04", "docs/features/supervision-and-report.md#RS-SUP-C05", "docs/features/supervision-and-report.md#RS-SUP-C06", "docs/PRD.md#RS-C12", "docs/PRD.md#RS-C09"],
    "references": ["docs/features/supervision-and-report.md#4. Command and Output Design", "docs/features/supervision-and-report.md#3. Functional Constraints"]
  }
}
```

---

## 7. Acceptance Criteria

1. Every collection failure ends up as exactly one state word with a reason that names a real command.
2. A run that was interrupted shows `unclosed`; a repository whose last success is older than 26 hours
   shows `stalled`; one that has never succeeded shows `never-collected`.
3. A supervision write that fails never turns a collection into a crash.
4. `report` contacts no host, reads no credential, and exits 0 whenever it read the archive.
5. Gaps are named, capped and counted, and absolute values always accompany a percentage.
6. The documented report shape and state vocabulary are asserted by a named test.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | The stall threshold is 26 hours; should it be configurable? | No: one number the runbook states is easier to trust than a setting |
| 2 | `unreadable` is a distinct state from `stalled`; should an unreadable time be repaired automatically? | No; the operator decides, and the dashboard shows the reason |
| 3 | Should `report` also print the request count of the most recent run? | It already prints the run counts; a separate request line would duplicate the collect line |