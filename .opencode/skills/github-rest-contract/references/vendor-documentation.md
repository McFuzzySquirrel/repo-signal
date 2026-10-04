# Vendor documentation and the pinned contract

## Pages that must be re-read rather than remembered

This table is PRD section 6.5, which records where each contract was read from and the module that
enforces it. Re-verify one file rather than the whole product.

| Contract | Vendor page | Enforced in |
|----------|-------------|-------------|
| REST API version header and support window | `https://docs.github.com/rest/overview/api-versions` | `src/github/http.js` |
| Repository identity, stars, forks, watchers | `https://docs.github.com/rest/repos/repos` | `src/github/repo-client.js` |
| Traffic clones, views, popular referrers, popular paths | `https://docs.github.com/rest/repos/traffic` | `src/github/traffic-client.js` |
| Weekly stargazer history and its pagination cap | `https://docs.github.com/rest/activity/starring` | `src/github/stars-client.js` |
| Participation and commit activity, including `202` | `https://docs.github.com/rest/metrics/activity` | `src/github/stats-client.js` |
| Rate-limit headers and `Retry-After` | `https://docs.github.com/rest/using-the-rest-api/rate-limits` | `src/github/rate-limit.js` |
| Stargazer listing restriction | the GitHub changelog entry dated 2026-06-30, cited from the source | `src/github/retry.js` |
| `node:sqlite`, defensive mode, WAL, `STRICT` | `https://nodejs.org/api/sqlite.html` | `src/db/connection.js` |
| Release schedule and LTS status | `https://nodejs.org/en/about/previous-releases` | `engines` in `package.json` |

## Pinned values

| Value | Setting | Note |
|-------|---------|------|
| API version | `2026-03-10` | One exported constant in `src/github/http.js` |
| Accept media type | `application/vnd.github+json` | The star history needs no endpoint-specific type |
| Star history | `GET /repos/{owner}/{repo}/stargazers/history` | Not covered by the July 2026 restriction that closed the listing; weeks are `{week, total, days[7]}` |
| Star pagination | 30 weeks per page, 100 pages maximum | Follow `rel="next"`; report a series past the cap as truncated |
| Traffic window | 14 days, rolling | A longer day breakdown is a contract misunderstanding and is refused |
| Retryable | `429`, `5xx`, and `202` on statistics | Capped backoff with jitter under a floor |
| Fail fast | `401`, `403`, `404` | One attempt each, distinct typed kinds |
| Rate limit | sleep until the reset instant | Headers parsed into a budget record; a malformed header reads as `null` |
| Transport | `GET` only, `redirect: 'manual'`, response body returned unparsed | A redirect status or a followed redirect is refused |

## Re-read procedure

1. Open the page for the detail rather than recalling it; these are the project's main drift surface.
2. Compare the documented shape against the fixture bodies in the client tests.
3. If the two disagree, then the document wins: update the fixture, the mapping and the affected
   assertion in the same change.
4. Record the observed outcome in the human live-integration review, with a status code or a stored row
   count as evidence. A difference between the mocked assumption and the real service is a defect to
   record, not a curiosity to note.

## Facts the client must not invent

- No conditional request or ETag caching: the archive wants fresh reads and the budget is small.
- No paging through issues or pull requests: the weekly statistics endpoints are the only development
  source.
- No day dimension for referrers or popular paths: they are undated aggregate snapshots, so no day is
  derived from them.
- No interpretation of unknown payload fields: they pass through untouched, so an added field cannot
  change a stored value.
- No client-owned retry, backoff or timer: the transport policy owns waiting, and a client never starts
  a scheduler.
- No storage or rendering inside a client: a client normalises a response and returns records.
- No payload values or JSON parser diagnostics inside an error message, because an error crosses the
  redaction boundary.

## The two human gates that keep drift visible

- The live integration check establishes that the real host answers as this build assumes: the version
  header, the `202` statistics retry, the traffic permission, and that a real token reaches every
  supported call shape.
- The seven-day soak establishes that unattended days leave no gap wider than 26 hours and keep the
  request budget inside the documented figure.

Both are named in the release checklist, both are recorded by a person, and neither is authored by an
agent. A change under `src/github/` that has not been through the live check is unverified, not
correct.