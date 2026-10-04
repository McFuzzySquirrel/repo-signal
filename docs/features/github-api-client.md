# Feature: GitHub API Client

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C02 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-NF-01 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-GHC-ST-01 | This feature | owns |
| RS-GHC-C01 | This feature | owns |
| RS-GHC-C02 | This feature | owns |
| RS-GHC-C03 | This feature | owns |
| RS-GHC-C04 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** GitHub API Client
**ID Prefix:** RS-GHC
**Summary:** The one path to GitHub: a transport that exposes `get` alone, re-checks its host
allowlist on every request, refuses redirects and never sends anything but a `GET`; a rate-limit
reader that never invents a zero; a retry policy that turns a status into a typed failure kind; and
five endpoint clients that validate every field they store.
**Dependencies:** Foundation and Runtime
**Priority:** Must
**As-built status:** Built, covered by `tests/github-http.test.js`, `tests/github-retry.test.js`,
`tests/repo-client.test.js`, `tests/traffic-client.test.js`, `tests/stars-client.test.js` and
`tests/stats-client.test.js`. The one outstanding gap is documentary: two environment variables the
code honours appear in no document.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-GHC-ST-01 | Maintainer | GitHub to be reachable from one audited path that can only ever ask one host for a reading, so that running the collector cannot turn into an exfiltration path | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-GHC-C01","kind":"constraint","text":"The transport exposes a single get(endpoint) call, re-evaluates the allowlist against both the base URL and the resolved target on every request, allows https api.github.com with an empty port, and allows a loopback origin only when REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT is set, the base hostname is 127.0.0.1 and the target origin equals the base origin."}
```

```forge-requirement
{"id":"RS-GHC-C02","kind":"constraint","text":"Every request is a GET with manual redirect handling, an AbortController timeout cleared in a finally block, and exactly the Accept, Authorization bearer, X-GitHub-Api-Version and User-Agent headers; a redirect status or a followed redirect is refused rather than resolved, and the response body is returned unparsed."}
```

```forge-requirement
{"id":"RS-GHC-C03","kind":"constraint","text":"A malformed rate-limit header reads as null rather than as zero, Retry-After is accepted as integer seconds or an HTTP-date and clamped when past, and the primary-budget delay applies only when the remaining budget is exactly zero with a known reset time."}
```

```forge-requirement
{"id":"RS-GHC-C04","kind":"constraint","text":"The retry policy maps 401 to authentication-rejected, 403 to permission-missing with an endpoint-specific action, 404 to repository-missing, 429 to rate-limited and 202 or 5xx to transient; it retries 429, 5xx and statistics 202 only, never retries 401, 403 or 404, applies equal-jitter backoff under a floor, and never retries a transport error."}
```

```forge-requirement
{"id":"RS-GHC-C05","kind":"constraint","text":"Each endpoint client validates what it stores: owner and name of exactly two valid parts, a day breakdown of at most 14 entries, a zoned timestamp resolved to its UTC day, non-negative safe-integer counts, a referrer or path with its required title, a star week whose seven days sum to its total, and a statistics payload that is either data, explicitly absent or explicitly still compiling."}
```

---

## 4. Command and Output Design

| Failure kind | Status | Retried | The action the product reports |
|--------------|--------|---------|----------------------------------|
| `authentication-rejected` | 401 | no | Re-authenticate with a valid GitHub token |
| `permission-missing` | 403 | no | Grant `Administration repository permission (read)` for traffic; for the stargazer endpoint, the July 2026 listing restriction |
| `repository-missing` | 404 | no | Check that the repository still exists |
| `rate-limited` | 429 | yes | Wait out the reported budget, then retry |
| `transient` | 202 for statistics, 5xx | yes | Retry with backoff; `202` means the statistics cache is still compiling |
| `unexpected` | anything else | no | Reported with the observed status and endpoint |

Transport-level failures carry their own codes: configuration, host, credential, network, timeout
and redirect. Each message and endpoint string passes through redaction, so a token-shaped value can
reach neither an error page nor a log line.

The endpoint clients are deliberately narrow. Repository identity returns stars, forks and watchers
as non-negative safe integers and passes every other field through untouched. Traffic refuses a day
breakdown longer than the window GitHub actually serves. Star history streams page by page to a
callback, follows only `Link rel="next"`, stops at the vendor's page cap and reports truncation
rather than pretending the history is complete. Statistics report compiling, absent or data, and
never an empty series treated as zero.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Allowlist, headers, timeout, redirect refusal, header parsing, backoff maths | Existing `tests/github-http.test.js` and `tests/github-retry.test.js` |
| Unit | Per-endpoint validation | Existing `tests/repo-client.test.js`, `tests/traffic-client.test.js`, `tests/stars-client.test.js`, `tests/stats-client.test.js` |
| Integration | A live-shaped transport | `tests/integration/collect-e2e.test.js` against the loopback stub through the gated local transport |
| Contract | Documented transport claims against the code | Created by task RS-GHC-CONTRACT-01 |
| Live | The real host | Not automated: the release checklist records a live integration review that a human performs |

Key scenarios: a base URL of `http://api.github.com` is refused even with the correct host; a redirect
answer is refused rather than followed; a `429` with no `Retry-After` and remaining budget above zero
still waits a floor interval; a stargazer `403` is never retried and carries the listing-restriction
action; a star week whose days do not sum to its total is refused by name.

---

## 6. Implementation Tasks

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-GHC-CONTRACT-01",
  "title": "Document the transport gate and its two environment variables, and assert the contract",
  "description": "Two environment variables are read by this feature and named in no document: REPO_SIGNAL_GITHUB_BASE_URL, which redirects the client at a stub, and REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT, which opens the allowlist to one loopback origin for tests. Add a section to `docs/operations/privacy.md` that names both, states exactly what each one changes, states that the gate exists for tests and cannot widen the product to any real host, and keeps the existing claim-to-file table accurate. Create `tests/contract-transport.test.js` asserting that the privacy note names both variables, that the only host the note allows is api.github.com, that the sent API version header matches the constant in `src/github/http.js`, and that the loopback gate cannot be enabled for a non-loopback base URL. Do not change transport behaviour, do not widen the allowlist, and do not make either variable settable from `config.json`.",
  "ownerAgent": "documentation-engineer",
  "dependencies": [],
  "expectedOutputs": ["docs/operations/privacy.md", "tests/contract-transport.test.js"],
  "validationCommands": ["npm test -- tests/contract-transport.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert every environment variable the transport reads is named in the privacy note, with its effect and its test-only scope"],
    "requirementRefs": [],
    "acceptanceCriteria": ["The privacy note names REPO_SIGNAL_GITHUB_BASE_URL and REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT and explains that neither can reach a host other than api.github.com", "A test reads the sent API version header constant and asserts it equals the version the privacy note records", "A test proves the loopback gate is refused for a non-loopback base URL", "tests/contract-transport.test.js reports more than zero executed tests"],
    "constraints": ["Do not modify src/github/http.js or widen the allowlist", "Do not document a variable the code does not read"],
    "constraintRefs": ["docs/features/github-api-client.md#RS-GHC-C01", "docs/PRD.md#RS-C02", "docs/PRD.md#RS-C12"],
    "references": ["docs/features/github-api-client.md#3. Functional Constraints", "docs/features/github-api-client.md#4. Command and Output Design"]
  }
}
```

---

## 7. Acceptance Criteria

1. No code path can reach a host other than `api.github.com`, and a test fails if one can.
2. Every request is a `GET`, refuses redirects, and carries exactly the four headers the contract names.
3. A malformed rate-limit header degrades to `null`; no absent header is ever read as a zero.
4. `401`, `403` and `404` are never retried, and each maps to the state word and action the runbooks
   document.
5. Every field a client stores is validated before it reaches the archive, and each refusal names the
   field that failed.
6. Both environment variables are documented, and the documented transport contract is asserted by a
   named test.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | The base-URL override is read per command rather than per request; should it be validated once at start-up? | Leave it: the transport re-checks the resolved target on every request, which is the stronger guarantee |
| 2 | Statistics `202` is retried; the vendor documents no retry-after guidance for it | Keep the exponential path and record `transient` if it never settles |
| 3 | Star history stops at the vendor's page cap and reports truncation | Keep truncation visible; a silently truncated history would read as a complete one |