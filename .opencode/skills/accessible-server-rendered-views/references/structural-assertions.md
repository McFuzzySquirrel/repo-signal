# Structural assertion catalogue

Each row is a mechanical assertion on the served markup. None of them requires a browser.

| Rule | Assertion | Typical failure |
|------|-----------|-----------------|
| Language | The shell's `<html>` carries a language declaration | A view building its own document |
| Unique title | The title names the repository and range and differs per page | A constant title on every page |
| One main landmark | Exactly one `main` element per page | A shell `main` plus a view `main` |
| Skip link first | The skip link is the first focusable element and targets the main content | A header link inserted before it |
| Heading order | The sequence from `h1` down skips no level | A page beginning at `h2` |
| Escaping, text context | A name with `<` and `&` appears escaped in text | Raw interpolation |
| Escaping, attribute context | A name with `"` cannot close the attribute | Text escaping reused for attributes |
| Escaping, URL context | A name with `'` and spaces is percent-encoded in an `href` | Raw interpolation into a link |
| Table alternative | Every `figure` has a sibling `table` with the same values | A chart with no table |
| Gap in the table | The table's text names each missing day | An omitted day reading as zero |
| Determinism | Two calls with the same input return byte-identical markup | A clock or a random id in the chart |
| Colour tokens | Every colour literal lives in the theme stylesheet | A hex value in a view |
| Contrast, text | Each declared text pair computes at least 4.5:1 | A grey that passes visually only |
| Contrast, non-text | Each declared non-text pair computes at least 3:1 | A border or focus ring that fails |
| State as text | With class attributes stripped, every state word and reason remains | A colour-only or badge-only state |
| Accessible names | Every control has a name that is not a placeholder or an icon | A search box labelled only by its placeholder |
| No script or remote asset | No script tag, inline handler, remote font, remote image or animation | A web font link |
| Renders unstyled | With the stylesheet absent, every value is present in text | Layout-only content |
| Error pages | The 400 and 404 pages use the same shell and name the problem | A bare error string |
| 500 safety | A throwing view yields 500 whose body carries neither the message nor a stack trace | The exception text in the response |

## Shape helpers to keep reusable

- A skip-link emitter used by every page through the shell.
- A labelled section wrapper that emits a heading with a generated identifier, so heading order is
  structural rather than remembered.
- A labelled control helper whose accessible name never comes from a placeholder or an icon alone.
- A chart wrapper that always pairs the figure with its data table, so a view cannot render a
  picture without its numbers.

## Proportion detail

The chart uses a fixed viewBox, at most five ticks on the left axis, and a bottom axis naming the
first day, the boundary day and the last day. The legend carries two entries: backfilled and
collected. A never-collected repository renders the first-connect caption and no boundary marker
rather than an empty chart.

## Test placement

| Level | What it covers | Where it runs |
|-------|----------------|--------------|
| Unit | One view's markup, section order, states, escaping | Render a view with a seeded context, assert the returned string |
| Unit | Accessibility structure and contrast | Structural assertions plus computed ratios over the theme tokens |
| Entry point | The serve command on loopback | Spawn the entry point with `--port 0` and make an HTTP request |
| Integration | Every page against the running server | Seeded archive with a deliberate hole, then assert the served markup |
| Human | Journey, keyboard, screen reader | The human accessibility review, which an agent never authors |

The end-to-end assertions run on served markup, not on a view's return value, because the router,
the shell and the header policy are part of the contract.
