# Honest output shapes and vocabulary

## Result shapes

| Situation | Shape | Never |
|-----------|-------|-------|
| Complete window, non-zero base | absolutes, absolute change, percentage | percentage without the absolutes |
| Window missing one or more calendar days | insufficient data naming the missing days | a smaller sum |
| Base window sums to zero | absolute change, percentage omitted | `Infinity`, `NaN`, `0%` |
| Range shorter than the required window | insufficient data naming the requirement | a percentage over a partial window |
| Fewer collected days than the documented minimum | insufficient data naming the minimum | a minimum-volume verdict |
| Star count zero | both absolutes, ratio omitted | a division result |
| Repository never collected | first-connect state, no series | empty chart, stalled state |
| Two stored days with a hole between | comparison of the two stored values | a fall to zero on the missing day |
| Day with no observation, in a chart | break in the line, named in the table | a bridged segment or a plotted zero |

## Layer obligations

| Layer | Obligation | Failure it prevents |
|-------|-----------|----------------------|
| Database read | Return stored rows only; enumerate covered days separately | A densified series that fills every hole with zero |
| Snapshot read | Return each capture with its own capture time | Two captures of one referrer merged into one |
| Insight module | Return insufficient data as a named variant in the JSDoc type | A `null` a view silently renders as nothing |
| Chart function | One polyline per contiguous run; table carries the same values | A bridge, or a picture whose numbers differ from its table |
| Page data read | Pass the calendar days, provenance and health through unchanged | A fabricated first collected day |
| View | Name the gap days in text; state states as text first | A gap that reads as a quiet day |
| CLI line | One fact per line, absolute value before the ratio | A summary that reports a percentage a reader cannot check |

## Vocabulary

| Category | Examples |
|----------|----------|
| Permitted | "clones", "views", "unique cloners", "recorded on", "insufficient data for the missing days 2026-03-02 and 2026-03-04", "the window before 2026-03-02 is since connection, not history" |
| Banned | adoption, usage, popularity, health score, engagement, momentum, trending, increasing, decreasing, surging, declining, improving, momentum is up, "looks healthy", "3x better" |
| Banned by context | "no data" for a day inside a collected range (it is a gap with a reason), "adoption" for any clone count, "stable" for a flat line whose window is incomplete |

A sentence that would be wrong for a repository with three clones and one unmeasured day is the
wrong sentence, whatever the numbers are for the repository actually in hand.

## Insufficient-data reason vocabulary

Pick one reason string per cause and reuse it, so pages and CLI lines agree:

- `missing_days` - the window's covered days are not all stored; carry the day list.
- `short_range` - the selected range is shorter than the calculation's window.
- `below_minimum_volume` - fewer collected days than the documented minimum; carry the minimum.
- `zero_base` - the earlier sum or the divisor is zero; carry the absolute values.
- `not_connected` - no collected day exists yet for this repository; carry the first-connect wording.

## Test shapes that prove the rule

- Build the fixture with an explicit hole, and assert the hole appears in the rendered output.
- Assert the reason string, not only the presence of a field.
- Assert absence of banned vocabulary in the module's own output strings.
- For the chart, assert the number of polyline elements equals the number of contiguous runs.
- For a view, strip class attributes in the assertion so a colour-only state fails.
- For the table, assert the table's numbers equal the plotted series' numbers and that the gap days
  are named in text.
