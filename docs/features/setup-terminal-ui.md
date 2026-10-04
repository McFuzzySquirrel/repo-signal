# Feature: Setup Terminal UI

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C01 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C07 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C09 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-A11Y-06 | [Vision](../PRD.md#9-accessibility) | participates |
| RS-NF-02 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-TUI-ST-01 | This feature | owns |
| RS-TUI-ST-02 | This feature | owns |
| RS-TUI-C01 | This feature | owns |
| RS-TUI-C02 | This feature | owns |
| RS-TUI-C03 | This feature | owns |
| RS-TUI-FR-01 | This feature | owns |
| RS-TUI-FR-02 | This feature | owns |
| RS-TUI-FR-03 | This feature | owns |
| RS-TUI-FR-04 | This feature | owns |
| RS-TUI-FR-05 | This feature | owns |
| RS-TUI-FR-06 | This feature | owns |
| RS-TUI-FR-07 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Setup Terminal UI
**ID Prefix:** RS-TUI
**Summary:** A `setup` command that configures RepoSignal interactively: a guided first run that
writes the templates, takes the token without echoing it, discovers what the token can reach and
turns a list into a selection, a configuration manager for changing that selection later, and a
short menu that can run a collection, print the report or start the dashboard. Line-oriented prompts
built on `node:readline`, no library, no full-screen mode, and a non-interactive escape hatch that
prints the exact commands instead.
**Dependencies:** Foundation and Runtime, Enrollment and Collection, Collection Supervision and Report
**Priority:** Should
**Status:** Not built. Every requirement in section 3 is executed by a task in section 6.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-TUI-ST-01 | Maintainer installing RepoSignal | one guided flow that takes me from an empty home to a working archive, so that I do not have to learn six commands and two JSON files in the right order | Should |
| RS-TUI-ST-02 | Maintainer three months in | to change what I watch from a menu instead of editing JSON, so that enrolling a new repository is a decision rather than a typo | Should |

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-TUI-FR-01","kind":"requirement","text":"A `setup` command is registered in the command registry and reachable as `node src/cli.js setup`, accepts `--help` to print its own steps and exits 0, accepts `--non-interactive` to print the scriptable equivalent of every step and exit 0 without touching a file, and returns the standard 0, 1 or 2 exit codes. It must appear in the generated command list like every other command."}
```

```forge-requirement
{"id":"RS-TUI-FR-02","kind":"requirement","text":"Reusable line-oriented prompt primitives are provided: a masked secret entry that writes no characters to the terminal, a numbered single choice, a space-toggled multiple selection supporting select-all, select-none and invert, a yes or no confirmation with an explicit default, and a free-text field with validation. Each prompt states its options in plain text, reads from standard input, and returns a typed result or a refusal naming what was expected."}
```

```forge-requirement
{"id":"RS-TUI-FR-03","kind":"requirement","text":"The first-run flow detects an existing home before writing anything, offers to write both templates at mode 0600, asks for the token with the masked field and explains the Administration repository permission in the prompt itself, runs discovery through the existing client, turns the returned repositories into a numbered multiple selection with select-all and none, optionally sets the collection hour, writes the configuration through the existing schema, runs the existing configuration check, and offers a first collection that reports the same lines and summary the command prints."}
```

```forge-requirement
{"id":"RS-TUI-FR-04","kind":"requirement","text":"Re-entering the flow opens a configuration manager that shows the current enrolled set, deny list, collection hour and per-repository flags, and can add or remove an enrollment, toggle a repository off without removing it, add or remove a deny entry, change the collection hour, and refresh the discovery list; every change is written through the existing schema and loader so an invalid configuration is impossible to save."}
```

```forge-requirement
{"id":"RS-TUI-FR-05","kind":"requirement","text":"A run-actions menu can collect now, print the report, print the health summary, and start the dashboard, each by invoking the existing command module rather than reimplementing it, so the request budget, the host allowlist, token redaction, the state words and the exit codes are identical to running the command directly."}
```

```forge-requirement
{"id":"RS-TUI-FR-06","kind":"requirement","text":"The surface is operable without a pointer and without colour, degrades to plain text when NO_COLOR is set or TERM is dumb, prints the same instructions and exits 1 with a next command when standard input is not a terminal, restores the terminal mode and leaves no partially written file when the run is interrupted at any prompt, and its tests drive the real command through standard input."}
```

```forge-requirement
{"id":"RS-TUI-FR-07","kind":"requirement","text":"The README and the scheduled-collection runbook document the command, what it writes, that the token is never echoed, and that `--non-interactive` prints the scriptable equivalent; a contract test asserts the command is registered and named in the documentation, and a human review records the journey."}
```

### Constraints

```forge-requirement
{"id":"RS-TUI-C01","kind":"constraint","text":"The surface is built from node:readline and node:tty with no third-party dependency, no full-screen alternate-screen mode and no cursor addressing, so that it keeps the clone-and-go promise and stays legible to a screen reader."}
```

```forge-requirement
{"id":"RS-TUI-C02","kind":"constraint","text":"The token is entered through the masked field, never echoed, never printed, never written to a log, and stored only by the existing credential writer at mode 0600; no prompt result may ever be passed to an output function."}
```

```forge-requirement
{"id":"RS-TUI-C03","kind":"constraint","text":"The flow reuses the existing home resolution, configuration schema and loader, credential loader and writer, discovery client, collection run, report formatter and health read; it does not reimplement validation, path resolution, transport, redaction or state vocabulary."}
```

```forge-requirement
{"id":"RS-TUI-C04","kind":"constraint","text":"An interrupted run writes nothing partial: each file is written whole through a temporary file and a rename, the credential write uses the existing refusing writer, and an enrolment is either saved in full or not at all."}
```

```forge-requirement
{"id":"RS-TUI-C05","kind":"constraint","text":"Colour carries no meaning: every prompt, state and selection is expressed in words, and a colour is only ever a decoration that disappears under NO_COLOR or a dumb terminal."}
```

---

## 4. Interaction Design

The flow is a sequence of questions, one screen at a time, each written as text and answered on one
line. Nothing is drawn over previous output, so scrolling back is a valid way to read what happened.

**First run**

1. States the resolved home and whether a configuration already exists.
2. Asks whether to write both templates, defaulting to yes when neither file exists.
3. Asks for the token with a masked field, then states in one line which permission it needs and where
   to read it.
4. Runs discovery and prints how many repositories the token can reach, with permission state.
5. Presents them as a numbered list with a space bar toggle, `a` for all, `n` for none and `i` to
   invert, then shows the chosen count and asks for confirmation.
6. Asks for the collection hour, defaulting to the configured value or zero.
7. Runs the configuration check and prints its own two lines.
8. Offers the first collection, and prints whatever the command would print.

**Returning later**

Opens a menu: add or remove an enrollment, toggle one off, edit the deny list, change the collection
hour, refresh discovery, then returns to the menu. Run actions sit behind one more menu: collect now,
report, health, start the dashboard.

Every prompt ends with an escape: `q` cancels the current step and returns to the previous one, and
Ctrl-C at any point ends the run without writing a partial file.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Each prompt's parsing, refusal, masking and cancellation | `tests/tui-prompts.test.js` |
| Unit | First-run steps and their refusals | `tests/tui-setup-wizard.test.js` |
| Unit | Configuration manager edits and saved results | `tests/tui-config-manager.test.js` |
| Unit | Run actions delegating to the command modules | `tests/tui-run-actions.test.js` |
| Unit | Registry entry, help text, non-interactive output | `tests/tui-setup-command.test.js` |
| Unit | Keyboard-only operation, no colour, non-terminal refusal, interruption | `tests/tui-accessibility.test.js` |
| Integration | The real command driven through standard input against the loopback stub | `tests/integration/tui-setup-e2e.test.js` |
| Contract | The command is registered and documented | `tests/contract-setup-command.test.js` |
| Human | The journey as a person experiences it | `docs/reviews/setup-terminal-ui.json` |

Key scenarios: an interrupted token entry leaves the credential file absent; a selection with nothing
chosen is refused rather than saved as an empty enrolment; a repository already denied cannot be
enrolled; a non-terminal standard input exits 1 and names the command to run instead; the flow under
NO_COLOR and TERM=dumb prints no escape sequence; the first collection prints the same summary the
command prints for the same home.

---

## 6. Implementation Tasks

### Phase 1: Prompt primitives

```forge-task
{
  "id": "RS-TUI-01",
  "title": "Build the line-oriented prompt primitives",
  "description": "Create `src/tui/prompts.js` exporting the prompt primitives the flow is built from: a masked secret field that disables terminal echo through node:tty and restores it in a finally block, a numbered single choice, a space-toggled multiple selection that also accepts `a`, `n` and `i` and returns the chosen indices in ascending order, a yes or no confirmation with an explicit default and an empty answer taking that default, and a free-text field with a caller-supplied validator returning either the trimmed value or a refusal naming what was expected. Every prompt must state its options as plain text, accept `q` to cancel, work with colour disabled, and take its input and output streams as parameters so a test can drive it. Do not build a full-screen mode, do not use cursor addressing or an alternate screen, do not add a third-party dependency, and do not prompt for a value the caller will not use.",
  "ownerAgent": "cli-engineer",
  "dependencies": [],
  "expectedOutputs": ["src/tui/prompts.js", "tests/tui-prompts.test.js"],
  "validationCommands": ["npm test -- tests/tui-prompts.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Every prompt states its options in text, reads one line at a time, supports cancellation, and returns a typed result or a named refusal"],
    "requirementRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-FR-02"],
    "acceptanceCriteria": ["A test drives the masked field and asserts the typed characters are absent from everything the prompt writes", "A test asserts a terminal echo failure is cleaned up in a finally block", "A test asserts the multiple selection returns ascending indices and supports all, none and invert", "A test asserts the confirmation default applies to an empty answer and to a q answer", "A test asserts every prompt works with colour disabled and writes no escape sequence", "tests/tui-prompts.test.js reports more than zero executed tests"],
    "constraints": ["Use node:readline and node:tty only; add no dependency and no build step", "Do not use an alternate screen, cursor addressing or mouse reporting", "Restore terminal echo and raw mode on every exit path including interruption"],
    "constraintRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-C01", "docs/features/setup-terminal-ui.md#RS-TUI-C05"],
    "references": ["docs/features/setup-terminal-ui.md#4. Interaction Design", "docs/features/setup-terminal-ui.md#3. Functional Requirements"]
  }
}
```

### Phase 2: First-run flow, configuration manager and run actions

```forge-task
{
  "id": "RS-TUI-03",
  "title": "Build the first-run setup flow",
  "description": "Create `src/tui/setup-wizard.js` implementing the first-run sequence: report the resolved home and whether a configuration exists, offer to write both templates through the existing configuration initialiser, ask for the token through the masked field and name the Administration repository permission in the prompt, run discovery through the existing client and policy, present the returned repositories as a multiple selection, refuse an empty selection, ask for the collection hour, save the configuration through the existing schema and loader, run the existing configuration check, and offer the first collection. Every value the flow collects must reach the product through an existing module; the wizard must not parse JSON, resolve a path, validate a token shape or call GitHub itself. Do not implement the configuration manager, the run actions or the command registration.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["RS-TUI-01"],
  "expectedOutputs": ["src/tui/setup-wizard.js", "tests/tui-setup-wizard.test.js"],
  "validationCommands": ["npm test -- tests/tui-setup-wizard.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["A first run takes an empty home to a saved, checked configuration using only the existing initialiser, schema, loader, credential writer, discovery client and collection run"],
    "requirementRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-FR-03"],
    "acceptanceCriteria": ["A test drives the whole first run with scripted answers and asserts the written configuration parses through the existing loader", "A test asserts an empty selection is refused and nothing is written", "A test asserts the token reaches the credential file at mode 0600 and never appears in any captured output", "A test asserts an existing home is detected before any write and that both templates are preflighted together", "A test asserts the offered first collection produces the same summary line the collect command prints for the same home", "tests/tui-setup-wizard.test.js reports more than zero executed tests"],
    "constraints": ["Reuse the existing modules; do not reimplement validation, path resolution, discovery or collection", "Never print, log or echo the token"],
    "constraintRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-C02", "docs/features/setup-terminal-ui.md#RS-TUI-C03", "docs/PRD.md#RS-C07"],
    "references": ["docs/features/setup-terminal-ui.md#4. Interaction Design", "docs/features/setup-terminal-ui.md#3. Functional Requirements"]
  }
}
```

```forge-task
{
  "id": "RS-TUI-04",
  "title": "Build the configuration manager",
  "description": "Create `src/tui/config-manager.js` implementing the returning-visit menu: show the current enrolled set with each repository's enabled flag, the deny list and the collection hour; add or remove an enrollment from the discovery list, toggle a repository off without removing it, add or remove a deny entry, change the collection hour, and refresh the discovery list. Each edit is applied to the loaded configuration and saved whole through the existing schema and loader, so an invalid configuration cannot be written, and an interrupted run leaves the previous file untouched. Removing a repository that is also denied is impossible because the deny list is shown as part of the edit. Do not implement the first-run flow, the run actions or the command registration.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["RS-TUI-01"],
  "expectedOutputs": ["src/tui/config-manager.js", "tests/tui-config-manager.test.js"],
  "validationCommands": ["npm test -- tests/tui-config-manager.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["A returning visit can change the enrolled set, the deny list, the collection hour and per-repository flags, with every change saved through the existing schema and loader"],
    "requirementRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-FR-04"],
    "acceptanceCriteria": ["A test adds and removes an enrollment and asserts the saved file parses through the existing loader", "A test toggles a repository off and asserts it stays enrolled with its flag false", "A test refuses enrolling a repository the deny list names, in either case", "A test asserts an interrupted edit leaves the previous configuration byte-identical", "tests/tui-config-manager.test.js reports more than zero executed tests"],
    "constraints": ["Never write a configuration that the existing loader would reject", "Do not remove a repository from enrollment when the request was to disable it"],
    "constraintRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-C03", "docs/features/setup-terminal-ui.md#RS-TUI-C04"],
    "references": ["docs/features/setup-terminal-ui.md#4. Interaction Design", "docs/features/setup-terminal-ui.md#3. Functional Requirements"]
  }
}
```

```forge-task
{
  "id": "RS-TUI-05",
  "title": "Build the run-actions menu",
  "description": "Create `src/tui/run-actions.js` offering collect now, print the report, print the health summary and start the dashboard, each by invoking the existing command module through the same context object the CLI builds, so the request budget, the host allowlist, token redaction, state words and exit codes are identical to running the command directly. Starting the dashboard must report the address the server printed and must not block the flow in a way that hides it, and must offer a way back to the menu. A failed action must return to the menu with the command's own message rather than ending the session. Do not reimplement collection, reporting or serving, and do not add a request of any kind.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["RS-TUI-01"],
  "expectedOutputs": ["src/tui/run-actions.js", "tests/tui-run-actions.test.js"],
  "validationCommands": ["npm test -- tests/tui-run-actions.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Each run action delegates to the existing command module, so its requests, state words, redaction and exit code are the command's own"],
    "requirementRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-FR-05"],
    "acceptanceCriteria": ["A test asserts the collect action prints the same summary the collect command prints for the same home", "A test asserts a failing action returns to the menu with the command's own message and does not end the session", "A test asserts starting the dashboard prints the address the server reported", "A test asserts no action performs a request the command it delegates to does not already perform", "tests/tui-run-actions.test.js reports more than zero executed tests"],
    "constraints": ["Do not reimplement collection, reporting or serving", "Do not bypass the credential loader or the transport allowlist"],
    "constraintRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-C03", "docs/PRD.md#RS-C02"],
    "references": ["docs/features/setup-terminal-ui.md#4. Interaction Design", "docs/features/setup-terminal-ui.md#3. Functional Requirements", "docs/PRD.md#7. Non-Functional Requirements"]
  }
}
```

### Phase 3: Registration, mounting and composition root

```forge-task
{
  "id": "RS-TUI-02",
  "title": "Register the setup command and mount the flow in the command registry",
  "description": "Create `src/commands/setup.js` and register it in `src/commands/index.js` as the entry point a user reaches: accept no positional arguments, accept `--help` to print the flow steps and exit 0, accept `--non-interactive` to print the scriptable equivalent of every step and exit 0 without reading or writing any file, and refuse any other argument as a usage error. The command must choose the first-run flow or the configuration manager by looking at the resolved home rather than by a flag, delegate the run actions to the menu, detect a non-terminal standard input and exit 1 naming the command to run instead, and return the standard exit codes. This is the composition root that mounts the flow, so it must be reachable from `node src/cli.js` and appear in the generated command list. Do not change any existing command, flag or exit code, and do not change the global flag rules.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["RS-TUI-03", "RS-TUI-04", "RS-TUI-05"],
  "expectedOutputs": ["src/commands/setup.js", "src/commands/index.js", "tests/tui-setup-command.test.js"],
  "validationCommands": ["npm test -- tests/tui-setup-command.test.js", "npm test -- tests/cli.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["`node src/cli.js setup` is registered, reachable, and its help, non-interactive output, refusals and exit codes follow the command contract"],
    "requirementRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-FR-01"],
    "acceptanceCriteria": ["A test spawns the real CLI and asserts `setup` appears in the generated command list with a summary", "A test spawns the real CLI and asserts `setup --help` prints the flow steps and exits 0", "A test spawns the real CLI and asserts `setup --non-interactive` prints the scriptable equivalent, writes nothing and exits 0", "A test spawns the real CLI with a non-terminal standard input and asserts exit 1 with the command to run named", "A test asserts an unknown argument to setup exits 2 with the usage", "tests/tui-setup-command.test.js and tests/cli.test.js each report more than zero executed tests"],
    "constraints": ["Do not change an existing command, flag, exit code or the global flag rules", "Do not register the command anywhere other than the command registry"],
    "constraintRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-C03", "docs/PRD.md#RS-C09"],
    "references": ["docs/features/setup-terminal-ui.md#4. Interaction Design", "docs/features/setup-terminal-ui.md#3. Functional Requirements"]
  }
}
```

### Phase 4: Terminal accessibility, compatibility and documentation

```forge-task
{
  "id": "RS-TUI-06",
  "title": "Prove the surface is keyboard-only, colour-free, non-terminal safe and interruptible",
  "description": "Create `tests/tui-accessibility.test.js` and `tests/integration/tui-setup-e2e.test.js`. The unit test drives every prompt and the whole first run with standard input only, asserting that each prompt is answerable by typing a line, that `q` cancels a step, that colour disabled and a dumb terminal produce output with no escape sequence, that no step requires a pointer, that a non-terminal standard input exits 1 naming the command to run, and that interrupting at each of the first three steps leaves no partial configuration and no credential file. The integration test spawns the real `node src/cli.js setup` with scripted answers against the loopback GitHub stub and asserts the flow completes, the configuration it wrote loads through the existing loader, and the repository it selected is the one enrolled. Do not change the prompts to pass a test: an interaction that cannot be driven from a pipe is the finding, and must be reported rather than patched.",
  "ownerAgent": "qa-engineer",
  "dependencies": ["RS-TUI-02"],
  "expectedOutputs": ["tests/tui-accessibility.test.js", "tests/integration/tui-setup-e2e.test.js"],
  "validationCommands": ["npm test -- tests/tui-accessibility.test.js", "npm test -- tests/integration/tui-setup-e2e.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Every prompt and the whole flow are answerable from standard input alone, with no pointer, no colour meaning and no partial write on interruption"],
    "requirementRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-FR-06"],
    "acceptanceCriteria": ["A test completes the first run by writing answers to standard input and asserts the saved configuration", "A test runs the flow with NO_COLOR set and TERM=dumb and asserts the output contains no escape sequence", "A test asserts each of the first three steps can be interrupted and leaves no partial file", "A test asserts a non-terminal standard input exits 1 and names the command to run", "tests/tui-accessibility.test.js and tests/integration/tui-setup-e2e.test.js each report more than zero executed tests"],
    "constraints": ["Drive the real command through a pipe; do not import internals to avoid the terminal", "Report an interaction that cannot be driven from a pipe instead of changing it"],
    "constraintRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-C01", "docs/features/setup-terminal-ui.md#RS-TUI-C05"],
    "references": ["docs/features/setup-terminal-ui.md#5. Testing Strategy", "docs/features/setup-terminal-ui.md#3. Functional Requirements", "docs/PRD.md#9. Accessibility"]
  }
}
```

```forge-task
{
  "id": "RS-TUI-07",
  "title": "Document the setup command and assert it is registered and documented",
  "description": "Add the command to the README as the guided alternative to the six-command sequence, stating what it writes, that the token is entered masked and never echoed, that `--non-interactive` prints the scriptable equivalent, and that every existing command still works exactly as documented. Extend the scheduled-collection runbook to say that the flow can set the collection hour but does not install a schedule, and that the operating system still owns the schedule. Create `tests/contract-setup-command.test.js` asserting the command is registered in the registry, named in the README, and that the README still documents the six-command sequence it replaced nothing of. Do not remove or reorder any existing README claim, and do not describe behaviour the command does not have.",
  "ownerAgent": "documentation-engineer",
  "dependencies": ["RS-TUI-02"],
  "expectedOutputs": ["README.md", "docs/operations/scheduled-collection.md", "tests/contract-setup-command.test.js"],
  "validationCommands": ["npm test -- tests/contract-setup-command.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["The command is documented with what it writes, the token handling and the non-interactive escape, and a contract test ties the document to the registry"],
    "requirementRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-FR-07"],
    "acceptanceCriteria": ["The README names the command, the masked token entry and the non-interactive flag", "The scheduled-collection runbook states that the flow sets the hour but installs no schedule", "A test asserts the registered command list and the README agree", "tests/contract-setup-command.test.js reports more than zero executed tests"],
    "constraints": ["Do not remove an existing README or runbook claim a contract test asserts", "Do not claim a behaviour the command does not have"],
    "constraintRefs": ["docs/PRD.md#RS-C12"],
    "references": ["docs/features/setup-terminal-ui.md#4. Interaction Design", "docs/features/setup-terminal-ui.md#3. Functional Requirements"]
  }
}
```

### Phase 5: Human review of the journey

```forge-task
{
  "id": "RS-TUI-REV-01",
  "title": "Human review of the interactive setup journey",
  "description": "A person runs the interactive flow themselves, from an empty temporary home on the same machine a maintainer uses. The reviewer must type a token into the masked field and confirm nothing appeared on screen, select repositories from the discovery list with the keyboard alone, save the configuration, run the offered first collection, change the configuration on a second visit, and start the dashboard from the run menu, recording the address it printed. The reviewer then answers the questions a new user asks: is it clear what will be written, can the whole flow be done without a mouse, is the refusal behaviour obvious, and does anything read as though the product has decided something. The notes must state what was exercised, including which steps were interrupted and what was left behind. No agent authors or approves this review, and a passing test suite is not evidence that the journey works.",
  "dependencies": ["RS-TUI-01", "RS-TUI-02", "RS-TUI-03", "RS-TUI-04", "RS-TUI-05", "RS-TUI-06", "RS-TUI-07"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": ["A named reviewer completed the first-run journey and a returning visit on the running command, and recorded what was exercised and what each refusal looks like"],
    "requirementRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-FR-07"],
    "acceptanceCriteria": ["The reviewer completed the primary user journey against the running command, typing the token, selecting repositories, saving, collecting and starting the dashboard", "The review file states which steps were interrupted and what was left on disk afterwards", "The review file records an answer on keyboard-only operability, the clarity of what will be written, and whether any screen reads as a verdict", "The review notes name the exercise rather than asserting a general impression"],
    "constraints": ["No agent authors or approves this review", "A passing test suite is not evidence that the journey is usable"],
    "constraintRefs": ["docs/features/setup-terminal-ui.md#RS-TUI-C01", "docs/features/setup-terminal-ui.md#RS-TUI-C05"],
    "reviewFile": "docs/reviews/setup-terminal-ui.json",
    "references": ["docs/features/setup-terminal-ui.md#4. Interaction Design", "docs/features/setup-terminal-ui.md#5. Testing Strategy", "docs/features/setup-terminal-ui.md#7. Acceptance Criteria", "docs/PRD.md#9. Accessibility"]
  }
}
```

---

## 7. Acceptance Criteria

1. `node src/cli.js setup` appears in the generated command list and runs the flow.
2. The first run takes an empty home to a saved, checked configuration without the user editing JSON.
3. The token is entered masked, is never echoed or printed, and is stored only at mode 0600.
4. Returning later can change the enrolled set, the deny list, the collection hour and per-repository
   flags, and every saved configuration loads through the existing loader.
5. Run actions produce exactly what the commands they delegate to produce.
6. The whole flow works from a pipe, without a pointer, without colour meaning, and leaves nothing
   partial when interrupted.
7. `--non-interactive` prints the scriptable equivalent and writes nothing.
8. A human has completed the journey and recorded what they exercised.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the flow be able to write an initial schedule for cron, launchd or systemd | No: the collector embeds no timer and the operating system owns the schedule |
| 2 | Should the dashboard be started in the foreground or as a child process | Keep it in-process and reversible, and print the address before anything can block it |
| 3 | Should enrolment accept a pasted list of repositories | Not yet; the multi-selection covers the case and a paste path would need its own validation |
| 4 | Should the flow warn when the token can reach far more repositories than are enrolled | Yes, as one line in the discovery step, because a broad token is the documented posture |