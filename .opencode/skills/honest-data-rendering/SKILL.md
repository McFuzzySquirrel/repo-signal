---
name: honest-data-rendering
description: "The no-fabrication rules for every RepoSignal layer that reads, computes or renders the archive: an unreported day stays a gap and is never zero-filled, interpolated or carried forward, insufficient data is a first-class result with a named reason, absolute values precede percentages, backfilled and collected days are labelled apart, and no output carries a score, verdict, threshold or unsupported directional claim. Use when writing an insight calculation, a chart, a page-data read, a view, or a CLI line that reports a repository's numbers."
---

# Skill: Honest Data Rendering

`RS-C04`, `RS-C05` and `RS-C13` are the product's central invariant, and PRD section 10 closes the
vocabulary they depend on. Every violation of them looks like working code, so each layer applies the
rules deliberately rather than inheriting them.

Load [honest-output-shapes.md](./references/honest-output-shapes.md) when a value crosses a layer
boundary - a database read into page data, page data into a view, or an observation array into a
sentence - and when a state word needs its precedence.

## Process

### Step 1: Classify every value before using it

Sort each input into exactly one class: **stored observation** (a row exists), **missing day** (the
calendar covers it and no row exists), **derived number** (a difference, ratio or sum of stored
observations), or **state** (a recorded health or lifecycle word). If a value does not fit one class,
then the shape is wrong and the class is decided before any arithmetic happens.

### Step 2: Keep the hole a hole through every layer

Range reads return stored rows only, and the days the range covers come from `calendarDays` as a
separate value. `RS-C04` forbids densifying a series to match the calendar, and it is also what
forbids carrying a value forward, interpolating between two neighbours, or filling a hole from
another metric or another repository. Never let a chart, table, panel or summary iterate the calendar
and look for a row: that pattern is where a zero appears for a day nobody measured.

If a value must cross a boundary that cannot express absence - a fixed-width array, a string column,
a point list - then the boundary carries two parallel values, one with the observations and one with
the covered days. If that is impossible, then the result is insufficient data, not a guess.

### Step 3: Choose the honest result shape

- A window containing a missing day returns an insufficient-data result naming the missing calendar
  days, and withholds both sums rather than returning a smaller one.
- A zero or absent base returns the absolute difference, names the omission and withholds the
  percentage - never `Infinity`, never `NaN`, never `0%`.
- A range below a documented minimum volume returns insufficient data with no stars, ratio or
  percentage field present at all.
- A repository that has never been collected returns the first-connect state, not an empty series and
  not a stalled one.

If a caller needs one shape for every case, then model the result as a named variant carrying the
value, the reason and that reason's evidence, and default to insufficient data rather than to an empty
success. `RS-C05` forbids a score, a ranking, a verdict, an anomaly claim or a firing threshold, so
there is no "healthy branch" that quietly summarises the whole range.

### Step 4: State absolutes first, then the ratio

Every percentage is reported next to the absolute value it came from, never instead of it. "3 clones,
down 25% from 4" is acceptable; "down 25%" alone is not. A three-clone repository moving three hundred
percent is noise, and the honest response to noise is the absolute number. A rounded percentage falls
back to three significant digits when two decimals would round a non-zero change to zero.

### Step 5: Label provenance and draw the boundary only where it exists

`RS-C13` requires every stored day to be labelled `collected` or `backfilled`, and the first collected
day to be stamped exactly once so a later run cannot move the boundary. The chart draws that boundary
only where the archive supports it, and refuses by name a day recorded collected before the boundary,
a day recorded collected for a repository that was never connected, and a boundary that disagrees with
the provenance record. Days before the boundary are since connection, not history, and the caption has
to say so.

### Step 6: Write the sentence from the number

Then read the sentence as if it described a repository with three clones and one unmeasured day. If it
would be wrong, it is the wrong sentence. Prefer "cloners outnumber stars in this range" over any
phrasing that asserts momentum the numbers do not carry. A state word is the honest alternative to a
verdict, so carry the word from PRD section 10 rather than inventing a grade for it.

### Step 7: Assert absence, not only presence

Every module that emits claims needs a test proving the forbidden shapes are absent, and a fixture
that contains a deliberate hole. A fixture with no gap cannot prove the rule, and a test that only
checks a good string still passes if the bad branch is unreachable but wrong.

## Gotchas

- **Summing a window with a hole shrinks the sum.** A window missing two of seven days returns a
  smaller total that reads as a real decline. Compare the window's days with the calendar days first,
  and return insufficient data naming them when they differ.
- **Bridging a polyline across a gap invents data.** One segment spanning an interior hole shows a
  plateau for two unmeasured days. Emit one polyline per contiguous run of stored days, and a single
  stored day must produce a circle marker rather than a division by a zero range.
- **Omitting a gap row from the data table reads as a zero.** A screen reader user gets the same table
  a sighted user gets, and a day absent from the table is a day that looks quiet. Give every covered
  day a row and let the gap row say in words that the day holds no stored value.
- **A change list that compares across a hole reports a fall to zero.** Compare each stored day with
  the previous *stored* day, emit nothing for an unchanged day while still counting the comparison,
  and produce no entry at all for a day with no stored value.
- **A repository with no successful collection is not stalled.** `never-collected` and `stalled` are
  different words, and a first-connect install must not alarm the maintainer about a repository whose
  last success has no date to be late against.
- **The state word must follow the fixed precedence.** A repository that is both unavailable and
  degraded is `unavailable`; one that needs re-authentication and is unreadable is
  `needs-re-authentication`. Resolving a state outside PRD section 10's order produces a word no
  document and no review has ever agreed with.
- **Days before the provenance boundary are not history.** Backfill reconstructs star history and
  weekly development activity only; clones, views, referrers and popular paths were never backfilled.
- **A health state is recorded, never inferred from quiet.** Absence of data is not a failure and a
  missing page is not a state; states come from the recorded run journal and the per-repository error
  rows.
- **One insufficient-data shape across the product.** The reason must arrive as data a view can
  display, not as prose a view must re-derive, so the three insight modules and both surfaces render
  missing evidence the same way.
- **Naming more gap days than the cap is not more honesty.** Gap days are capped per series with the
  remainder counted, so a report states ten days and a count rather than an unbounded list a reader
  cannot check.

## Validation

Self-check with a fixture that contains a deliberate hole, through the repository wrapper so an empty
selection fails:

- [ ] The fixture or temporary archive used by the test contains at least one deliberate hole, and the
      test asserts the hole is visible in the output rather than absent from it.
- [ ] A search of the module's output strings finds no score, grade, ranking, threshold, verdict or
      trend word; a named test asserts that absence.
- [ ] Every percentage in the output is accompanied by the absolute value it derives from.
- [ ] A window with a missing day returns insufficient data naming that calendar day, and the test
      asserts the reason string, not only the shape of the result.
- [ ] A zero base returns the absolute difference with no percentage and no `Infinity` or `NaN` in the
      output.
- [ ] Every stored day in a rendered series carries its provenance label, and the chart emits exactly
      as many polylines as there are contiguous runs of stored days.
- [ ] Every repository state a surface prints resolves to PRD section 10's precedence, and
      `never-collected` is never rendered as `stalled`.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default an assertion that would also pass on a fixture with no hole
      counts as not proven.