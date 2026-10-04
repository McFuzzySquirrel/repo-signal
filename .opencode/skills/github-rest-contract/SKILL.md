---
name: github-rest-contract
description: "The pinned GitHub REST contract RepoSignal depends on: the 2026-03-10 API version constant and its header set, the 14-day traffic window bound, 202 Accepted as retryable only for statistics endpoints, the weekly star history at /stargazers/history with its last-page pagination and UTC-midnight week check, the typed error taxonomy, and the vendor documentation pages that must be re-read rather than remembered. Use when writing or changing any code under src/github/, any test that mocks a GitHub response, or any claim about what an endpoint returns."
---

# Skill: GitHub REST Contract

The client is the only code that talks to GitHub, and the plan treats the vendor API as an external
drift surface. This skill records the pinned contract once so the client, the collector that must
survive a `202`, and the three test suites that mock it all assert the same assumptions.

Load the page-by-page contract table in [vendor-documentation.md](./references/vendor-documentation.md)
when you need to confirm a header, a window bound, a media type or a status code, or before
changing the pinned version constant.

## Process

### Step 1: Pin the version in one constant

The API version lives in a single exported constant. Nothing else in the codebase writes the date
string. Changing the pin is a one-line edit, but it is a contract change: the mocked tests are
updated in the same change, and the live gate is what confirms the real service accepts it.
If a newer version is not confirmed live, then stay on the current pin and record the change as
unverified rather than shipping two active versions.

### Step 2: Send the documented header set

Every request carries the version header, the endpoint's `Accept` media type, the bearer
authorization and a `User-Agent` naming the project. The header set is asserted by a test that
captures the outbound request through an injected fetch stub, so a dropped header fails the suite
rather than a live run.

### Step 3: Treat the 14-day window as a contract assertion

The traffic endpoints return a rolling 14-day window of `day` or `week` entries. Assert that a day
breakdown never exceeds fourteen entries and reject a longer one with a message naming the observed
length: a longer window means a misunderstood contract, not more data. Do not pad a short response
to fourteen either - store what was returned and let the calendar decide what is missing.

### Step 4: Retry `202` only where it means something

A `202 Accepted` from a statistics endpoint means the cache is still compiling, so it is a
retryable outcome with backoff, and a later `200` supplies the data. A `202` from a traffic
endpoint is not a documented meaning and is surfaced without retry. Never write a statistics `202`
as data: an empty array read as a week of zeros is a fabricated observation.

### Step 5: Map statuses into the typed taxonomy

`401`, `403` and `404` fail fast with distinct kinds and are attempted exactly once. `429` and `5xx`
back off exponentially with jitter and a hard attempt cap, and reaching the cap surfaces the last
status code rather than a generic failure. An exhausted primary budget waits until the reset
instant. The clock and the sleep function are injected, so no test spends real time.

### Step 6: Paginate to the last page

**The star backfill reads `/stargazers/history`, not the `/stargazers` listing.** In July 2026
GitHub limited the listing to admins and collaborators, because the public lists were being used to
harvest users for spam. Announced 2026-06-30:
<https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/>.
`/stargazers/history` and `/stargazers/count` were not in that list and answer an unauthenticated
caller, so the restriction is verified rather than assumed whenever this client changes. The
history endpoint is also the better source: it returns per-day counts without enumerating a single
user, which is exactly the data the restriction exists to protect. It also means the star-timestamp
media type is no longer needed - that existed only to make a *listing* reconstructable.

It serves weeks newest first as `{ week, total, days[7] }`, where `total` is the stars created in
that week, `days` counts them per day from Sunday, and the series walks backwards toward the
repository's creation week. Pages are followed to the last on the advertised `rel="next"` Link, never
a fixed page count, and the vendor caps the series at 100 pages - a series past that is reported as
truncated rather than read as a whole history.

Two contract details are verified rather than trusted. A week whose `total` disagrees with the sum of
its own `days` is refused, not reconciled, because reconciling it would invent a distribution across
the week. And "day boundaries are not guaranteed to align with UTC" is checked per week: a week that
does not begin on a UTC midnight carries buckets this archive cannot name, so it is reported and
skipped rather than shifted onto days that never held those stars.

### Step 7: Re-read the vendor page before assuming a detail

An endpoint detail that was assumed rather than verified - a query parameter, a payload field, a
media type, a permission - must be confirmed against the vendor's own documentation, and the live
integration gate is the recorded evidence. Carry unknown fields through untouched and never
interpret them, so a new field cannot silently change a stored value. If the page and the fixture
disagree, then the page wins and the fixture is updated in the same change.

## Gotchas

- **A statistics `202` stored as data becomes a row of zeros.** The retryable outcome and the empty
  response are different results; store only the `200` payload, and record a `202` that never
  resolves as no statistics yet rather than as a failure.
- **Stargazers without the star media type have no `starred_at`.** The media type in `Accept` is what
  made the full star history reconstructable from a listing. That listing is now restricted, and the
  backfill reads `/stargazers/history` instead, so this gotcha is history: if the backfill ever goes
  back to a listing, the media type in `Accept` is what carries the per-star timestamps, and a
  backfill built from a listing without them cannot be built at all.
- **A 403 on the star endpoints is not a permission.** The listing is restricted to admins and
  collaborators, and no token permission the maintainer can grant changes that. The family is
  therefore its own `endpointType` (`stargazers`): classified as a repository read it produces
  "grant the required token permissions", which is advice that cannot work.
- **A 403 on a traffic endpoint is a permission state, not a rate limit.** It names the
  `Administration` repository read permission for a fine-grained token, and it persists until the
  install accepts the permission upgrade. Retrying it, or re-reading the credential, wastes the run.
- **A 403 on a star endpoint is neither of those.** It is GitHub's admin-and-collaborator
  restriction on the listing, which the backfill no longer reads. If even `/stargazers/history` is
  refused, granting every permission in the product still leaves it 403, so the refusal is recorded
  against the repository, the star history is reported absent, and traffic collection continues. An
  optional history step must never be able to cost the product its data.
- **The pinned version has a real fallback window.** `2022-11-28` remains supported until
  2028-03-10, so an unaccepted pin is recoverable by moving one constant - but only a live check
  proves acceptance, and the fallback must not be written as two active versions.
- **A `Link: rel="next"` header, not a page count, ends pagination.** Any client that stops after a
  fixed number of pages silently truncates a popular repository's history and produces a
  short-but-plausible star curve.
- **An empty breakdown is a valid answer.** It yields an empty array and no error, and it must not be
  padded to a full window or converted into zeros for the days it did not cover.
- **A repository with no statistics yet is a normal state.** Report it as such instead of as a
  failed collection, or a first-connect install will show a permanent error state.

## Validation

Self-check with the client tests, each of which asserts an assumption rather than exercising a
fixture's shape:

- [ ] The pinned version appears exactly once as an exported constant, and a test asserts the
      outbound header carries it.
- [ ] A day breakdown of fifteen entries is rejected with a message naming the observed length, and
      an empty breakdown returns an empty array with no error.
- [ ] A statistics endpoint answering `202` then `200` yields stored weekly rows, and a `202` on a
      traffic endpoint is surfaced without a retry.
- [ ] `401`, `403` and `404` each produce a distinct error kind after exactly one attempt, and the
      `403` message names the `Administration` read permission.
- [ ] A three-page star history is fully consumed, with the page numbers requested and the
      callback invocation count asserted.
- [ ] A week whose `total` disagrees with its own `days` is refused, and a week that does not begin on
      a UTC midnight is counted as unaligned rather than placed on a calendar day.
- [ ] Every claim about a live endpoint is recorded in the human live-integration review rather than
      inferred from mocked test output.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default a claim no mock can prove is recorded as unverified rather
      than as verified.
