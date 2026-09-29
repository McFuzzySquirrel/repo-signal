---
name: documentation-contract-tests
description: "Write RepoSignal's operator and public documents so they stay true, with the test that fails when they drift: every command named in a runbook must exist in the repository, the README must retain its no-fabrication, redistribution, permission and Node-range statements, the CI workflow must run install, typecheck and the fail-on-empty test wrapper, and no document may state a test result or approval that was not observed. Use when writing or editing README.md, a file under docs/operations/, the CI workflow, or the release checklist."
---

# Skill: Documentation Contract Tests

Four consecutive operations tasks build the same fragile artefact: a document plus a test that fails
when the document drifts. The failure mode is specific - a runbook documenting a command that does
not exist, or a README that quietly loses the statement that GitHub's traffic data may not be
redistributed - and the automated checks pass either way unless a test asserts the statement.

Load the assertion patterns in [document-test-patterns.md](./references/document-test-patterns.md)
when writing a new documentation test, and when deciding what a document must be made to assert
rather than merely state.

## Process

### Step 1: Name the statements the document must keep

Before writing prose, list the sentences that must survive editing: the no-fabrication statement
that a clone is not adoption and no history is fabricated; the redistribution statement that
GitHub's traffic data is GitHub's aggregate data and may not be redistributed; the required
`Administration` repository read permission; the supported Node range; where the archive and the
credential file live; and that no telemetry exists. Each becomes an assertion.
If a statement is added later, then it is added to this list first, or it becomes the one a later
edit drops.

### Step 2: Assert the commands a runbook names actually exist

For every command in a runbook, prove it exists in the repository. A word-match test is not enough:
resolve the command against the CLI by running it with `--help` or by reading the registry, and fail
when the named subcommand is unknown. Documentation that names a command which was renamed, or
written before the command existed, is the most common drift in this project.

### Step 3: Keep the pipeline and the checklist in step with reality

The workflow file must run a clean install, the type check and the repository test command - the
wrapper, not the bare runner, so an empty selection fails the build - on two Node versions
including the supported floor. The release checklist names the schema version that ships, the
supported Node range, the licence, the statements the README must still make, and the human gates
that must be recorded before a tag: the live integration check, the seven-day soak and the
open-source posture review.

### Step 4: Match every failure mode to the state word the product shows

The troubleshooting page covers an expired token, a token without the traffic permission, an
exhausted rate limit, a stalled collector, a failed migration and a database that will not open, and
for each one names the state word the dashboard displays. A symptom that maps to a cause cannot be
matched by guessing; the document and the product must use the same word.

### Step 5: Keep the unobservable out of every document

No document states a test result, an approval, a compliance claim or a live observation that was not
actually observed. The checklist names required gates, not outcomes. A redistribution statement is
drafted by the author and confirmed by the human posture review, which an agent never authors.
If a document needs a result to be useful, then it names where the result is recorded instead.

### Step 6: Assert the repository's own hygiene in the same tests

A release-contract test also asserts that no credential, database or home-directory file is tracked,
and that a licence file exists naming MIT with a copyright line. These are statements about the
repository, and they drift exactly as documents do.

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" npm test -- tests/release-contract.test.js
```

## Gotchas

- **A word-match test passes while the command is gone.** Asserting that a runbook contains the
  string `db backup` proves nothing; assert the subcommand resolves in the registry or answers
  `--help`.
- **A README loses its most important sentence quietly.** Rewriting the introduction to be friendlier
  easily drops "may not be redistributed" or "a clone is not adoption". That is why each statement
  has its own named assertion.
- **Asserting a test result in a document is a fabricated observation.** A checklist line reading
  "all tests passing" becomes false the day one fails, and no test can keep it true. Name the gates
  instead.
- **The workflow must call the wrapper.** A pipeline step that runs `node --test` passes on an empty
  selection, so the build reports success having tested nothing.
- **Checking committed secrets by filename is not enough.** Assert the credential path, the database
  extension and the home directory are ignored and absent from the index, rather than trusting a
  filename convention.
- **A runbook command written before its task landed is normal, not wrong to fix later.** When the
  document names a command that does not exist yet because its dependency has not run, report it and
  make the test name the gap rather than weakening the assertion.
- **The two-command promise must stay true.** The README documents a clone-and-run path with no
  build step; adding a build step, a bundler or a framework to a document or a document's
  instructions is a product regression, not a documentation fix.
- **A licence claim is a human judgement.** The test asserts the licence file names MIT and carries a
  copyright line; it does not decide whether that is the right licence.

## Validation

Self-check each item, remembering that a documentation test that passes because it greps words is
not evidence:

- [ ] A test asserts the README still states that a clone is not adoption and that no history is
      fabricated.
- [ ] A test asserts the README still states that GitHub's traffic data is GitHub's aggregate data
      and may not be redistributed.
- [ ] A test asserts the README names the `Administration` read permission and the supported Node
      range.
- [ ] A test asserts every command named in each runbook resolves in this repository, and the
      assertion names the command that is missing when it fails.
- [ ] A test asserts the workflow runs a clean install, the type check and the repository test
      command across two Node versions including the floor.
- [ ] A test asserts the release checklist names the live integration check, the seven-day soak, the
      open-source posture review, the schema version and the supported Node range.
- [ ] A test asserts no credential, database or home-directory file is tracked, and that a licence
      file names MIT with a copyright line.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default no document states a result, an approval or a compliance
      claim that was not observed.
