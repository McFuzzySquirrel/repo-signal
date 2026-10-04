# Feature: Operations and Posture

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-C01 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C06 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-C12 | [Vision](../PRD.md#64-shared-constraints) | participates |
| RS-NF-06 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-NF-09 | [Vision](../PRD.md#7-non-functional-requirements) | participates |
| RS-PRIV-02 | [Vision](../PRD.md#8-security-and-privacy) | participates |
| RS-OPS-ST-01 | This feature | owns |
| RS-OPS-ST-02 | This feature | owns |
| RS-OPS-C01 | This feature | owns |
| RS-OPS-C02 | This feature | owns |
| RS-OPS-C03 | This feature | owns |
| RS-OPS-FR-01 | This feature | owns |
| RS-OPS-FR-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Operations and Posture
**ID Prefix:** RS-OPS
**Summary:** Everything that keeps the claims true after the code is written: continuous
integration that typechecks, tests and rehearses a restore on two Node lines; a release checklist
that names what ships with a tag and the three human gates before one; four runbooks for scheduling,
troubleshooting, backup and privacy; and the open-source posture position, which the project states
but has never had reviewed by a person.
**Dependencies:** Foundation and Runtime, Archive Storage, Dashboard Views
**Priority:** Must
**As-built status:** Built, covered by `tests/ci-contract.test.js`, `tests/release-contract.test.js`,
`tests/troubleshooting-contract.test.js`, `tests/backup-drill.test.js` and the four runbooks. The one
outstanding item is the posture review artefact the README and the release checklist both say is
missing.

---

## 2. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| RS-OPS-ST-01 | Maintainer releasing a version | one checklist that names what ships, what the pipeline proves and which claims must still hold, so that a tag is a decision rather than a reflex | Must |
| RS-OPS-ST-02 | Maintainer whose archive needs to survive a disk | rehearsed backup and restore steps with the warnings that matter, so that a recovery is a procedure rather than an improvisation | Must |

---

## 3. Functional Constraints

```forge-requirement
{"id":"RS-OPS-FR-01","kind":"requirement","text":"A named human reviewer records a decision for the open-source posture: the MIT licence, the statement that GitHub aggregate traffic data may not be redistributed, the read-only token description and the privacy note, with the reason and the evidence read for each position, in a review file no agent authors."}
```

```forge-requirement
{"id":"RS-OPS-FR-02","kind":"requirement","text":"Before that review runs, a dossier states each of the four positions, names the file and heading each one lives in, names the test that asserts it, and marks it confirmed by documentation or contested, so the reviewer reads gathered evidence rather than hunting for it."}
```

```forge-requirement
{"id":"RS-OPS-C01","kind":"constraint","text":"Continuous integration runs the type check, the whole test suite and the backup drill exactly once on both the declared Node floor and the current LTS line, with read-only repository permissions, no secret of any kind, no deploy or publish pattern, no scheduled trigger and no action outside the two it uses."}
```

```forge-requirement
{"id":"RS-OPS-C02","kind":"constraint","text":"The release checklist names the schema version, the supported Node range, the licence and the package version each with its authority, lists the pipeline commands in order with what each one proves, and states that a failure of any of them means do not tag."}
```

```forge-requirement
{"id":"RS-OPS-C03","kind":"constraint","text":"The runbooks are contract-tested: every command, state word, request figure and refusal they name is asserted against the code, so a runbook cannot drift into describing a product that no longer exists."}
```

```forge-requirement
{"id":"RS-OPS-C04","kind":"constraint","text":"The product performs no export, publish, share or upload action of any kind, offers no archive download, and states in its own words that GitHub aggregate traffic data may not be redistributed; a personal backup is a copy rather than a redistribution."}
```

---

## 4. Runbooks and Gates

| Document | Read it when | Contract test |
|----------|--------------|---------------|
| `docs/operations/scheduled-collection.md` | The daily run should happen without you | `tests/troubleshooting-contract.test.js` |
| `docs/operations/troubleshooting.md` | Collection stopped | `tests/troubleshooting-contract.test.js` |
| `docs/operations/backup-and-migrate.md` | The archive must survive a disk | `tests/backup-drill.test.js` |
| `docs/operations/privacy.md` | You want to know exactly what is stored and what leaves | `tests/release-contract.test.js` |
| `docs/operations/release-checklist.md` | You are about to tag | `tests/ci-contract.test.js` |

Three human gates are named by the release checklist and are not recorded in this repository:

| Gate | Artefact | Status |
|------|----------|--------|
| `RS-OPS-LIVE-01` | `docs/reviews/github-live-integration.json` | not recorded |
| `RS-OPS-SOAK-01` | `docs/reviews/collection-soak.json` | not recorded |
| `RS-OPS-REV-01` | `docs/reviews/open-source-posture.json` | not recorded; authored as a task below |

The first two are deliberately not authored here. No agent authors any of the three; each is written
by a person who did the work. Only the posture gate is in scope for this pass, and it is the one the
README calls out by name.

---

## 5. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Integration | Continuous integration shape and permissions | Existing `tests/ci-contract.test.js` |
| Contract | README, licence and privacy-note claims | Existing `tests/release-contract.test.js` |
| Contract | Runbook commands, states and figures | Existing `tests/troubleshooting-contract.test.js` |
| Integration | Backup and restore round trip | Existing `tests/backup-drill.test.js`, and the drill itself in CI |
| Contract | The posture dossier cites what it claims to cite | Created by task RS-OPS-POST-01 |
| Human | The posture decision itself | Task RS-OPS-REV-01 |

Key scenarios: a workflow that gained a secret, a deploy step, a schedule or a third action fails the
contract test; a runbook that names a state word the code cannot produce fails; a dossier citation
that points at a heading which no longer exists fails; the review artefact is absent until a person
writes it, and no agent writes it.

---

## 6. Implementation Tasks

### Phase 1: Posture review

```forge-task
{
  "id": "RS-OPS-POST-01",
  "title": "Assemble the open-source posture dossier a human reviewer can actually read",
  "description": "The README states the project is MIT licensed, that GitHub aggregate traffic data may not be redistributed, that one read-only fine-grained token is the only secret, and that nothing leaves the machine but read requests to one host. No single document gathers those four positions with their sources, and the README says the review artefact that confirms them is missing. Create `docs/reviews/open-source-posture-dossier.md` that states each of the four positions in the reviewer's own words, names the file and heading each one currently lives in, names the test that asserts it, and marks each position confirmed-by-documentation or contested. Create `tests/posture-dossier.test.js` asserting that every file and heading the dossier cites exists, that every test it names exists, and that the four positions are all present. Do not decide any of the four positions, do not soften the redistribution statement, do not add legal advice, and do not create the review artefact itself.",
  "ownerAgent": "documentation-engineer",
  "dependencies": ["RS-GHC-CONTRACT-01"],
  "expectedOutputs": ["docs/reviews/open-source-posture-dossier.md", "tests/posture-dossier.test.js"],
  "validationCommands": ["npm test -- tests/posture-dossier.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": ["Assert every position the dossier cites is present in this repository, at the heading it names, with the test that asserts it"],
    "requirementRefs": ["docs/features/operations-and-posture.md#RS-OPS-FR-02"],
    "acceptanceCriteria": ["The dossier covers the licence, the data statement, the token description and the privacy note, each with a file and heading", "A test fails when a cited heading or cited test file does not exist", "The dossier marks each position confirmed or contested without resolving it", "tests/posture-dossier.test.js reports more than zero executed tests"],
    "constraints": ["Do not create docs/reviews/open-source-posture.json; that file is written by a person", "Do not weaken, reinterpret or paraphrase the redistribution statement into something narrower"],
    "constraintRefs": ["docs/features/operations-and-posture.md#RS-OPS-C04", "docs/PRD.md#RS-C06"],
    "references": ["docs/features/operations-and-posture.md#4. Runbooks and Gates", "docs/operations/release-checklist.md"]
  }
}
```

```forge-task
{
  "id": "RS-OPS-REV-01",
  "title": "Human review of the open-source posture",
  "description": "A person reviews the four positions in the dossier and records the decision in docs/reviews/open-source-posture.json. The reviewer reads the project as a new reader would, starting at the README, and checks each of the dossier's four positions against the file it names: the MIT licence text, the redistribution statement for GitHub aggregate traffic data, the token description including that it is read-only and never printed, and the privacy note including that one host is the only outbound destination. For each position the reviewer records a decision, the reason, and whether the statement as written is accurate. The reviewer's notes must state what they read and what they checked, and must record any position they could not confirm. This is a judgement about posture, licence and data handling: no agent may write or approve this file, and the reviewer must not treat a passing test suite as evidence for any of the four positions.",
  "dependencies": ["RS-OPS-POST-01"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": ["A named human reviewer records a decision for the licence, the data statement, the token description and the privacy note, with the reason and what was checked for each"],
    "requirementRefs": ["docs/features/operations-and-posture.md#RS-OPS-FR-01"],
    "acceptanceCriteria": ["The reviewer has read the README as a new reader and checked each of the four positions against the file the dossier names", "The review file records a decision, a reason and the evidence read for each of the four positions", "The review file states plainly which positions, if any, could not be confirmed", "The notes name the exercise rather than asserting a general impression"],
    "constraints": ["No agent authors or approves this review", "A passing test suite is not evidence for any of the four positions"],
    "constraintRefs": ["docs/features/operations-and-posture.md#RS-OPS-C04"],
    "reviewFile": "docs/reviews/open-source-posture.json",
    "references": ["README.md", "LICENSE", "docs/operations/privacy.md", "docs/operations/release-checklist.md", "docs/features/operations-and-posture.md#4. Runbooks and Gates"]
  }
}
```

---

## 7. Acceptance Criteria

1. Continuous integration proves the type check, the tests and the restore round trip on both Node
   lines, with no secret and no deploy path.
2. Every runbook claim about commands, states, figures and refusals is asserted by a named test.
3. The release checklist names what ships with a tag and the human gates that are not yet recorded.
4. The dossier exists, cites real files and headings, and resolves every claim it makes.
5. The posture review artefact is written by a person, records a decision per position, and states
   what was read and checked.

---

## 8. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | The redistribution statement is the project's own position and has had no legal sign-off | The conservative reading is operative: keep the archive local |
| 2 | Should the live integration and unattended soak gates be authored as tasks in a later pass | Not in this pass; they stay named in the release checklist until a person records them |
| 3 | The workflow runs no scheduled collection of its own, so CI proves correctness rather than liveness | Keep it: the collector belongs on the maintainer's machine, not on a runner |
| 4 | Should a tag be cut for the current version | No decision here; the checklist's six steps are the gate |