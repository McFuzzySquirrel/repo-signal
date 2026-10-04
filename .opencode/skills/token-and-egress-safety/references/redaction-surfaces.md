# Redaction surfaces, the header set and the override gate

## Every surface a token can escape through

| Surface | How it escapes | Rule |
|---------|----------------|------|
| Logged error message | The transport rethrows the raw provider error | Redact in the transport before the message is created |
| Stack trace | Any frame above the redaction point reprints the message | Redact the message, never just the printed line |
| `console.log` of a request or options object | `headers` is an enumerable property | Log redacted text, not an object graph |
| Per-repository error row | The supervision reporter persists the message | Redact before recording; a row survives every backup |
| Run record and run journal | A summary may embed a failure message | Redact before the run is written |
| Masked terminal prompt | An echo-restore failure, or a prompt result passed to an output function | The field never echoes, and no prompt result reaches an output function |
| HTTP response body | A 500 page may include a thrown message | The server returns a generic body; the detail goes to the local log |
| Rendered page | A page may render a failure reason | Reasons are state words, never raw transport text |
| CLI standard output and usage text | `config check` and `collect` print one line per fact | The value is never a printed fact |
| Test snapshot or golden file | A fixture with a token-shaped literal is uploaded on snapshot update | Use an obviously fake value |
| Process listing | A token passed as an argument or exported into the environment of a child | Read from the 0600 file inside the process |
| Database row | A token stored as configuration state | The token is never durable state |
| Backup copy | A backup copies every row | Redact before persistence, not after the backup |

## Redaction properties that matter

`src/credentials/redact.js` strips values matching a GitHub token shape and any bearer value, and
replaces them with a fixed marker. Two properties matter more than the exact pattern:

- It is applied to the message text, so a stack trace and any substring are covered.
- It is applied before the value is persisted, logged, returned or rendered - not at the print site.

The helper returns text rather than the original error object, because the object may carry headers.
It also accepts a list of known secrets, so an opaque credential with no recognisable prefix can still
be removed. That helper is the single implementation; a second, weaker copy in a module that "just needs
it for this error" is a leak with extra steps.

## Header set

Every request carries exactly these, and a test asserts the set:

| Header | Value |
|--------|-------|
| `Accept` | `application/vnd.github+json`, or the endpoint's documented media type, and never empty or line-broken |
| `Authorization` | `Bearer` plus the token resolved through the provider |
| `X-GitHub-Api-Version` | the single exported pinned constant |
| `User-Agent` | identifies the project and its version |

The token's presence in `Authorization` is why no code path may log the request object.

## The local transport override

| Property | Value |
|----------|-------|
| Flag | `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` |
| Effect | permits a `127.0.0.1` base URL instead of `api.github.com` |
| Additional conditions | the base hostname is `127.0.0.1`, and the target origin equals the base origin |
| Evaluated | inside the transport, per request, against the base URL and the resolved target |
| Absence | any other host, including `127.0.0.1`, is refused before a socket opens |
| Used by | the suites that drive the collect command, the discover command, and the collection, server and dashboard end-to-end flows against the loopback stub |
| Never used by | the live integration gate, which is a human with a real token against the real host |

If a test needs the flag, the safest shape is to spawn the child with the variable in its environment
rather than mutating the current process, so no later suite inherits it.

## Failure classification that names a permission

The six kinds are authentication-rejected, permission-missing, repository-missing, rate-limited,
transient and unexpected. A `401` is authentication-rejected. A `403` is permission-missing and names
the `Administration repository permission (read)` a fine-grained token needs, together with the
instruction to accept the permission upgrade and reconnect. A `404` is repository-missing. A `429` is
rate-limited and waits for the reset instant. A `202` or a `5xx` is transient. The stargazer family
carries its own endpoint type, because its refusal is an access restriction rather than a permission
the maintainer can grant, so classifying it as a missing permission produces advice that cannot work.

## Where the operator-facing claims live

`docs/operations/privacy.md` maps each claim to the file that enforces it: the host allowlist and
redirect refusal to `src/github/http.js`, the credential mode to `src/credentials/store.js`,
redaction to `src/credentials/redact.js`, the single home to `src/paths.js`, and the dashboard's
loopback restriction to `src/server/security.js`. A change to any of those files changes a documented
claim, so the contract test that reads the privacy note has to be updated in the same change.