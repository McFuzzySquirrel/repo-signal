# Vendor documentation and the pinned contract

## Pages that must be re-read rather than remembered

| Contract detail | Vendor page | What it pins here |
|-----------------|-------------|-------------------|
| Traffic endpoints, the rolling 14-day window, day or week parameter, top-ten lists | GitHub REST - Metrics / Traffic | Four traffic clients; the 14-entry bound; referrers and popular paths as undated top-ten lists |
| `Administration` repository permission (read) required by the traffic endpoints for a fine-grained token | GitHub REST - Metrics / Traffic | The permission named in the `403` message and in the re-authenticate action |
| Supported API versions and the `X-GitHub-Api-Version` header | GitHub REST - API versions | The single pinned constant and its fallback window |
| Star timestamps through the star media type on the stargazer list | GitHub REST - Activity / Starring | The `Accept` media type the star backfill depends on |
| Statistics endpoints returning `202` while the cache compiles | GitHub REST - Metrics / Statistics | Retryable outcome for `202` on statistics only |
| `node:sqlite` availability, stability and the defensive flag | Node.js documentation | The connection settings and the re-check trigger on a Node major upgrade |
| Node.js release lines and LTS status | Node.js releases | The engine range floor and the CI matrix |

## Pinned values

| Value | Setting | Note |
|-------|---------|------|
| API version | `2026-03-10` | One exported constant; `2022-11-28` remains supported until 2028-03-10 |
| Accept media type | `application/vnd.github+json` | The star history needs no endpoint-specific type |
| Star history | `GET /repos/{owner}/{repo}/stargazers/history` | Not covered by the July 2026 admin-and-collaborator restriction that closed `/stargazers`; weeks are `{week, total, days[7]}` with `week` a UTC midnight |
| Traffic window | 14 days, rolling | A longer breakdown is a contract misunderstanding |
| Retryable | `429`, `5xx`, and `202` on statistics | Capped exponential backoff with jitter |
| Fail fast | `401`, `403`, `404` | One attempt each, distinct typed kinds |
| Rate limit | sleep until the reset instant | Headers parsed into a budget record |

## Re-read procedure

1. Open the page for the detail rather than recalling it; these are the plan's main drift surface.
2. Compare the documented shape against the fixture bodies in the client tests.
3. If the two disagree, the document wins: update the fixture, the mapping and the affected
   assertion in the same change.
4. Record the observed outcome in the human live-integration review with a status code or a stored
   row count as evidence. A difference between the mocked assumption and the real service is a
   defect to record, not a curiosity to note.

## Facts the client must not invent

- No conditional request or ETag caching: the archive wants fresh reads and the budget is small.
- No paging through issues or pull requests: the weekly statistics endpoints are the only
  development source.
- No interpretation of unknown payload fields: they pass through untouched so an added field cannot
  change a stored value.
- No client-owned retry, backoff or timer: the transport policy owns waiting, and a client never
  starts a scheduler.
- No storage or rendering inside a client: a client normalises a response and returns records.
