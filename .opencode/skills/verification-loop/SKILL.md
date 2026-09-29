---
name: verification-loop
description: "The RepoSignal verification loop: run tests through scripts/run-tests.mjs so a zero-test selection fails, type-check with tsc --noEmit over checkJs JSDoc types, mirror the source layout under tests/, give every run a temporary REPO_SIGNAL_HOME, and drive entry-point tests by spawning node src/cli.js rather than importing a module. Use when running, interpreting or fixing a task's validation commands, or when a test fails in a way that looks like a product bug."
---

# Skill: Verification Loop

Every task in the plan names two commands drawn from this one loop, and `RS-TC-04` makes a command
that proves nothing an unacceptable check. The loop has no test-framework dependency, no build step
and TypeScript sources do not exist - types live in JSDoc and are checked with `tsc --noEmit`.

Load the symptom-to-cause table in [failure-recovery.md](./references/failure-recovery.md) when a
command fails, when a suite passes suspiciously fast, or when a test fails only in some orders.

## Process

### Step 1: Run through the wrapper, not the runner

```bash
npm test -- tests/the-named-file.test.js
```

`npm test` runs `scripts/run-tests.mjs`, which invokes the Node test runner over the given paths and
then fails the command when zero tests were selected or when any test failed. Running
`node --test` directly bypasses the empty-selection guard, so never substitute it for a task's named
command.

### Step 2: Read the selection count, not only the exit code

Confirm the output names the tests that ran. Exit zero with a suspiciously short output means the
selection found nothing, and until the wrapper exists that command proves nothing - say so rather
than reporting a pass. If the count is zero, then stop and fix the selection before anything else.

### Step 3: Type-check as part of the loop

```bash
npm run typecheck
```

`tsc --noEmit` covers `src`, `scripts` and `tests` under `checkJs`. A JSDoc type error is a failure
even when the runtime behaviour is correct, because the loop exists to keep the types honest without
a build step.

### Step 4: Mirror the source layout

Tests live under `tests/` and mirror the source tree: a module at `src/db/day-series-repo.js` is
tested at `tests/day-series-repo.test.js`, a view at `src/server/views/health.js` at
`tests/views/health-view.test.js`, and end-to-end suites at `tests/integration/*.test.js`. Naming
mirrors layout so a missing test is visible as a missing file rather than a missing assertion.

### Step 5: Isolate the home directory per run

Every test that touches configuration, credentials or the database sets `REPO_SIGNAL_HOME` to a
fresh temporary directory and asserts the home is created with mode 0700. A suite that inherits the
developer's home migrates it, and a suite that shares a home with another is order-dependent.

### Step 6: Drive commands through the process entry point

Command tests spawn `node src/cli.js` and assert the exit code and captured output. An import
proves the module works; only a spawn proves the registry, the argument parsing, the usage path and
the exit code. If a test needs a command's internal state, then call the module directly as a
second test rather than weakening the spawn assertion.

### Step 7: Report the observed outcome

State each command with what it actually printed and whether tests were selected. Report a failing
command as failing. An unrun command is reported as unrun, never as implied success.

## Gotchas

- **`npm test -- <file>` exits zero with no tests until the wrapper lands.** `RS-FND-01` creates the
  fail-on-empty wrapper, so before that task is complete a green command can mean nothing ran. Check
  the reported count.
- **`npm test --` swallows flags meant for the runner.** Pass paths after `--`; without it the
  wrapper may treat a path as an unknown option and select nothing.
- **A host below Node 22.13 cannot import `node:sqlite` without a flag.** Every storage test then
  fails with an import error that looks like a product bug. Check `node -v` before debugging storage.
- **`checkJs` errors are usually about the JSDoc, not the logic.** A missing `@type` import for
  `DatabaseSync` or a `Promise` returned where the annotation says otherwise is a type error; fix
  the annotation rather than casting the value away.
- **A suite that writes into the real home passes alone and fails in a full run.** The second run
  finds a migrated database with existing rows and a possibly different schema version.
- **Fixed ports make integration tests flaky.** Start the server with `--port 0` and read the URL the
  factory returned; a hard-coded 4173 collides with a real dashboard or a parallel suite.
- **A test that waits on real retry backoff is slow and flaky.** Inject the clock and the sleep
  function, then assert the chosen delays and attempt counts instead of waiting.
- **A stub server that only works when a flag is set globally voids the allowlist test.** Set the
  local transport override for the child process under test only.
- **Seed data through the repositories, not with direct SQL.** Direct inserts skip the constraints
  the invariants rely on, so a later assertion about a rejected write can pass against a database
  that never enforced it.

## Validation

Self-check the loop itself before trusting a result:

- [ ] `npm run typecheck` exits zero and covers `src`, `scripts` and `tests`.
- [ ] `npm test -- <named test file>` reports the tests it selected; the count is greater than zero.
- [ ] A test file that contains no tests makes the repository test command fail, and that behaviour
      is itself covered by a named test in `tests/run-tests.test.js`.
- [ ] Every test that touches state sets `REPO_SIGNAL_HOME` to a temporary directory and asserts
      mode 0700.
- [ ] Every command-level test spawns `node src/cli.js` and asserts both the exit code and the
      captured output.
- [ ] Each task's report states the commands run and their observed output, with an unrun command
      reported as unrun.
