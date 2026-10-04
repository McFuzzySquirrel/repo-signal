# Feature: Dashboard Server

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C02 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C03 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C11 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-NF-04 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-SRV-ST-01 | This feature | owns |
| RS-SRV-C01 | This feature | owns |
| RS-SRV-C02 | This feature | owns |
| RS-SRV-C03 | This feature | owns |
| RS-SRV-C04 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Dashboard Server
**ID Prefix:** RS-SRV
**Summary:** The read-only HTTP surface: a `node:http` server bound to `127.0.0.1` on an ephemeral
port, a request handler that refuses non-loopback peers and every method but GET and HEAD, a fixed
set of security headers on every response, a router that validates the URL and the date range before
a view runs, a view registry that mounts pages and serves the one stylesheet, and a page data layer
that reads the archive without interpreting it.
**Dependencies:** Foundation and Runtime, Archive Storage, Collection Supervision and Report
**Priority:** Must
**As-built status:** Built, covered by `tests/server.test.js`, `tests/router.test.js`,
`tests/html.test.js`, `tests/repo-data.test.js`, `tests/serve-command.test.js` and
`tests/integration/server-e2e.test.js`.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-SRV-ST-01 | Maintainer | a dashboard on my own loopback address that serves the archive and nothing else, so that reading my traffic needs no account, no hosting and no outbound request | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-SRV-C01","kind":"constraint","text":"The server binds to 127.0.0.1 on an ephemeral port, destroys any socket whose peer is not loopback, answers only GET and HEAD, rejects an over-long URL with 414 and any other method with 405 and an Allow header, and answers HEAD with the GET headers and no body."}
```

```forge-requirement
{"id":"RS-SRV-C02","kind":"constraint","text":"Every response carries a default-src none content security policy with script-src none, style-src and img-src limited to self, no base-uri, no form-action, no frame-ancestors, plus no-store caching, a no-referrer policy, nosniff and an explicit UTF-8 HTML content type; a view that throws produces a generic 500 page with no message, stack or forwarded header, logged locally with redaction."}
```

```forge-requirement
{"id":"RS-SRV-C03","kind":"constraint","text":"The router resolves the index, the repository list, a repository detail page and the health page, folds a trailing slash, refuses a malformed day or an inverted range in words, percent-decodes owner and name and answers 400 on a decode failure, and answers 404 for an unknown repository before any view runs."}
```

```forge-requirement
{"id":"RS-SRV-C04","kind":"constraint","text":"The view registry mounts pages, paths and assets from three tables, answers its own routes in front of the router without extending the router's route table, defaults the window to the last fourteen days ending today, keeps a bound the URL carried, and refuses an inverted result in words rather than silently swapping the bounds."}
```

```forge-requirement
{"id":"RS-SRV-C05","kind":"constraint","text":"The page data layer validates the range before its first query, returns the calendar and the stored rows as two separate lists so a missing day is distinguishable from an absent series, returns an unknown repository as unknown rather than throwing, and passes health and provenance through unmodified."}
```

---

## 4. Command and Output Design

`serve` prints the address it is listening on, the links to the repository list and the health page,
the stylesheet address, the archive path it is reading, and the sentence that the dashboard only
reads the archive while it is open and stops on Ctrl-C. A port argument other than 0 is refused by
name rather than honoured, which keeps the dashboard off a routable interface by construction rather
than by configuration.

Documents are server-rendered HTML: text, attribute and URL escaping at the point of use, a skip link
as the first element, exactly one main landmark, the local stylesheet, and a footer stating that the
page is served from loopback, loads no remote asset and runs no script.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Peer checks, methods, headers, error responses | Existing `tests/server.test.js` |
| Unit | Path resolution, ranges, escapes, unknown repository | Existing `tests/router.test.js` |
| Unit | Shell structure and escaping | Existing `tests/html.test.js` |
| Unit | Page reads, unknown repository, range validation | Existing `tests/repo-data.test.js` |
| Integration | The running server and a stub view registry | Existing `tests/integration/server-e2e.test.js` and `tests/integration/dashboard-e2e.test.js` |
| Contract | Documented server claims against the implementation | Created by task RS-SRV-CONTRACT-01 |

Key scenarios: a request from a non-loopback peer is refused before routing; a POST is refused with an
Allow header; a throwing view yields a 500 page whose body contains neither the message nor the
stack; an unknown repository yields 404 without the view running; an inverted range is refused in
words; the stylesheet is served from the local file with a text/css content type.

---

## 6. Implementation Tasks

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-SRV-CONTRACT-01",
  "title": "Assert the documented dashboard claims against the server implementation",
  "description": "The README and the privacy note promise that the dashboard is loopback-only, unauthenticated, serves no remote asset, runs no client-side script and sends four specific headers, and the health runbook names the state words the page prints. Create `tests/contract-server.test.js` asserting those claims against `src/server/security.js`, `src/server/server.js`, `src/server/views/index.js` and `src/server/router.js`: the four headers and their values on every response, the absence of any remote host in the served markup and stylesheet, the loopback bind and the refusal of a non-loopback peer, the GET and HEAD method set, and that every state word the health page can print is one the health read can return. Where the documentation and the code disagree, fix the document and record the disagreement in the task notes. Do not change the bind address, the header set, the routing table or the state vocabulary.",
  "ownerAgent": "documentation-engineer",
  "dependencies": [],
  "expectedOutputs": ["tests/contract-server.test.js"],
  "validationCommands": ["npm test -- tests/contract-server.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert the documented dashboard security and accessibility claims hold against the server, its headers and its routes"],
    "requirementRefs": [],
    "acceptanceCriteria": ["A test asserts the exact four security headers and their values on a served response", "A test fails if any served page or the stylesheet references a remote host or a script", "A test asserts a non-loopback peer is refused and only GET and HEAD are accepted", "tests/contract-server.test.js reports more than zero executed tests"],
    "constraints": ["Do not weaken, remove or add a response header", "Do not make the server reachable from a routable interface"],
    "constraintRefs": ["docs/features/dashboard-server.md#RS-SRV-C01", "docs/features/dashboard-server.md#RS-SRV-C02", "docs/features/dashboard-server.md#RS-SRV-C04", "docs/PRD.md#RS-C11", "docs/PRD.md#RS-C03", "docs/PRD.md#RS-C12"],
    "references": ["docs/features/dashboard-server.md#4. Command and Output Design", "docs/features/dashboard-server.md#3. Functional Constraints"]
  }
}
```

---

## 7. Acceptance Criteria

1. The dashboard is reachable only from loopback, and only over GET and HEAD.
2. Every response carries the four security headers and a no-store cache directive.
3. A failing view produces a generic 500 page that leaks neither a message nor a stack.
4. An unknown repository, a malformed day and an inverted range are each refused in words before a
   view runs.
5. No served page or stylesheet references a remote host or a script.
6. The documented claims above are asserted by a named test.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | The dashboard is unauthenticated because it is loopback-only; should it refuse to start on a machine with a shared account? | Out of scope: the bind address is the control, and it is fixed |
| 2 | Only port 0 is honoured, which makes a remembered bookmark useless across restarts | Keep it: the printed address is the way in, and the runbook names it |
| 3 | Should the health page offer a refresh control without script? | No: the page states the instant it read, and reloading is the reader's action |