# Privacy note

This page is for a stranger deciding whether to run this tool on their own repositories. It says
what leaves your machine, what is stored on it, what is never collected at all, and where in the
source each of those claims is enforced. Where a claim is enforced by code rather than by this
document, the file is named so you can read it yourself.

RepoSignal collects GitHub's traffic counters for the repositories **you** enrolled, once a day,
into a database on your own machine, and shows them back to you. There is no service, no account,
no signup and no third party in the middle.

This page makes no legal, regulatory or compliance claim, and it is not an audit. What it does is
enumerate facts that are either visible in this repository or checkable by running it. The review
artefact that confirms this note against the code is `docs/reviews/open-source-posture.json`, and
this repository does not contain it yet.

---

## The short version

| Question | Answer |
|----------|--------|
| Does anything leave my machine? | Yes: read requests to `api.github.com`, and nothing else. |
| Which host? | `api.github.com`. Only that host. Enforced in `src/github/http.js`. |
| Is there telemetry? | No. No telemetry, no analytics, no crash reporting, no error reporting, no update check, no remote font, no remote image, no CDN, no remote asset. |
| What do you store about me? | Nothing. There is no user record, no account, no cookie, no device identifier, no IP log and no session. |
| What is stored about my repositories? | GitHub's counters, in one SQLite file in my home directory. |
| Where is my token? | In `credentials.json` in that home, mode `0600`, read only, and never printed. |
| Is the archive shared? | No. There is no export, publish or share action, and the archive may not be redistributed. See [README.md](../../README.md). |
| Does `report` send anything? | No. It writes plain text to standard output and nothing else: no upload, no message, no hosted copy, and no file it creates. It is safe to read, and whether you paste it anywhere is your decision. |
| Is the dashboard reachable from my network? | No. It binds to `127.0.0.1` only and refuses a request from any other address. |

---

## What leaves your machine

**One host: `api.github.com`.** Every outbound request in this product is a `GET` to that host
over HTTPS, carrying the API version header the project pins and a `User-Agent` of the form
`repo-signal/<version>`.

The requests a collection run makes, per repository:

| Request | Why it exists |
|---------|---------------|
| Repository record | resolve the enrolled name and record a rename, transfer or disappearance |
| Traffic: clones and unique cloners | the day series |
| Traffic: views and unique visitors | the day series |
| Traffic: referrers | a timestamped top-ten snapshot |
| Traffic: popular paths | a timestamped top-ten snapshot |

On a repository's first successful collection, two more kinds of request run once: the stargazer
list with its star-timestamp media type, which reconstructs the star history, and the two
statistics endpoints, which reconstruct a year of weekly development activity. After that, a
steady-state run costs five requests per repository. The figures are the collector's own constants,
and the count for a given run is printed on its `summary` line.

Three things that request policy makes true rather than merely intended:

- **Redirects are refused.** A `3xx`, including a same-host one, is not followed. No implicit second
  request happens, so no endpoint can quietly redirect a credential somewhere else.
- **The host is checked on every request**, against the base URL and the resolved target, before a
  socket is opened. A URL that is not `https://api.github.com` is refused rather than attempted.
  The single exception is a loopback base URL that a test explicitly enables through an environment
  gate, which exists so the test suite can drive a local stub; that gate is off unless a test sets it.
- **Requests are `GET` only.** There is no code path that writes to GitHub, and no command that
  creates an issue, pull request, comment, release or star.

---

## What is never collected

There is **no telemetry** in this product, and the list below is the whole of it:

- No usage analytics, no page-view counting, no funnel, no feature flag service, no A/B assignment.
- No crash reporting and no error reporting service. A failure is printed on your terminal and
  written into your own archive's run journal; it is not sent anywhere.
- No update check. The tool does not ask any host whether a newer version exists, and the only host
  it may contact is the one that serves your repositories.
- No remote font, no remote image, no CDN, no stylesheet or script from another origin. The
  dashboard serves same-origin assets only and its content security policy sets `default-src
  'none'` with `script-src 'none'`, so a page cannot load or run anything you did not already have.
- No account, no signup, no login, no session, no cookie and no identifier for you as a person. The
  archive is keyed by repository name, not by a user of this tool.
- No IP address is stored. The only address that reaches GitHub is the one your network gives your
  requests, and GitHub's own handling of it is GitHub's business, not something this tool records.

Because there is no telemetry, there is also no telemetry to opt out of: there is no setting,
because there is no collection.

---

## What is stored on your machine

One home directory, resolved in this order: `REPO_SIGNAL_HOME`, then
`XDG_DATA_HOME/repo-signal`, then `~/.local/share/repo-signal`. It is created with mode `0700`,
and the tool refuses to start when the resolved home is a git repository root, so an archive and a
credential cannot be committed into a work tree by accident.

| File | What it holds |
|------|---------------|
| `config.json` | the repositories you enrolled, the optional deny list, the UTC collection hour you intend to collect in, and optional per-repository flags |
| `credentials.json` | your token, and nothing else |
| `archive.sqlite3` | the archive: day-series facts, timestamped top-ten snapshots, the run journal, collection health and the recorded reasons for each failure |

Inside the archive, what is stored about your repositories is GitHub's own reporting: clone counts,
unique cloners, view counts and unique visitors per UTC day; cumulative stars per day from the
backfill; weekly commit activity and owner participation from the backfill; referrer hostnames and
popular paths as undated top-ten lists captured with a timestamp; and, per repository, the identity
GitHub currently serves it under, the last successful collection, the consecutive failure count and
the classified reason for the most recent failure.

**Two of those are third-party data, not yours.** Referrer hostnames and popular paths describe
other people's sites and files. They are stored in your local archive because they are part of the
observation GitHub returned to you, they never leave your machine, and they are covered by the same
redistribution statement as the rest of the archive: the product performs no export, publish or
share action, and [README.md](../../README.md) states that this archive may not be redistributed.

The archive retains what it collected. A repository GitHub stops serving is marked and keeps its
history rather than being deleted, and the database itself refuses to delete a fact row.

---

## The credential file

`credentials.json` holds **one read-only token**: a fine-grained personal access token, scoped to
the repositories you enrolled, held at mode `0600` exactly.

- **Read-only is a property of the token and of the code together.** The token needs
  `Administration repository permission (read)` for the traffic endpoints; it does not need
  `Contents`, which is never requested, and every request this tool makes is a `GET`.
- **The mode is enforced, not suggested.** `src/credentials/store.js` refuses to read the file
  unless its mode is exactly `0600`, naming the mode it observed; `0644` and `0666` are refused
  with that message. It never repairs the mode for you.
- **The token is never printed.** It does not appear on standard output, on standard error, in an
  error message, in an exception, in a log line, in a database row, in a rendered page or in a
  process listing. `config check` validates the credential file and prints no token, which is why it
  is safe to paste its output into a report or a bug.
- **Token-shaped values are redacted from every error surface.** `src/credentials/redact.js` removes
  anything shaped like a GitHub token and any known secret before a message becomes an error, a log
  line or a stored failure reason.
- **There is no environment-variable fallback and no second credential source.** The token is read
  from that one file, and it is handed to the HTTP transport through a provider the collector never
  sees past.

If a token is revoked or expires, GitHub answers `401` and the product reports a
re-authentication state naming the required permission. It does not retry a refused credential,
because retrying spends requests without changing the answer.

---

## The dashboard

The dashboard is a server on your own machine, and it is deliberately not a service:

- It binds to `127.0.0.1` only. The bind address cannot be changed through configuration, and a
  request arriving from a non-loopback address is refused rather than served.
- It is unauthenticated because it is loopback-only: there is no login, no session and no cookie to
  protect, and no credential is reachable through it.
- Every response carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff` and a content security policy of `default-src 'none'` with
  `script-src 'none'`. Nothing it renders can be cached or turned into a script by a page.
- It loads no remote asset and renders no JavaScript, so opening a dashboard page cannot cause a
  request to any host.

---

## Check these claims yourself

Every command below is a command this repository provides; `tests/release-contract.test.js`
resolves each one against the command registry, so this page naming a command that does not exist
fails the suite.

Validate your own home, and read where the archive landed:

```
node src/cli.js config check
node src/cli.js db status
```

`config check` reads the credential file's mode and shape and prints no token. `db status` prints
the resolved database path beside both schema versions, so you can see for yourself that the
archive is one file inside your home directory.

Collect, and read the request count the run actually made:

```
node src/cli.js collect
```

The `summary` line the run prints ends `requests=`, which is the run's own count of requests to
`api.github.com` and the only network activity a collection produces. To plan without contacting
GitHub at all, use `node src/cli.js collect --dry-run`, which prints `requests=0` and opens no
socket.

Copy the archive, keep it local, and check its integrity:

```
node src/cli.js db backup "$HOME/repo-signal-backups/archive-$(date -u +%F).sqlite3"
node src/cli.js db verify
```

---

## Where each claim is enforced

| Claim | Enforced in |
|-------|-------------|
| The only permitted host is `api.github.com`; redirects are refused; requests are `GET` | `src/github/http.js`, checked on every request before a socket opens |
| The credential file must be mode `0600`, and the token is held privately behind `getToken()` | `src/credentials/store.js` |
| Token-shaped values are removed from every error surface | `src/credentials/redact.js` |
| One home directory, mode `0700`, no state outside it, refusal to run inside a work tree | `src/paths.js` |
| A run is `GET`-only and writes nothing to GitHub | `src/github/retry.js` and the endpoint clients under `src/github/` |
| The dashboard is loopback-only, stores nothing, and serves a restrictive policy | `src/server/security.js` |
| Evidence is retained; a day is corrected or absent, never deleted or invented | the forward-only migration runner in `src/db/` and its day-series repository |
| A day is corrected or absent, never deleted or invented | the forward-only migration runner and its day-series repository under `src/db/` |
| The statements on this page survive editing | `tests/release-contract.test.js`, and `tests/troubleshooting-contract.test.js` for the runbooks |

`tests/release-contract.test.js` also asserts that no credential file, database file or home-directory
file is tracked in this repository, and that the licence file names the MIT licence.

---

## What this page does not claim

It does not claim legal advice, a compliance status, a certification, an independent security audit
or a third-party assessment of this tool. It does not claim a test result or an approval that has
not happened: the artefacts that would record those are `docs/reviews/github-live-integration.json`,
`docs/reviews/collection-soak.json` and `docs/reviews/open-source-posture.json`, and none of them is
in this repository yet.

It also does not describe GitHub's own data practices. Whatever GitHub does with a request it
serves is GitHub's, and this tool adds nothing to it beyond the request the collection needs.
