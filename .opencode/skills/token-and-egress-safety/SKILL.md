---
name: token-and-egress-safety
description: "RepoSignal credential and outbound-request safety: the 0600 credential file, the api.github.com allowlist enforced before a socket opens, GET-only requests with no request body, redaction of token-shaped values from every error and log surface, and the REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT test-override gate that test suites and stubs depend on. Use when touching src/credentials/, src/github/ transport, any error path that could carry a header, or any test that points the client at a local stub."
---

# Skill: Token and Egress Safety

`RS-SC-01`, `RS-SC-02` and `RS-SC-04` form one coupled boundary: the token is read by the
credential store, resolved through the provider interface, attached by the transport, and must
never reach a log, an error, a row, a page, a snapshot or a process listing.

Load the surface-by-surface escape list in [redaction-surfaces.md](./references/redaction-surfaces.md)
when you add an error path, a log line, a persisted failure message, or a test that spawns the
entry point and captures output.

## Process

### Step 1: Read the token once, through the provider

The token is obtained only through the credential provider's getter, which the transport resolves
per request. No module outside the transport may hold the token, and the collector must never learn
where it came from. Anything that wants to report identity asks the provider, not the file.

### Step 2: Refuse the wrong file mode

On POSIX, refuse to read a credential file that is not exactly mode `0600`; `0644` and `0666` are
the tested rejections and the message names the observed mode. A refusal is a configuration error
naming the path and the mode, never a silent fallback to an environment variable.

### Step 3: Enforce the host allowlist before the socket

The transport compares the target host against `api.github.com` and refuses anything else before
`fetch` is called, so a refused host never appears in a network log, a proxy log or a DNS cache. A
redirect to a different host is refused rather than followed. Prove it with an injected fetch stub
that asserts it was never called.

### Step 4: Keep the request a read

Only `GET` may be issued and no client function accepts a request body. The body is not merely
unused - it is not a parameter, so a later edit cannot turn the collector into a writer without
changing the signature the tests call. If a future endpoint genuinely needs a write, then it does
not belong in this product.

### Step 5: Redact at the boundary, not at the print site

Every error leaving the transport passes through the redaction helper before it is thrown, logged
or returned. Redaction is applied where the message is created; a redaction applied at the print
site misses a stack trace, an assertion message, and the message retained in a database row. If a
new error path bypasses the transport, then it must call the same helper before returning.

### Step 6: Gate the local transport override

A `127.0.0.1` base URL is accepted only when `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` is set in the
process environment, and the gate is evaluated per request inside the transport. The five test
suites that use the local stub - collect command, discover command, collection end-to-end, server
end-to-end and dashboard end-to-end - set it only for the child process they spawn or for their own
test process, never in a shared fixture that other suites inherit.

### Step 7: Prove it with the four named tests

Every task that touches this boundary must keep these assertions green, in the test file that owns
the surface: non-allowlisted host refused with the fetch stub never called; the exact header set
sent; a redirect to another host refused; and no token-shaped value in any error message, printed
line or captured stdout.

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" npm test -- tests/github-http.test.js
```

## Gotchas

- **A globally set override quietly voids the allowlist guarantee.** Setting
  `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` in a shared test helper, a `process.env` assignment at module
  scope, or a dotenv-style file makes every other suite capable of reaching any host. The mechanical
  guarantee for `RS-SP-04` and `RS-SP-05` is that the refusal is proven *with the flag absent*.
- **Headers are enumerable, so a logged error object leaks the token.** `fetch` errors, request
  objects and any `console.log` of a request carry `Authorization`. Log redacted text, never an
  object graph that includes headers.
- **A persisted failure message is a durable leak.** The per-repository error row keeps the most
  recent message; if it is not redacted before it is recorded, the token is in the archive and in
  every backup, and `RS-OPS-01`'s drill copies it.
- **A 403 is a permission state, not an authentication failure and not a rate limit.** The
  transport must not answer a 403 by retrying or by re-reading the credential, and the message must
  name the `Administration` read permission so the maintainer can act.
- **`config check` output is a terminal log.** Anything it prints is permanent in a cron log or a
  shell scrollback, so the check reports the credential's presence, mode and parse state, and never
  its value.
- **Test fixtures must not contain a plausible real token.** A literal token-shaped string in a
  fixture, a golden file or a snapshot is uploaded to CI on the first failing snapshot upload. Use
  an obviously fake value that still matches the redaction pattern.
- **Redaction must not rewrite the data being reported.** Redacting repository names, referrer
  hosts or popular paths would corrupt the archive's usefulness; only token-shaped values are
  removed.

## Validation

Self-check each item; the first is the mechanical guarantee for the outbound allowlist and cannot be
satisfied by any other evidence:

- [ ] A test asserts a request to a non-`api.github.com` host is refused and the injected fetch stub
      is never called, with `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` unset.
- [ ] The captured outbound headers include `Accept`, `Authorization`, `X-GitHub-Api-Version` and a
      `User-Agent` naming the project; no other host constant exists in the module.
- [ ] A test asserts a token-shaped value is absent from a thrown error's message, from a captured
      `stdout`, and from the message recorded against a repository.
- [ ] A search of the changed module confirms no function accepts a request body and no method other
      than `GET` is issued.
- [ ] Every test that sets `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` sets it for its own process or child
      process only.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default an assertion made with the flag set does not count as
      proof of the allowlist.
