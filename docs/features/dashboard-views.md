# Feature: Dashboard Views

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C04 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C12 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-NF-04 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-A11Y-01 | [Vision](../PRD.md#9-accessibility) | participates |
| RS-A11Y-02 | [Vision](../PRD.md#9-accessibility) | participates |
| RS-A11Y-03 | [Vision](../PRD.md#9-accessibility) | participates |
| RS-A11Y-04 | [Vision](../PRD.md#9-accessibility) | participates |
| RS-A11Y-05 | [Vision](../PRD.md#9-accessibility) | participates |
| RS-VWS-ST-01 | This feature | owns |
| RS-VWS-C01 | This feature | owns |
| RS-VWS-C02 | This feature | owns |
| RS-VWS-C03 | This feature | owns |
| RS-VWS-C04 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Dashboard Views
**ID Prefix:** RS-VWS
**Summary:** The four pages and the design tokens they share: an index and repository list of
enrolled repositories with their coverage and state, a repository detail page ordered so the answer
comes first, a collection health page that reports every state word in words, and a contrast-checked
stylesheet with no motion and no remote asset.
**Dependencies:** Dashboard Server, Chart and Insight, Archive Storage
**Priority:** Must
**As-built status:** Built, covered by `tests/views/repo-list.test.js`,
`tests/views/repo-detail.test.js`, `tests/views/health-view.test.js`, `tests/views/a11y.test.js`,
`tests/contrast.test.js` and `tests/legibility-spike.test.js`.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-VWS-ST-01 | Maintainer reading the repository page | the number I came for at the top, then the series behind it, then the caveats, so that a chart cannot be read past its own provenance | Must |
| RS-VWS-ST-02 | Maintainer using a keyboard or a screen reader | every page navigable by landmarks and headings with the state announced as a word, so that no reading depends on colour or on a pointer | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-VWS-C01","kind":"constraint","text":"Every chart is rendered through a helper that throws unless the markup holds exactly one figure, exactly one table with a caption and at least one row, a figure caption, and every aria-describedby reference resolving inside the figure; a view that pairs a chart with a table is not shippable without the pairing."}
```

```forge-requirement
{"id":"RS-VWS-C02","kind":"constraint","text":"State travels as a word as well as a class and a data attribute: every state is rendered as a state word with its reason beside it, and no meaning is carried by colour alone."}
```

```forge-requirement
{"id":"RS-VWS-C03","kind":"constraint","text":"An absent day prints as a named gap with the count and the sentence that those days are unmeasured rather than zero, an absent series prints that there is no stored value in the range, and a repository with nothing stored prints an empty state in words rather than an empty table."}
```

```forge-requirement
{"id":"RS-VWS-C04","kind":"constraint","text":"The health page prints its whole-archive roll-up, the repository list and the re-authentication section in that order, emits a machine-readable time element only for an instant it can parse and marks an unreadable recorded time as not machine-readable, and names the permission when re-authentication is what is needed."}
```

```forge-requirement
{"id":"RS-VWS-C05","kind":"constraint","text":"The stylesheet declares its colours as tokens whose contrast pairs are declared and checked by role, contains no transition, animation, keyframes, import, font-face or url function, and every colour reference goes through a token rather than a literal."}
```

```forge-requirement
{"id":"RS-VWS-C06","kind":"constraint","text":"Section headings are level two or below and never skip a level, the skip link is the first element of every document, each page has exactly one main landmark, and a named link always carries visible text rather than an address."}
```

---

## 4. Page and Section Design

The repository detail page answers, in this fixed order, and this order is the order the page renders:

1. **Current numbers** — the absolute value and the change for each daily metric in the window.
2. **Acquisition** — clones and unique cloners as charts, with their stored days.
3. **Interest** — views and unique visitors as charts, with their stored days.
4. **Comparison** — seven-day and week-over-week readings, each with its reason when withheld.
5. **Clones against stars** — the divergence reading, insufficient and reason-bearing below its floor.
6. **Changes** — the capped, dated change list per metric.
7. **Captures** — referrer and popular-path snapshots, newest first, labelled as snapshots with no day.
8. **Collection state** — the run word, the repository state word and the reason, and the last success.
9. **Provenance** — where collection began, which days are backfilled, and which backfills completed.

The answer the maintainer came for is at the top, the evidence sits behind it, and the caveats that
change how the evidence reads come last. Weekly development metrics are deliberately not charted on
this page: a week bucket beside day buckets invites a comparison the page cannot make honestly.

The index and list pages summarise each repository in one line: summed clones and views over the
window, the last unique-cloner and unique-visitor value with the day it was recorded, the named gap
days, and the state word with its reason.

The health page is the maintenance view: one roll-up word at the top, then every repository's state
and reason, then the repositories that need re-authentication and the permission they need.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Index and list rendering, columns, gaps, empty state | Existing `tests/views/repo-list.test.js` |
| Unit | Detail section order, charts, deltas, captures, provenance | Existing `tests/views/repo-detail.test.js` |
| Unit | Health sections, words, time elements | Existing `tests/views/health-view.test.js` |
| Unit | Chart pairing, headings, landmarks, skip link | Existing `tests/views/a11y.test.js` |
| Unit | Contrast pairs, no motion, token-only colour | Existing `tests/contrast.test.js` |
| Integration | Every page against the running server | Existing `tests/integration/dashboard-e2e.test.js` |
| Contract | Section 4 order, the code's citation of it, and the printed gap wording | Created by task RS-VWS-CONTRACT-01 |

Key scenarios: the detail page emits its nine sections in the documented order; a chart without its
table is refused at render time; a repository with no stored value prints the empty state rather than
an empty table; a gap cell ends with the sentence that the days are unmeasured; a recorded time that
cannot be parsed renders as text marked not machine-readable; the stylesheet contains no animation
and no colour literal.

---

## 6. Implementation Tasks

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-VWS-CONTRACT-01",
  "title": "Assert the section 4 order, the citation of it, and the printed gap wording",
  "description": "`src/server/views/repo-detail.js` cites section 4 of this document as the authority for the order in which the detail page renders its sections, and the README promises that gaps are named rather than drawn as zeros. Create `tests/contract-views.test.js` asserting that the order listed in section 4 equals the exported detail section order, that this document still carries a section 4 and still lists all nine sections in that order, that the gap and empty-state sentences the pages print match the wording this document and the README publish, and that every state word a view can render is also a word the health read can return. Where the page and the document disagree, fix the document and note the disagreement; do not reorder a page to satisfy the test without also changing section 4 and the code comment that cites it. Do not change the section order, the rendered wording or the state vocabulary.",
  "ownerAgent": "documentation-engineer",
  "dependencies": [],
  "expectedOutputs": ["tests/contract-views.test.js"],
  "validationCommands": ["npm test -- tests/contract-views.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert the documented detail section order equals the rendered order, and that the gap and empty-state wording matches what the pages print"],
    "requirementRefs": [],
    "acceptanceCriteria": ["A test compares the nine sections in section 4 with the exported detail section order", "A test fails when this document loses its section 4 or a section", "A test asserts the gap sentence and the no-stored-value sentence the pages print are the documented ones", "tests/contract-views.test.js reports more than zero executed tests"],
    "constraints": ["Do not change the detail section order, the chart set or the rendered wording", "Do not remove the comment in src/server/views/repo-detail.js that cites this document"],
    "constraintRefs": ["docs/features/dashboard-views.md#RS-VWS-C03", "docs/features/dashboard-views.md#RS-VWS-C02", "docs/PRD.md#RS-C12"],
    "references": ["docs/features/dashboard-views.md#4. Page and Section Design", "docs/features/dashboard-views.md#3. Functional Constraints"]
  }
}
```

---

## 7. Acceptance Criteria

1. The detail page renders its nine sections in the order section 4 documents.
2. Every chart ships with a captioned data table, and a view that would break the pairing refuses to
   render.
3. Gaps, empty series and empty archives each print in words, never as a silent blank or a zero.
4. Every state is rendered as a word with its reason, and colour carries no meaning.
5. Contrast meets AA for the declared pairs, and the stylesheet has no motion, no remote import and
   no colour literal.
6. The documented order and wording are asserted by a named test.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the index and list pages be one page rather than two routes | Keep both: the route exists so a bookmark keeps working, and they render the same summary |
| 2 | Should the detail page chart the weekly development metrics at all | Not yet: a week bucket beside day buckets invites a comparison the page cannot justify |
| 3 | Named gap days are capped at ten in the list and full count beside them | Keep it; the count carries the weight the list cannot |