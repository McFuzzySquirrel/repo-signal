# Structural assertion catalogue

Each row is a mechanical assertion on the served markup. None of them requires a browser.

| Rule | Assertion | Typical failure |
|------|-----------|-----------------|
| Language | The shell's document element carries a language declaration | A view building its own document |
| Unique title | The title names the repository and the range and differs per page | A constant title on every page |
| One main landmark | Exactly one `main` element per page | A shell `main` plus a view `main` |
| Skip link first | The skip link is the first focusable element and targets the main content | A header link inserted before it |
| Heading order | The sequence from `h1` down skips no level, and sections start at level two or below | A page beginning at level two |
| Escaping, text context | A name with `<` and `&` appears escaped in text | Raw interpolation |
| Escaping, attribute context | A name with `"` cannot close the attribute | Text escaping reused for attributes |
| Escaping, URL context | A name with `'` and spaces is percent-encoded in a link target | Raw interpolation into a link |
| Chart pairing | Exactly one figure, exactly one table with a caption and at least one row, a figure caption, and every described-by reference resolving inside the figure | A chart with no table, or a caption pointing nowhere |
| Gap in the table | Every day the range covers has a row, and a gap row says in words that the day holds no stored value | An omitted day reading as zero |
| Gap in the picture | One polyline per contiguous run of at least two stored days, a marker for a lone day | A bridged segment, or a zero plotted for an unmeasured day |
| Determinism | Two calls with the same input return byte-identical markup | A clock or a random identifier in the chart |
| Colour tokens | Every colour literal lives in the token block of the stylesheet | A hex value in a view |
| Colour pairs declared | Every declared token takes part in at least one pair, and every pair names its role as text or non-text | A token no ratio is checked against |
| Contrast, text | Each declared text pair computes at least 4.5:1 | A grey that passes visually only |
| Contrast, non-text | Each declared non-text pair computes at least 3:1 | A border or focus ring that fails |
| State as a word | With class attributes stripped, every state word and its reason remain | A colour-only or badge-only state |
| Readable times | A machine-readable time element appears only for an instant the build can parse | An unreadable recorded time rendered as a machine-readable one |
| Named controls | Every link and control carries visible text rather than an address, a placeholder or an icon alone | A search box labelled only by its placeholder |
| No script or remote asset | No script tag, inline handler, remote font, remote image, or animation, and no transition, keyframes, import, font-face or url function in the stylesheet | A web font link or a hover transition |
| Renders unstyled | With the stylesheet absent, every value is present in text | Layout-only content |
| Error pages | The 400, 404 and 500 pages use the same shell and name the problem without internal detail | A bare error string, or an exception text in the response |

## Shape helpers to keep reusable

- A skip-link emitter used by every page through the shell, with a fixed target and fixed visible text.
- A labelled section wrapper that emits a heading with a generated identifier, so heading order is
  structural rather than remembered.
- A named-link helper whose accessible text never comes from the address, a placeholder or an icon alone.
- A chart wrapper that always pairs the figure with its data table, so a view cannot render a picture
  without its numbers.
- A document auditor that returns the structural findings rather than throwing at the first one, so one
  run reports every rule that failed.

## Proportion and axis detail

The chart uses a fixed viewBox, at most five value ticks on the left axis, at most three day labels along
the bottom, and names the gap days up to a cap with the remainder counted. The legend carries two
entries, backfilled and collected, and every stroke uses the inherited text colour so the stylesheet
stays the only place a colour is declared. A never-collected repository renders the first-connect caption
and no boundary marker rather than an empty chart.

## Test placement

| Level | What it covers | Where it runs |
|-------|----------------|---------------|
| Unit | One view's markup, section order, states and escaping | Render a view with a seeded context, assert the returned string |
| Unit | Accessibility structure, token pairs and computed ratios | The structural auditor plus the contrast computation over the stylesheet tokens |
| Entry point | The serve command on loopback | Spawn the entry point with an ephemeral port and make a real request |
| Integration | Every page against the running server | Seed an archive with a deliberate hole, then assert the served markup |
| Human | Journey, keyboard and screen reader | The human accessibility review, which no agent authors |

The end-to-end assertions run on served markup, not on a view's return value, because the router, the
shell and the header policy are part of the contract.