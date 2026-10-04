---
name: accessible-server-rendered-views
description: "Building RepoSignal's server-rendered pages, SVG chart and stylesheet to WCAG 2.1 AA: one escaping helper per context, the shared document shell, exactly one main landmark, a skip link first in the tab order, unbroken heading order, a data table paired with every figure, states announced as words as well as classes, and colour tokens declared once with their contrast pairs computed by a test. Use when writing or changing a view, the chart component, the router's escaping helpers, the document shell, the theme stylesheet, or a structural accessibility test."
---

# Skill: Accessible Server-Rendered Views

`RS-A11Y-01` through `RS-A11Y-05` apply at once to the router's escaping helpers, the shell, the view
modules, the SVG chart and the stylesheet, and the same structural assertions would otherwise be
re-derived in the router, chart, view and integration work. The contract is checked mechanically by
tests and again by a person, so it has to hold in the served markup rather than in a rendered string in
isolation.

Do not extend a global design-theme package for this work: the product sends no client-side script and
uses system fonts only, while such a package assumes a component renderer and a foreign token system.

Load [structural-assertions.md](./references/structural-assertions.md) when writing a new view or a new
structural test, and when a page needs a new reusable piece such as a labelled section, a link with
visible text, or a chart wrapper.

## Process

### Step 1: Render only through the shell and the escaping helpers

`src/server/html.js` holds one document shell carrying the language declaration, the page title, the
theme stylesheet link and the skip link, and one escaping helper per context: text, attribute and URL.
A view receives a context and returns escaped markup; no view builds its own document, and no dynamic
value is interpolated without the helper for its context. If a page needs a new structural piece, then
it goes into the shared helpers rather than into one view.

### Step 2: Keep the structural contract per page

`RS-A11Y-02` and the view rules require exactly one `main` landmark, a skip link as the first focusable
element of the document, a unique title naming the repository and the range, and a heading sequence
that skips no level. Section headings are level two or below, because the shell owns the `h1`. The 400,
404 and 500 pages use the same shell, so a mistyped URL still looks like the product rather than a bare
error string, and a 500 body carries neither the thrown message nor a stack trace.

### Step 3: Pair every figure with its table

`RS-A11Y-03` requires every chart to ship with a data table, a caption and a legend, and no reading to
depend on colour. The chart helper enforces this by refusing to render markup that does not hold exactly
one figure, exactly one table with a caption and at least one row, a figure caption, and only
`aria-describedby` references that resolve inside the figure. Reachability matters: the table has to be
associable with the picture rather than present somewhere on the page.

### Step 4: Declare colour once and compute the ratios

Every colour lives as a custom property in `src/ui/theme.css`, and each declared pair names its role as
`text` or `non-text` with its two tokens. A test resolves each pair to the values that same file
declares, computes the ratio, and fails below 4.5:1 for text and 3:1 for non-text. The same test asserts
that every colour token takes part in at least one declared pair, that every colour literal sits inside
the token block, and that no other file under `src`, `tests` or `scripts` declares a colour literal, so
a hard-coded hex in a view cannot bypass the check. If a pair fails, then darken or lighten the token
rather than lowering the threshold.

### Step 5: Keep the pages script-free, remote-asset-free and motionless

`RS-A11Y-05` and the remote-asset constraints mean the stylesheet contains no transition, animation,
keyframes, import, font-face or url function, the markup contains no script tag, no inline handler, no
remote font and no remote image, and every page renders completely with the stylesheet absent and every
value present in text form. The dashboard sends no client-side JavaScript at all, so nothing may depend
on one.

### Step 6: State states as words first

`RS-A11Y-04` requires every state to be announced as a word as well as a class, so a re-authentication
need, a stalled collection, an unavailable repository, a never-collected repository, a degraded read and
a healthy read each render their own state word with its reason beside it. A colour or a badge may
reinforce a state; it may never carry it. Stripping class attributes must leave every state readable,
and a machine-readable time element appears only for an instant the build can parse.

### Step 7: Assert the structure mechanically against served markup

The structural assertions run against the served markup in the end-to-end suite, not against a view's
return value alone, because the router, the shell and the header policy are part of what must hold.

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" npm test -- tests/views/a11y.test.js
```

## Gotchas

- **Text-context escaping does not make an attribute or a URL safe.** A repository name containing a
  quote breaks an attribute and can break out of an `href`. Test each context with a name containing a
  quote and angle brackets, asserted per context.
- **A chart and its table under one `aria-hidden` disappear together.** Wrapping both in a hidden element
  removes the text alternative, so wrap only the picture and let the table stay reachable.
- **Two `main` landmarks is a structural failure, not a nesting convenience.** A wrapper in the shell
  plus a view's own `main` yields two, and one of them has to go.
- **The heading walk must start below the `h1`.** A page that begins at level two looks fine and fails
  the order assertion, because the shell owns the heading.
- **A chart scale that ignores its own maximum hides small repositories.** Scale the longest series to
  the full height and emit a marker for a single stored day rather than dividing by a zero range.
- **Polylines are how gaps stay visible.** One segment per contiguous run of stored days; a hole in the
  middle produces two polylines, and a repository with a lone day produces a marker rather than a line
  that draws nothing.
- **A stylesheet route is a registered route, not a file server.** The theme is served at its declared
  path through the view registry with an explicit CSS content type, and the server never serves a file
  from outside the registry.
- **A named link whose text is its address is not a named link.** A control whose accessible name comes
  only from a placeholder or an icon is the same defect in another form.
- **A state conveyed by a badge is invisible to the test that strips classes.** Assert the state words
  with class attributes removed, so a colour-only state fails.
- **The 500 page is an accessibility surface too.** A throwing view returns a generic body through the
  same shell, with no internal detail and no forwarded header.

## Validation

Self-check each item against served markup rather than a view's return value:

- [ ] A test asserts each rendered page has exactly one `main` landmark, a skip link as its first
      focusable element, a unique title, and a heading sequence that skips no level.
- [ ] A repository name containing a quote and angle brackets is escaped in the text, attribute and URL
      contexts, asserted per context.
- [ ] Every figure has a sibling data table whose values equal the plotted values, whose caption and
      legend are present, and whose text names the gap days.
- [ ] Every declared text token pair computes at least 4.5:1 and every non-text pair at least 3:1, and a
      repository search proves no file outside the stylesheet declares a colour literal.
- [ ] A page rendered with class attributes removed still states every health state, and no state is
      carried by colour, icon or badge alone.
- [ ] A machine-readable time element appears only for a parseable instant, and an unreadable recorded
      time is marked as not machine-readable rather than omitted silently.
- [ ] The served markup contains no script tag, no inline handler, no remote font or image reference and
      no animation, and the stylesheet declares no transition, keyframes, import, font-face or url
      function.
- [ ] The 400, 404 and 500 pages use the same shell, and the 500 body carries neither the thrown message
      nor a stack trace.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default a person's later review is not a substitute for the mechanical
      assertions above.