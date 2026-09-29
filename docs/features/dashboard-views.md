# Feature: Dashboard Views and Accessibility

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-VR-03 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-ST-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-ST-03 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-ST-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-HO-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-AX-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-AX-02 | [Vision](../PRD.md#9. Accessibility) | participates |
| RS-AX-03 | [Vision](../PRD.md#9. Accessibility) | participates |
| RS-AX-04 | [Vision](../PRD.md#9. Accessibility) | participates |
| RS-AX-05 | [Vision](../PRD.md#9. Accessibility) | participates |
| RS-AX-06 | [Vision](../PRD.md#9. Accessibility) | participates |
| RS-AX-07 | [Vision](../PRD.md#9. Accessibility) | participates |
| RS-SP-07 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SP-02 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-UI-FR-01 | This feature | owns |
| RS-UI-FR-02 | This feature | owns |
| RS-UI-FR-03 | This feature | owns |
| RS-UI-FR-04 | This feature | owns |
| RS-UI-FR-05 | This feature | owns |
| RS-UI-CON-01 | This feature | owns |
| RS-UI-ST-01 | This feature | owns |
| RS-UI-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Dashboard Views and Accessibility
**ID Prefix:** RS-UI
**Summary:** The pages a maintainer actually looks at, the view registry that mounts them, the
`serve` command that starts the dashboard, and the accessibility contract that is checked
mechanically and again by a human.
**Dependencies:** Local Dashboard Server, Chart and Insight Rendering
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-UI-ST-01","kind":"story","text":"As a solo maintainer I want one page per repository that answers whether anyone is using it, so that I do not have to correlate four charts myself."}
```

```forge-requirement
{"id":"RS-UI-ST-02","kind":"story","text":"As a solo maintainer using a keyboard or a screen reader, I want the dashboard to be fully usable, so that the archive is not a picture I cannot read."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-UI-FR-01","kind":"requirement","text":"Create the view registry as the composition root every page is mounted in, and expose the `serve` command from the process entry point so the dashboard starts with the registry mounted. The registry maps the three routes to their render functions, and adding a page must be a change in this one file plus its view module."}
```

```forge-requirement
{"id":"RS-UI-FR-02","kind":"requirement","text":"Render the repository detail page as one page that shows, for the selected range: the current absolute numbers, one chart per acquisition and interest metric, the delta panel, the stars-versus-clones comparison, the change list, the referrer and popular-path captures with their capture times, the collection health state, and the provenance boundary with its first-connect caption. A repository with no data renders a first-connect state rather than an empty chart."}
```

```forge-requirement
{"id":"RS-UI-FR-03","kind":"requirement","text":"Render a collection health page listing every enrolled repository with its state word, last successful collection, consecutive failure count, and where relevant the re-authenticate action naming the missing permission and the stalled warning. States appear as text first and are never conveyed by colour alone."}
```

```forge-requirement
{"id":"RS-UI-FR-04","kind":"requirement","text":"Meet the accessibility contract mechanically: one main landmark per page, a skip link first in the tab order, a heading order that skips no level, a unique page title, a labelled control for every interactive element, a data table for every chart, and colour tokens defined once with their contrast ratios asserted by a test at 4.5:1 for text and 3:1 for non-text."}
```

```forge-requirement
{"id":"RS-UI-FR-05","kind":"requirement","text":"Cover the running product with one end-to-end view test that starts the real server against a temporary home with seeded data and requests every page, asserting the empty state, the populated state, the gap rendering that shows no substituted zero, the health states, and the 404 and 400 pages."}
```

```forge-requirement
{"id":"RS-UI-CON-01","kind":"constraint","text":"No page may contain a script tag, an inline event handler, a remote font, a remote image or an animated transition, and no page may claim a measurement the archive does not contain."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-UI-ST-01 | story | Must |
| RS-UI-ST-02 | story | Must |
| RS-UI-FR-01 | requirement | Must |
| RS-UI-FR-02 | requirement | Must |
| RS-UI-FR-03 | requirement | Must |
| RS-UI-FR-04 | requirement | Must |
| RS-UI-FR-05 | requirement | Must |
| RS-UI-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

The detail page is ordered by the answer the maintainer came for, in the order the legibility
review recorded: current numbers first, then acquisition, then interest, then the comparison with
recognition, then what changed, then discovery captures, then collection state, then provenance.
Each section is a labelled landmark with a heading, so the page can be navigated by heading.

The health page is a table with a text state column, a last-success column, a failure-count
column and an action column. The re-authenticate action is a link to the operations
troubleshooting runbook, named with the permission, not a generic help link.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-UI-01 | The registry mounts the pages and `serve` starts the dashboard | ui-engineer | RS-SRV-02, RS-VIZ-01 | src/server/views/index.js, src/server/views/repo-list.js, src/commands/serve.js, src/commands/index.js, tests/views/repo-list.test.js, tests/serve-command.test.js | registry routes, reachable from the CLI, links carry repository and range | Detail page, health page |
| RS-UI-02 | The detail page answers the question in the reviewed order | ui-engineer | RS-UI-01, RS-VIZ-05, RS-SRV-03 | src/server/views/repo-detail.js, src/server/views/index.js, tests/views/repo-detail.test.js | section order, empty state, gap not rendered as zero, provenance caption | Health page, theme |
| RS-UI-03 | The health page states each repository's collection state in text | ui-engineer | RS-UI-01, RS-SUP-03 | src/server/views/health.js, src/server/views/index.js, tests/views/health-view.test.js | six states rendered, action link names the permission | Detail page, theme |
| RS-UI-04 | The accessibility contract is checked mechanically | ui-engineer | RS-UI-02, RS-UI-03 | src/server/views/a11y.js, src/ui/theme.css, tests/views/a11y.test.js, tests/contrast.test.js | landmarks, heading order, titles, labels, table alternative, contrast ratios | Styling beyond tokens |
| RS-UI-05 | Every page is exercised against the running server | qa-engineer | RS-UI-04, RS-SRV-01 | tests/integration/dashboard-e2e.test.js | six request outcomes, no substituted zero, headers | Human judgement |
| RS-UI-REV-01 | A human completes the primary journey and the accessibility pass | human reviewer | RS-UI-05 | docs/reviews/dashboard-accessibility.json | journey, keyboard, screen reader, gaps | Code changes |

---

## 6. Implementation Tasks

### Phase 1: Composition root and the pages

```forge-task
{
  "id": "RS-UI-01",
  "title": "Mount the view registry and expose the serve command",
  "description": "Create src/server/views/index.js as the composition root that maps the three routes to their render functions and mounts the view modules the later tasks add, and add the index and repository-list views in src/server/views/repo-list.js, rendered through the document shell and escaping helpers in src/server/html.js: a table of enrolled repositories with the current acquisition and interest totals, the collection state word, and links that carry the repository and the selected range in the URL. Add src/commands/serve.js, which starts the loopback server through the factory in src/server/server.js with the router from src/server/router.js and this registry mounted, and register it in src/commands/index.js so `repo-signal serve` is reachable from the process entry point and prints the URL it is actually listening on. The tests assert the registry routes to the expected views, that the list page escapes repository names, and that starting the command through the process entry point serves a real page over loopback.",
  "ownerAgent": "ui-engineer",
  "dependencies": ["RS-SRV-02", "RS-SRV-03", "RS-VIZ-01"],
  "expectedOutputs": ["src/server/views/index.js", "src/server/views/repo-list.js", "src/commands/serve.js", "src/commands/index.js", "tests/views/repo-list.test.js", "tests/serve-command.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/views/repo-list.test.js tests/serve-command.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-views.md#RS-UI-FR-01", "docs/PRD.md#RS-SP-07"],
    "acceptanceCriteria": ["The registry maps the index, list and detail routes and a test asserts each mapping", "The repository list page links to a detail page carrying the repository name and the range in the query string", "A repository name containing markup characters appears escaped in the list page", "`node src/cli.js serve --port 0` starts a server on loopback, prints the resolved URL and serves the list page, asserted by an HTTP request in the test", "Adding a view is a change in the registry file plus its own view module"],
    "constraints": ["No script tag, remote asset or inline handler in any view", "The detail and health views are not implemented in this task; the registry must degrade to the list page for them"],
    "constraintRefs": ["docs/features/dashboard-views.md#RS-UI-CON-01", "docs/PRD.md#RS-SC-03", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-TC-04"],
    "requirements": ["The list page links from one enrolled repository to its own detail page, per vision story RS-ST-01"],
    "references": ["docs/PRD.md#4. Personas", "docs/PRD.md#6.2 Project Structure"]
  }
}
```

```forge-task
{
  "id": "RS-UI-02",
  "title": "Render the repository detail page in the reviewed order",
  "description": "Add src/server/views/repo-detail.js and register it in src/server/views/index.js. Render, as labelled sections in the order recorded by the legibility review: the current absolute numbers, one chart per acquisition and interest metric using the chart component, the delta panel, the stars-versus-clones comparison, the change list, the referrer and popular-path captures with their capture times, the collection health state, and the provenance boundary with its first-connect caption. A repository with no collected data renders a first-connect state naming the missing permission or the next step, not an empty chart, and a missing day appears as a gap in both the chart and the text alternative. Mount the modules built by earlier features here, importing src/views/components/line-chart.js, src/insight/deltas.js, src/insight/divergence.js and src/insight/changes.js, and read the page data through src/server/repo-data.js; this task is what puts them on a page. The test asserts the section order, the empty state, and that no zero appears where a day is missing.",
  "ownerAgent": "ui-engineer",
  "dependencies": ["RS-UI-01", "RS-VIZ-05", "RS-SRV-03"],
  "expectedOutputs": ["src/server/views/repo-detail.js", "src/server/views/index.js", "tests/views/repo-detail.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/views/repo-detail.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-views.md#RS-UI-FR-02", "docs/PRD.md#RS-VR-02", "docs/PRD.md#RS-AX-04"],
    "acceptanceCriteria": ["The rendered sections appear in the order the legibility review recorded, asserted by heading sequence", "A repository with no collected data renders a first-connect state and no chart element", "A day with no observation renders no zero in the chart data and names the day in the text alternative", "Referrer and popular-path captures are shown with their capture times", "The provenance caption names the first collected day, or the first-connect wording when there is none"],
    "constraints": ["No page may state a trend, a score or a verdict the data does not support", "No missing day is rendered as zero and no section is omitted for a repository in a failure state"],
    "constraintRefs": ["docs/features/dashboard-views.md#RS-UI-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-AX-01"],
    "references": ["docs/PRD.md#4. Personas"]
  }
}
```

```forge-task
{
  "id": "RS-UI-03",
  "title": "Render the collection health page with text states",
  "description": "Add src/server/views/health.js and register it in src/server/views/index.js so the health read is visible as a page. Render one row per enrolled repository with its state word, its last successful collection, its consecutive failure count, the reason for the most recent failure, and an action cell that names what to do: a link to the re-authenticate guidance naming the Administration read permission when the token was rejected or under-permissioned, and a stalled warning naming the last success when collection has stopped. States must be readable as text with colour removed, and a never-collected repository must read as not yet connected rather than as broken.",
  "ownerAgent": "ui-engineer",
  "dependencies": ["RS-UI-01", "RS-SUP-03"],
  "expectedOutputs": ["src/server/views/health.js", "src/server/views/index.js", "tests/views/health-view.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/views/health-view.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-views.md#RS-UI-FR-03", "docs/PRD.md#RS-VR-03", "docs/PRD.md#RS-AX-07", "docs/PRD.md#RS-SP-02"],
    "acceptanceCriteria": ["Each of the six health states renders its own text state word", "A needs-re-authentication row names the Administration read permission in its action text", "A stalled row names the time of the last successful collection", "A never-collected repository reads as not yet connected and carries no failure action", "Stripping all class attributes leaves every state still readable as text, asserted by the test"],
    "constraints": ["No state may be conveyed by colour, icon or badge alone", "The health page must not restate a failure as a data gap"],
    "constraintRefs": ["docs/features/dashboard-views.md#RS-UI-CON-01", "docs/PRD.md#RS-AX-01", "docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-DU-02"],
    "references": ["docs/PRD.md#4. Personas"]
  }
}
```

### Phase 2: Accessibility contract and end-to-end verification

```forge-task
{
  "id": "RS-UI-04",
  "title": "Define the accessibility helpers and contrast-checked theme tokens",
  "description": "Add src/server/views/a11y.js with the reusable pieces the accessibility contract needs, and use it in the index, list and detail views this feature already renders: a skip link, a labelled section wrapper that emits a heading with a generated identifier, a labelled control helper whose accessible name never comes from a placeholder or an icon, and a chart wrapper that always pairs the figure with its data table. Define every colour once in src/ui/theme.css as custom properties, with no other file declaring a colour literal, and register a static route in src/server/views/index.js that serves that file at /assets/theme.css with a text/css content type, so the stylesheet link in the document shell resolves without any static file server. Add tests/views/a11y.test.js asserting that a rendered page has exactly one main landmark, a skip link as the first focusable element, no skipped heading level, a unique title, and a data table for every figure, and add tests/contrast.test.js computing the contrast ratio of every declared token pair and failing below 4.5:1 for text and 3:1 for non-text. The pages must still render without the stylesheet.",
  "ownerAgent": "ui-engineer",
  "dependencies": ["RS-UI-02", "RS-UI-03"],
  "expectedOutputs": ["src/server/views/a11y.js", "src/server/views/index.js", "src/ui/theme.css", "tests/views/a11y.test.js", "tests/contrast.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/views/a11y.test.js tests/contrast.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-views.md#RS-UI-FR-04", "docs/PRD.md#RS-AX-02", "docs/PRD.md#RS-AX-03", "docs/PRD.md#RS-AX-05", "docs/PRD.md#RS-AX-06"],
    "acceptanceCriteria": ["Each rendered page has exactly one main landmark and a skip link as its first focusable element", "A test walks the heading sequence of each page and fails on a skipped level", "Every figure element has a sibling data table carrying the same values", "Every text token pair in the stylesheet meets 4.5:1 and every non-text pair meets 3:1, asserted by computing the ratios", "No file other than the stylesheet declares a colour literal, asserted by a repository search in the test", "A page rendered without the stylesheet still contains every value in text form", "Requesting the stylesheet route returns the theme file with a text/css content type and no remote font reference"],
    "constraints": ["No remote font and no icon font; system fonts only", "No animation or transition, and the reduced-motion preference is respected trivially because there is none"],
    "constraintRefs": ["docs/features/dashboard-views.md#RS-UI-CON-01", "docs/PRD.md#RS-AX-01", "docs/PRD.md#RS-SC-01"],
    "references": ["docs/PRD.md#9. Accessibility"]
  }
}
```

```forge-task
{
  "id": "RS-UI-05",
  "title": "Exercise every page against the running server",
  "description": "Add tests/integration/dashboard-e2e.test.js, an integration test that seeds a temporary home with a migrated archive containing a deliberate hole, two snapshot captures, a backfilled and a collected range, and a mix of health states, then starts the real server and requests the index, the repository list, the detail page, the health page, an unknown repository and an inverted range. Assert the six outcomes, that the gap renders without any substituted zero, that the security headers are present, and that the accessibility assertions hold on the served markup rather than on a rendered string in isolation. This task adds tests only; if a production change is needed, report it rather than editing src.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["RS-UI-04", "RS-SRV-04"],
  "expectedOutputs": ["tests/integration/dashboard-e2e.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/integration/dashboard-e2e.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-views.md#RS-UI-FR-05"],
    "acceptanceCriteria": ["The six requests return 200, 200, 200, 200, 404 and 400 respectively", "The deliberate hole appears as a gap in the served detail page and no zero is emitted for that day", "The served markup satisfies the landmark, heading-order and table-alternative assertions", "Every response carries the content security policy and no-store headers", "The test performs no outbound request to any host and needs no token"],
    "constraints": ["Tests only; production behaviour is not changed to make a test pass", "Seeded data must be written through the repositories, not by direct SQL that skips the invariants"],
    "constraintRefs": ["docs/features/dashboard-views.md#RS-UI-CON-01", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-TC-04", "docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-DU-02"],
    "references": ["docs/PRD.md#7.4 Shared Definition Index"]
  }
}
```

### Phase 3: Human journey and accessibility review

```forge-task
{
  "id": "RS-UI-REV-01",
  "title": "Human review of the dashboard journey and its accessibility",
  "description": "Start the dashboard with `node src/cli.js serve` against a home that holds at least two weeks of seeded data, then complete the primary maintainer journey by hand: open the list, open one repository, read the current numbers, find the day a spike happened, see the gap where a day is missing, read the change list, open the health page and notice that one repository needs re-authentication. Repeat the journey with the keyboard only, then with a screen reader, checking the skip link, the heading navigation, the chart alternatives and the state words. Record the rubric scores, what was actually exercised, any upstream validation gap you confirmed, and every defect found in docs/reviews/dashboard-accessibility.json. Do not approve a page that renders but does not answer the question.",
  "dependencies": ["RS-UI-05"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-views.md#RS-UI-FR-04", "docs/features/dashboard-views.md#RS-UI-FR-02"],
    "acceptanceCriteria": ["The review file states that the primary journey was completed against the running dashboard, naming the steps taken and the data used", "A keyboard-only pass is recorded with the focus order observed, including the skip link as the first stop", "A screen-reader pass is recorded naming how the chart, the gap and the health states were read", "Every accessibility rule in the vision has a recorded result, with unverified rules marked unverified", "Each defect found is written as a reproducible step rather than a general impression"],
    "constraints": ["No agent may author or complete this review file", "Visual polish alone never satisfies this review; a polished page that does not answer the maintainer's question fails"],
    "constraintRefs": ["docs/PRD.md#RS-AX-01", "docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-DU-02"],
    "references": ["docs/features/dashboard-views.md#RS-UI-ST-02", "docs/PRD.md#9. Accessibility"],
    "reviewFile": "docs/reviews/dashboard-accessibility.json"
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Each view's markup, section order, states, escaping | Render a view with a seeded context and assert on the returned string |
| Unit | Accessibility contract and contrast ratios | Structural assertions plus computed contrast ratios over the stylesheet tokens |
| Entry point | The serve command on loopback | Spawn `node src/cli.js serve --port 0` and make an HTTP request |
| Integration | Every page against the running server | One integration test with seeded data and a deliberate hole |
| Human | Journey, keyboard, screen reader | Rubric review recorded after the dashboard is run |

Key test scenarios:

1. The registry maps three routes and the serve command serves the list page over loopback.
2. The detail page renders sections in the reviewed order and shows a gap where a day is missing.
3. A repository with no data renders a first-connect state, not an empty chart.
4. Each of the six health states renders its own text state word and the right action.
5. Every page has one main landmark, a first-position skip link, no skipped heading level and a table per figure.
6. Every text colour pair meets 4.5:1 and every non-text pair meets 3:1.
7. An unknown repository returns 404 and an inverted range returns 400.

---

## 8. Acceptance Criteria

1. A maintainer can go from the repository list to a single repository's story in one click, with the range in the URL.
2. Every page renders its content in text form, with charts accompanied by their tables.
3. The accessibility contract is asserted mechanically and then exercised by a human.
4. The dashboard is served only on loopback, with the documented security headers.
5. A missing day is never shown as a zero, and no page claims more than the archive contains.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the dashboard be one page per repository or a single scrolling page? | One page per repository, because the range belongs in the URL and two repositories must be comparable without scrolling |
| 2 | Should there be a cross-repository comparison view? | No for v1. Comparing other maintainers' repositories is a non-goal, and comparing one's own is a chart the archive can produce later |
| 3 | Should the change list be capped on the page? | Yes, at twenty entries with a count of the remainder, matching the insight module |
| 4 | Should the health page be the landing page? | No. The list page is the landing page, with a health summary line linking to the health page when something needs attention |
