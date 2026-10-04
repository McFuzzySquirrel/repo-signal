# Feature: Foundation and Runtime

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C01 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C08 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C09 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-FND-ST-01 | This feature | owns |
| RS-FND-C01 | This feature | owns |
| RS-FND-C02 | This feature | owns |
| RS-FND-C03 | This feature | owns |
| RS-FND-C04 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Foundation and Runtime
**ID Prefix:** RS-FND
**Summary:** Everything that exists before any GitHub call: the command registry that generates
`--help` and dispatch, the three exit codes, the single place the home and its three files are
resolved, the closed configuration schema and its comment-tolerant loader, the credential file
loader that refuses any mode but 0600, token redaction, and the pure enrollment resolution.
**Dependencies:** None
**Priority:** Must
**As-built status:** Built. `tests/cli.test.js`, `tests/paths.test.js`, `tests/config.test.js`,
`tests/config-command.test.js`, `tests/credentials.test.js` and `tests/enrollment.test.js` cover the
behaviour below; two documentation defects found while authoring this document are the only
outstanding work, recorded in section 8.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-FND-ST-01 | Maintainer | I want every command and every documented flag to exist in one registry, so that the help text cannot describe something the build does not register | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-FND-C01","kind":"constraint","text":"The command registry accepts a command name of one or two lower-case words, requires a summary and a run function, and refuses a duplicate name rather than letting it shadow the first registration; help text, dispatch and suggestions are all derived from the registry."}
```

```forge-requirement
{"id":"RS-FND-C02","kind":"constraint","text":"Command resolution takes the longest registered prefix, a usage error exits 2 after printing the message and the full usage to stderr, an operational failure exits 1 with a message and never a stack trace, and a returned exit code outside 0, 1 and 2 is refused by name."}
```

```forge-requirement
{"id":"RS-FND-C03","kind":"constraint","text":"config.json is validated as a closed schema of enrolled, denyList, collectionHourUtc and enabled: any other key is refused, enrolled is required, collectionHourUtc is an integer 0 to 23 defaulting to 0, and whole-line // comments are stripped before parsing while an inline comment or a trailing comma stays an error."}
```

```forge-requirement
{"id":"RS-FND-C04","kind":"constraint","text":"credentials.json is opened once and its mode is checked on that same descriptor before the body is read; the mode must be exactly 0600, the token is returned through a frozen closure rather than an enumerable property, and the loader neither repairs the mode nor falls back to an environment variable."}
```

---

## 4. Command and Output Design

| Command | Flags | Success exit | Notes |
|---------|-------|--------------|-------|
| `config init` | `--force` | 0 | Preflights both templates with a stat before writing either, refuses a non-regular file even with `--force`, and writes through `O_NOFOLLOW` at mode 0600 |
| `config check` | none | 0 or 1 | Prints `configuration ok:`/`failed:`, `credentials ok:`/`failed:`, then `config check: ok|failed`. Contacts nothing |
| `discover` | `--json`, `--include-organizations` | 0 or 1 | Paginates on `Link rel="next"`, applies the deny list case-insensitively, and prints a configuration block proven loadable by the config parser before printing it |
| `report` | `--repo`, `--from`, `--to` | 0 or 1 | Refuses a repeated flag, a value beginning with `--`, a non-calendar day, an inverted range, and a repository outside the enrolled set before the archive is opened |
| `serve` | `--port` | 0 or 1 | Only port 0 is honoured; any other value is refused by name. `--help` after the command name prints the command's own help |

Global `--help` is recognised only before the first non-flag token, so `config init --force` still
reaches `config init`. The home resolution order is `REPO_SIGNAL_HOME`, then
`XDG_DATA_HOME/repo-signal`, then `~/.local/share/repo-signal`, treating a blank value as unset and
returning absolute normalised paths. Each refusal carries a stable code: unresolvable, inside a git
work tree, not a directory, unwritable, unreadable, or an unexpected mode, with the observed mode
named in 3-digit octal.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Registry, dispatch, help text, paths, config, credentials, redaction, enrollment | Existing `tests/cli.test.js`, `tests/paths.test.js`, `tests/config.test.js`, `tests/credentials.test.js`, `tests/enrollment.test.js` |
| Command | `config init`, `config check` | Existing `tests/config-command.test.js`, including the refusal of a pre-existing or non-regular template |
| Contract | The README's command inventory against the registry | Extended by task RS-FND-CONTRACT-02 |
| Integration | None | The foundation performs no GitHub call, so nothing here needs a stub |

Key scenarios: a name that would shadow an existing command is refused at registration; a global flag
placed after a subcommand is a usage error rather than a silently ignored flag; a credential file at
0644 is refused with the observed mode named; a deny-list entry wins over enrollment in either
declaration order; case-only duplicates collapse to the first declared form.

---

## 6. Implementation Tasks

Two documentation defects were found while authoring this document. They are the only outstanding
work in this feature, and both are bounded and independently verifiable.

### Phase 1: Contract reconciliation

```forge-task
{
  "id": "RS-FND-CONTRACT-01",
  "title": "Point every usage-error message at a help flag the command actually accepts",
  "description": "Repair the usage-error pointer in `src/commands/discover.js` and `src/commands/report.js`. Both messages currently tell the user to run the command with `--help`, but only `serve` accepts a flag after its name; `discover` and `report` reject `--help` as an unknown flag because the CLI treats flags before the first non-flag token as global only. Replace the pointer with text that names the registry help, `node src/cli.js --help`, and add tests asserting the refusal path for `discover --help` and `report --help` still exits 2 with the corrected wording. Do not change global flag parsing, do not make either command accept a post-name `--help`, and leave every other message alone.",
  "ownerAgent": "cli-engineer",
  "dependencies": [],
  "expectedOutputs": ["src/commands/discover.js", "src/commands/report.js", "tests/discover-command.test.js", "tests/report-command.test.js"],
  "validationCommands": ["npm test -- tests/discover-command.test.js tests/report-command.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert the usage-error text of discover and report names a help path that works, and that neither command gains a post-name --help flag as a side effect"],
    "requirementRefs": [],
    "acceptanceCriteria": ["A test drives `discover --help` and asserts exit code 2 and a message naming node src/cli.js --help", "A test drives `report --help` and asserts the same corrected wording", "tests/discover-command.test.js and tests/report-command.test.js each report more than zero executed tests"],
    "constraints": ["Do not alter global flag parsing in src/cli.js", "Do not add a post-name --help handler to either command"],
    "constraintRefs": ["docs/features/foundation-and-runtime.md#RS-FND-C02", "docs/features/foundation-and-runtime.md#RS-FND-C01", "docs/PRD.md#RS-C09"],
    "references": ["docs/features/foundation-and-runtime.md#4. Command and Output Design", "docs/PRD.md#6.4 Shared Constraints"]
  }
}
```

```forge-task
{
  "id": "RS-FND-CONTRACT-02",
  "title": "Make the README's command inventory agree with the registry",
  "description": "The README's table of runtime and setup commands omits `report`, which its own install sequence and every runbook use, and the surrounding prose still frames the product as having exactly two runtime commands. Rewrite that section so every command the registry registers is listed exactly once with its role, state how many are runtime commands, and keep the registry as the stated authority. Extend `tests/release-contract.test.js` to parse `node src/cli.js --help`, compare the registered names against the README, and fail when a registered command is missing from the document or a documented command is not registered. Do not add, remove or rename a command.",
  "ownerAgent": "documentation-engineer",
  "dependencies": ["RS-FND-CONTRACT-01"],
  "expectedOutputs": ["README.md", "tests/release-contract.test.js"],
  "validationCommands": ["npm test -- tests/release-contract.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert every command registered by src/commands/index.js is named in the README exactly once and that no README command is unregistered"],
    "requirementRefs": [],
    "acceptanceCriteria": ["The README names all eleven registered commands, including report, and states their role", "A release-contract test derives the command list from the registry rather than repeating it by hand", "tests/release-contract.test.js reports more than zero executed tests"],
    "constraints": ["Do not change any command's behaviour, flags or exit codes", "Do not remove an existing README claim that a contract test asserts"],
    "constraintRefs": ["docs/features/foundation-and-runtime.md#RS-FND-C01", "docs/PRD.md#RS-C12"],
    "references": ["docs/features/foundation-and-runtime.md#4. Command and Output Design", "docs/features/foundation-and-runtime.md#6. Implementation Tasks"]
  }
}
```

---

## 7. Acceptance Criteria

1. `node src/cli.js --help` lists exactly the commands the registry holds, generated from the registry.
2. No command can exit with a code other than 0, 1 or 2, and no failure prints a stack trace.
3. The home resolves to one absolute path with a stable refusal code per failure, and the credential
   file is read only at exactly mode 0600 from the same descriptor that was checked.
4. The token never appears in output, an error, a configuration message or a process-visible property.
5. The documented command inventory matches the registry, and a test fails when it stops matching.
6. Both defect tasks above are complete and their named test files execute.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the framework recognise `--help` after any command name instead of only `serve`? | No: the registry stays the authority and each message points at the help that exists today |
| 2 | Should `config check` contact GitHub to prove the token works? | No: local validation is not authentication, and the message already says so |
| 3 | The credential mode check is skipped on `win32`; should the product refuse to run there outright? | Keep the skip; the home inventory and mode rules are stated as POSIX behaviour |