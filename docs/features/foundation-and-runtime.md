# Feature: Foundation and Runtime

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-03 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SC-02 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SP-03 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-FND-FR-01 | This feature | owns |
| RS-FND-FR-02 | This feature | owns |
| RS-FND-FR-03 | This feature | owns |
| RS-FND-FR-04 | This feature | owns |
| RS-FND-FR-05 | This feature | owns |
| RS-FND-FR-06 | This feature | owns |
| RS-FND-CON-01 | This feature | owns |
| RS-FND-ST-01 | This feature | owns |
| RS-FND-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Foundation and Runtime
**ID Prefix:** RS-FND
**Summary:** The runnable, dependency-free package skeleton every other feature builds on: home
directory resolution, the configuration file, the credential file, the command dispatch surface,
and a test wrapper that fails when a named test file selected nothing.
**Dependencies:** None
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-FND-ST-01","kind":"story","text":"As a solo maintainer I want to run repo-signal with no installation ceremony, so that building the archive is a couple of commands rather than a deployment project."}
```

```forge-requirement
{"id":"RS-FND-ST-02","kind":"story","text":"As a solo maintainer I want a refusal to name its cause, so that a missing permission or an unwritable path is never a puzzle."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-FND-FR-01","kind":"requirement","text":"Resolve one home directory from `REPO_SIGNAL_HOME`, then `XDG_DATA_HOME/repo-signal`, then `~/.local/share/repo-signal`; create it with mode 0700 and expose the configuration, credential and database paths derived from it. Refuse to start when the resolved directory is itself a git repository root."}
```

```forge-requirement
{"id":"RS-FND-FR-02","kind":"requirement","text":"Load and validate a JSON configuration file with a closed schema: an enrolled repository list of `owner/name` entries, an optional deny list of `owner/name` entries, an optional daily collection hour in UTC, and an optional per-repository enabled flag. Reject unknown keys, malformed JSON, and any entry that is not a single `owner/name` pair, naming the offending key in the message."}
```

```forge-requirement
{"id":"RS-FND-FR-03","kind":"requirement","text":"Load the access token from a `credentials.json` file that must have mode 0600 on POSIX systems; refuse to read a credential file that is group- or world-accessible, and expose the token only through a getter that never appears in logs, errors, or rendered pages."}
```

```forge-requirement
{"id":"RS-FND-FR-04","kind":"requirement","text":"Provide one command dispatch surface at `src/cli.js` that parses global flags, resolves a subcommand from a registry in `src/commands/index.js`, prints usage for `--help` and an unknown command, and maps failures to documented exit codes: 0 success, 1 operational failure, 2 usage error."}
```

```forge-requirement
{"id":"RS-FND-FR-05","kind":"requirement","text":"Provide `repo-signal config init` to write a commented configuration template and a credential template with mode 0600, and `repo-signal config check` to validate an existing configuration and credential without printing the token value."}
```

```forge-requirement
{"id":"RS-FND-FR-06","kind":"requirement","text":"Provide `scripts/run-tests.mjs` as the repository test entry point: it runs the Node test runner over the given paths, then fails the command when zero tests were selected or when any test failed, so a task's named validation command cannot pass by discovering nothing."}
```

```forge-requirement
{"id":"RS-FND-CON-01","kind":"constraint","text":"No third-party module is imported at runtime by any file in `src/`; the only imports are `node:` builtins and relative paths."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-FND-ST-01 | story | Must |
| RS-FND-ST-02 | story | Must |
| RS-FND-FR-01 | requirement | Must |
| RS-FND-FR-02 | requirement | Must |
| RS-FND-FR-03 | requirement | Must |
| RS-FND-FR-04 | requirement | Must |
| RS-FND-FR-05 | requirement | Must |
| RS-FND-FR-06 | requirement | Must |
| RS-FND-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

This feature has no browser surface. It defines the two surfaces everything else inherits:
the terminal contract (usage text, exit codes, single-line progress and error lines) and the
path contract other features resolve through. `config check` prints one line per check and a
final `ok` or the first failure, so it can be read in a cron log.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|----------|-------|------------------------|-------------------|---------|------------|
| RS-FND-01 | A cloneable package runs, type-checks and fails on empty test selection | platform-engineer | Node 24 LTS | package.json, tsconfig.json, .gitignore, package-lock.json, scripts/run-tests.mjs, scripts/fixtures/empty-suite/sample.js, scripts/fixtures/passing-suite/passing.test.js, tests/run-tests.test.js | type check clean; wrapper exits non-zero on an empty suite and zero on a passing one | Any feature module, any command |
| RS-FND-02 | Home and child paths resolve deterministically with 0700 and a git-root refusal | platform-engineer | RS-FND-01 | src/paths.js, tests/paths.test.js | path matrix covered by named tests | Configuration schema, credential content |
| RS-FND-03 | The CLI dispatches registered commands, prints usage, and returns 0/1/2 | platform-engineer | RS-FND-01 | src/cli.js, src/commands/index.js, tests/cli.test.js | unknown command yields 2 and usage; registered stub yields 0 | Real commands, argument semantics |
| RS-FND-04 | Configuration parses under a closed schema with actionable errors | platform-engineer | RS-FND-02 | src/config/schema.js, src/config/load.js, tests/config.test.js | unknown key, bad JSON and bad entry each fail with the key named | Credential loading, enrollment precedence |
| RS-FND-05 | A 0600 credential file yields a token; a permissive one is refused | platform-engineer | RS-FND-02 | src/credentials/store.js, src/credentials/redact.js, tests/credentials.test.js | 0644 and 0666 are both refused; redaction removes token-shaped values | Token acquisition, HTTP use |
| RS-FND-06 | `config init` and `config check` are reachable from the CLI | platform-engineer | RS-FND-03, RS-FND-04, RS-FND-05 | src/commands/config.js, src/commands/index.js, tests/config-command.test.js | both subcommands run through `node src/cli.js`; check never prints the token | Backfill, collection, serving |
| RS-FND-REV-01 | A human signs off on the security and privacy posture | human reviewer | RS-FND-01 through RS-FND-06 | docs/reviews/foundation-security.json | explicit checks recorded in the review file | Code changes, rubric scoring by agents |

---

## 6. Implementation Tasks

### Phase 1: Package, paths and dispatch

```forge-task
{
  "id": "RS-FND-01",
  "title": "Create the runnable package, type-check config and fail-on-empty test wrapper",
  "description": "Create the repository skeleton that every other feature depends on: an ESM package named repo-signal with no runtime dependencies, a checkJs tsconfig with noEmit, a .gitignore, and scripts/run-tests.mjs. The wrapper runs the Node test runner over the paths it is given and then fails when the selected count is zero or any test failed, so a later task's named command cannot pass by discovering nothing. Include two committed fixtures (a directory with a non-test module and a directory with one passing test) and a test that proves both exit codes. Run `npm install` once to fetch the two development dependencies before type checking. Do not create any feature module or subcommand.",
  "ownerAgent": "platform-engineer",
  "dependencies": [],
  "expectedOutputs": ["package.json", "tsconfig.json", ".gitignore", "package-lock.json", "scripts/run-tests.mjs", "scripts/fixtures/empty-suite/sample.js", "scripts/fixtures/passing-suite/passing.test.js", "tests/run-tests.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/run-tests.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/foundation-and-runtime.md#RS-FND-FR-06"],
    "acceptanceCriteria": ["npm run typecheck exits zero over src, scripts and tests", "npm test -- tests/run-tests.test.js exits non-zero when pointed at a suite with no test files and exits zero for the passing fixture", "package.json declares type module, an engines range starting at node 24.12.0 (the release exposing `node:sqlite`'s `enableDefensive`, which the storage layer requires), and no dependencies entry"],
    "constraints": ["No third-party module may be imported at runtime by src, scripts or tests", "Do not add a bundler, a transpile step, or a test framework dependency"],
    "constraintRefs": ["docs/features/foundation-and-runtime.md#RS-FND-CON-01", "docs/PRD.md#RS-TC-01", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#6.1 Technology Stack", "docs/PRD.md#6.2 Project Structure"]
  }
}
```

```forge-task
{
  "id": "RS-FND-02",
  "title": "Resolve the home directory and the paths derived from it",
  "description": "Implement src/paths.js as the single source of truth for where state lives. Resolve REPO_SIGNAL_HOME first, then XDG_DATA_HOME/repo-signal, then ~/.local/share/repo-signal; create the directory with mode 0700 when missing; expose configPath, credentialsPath and databasePath. Refuse to continue when the resolved directory contains a .git entry, because state must never land in a work tree. Purely a path and permission concern: no configuration parsing, no credential content, no database access.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-FND-01"],
  "expectedOutputs": ["src/paths.js", "tests/paths.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/paths.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/foundation-and-runtime.md#RS-FND-FR-01", "docs/PRD.md#RS-SP-03"],
    "acceptanceCriteria": ["Each of the three resolution inputs is covered by a named test, including REPO_SIGNAL_HOME winning over XDG_DATA_HOME", "A created home directory is asserted to be mode 0700 by the test", "A home directory containing a .git entry is refused with a message naming the resolved path", "Paths are absolute and normalized even when the environment supplies a relative value"],
    "constraints": ["Do not read or write configuration or credential content in this task"],
    "constraintRefs": ["docs/features/foundation-and-runtime.md#RS-FND-CON-01", "docs/PRD.md#RS-TC-03"],
    "references": ["docs/PRD.md#6.2 Project Structure"]
  }
}
```

```forge-task
{
  "id": "RS-FND-03",
  "title": "Build the CLI composition root and command registry",
  "description": "Implement src/cli.js as the composition root every subcommand is reached through, with the dispatch table in src/commands/index.js. Parse global flags, resolve a subcommand, print usage for --help and for an unknown command, and map outcomes to exit codes 0 success, 1 operational failure, 2 usage error. The registry starts with no real commands; later features append to it. Prove reachability in the test by registering a stub command and invoking it through the process entry point rather than by importing the module.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-FND-01"],
  "expectedOutputs": ["src/cli.js", "src/commands/index.js", "tests/cli.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/cli.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/foundation-and-runtime.md#RS-FND-FR-04"],
    "acceptanceCriteria": ["tests/cli.test.js spawns `node src/cli.js` and asserts exit code 2 with usage for an unknown command", "A registered stub subcommand is reachable through `node src/cli.js` and returns exit code 0", "Exit code 1 is produced when a command reports an operational failure", "src/commands/index.js is the only module a subcommand must be registered in"],
    "constraints": ["Do not add a real subcommand in this task"],
    "constraintRefs": ["docs/features/foundation-and-runtime.md#RS-FND-CON-01"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces"]
  }
}
```

### Phase 2: Configuration and credential boundary

```forge-task
{
  "id": "RS-FND-04",
  "title": "Parse and validate the configuration file under a closed schema",
  "description": "Implement src/config/schema.js and src/config/load.js so that a malformed configuration is refused with a message naming the offending key. The accepted shape is a closed object: an enrolled repository list of owner/name strings, an optional deny list of owner/name strings, an optional collection hour in UTC, and an optional per-repository enabled flag. Unknown keys, malformed JSON, a missing owner separator, whitespace inside a name, and an out-of-range hour are all errors. Enrollment precedence, which belongs to a later feature, is out of scope here.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-FND-02"],
  "expectedOutputs": ["src/config/schema.js", "src/config/load.js", "tests/config.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/config.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/foundation-and-runtime.md#RS-FND-FR-02"],
    "acceptanceCriteria": ["One named test per rejection case: unknown top-level key, malformed JSON, entry without a slash, entry with surrounding whitespace, hour outside 0-23", "A minimal valid configuration parses to a normalized object with absolute default values for omitted optional fields", "A missing configuration file produces a dedicated error kind rather than a generic parse failure"],
    "constraints": ["Do not implement deny-list precedence or repository discovery in this task"],
    "constraintRefs": ["docs/features/foundation-and-runtime.md#RS-FND-CON-01"],
    "references": ["docs/PRD.md#6.2 Project Structure"]
  }
}
```

```forge-task
{
  "id": "RS-FND-05",
  "title": "Load the credential file with a 0600 check and redact token-shaped values",
  "description": "Implement src/credentials/store.js and src/credentials/redact.js. Reading the credential file on a POSIX system must fail unless its mode is exactly 0600; modes 0644 and 0666 are the tested rejections. Expose the token only through a getter that returns it to the HTTP transport and satisfies the credential provider interface in src/github/credential-provider.js, and implement redaction that strips token-shaped values from any message before it is logged or printed. The store holds no knowledge of GitHub and performs no network call.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-FND-02"],
  "expectedOutputs": ["src/credentials/store.js", "src/credentials/redact.js", "tests/credentials.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/credentials.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/foundation-and-runtime.md#RS-FND-FR-03"],
    "acceptanceCriteria": ["A credential file written with mode 0644 and one written with mode 0666 are both refused with a message naming the observed mode", "A 0600 credential file yields its token through the getter", "A test asserts a token-shaped string is absent from the redacted output of an error message", "An empty or missing token value produces a distinct configuration error, not a silent undefined"],
    "constraints": ["Do not send the token anywhere and do not import the HTTP transport in this task"],
    "constraintRefs": ["docs/features/foundation-and-runtime.md#RS-FND-CON-01", "docs/PRD.md#RS-SC-02", "docs/PRD.md#RS-SC-04"],
    "references": ["docs/PRD.md#8. Security and Privacy"]
  }
}
```

```forge-task
{
  "id": "RS-FND-06",
  "title": "Expose the config init and config check subcommands",
  "description": "Add src/commands/config.js, which resolves its files through src/paths.js and validates through src/config/load.js and src/credentials/store.js, and register it in src/commands/index.js so `config init` and `config check` are reachable from the composition root. config init writes a configuration template and a credential template, both with mode 0600, and never overwrites an existing file without an explicit force flag. config check validates the configuration and the credential file and prints one line per check plus a final verdict, and must never print the token value. The test drives both subcommands by spawning the process entry point.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-FND-03", "RS-FND-04", "RS-FND-05"],
  "expectedOutputs": ["src/commands/config.js", "src/commands/index.js", "tests/config-command.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/config-command.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/foundation-and-runtime.md#RS-FND-FR-05", "docs/features/foundation-and-runtime.md#RS-FND-FR-04"],
    "acceptanceCriteria": ["tests/config-command.test.js runs `node src/cli.js config init` then `node src/cli.js config check` against a temporary home and asserts exit code 0", "The captured stdout of config check contains no token-shaped value even when a valid token is configured", "config init on an existing file without --force exits non-zero and leaves the file unchanged", "Both templates are created with mode 0600"],
    "constraints": ["Do not add backfill, collection, or serve behaviour to the registry in this task"],
    "constraintRefs": ["docs/features/foundation-and-runtime.md#RS-FND-CON-01", "docs/PRD.md#RS-SC-02"],
    "references": ["docs/PRD.md#7.4 Shared Definition Index"]
  }
}
```

### Phase 3: Security sign-off

```forge-task
{
  "id": "RS-FND-REV-01",
  "title": "Human review of the foundation security and privacy posture",
  "description": "Review the foundation on a throwaway home directory after `npm install`. Record the rubric scores, the checks actually run, and any accepted exception in docs/reviews/foundation-security.json. Confirm by inspection that the only outbound host any file can reach is api.github.com, that no telemetry, analytics, update check or remote asset exists, that the credential file is required to be 0600 and its value is absent from stdout, stderr and error messages, and that the home directory refusal prevents state landing in a work tree. Report upstream validation gaps rather than assuming the automated tests covered them.",
  "dependencies": ["RS-FND-01", "RS-FND-02", "RS-FND-03", "RS-FND-04", "RS-FND-05", "RS-FND-06"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/PRD.md#RS-SP-04", "docs/PRD.md#RS-SP-05"],
    "acceptanceCriteria": ["The review file records a rubric score and a written verdict per security and privacy rule RS-SP-03, RS-SP-04, RS-SP-05 and RS-SP-06", "The reviewer states which commands were run and what output was observed", "The reviewer confirms by search that no module outside src/ and tests/ can perform an outbound request", "Any rule that cannot be verified is recorded as unverified rather than passed"],
    "constraints": ["Agents must not create or modify this review file, and no task may claim this review is done"],
    "constraintRefs": ["docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-SC-02", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#8. Security and Privacy", "docs/features/foundation-and-runtime.md#RS-FND-ST-02"],
    "reviewFile": "docs/reviews/foundation-security.json"
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Path resolution, configuration validation, credential permissions, redaction | `node --test` over one file per module through the repository wrapper |
| Entry point | Command dispatch, usage text, exit codes, `config` subcommands | Spawn `node src/cli.js` in a temporary home and assert exit code and stdout |
| Human | Security and privacy posture | Rubric review recorded in `docs/reviews/foundation-security.json` |

Key test scenarios:

1. Three competing home-directory inputs resolve in the documented order and the winner wins.
2. A home directory that is a git repository root is refused by name.
3. Unknown configuration keys, malformed JSON and unslashed repository entries each fail with the offending key in the message.
4. Credential files at 0600, 0644 and 0666 produce read, refusal and refusal respectively.
5. A registered stub subcommand is reachable through the process entry point and an unknown one returns exit code 2.
6. The test wrapper itself: a suite with no test files exits non-zero, a passing suite exits zero.

---

## 8. Acceptance Criteria

1. A fresh clone with Node 24.21.0 or later runs `npm install` and then `npm run typecheck` and `npm test` with no further setup.
2. `node src/cli.js config init` and `node src/cli.js config check` work against a fresh home, and `config check` never reveals the token.
3. No file under `src/` imports a third-party module.
4. A named test file that contains no tests makes the repository test command fail.
5. The human security review file exists with recorded scores, or the feature is explicitly not complete.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the configuration file be JSON or TOML? | JSON, because Node parses it with no dependency and the schema stays closed and machine-checkable |
| 2 | Does the wrapper need to support a watch mode? | No. Nightly collection is a scheduler's job, not a test runner's |
| 3 | Should `config init` write into the home directory or the current directory? | The home directory only, so nothing is ever written into a work tree |
