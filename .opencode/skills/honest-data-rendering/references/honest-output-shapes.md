# Honest output shapes, reasons and state words

## Result shapes

| Situation | Shape | Never |
|-----------|-------|-------|
| Complete window, non-zero base | absolutes, absolute change, percentage | a percentage without the absolutes |
| Window missing one or more calendar days | insufficient data naming the missing days, both sums withheld | a smaller sum |
| Base window sums to zero | absolute difference, percentage withheld and the omission named | `Infinity`, `NaN`, `0%` |
| Range shorter than the calculation's window | insufficient data naming the required and available day counts | a percentage over a partial window |
| Fewer collected days than the documented minimum | insufficient, with no stars, ratio or percentage field present | a minimum-volume verdict |
| Star count zero | both absolutes, ratio withheld | a division result |
| Repository never collected | first-connect state, no series | an empty chart, or a stalled state |
| Two stored days with a hole between | comparison of the two stored values | a fall to zero on the missing day |
| Day with no observation, in a chart | a break in the line, and a gap row that says so in words | a bridged segment or a plotted zero |

## Layer obligations

| Layer | Obligation | Failure it prevents |
|-------|-------------|----------------------|
| Database read | Return stored rows only; enumerate covered days separately | A densified series that fills every hole with zero |
| Snapshot read | Return each capture with its own capture time | Two captures of one referrer merged into one |
| Insight module | Return insufficient data as a named variant in the JSDoc type | A `null` a view silently renders as nothing |
| Chart function | One polyline per contiguous run, a marker for a lone day, a table carrying the same values | A bridge, or a picture whose numbers differ from its table |
| Page data read | Pass the calendar days, the provenance and the health through unchanged | A fabricated first collected day |
| View | Name the gap days in text; state every state as a word | A gap that reads as a quiet day |
| CLI line | One fact per line, absolute value before the ratio | A summary that reports a ratio a reader cannot check |

## Insufficient-data reason vocabulary

Pick one reason string per cause and reuse it, so pages and CLI lines agree:

- `missing-days` - the window's covered days are not all stored; carry the day list.
- `short-range` - the selected range is shorter than the calculation's window; carry the required and
  available day counts.
- `zero-base` - the earlier sum or the divisor is zero; carry the absolute values.
- `below-minimum-volume` - fewer collected days than the documented minimum; carry the minimum.
- `not-connected` - no collected day exists yet for this repository; carry the first-connect wording.

## State words and their precedence

Repository states, in the fixed precedence order from PRD section 10:

| Order | Word | Reserved for |
|-------|------|---------------|
| 1 | `unavailable` | The archive recorded that the repository is gone; its history is kept and the reason is shown |
| 2 | `needs-re-authentication` | An authentication rejection or a missing permission; the message names the permission |
| 3 | `unreadable` | A recorded time the build cannot parse |
| 4 | `stalled` | A last recorded success more than 26 hours old |
| 5 | `degraded` | The repository collected with a failure worth reporting |
| 6 | `never-collected` | No recorded success yet; there is no date to be late against, so this is not `stalled` |
| 7 | `healthy` | Recorded success inside the threshold |

Run states are `never-run`, `unclosed`, `completed` and `degraded`, with `degraded` meaning any
repository failed or became unavailable. The archive roll-up is `empty` when nothing is enrolled, and
otherwise the highest-precedence non-zero repository state; it needs attention for every state other
than `healthy`, `never-collected` and `empty`.

## Vocabulary

| Category | Examples |
|----------|----------|
| Permitted | "clones", "views", "unique cloners", "recorded on", "no stored value (gap)", "insufficient data: the window is missing 2026-03-02 and 2026-03-04", "the window before 2026-03-02 is since connection, not history" |
| Banned | adoption, usage, popularity, health score, engagement, momentum, trending, increasing, decreasing, surging, declining, improving, "looks healthy", "3x better" |
| Banned by context | "no data" for a day inside a collected range, because it is a gap with a reason; "adoption" for any clone count; "stable" for a flat line whose window is incomplete |

A sentence that would be wrong for a repository with three clones and one unmeasured day is the wrong
sentence, whatever the numbers are for the repository actually in hand.

## Test shapes that prove the rule

- Build the fixture with an explicit hole, and assert the hole appears in the rendered output.
- Assert the reason string, not only the presence of a field.
- Assert the absence of banned vocabulary in the module's own output strings.
- For the chart, assert that the number of polyline elements equals the number of contiguous runs.
- For a view, strip class attributes in the assertion, so a colour-only state fails.
- For the table, assert that the table's numbers equal the plotted series' numbers, that every covered
  day has a row, and that the gap days are named in text.