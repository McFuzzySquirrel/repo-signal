---
name: cli-command-surface
description: "Adding and testing a RepoSignal subcommand: register it in the one registry that generates --help, dispatch and suggestions, honour the 0 success / 1 operational failure / 2 usage error contract with no stack trace, emit one fact per line with no credential material, implement only the flags the task names, and prove reachability by spawning node src/cli.js rather than importing a module. Use when creating or changing anything under src/commands/ or src/cli.js, or when a test needs to exercise a command."
---

# Skill: CLI Command Surface

Every subcommand in the product is reached through one registry with one exit-code contract and one
output contract, and two features append to it. The conventions here exist because each command's
acceptance criteria assert reachability through the process entry point rather than through an import.

Load [command-inventory.md](./references/command-inventory.md) when adding a subcommand, when a runbook
needs to name a command, or when a test asserts a command exists - and regenerate that inventory from
the registry rather than editing it, because the README's own inventory is already known to disagree
with the registry about `report`.

## Process

### Step 1: Register in the one registry

`src/commands/index.js` is the only module a subcommand may be registered in, and `src/cli.js` is the
composition root that resolves and dispatches it. Registration requires a name of one or two lower-case
words separated by single spaces, a one-line summary and a run function, and it refuses a duplicate
rather than letting it shadow the first registration. Help text, dispatch and the suggestions printed
for an unknown command are all derived from the registry, so a command reached by any other route is
unreachable work.

### Step 2: Map the outcome to 0, 1 or 2

`RS-C09` allows no other exit code: zero on success, one on an operational failure, two on a usage
error. Throwing a `UsageError` exits 2 after printing the message and the full usage to standard error;
any other thrown value exits 1 with a message and never a stack trace; and a returned exit code outside
0, 1 and 2 is refused by name. A repository that failed during `collect` is an operational failure: the
command exits 1, prints a failure line per repository and still leaves a complete run record, so a
scheduler can alert while the successful repositories are already stored.

### Step 3: Resolve by longest prefix and suggest what exists

Resolution takes the longest registered prefix, so `db migrate` beats `db`, and every token after the
name is the command's own argument to parse. An unknown command exits 2 and prints the registered names
that sit under what was typed, or points at the global help when nothing does. That is why a name with
a group and a subcommand must be registered exactly as it is typed.

### Step 4: Print usage where a stranger will actually find it

`--help` and `-h` are global flags, and the entry point parses them only before the command name; a
help flag after the name belongs to the command, and a command that does not parse one refuses it with
exit 2. Usage names the real registered subcommands with their usage shapes, because a stranger reads it
after a typo.

If a command prints a pointer to its own `--help`, then it must parse that flag itself; if it does not,
then the pointer is a dead end that sends the operator to a usage error, and repairing it belongs to that
command's own module rather than to the global flag rules.

### Step 5: Print one fact per line, with no credential material

Each line carries a single fact in the documented shape, such as a per-repository outcome, a dry-run
`planned` in place of the real one, or a run identifier so the run row can be found afterwards. Every
printed line passes through the credential redaction helper, and no line ever carries a token, a
credential file's contents, observation values or row contents where the command's contract forbids it.

### Step 6: Implement only the flags the task names

`--dry-run` plans and prints without any network call, credential read or write: no run row, no
heartbeat, no fact row. `--repo owner/name` restricts work to one repository. `--port 0` binds an
ephemeral port and prints the URL actually listened on, which is what a test needs. A new command that
needs a flag the task did not name is scope creep, and a missing flag is a defect to report rather than
a default to invent.

### Step 7: Prove reachability by spawning

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" node src/cli.js config check; echo "exit=$?"
```

Reachability is proven by spawning the entry point: an import proves the function, and only a spawn
proves the registry entry, the argument parsing, the usage path and the exit code. Assert the exit code
together with the captured output, never one without the other.

### Step 8: Isolate every run

Point `REPO_SIGNAL_HOME` at a temporary directory for the test, assert the home was created at mode
0700, and assert the command wrote nothing outside it. A test that inherits the developer's real home
migrates or overwrites the maintainer's archive.

## Gotchas

- **An import-only test passes while the command is unreachable.** A subcommand that is never registered,
  or registered under the wrong key, still passes a unit test that imports its module directly. Spawn
  for at least one assertion per command.
- **Exit code 1 versus 2 is not cosmetic.** Returning 1 for a mistyped flag makes a daily scheduler treat
  a typo as an outage, and returning 2 for a failed collection makes it ignore a real failure.
- **A global `--help` after the command name is a usage error, not help.** Only a command that parses
  the flag itself honours it, so a printed pointer to `node src/cli.js <command> --help` must match the
  command's own parser or it sends the operator to an exit 2.
- **A dry run that writes is not a plan.** The most frequent dry-run defect is writing a run row or a
  heartbeat while planning; a test that asserts zero writes is what catches it.
- **`discover` must leave the configuration file byte-identical.** Discovery is a read-only convenience,
  so a helper that normalises the configuration while reading it silently rewrites the file. Assert the
  file's content is unchanged after the command runs.
- **`serve` must print the resolved URL, not a configured default.** A printed port the process is not
  listening on is the one lie an operator cannot see through; read the URL the factory returned.
- **`config init` must not clobber an existing file.** Without the force flag it exits non-zero and
  leaves the file unchanged, and both templates are created at mode 0600.
- **A test that shares a real home is order-dependent.** The second suite to run finds a database with
  pending migrations or a lock, and the failure looks like a product bug.
- **A hand-maintained command inventory drifts.** The README's inventory already disagrees with the
  registry about `report`, so an inventory that is edited rather than regenerated will agree with
  nothing.
- **Machine-readable output is a separate mode, not the human table.** Where a command promises a
  structured shape it prints exactly that shape, and the human table is not it.

## Validation

Self-check each item, asserting the exit code and the captured output together:

- [ ] The subcommand is registered in `src/commands/index.js` and reached only through `src/cli.js`.
- [ ] A spawned `node src/cli.js <command>` returns exit 0 on success, 1 on an operational failure and 2
      for an unknown command or a bad flag, each asserted by name.
- [ ] `node src/cli.js --help` and the unknown-command path both name the real registered subcommands
      and their usage shapes.
- [ ] Every printed pointer to a command's own `--help` resolves in that command, and a global `--help`
      after the command name exits 2 with usage on standard error.
- [ ] A returned exit code outside 0, 1 and 2 is refused by name rather than reaching the process.
- [ ] The captured output of a `--dry-run` run contains one planned line per repository and no fact row,
      run row or heartbeat was written.
- [ ] The captured output of every command contains no token-shaped value, and every printed line comes
      from the redaction helper.
- [ ] The test sets `REPO_SIGNAL_HOME` to a temporary directory and asserts nothing was written outside
      it.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default an import-only test does not count as proof of reachability.