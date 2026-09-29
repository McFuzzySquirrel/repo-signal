# Feature: GitHub API Client

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SC-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SC-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SC-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SP-01 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SP-02 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SP-04 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SP-05 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-API-FR-01 | This feature | owns |
| RS-API-FR-02 | This feature | owns |
| RS-API-FR-03 | This feature | owns |
| RS-API-FR-04 | This feature | owns |
| RS-API-CON-01 | This feature | owns |
| RS-API-ST-01 | This feature | owns |
| RS-API-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** GitHub API Client
**ID Prefix:** RS-API
**Summary:** The only code that talks to GitHub: one transport with a host allowlist and a pinned
API version, one retry and rate-limit policy, and thin clients for the traffic, repository, star
and statistics endpoints.
**Dependencies:** Foundation and Runtime
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-API-ST-01","kind":"story","text":"As a solo maintainer I want the collector to respect GitHub's rate limits and to wait out a statistics cache being compiled, so that a nightly run degrades politely instead of being blocked."}
```

```forge-requirement
{"id":"RS-API-ST-02","kind":"story","text":"As a solo maintainer I want a missing permission named in plain words, so that I know whether to wait, to re-authenticate or to change the token's scope."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-API-FR-01","kind":"requirement","text":"Provide a credential provider interface and one HTTP transport that resolves the token through that interface, sends the Authorization, Accept, X-GitHub-Api-Version and User-Agent headers, enforces the api.github.com host allowlist before a socket is opened, applies a request timeout, and refuses to follow a redirect to a different host. A test-only override to a 127.0.0.1 base URL is accepted only when an explicit environment flag is set and is refused otherwise."}
```

```forge-requirement
{"id":"RS-API-FR-02","kind":"requirement","text":"Provide one retry and rate-limit policy: parse the rate-limit and retry headers, sleep until the reset instant when the primary budget is exhausted, back off exponentially with jitter and a cap for 429, 5xx and 202 responses, treat 202 as retryable only for the statistics endpoints, and fail fast with a typed error for 401, 403 and 404. The clock and the sleep function are injected so the policy is testable without waiting."}
```

```forge-requirement
{"id":"RS-API-FR-03","kind":"requirement","text":"Provide traffic clients for clones, views, referrers and popular paths that normalize the documented response shapes into records with a UTC day and integer counts, assert that a day breakdown never exceeds fourteen entries, and translate a 403 into a typed permission error naming the Administration read permission."}
```

```forge-requirement
{"id":"RS-API-FR-04","kind":"requirement","text":"Provide a repository client for the repository record and its releases, a stargazer client that requests the star-timestamp media type and follows pages until the last page, and a statistics client for weekly participation and commit activity that surfaces 202 as a retryable outcome rather than as data."}
```

```forge-requirement
{"id":"RS-API-CON-01","kind":"constraint","text":"Every request this client makes is a read. No method other than GET may be issued, and no client function accepts a request body, so a future edit cannot turn the collector into a writer."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-API-ST-01 | story | Must |
| RS-API-ST-02 | story | Must |
| RS-API-FR-01 | requirement | Must |
| RS-API-FR-02 | requirement | Must |
| RS-API-FR-03 | requirement | Must |
| RS-API-FR-04 | requirement | Must |
| RS-API-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

The client has no user interface. Its observable contract is the single-line error taxonomy the
collector and the dashboard share: an authentication failure, a permission failure naming
`Administration` read, a rate-limit wait, a missing repository, and a transient failure. Each is
a distinct error kind so the collector can decide whether to retry, stop the repository, or stop
the run.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-API-01 | One transport enforces the allowlist, headers, timeout and redirect rules | github-integration-engineer | RS-FND-05 | src/github/credential-provider.js, src/github/http.js, tests/github-http.test.js | allowlist, header set, redirect refusal, redaction, localhost override gate | Retry policy, endpoint shapes |
| RS-API-02 | One policy turns rate limits, 202, 429 and 5xx into waits and typed failures | github-integration-engineer | RS-API-01 | src/github/retry.js, src/github/rate-limit.js, tests/github-retry.test.js | reset wait, capped backoff, 202 retry, fail-fast kinds | Endpoint parsing |
| RS-API-03 | The four traffic endpoints normalize into day records and typed permission errors | github-integration-engineer | RS-API-02 | src/github/traffic-client.js, tests/traffic-client.test.js | field mapping, fourteen-day bound, 403 translation | Repository, star and statistics calls |
| RS-API-04 | Repository, stargazer and statistics clients paginate and interpret 202 | github-integration-engineer | RS-API-03 | src/github/repo-client.js, src/github/stars-client.js, src/github/stats-client.js, tests/repo-client.test.js, tests/stars-client.test.js, tests/stats-client.test.js | pagination to the last page, star media type, 202 as retryable | Collection orchestration, storage |

---

## 6. Implementation Tasks

### Phase 1: Transport and request policy

```forge-task
{
  "id": "RS-API-01",
  "title": "Build the credential provider and the allowlisted HTTP transport",
  "description": "Implement src/github/credential-provider.js as the interface the collector sees (a getToken call and nothing else about where the token came from) and src/github/http.js as the single place a request leaves the process. The transport must refuse any host other than api.github.com before a socket is opened, send the Authorization bearer header, the Accept media type application/vnd.github+json, the User-Agent identifying repo-signal and its version, and the X-GitHub-Api-Version header pinned in a single exported constant whose value is 2026-03-10; it must apply a timeout, refuse to follow a redirect to another host, and pass every error through the credential redaction helper so a token-shaped value cannot escape. A test-only base URL of 127.0.0.1 is accepted only when REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT is set and is refused otherwise. Unit tests use an injected fetch stub and assert the header set, the refusal, the redirect refusal and the absence of the token from an error message.",
  "ownerAgent": "github-integration-engineer",
  "dependencies": ["RS-FND-05"],
  "expectedOutputs": ["src/github/credential-provider.js", "src/github/http.js", "tests/github-http.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/github-http.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/github-api-client.md#RS-API-FR-01", "docs/PRD.md#RS-SP-01", "docs/PRD.md#RS-SP-04", "docs/PRD.md#RS-SP-05"],
    "acceptanceCriteria": ["A request to a host other than api.github.com is refused and the injected fetch stub is never called", "The captured outbound headers include Accept, Authorization, X-GitHub-Api-Version 2026-03-10 and a User-Agent naming repo-signal", "A redirect to a different host is refused rather than followed", "A thrown error containing a token-shaped value is redacted before it leaves the transport", "A 127.0.0.1 base URL is accepted only with REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT set"],
    "constraints": ["Only GET may be issued and no request body may be accepted", "No telemetry, update check or second host may be introduced in this module"],
    "constraintRefs": ["docs/features/github-api-client.md#RS-API-CON-01", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-SC-02", "docs/PRD.md#RS-SC-04", "docs/PRD.md#RS-TC-01"],
    "references": ["docs/PRD.md#6.1 Technology Stack", "docs/PRD.md#16. Open Questions"]
  }
}
```

```forge-task
{
  "id": "RS-API-02",
  "title": "Implement the rate-limit and retry policy",
  "description": "Implement src/github/rate-limit.js to read the rate-limit and retry headers into a budget record, and src/github/retry.js to apply the single policy every client shares on top of the transport in src/github/http.js: wait until the reset instant when the primary budget is exhausted, back off exponentially with jitter and a hard attempt cap for 429 and 5xx, treat 202 as retryable only when the caller marked the endpoint as a statistics endpoint, and convert 401, 403 and 404 into distinct typed errors without retrying. The clock and the sleep function are injected, so the tests assert the chosen delays and attempt counts without spending real time. Include the case where the reset instant is already in the past and the case where the caller runs out of attempts, which must surface the last status.",
  "ownerAgent": "github-integration-engineer",
  "dependencies": ["RS-API-01"],
  "expectedOutputs": ["src/github/rate-limit.js", "src/github/retry.js", "tests/github-retry.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/github-retry.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/github-api-client.md#RS-API-FR-02", "docs/PRD.md#RS-SP-02"],
    "acceptanceCriteria": ["An exhausted primary budget produces a sleep until the reset instant and no further attempt before it", "A 202 from a statistics endpoint is retried and a 202 from a traffic endpoint is surfaced without retry", "A 429 and a 500 are retried with increasing capped delays and the recorded attempt count is asserted", "401, 403 and 404 each produce a distinct error kind and are attempted exactly once", "Reaching the attempt cap surfaces the last status code rather than a generic failure"],
    "constraints": ["No real sleeping in tests: the clock and sleep function are injected", "Do not add endpoint-specific parsing in this task"],
    "constraintRefs": ["docs/features/github-api-client.md#RS-API-CON-01", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces"]
  }
}
```

### Phase 2: Endpoint clients

```forge-task
{
  "id": "RS-API-03",
  "title": "Normalize the four traffic endpoints",
  "description": "Implement src/github/traffic-client.js with one function per traffic endpoint: clones, views, referrers and popular paths. Each maps the documented response shape into records carrying a UTC day, an integer count and an integer uniques value, and a 403 becomes a typed permission error naming the Administration read permission rather than a generic failure. The day breakdown must be rejected if it contains more than fourteen entries, because a longer window would mean a misunderstood contract rather than more data. The tests use fixture response bodies and cover the week versus day parameter, an empty breakdown, a missing timestamp and the fourteen-entry bound.",
  "ownerAgent": "github-integration-engineer",
  "dependencies": ["RS-API-02"],
  "expectedOutputs": ["src/github/traffic-client.js", "tests/traffic-client.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/traffic-client.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/github-api-client.md#RS-API-FR-03", "docs/PRD.md#RS-SP-02"],
    "acceptanceCriteria": ["A clones response with three day entries yields three records with UTC days and integer counts", "A breakdown longer than fourteen entries is rejected with a message naming the observed length", "An empty breakdown yields an empty array and no error", "A 403 response produces a permission error whose message names the Administration read permission", "The referrers and popular paths clients return records carrying count and uniques with no day assigned"],
    "constraints": ["No storage or collection behaviour in this task", "Do not interpolate or default a missing day in the returned records"],
    "constraintRefs": ["docs/features/github-api-client.md#RS-API-CON-01", "docs/PRD.md#RS-DU-02"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces"]
  }
}
```

```forge-task
{
  "id": "RS-API-04",
  "title": "Add the repository, stargazer and statistics clients",
  "description": "Implement src/github/repo-client.js for the repository record and its releases, src/github/stars-client.js for the stargazer list requested with the star-timestamp media type, and src/github/stats-client.js for weekly participation and commit activity. The stargazer client must follow pages until the response advertises no next page and hand each page to a caller-supplied callback so a multi-thousand-star repository is never buffered whole. The statistics client must return a retryable outcome for 202 and data for 200, and must expose that a repository with no statistics yet is a normal state rather than an error. The tests cover pagination across three pages, the media type sent, the 202 then 200 sequence, and the field mapping of participation and commit activity.",
  "ownerAgent": "github-integration-engineer",
  "dependencies": ["RS-API-03"],
  "expectedOutputs": ["src/github/repo-client.js", "src/github/stars-client.js", "src/github/stats-client.js", "tests/repo-client.test.js", "tests/stars-client.test.js", "tests/stats-client.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/repo-client.test.js tests/stars-client.test.js tests/stats-client.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/github-api-client.md#RS-API-FR-04", "docs/PRD.md#RS-VR-01"],
    "acceptanceCriteria": ["The stargazer client requests the star-timestamp media type and the test asserts the header value", "A three-page stargazer listing is fully consumed and the test asserts the page numbers requested and the callback invocation count", "A 202 response from a statistics endpoint yields a retryable outcome and a following 200 yields parsed weekly data", "An empty participation response is reported as no statistics yet, not as an error", "The repository record maps stars, forks and watchers into plain fields with no interpretation"],
    "constraints": ["No writes, no repository mutation and no storage access in these modules", "Do not start a timer or scheduler in a client"],
    "constraintRefs": ["docs/features/github-api-client.md#RS-API-CON-01", "docs/PRD.md#RS-SC-04", "docs/PRD.md#RS-HO-01"],
    "references": ["docs/PRD.md#16. Open Questions"]
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Transport allowlist, headers, timeout, redirect, redaction | Injected fetch stub; no socket is opened |
| Unit | Retry and rate-limit policy | Injected clock and sleep function; delays and attempt counts are asserted, never waited |
| Unit | Endpoint response mapping | Recorded fixture response bodies, including empty, oversized and 202 cases |
| Human | The real service | Live verification of every endpoint, media type and permission against a real token, recorded in the operations feature |

Key test scenarios:

1. A non-GitHub host is refused before any request is made.
2. A local base URL is accepted only with the explicit test flag.
3. An exhausted rate-limit budget waits until the reset instant.
4. A 202 retries for a statistics endpoint and does not retry for a traffic endpoint.
5. A day breakdown longer than fourteen entries is rejected.
6. A three-page stargazer listing is consumed without buffering.
7. A token-shaped value never appears in an error message.

---

## 8. Acceptance Criteria

1. Only `api.github.com` is reachable, and a test proves the refusal for every other host.
2. The pinned API version, accept media type and user agent are sent on every request and asserted by a test.
3. Rate limits, 202 responses and transient failures are waited out rather than hammered.
4. 401, 403 and 404 become three distinguishable states that name what the maintainer must do.
5. No function in this feature can issue a method other than GET.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Is 2026-03-10 accepted by every endpoint this client calls? | Yes for the documented ones; the live integration check confirms it, and the pin is a single constant so 2022-11-28 remains an easy fallback before March 2028 |
| 2 | Should the client cache ETag responses to save budget? | No. The archive wants fresh reads, and the budget is small enough that conditional requests add risk without saving meaningful quota |
| 3 | What if GitHub adds fields to these payloads? | Unknown fields are carried through untouched and never interpreted, so a new field cannot silently change a stored value |
