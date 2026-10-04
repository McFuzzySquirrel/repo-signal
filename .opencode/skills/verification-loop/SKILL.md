---
name: verification-loop
description: "The RepoSignal verification loop: run suites through scripts/run-tests.mjs so a zero-test selection is a failure, type-check the JSDoc types with tsc --noEmit, mirror the source layout under tests/, give every run a temporary REPO_SIGNAL_HOME, and prove a command by spawning node src/cli.js instead of importing a module. Use when running or interpreting a task's validation commands, or when a suite fails in a way that looks like a product defect."
---

# Skill: Verification Loop

Every task in the plan names validation commands drawn from this loop, and `RS-NF-05` makes a command
that proves nothing an unacceptable check. There is no test-framework dependency and no build step;
the JavaScript types are JSDoc annotations and `RS-C14` sets the runtime floor at Node 24.12.0.

Load [failure-recovery.md](./references/failure-recovery.md) when a command fails, when a suite passes
suspiciously fast, or when a test fails only in some orders.

## Process

### Step 1: Run through the wrapper, not the bare runner

```bash
npm test -- tests/the-named-file.test.js
```

`npm test` runs `scripts/run-tests.mjs`, which spawns the Node test runner over the given paths with
the TAP reporter and then decides the exit code itself. Running `node --test` directly bypasses every
guard in the wrapper, so never substitute it for a task's named command. If a name is ambiguous and
two suites match, then run the file path explicitly rather than letting the wrapper widen the
selection.

### Step 2: Read the selection count, not only the exit code

The wrapper reports seven distinct refusals, and each one is a failure the operator has to see rather
than a green run:

- a named path that does not resolve;
- zero files matching the Node test patterns;
- a runner that could not be started at all, which names the operating-system code and the `node` it
  tried to spawn;
- a runner that was killed by a signal before it reported a summary;
- a run whose TAP counters never printed, so no result can be trusted;
- a run that selected zero tests from files that did resolve;
- a file that reported only itself, meaning it declares no test.

Confirm the output names the tests that ran. If the selection found nothing, then stop and fix the
selection before anything else, and report the command as proving nothing rather than as a pass.

### Step 3: Type-check inside the same loop

```bash
npm run typecheck
```

`tsc --noEmit` covers `src`, `scripts` and `tests` under `checkJs` with `strict`, so a JSDoc type
error is a failure even when the runtime behaviour is correct. A missing `@type` import for
`DatabaseSync` or a promise returned where the annotation says otherwise is a type error, so fix the
annotation rather than casting the value to `any`.

### Step 4: Mirror the source layout

Tests live under `tests/` and mirror the source tree: `src/db/day-series-repo.js` is tested at
`tests/day-series-repo.test.js`, `src/server/views/health.js` at `tests/views/health-view.test.js`, and
the whole-stack suites at `tests/integration/*.test.js`. Contract tests that assert a document live
beside the other repository-level suites, as `tests/release-contract.test.js` and
`tests/ci-contract.test.js` do. Naming mirrors layout, so a missing test is visible as a missing file
rather than as a missing assertion inside a file that already exists.

### Step 5: Isolate the home directory per run

Every test that touches configuration, credentials or the archive sets `REPO_SIGNAL_HOME` to a fresh
temporary directory and asserts the home is created at mode 0700. `RS-C08` resolves one home for the
whole product, so a suite that inherits the developer's home migrates it, and a suite that shares a
home with another is order-dependent.

### Step 6: Drive commands through the process entry point

Command tests spawn `node src/cli.js` and assert the exit code together with the captured output. An
import proves the module works, and only a spawn proves the registry entry, the argument parsing, the
usage path and the exit code. If a test needs a command's internal state, then call the module
directly as a second test rather than weakening the spawn assertion.

### Step 7: Prove claims against the authority, not a copy

A contract test imports the constant it asserts rather than restating its value, as
`tests/ci-contract.test.js` imports `CREDENTIAL_FILE_MODE`, `HOME_DIRECTORY_MODE` and
`TRAFFIC_PERMISSION` and `tests/troubleshooting-contract.test.js` imports the request figures from
`src/collect/run.js`. If the test carries its own copy of a number, then the code can change and the
document still agree with a value nothing produces.

### Step 8: Report the observed outcome

State each command with what it actually printed and how many tests it selected. Report a failing
command as failing, report a command that proved nothing as proving nothing with the reason, and
report an unrun command as unrun.

## Gotchas

- **A green command can mean nothing ran.** `scripts/run-tests.mjs` exists to make that state a
  failure; if the count it prints is zero, then the assertion you were asked to prove was never
  exercised.
- **`npm test --` swallows flags meant for the runner.** Pass paths after `--`; without it the
  wrapper may treat a path as an unknown option and select nothing.
- **A host below Node 24.12 imports `node:sqlite` and only fails at the connection.** The release
  that dropped the experimental flag is older than the release that exposes `enableDefensive`, so the
  import succeeds and every storage test then dies at `new DatabaseSync(...)` with an unknown option.
  That reads as a product defect; check `node -v` against the `RS-C14` floor first.
- **`checkJs` errors are usually about the annotation, not the logic.** Fix the `@type` or the return
  type; casting the value away hides the next error.
- **A suite that writes into the real home passes alone and fails in a full run.** The second run
  finds an already-migrated database with rows and a possibly different schema version.
- **Fixed ports make integration tests flaky.** Start the dashboard with `--port 0` and read the URL
  the factory returned; a hard-coded port collides with a running dashboard or a parallel suite.
- **A test that waits on real retry backoff is slow and flaky.** Inject the clock and the sleep
  function, then assert the chosen delays and the attempt count instead of waiting.
- **A stub server that only works when the override is set globally voids the allowlist test.** Scope
  `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` to the spawned child, or to the test's own process, and never to
  a helper other suites inherit.
- **Seed data through the repositories, not with direct SQL.** A direct insert skips the constraints
  the invariants rely on, so a later assertion about a rejected write passes against a database that
  never enforced it.

## Validation

Self-check the loop itself before trusting a result it produced:

- [ ] `npm test -- <named test file>` reports the tests it selected and the count is greater than zero.
- [ ] `npm run typecheck` exits zero across `src`, `scripts` and `tests`.
- [ ] The wrapper's own behaviour is covered by `tests/run-tests.test.js`, including the refusal when
      a named file declares no test.
- [ ] Every test that touches durable state sets `REPO_SIGNAL_HOME` to a temporary directory and
      asserts mode 0700.
- [ ] Every command-level test spawns `node src/cli.js` and asserts the exit code and the captured
      output together.
- [ ] Every contract test imports the constant it asserts from the module that owns it.
- [ ] `npm test` and `node scripts/backup-drill.mjs` both exit zero, which is what `RS-NF-06` asks the
      pipeline to run on the floor and the current LTS line.
- [ ] The report states each command with its observed output, and any unrun command is reported as
      unrun.