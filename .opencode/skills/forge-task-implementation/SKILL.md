---
name: forge-task-implementation
description: "Execute one RepoSignal forge-task contract end to end: read the version-2 contract, resolve its requirement and constraint refs, stay inside expectedOutputs and constraints, prove the behaviour with the named test files, run the named validationCommands, and stop at a human-review gate instead of self-serving it. Use when a forge-task block names your ownerAgent, or when deciding whether a file, module or behaviour belongs to the task in front of you."
---

# Skill: Execute One Forge Task

A RepoSignal `forge-task` block is a bounded contract: one accountable specialist, named output
files, hard constraints, and named validation commands. This skill is the reading order and the
stop rule for working exactly one of them.

Load the field-by-field map in [contract-fields.md](./references/contract-fields.md) when you need
to decide whether a file, a module or a behaviour is inside the contract's boundary.

## Process

### Step 1: Read the contract before the repository

Parse the block in this order and write the answers down: `id`, `ownerAgent`, `dependencies`,
`expectedOutputs`, `validationCommands`, then `contract.requirements` and `contract.constraints`.
Read `description` last as prose, because it summarises decisions the field list already fixes.

If `ownerAgent` is not your name, then stop and report the mismatch rather than implementing it
under a different identity. If the block is a `human-review` kind, then go to Step 8. If the block
names a file that does not exist, then treat it as an intentional modification of an earlier task's
output and preserve everything else in it.

### Step 2: Resolve the refs, not the document

`requirementRefs` and `constraintRefs` are `path#ID` selectors such as
`docs/features/telemetry-storage.md#RS-DB-FR-02`. Open the selected requirement or heading, not the
whole feature document, and treat the resolved text as part of your contract. A version-2 contract
with empty `requirements` and non-empty `requirementRefs` is fully specified; you do not need to
hunt for extra requirements in the vision.

### Step 3: Confirm the prerequisites actually exist

Every entry in `dependencies` is a task ID whose outputs are your inputs. Check each named file
exists before writing code. If a prerequisite output is missing, stop and report the missing
interface; do not create a private stand-in for it, because the real module will then be wired
around yours.

### Step 4: Write only what the contract names

Create or modify exactly the paths in `expectedOutputs`, plus the test files the block requires in
them. If the behaviour obviously needs a helper module, keep the helper inside the named output
file rather than adding an unnamed file. If the contract names a file that already exists and
intentionally modifies it, keep every unrelated behaviour in it intact.

### Step 5: Treat the constraints as a deny list

Each `constraints` entry is a boundary owned by another task or another feature. Treat the entries
as exclusions for this task: documentation belongs to the operations feature, heartbeat and error
state belong to supervision, rendering belongs to the views, and retry or backoff logic belongs to
the transport policy. Writing a small part of a neighbour's responsibility makes that neighbour's
test pass without ever exercising your change.

### Step 6: Prove the behaviour with the named tests

For every entry in `contract.acceptanceCriteria`, there must be a named assertion - a test case or a
specific test file - that fails before the change and passes after it. A criterion that reads "the
state is preserved" needs a test named for that state, not a general happy-path test.

### Step 7: Run the named validation commands

Run exactly the `validationCommands`, from the repository root, and report the observed output. If
`npm run typecheck` is listed, then it must exit zero; a JSDoc type error is a failure even when the
runtime behaviour is right. The repository wrapper at `scripts/run-tests.mjs` is what makes a named
test selection meaningful, so if the wrapper has not landed yet, then report the command as
proving nothing rather than as passing.

```bash
npm run typecheck
npm test -- tests/the-named-file.test.js
```

### Step 8: Stop at the human gate

A `human-review` contract has empty `expectedOutputs` and empty `validationCommands`, a
`contract.reviewFile` path, and an explicit constraint that no agent may author or complete it. Do
not create the review file, do not run an approval command, and do not write a report that a
reviewer could mistake for sign-off. A review task is blocked on a person; report it as blocked.

## Gotchas

- **A file that is not in `expectedOutputs` is unowned work.** Code that exists but is not named in
  a contract is invisible to the next task, which will build a parallel version. If a change cannot
  be expressed inside the named outputs, report the gap instead of adding a file.
- **The exclusion is the field agents overrun.** Constraints such as "no heartbeat or error-state
  recording in this task" or "no repository or query function is written in this task" exist because
  a neighbouring task owns that surface. Writing a plausible half of it produces a suite that passes
  while the real implementation is never exercised.
- **A validation command can pass while proving nothing.** `npm test -- tests/foo.test.js` exits zero
  if the file selects no tests, so the repository wrapper that fails on an empty selection is part
  of the contract. If the wrapper has not landed yet, say the command proves nothing yet.
- **`node src/cli.js` reachability is an acceptance criterion, not an import.** Several tasks assert
  the command through the process entry point because an import proves the function but not the
  wiring.
- **Do not edit a human-review file to make a run complete.** A green pipeline does not satisfy
  `RS-FND-REV-01`, `RS-UI-REV-01`, `RS-VIZ-REV-01`, `RS-OPS-LIVE-01`, `RS-OPS-SOAK-01` or
  `RS-OPS-REV-01`; those records are a person's observation.
- **Three tasks own the same three files by design.** Registry, orchestration and wiring files are
  modified by later tasks, so a merge or an unexpected diff in `src/commands/index.js` is expected,
  not a conflict to resolve by reverting.
- **A test-only task must not patch production.** The three `qa-engineer` integration tasks add
  tests only; when a test fails because `src/` is wrong, report the defect with the file and the
  observed output instead of editing `src/`.

## Validation

Self-check before reporting, in this order:

- [ ] `git status --porcelain` lists only paths from `expectedOutputs`.
- [ ] Every `contract.constraints` entry was checked against the diff, and nothing owned by a
      neighbouring task appears in it.
- [ ] Each `contract.acceptanceCriteria` maps to a named test case in a file named in `expectedOutputs`.
- [ ] `npm run typecheck` exits zero and `npm test -- <named test file>` reports a non-zero selected
      test count through the `scripts/run-tests.mjs` wrapper; by default report an unrun command as
      unrun rather than as an implied pass.
- [ ] For a `human-review` block, no file under `docs/reviews/` was created or modified and the
      task is reported as blocked on a person.
