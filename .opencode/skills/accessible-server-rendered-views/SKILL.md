---
name: accessible-server-rendered-views
description: "Build RepoSignal's server-rendered pages, SVG chart and stylesheet to WCAG 2.1 AA: one escaping helper per context, the shared document shell, exactly one main landmark, a skip link first in the tab order, unbroken heading order, a data table paired with every figure, text-first states, and colour tokens declared once with contrast ratios computed by a test. Use when writing or changing a view, the chart component, the router's escaping helpers, the document shell, the theme stylesheet, or a structural accessibility test."
---

# Skill: Accessible Server-Rendered Views

`RS-AX-01` through `RS-AX-07` apply to the router's escaping helpers, the shell, the view modules,
the SVG chart and the stylesheet. The contract is checked mechanically by tests and again by a human,
so it must hold in the served markup, not in a rendered string in isolation.

Load the assertion catalogue in [structural-assertions.md](./references/structural-assertions.md)
when writing a new view or a new structural test, and when a page needs a new reusable piece such
as a labelled section, a control with an accessible name, or a chart wrapper.

## Process

### Step 1: Render only through the shell and the escaping helpers

There is one document shell carrying the language declaration, the page title, the theme stylesheet
link and the skip link, and one escaping helper per context: text, attribute and URL. A view
receives a context and returns escaped markup; no view builds its own `<html>`, and no dynamic value
is interpolated without the helper for its context. If a new page needs a new structural piece, then
it is added to the shared helpers rather than to one view.

### Step 2: Keep the structural contract per page

Each page declares its language, has a unique title naming the repository and range, has exactly one
`main` landmark, offers a skip link as the first focusable element, and uses a heading order that
skips no level. The 400 and 404 pages use the same shell, so a mistyped URL still looks like the
product rather than a bare error string.

### Step 3: Pair every figure with a data table

A chart is always accompanied by a data table carrying the same values and naming the gap days in
text, reachable from the chart. No information may exist only inside a picture, and a gap omitted
from the table reads as a zero day to a screen reader user.

### Step 4: Declare colour once and test the ratios

Every colour lives as a custom property in `src/ui/theme.css`; no other file declares a colour
literal. A test computes the contrast ratio of each declared text pair and non-text pair and fails
below 4.5:1 and 3:1 respectively. A search in the same test asserts no other file declares a colour
literal, so a hard-coded hex in a view cannot bypass the check. If a pair's ratio fails, then darken
or lighten the token rather than lowering the threshold.

### Step 5: State states as text, first

Re-authentication, stalled collection, unavailable repository, never collected, degraded and healthy
each render their own state word with a reason. A colour may reinforce a state; it may never carry
it. Stripping class attributes must leave every state readable.

### Step 6: Keep the pages script-free and asset-free

No script tag, no inline event handler, no remote font, no remote image and no animation. A page
must render completely without the stylesheet, with every value present in text form.

### Step 7: Assert the structure mechanically

The structural assertions run against the served markup in the end-to-end test, not against a view's
return value alone, because the router, the shell and the header policy are part of what must hold.
By default every structural assertion runs on served markup; otherwise a page that is correct in
isolation can still fail once the router and shell have wrapped it.

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" npm test -- tests/views/a11y.test.js
```

## Gotchas

- **Text-context escaping does not make an attribute or a URL safe.** A repository name containing a
  quote breaks an attribute and can break out of a `href`. Test each context with a name containing
  a quote and angle brackets, asserted per context.
- **A chart and its table under one `aria-hidden` disappear together.** Wrapping both in a hidden
  element removes the text alternative; wrap only the picture.
- **Two `main` landmarks is a structural failure, not a nesting convenience.** A wrapper in the
  shell plus a view's own `main` yields two; one of them must go.
- **The heading walk must start below `h1`.** A page that begins at `h2` looks fine and fails the
  order assertion; the shell owns the `h1`.
- **A chart scale that ignores its own maximum hides small repositories.** Scale the longest series
  to the full height, and emit a marker for a single stored day rather than dividing by a zero range.
- **Polylines are how gaps stay visible.** One segment per contiguous run of stored days; a hole in
  the middle produces two polylines, and a repository with a single day produces a marker.
- **A stylesheet route is a registered route, not a file server.** The theme is served at
  `/assets/theme.css` through the view registry with a `text/css` content type, and the server never
  serves a file from outside the registry.
- **System fonts only.** A remote font request is both a remote asset and a third contrast
  environment the token test cannot see.
- **A state conveyed by a badge is invisible to the test that strips classes.** Assert the state
  words with class attributes removed so a colour-only state fails.
- **The 500 page is an accessibility surface too.** A throwing view returns a generic body with no
  internal detail, rendered through the same shell.

## Validation

Self-check each item against served markup rather than a view's return value:

- [ ] A test asserts each rendered page has exactly one `main` landmark, a skip link as its first
      focusable element, a unique title, and a heading sequence that skips no level.
- [ ] A repository name containing a quote and angle brackets is escaped in the text, attribute and
      URL contexts, asserted per context.
- [ ] Every `figure` element has a sibling data table whose values equal the plotted values and
      whose text names the gap days.
- [ ] Every declared text token pair meets 4.5:1 and every non-text pair meets 3:1, computed in a
      test, and a repository search proves no other file declares a colour literal.
- [ ] A page rendered with class attributes removed still states every health state, and no state is
      carried by colour, icon or badge alone.
- [ ] The served markup contains no script tag, no inline handler, no remote font or image reference
      and no animation, and the stylesheet route returns the theme with a `text/css` content type.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default a human's later review is not a substitute for the
      mechanical assertions above.
