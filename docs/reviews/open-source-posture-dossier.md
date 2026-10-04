# Open-source posture dossier

**Read this before writing `docs/reviews/open-source-posture.json`.** This page gathers the four
positions that review has to decide and, for each one, names where the position is stated today, which
named test fails when that sentence stops being true, and whether the sources agree. It is evidence, not
a decision: it does not choose a position, soften one, or rule on one.

**Gate:** `RS-OPS-REV-01`, the open-source posture review, named in
`docs/operations/release-checklist.md` under `## The three human gates before a tag`.
**Decision artefact:** `docs/reviews/open-source-posture.json`. No agent writes it, and this repository
does not contain it yet.
**Assembled by:** task `RS-OPS-POST-01`, from the files as they stand in this repository. Every file,
heading, quotation and test named below was opened before it was written here; nothing is quoted from
memory, and `tests/posture-dossier.test.js` fails when a citation stops resolving.

---

## What this dossier is for

`README.md` states four positions about this project's own posture, and each one is asserted by a named
test. Nothing gathered them in one place, so a reviewer had to find each sentence, decide which test
holds it, and notice for themselves whether the files agreed. That search is what this dossier removes.

It exists under `RS-OPS-FR-02`: before the review runs, a dossier states each of the four positions,
names the file and heading each one lives in, names the test that asserts it, and marks each one
confirmed by documentation or contested. `RS-OPS-FR-01` is the review itself, and that half belongs to a
person.

---

## How to read a position

Each of the four positions below is recorded in the same shape, and `tests/posture-dossier.test.js`
reads these fields rather than matching prose.

| Field | What it means |
|-------|---------------|
| `Position` | the stable name this dossier and its test use for the position |
| The question the reviewer answers | the judgement this dossier cannot make for you |
| The claim, in the project's own words | a verbatim sentence, quoted from the file and heading on the row below |
| `Stated in` | the file and the heading where the position lives now |
| `Asserted by` | the test files, and the named test inside each, that fails when that sentence stops being true |
| `Also stated in` | every other place the same position appears, each with its file and heading and a verbatim sentence |
| `Status` | one of the two marks below |

**The two marks mean this and nothing more:**

- **`confirmed by documentation`** - the position is stated at the heading this dossier names, at least
  one named test fails when that sentence stops being true, and no file listed under the position
  contradicts it. It says nothing about whether a position is correct, workable or wise.
- **`contested`** - two sources disagree, or a file named under the position no longer says it, or no
  named test holds it. A contested position is not a failed position; it is one a reader cannot confirm
  from the documents, which is the reviewer's cue to read it harder.

Neither mark resolves the position. The decision, the reason and the list of what was read belong in
`docs/reviews/open-source-posture.json`, written by the reviewer who did the reading.

## The four positions

| Position | The question the reviewer answers | Stated in | Status |
|----------|-----------------------------------|-----------|--------|
| `licence` | Is MIT the right licence for this software, and does the extra text at the foot of `LICENSE` belong there? | `README.md` `## Licence` | confirmed by documentation |
| `redistribution` | Is the project's own position - GitHub's aggregate traffic data may not be redistributed - accurate as written, and does anything in this repository weaken it? | `README.md` `## This archive may not be redistributed` | confirmed by documentation |
| `token` | Is the description of the single read-only fine-grained token accurate and unambiguous for somebody creating one today? | `README.md` `## The token` | confirmed by documentation |
| `privacy-note` | Is the claim that nothing leaves the machine but read requests to one host accurate, including the one test-only exception? | `docs/operations/privacy.md` `## What leaves your machine` | confirmed by documentation |

All four marks are `confirmed by documentation`, which is a statement about the documents and their
tests, not about the positions. Each block below names what was read and what could not be settled from
the files alone; the observations are gathered under `## Observations the reviewer still has to make`.

---

## 1. The licence is MIT

| Field | Value |
|-------|-------|
| `Position` | `licence` |
| The question the reviewer answers | Is MIT the right licence for this software, and does the paragraph after the MIT text belong in `LICENSE`? |
| The claim, in the project's own words | "MIT. See [LICENSE](LICENSE) for the full text." |
| `Stated in` | `README.md` `## Licence` |
| `Asserted by` | `tests/release-contract.test.js` test "the licence file names the MIT licence with a copyright line, and the manifest agrees"; `tests/ci-contract.test.js` test "the release checklist names the licence and the file that carries it" |
| `Also stated in` | `LICENSE` - "MIT License"; `LICENSE` - "It grants no right in the data RepoSignal archives."; `docs/operations/release-checklist.md` `## What ships with the tag` - "The licence covers the software. It grants no right in the data an archive holds"; `docs/PRD.md` `## 1. Overview` - "Public source under MIT, no hosted service, no account, no signup, no telemetry." |
| `Status` | confirmed by documentation |

**What the sources say.** `LICENSE` carries the MIT text with a copyright line, `README.md` `## Licence`
points at it, and the release checklist names MIT beside `LICENSE` as the authority. `package.json`
declares the same licence, and the contract test reads that field rather than repeating the word, so the
manifest cannot drift from the file. `README.md` `## Licence` also
states the scope limit - the licence covers the software and grants no right in the data - which is the
sentence that connects this position to the redistribution one below.

**What the tests hold.** `tests/release-contract.test.js` reads the licence file, the manifest and the
README together and fails if any of the three stops agreeing; `tests/ci-contract.test.js` fails if the
release checklist stops naming the licence and the file that carries it. A licence claim is a person's
judgement, so both tests stop at the facts: which licence the file names, that the manifest agrees, and
that the documents still say it.

**Left for the reviewer.** Whether MIT is the right choice, and whether the paragraph after the MIT text
is the right place for a statement about data the licence does not cover.

---

## 2. GitHub's aggregate traffic data may not be redistributed

| Field | Value |
|-------|-------|
| `Position` | `redistribution` |
| The question the reviewer answers | Is the project's position accurate and unambiguous as written, and does any part of this repository narrow it? |
| The claim, in the project's own words | "**GitHub's repository traffic data is GitHub's aggregate data. This archive may not be redistributed.**" |
| `Stated in` | `README.md` `## This archive may not be redistributed` |
| `Asserted by` | `tests/release-contract.test.js` test "the README states that GitHub traffic data is GitHub aggregate data and may not be redistributed"; `tests/ci-contract.test.js` test "the release checklist names every statement the README must still make, and the README still makes it" |
| `Also stated in` | `LICENSE` - "GitHub's repository traffic data is GitHub's aggregate data, and this project states plainly in README.md that an archive may not be redistributed"; `docs/operations/release-checklist.md` `## The statements the README must still make` - "GitHub's repository traffic data is GitHub's aggregate data, and this archive may not be redistributed."; `docs/operations/release-checklist.md` `## The tag itself` - "**Do not attach an archive to the release.**"; `docs/operations/privacy.md` `## What is stored on your machine` - "they are covered by the same redistribution statement as the rest of the archive"; `docs/PRD.md` `### 6.4 Shared Constraints` - "GitHub aggregate traffic data may not be redistributed: no command exports, publishes or shares an archive, and the dashboard offers no download of one."; `docs/PRD.md` `## 8. Security and Privacy` - "The archive is local, private and never redistributed; a backup is a copy, not a publication"; `docs/features/operations-and-posture.md` `## 3. Functional Constraints` - "The product performs no export, publish, share or upload action of any kind, offers no archive download, and states in its own words that GitHub aggregate traffic data may not be redistributed; a personal backup is a copy rather than a redistribution." |
| `Status` | confirmed by documentation |

**What the sources say.** The statement is stated in full, in the same words, in `README.md` and in
`LICENSE`, and `README.md` gives it its own section rather than a footnote because the archive is
derived entirely from GitHub's counters. The README makes it actionable - do not publish an archive as
a release asset, a gist, a repository, a package or a dashboard download, and do not build a public
comparison or leaderboard out of it - and it names the one thing that is not forbidden: a backup kept in
the same private posture as the home it came from is a copy, not a redistribution. The release
checklist carries the statement into the tagging gate, where the last step is not to attach an archive
to the release, and the privacy note extends it to referrer hostnames and popular paths, which are third
party data inside the archive.

The two constraints behind the statement are `RS-C06` in `docs/PRD.md` `### 6.4 Shared Constraints` and
`RS-OPS-C04` in `docs/features/operations-and-posture.md` `## 3. Functional Constraints`: no command
exports, publishes or shares an archive, and the dashboard offers no download of one. This dossier does
not narrow either of them, and `tests/posture-dossier.test.js` fails if the sentence it quotes is
weakened, reworded or replaced by something narrower than `may not be redistributed`.

**What the tests hold.** `tests/release-contract.test.js` asserts both halves of the statement - whose
data it is, and that it may not be redistributed - asserts the actionable sentence, asserts the product
performs no export, publish or share action, and asserts the same words appear in `LICENSE`.
`tests/ci-contract.test.js` asserts the statement is present in both `README.md` and the release
checklist, so a later edit cannot drop it from one document and leave the other claiming it.

**Left for the reviewer.** The position is the project's own and has had no sign-off, which is recorded
as an open question in `docs/PRD.md` `## 16. Open Questions`. One sentence of `LICENSE` is worth reading
closely, because it reads two ways: "that statement is the project's own position on its own data and is
confirmed by a person, not by this file." This dossier does not choose between those readings, and does
not treat either of them as a decision that has been made.

---

## 3. One read-only fine-grained token is the only secret this tool holds

| Field | Value |
|-------|-------|
| `Position` | `token` |
| The question the reviewer answers | Is the description accurate and unambiguous for somebody creating a token today? |
| The claim, in the project's own words | "RepoSignal needs exactly one credential, and it is used for reads only." |
| `Stated in` | `README.md` `## The token` |
| `Asserted by` | `tests/release-contract.test.js` test "the privacy note states that the credential file holds a read-only token that is never printed"; `tests/release-contract.test.js` test "the README names the permission the traffic endpoints require and no write permission"; `tests/credentials.test.js` test "0600 credentials expose the exact token only through getToken" |
| `Also stated in` | `README.md` `## The token` - "It is the only secret this tool holds."; `docs/operations/privacy.md` `## The credential file` - "`credentials.json` holds **one read-only token**: a fine-grained personal access token, scoped to the repositories you enrolled, held at mode `0600` exactly."; `docs/operations/privacy.md` `## What leaves your machine` - "**Requests are `GET` only.** There is no code path that writes to GitHub, and no command that creates an issue, pull request, comment, release or star."; `docs/operations/release-checklist.md` `## The statements the README must still make` - "**It performs no write.** Every request is a `GET`, and `Contents` is not required and never requested."; `docs/PRD.md` `### 6.4 Shared Constraints` - "Exactly one credential is held, in credentials.json at mode 0600, read-only, never printed on any surface, redacted from every error, with no environment-variable fallback and no automatic repair of the file mode."; `docs/PRD.md` `## 8. Security and Privacy` - "One fine-grained personal access token scoped to the enrolled repositories, with `Administration repository permission (read)` as the permission that matters" |
| `Status` | confirmed by documentation |

**What the sources say.** The README and the privacy note describe the same credential: one fine-grained
personal access token, scoped to the repositories the user enrolled, read-only because every request the
tool makes is a `GET`, held in `credentials.json` at mode `0600` exactly, never printed on any surface,
with no second credential source and no environment-variable fallback. The README names the one
permission that matters, `Administration repository permission (read)`, because the traffic endpoints
require it, and states that `Contents` is not required and never requested. The privacy note adds the
two mechanisms behind the description: the store refuses to read the credential file at any other mode
and names the mode it observed rather than repairing it, and token-shaped values are redacted from every
error surface.

`docs/PRD.md` `## 8. Security and Privacy` carries the same description as `RS-SEC-01` through
`RS-SEC-04`, so the requirement and the documents use one set of words.

**What the tests hold.** `tests/release-contract.test.js` asserts the permission against
`TRAFFIC_PERMISSION`, the constant the product itself exports, so the README and the privacy note cannot
drift apart from the code; it also asserts the read-only claim, the mode, and the never-printed claim.
`tests/credentials.test.js` asserts the credential file exposes the token only through `getToken()` at
mode `0600`.

**Left for the reviewer.** Whether the description matches the tokens GitHub offers today is a question
for a reader with the vendor pages open. This dossier checks what this repository says and asserts; it
does not check GitHub's current documentation, and no test here can.

---

## 4. Nothing leaves the machine but read requests to one host

| Field | Value |
|-------|-------|
| `Position` | `privacy-note` |
| The question the reviewer answers | Is the privacy note accurate as written, including the one exception the transport permits for tests? |
| The claim, in the project's own words | "**One host: `api.github.com`.** Every outbound request in this product is a `GET` to that host over HTTPS" |
| `Stated in` | `docs/operations/privacy.md` `## What leaves your machine` |
| `Asserted by` | `tests/release-contract.test.js` test "the privacy note states that no telemetry exists and names the only outbound host"; `tests/release-contract.test.js` test "neither document names an outbound host other than api.github.com"; `tests/release-contract.test.js` test "the transport still permits only api.github.com and the gated loopback stub, and only the transport makes an outbound request"; `tests/github-http.test.js` test "non-allowlisted targets and insecure URLs never call fetch or credentials"; `tests/contract-transport.test.js` test "the only host the privacy note allows is api.github.com" |
| `Also stated in` | `README.md` `## No telemetry, and no analytics` - "The only outbound host the product is permitted to contact is `api.github.com`, enforced in code by the transport's allowlist rather than by convention."; `docs/operations/privacy.md` `## The short version` - "Yes: read requests to `api.github.com`, and nothing else."; `docs/operations/privacy.md` `## Where each claim is enforced` - "The only permitted host is `api.github.com`; redirects are refused; requests are `GET`"; `docs/operations/privacy.md` `## Test-only transport variables` - "opens the allowlist to exactly one extra origin: a loopback base URL whose hostname is `127.0.0.1`"; `docs/PRD.md` `### 6.4 Shared Constraints` - "The only outbound host the product may contact is api.github.com, every request is a GET, redirects are refused rather than followed, and the host is re-checked on every request rather than at import."; `docs/PRD.md` `## 8. Security and Privacy` - "Nothing leaves the machine except the read requests collection needs, and those go to one host" |
| `Status` | confirmed by documentation |

**What the sources say.** The privacy note is the long version and the README is the short one, and they
agree: the only host is `api.github.com`, every outbound request is a `GET` over HTTPS carrying the
pinned API version header, there is no telemetry of any kind, and the dashboard loads no remote asset.
The note states three things the request policy makes true rather than merely intended - redirects are
refused rather than followed, the host is re-checked on every request before a socket opens, and
requests are `GET` only - and it maps each claim to the file that enforces it.

There is exactly one documented exception, and a reviewer should read it as part of the position rather
than past it: `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` opens the allowlist to one loopback origin so the test
suite can drive a local stub. `docs/operations/privacy.md` `## Test-only transport variables` says so,
says the gate is off unless a test sets it and is evaluated on every request, and says neither of the
two variables is settable from `config.json`.

**What the tests hold.** `tests/release-contract.test.js` asserts the note names the single permitted
host, that neither document names another, and that `src/github/http.js` still permits only
`api.github.com` and the gated loopback stub while being the only module in `src` that names `fetch`.
`tests/github-http.test.js` asserts that a non-allowlisted target never reaches `fetch` or the credential
at all. `tests/contract-transport.test.js` asserts the note's own host set, and that the loopback gate
cannot authorise any other host.

**Left for the reviewer.** Whether the note's account of what leaves the machine is accurate and
unambiguous, and whether the loopback exception is described prominently enough for a reader who never
opens the transport.

---

## Observations the reviewer still has to make

These are the places where the files around a position say something the position's own claim does not
settle. They are recorded here because a reviewer's judgement is the only thing that can settle them,
and none of them is resolved on this page.

1. **The confirmation sentence in `LICENSE`.** The paragraph after the MIT text ends with "that
   statement is the project's own position on its own data and is confirmed by a person, not by this
   file." Read one way that states who confirms the position; read another it states that the file does
   not. No test asserts that sentence, and this dossier does not choose between the readings.
2. **The stored-files table in the privacy note.** `docs/operations/privacy.md` `## What is stored on
   your machine` lists `config.json`, `credentials.json` and `archive.sqlite3`, while `README.md`
   `## Where everything lives` names five files, adding `archive.sqlite3-wal` and `archive.sqlite3-shm`
   as the two write-ahead side files an open archive keeps beside itself. Both documents are asserted by
   named tests for the claims they make, and nothing asserts that the two inventories agree with each
   other. Whether that difference is worth recording is the reviewer's call.
3. **The one test-only host exception.** Under position 4 above: documented, gated and asserted, and
   still the only allowance besides `api.github.com`.
4. **Outside the four positions.** The target-platform paragraph of `docs/PRD.md` `## 1. Overview` - the
   same paragraph that carries "Public source under MIT" - describes "two runtime commands", while
   `README.md` `## The registered commands` states three. That is command inventory rather than posture,
   so it is reported here and not treated as a position.

---

## Where the decision goes

The reviewer's decision for each of the four positions, the reason, and the list of what was read belong
in `docs/reviews/open-source-posture.json`. No agent authors, completes or approves that file, and no
test in this repository can stand in for it - a passing suite is evidence that a sentence is still in a
document, and it is not evidence that a position is right. `docs/operations/release-checklist.md` keeps
that gate in its table of three human gates, and `tests/ci-contract.test.js` fails if that page ever
calls a gate recorded while its artefact is absent, or absent while its artefact is present.

Two further gates are named in the same table and are outside this dossier: the live integration check
(`RS-OPS-LIVE-01`) and the seven-day unattended soak (`RS-OPS-SOAK-01`). Neither concerns posture, and
neither is recorded either.