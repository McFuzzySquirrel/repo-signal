# Feature: Chart and Insight

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C04 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C05 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C13 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-ST-04 | [Vision](../PRD.md#4-personas) | participates |
| RS-INS-ST-01 | This feature | owns |
| RS-INS-C01 | This feature | owns |
| RS-INS-C02 | This feature | owns |
| RS-INS-C03 | This feature | owns |
| RS-INS-C04 | This feature | owns |
| RS-INS-C05 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Chart and Insight
**ID Prefix:** RS-INS
**Summary:** Turning stored days into readings without overstating them: seven-day and
week-over-week deltas that refuse a short window, a missing day or a zero base; a stars-versus-clones
comparison that needs paired collected days and returns insufficient below its floor; a dated change
list; and the SVG chart that draws a gap as a break, a backfilled run as a dashed line and the
provenance boundary as a rule.
**Dependencies:** Archive Storage
**Priority:** Must
**As-built status:** Built, covered by `tests/insight-deltas.test.js`,
`tests/insight-divergence.test.js`, `tests/insight-changes.test.js`, `tests/line-chart.test.js` and
the chart-pairing assertions in `tests/views/a11y.test.js`. The thresholds in section 9 are cited by
the code itself, and nothing checks that the citation still resolves.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-INS-ST-01 | Maintainer comparing two signals | the stars-versus-cloners reading to state both numbers, their basis and why the volume is or is not enough, so that a ratio is never presented as more than it is | Must |
| RS-INS-ST-02 | Maintainer reading a chart | gaps drawn as breaks and backfilled days drawn as backfilled, so that the shape of the line cannot suggest history the archive does not hold | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-INS-C01","kind":"constraint","text":"The three insight modules are pure: they import nothing at all, take no database, file, clock or chart library, refuse a non-calendar day, a duplicate day, a non-finite value, a reversed range and a repeated metric, and each returns a named union so a caller that forgets to branch cannot read a field that was never computed."}
```

```forge-requirement
{"id":"RS-INS-C02","kind":"constraint","text":"A seven-day delta compares the last seven days of the range with the seven before them, and a week-over-week delta compares complete weeks only; a range shorter than the comparison needs returns short-range with both sums withheld and the required and available day counts named, and any missing day in either window returns missing-days with those days listed oldest first."}
```

```forge-requirement
{"id":"RS-INS-C03","kind":"constraint","text":"A zero base withholds the percentage, names the omission and still reports the absolute difference; a rounded percentage falls back to three significant digits when two decimals would round a non-zero change to zero."}
```

```forge-requirement
{"id":"RS-INS-C04","kind":"constraint","text":"The stars-versus-clones reading counts a day as collected only when both metrics are present on it, sums the stored daily unique-cloner counts and says so, takes the star level from the last collected day, and below its floor returns insufficient with no stars, ratio or percentage field present at all."}
```

```forge-requirement
{"id":"RS-INS-C05","kind":"constraint","text":"The change list walks stored rows per metric, comparing each stored day with the previous stored day, emitting nothing for an unchanged day while still counting the comparison, ordering entries by absolute change, capping the list and reporting how many entries were omitted."}
```

```forge-requirement
{"id":"RS-INS-C06","kind":"constraint","text":"The chart draws one polyline per contiguous run of at least two stored days and one point for a lone day, closes a run at a missing day and at a change of dash treatment, uses currentColor only, and refuses by name a day recorded collected before the boundary, a day recorded collected for a repository that was never connected, and a boundary that disagrees with the provenance read it was given."}
```

---

## 4. Chart and Table Design

The chart is one `figure` holding an SVG, a `figcaption`, a legend and a data table. The value axis
runs from zero to the largest stored value, the boundary is a vertical rule at the first collected
day's own position, and no rule is drawn at all when the repository was never connected or the
boundary lies outside the window. The legend names backfilled then collected and shows a dashed line
then a solid one. The table carries a source column, prints `No stored value (gap)` for an absent day,
and is the accessible reading of the same data the line shows.

Captions and axes are rendered from the model, never from a colour: there is no colour literal in the
chart module, so the same model prints identically under any theme.

---

## 5. Deltas

Both deltas are anchored on the range's end rather than on the wall clock, and the week-over-week form
requires an explicit `today` so a caller cannot accidentally compare an incomplete week. A repository
whose last complete day is yesterday is compared over complete weeks only. When a window contains a
missing day the reading withholds the change and the percentage entirely rather than summing what
happened to be there, because a percentage over a partial window is the exact overstatement this
product exists to avoid.

---

## 6. Divergence

The reading answers a question a maintainer actually asks: many stars but few cloners, or the
reverse. It needs paired days so that the two signals are compared over the same stretch, and it
declines below its floor with no numbers at all. A zero star count is still a sufficient reading with
a withheld ratio, because "no stars" is an observation rather than a missing one. The unique-cloner
figure is a sum of stored daily counts, which is not the same number as a deduplicated total, so the
basis is stated with the figure.

---

## 7. Change List

Entries are flat and dated: metric, the newer day, the previous stored day, both values, the signed
change, the absolute change, the number of days between the two observations and any days missing
between them. Ordering is by absolute change descending, the newer day first among equals, capped,
with the omitted count reported so a truncated list never reads as a complete one. Fewer than two
stored days in a series is insufficient, not a list of nothing.

---

## 8. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Deltas, short ranges, missing days, zero base, rounding | Existing `tests/insight-deltas.test.js` |
| Unit | Paired days, floor, zero stars, ratio rounding | Existing `tests/insight-divergence.test.js` |
| Unit | Ordering, capping, coverage counting, refusals | Existing `tests/insight-changes.test.js` |
| Unit | Runs, boundary, legend, table pairing, refusals | Existing `tests/line-chart.test.js` |
| Contract | Section 9 thresholds against the module constants, and the code's own citations | Created by task RS-INS-CONTRACT-01 |

Key scenarios: a window of nine days returns short-range rather than a partial comparison; one missing
day in the comparison window withholds the percentage and names the day; fourteen paired days is the
boundary of sufficiency for the divergence reading and thirteen is not; a lone stored day renders as a
point rather than a line; a chart whose boundary contradicts its provenance is refused by name.

---

## 9. Sufficiency Thresholds and Caps

These are the numbers the code cites from this document, and the test that keeps them honest.

| Constant | Value | Why this number |
|----------|-------|-----------------|
| `WINDOW_DAYS` | 7 | The short comparison window a maintainer can hold in their head; also the length of a vendor traffic day window as commonly read |
| `COMPARISON_DAYS` | 14 | The week-over-week comparison needs a full preceding week beside the current one |
| `MINIMUM_COLLECTED_DAYS` | 14 | Fourteen collected days, matching one full traffic window: below that, a stars-versus-cloners ratio compares two signals over different stretches and the percentage moves by hundreds of points on three clones |
| `MAX_CHANGE_ENTRIES` | 20 | Twenty entries is the most a maintainer reads; a hundred-row list is a data dump, and a truncated list reports its omitted count |
| `MAX_NAMED_GAP_DAYS` | 10 | Naming every gap day would bury the coverage line; ten named days plus a counted remainder keeps the gap visible without inverting the reading |
| `MAX_VALUE_TICKS` | 5 | Enough ticks to read a level, few enough that the axis is not a grid |
| `MAX_DAY_LABELS` | 3 | A 14-day axis labelled at three points stays legible at the served chart width |
| `Rounded ratio` | 4 decimals, 3-significant-digit fallback | A ratio below one is the interesting case, and two decimals would print it as zero |
| `Rounded percentage` | 2 decimals, 3-significant-digit fallback | Keeps a small real change from reading as no change |

---

## 10. Implementation Tasks

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-INS-CONTRACT-01",
  "title": "Assert the thresholds in section 9 and the code's citations of this document",
  "description": "Two source files cite this document for their defaults: `src/insight/divergence.js` cites section 9 for the fourteen-collected-day floor and `src/insight/changes.js` cites it for the twenty-entry cap, and `src/views/components/line-chart.js` is held to the same caps. Nothing checks that the citation still resolves or that the numbers still match. Create `tests/contract-insight.test.js` asserting that every constant listed in section 9 equals the value the corresponding module exports, that this document still carries a section 9 and still states both cited numbers, and that the chart's own caps for named gap days, value ticks and day labels match section 9. Where a mismatch is found, correct this document rather than the constant, unless the constant is demonstrably wrong, in which case report it instead of quietly moving either. Do not change a threshold, a rounding rule or a refusal.",
  "ownerAgent": "documentation-engineer",
  "dependencies": [],
  "expectedOutputs": ["tests/contract-insight.test.js"],
  "validationCommands": ["npm test -- tests/contract-insight.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert every threshold in section 9 equals the exported constant, and that the two source citations of this document still resolve to it"],
    "requirementRefs": [],
    "acceptanceCriteria": ["A test imports MINIMUM_COLLECTED_DAYS and MAX_CHANGE_ENTRIES and compares them with the table in section 9", "A test fails when this document loses its section 9 or either cited number", "A test compares the chart caps with section 9", "tests/contract-insight.test.js reports more than zero executed tests"],
    "constraints": ["Do not change a threshold, a cap or a rounding rule to make a test pass", "Do not delete a section a source file cites"],
    "constraintRefs": ["docs/features/chart-and-insight.md#RS-INS-C04", "docs/features/chart-and-insight.md#RS-INS-C05", "docs/features/chart-and-insight.md#RS-INS-C06", "docs/PRD.md#RS-C05", "docs/PRD.md#RS-C12"],
    "references": ["docs/features/chart-and-insight.md#9. Sufficiency Thresholds and Caps", "docs/features/chart-and-insight.md#4. Chart and Table Design"]
  }
}
```

---

## 11. Acceptance Criteria

1. No reading is produced from a window shorter than the comparison it claims, and the shortfall is
   named with the days required and available.
2. A missing day in a comparison window withholds the percentage and names the day.
3. The stars-versus-cloners reading is insufficient below fourteen paired collected days and carries no
   numbers in that case.
4. A change list is capped, ordered by absolute change, and reports what it omitted.
5. The chart draws gaps as breaks, backfill as dashes, and the boundary only where the archive
   supports it, and refuses a chart whose provenance contradicts itself.
6. Every threshold in section 9 is asserted against the module that implements it.

---

## 12. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Unique cloners are summed from daily counts rather than deduplicated | Keep the sum and state its basis beside the number |
| 2 | Should the divergence reading also compare forks and watchers? | Not until those series exist with their own provenance decisions |
| 3 | Change entries compare consecutive stored days, so a gap widens `daysSincePrevious` | Keep it: the entry reports the days between observations rather than hiding the gap |