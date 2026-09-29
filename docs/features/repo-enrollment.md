# Feature: Repo Enrollment and Discovery

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-ST-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-04 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SP-01 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-ENR-FR-01 | This feature | owns |
| RS-ENR-FR-02 | This feature | owns |
| RS-ENR-CON-01 | This feature | owns |
| RS-ENR-ST-01 | This feature | owns |
| RS-ENR-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Repo Enrollment and Discovery
**ID Prefix:** RS-ENR
**Summary:** The opt-in boundary. Nothing is collected until a repository is named in the
configuration file, and `discover` turns "what can this token even see?" into ready-to-paste
configuration lines.
**Dependencies:** Foundation and Runtime, GitHub API Client
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-ENR-ST-01","kind":"story","text":"As a solo maintainer I want nothing collected until I name a repository, so that a token that can see an entire organization never collects from repositories I did not choose."}
```

```forge-requirement
{"id":"RS-ENR-ST-02","kind":"story","text":"As a solo maintainer I want a command that prints the repositories my token can reach as configuration lines, so that enrolling six repositories is a paste rather than a lookup exercise."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-ENR-FR-01","kind":"requirement","text":"Resolve the enrolled set from the configuration: take the declared repository list, remove every entry matching the deny list, drop entries whose enabled flag is false, compare names case-insensitively, and return the survivors in declared order with their normalized owner and name. Nothing outside this set is ever collected."}
```

```forge-requirement
{"id":"RS-ENR-FR-02","kind":"requirement","text":"Provide `repo-signal discover`, reachable from the process entry point, that lists the repositories the token can reach, marks each with its permission and whether it is already enrolled, and prints a ready-to-paste configuration block for the ones that are not. It must support a machine-readable JSON output, must respect the deny list, and must not enrol anything by itself."}
```

```forge-requirement
{"id":"RS-ENR-CON-01","kind":"constraint","text":"Discovery is a read-only convenience. It never writes to the configuration file, never collects, and never widens the enrolled set; enrolling is always a deliberate edit by the maintainer."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-ENR-ST-01 | story | Must |
| RS-ENR-ST-02 | story | Must |
| RS-ENR-FR-01 | requirement | Must |
| RS-ENR-FR-02 | requirement | Must |
| RS-ENR-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

`discover` prints a table of `owner/name`, visibility, current enrolment state and the
permission the token holds, then a fenced block containing the configuration lines to paste. With
`--json` it prints one object with `repositories` and `configLines` arrays so the output can be
piped. Repository names are printed verbatim; the command does not reformat or abbreviate them.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-ENR-01 | The enrolled set is derived deterministically with deny precedence | cli-engineer | RS-FND-04 | src/enrollment/resolve.js, tests/enrollment.test.js | deny wins, disabled dropped, case folding, order kept | Network calls, command surface |
| RS-ENR-02 | `discover` is reachable and prints pasteable configuration lines | cli-engineer | RS-ENR-01, RS-API-04 | src/commands/discover.js, src/commands/index.js, tests/discover-command.test.js | table, JSON mode, deny filter, already-enrolled marking, no write | Collection, storage writes |

---

## 6. Implementation Tasks

### Phase 1: Enrolled set resolution

```forge-task
{
  "id": "RS-ENR-01",
  "title": "Resolve the enrolled repository set with deny-list precedence",
  "description": "Implement src/enrollment/resolve.js as the single function that answers which repositories this install collects. Take the declared repository list, remove any entry whose owner/name appears in the deny list compared case-insensitively, drop entries whose enabled flag is false, and return the survivors in declared order with normalized owner and name and no duplicates. This is the opt-in boundary: the collector must be able to reach no repository that this function did not return, and a repository that appears only in the deny list must never be returned even when it is also declared. The tests cover deny precedence in both declaration orders, case differences, a disabled entry, a duplicate entry and an empty configuration.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["RS-FND-04"],
  "expectedOutputs": ["src/enrollment/resolve.js", "tests/enrollment.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/enrollment.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/repo-enrollment.md#RS-ENR-FR-01"],
    "acceptanceCriteria": ["A repository present in both the declared and the deny list is absent from the result whichever order they appear in", "Entries differing only by case collapse to one survivor", "An entry with enabled false is dropped and its absence is distinguishable from a configuration error", "The result preserves the declared order of the surviving entries", "An empty declared list resolves to an empty array and no error"],
    "constraints": ["This module performs no network and no filesystem access", "Do not implement the discovery command in this task"],
    "constraintRefs": ["docs/features/repo-enrollment.md#RS-ENR-CON-01", "docs/PRD.md#RS-TC-01"],
    "references": ["docs/PRD.md#6.3 Key APIs / Interfaces", "docs/features/repo-enrollment.md#RS-ENR-ST-01"]
  }
}
```

### Phase 2: Discovery command

```forge-task
{
  "id": "RS-ENR-02",
  "title": "Expose the discover command with pasteable configuration lines",
  "description": "Add src/commands/discover.js and register it in src/commands/index.js so `repo-signal discover` is reachable from the process entry point. The command lists the repositories the token can reach, marks each as already enrolled or not, notes whether the token holds the Administration read permission the traffic endpoints need, and prints a fenced block of configuration lines for the repositories that are not yet enrolled. It must support a JSON output mode for piping, must honour the deny list, and must never write the configuration file. The test drives the command through the process entry point against the local transport override, with a stub server supplying the repository list, and asserts the pasted lines are syntactically accepted by the configuration loader.",
  "ownerAgent": "cli-engineer",
  "dependencies": ["RS-ENR-01", "RS-API-04"],
  "expectedOutputs": ["src/commands/discover.js", "src/commands/index.js", "tests/discover-command.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/discover-command.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/repo-enrollment.md#RS-ENR-FR-02", "docs/PRD.md#RS-SP-01"],
    "acceptanceCriteria": ["Running `node src/cli.js discover` against a stubbed repository list exits 0 and prints a fenced configuration block", "The printed lines, when written into a configuration file, are accepted by the configuration loader without edits", "A repository in the deny list is absent from both the table and the printed lines", "The JSON output mode parses to an object with a repositories array and a configLines array", "A test asserts the configuration file's content is unchanged after the command runs"],
    "constraints": ["The command must not enrol, collect, or write configuration", "Only the local transport override may be used in tests"],
    "constraintRefs": ["docs/features/repo-enrollment.md#RS-ENR-CON-01", "docs/PRD.md#RS-TC-04", "docs/PRD.md#RS-SC-01"],
    "references": ["docs/PRD.md#7.4 Shared Definition Index"]
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit | Enrolled set resolution | Pure function over configuration objects |
| Entry point | `discover` output and reachability | Spawn `node src/cli.js discover` against a stubbed repository list over the local transport override |
| Human | Permission and visibility of a real token | Covered by the live integration check in the operations feature |

Key test scenarios:

1. A deny-listed repository never survives, in either declaration order.
2. Case-only differences collapse to one entry.
3. A disabled entry is dropped and reported differently from an invalid entry.
4. The pasted configuration lines load without edits.
5. Discovery leaves the configuration file byte-identical.

---

## 8. Acceptance Criteria

1. A repository absent from the configuration is never collected, even when the token can reach it.
2. A deny-listed repository is never collected.
3. `discover` produces configuration lines the loader accepts unchanged.
4. `discover` never modifies the configuration file.
5. JSON output is machine-readable for scripting.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should discovery include organization repositories by default? | No. Only repositories owned by the authenticated user are listed unless an explicit include-organization flag is passed, because a token with Administration read can see an entire organization |
| 2 | Should discovery show the token's scopes? | It shows the traffic permission state per repository, which is the actionable fact, and never the token value or its full scope list |
| 3 | Should a fork be listed? | Yes, if the token can reach it and it is not denied, because a maintained fork is a real repository |
