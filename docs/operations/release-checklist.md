# Release checklist

This page is what a maintainer reads before tagging a commit. It names the facts that have to be
true of the tag, the commands that prove the mechanical ones, and the three gates that only a
person can pass. It reports no test result, no approval and no compliance claim, because none of
those is a property of a document: where a result belongs, this page names the artefact that has
to hold it.

Two things are deliberately absent. Nothing here is automated, because a script must not be able
to satisfy the three human gates at the bottom of this page. And nothing here publishes anything:
the pipeline in `.github/workflows/ci.yml` verifies and stops, a tag is created by a person, and
this repository ships no release step of its own.

Run every command below from the repository root. Every command named here exists in this
repository today; `tests/ci-contract.test.js` resolves each one against the command registry and
fails the suite if a page names a command this build does not register.

---

## What ships with the tag

| Fact | Value | The authority for it |
|------|-------|----------------------|
| Schema version (code) | `1` | the highest numbered file in `src/db/migrations/`, here `001-core-schema.js` |
| Supported Node range | `>=24.12.0` | `"engines": { "node": ">=24.12.0" }` in `package.json` |
| Node line also verified | `24.21.0`, the current 24 Active LTS line | the matrix in `.github/workflows/ci.yml` |
| Licence | MIT | `LICENSE` |
| Package version | `0.1.0` | `"version"` in `package.json` |

Three of those five are values a later commit can move, so each one is checked mechanically
rather than trusted: `tests/ci-contract.test.js` reads the migration directory, `package.json` and
the workflow matrix and fails if this page stops naming what they say. Adding
`002-something.js` to `src/db/migrations/` therefore fails the suite until this table is updated,
which is the point of naming the schema version here at all.

Read the schema version the same way a release does, from the tool rather than from this page:

```
node src/cli.js db migrate
node src/cli.js db status
```

`db status` prints `schema version (code)` and `schema version (on disk)`. The number that ships
is the code version; the on-disk version is whatever a maintainer's own archive happens to hold.

The Node floor is a storage requirement, not a preference: the archive is opened through
`node:sqlite`'s `enableDefensive`, which earlier release lines do not expose. A host below the
floor imports the module successfully and then fails inside the archive code, which reads as a
product fault. Both supported lines are in the pipeline matrix so the floor is proven rather than
merely declared.

The licence covers the software. It grants no right in the data an archive holds, which is why the
redistribution statement is stated separately, in `README.md`, and why the open-source posture
review below is a gate rather than a formality.

---

## What the pipeline runs

Four commands, in this order, on each of the two Node lines:

| Command | What it proves | If it fails |
|---------|----------------|-------------|
| `npm ci` | the checkout installs from the committed lock file, with no `dependencies` entry to install | the lock file and the manifest disagree; do not tag |
| `npm run typecheck` | `tsc --noEmit` is clean over `src`, `scripts` and `tests` | a JSDoc type is wrong; do not tag |
| `npm test` | the whole suite ran: `scripts/run-tests.mjs` exits non-zero when it selected zero tests, so a suite that discovered nothing fails the build | a test failed; do not tag |
| `node scripts/backup-drill.mjs` | the archive restore path works: a known dataset is written to a scratch home, backed up, restored into a second scratch home and compared per table, exiting non-zero on any difference | the archive cannot be restored; do not tag |

The drill runs last so the restore path is exercised on every pipeline run, and it needs no token,
no network and no real archive. `docs/operations/backup-and-migrate.md` is the operator's version
of the same procedure.

Two properties of the pipeline are part of the release promise rather than of its convenience, and
`tests/ci-contract.test.js` asserts both:

- **It needs no secret.** No GitHub token, no repository secret, no environment variable carrying a
  credential. `permissions: contents: read` is a read-only checkout and nothing else. A pipeline
  that needed a token would mean the token was needed to prove the product works, which it is not.
- **It publishes nothing.** No deployment, no package publication, no release creation, no upload.
  Verifying is the whole job.

The pipeline also contacts no host of its own. The product's only permitted outbound host is
`api.github.com`, enforced in `src/github/http.js` and asserted by `tests/github-http.test.js`, and
a build step is not a place where a second host could appear.

---

## The statements the README must still make

`README.md` is the only page a stranger is guaranteed to read, and each of these sentences is load
bearing. `tests/release-contract.test.js` asserts them against the live files, and
`tests/ci-contract.test.js` asserts that this page still names them, so a later edit cannot drop a
statement from one document and quietly leave the other claiming it:

- **A clone is not adoption.** The README says it, and says the tool never calls a clone adoption.
- **It fabricates no history.** A missing day stays absent: never written as `0`, never
  interpolated, never carried forward, and the tool leaves the gaps as gaps.
- **There is no adoption score**, no ranking, no verdict and no threshold that fires.
- **It performs no write.** Every request is a `GET`, and `Contents` is not required and never
  requested.
- **GitHub's repository traffic data is GitHub's aggregate data, and this archive may not be
  redistributed.** Do not publish an archive file.
- **The one permission that matters is `Administration repository permission (read)`**, because the
  traffic endpoints require it.
- **There is no telemetry**, and the only outbound host is `api.github.com`.
- **The supported Node range is `>=24.12.0`**, with the reason the floor is a floor.
- **The home is created mode `0700` and the credential file is read only at mode `0600`**, and the
  tool refuses to run when the resolved home is a git repository root.

Two of those sentences are a person's judgement rather than a fact, and this page does not settle
them: the redistribution statement and the choice of licence come from the open-source posture
review below. Until that review is recorded, read them as the project's own position rather than as
confirmed policy.

---

## The three human gates before a tag

No agent authors these three files, and no test can stand in for them. A tag is premature while any
row below reads `not recorded`.

| Gate | What a person establishes | Evidence artefact | Recorded? |
|------|---------------------------|--------------------|-----------|
| `RS-OPS-LIVE-01`, the live integration check | that the real `api.github.com` answers as this build assumes: the API version header, the star media type, the `202` statistics retry, the traffic permission, and that a real token reaches every supported call shape | `docs/reviews/github-live-integration.json` | not recorded |
| `RS-OPS-SOAK-01`, the seven-day soak | that seven consecutive unattended days leave no gap wider than 26 hours, need no manual repair, and keep the request budget inside the documented figure | `docs/reviews/collection-soak.json` | not recorded |
| `RS-OPS-REV-01`, the open-source posture review | that the licence, the redistribution statement, the token description and the privacy note are accurate and unambiguous, and that this page's gates match the review files that exist | `docs/reviews/open-source-posture.json` | not recorded |

None of those three files is in this repository yet, and this page says so rather than implying the
gates are behind you. The `Recorded?` column is the only thing that changes when they are: each
file is written by the reviewer who ran the gate, and `tests/ci-contract.test.js` fails if this
page keeps calling a recorded gate unrecorded or claims an unrecorded one as done.

The gates are ordered by what they can catch. The live check catches a wrong vendor assumption, which
is the failure no amount of local testing can find. The soak catches the laptop-sleep, token-expiry
and rate-limit days that a week's unattended schedule is the shortest window able to produce. The
posture review catches a statement that is technically true and still misleading, which is the one
failure mode a test cannot express.

---

## The tag itself

1. **Confirm the pipeline ran on the commit you are about to tag**, on both Node lines named in the
   matrix. Read the run; this page does not record its outcome for you.
2. **Confirm every row of the gate table above reads `recorded`.** One row still reading
   `not recorded` stops the tag.
3. **Confirm the five facts in the first table still match the repository** after the last commit:
   schema version, Node range, verified Node line, licence, package version.
4. **Bump `package.json` and this page together** if any of those moved, and let the suite tell you
   when you did not.
5. **Tag the commit** with the package version, for example `v0.1.0`, and record the tag in the
   open-source posture review or in your own dated notes.
6. **Do not attach an archive to the release.** A backup copy is GitHub's aggregate traffic data;
   where copies belong is in `docs/operations/backup-and-migrate.md`, and publishing one is the one
   thing the redistribution statement forbids.

A tag is a person's decision, and the release gate is deliberately not a machine step: the three
artefacts above are the evidence, and this page is only the list.
