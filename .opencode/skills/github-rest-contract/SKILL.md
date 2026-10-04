---
name: github-rest-contract
description: "The pinned GitHub REST contract RepoSignal depends on: the 2026-03-10 API version header set, the 14-day traffic window bound, 202 Accepted as retryable only for the statistics endpoints, the weekly stargazer history with its last-page pagination, 100-page cap and week-total refusal, the typed per-endpoint failure taxonomy, and the vendor pages that must be re-read rather than remembered. Use when writing or changing anything under src/github/, or when a test mocks a GitHub response or states what an endpoint returns."
---

# Skill: GitHub REST Contract

The modules under `src/github/` are the only code that talks to GitHub, and PRD section 6.5 records
which vendor page each contract was read from and which module enforces it. That makes the vendor API
this project's main external drift surface: a payload, media type or status code can change and no
local test can detect it.

Load [vendor-documentation.md](./references/vendor-documentation.md) when you need to confirm a
header, a window bound, a media type, a status code or a pagination cap, and before changing the pinned
version constant or any client validation rule.

## Process

### Step 1: Pin the version in one constant

`GITHUB_API_VERSION` is a single exported constant in `src/github/http.js`, and nothing else writes
the date string. Changing the pin is a one-line edit, and it is still a contract change: the mocked
tests are updated in the same change, and the live integration gate is what confirms the real service
accepts it. If a newer version is not confirmed live, then stay on the current pin and record the
change as unverified rather than shipping two active versions.

### Step 2: Send the documented header set

Every request carries the version header, the endpoint's `Accept` media type, the bearer authorization
and a `User-Agent` naming the project, and nothing else. A header set is asserted by a test that
captures the outbound request through an injected fetch stub, so a dropped header fails a suite rather
than a live run. An `Accept` that is empty or carries a line break is refused before the socket opens.

### Step 3: Assert each endpoint's own bound

The traffic endpoints return a rolling 14-day window of `day` or `week` entries, so a day breakdown
longer than fourteen is rejected with a message naming the observed length: a longer window means a
misunderstood contract, not more data. Do not pad a short response to fourteen either, because referrers
and popular paths are undated aggregate snapshots and a day must never be invented for them. A
timestamp must carry an explicit zone, and its day is derived from the UTC instant rather than guessed.

### Step 4: Retry `202` only where it means something

A `202 Accepted` from a statistics endpoint means the cache is still compiling, so it is a retryable
outcome with backoff and a later `200` supplies the data. A `202` from any other endpoint family is not
a documented meaning, and it is returned untouched once for the client to surface rather than retried.
Never write a statistics `202` as data: an empty array read as a week of zeros is a fabricated
observation.

### Step 5: Map statuses into the typed taxonomy

`401`, `403` and `404` fail fast with distinct kinds after exactly one attempt. `429` and `5xx` back
off with jitter under a floor and a hard attempt cap, and reaching the cap surfaces the last status
code rather than a generic failure. A transport error is never retried. A malformed rate-limit header
reads as `null` rather than as zero, `Retry-After` is accepted as integer seconds or an HTTP-date and
clamped when it is already past, and the primary-budget delay applies only when the remaining budget is
exactly zero with a known reset instant. The clock and the sleep function are injected, so no test
spends real time.

### Step 6: Paginate the star history to the last page

**The star backfill reads `/repos/{owner}/{repo}/stargazers/history`, not the `/stargazers` listing.**
GitHub restricted the listing to admins and collaborators in July 2026, because the public lists were
being used to harvest users for spam; the changelog entry is dated 2026-06-30 and is cited from
`src/github/retry.js`. The history endpoint was not in that list and answers an unauthenticated
caller, and it returns the cumulative daily shape without enumerating a single user, which is exactly
the data the restriction exists to protect.

It serves weeks as `{ week, total, days[7] }`, where `total` is the stars created in that week and
`days` counts them from Sunday, and the series walks backwards toward the repository's creation week.
Pagination follows only the advertised `rel="next"` Link and never a fixed page count. The vendor caps
a page at 30 weeks and the series at 100 pages, so a series past that cap is reported as truncated
rather than read as a whole history.

Two contract details are verified rather than trusted. A week whose `total` disagrees with the sum of
its own `days` is refused, not reconciled, because reconciling it would invent a distribution across the
week. And a week start that is not a positive whole number of days since the epoch is refused by name,
so a bucket this archive cannot name is never shifted onto a day that never held those stars.

### Step 7: Re-read the vendor page before assuming a detail

An endpoint detail that was assumed rather than verified - a query parameter, a payload field, a media
type, a permission - must be confirmed against the vendor's own documentation, and the live integration
gate is the recorded evidence. Carry unknown fields through untouched and never interpret them, so a
new field cannot silently change a stored value. If the page and a fixture disagree, then the page
wins and the fixture is updated in the same change.

## Gotchas

- **A statistics `202` stored as data becomes a row of zeros.** The retryable outcome and the empty
  response are different results, so store only the `200` payload and record a `202` that never resolves
  as no statistics yet rather than as a failure.
- **A `403` on a traffic endpoint is a permission state, not a rate limit.** It names the
  `Administration repository permission (read)` a fine-grained token needs and it persists until the
  install accepts the permission upgrade, so retrying it or re-reading the credential wastes the run.
- **A `403` on the stargazer family is neither of those.** It is the admin-and-collaborator restriction
  on the listing, which no grantable token permission changes, so the family carries its own endpoint
  type. Classifying it as a missing permission produces advice that cannot work.
- **A refused star history must not cost the product its traffic.** The refusal is recorded against the
  repository, the star history is reported absent on every collection line, and the traffic half of the
  run continues.
- **The pinned version has a real fallback window.** An unaccepted pin is recoverable by moving one
  constant, but only a live check proves acceptance and the fallback must not be written as two active
  versions.
- **A fixed page count instead of `rel="next"` silently truncates history.** Any client that stops after
  N pages produces a short but plausible star curve with no error anywhere.
- **An empty breakdown is a valid answer.** It yields an empty array and no error, and it must not be
  padded to a full window or converted into zeros for the days it did not cover.
- **A repository with no statistics yet is a normal state.** Report it as such instead of as a failed
  collection, or a first-connect install shows a permanent error state.
- **One vendor change already reshaped this product.** The stargazer restriction forced the backfill
  onto the weekly endpoint and made a recorded refusal permanent, so any client that assumes the
  listing is reachable is working from a superseded assumption.

## Validation

Self-check with the client tests, each of which asserts an assumption rather than exercising a
fixture's shape:

- [ ] The pinned version appears exactly once as an exported constant, and a test asserts the outbound
      header carries it.
- [ ] A day breakdown of fifteen entries is rejected with a message naming the observed length, and an
      empty breakdown returns an empty array with no error.
- [ ] A statistics endpoint answering `202` then `200` yields stored weekly rows, and a `202` on a
      traffic endpoint is surfaced without a retry.
- [ ] `401`, `403` and `404` each produce a distinct error kind after exactly one attempt, and the
      `403` message names the `Administration` read permission.
- [ ] A three-page star history is fully consumed, with the page numbers requested and the callback
      invocation count asserted.
- [ ] A week whose `total` disagrees with its own `days` is refused, and an unaligned week start is
      refused by name rather than placed on a calendar day.
- [ ] A series past the 100-page cap is reported as truncated rather than as a whole history.
- [ ] Every claim about a live endpoint is recorded in the human live-integration review rather than
      inferred from mocked test output.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default a claim no mock can prove is recorded as unverified rather
      than as verified.