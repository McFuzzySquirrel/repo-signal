---
name: cli-command-surface
description: "Adding and testing a RepoSignal subcommand: register it in src/commands/index.js, honour the 0 success / 1 operational failure / 2 usage error exit-code contract, print usage for --help and for an unknown command, emit one fact per line with no credential material, support the dry-run and filter flags the command plan names, and prove reachability by spawning node src/cli.js rather than importing a module. Use when creating or changing anything under src/commands/, or when a test needs to exercise a command."
---

# Skill: CLI Command Surface

Five features add subcommands to one shared registry with one shared exit-code and output contract.
The conventions here exist because each command's acceptance criteria assert reachability through
the process entry point rather than an import.

Load [command-inventory.md](./references/command-inventory.md) when adding a subcommand, when a
runbook needs to name a command, or when a test asserts a command exists.

## Process

### Step 1: Register in the one registry

`src/commands/index.js` is the only module a subcommand must be registered in, and `src/cli.js` is
the composition root that resolves it. Adding a command is a change to the registry plus its own
module; a view or command reached by any other route is unreachable work.

### Step 2: Map the outcome to 0, 1 or 2

Zero on success, one on an operational failure, two on a usage error - a bad flag, a missing
argument, an unknown subcommand. A repository that failed during `collect` is an operational
failure: the command exits 1, prints a failure line per repository, and still writes a complete run
record, so a scheduler can alert while the successful repositories are already stored.
If a new command has no natural operational failure, then it still maps an unexpected state to 1.

### Step 3: Print usage for help and for mistakes

`--help` and an unknown command both print usage; the unknown command exits 2. Usage names the real
subcommands, not a placeholder, because a stranger reads it after a typo.

### Step 4: Print one fact per line, with no credential material

Each line carries a single fact in the documented shape, such as `owner/name ok 14 days`,
`owner/name failed <kind>`, or `planned` in place of `ok` for a dry run. Every printed line passes
through credential redaction, and no line ever carries a token, an observation value or a repository
name where the command's contract says not to. A `collect` run prints its run identifier so the run
row can be found.

### Step 5: Implement only the flags the task names

`--dry-run` plans and prints without any network call or write - no run row, no heartbeat, no fact
row. `--repo owner/name` restricts work to one repository. `serve --port 0` binds an ephemeral port
and prints the URL actually listened on, which is what a test needs. Do not add a flag the plan did
not name.

### Step 6: Prove reachability by spawning

Reachability is proven by spawning the entry point, not by importing the module:

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" node src/cli.js config check; echo "exit=$?"
```

An import proves the function; only a spawn proves the registry entry, the argument parsing, the
usage path and the exit code. Assert the exit code and the captured stdout.

### Step 7: Isolate every run

Point `REPO_SIGNAL_HOME` at a temporary directory for the test, assert the home was created with
mode 0700, and assert the command wrote nothing outside it. A test that inherits the developer's
real home migrates or overwrites the maintainer's archive.

## Gotchas

- **An import-only test passes while the command is unreachable.** A subcommand that is never
  registered, or registered under the wrong key, still passes a unit test that imports its module
  directly. Always spawn for at least one assertion per command.
- **Exit code 1 versus 2 is not cosmetic.** Returning 1 for a mistyped flag makes a daily scheduler
  treat a typo as an outage, and returning 2 for a failed collection makes it ignore a real failure.
- **A dry run that writes is not a plan.** The most common dry-run bug is writing a run row or a
  heartbeat while "planning"; a test that asserts zero writes is what catches it.
- **`discover` must leave the configuration file byte-identical.** Discovery is a read-only
  convenience; a helper that normalises the configuration while reading it silently rewrites the
  file. Assert the file's content is unchanged after the command runs.
- **`serve` must print the resolved URL, not the default port.** A default of 4173 printed while the
  process listens on an ephemeral port is a lie the test cannot see through; read the URL the
  factory returned.
- **`config init` must not clobber an existing file.** Without an explicit force flag it exits
  non-zero and leaves the file unchanged; both templates are created with mode 0600.
- **A test that shares a real home is order-dependent.** The second suite to run finds a database
  with pending migrations or a lock, and the failure looks like a product bug.
- **Structured output is parsed by the operator, not by a machine, except where `--json` is
  specified.** `discover` has a machine-readable mode that prints one object with `repositories` and
  `configLines` arrays; the human table is not that format.

## Validation

Self-check each item, asserting the exit code and the captured output together:

- [ ] The subcommand is registered in `src/commands/index.js` and reached only through
      `src/cli.js`.
- [ ] A spawned `node src/cli.js <command>` returns exit 0 on success, 1 on an operational failure
      and 2 for an unknown command or a bad flag, each asserted by name.
- [ ] `--help` and the unknown-command path both print usage naming the real subcommands.
- [ ] The captured stdout of a `--dry-run` run contains one `planned` line per repository and no
      fact row, run row or heartbeat was written.
- [ ] The captured stdout of every command contains no token-shaped value, and every printed line
      comes from the redaction helper.
- [ ] The test sets `REPO_SIGNAL_HOME` to a temporary directory and asserts nothing was written
      outside it.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default an import-only test does not count as proof of
      reachability.
