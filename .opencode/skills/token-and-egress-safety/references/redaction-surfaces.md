# Redaction surfaces

## Every surface a token can escape through

| Surface | How it escapes | Rule |
|---------|----------------|------|
| Logged error message | The transport rethrows the raw provider error | Redact in the transport before the message is created |
| Stack trace | Any frame above the redaction point reprints the message | Redact the message, never just the printed line |
| `console.log` of a request or options object | `headers` is an enumerable property | Log redacted text, not an object graph |
| Per-repository error row | The supervision reporter persists the message | Redact before recording; a row survives every backup |
| Run record and run journal | A summary may embed a failure message | Redact before the run is written |
| HTTP response body | A 500 page may include a thrown message | The server returns a generic body; the detail goes to the local log |
| Rendered page | A page may render a health reason | Reasons are state words, never raw transport text |
| CLI stdout and usage text | `config check` and `collect` print one line per fact | The value is never a printed fact |
| Test snapshot or golden file | A fixture with a token-shaped literal is uploaded on snapshot update | Use an obviously fake value |
| Process listing | A token passed as an argument or an exported variable visible in `ps` | Read from the `0600` file inside the process |
| Database row | A token stored as configuration state | The token is never durable state |
| Backup copy | A backup copies every row | Redaction before persistence, not after the backup |

## Redaction pattern

The helper strips values that look like a GitHub token from any string. Two properties matter more
than the exact pattern:

- It is applied to the message, so a stack trace and any substring are covered.
- It is applied before the value is persisted, logged, returned or rendered - not at the print site.

The credential store's redaction helper is the single implementation; do not add a second, weaker
copy in a module that "just needs it for this error".

## Header set

Every request carries exactly these, and a test asserts the set:

| Header | Value |
|--------|-------|
| `Accept` | `application/vnd.github+json`, or the endpoint's documented media type |
| `Authorization` | `Bearer` plus the token resolved through the provider |
| `X-GitHub-Api-Version` | the single exported pinned constant |
| `User-Agent` | identifies the project and its version |

The token's presence in `Authorization` is why no code path may log the request object.

## The local transport override

| Property | Value |
|----------|-------|
| Flag | `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` |
| Effect | permits a `127.0.0.1` base URL instead of `api.github.com` |
| Evaluated | inside the transport, per request |
| Absence | any other host, including `127.0.0.1`, is refused before a socket opens |
| Used by | collect command tests, discover command tests, collection end-to-end, server end-to-end, dashboard end-to-end |
| Never used by | the live integration gate, which is a human with a real token against the real host |

If a test needs the flag, the safest shape is to spawn the child with the variable in its
environment rather than mutating the current process, so no later suite inherits it.

## Failure classification that names a permission

The six failure kinds are authentication rejected, traffic permission missing, repository missing,
rate limited, transient, and unexpected. Only the first two carry an action-oriented message, and
the permission message names the `Administration` repository read permission the traffic endpoints
require. A 403 is never retried and never triggers a credential re-read.
