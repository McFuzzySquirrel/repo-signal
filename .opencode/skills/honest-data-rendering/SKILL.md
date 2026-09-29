---
name: honest-data-rendering
description: "The no-fabrication rules for every RepoSignal layer that reads, computes or renders the archive: a missing day stays a gap, insufficient data is a first-class result, absolute values precede percentages, backfilled and collected days are labelled apart, and no output carries a score, threshold, verdict or unsupported directional claim. Use when writing an insight calculation, a chart, a page-data read, a view, or a CLI line that reports a repository's numbers."
---

# Skill: Honest Data Rendering

RepoSignal's central invariant is `RS-DU-02` (a day that was never observed is rendered as a gap)
and `RS-HO-01` (the product states evidence and its limits). Every failure of both looks like
working code, so the rules are applied deliberately at each layer.

Load the per-layer shape and vocabulary tables in [honest-output-shapes.md](./references/honest-output-shapes.md)
when a value crosses a layer boundary - database read into page data, page data into a view, or an
observation array into a sentence.

## Process

### Step 1: Classify every value before using it

Sort each input into exactly one class: **stored observation** (a row exists), **missing day** (the
calendar covers it, no row exists), **derived number** (a difference, ratio or sum of stored
observations), or **state** (a recorded health or lifecycle value). If a value does not fit one
class, then the shape is wrong and the class is decided before any arithmetic happens.

### Step 2: Keep the hole a hole through every layer

Range reads return stored rows only. The days the range covers come from `calendarDays` as a
separate value. Never densify a series to match the calendar, and never let a chart, table, panel
or summary iterate the calendar and look for a row: that pattern is where a zero appears for a day
nobody measured.

If a value must cross a boundary that cannot express absence - a fixed-width array, a string
column, a chart point list - then the boundary needs two parallel values, one carrying the
observations and one carrying the covered days. If that is impossible, the result is
insufficient data, not a guess.

### Step 3: Choose the honest result shape

- A window containing a missing day returns an insufficient-data result naming the missing calendar
  days, not a smaller sum.
- A zero or absent base returns the absolute value with the percentage omitted - never `Infinity`,
  never `NaN`, never `0%`.
- A range below a documented minimum volume returns insufficient data naming the minimum.
- A repository that has never been collected returns the first-connect state, not an empty series
  and not a stalled one.

If a caller needs one shape for every case, then model the result as a named variant carrying the
value, the reason and the reasons' evidence, and default to insufficient data rather than to an
empty success.

### Step 4: State absolutes first, then the ratio

Every percentage is reported next to the absolute value it came from, never instead of it. "3
clones, down 25% from 4" is acceptable; "down 25%" alone is not. A three-clone repository moving
three hundred percent is noise, and the honest response to noise is the absolute number.

### Step 5: Write the sentence from the number

Then read the sentence as if it described a repository with three clones and one unmeasured day.
If it would be wrong, it is the wrong sentence. Prefer "cloners outnumber stars in this range" over
any phrasing that asserts momentum the numbers do not carry.

### Step 6: Assert absence, not only presence

Every module that emits claims needs a test proving the forbidden shapes are absent, and a fixture
that contains a deliberate hole. A fixture with no gap cannot prove the rule, and a test that only
checks a good string still passes if the bad branch is unreachable-but-wrong.

## Gotchas

- **Summing a window with a hole shrinks the sum.** A window missing two of seven days returns a
  smaller total that reads as a real decline. Compare the window's days against the calendar days
  first, and return insufficient data naming the days when they differ.
- **Bridging a polyline across a gap invents data.** One segment spanning an interior hole shows a
  plateau for two unmeasured days. Emit one polyline per contiguous run of stored days, and a single
  stored day must produce a marker rather than a division by zero.
- **Omitting a gap row from the data table reads as a zero.** A screen reader user gets the same
  table a sighted user gets; a day absent from the table is a day that looks quiet. Name the gap
  days in the table text.
- **A change list that compares across a hole reports a fall to zero.** Compare each stored day with
  the previous *stored* day, and produce no entry for a day with no stored value.
- **A repository with no successful collection is not stalled.** "Never collected" and "stalled" are
  different states, and a first-connect install must not alarm the maintainer.
- **Days before the provenance boundary are not history.** Backfill reconstructs star history and
  weekly development activity only; clones, views, referrers and popular paths were never
  backfilled. A caption that says "since connection, not history" is required, and no day before the
  boundary may be drawn as if it were collected.
- **A health state is recorded, never inferred from quiet.** Absence of data is not a failure, and a
  missing page is not a state; states come from the recorded run journal and per-repository error
  rows.
- **One insufficient-data shape across the product.** The reason must arrive as data a view can
  display, not as prose a view must re-derive, so the three insight modules and both surfaces render
  missing evidence the same way.

## Validation

Self-check with a fixture that contains a deliberate hole, through the repository wrapper so an
empty selection fails:

- [ ] The fixture or temporary archive used by the test contains at least one deliberate hole, and
      the test asserts the hole is visible in the output rather than absent from it.
- [ ] A search of the module's output strings finds no score, grade, ranking, threshold, verdict or
      trend word; a named test asserts that absence.
- [ ] Every percentage in the output is accompanied by the absolute value it derives from.
- [ ] A window with a missing day returns insufficient data naming that calendar day, and the test
      asserts the reason string, not only the shape.
- [ ] A zero base returns the absolute change with no percentage and no `Infinity` or `NaN` in the
      output.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default an assertion that would pass on a fixture with no hole
      counts as not proven.
