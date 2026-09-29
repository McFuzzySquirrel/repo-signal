# Feature: Chart and Insight Rendering

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-HO-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-AX-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-AX-03 | [Vision](../PRD.md#9. Accessibility) | participates |
| RS-AX-04 | [Vision](../PRD.md#9. Accessibility) | participates |
| RS-PR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-ST-03 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-VIZ-FR-01 | This feature | owns |
| RS-VIZ-FR-02 | This feature | owns |
| RS-VIZ-FR-03 | This feature | owns |
| RS-VIZ-FR-04 | This feature | owns |
| RS-VIZ-FR-05 | This feature | owns |
| RS-VIZ-CON-01 | This feature | owns |
| RS-VIZ-ST-01 | This feature | owns |
| RS-VIZ-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Chart and Insight Rendering
**ID Prefix:** RS-VIZ
**Summary:** The descriptive layer. Week-over-week and seven-day deltas, a stars-versus-clones
divergence reading, a flat list of what changed, and one hand-rolled SVG line chart that draws a
gap as a gap and marks where collected history begins.
**Dependencies:** None
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-VIZ-ST-01","kind":"story","text":"As a solo maintainer I want to compare this week with the week before, so that I can see movement without reading raw numbers."}
```

```forge-requirement
{"id":"RS-VIZ-ST-02","kind":"story","text":"As a solo maintainer I want a stars-versus-clones comparison, so that I can notice a project that is used more than it is recognised, or the reverse."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-VIZ-FR-01","kind":"requirement","text":"Compute, for any metric and any day range, the last seven days against the seven days before them and the last complete week against the week before it. When either window is missing a stored day, return an explicit insufficient-data result naming the missing days; when the base is zero, return the absolute change and suppress the percentage rather than dividing."}
```

```forge-requirement
{"id":"RS-VIZ-FR-02","kind":"requirement","text":"Compute a stars-versus-clones divergence reading as the ratio of unique cloners to stars over the selected range, with a plain directional label describing which is larger, an absolute value beside any percentage, and an insufficient-data result when the range has too few collected days to say anything. It must never produce a score, a grade, a threshold verdict or a trend claim."}
```

```forge-requirement
{"id":"RS-VIZ-FR-03","kind":"requirement","text":"Produce a flat, dated list of what changed: for each day whose value differs from the previous stored day, an entry naming the metric, the date, the previous value and the new value, sorted by the absolute change. A day with no stored value produces no entry and is never described as a drop to zero."}
```

```forge-requirement
{"id":"RS-VIZ-FR-04","kind":"requirement","text":"Render a metric series as deterministic inline SVG from a pure function over the observation array: a polyline per contiguous run of stored days, a visible break where a day is missing, a labelled axis, no charting dependency, and a paired data table carrying the same values and naming the gap days in text. The function performs no I/O and returns identical markup for identical input."}
```

```forge-requirement
{"id":"RS-VIZ-FR-05","kind":"requirement","text":"Annotate chart output with provenance: a boundary marker at the first collected day, a distinct treatment for backfilled days, a legend naming both, and a first-connect caption stating that the window before the boundary is since connection rather than history."}
```

```forge-requirement
{"id":"RS-VIZ-CON-01","kind":"constraint","text":"No output of this feature contains an adoption score, a composite ranking, a threshold, an anomaly claim, or directional wording such as increasing, surging or declining. Every claim is a number, a difference, or an explicit statement that the data is insufficient."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-VIZ-ST-01 | story | Must |
| RS-VIZ-ST-02 | story | Must |
| RS-VIZ-FR-01 | requirement | Must |
| RS-VIZ-FR-02 | requirement | Must |
| RS-VIZ-FR-03 | requirement | Must |
| RS-VIZ-FR-04 | requirement | Must |
| RS-VIZ-FR-05 | requirement | Must |
| RS-VIZ-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

The chart is one SVG with a fixed viewBox, a left axis carrying at most five ticks, a
bottom axis carrying the first day, the boundary day and the last day, and a legend of two
entries: backfilled and collected. A missing day breaks the line; it is never bridged. The paired
data table is visually collapsed behind a disclosure control but present in the markup, so a
screen reader and a text browser both reach the numbers.

The delta panel states absolute values first. The divergence panel states the two absolute
numbers, then the ratio, then a sentence that only compares the two. The change list is ordered
newest first with no grouping, no icons and no colour coding of importance.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-VIZ-00 | A throwaway page with three shaped histories exists for a human to look at | ui-engineer | RS-FND-01 | spikes/dashboard-legibility.html, tests/legibility-spike.test.js | three panels, hardcoded data, no remote asset | Production chart code |
| RS-VIZ-01 | Seven-day and week-over-week deltas with honest insufficiency | insight-engineer | RS-DB-03 | src/insight/deltas.js, tests/insight-deltas.test.js | complete windows, window with a hole, zero base | Chart markup |
| RS-VIZ-02 | Stars-versus-clones divergence without a verdict | insight-engineer | RS-VIZ-01 | src/insight/divergence.js, tests/insight-divergence.test.js | ratio, absolute beside ratio, insufficient data | Change list |
| RS-VIZ-03 | A flat dated list of what changed | insight-engineer | RS-VIZ-01 | src/insight/changes.js, tests/insight-changes.test.js | entry wording, ordering, gap day ignored | Chart markup |
| RS-VIZ-04 | The SVG chart draws gaps as breaks and ships a data table | ui-engineer | RS-VIZ-01 | src/views/components/line-chart.js, tests/line-chart.test.js | two polylines across a hole, deterministic output, table parity | Provenance annotation |
| RS-VIZ-05 | Provenance boundary and legend annotate the chart | ui-engineer | RS-VIZ-04 | src/views/components/line-chart.js, tests/provenance.test.js | boundary at first collected day, legend, caption text | Page layout |
| RS-VIZ-REV-01 | A human decides the chart order from the spike | human reviewer | RS-VIZ-00 | docs/reviews/dashboard-legibility-spike.json | three-repository judgement recorded | Implementation |

---

## 6. Implementation Tasks
### Phase 1: Legibility spike and the decision it produces

```forge-task
{
  "id": "RS-VIZ-00",
  "title": "Build a throwaway legibility spike with three shaped histories",
  "description": "Create spikes/dashboard-legibility.html, a single self-contained static page with three panels of hardcoded fake data for a spiking, a flat and a decaying repository, so that a human can decide which chart order answers the question of whether anyone is using the work, first. It must reference no remote script, style or font, must not be wired into the product, and must be obviously separate from the real dashboard. Add tests/legibility-spike.test.js asserting that the file exists, contains three panels, carries its data inline rather than fetching it, and contains no external reference. This is a design artifact for review, not product code.",
  "ownerAgent": "ui-engineer",
  "dependencies": ["RS-FND-01"],
  "expectedOutputs": ["spikes/dashboard-legibility.html", "tests/legibility-spike.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/legibility-spike.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/PRD.md#RS-SP-05"],
    "acceptanceCriteria": ["The spike file exists, renders three panels and carries all data inline", "A test asserts the file contains no http, https or protocol-relative external reference", "A test asserts the spike is not imported by any file under src", "The page states on its face that it is a throwaway design artifact"],
    "constraints": ["No product module may import or copy this file; the real chart is written independently", "No charting library and no remote asset may be referenced"],
    "constraintRefs": ["docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-HO-01"],
    "references": ["docs/features/chart-and-insight.md#RS-VIZ-ST-02"]
  }
}
```

```forge-task
{
  "id": "RS-VIZ-REV-01",
  "title": "Human review of the legibility spike and the chart order it decides",
  "description": "Open spikes/dashboard-legibility.html, look at the three shaped histories side by side, and record the decision in docs/reviews/dashboard-legibility-spike.json: which number a maintainer should see first, whether the decay case should be shown at all, whether the small-repository case needs its own treatment, and whether the spike is retained as decision evidence or deleted. The decision must be concrete enough that the chart implementation can follow it, and the reviewer must state which of the three panels decided it. This gate exists because chart order is a human judgement about legibility, not a property a test can assert.",
  "dependencies": ["RS-VIZ-00"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/chart-and-insight.md#RS-VIZ-FR-04"],
    "acceptanceCriteria": ["The review file records the chosen chart order, the panel that decided it, and the small-repository treatment", "The review file states whether the spike is retained as evidence or deleted", "The reviewer confirms the three panels were opened and compared, not only the file read", "Any disagreement with the proposed order is written down as a specific change to the chart"],
    "constraints": ["No agent may author or complete this review file", "The review must not claim a human approved any later implementation"],
    "constraintRefs": ["docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-AX-01"],
    "references": ["docs/features/chart-and-insight.md#RS-VIZ-ST-02", "docs/PRD.md#16. Open Questions", "docs/PRD.md#RS-ST-03"],
    "reviewFile": "docs/reviews/dashboard-legibility-spike.json"
  }
}
```

### Phase 2: Insight calculations

```forge-task
{
  "id": "RS-VIZ-01",
  "title": "Compute seven-day and week-over-week deltas honestly",
  "description": "Implement src/insight/deltas.js as pure functions over an observation array of stored days. For a metric and a range, return the sum of the last seven stored days, the sum of the seven before them, the absolute change, and the percentage change only when the earlier sum is not zero. Return an explicit insufficient-data result naming the calendar days either window is missing, so a hole in the archive produces a stated reason rather than a smaller sum. Provide the same calculation for the last complete week against the week before it. The tests cover two complete windows, a window containing one missing day, an earlier sum of zero, and a range shorter than fourteen days.",
  "ownerAgent": "insight-engineer",
  "dependencies": ["RS-DB-03"],
  "expectedOutputs": ["src/insight/deltas.js", "tests/insight-deltas.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/insight-deltas.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/chart-and-insight.md#RS-VIZ-FR-01"],
    "acceptanceCriteria": ["Two complete seven-day windows return both sums, the absolute change and the percentage", "A window with one missing day returns insufficient data naming that calendar day and returns no percentage", "An earlier sum of zero returns the absolute change with the percentage omitted rather than a division result", "A range shorter than fourteen days returns insufficient data naming the requirement", "Week-over-week uses the last complete week, not a partial one, asserted by a test"],
    "constraints": ["A missing day is never counted as zero and never interpolated", "No threshold, score or directional verdict is produced"],
    "constraintRefs": ["docs/features/chart-and-insight.md#RS-VIZ-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-HO-01"],
    "references": ["docs/PRD.md#4. Personas", "docs/PRD.md#RS-ST-03"]
  }
}
```

```forge-task
{
  "id": "RS-VIZ-02",
  "title": "Compute the stars-versus-clones divergence without a verdict",
  "description": "Implement src/insight/divergence.js to compare unique cloners with stars over a selected range. Return both absolute numbers, their ratio when the star count is not zero, and a plain sentence stating which of the two is larger, with the percentage reported next to the absolute value rather than instead of it. When the range contains fewer collected days than the documented minimum, or the star count is zero, return an explicit insufficient-data result naming the reason. The module must not produce a score, a grade, a threshold, a verdict word or a claim about trend; a test asserts the absence of such words in its output strings.",
  "ownerAgent": "insight-engineer",
  "dependencies": ["RS-VIZ-01"],
  "expectedOutputs": ["src/insight/divergence.js", "tests/insight-divergence.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/insight-divergence.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/chart-and-insight.md#RS-VIZ-FR-02"],
    "acceptanceCriteria": ["A range with 900 unique cloners and 8,000 stars returns both absolutes, the ratio and a sentence naming which is larger", "A range below the documented minimum collected days returns insufficient data naming the minimum", "A zero star count returns the absolutes with the ratio omitted and no division result", "A test asserts that no output string contains a score, grade, threshold or trend word"],
    "constraints": ["No minimum-volume judgement may be expressed as a verdict; it produces insufficient data only", "No directional trend language in any output string"],
    "constraintRefs": ["docs/features/chart-and-insight.md#RS-VIZ-CON-01", "docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-DU-02"],
    "references": ["docs/PRD.md#3.2 Non-Goals"]
  }
}
```

```forge-task
{
  "id": "RS-VIZ-03",
  "title": "Produce a flat dated list of what changed",
  "description": "Implement src/insight/changes.js to walk a stored observation array in date order and emit one entry per day whose value differs from the previous stored day, each naming the metric, the date, the previous value and the new value. Sort the result by the absolute change, largest first, and give each entry a date so the list can be read as a timeline. A day with no stored value produces no entry and is never described as a drop to zero, because that is the difference between a quiet day and an unmeasured one. The tests cover a simple increase, a decrease, two metrics on the same day, a gap between two stored days, and a day whose value is unchanged.",
  "ownerAgent": "insight-engineer",
  "dependencies": ["RS-VIZ-01"],
  "expectedOutputs": ["src/insight/changes.js", "tests/insight-changes.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/insight-changes.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/chart-and-insight.md#RS-VIZ-FR-03"],
    "acceptanceCriteria": ["An increase from three to nine produces one entry naming the metric, the date, three and nine", "A gap between two stored days compares the two stored values and does not mention the missing day as a zero", "An unchanged day produces no entry", "Entries are ordered by absolute change, largest first, asserted by a test with three changes of different sizes"],
    "constraints": ["The list is flat: no grouping, no narrative, no icons, no severity", "A missing day is never rendered as a fall to zero"],
    "constraintRefs": ["docs/features/chart-and-insight.md#RS-VIZ-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-HO-01"],
    "references": ["docs/PRD.md#4. Personas"]
  }
}
```

### Phase 3: The chart

```forge-task
{
  "id": "RS-VIZ-04",
  "title": "Render a metric series as SVG with gaps drawn as breaks",
  "description": "Implement src/views/components/line-chart.js as a pure function from an observation array and a label to an SVG string. Emit one polyline per contiguous run of stored days, so a missing day produces a visible break rather than a bridged segment; draw a left axis with at most five ticks and a bottom axis naming the first, last and boundary days; scale the longest series to the full height so a small repository is still readable. Return the chart and its paired data table together, where the table carries the same values and names the gap days in text. The function performs no I/O, reads no clock, and returns byte-identical markup for identical input. Add tests/line-chart.test.js covering a contiguous series, a series with an interior hole producing two polylines, a single-point series, and table-versus-markup parity.",
  "ownerAgent": "ui-engineer",
  "dependencies": ["RS-VIZ-01", "RS-VIZ-REV-01"],
  "expectedOutputs": ["src/views/components/line-chart.js", "tests/line-chart.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/line-chart.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/chart-and-insight.md#RS-VIZ-FR-04", "docs/PRD.md#RS-AX-03", "docs/PRD.md#RS-AX-04"],
    "acceptanceCriteria": ["A series with one interior missing day produces two polyline elements and no segment spanning the hole", "A single stored day produces a marker and no division by zero", "The paired data table contains the same numeric values as the plotted series and names the missing days", "Calling the function twice with the same input returns byte-identical markup", "No charting library is imported and the markup is a valid inline SVG fragment"],
    "constraints": ["No interpolation, bridging or zero substitution across a missing day", "No animation, no external asset and no inline script"],
    "constraintRefs": ["docs/features/chart-and-insight.md#RS-VIZ-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-AX-01", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-PR-01"],
    "references": ["docs/PRD.md#6.2 Project Structure"]
  }
}
```

```forge-task
{
  "id": "RS-VIZ-05",
  "title": "Annotate the chart with the provenance boundary and legend",
  "description": "Extend src/views/components/line-chart.js, which this task modifies, to take the provenance read and annotate the output: a vertical boundary marker placed at the first collected day, a distinct dash treatment for backfilled days, a two-entry legend naming backfilled and collected, and a caption stating that the window before the boundary is since connection rather than history. A repository that has never been collected must render the first-connect caption and no boundary marker rather than an empty chart, and the caption must name the first collected day when one exists. Add tests/provenance.test.js covering a connected repository, a never-collected repository, and a repository whose backfill predates its first collected day.",
  "ownerAgent": "ui-engineer",
  "dependencies": ["RS-VIZ-04"],
  "expectedOutputs": ["src/views/components/line-chart.js", "tests/provenance.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/provenance.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/chart-and-insight.md#RS-VIZ-FR-05", "docs/PRD.md#RS-VR-02", "docs/PRD.md#RS-AX-04"],
    "acceptanceCriteria": ["A connected repository renders one boundary marker positioned at the first collected day", "Backfilled days are rendered with a treatment distinguishable from collected days and the legend names both", "A never-collected repository renders the first-connect caption and no boundary marker", "The data table text names every gap day and the first-connect caption when it applies"],
    "constraints": ["Provenance is labelled, never smoothed; no day before the boundary is drawn as if it were collected", "No wording that implies a pre-boundary day was measured"],
    "constraintRefs": ["docs/features/chart-and-insight.md#RS-VIZ-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-AX-01"],
    "references": ["docs/PRD.md#4. Personas"]
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Deltas, divergence, change list | Pure functions over hand-built observation arrays including holes |
| Unit | Chart markup and provenance | String assertions on generated SVG, including determinism and table parity |
| Human | Which number comes first, and whether small repositories are worth charting | Spike reviewed by a human before the chart is written |
| Human | Whether the finished page reads well | Accessibility and journey review in the views feature |

Key test scenarios:

1. Two complete windows return a percentage; one missing day returns insufficient data naming it.
2. An earlier sum of zero returns no percentage.
3. A divergence reading names which number is larger without a score or a verdict.
4. A gap between stored days yields a comparison of the two stored values only.
5. A hole in a series produces two polylines and no bridged segment.
6. The paired data table carries the same values as the plotted series.
7. A never-collected repository renders the first-connect caption and no boundary marker.

---

## 8. Acceptance Criteria

1. Every delta states absolute values first and names any day it could not use.
2. No output of this feature contains a score, a threshold, a verdict or an unsupported trend claim.
3. A missing day is a visible break in the chart and a named day in the text alternative.
4. The chart is deterministic, dependency-free and byte-identical for identical input.
5. A repository page can state where collected history begins and what that boundary means.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | How many collected days make a divergence reading meaningful? | Fourteen, matching one full traffic window, below which the reading is insufficient data |
| 2 | Should the change list be capped? | Capped at twenty entries with a count of the remainder, because a hundred-row list is not read |
| 3 | Should a decaying repository be hidden? | No. It is shown with its own numbers, and the spike review may change that |
