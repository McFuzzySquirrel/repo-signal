# Feature: Local Dashboard Server

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-TC-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SC-03 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SP-06 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SP-07 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-PR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SRV-FR-01 | This feature | owns |
| RS-SRV-FR-02 | This feature | owns |
| RS-SRV-FR-03 | This feature | owns |
| RS-SRV-FR-04 | This feature | owns |
| RS-SRV-CON-01 | This feature | owns |
| RS-SRV-ST-01 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Local Dashboard Server
**ID Prefix:** RS-SRV
**Summary:** The loopback HTTP surface and the data access pages read from: routing with the
repository and date range in the URL, strict output escaping, security headers, and a page data
layer that never invents a day.
**Dependencies:** Foundation and Runtime, Telemetry Storage and Migrations
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-SRV-ST-01","kind":"story","text":"As a solo maintainer I want a dashboard I can open with a plain browser and a bookmark that keeps working, so that the archive is one click away instead of a command to remember."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-SRV-FR-01","kind":"requirement","text":"Provide a server factory that binds to 127.0.0.1 only, refuses a connection from any non-loopback address, answers with a content security policy allowing only same-origin styles and no script, sends Cache-Control no-store and a no-referrer policy, allows only GET and HEAD, limits the request URL length, and returns a generic 500 page with a correlation-free body when a view throws, while logging the detail locally."}
```

```forge-requirement
{"id":"RS-SRV-FR-02","kind":"requirement","text":"Route three pages: an index, a repository list, and a repository detail addressed as `/repo/{owner}/{name}` with optional `from` and `to` query parameters in ISO day form. Validate the parameters, reject a malformed or inverted range with a 400 page that names the problem, return a 404 page for an unknown repository or path, and keep the selected repository and range in the URL so a page can be bookmarked and shared with no one."}
```

```forge-requirement
{"id":"RS-SRV-FR-03","kind":"requirement","text":"Escape every dynamic value that reaches a page. Provide one escaping helper used by all views for text, attribute, and URL contexts, and one document shell that carries the language declaration, the page title, the theme stylesheet link and the skip link, so no view can accidentally emit unescaped repository, referrer or path text."}
```

```forge-requirement
{"id":"RS-SRV-FR-04","kind":"requirement","text":"Provide the page data layer: for a repository and an inclusive day range, return the stored series per metric, the calendar days the range covers so gaps stay identifiable, the referrer and popular-path captures with their capture times, the health state, and the provenance record. A repository absent from the archive is reported as unknown rather than as an empty one."}
```

```forge-requirement
{"id":"RS-SRV-CON-01","kind":"constraint","text":"The server is unauthenticated and must stay unreachable from another machine: it binds to the loopback interface, sends no cross-origin header, loads no remote asset, and never serves a file from outside the view registry."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-SRV-ST-01 | story | Must |
| RS-SRV-FR-01 | requirement | Must |
| RS-SRV-FR-02 | requirement | Must |
| RS-SRV-FR-03 | requirement | Must |
| RS-SRV-FR-04 | requirement | Must |
| RS-SRV-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

The document shell is one HTML page with a language declaration, a title that names the
repository and range, a skip link as the first focusable element, a header with the product name,
a single `main` landmark, and a footer stating the loopback-only nature of the page. Pages are
served with the same stylesheet and no script. The 400 and 404 pages use the same shell so a
mistyped URL still looks like the product.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-SRV-01 | The server binds to loopback and answers with strict headers | server-engineer | RS-FND-01 | src/server/server.js, src/server/security.js, tests/server.test.js | bind address, refused non-loopback, headers, method allowlist, thrown-view 500 | Routes, views |
| RS-SRV-02 | Routing, range validation and escaping behave as documented | server-engineer | RS-SRV-01 | src/server/router.js, src/server/html.js, tests/router.test.js, tests/html.test.js | three routes, bad range 400, unknown repo 404, escaping in three contexts | Data access, styling |
| RS-SRV-03 | The page data layer returns series, gaps, captures, health and provenance | server-engineer | RS-SRV-02, RS-DB-03, RS-SUP-03, RS-BKL-03 | src/server/repo-data.js, tests/repo-data.test.js | stored rows only, calendar days, captures, unknown repository | Rendering, charts |
| RS-SRV-04 | The server is exercised as a running process with a stub registry | qa-engineer | RS-SRV-03 | tests/integration/server-e2e.test.js | 200, 400, 404, headers, render budget | View content |

---

## 6. Implementation Tasks

### Phase 1: Server, routing and escaping

```forge-task
{
  "id": "RS-SRV-01",
  "title": "Create the loopback server with strict response headers",
  "description": "Implement src/server/server.js as a factory that starts a node:http server bound to 127.0.0.1 and returns its URL and a close function, and src/server/security.js for the response header policy. The server must refuse a connection whose remote address is not loopback, answer with a content security policy that allows same-origin styles and no script, send Cache-Control no-store and a no-referrer policy, allow only GET and HEAD, reject an over-long request URL, and translate a throwing view into a generic 500 page whose body carries no internal detail while the detail is logged locally. The tests start the real server on an ephemeral port and assert the bound address, the headers, the method rejection, the URL-length rejection, and that a throwing view yields 500 without leaking its message.",
  "ownerAgent": "server-engineer",
  "dependencies": ["RS-FND-01"],
  "expectedOutputs": ["src/server/server.js", "src/server/security.js", "tests/server.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/server.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-server.md#RS-SRV-FR-01", "docs/PRD.md#RS-SP-06"],
    "acceptanceCriteria": ["The factory reports a URL on 127.0.0.1 and the test asserts the bound address rather than accepting any address", "Responses carry the documented content security policy, no-store and no-referrer headers, asserted by the test", "A non-GET, non-HEAD request is rejected with 405", "A view that throws yields a 500 whose body contains neither the thrown message nor a stack trace", "An over-long request URL is rejected before any view runs"],
    "constraints": ["No remote asset, no inline script and no cross-origin header may be emitted", "The bind address is not configurable"],
    "constraintRefs": ["docs/features/dashboard-server.md#RS-SRV-CON-01", "docs/PRD.md#RS-SC-03", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-TC-01"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces"]
  }
}
```

```forge-task
{
  "id": "RS-SRV-02",
  "title": "Route the three pages and escape every dynamic value",
  "description": "Implement src/server/router.js to map an incoming request to one of three pages: the index, the repository list, and `/repo/{owner}/{name}` with optional `from` and `to` query parameters in ISO day form. Validate the parameters, reject a malformed or inverted range with a 400 page naming the problem, return 404 for an unknown repository or path, and keep the selected repository and range in the generated links. Implement src/server/html.js with the escaping helpers for text, attribute and URL contexts plus the document shell carrying the language declaration, the page title, the stylesheet link and the skip link. The tests cover the three routes, a valid and an inverted range, a malformed day, an unknown repository, and a repository name containing markup characters in each escaping context.",
  "ownerAgent": "server-engineer",
  "dependencies": ["RS-SRV-01"],
  "expectedOutputs": ["src/server/router.js", "src/server/html.js", "tests/router.test.js", "tests/html.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/router.test.js tests/html.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-server.md#RS-SRV-FR-02", "docs/features/dashboard-server.md#RS-SRV-FR-03", "docs/PRD.md#RS-SP-07"],
    "acceptanceCriteria": ["Each of the three routes resolves to its view and the test asserts the route and the view called", "A from later than to returns 400 with a page naming the inversion", "A malformed day value returns 400 rather than being coerced", "An unknown repository returns 404", "A repository name containing a quote and angle brackets is escaped in text, attribute and URL contexts, asserted per context", "The document shell contains the language declaration, a title, the stylesheet link and a skip link as the first focusable element"],
    "constraints": ["No view module is written in this task; the router receives renderers by injection", "No unescaped interpolation of a dynamic value is permitted anywhere in the output"],
    "constraintRefs": ["docs/features/dashboard-server.md#RS-SRV-CON-01", "docs/PRD.md#RS-SC-03", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#4. Personas"]
  }
}
```

### Phase 2: Page data and running-server verification

```forge-task
{
  "id": "RS-SRV-03",
  "title": "Build the page data layer over the archive",
  "description": "Implement src/server/repo-data.js as the single read path pages use: given an owner, a name and an inclusive day range, return the stored series per metric, the calendar days the range covers so a missing day stays identifiable, the referrer and popular-path captures with their capture times, the health state from the supervision read, and the provenance record. A repository absent from the archive is reported as unknown rather than as an empty repository, and a range is validated before any query runs. The function must never fill, interpolate or default a missing day, and must never return a fabricated first collected day. The tests build an archive with a deliberate hole, two snapshot captures, a health state and a provenance record, and assert each part of the returned shape.",
  "ownerAgent": "server-engineer",
  "dependencies": ["RS-SRV-02", "RS-DB-03", "RS-SUP-03", "RS-BKL-03"],
  "expectedOutputs": ["src/server/repo-data.js", "tests/repo-data.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/repo-data.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-server.md#RS-SRV-FR-04", "docs/PRD.md#RS-VR-02", "docs/PRD.md#RS-VR-03"],
    "acceptanceCriteria": ["The returned series contains only stored days while the returned calendar days include the deliberate hole", "Both snapshot captures are returned with their distinct capture times", "The health state and the provenance record are passed through unchanged from their own reads", "An unknown repository returns an unknown marker and no series", "An invalid range is rejected before any query runs"],
    "constraints": ["No rendering, no HTML and no chart markup in this module", "A missing day is never defaulted to zero or filled from another metric"],
    "constraintRefs": ["docs/features/dashboard-server.md#RS-SRV-CON-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-TC-01"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces"]
  }
}
```

```forge-task
{
  "id": "RS-SRV-04",
  "title": "Exercise the running server end to end with a stub view registry",
  "description": "Add tests/integration/server-e2e.test.js, an integration test that starts the real server over a temporary home with a real migrated archive and a stub view registry, then requests the index, the repository list, a repository detail with a valid range, an inverted range and an unknown repository. Assert the status codes, that the security headers are present on every response, that a repository name containing markup characters is escaped in the returned body, and that a detail page over a six-repository, four-hundred-day range is produced within the render budget. This task adds tests only; if a production change is needed, report it rather than editing src.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["RS-SRV-03"],
  "expectedOutputs": ["tests/integration/server-e2e.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/integration/server-e2e.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/dashboard-server.md#RS-SRV-FR-01", "docs/PRD.md#RS-SP-07"],
    "acceptanceCriteria": ["The five requests return 200, 200, 200, 400 and 404 respectively", "Every response carries the content security policy and the no-store header", "A repository name containing markup characters appears escaped in the body and unescaped nowhere", "A detail page over six repositories and four hundred days is served within the documented render budget, asserted with an injected measurement", "The test performs no outbound request to any host"],
    "constraints": ["Tests only; production behaviour is not changed to make a test pass", "The stub registry is test-local and must not become a product view"],
    "constraintRefs": ["docs/features/dashboard-server.md#RS-SRV-CON-01", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-TC-04", "docs/PRD.md#RS-PR-01"],
    "references": ["docs/PRD.md#7.4 Shared Definition Index"]
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Headers, bind address, method and URL rejection, 500 safety | Real server on an ephemeral loopback port |
| Unit | Routing, range validation, escaping in three contexts | Router called with injected renderers and captured output |
| Unit | Page data shape, gap preservation, unknown repository | In-process against a temporary migrated archive |
| Integration | Running server responses and render budget | One integration test with a stub view registry |
| Human | Keyboard, screen reader and the real journey | Accessibility review in the views feature |

Key test scenarios:

1. The server binds to 127.0.0.1 and refuses a non-loopback peer.
2. A throwing view produces 500 with no internal detail in the body.
3. An inverted range produces 400; an unknown repository produces 404.
4. A repository name containing markup is escaped in text, attribute and URL contexts.
5. A hole in the archive appears in the calendar days but not in the series.
6. A detail page over the largest supported range stays inside the render budget.

---

## 8. Acceptance Criteria

1. The dashboard is reachable from a browser on the same machine and from nowhere else.
2. Every response carries the documented security headers and no cross-origin header.
3. The selected repository and range live in the URL, so a page is bookmarkable.
4. No dynamic value reaches a page unescaped.
5. A missing day is passed to the views as a gap and never as a zero.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the server require a session or a token? | No. Loopback binding is the control, and a browser cannot be pointed at loopback from another machine without an explicit tunnel |
| 2 | What is the default port? | 4173, overridable by a port flag, and the printed URL always shows the real port so a conflict is obvious |
| 3 | Should a HEAD request return the same headers as GET? | Yes, with no body |
| 4 | Should pages be cacheable at all? | No; `no-store` is set, because a stale archive on a local dashboard is a lie about the data's freshness |
