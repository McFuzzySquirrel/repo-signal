---
name: token-and-egress-safety
description: "RepoSignal credential and outbound-request safety: credentials.json read only at exactly mode 0600 from the descriptor that was checked, token-shaped values and bearer headers redacted from every error and log surface, the api.github.com allowlist re-checked on every request with redirects refused, GET-only requests with no request body, and the REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT gate the stub-driven suites depend on. Use when touching src/credentials/, the transport under src/github/, any error path that could carry a header, or any test that points the client at a local stub."
---

# Skill: Token and Egress Safety

`RS-C02`, `RS-C07`, `RS-SEC-03` and `RS-SEC-04` are one coupled boundary rather than four independent
rules: the same token is read by the credential store, attached by the transport, and must never reach
a log, an error, a row, a page, a snapshot or a process listing. `docs/operations/privacy.md` is the
document that states the same claims to an operator and names the file that enforces each one.

Load [redaction-surfaces.md](./references/redaction-surfaces.md) when you add an error path, a log
line, a persisted failure message, a second entry point for the secret, or a test that spawns the entry
point and captures its output.

## Process

### Step 1: Read the token once, through the provider

The token is obtained only through the credential provider's getter, which the transport resolves per
request. `RS-SEC-06` makes the interface the seam, so no module outside the transport may hold the
token and the collector must never learn where it came from. Anything that wants to report identity
asks the provider, not the file. The provider returns the token through a frozen closure rather than an
enumerable property, so it cannot be read out by logging the object.

### Step 2: Check the mode on the descriptor that was opened

`credentials.json` is opened once, and its mode is checked on that same descriptor before the body is
read. The mode must be exactly `0600`; `0644` and `0666` are the tested rejections and the message
names the observed mode. On `win32` there is no mode to check, so the check is skipped rather than
faked.

If the mode is wrong, then raise a configuration error naming the path and the observed mode; if the
file is missing or is not a regular file, then say which of the two it is. Neither case may fall back to
an environment variable or repair the mode automatically, because `RS-C07` forbids both and a repair
teaches the maintainer that the check is advisory.

### Step 3: Enforce the host allowlist on every request

The transport exposes one `get(endpoint)` call and re-evaluates the allowlist against both the base
URL and the resolved target on each request rather than at import. It accepts `https` on
`api.github.com` with an empty port, and accepts a loopback origin only when
`REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` is set, the base hostname is `127.0.0.1`, and the target origin
equals the base origin. A refused host never appears in a network log, a proxy log or a DNS cache, so
prove the refusal with an injected fetch stub and assert it was never called.

### Step 4: Keep the request a read

Every request is a `GET` with manual redirect handling, and no client function accepts a request body.
The body is not merely unused, it is not a parameter, so a later edit cannot turn the collector into a
writer without changing the signature the tests call. A redirect status or a followed redirect is
refused rather than resolved, even when it stays on the same host, and no implicit second request
occurs.

### Step 5: Redact where the message is created

Every error leaving the transport passes through the redaction helper before it is thrown, logged or
returned. Redaction applied at the print site misses a stack trace, an assertion message and the
message retained in a database row. The helper returns redacted text rather than the original error
object, because an error object carries enumerable headers. If a new error path bypasses the transport,
then it must call the same helper before returning, and a second weaker copy is never the answer.

### Step 6: Classify a failure into the six kinds

A failure is exactly one of authentication-rejected, permission-missing, repository-missing,
rate-limited, transient or unexpected. The classifier prefers the transport's typed kind, then a bare
status, then a bare transport code, and redacts the message. Only the first two carry an
action-oriented message, and the permission message names the `Administration repository permission
(read)` a fine-grained token needs. Every non-unexpected action names a registered command, so the
operator is told what to run.

### Step 7: Gate the local transport override

A `127.0.0.1` base URL is accepted only when `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` is set in the process
environment, and the gate is evaluated per request inside the transport. The suites that use the local
stub set it only for the child process they spawn or for their own test process, never in a shared
fixture another suite inherits.

### Step 8: Prove it with the named assertions

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" npm test -- tests/github-http.test.js
```

Keep four assertions green in the file that owns each surface: a non-allowlisted host refused with the
fetch stub never called; the exact header set sent; a redirect refused; and no token-shaped value in
any error message, printed line or captured standard output.

## Gotchas

- **A globally set override quietly voids the allowlist guarantee.** Setting
  `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` in a shared helper, at module scope in `process.env`, or in a
  dotenv-style file makes every other suite capable of reaching any host. The mechanical guarantee is
  that the refusal is proven with the flag absent.
- **Headers are enumerable, so a logged error object leaks the token.** `fetch` errors, request
  objects and any `console.log` of a request carry `Authorization`. Log redacted text, never an object
  graph that includes headers.
- **A persisted failure message is a durable leak.** The per-repository error row keeps the most recent
  message, so an unredacted message puts the token in the archive and in every backup the drill copies.
- **A 403 is a permission state, not an authentication failure and not a rate limit.** The transport
  must not answer a 403 by retrying or by re-reading the credential, and the message names the
  `Administration` read permission so the maintainer can act.
- **A second entry path for the secret needs the same guarantees as the first.** The masked setup prompt
  is a front door onto the same credential: it is never echoed, never printed, never logged, and its
  result is never passed to an output function, because an echo-restore failure leaks silently.
- **`config check` output is a terminal log.** Anything it prints is permanent in a cron log or a shell
  scrollback, so the check reports the credential's presence, mode and parse state, and never its
  value.
- **Test fixtures must not contain a plausible real token.** A literal token-shaped string in a fixture
  or a golden file is uploaded to CI on the first snapshot upload. Use an obviously fake value that
  still matches the redaction pattern.
- **Redaction must not rewrite the data being reported.** Redacting repository names, referrer hosts or
  popular paths would corrupt the archive's usefulness, so only token-shaped values and bearer values
  are removed.
- **Repairing the file mode is itself a violation.** A loader that chmods a loose credential to 0600
  teaches the maintainer that the check is advisory, and the next loose file is never noticed.

## Validation

Self-check each item; the first is the mechanical guarantee for the outbound allowlist and cannot be
satisfied by any other evidence:

- [ ] A test asserts a request to a non-`api.github.com` host is refused and the injected fetch stub is
      never called, with `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` unset.
- [ ] The captured outbound headers are exactly `Accept`, `Authorization`, `X-GitHub-Api-Version` and
      a `User-Agent` naming the project, and no other host constant exists in the module.
- [ ] A test asserts a token-shaped value is absent from a thrown error's message, from captured
      standard output, and from the message recorded against a repository.
- [ ] A test asserts a credential file at any mode other than 0600 is refused with the observed mode
      named, and that no environment-variable fallback is attempted.
- [ ] A search of the changed module confirms no function accepts a request body and no method other
      than `GET` is issued.
- [ ] Every test that sets `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` sets it for its own process or its own
      child process only.
- [ ] `docs/operations/privacy.md` still names the file that enforces each claim, and a contract test
      asserts the statements it makes.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default an assertion made with the override set does not count as
      proof of the allowlist.