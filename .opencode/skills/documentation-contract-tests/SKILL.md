---
name: documentation-contract-tests
description: "Writing RepoSignal's public and operator documents so they stay true, with the test that fails when they drift: every command a runbook names must resolve in the registry, every documented number must be asserted against the exported constant that owns it, the pipeline and the release checklist against the workflow they describe, and no document may state a test result, approval or gate outcome that was not observed. Use when writing or editing the README, a file under docs/operations/, the CI workflow, or the release checklist."
---

# Skill: Documentation Contract Tests

Eleven of the eighteen implementation tasks in the plan build the same fragile artefact: one document
claim plus one contract test that fails when the claim drifts. `RS-C12` makes that a product constraint
rather than a nicety, because the failure mode is specific and expensive - a runbook documenting a
command that does not exist, or a README that quietly loses the statement that GitHub's aggregate
traffic data may not be redistributed, with every other check still green.

Load [document-test-patterns.md](./references/document-test-patterns.md) when writing a new
documentation test, when deciding what a document must be made to assert rather than merely state, and
when a document has to state a fact the code already exports.

## Process

### Step 1: Name the statements the document must keep

Before writing prose, list the sentences that must survive editing: the no-fabrication statement that a
clone is not adoption and no history is invented; the redistribution statement that GitHub's traffic data
is GitHub's aggregate data and may not be redistributed; the required `Administration repository
permission (read)`; the supported Node range; where the archive and the credential file live, including
the two side files that write-ahead logging adds beside the archive; and that no telemetry exists. Each
becomes its own named assertion.

If a statement is added later, then it is added to this list first, or it becomes the one a later edit
drops.

### Step 2: Assert documented numbers against the constant that owns them

Never restate a number in a test. Import the exported constant the product already uses and compare the
document against it: the credential mode and the home-directory mode from the store and path modules, the
traffic permission name from the supervision error module, the request figures from the collection run,
and the file names from the path module. A test carrying its own copy of a value lets the code change
under a document that still agrees with a number nothing produces.

### Step 3: Prove the commands a runbook names actually exist

For every command a document names, prove it exists: resolve it against the registry or spawn the entry
point and read the generated usage, then fail naming the command that is missing. A word match proves
the sentence and nothing else. The known live instance of this drift is the README's inventory, which
omits `report` even though the install sequence and every runbook use it, so the registry is the
authority and the document is what moves.

### Step 4: Keep the pipeline and the checklist in step with reality

The workflow runs a clean install, the type check, the whole suite through the wrapper rather than the
bare runner, and the backup drill - each exactly once, on both the declared Node floor and the current
LTS line, with read-only repository permissions, no secret of any kind, no deploy or publish pattern and
no scheduled trigger. A contract test asserts that shape against the workflow file itself, so the claims
in its comments cannot drift away from what it runs.

The release checklist names the schema version, the supported Node range, the licence and the package
version, each beside the authority for it; lists the pipeline commands in order with what each one
proves and what a failure means; and states that a failure of any of them means do not tag.

### Step 5: Name the human gates without claiming their outcome

The live integration check, the unattended soak and the open-source posture review are recorded by a
person into named review artefacts, and the checklist says so rather than asserting that they passed.
A checklist that names a gate only as "sign-off" without an artefact is not a gate, and a test that
asserts a review file contains an approval is asserting an observation no agent may make.

### Step 6: Match every failure mode to the state word the product shows

The troubleshooting document covers an expired token, a token without the traffic permission, an
exhausted rate limit, a stalled collector, a failed migration and a database that will not open, and for
each one names the state word the dashboard and the report display. Extract the state words from the
product's own state enumeration and assert each appears in the document, so a renamed state breaks the
test rather than the operator's trust.

### Step 7: Assert repository hygiene in the same suite

A release-contract test also asserts that no credential, database or home-directory path is tracked, that
the ignore file covers those paths so a local run cannot stage them by accident, and that a licence file
exists naming MIT with a copyright line. Those are statements about the repository and they drift exactly
as documents do.

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" npm test -- tests/release-contract.test.js
```

## Gotchas

- **A word-match test passes while the command is gone.** Asserting a document contains the string for a
  command proves nothing; assert the subcommand resolves in the registry or answers generated usage.
- **A test that copies a number is a second source of truth.** Import the constant, or the document and
  the code drift apart with every test still green.
- **A document loses its most important sentence quietly.** Rewriting an introduction to be friendlier
  easily drops the redistribution statement or the no-fabrication statement, which is why each one has
  its own named assertion.
- **Asserting a test result in a document is a fabricated observation.** A checklist line reading "all
  tests passing" becomes false the day one fails and no test can keep it true. Name the gate instead.
- **The workflow must call the wrapper.** A pipeline step that runs the bare test runner passes on an
  empty selection, so the build reports success having tested nothing.
- **Checking committed secrets by filename is not enough.** Assert the credential path, the database file
  and the home-directory pattern are ignored and absent from the index, rather than trusting a naming
  convention.
- **A runbook command written before its task landed is normal, not wrong.** When a document names a
  command that does not exist yet because its dependency has not run, report it and let the test name the
  gap rather than weakening the assertion.
- **The clone-and-go promise is a documented claim.** Adding a build step, a bundler or a framework to
  the instructions is a product regression, not a documentation fix, and a contract test should notice.
- **A licence claim is a person's judgement.** The test asserts the file names MIT and carries a
  copyright line; it does not decide whether that is the right licence, and the posture review does.
- **A whole-document golden comparison fails on every copy edit and gets deleted.** Named statement
  assertions survive editing; a byte comparison does not.

## Validation

Self-check each item, remembering that a documentation test which passes because it greps words is not
evidence:

- [ ] Every documented number is asserted against an imported constant rather than a literal in the
      test.
- [ ] A test asserts the README still states that a clone is not adoption and that no history is
      invented, as its own named assertion.
- [ ] A test asserts the README still states that GitHub's traffic data is GitHub's aggregate data and
      may not be redistributed, and that no command exports, publishes or shares an archive.
- [ ] A test asserts every command named in each runbook resolves in this repository, and the failure
      message names the command that is missing.
- [ ] A test asserts the workflow runs a clean install, the type check, the suite through the wrapper and
      the backup drill, exactly once each, across two Node versions including the floor, with no secret
      and no deploy or publish pattern.
- [ ] A test asserts the release checklist names the schema version, the supported Node range, the
      licence and the package version beside their authorities, and states that a pipeline failure means
      do not tag.
- [ ] A test asserts the checklist names each human gate by its review artefact and does not assert that
      any of them passed.
- [ ] A test asserts the troubleshooting document uses the same state words the product emits.
- [ ] A test asserts no credential, database or home-directory path is tracked, that the ignore file
      covers them, and that a licence file names MIT with a copyright line.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default no document states a result, an approval or a compliance claim
      that was not observed.