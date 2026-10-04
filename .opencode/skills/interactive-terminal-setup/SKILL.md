---
name: interactive-terminal-setup
description: "Building RepoSignal's interactive setup surface from node:readline and node:tty with no dependency: a masked secret field that restores the terminal in a finally block, numbered single choice, space-toggled multiple selection with all/none/invert, a confirmation with an explicit default, streams passed as parameters so tests drive them, a --non-interactive escape hatch that prints the scriptable equivalent, and no partial file left by an interruption at any prompt. Use when creating or changing anything under src/tui/, the setup command, or the tests that drive the flow from a pipe."
---

# Skill: Interactive Terminal Setup

The setup surface is the only unbuilt feature and the largest task cluster in the plan, at eight task
blocks: seven implementation tasks and one human review. Every one of them rests on rules that are easy
to satisfy wrongly in ways nothing else in the product exposes, because a terminal is the one surface
where a mistake is invisible in a passing run.

Load [prompt-and-flow-shapes.md](./references/prompt-and-flow-shapes.md) when adding a prompt, a flow
step or a refusal, and when deciding what a test has to drive from standard input rather than from an
import.

## Process

### Step 1: Build the primitives from the standard library only

`RS-TUI-C01` allows `node:readline` and `node:tty` and nothing else: no third-party dependency, no
full-screen alternate-screen mode, and no cursor addressing. That is what keeps the clone-and-go
promise and keeps the output legible to a screen reader. Anything drawn over previous output would also
make scrolling back an invalid way to read what happened, so each prompt writes a line and waits.

Every prompt states its options as plain text, reads one line at a time, accepts `q` to cancel the
current step, works with colour disabled, and takes its input and output streams as parameters so a
test can drive it without a terminal. A prompt that reads the global process streams is a prompt that
cannot be tested.

### Step 2: Make the masked field the only path for the token

The token is entered through the masked field, which disables terminal echo through `node:tty` and
restores it in a `finally` block, because a throw between disabling and restoring leaves the terminal
without echo and the token visible to everything typed afterwards. `RS-TUI-C02` is stricter still: no
prompt result may ever be passed to an output function, the value is never echoed, printed or logged, and
it reaches storage only through the existing credential writer at mode 0600.

The prompt itself states which permission the token needs and where to read about it, so the operator is
not asked for a token that will then be refused for a missing permission.

### Step 3: Reuse the existing modules for everything else

`RS-TUI-C03` is the constraint that keeps this surface honest: the flow reuses the existing home
resolution, configuration schema and loader, credential loader and writer, discovery client, collection
run, report formatter and health read. It does not reimplement validation, path resolution, transport,
redaction or the state vocabulary. If the flow parses JSON, resolves a path, validates a token shape or
calls GitHub itself, then it has created a second source of truth for a rule that already has one.

### Step 4: Make every write atomic

`RS-TUI-C04` requires an interrupted run to leave nothing partial: each file is written whole through a
temporary file and a rename, the credential write goes through the existing refusing writer, and an
enrolment is saved in full or not at all. An edit in the configuration manager is applied to the loaded
configuration and saved whole, so a configuration the existing loader would reject can never be written,
and an interruption leaves the previous file byte-identical.

### Step 5: Refuse the states that are not successes

A selection with nothing chosen is refused rather than saved as an empty enrolment. A repository the
deny list names cannot be enrolled, in either case. Toggling a repository off keeps it enrolled with its
flag false, because disabling and removing are different requests. `q` cancels the current step and
returns to the previous one rather than ending the run.

### Step 6: Degrade to text and refuse a pipe-less terminal

`RS-TUI-C05` makes colour decorative: every prompt, state and selection is expressed in words, and a
colour disappears entirely under `NO_COLOR` or a dumb terminal. When standard input is not a terminal,
the command prints the same instructions and exits 1 naming the command to run instead, rather than
hanging on a read that will never answer.

### Step 7: Provide the scriptable escape hatch

`--non-interactive` prints the scriptable equivalent of every step and exits 0 without touching a file,
and the command's own `--help` prints its steps and exits 0. Both exist so an operator who cannot answer
a prompt - in a script, a container, a pipe - has a documented path rather than a hang. The command is
registered in the one registry like every other command, so it appears in the generated list and takes
the standard exit codes.

### Step 8: Prove it from standard input, not from an import

```bash
REPO_SIGNAL_HOME="$(mktemp -d)" npm test -- tests/tui-accessibility.test.js
```

Drive the real command through a pipe with scripted answers. If an interaction cannot be driven from a pipe, then that is the finding to report, and the prompt is left alone; reshaping a prompt to suit the test destroys the only evidence that a person can use it.

## Gotchas

- **A masked field that leaks on an echo-restore failure.** Disabling echo and restoring it are two
  separate operations and an interruption can happen between them, so the restore belongs in a `finally`
  block and a test has to assert the field leaves the terminal able to echo.
- **A prompt whose state is visible only in colour.** Under `NO_COLOR` or a dumb terminal the selection
  becomes unreadable and the operator has no way to know what is chosen. Every state is a word.
- **An answer that can arrive on the wrong line.** Reading a whole piped input as one value, or treating a
  blank line as a submission rather than as taking a default, silently reorders a scripted run.
- **A partial file is written on interruption.** Writing straight to the destination leaves a truncated
  credential or configuration behind. Write through a temporary file and rename, and assert the
  interruption cases rather than reasoning about them.
- **An empty selection saved as an empty enrolment.** The product then reports every repository as
  never collected with no explanation, so refuse the selection instead.
- **Removing a repository that was only meant to be disabled.** Enrolment is the set the maintainer chose;
  a disabled flag keeps it in the set and out of the runs.
- **A colour escape sequence under a dumb terminal.** A colour that is emitted anyway and merely ignored
  by some terminals still breaks capture-based assertions and still renders as noise in a log.
- **A run action that reimplements a command.** Delegating to the existing command module is what keeps the
  request budget, the host allowlist, redaction, the state words and the exit codes identical; a copy of
  the logic is where they diverge.
- **A starting dashboard that blocks the flow.** The address the server printed must be visible before
  anything can block, and there has to be a way back to the menu.
- **A failing action that ends the session.** A failed action returns to the menu with the command's own
  message, so one repository's refusal does not strand the operator.
- **A passing test suite used as evidence the journey works.** The human review exists because a green
  suite cannot show that the flow is usable; no agent authors or approves that review.

## Validation

Self-check each item, driving the real command through a pipe:

- [ ] A test completes the whole first run by writing answers to standard input and asserts the saved
      configuration parses through the existing loader.
- [ ] A test asserts the token reaches the credential file at mode 0600 and appears in no captured
      output, and that the masked field leaves the terminal able to echo after both success and failure.
- [ ] A test asserts an empty selection is refused and nothing is written.
- [ ] A test asserts a repository the deny list names cannot be enrolled in either case, and that
      toggling one off keeps it enrolled with its flag false.
- [ ] A test asserts each of the first three steps can be interrupted and leaves no partial
      configuration and no credential file.
- [ ] A test asserts an interrupted edit leaves the previous configuration byte-identical.
- [ ] A test asserts `NO_COLOR` set and a dumb terminal produce output containing no escape sequence.
- [ ] A test asserts a non-terminal standard input exits 1 and names the command to run instead.
- [ ] A test asserts `--non-interactive` prints the scriptable equivalent of every step and writes
      nothing, and that `--help` prints the command's own steps and exits 0.
- [ ] A test asserts each run action produces exactly what the command it delegates to produces, and that
      a failing action returns to the menu with the command's own message.
- [ ] `npm test -- <named test file>` selects a non-zero number of tests through
      `scripts/run-tests.mjs`; by default an assertion made with an imported module rather than a spawned
      process does not count as proof that the surface is drivable.