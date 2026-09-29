# Feature: Operations and Open Source Posture

## Traceability

| Canonical ID | Owner / Source Link | Relationship |
|--------------|---------------------|--------------|
| RS-VR-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-TC-03 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-DU-01 | [Vision](../PRD.md#7. Non-Functional Requirements) | participates |
| RS-SP-03 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SP-04 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SP-05 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-SP-08 | [Vision](../PRD.md#8. Security and Privacy) | participates |
| RS-OPS-FR-01 | This feature | owns |
| RS-OPS-FR-02 | This feature | owns |
| RS-OPS-FR-03 | This feature | owns |
| RS-OPS-FR-04 | This feature | owns |
| RS-OPS-CON-01 | This feature | owns |
| RS-OPS-ST-01 | This feature | owns |
| RS-OPS-ST-02 | This feature | owns |

**PRD:** [docs/PRD.md](../PRD.md)

---

## 1. Feature Overview

**Feature Name:** Operations and Open Source Posture
**ID Prefix:** RS-OPS
**Summary:** Everything a stranger needs to run this on their own repositories for years: the
backup and migration drill, the scheduling and troubleshooting runbooks, the README and licence
that state the data's real owner, the continuous integration that keeps the promise honest, and
the three human gates a machine cannot pass.
**Dependencies:** Foundation and Runtime, Telemetry Storage and Migrations, Collection Supervision
**Priority:** Must

---

## 2. User Stories

```forge-requirement
{"id":"RS-OPS-ST-01","kind":"story","text":"As a solo maintainer I want the archive to be backed up and restorable with two commands and a written procedure, so that years of accumulated history is not one disk away from gone."}
```

```forge-requirement
{"id":"RS-OPS-ST-02","kind":"story","text":"As a stranger I want to know exactly what this tool stores, where, and what I may not do with the data, so that I can run it on my own repositories without guessing."}
```

---

## 3. Functional Requirements

```forge-requirement
{"id":"RS-OPS-FR-01","kind":"requirement","text":"Provide a backup drill that creates a scratch home, collects a small known dataset, takes a backup, restores it into a second home, runs the integrity check, and compares per-table row counts, failing on any difference; and document the same procedure for a real archive including where to keep copies and how to move an archive to another machine."}
```

```forge-requirement
{"id":"RS-OPS-FR-02","kind":"requirement","text":"Document unattended operation: a daily schedule entry for cron, launchd and a systemd timer, the expected quiet-hours request budget, what happens after a laptop sleeps, how to catch up, and a troubleshooting page covering an expired token, a missing traffic permission, an exhausted rate limit, a stalled collector and a failed migration."}
```

```forge-requirement
{"id":"RS-OPS-FR-03","kind":"requirement","text":"Publish the README, the licence and a privacy note: what the tool is, the honest limits of its evidence, how to install and run it with no build step, the required token permission, the fact that repository traffic data is GitHub's aggregate data and may not be redistributed, where state and credentials live, and that no telemetry exists. Add a test that asserts these statements are present, so a later edit cannot quietly remove them."}
```

```forge-requirement
{"id":"RS-OPS-FR-04","kind":"requirement","text":"Run the verification pipeline in continuous integration on both supported Node lines with a clean install, the type check and the full test suite, and publish a release checklist that names the schema version, the supported Node range, the licence, and the human gates that must have run before a tag."}
```

```forge-requirement
{"id":"RS-OPS-CON-01","kind":"constraint","text":"No operation, script or document in this feature may create an outbound request other than to api.github.com, and no document may state a test result, an approval or a compliance claim that has not actually been observed."}
```

### 3.1 Priority Index

| ID | Kind | Priority |
|----|------|----------|
| RS-OPS-ST-01 | story | Must |
| RS-OPS-ST-02 | story | Must |
| RS-OPS-FR-01 | requirement | Must |
| RS-OPS-FR-02 | requirement | Must |
| RS-OPS-FR-03 | requirement | Must |
| RS-OPS-FR-04 | requirement | Must |
| RS-OPS-CON-01 | constraint | Must |

---

## 4. UI / Interaction Design

There is no new surface. The runbooks are read in a terminal or a browser; every command in them
is copy-pasteable, and every failure mode in the troubleshooting page is listed with the exact
state word the dashboard shows, so a symptom and a cause can be matched without guessing.

---

## 5. Task Review Table

| ID | Outcome | Owner | Prerequisite interface | Outputs and tests | Checks | Exclusions |
|----|---------|-------|------------------------|-------------------|--------|------------|
| RS-OPS-01 | A repeatable backup and restore drill proves the runbook | platform-engineer | RS-DB-04 | docs/operations/backup-and-migrate.md, scripts/backup-drill.mjs, tests/backup-drill.test.js | drill passes, row counts compared, restore verified | CI, README |
| RS-OPS-02 | Scheduling and troubleshooting runbooks exist and are executable | platform-engineer | RS-SUP-02, RS-FND-06 | docs/operations/scheduled-collection.md, docs/operations/troubleshooting.md | schedule entries verified, failure modes matched to state words | Live verification |
| RS-OPS-03 | README, licence and privacy note state the data's real owner | platform-engineer | RS-FND-01 | README.md, LICENSE, docs/operations/privacy.md, tests/release-contract.test.js | required statements asserted, licence present, no secret committed | CI, live verification |
| RS-OPS-04 | CI runs the verification pipeline and a release checklist gates a tag | platform-engineer | RS-OPS-01, RS-OPS-03 | .github/workflows/ci.yml, docs/operations/release-checklist.md, tests/ci-contract.test.js | both Node lines, install, typecheck, test asserted from the workflow file | Human gates |
| RS-OPS-LIVE-01 | The real GitHub service is exercised with a real token | human reviewer | RS-ENR-02, RS-API-04, RS-BKL-03, RS-COL-04 | docs/reviews/github-live-integration.json | every endpoint, media type and permission checked live | Code changes |
| RS-OPS-SOAK-01 | Seven consecutive unattended days leave no gap and no manual fix | human reviewer | RS-OPS-02, RS-COL-03, RS-SUP-03 | docs/reviews/collection-soak.json | per-day evidence recorded for seven days | Code changes |
| RS-OPS-REV-01 | The open-source posture is signed off by a person | human reviewer | RS-OPS-03, RS-OPS-04 | docs/reviews/open-source-posture.json | licence, data statement, release gate confirmed | Code changes |

---

## 6. Implementation Tasks

### Phase 1: Durability and operation documents

```forge-task
{
  "id": "RS-OPS-01",
  "title": "Build the backup drill and the backup and migration runbook",
  "description": "Add scripts/backup-drill.mjs, a script that creates a scratch home, writes a small known dataset through the repositories, takes a backup with the database command, restores it into a second home, runs the integrity check, and compares per-table row counts, exiting non-zero on any difference. Add tests/backup-drill.test.js that runs the drill and asserts it succeeds and that a deliberately truncated backup is detected. Add docs/operations/backup-and-migrate.md, the operator runbook: where copies should live, how to restore into a fresh home, how to move an archive to another machine, what to do when the code's schema version is ahead of the archive, and the warning that a restore replaces the current archive. Every command in the runbook must be one that exists in this repository.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-DB-04"],
  "expectedOutputs": ["docs/operations/backup-and-migrate.md", "scripts/backup-drill.mjs", "tests/backup-drill.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/backup-drill.test.js", "node scripts/backup-drill.mjs"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/operations-and-posture.md#RS-OPS-FR-01", "docs/PRD.md#RS-SP-03"],
    "acceptanceCriteria": ["The drill exits zero and reports identical per-table row counts for the original and the restored home", "A deliberately truncated backup is detected and the drill exits non-zero", "A test asserts the runbook names the backup, restore, verify and schema-version commands that exist in this repository", "The runbook states that a restore replaces the current archive and where copies should be kept"],
    "constraints": ["The drill and the runbook must not print a token or an observation value", "No command may be documented that the repository does not provide"],
    "constraintRefs": ["docs/features/operations-and-posture.md#RS-OPS-CON-01", "docs/PRD.md#RS-SC-02", "docs/PRD.md#RS-TC-04", "docs/PRD.md#RS-TC-03"],
    "references": ["docs/PRD.md#12. Dependencies and Risks"]
  }
}
```

```forge-task
{
  "id": "RS-OPS-02",
  "title": "Write the unattended operation and troubleshooting runbooks",
  "description": "Add docs/operations/scheduled-collection.md and docs/operations/troubleshooting.md. The scheduling page must give a working daily entry for cron, for launchd and for a systemd timer, each invoking the collect command with the resolved home, and must state the expected quiet-hours request budget, what a sleeping laptop does to the schedule, and how to catch up after a missed day. The troubleshooting page must cover an expired token, a token without the traffic permission, an exhausted rate limit, a stalled collector, a failed migration and a database that will not open, and for each one name the state word the dashboard shows so a symptom maps to a cause. A test must assert that every command named in both pages exists as a command in this repository.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-SUP-02", "RS-FND-06"],
  "expectedOutputs": ["docs/operations/scheduled-collection.md", "docs/operations/troubleshooting.md"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/troubleshooting-contract.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/operations-and-posture.md#RS-OPS-FR-02"],
    "acceptanceCriteria": ["Both pages are added, and a test asserts every command they name is a command this repository actually provides", "The scheduling page gives a cron, a launchd and a systemd timer entry for the daily run", "The troubleshooting page covers all six failure modes and names the dashboard state word for each", "The pages state what happens after the machine sleeps and how to catch up"],
    "constraints": ["No page may claim a test result or an approval that was not observed", "No new command is introduced by these documents"],
    "constraintRefs": ["docs/features/operations-and-posture.md#RS-OPS-CON-01", "docs/PRD.md#RS-TC-04", "docs/PRD.md#RS-DU-01"],
    "references": ["docs/PRD.md#10. System States / Lifecycle", "docs/PRD.md#11. Analytics / Success Metrics"]
  }
}
```

### Phase 2: Public surface and pipeline

```forge-task
{
  "id": "RS-OPS-03",
  "title": "Publish the README, the licence and the privacy note",
  "description": "Write README.md, LICENSE and docs/operations/privacy.md. The README states what the tool is and what a clone does not prove, the honest limits of the archive, how to install and run it with no build step, the token and the exact permission it needs, the two commands, and where the archive lives. The privacy note states that no telemetry exists, that the only outbound host is api.github.com, and that the credential file holds a read-only token. The licence is MIT. Add tests/release-contract.test.js asserting that the README still contains the no-fabrication statement, the redistribution statement that GitHub's traffic data is GitHub's aggregate data and not ours to share, the required permission, the supported Node range, and that no credential or database file is committed. The redistribution statement is a legal judgement the reviewer confirms, not a substitute for one.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-FND-01"],
  "expectedOutputs": ["README.md", "LICENSE", "docs/operations/privacy.md", "tests/release-contract.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/release-contract.test.js"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/operations-and-posture.md#RS-OPS-FR-03", "docs/PRD.md#RS-SP-08", "docs/PRD.md#RS-SP-04", "docs/PRD.md#RS-SP-05"],
    "acceptanceCriteria": ["A test asserts the README states that a clone is not adoption and that no history is fabricated", "A test asserts the README states that GitHub's traffic data is GitHub's aggregate data and may not be redistributed", "A test asserts the README names the Administration read permission and the supported Node range", "A test asserts no credential, database or home-directory file is tracked in the repository", "A licence file exists and names the MIT licence with a copyright line"],
    "constraints": ["No statement of legal advice, compliance or test result beyond what the repository can show", "The redistribution statement is drafted, and the human review confirms it"],
    "constraintRefs": ["docs/features/operations-and-posture.md#RS-OPS-CON-01", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-HO-01"],
    "references": ["docs/PRD.md#8. Security and Privacy"]
  }
}
```

```forge-task
{
  "id": "RS-OPS-04",
  "title": "Add continuous integration and the release checklist",
  "description": "Add .github/workflows/ci.yml running a clean install, the type check and the full test suite on both supported Node lines, with the verification wrapper so an empty test selection fails the build, followed by the backup drill so the archive restore path is exercised on every run, and add docs/operations/release-checklist.md naming the schema version that ships, the supported Node range, the licence, the statements the README must still make, and the human gates that must have been recorded before a tag: the live integration check, the seven-day soak and the open-source posture review. Add tests/ci-contract.test.js asserting the workflow file runs the install, the type check and the test command on two Node versions and that the checklist names all three human gates.",
  "ownerAgent": "platform-engineer",
  "dependencies": ["RS-OPS-01", "RS-OPS-03"],
  "expectedOutputs": [".github/workflows/ci.yml", "docs/operations/release-checklist.md", "tests/ci-contract.test.js"],
  "validationCommands": ["npm run typecheck", "npm test -- tests/ci-contract.test.js", "node scripts/backup-drill.mjs"],
  "contract": {
    "version": 2,
    "kind": "implementation",
    "requirements": [],
    "requirementRefs": ["docs/features/operations-and-posture.md#RS-OPS-FR-04", "docs/PRD.md#RS-SP-05"],
    "acceptanceCriteria": ["A test asserts the workflow performs a clean install, the type check and the repository test command", "A test asserts the workflow matrix covers two Node versions including the supported floor", "A test asserts the release checklist names the live integration check, the seven-day soak and the open-source posture review", "A test asserts the checklist names the schema version and the supported Node range"],
    "constraints": ["The pipeline must not require a GitHub token or any secret to run", "The pipeline must not deploy, publish or release anything"],
    "constraintRefs": ["docs/features/operations-and-posture.md#RS-OPS-CON-01", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#16. Open Questions"]
  }
}
```

### Phase 3: Human gates

```forge-task
{
  "id": "RS-OPS-LIVE-01",
  "title": "Live verification of the real GitHub service with a real token",
  "description": "Run the collection path against api.github.com with a fine-grained personal access token that has Administration read on one or two repositories you own, and record every result in docs/reviews/github-live-integration.json. Set REPO_SIGNAL_HOME to a scratch directory, then check each of these and paste the observed outcome: `node src/cli.js config init` and `config check` accept the credential; `node src/cli.js discover` returns a non-empty list and prints lines the configuration loader accepts; `node src/cli.js collect --dry-run` plans without a request; `node src/cli.js collect` succeeds and the dashboard shows 14 days of clones and views; a request carrying X-GitHub-Api-Version 2026-03-10 is answered with 200 rather than 400 or 410, and the same request without the header still defaults to 2022-11-28; `GET /repos/{owner}/{repo}/stargazers` with Accept application/vnd.github.star+json returns starred_at fields and the backfill stores a star history; `GET /repos/{owner}/{repo}/stats/participation` returns 202 at least once before 200; the traffic endpoints answer with the Administration read permission and produce a 403 without it; the referrer and popular-path responses are top ten lists with no day dimension. Record any difference from the mocked assumptions as a defect, not as a curiosity. The engine cannot hold a real token, so this gate is a person with the credential.",
  "dependencies": ["RS-ENR-02", "RS-API-01", "RS-API-02", "RS-API-03", "RS-API-04", "RS-BKL-01", "RS-BKL-02", "RS-BKL-03", "RS-COL-03", "RS-COL-04", "RS-SRV-03"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/github-api-client.md#RS-API-FR-01", "docs/features/github-api-client.md#RS-API-FR-03", "docs/features/github-api-client.md#RS-API-FR-04", "docs/features/first-connect-backfill.md#RS-BKL-FR-01", "docs/PRD.md#RS-SP-01"],
    "acceptanceCriteria": ["The review file records the observed outcome of each of the nine live checks, with the status code or the stored row count as evidence", "The review file confirms a non-empty successful result for every supported call shape", "Any external API detail that the mocked tests assumed rather than verified is recorded as verified or as a defect", "The review file names the token's permission set as tested, and records that no token value was written into the file", "A check that could not be run is recorded as unverified with the reason"],
    "constraints": ["No agent may author or complete this review file", "The review must not be signed off from mocked test output alone"],
    "constraintRefs": ["docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-SC-04", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/PRD.md#16. Open Questions", "docs/PRD.md#12.1 Dependencies"],
    "reviewFile": "docs/reviews/github-live-integration.json"
  }
}
```

```forge-task
{
  "id": "RS-OPS-SOAK-01",
  "title": "Seven consecutive unattended days of scheduled collection",
  "description": "Install the daily schedule entry from the scheduling runbook on one real machine and let it run for seven consecutive days without manual intervention. Each day, record in docs/reviews/collection-soak.json: the run identifier, the run status, the number of repositories collected, the row count written, and the health state shown for each repository. Confirm at the end that the archive has no gap wider than 26 hours, that no day required a manual fix, that the token never appeared in any log, and that the request budget stayed within the documented figure. If the machine slept, record it as an observation of the stalled state rather than repairing the data by hand. This gate exists because the product's premise is unattended accumulation, and a week is the shortest window in which a sleep, a token expiry and a rate limit can all appear.",
  "dependencies": ["RS-OPS-02", "RS-COL-03", "RS-SUP-02", "RS-SUP-03", "RS-UI-03"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/collection-supervision.md#RS-SUP-FR-02", "docs/features/operations-and-posture.md#RS-OPS-FR-02"],
    "acceptanceCriteria": ["Seven dated entries are recorded, each with a run identifier, a status, a repository count and a row count", "The final check states the widest gap in the archive and that it is within 26 hours", "The record states that no manual repair was needed and names any day the machine slept", "The record states that no token value appeared in any log or review artifact", "Any failure observed is written as a defect with its date rather than smoothed over in the narrative"],
    "constraints": ["No agent may author or complete this review file", "Data must not be hand-edited to close a gap; a gap is the finding"],
    "constraintRefs": ["docs/PRD.md#RS-DU-01", "docs/PRD.md#RS-DU-02", "docs/PRD.md#RS-SC-02"],
    "references": ["docs/PRD.md#11. Analytics / Success Metrics", "docs/features/operations-and-posture.md#RS-OPS-ST-01"],
    "reviewFile": "docs/reviews/collection-soak.json"
  }
}
```

```forge-task
{
  "id": "RS-OPS-REV-01",
  "title": "Human sign-off on the open-source posture and the release gate",
  "description": "Read README.md, LICENSE and docs/operations/privacy.md as a stranger would, then confirm in docs/reviews/open-source-posture.json: the licence is the one intended for this project; the redistribution statement about GitHub's aggregate traffic data is accurate and unambiguous; the token description matches the permission the live integration check actually used; the privacy note matches what the code does; and the release checklist's required gates match the review files that exist. Record a rubric score per item, the decision to publish or not, and any statement that must be reworded. Approving the licence and the data statement is a person's judgement, not an agent's.",
  "dependencies": ["RS-OPS-03", "RS-OPS-04"],
  "expectedOutputs": [],
  "validationCommands": [],
  "contract": {
    "version": 2,
    "kind": "human-review",
    "requirements": [],
    "requirementRefs": ["docs/features/operations-and-posture.md#RS-OPS-FR-03", "docs/PRD.md#RS-SP-08"],
    "acceptanceCriteria": ["The review file records a rubric score and a written verdict for the licence, the redistribution statement, the token description, the privacy note and the release gate", "The reviewer confirms the token description matches the permission used in the live integration review", "The publish or hold decision is stated explicitly with its date", "Any statement that must be reworded is quoted in the review file as it appears now"],
    "constraints": ["No agent may author or complete this review file", "Headless approval of these documents is not a substitute for this review"],
    "constraintRefs": ["docs/PRD.md#RS-HO-01", "docs/PRD.md#RS-SC-01", "docs/PRD.md#RS-TC-04"],
    "references": ["docs/features/operations-and-posture.md#RS-OPS-ST-02", "docs/PRD.md#8. Security and Privacy"],
    "reviewFile": "docs/reviews/open-source-posture.json"
  }
}
```

---

## 7. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Script | Backup and restore round trip, truncation detection | `scripts/backup-drill.mjs` plus a test that runs it |
| Unit | Documentation contracts | Tests asserting the statements, commands and gates the documents must contain |
| Pipeline | Install, type check, full test suite on two Node lines | A test asserting the workflow file, and the workflow itself in the repository host |
| Human | The real GitHub service, the unattended week, the licence and data statement | Three recorded human review files |

Key test scenarios:

1. Backup then restore into a fresh home yields identical per-table row counts.
2. A truncated backup is detected rather than restored.
3. Every command named in a runbook exists in this repository.
4. The README still carries the no-fabrication, redistribution, permission and Node-range statements.
5. The pipeline runs install, type check and tests on two Node versions.
6. Nine live GitHub checks are performed with a real token and recorded.
7. Seven unattended days are recorded with no manual repair.

---

## 8. Acceptance Criteria

1. A stranger can clone, configure, schedule and read the tool using only the README and the runbooks.
2. A backup and restore round trip is executable today and produces a verified copy.
3. The archive's provenance, its limits and its data ownership are stated plainly and survive editing.
4. The pipeline fails when the type check or the test suite fails, and when no test is selected.
5. The three human gates exist as recorded evidence before a release is claimed.

---

## 9. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Is seven days a meaningful soak? | It is the shortest window in which a sleep, a token expiry and a rate limit can all plausibly appear; the ninety-day measurement stays the maintainer's own later review |
| 2 | Should the repository be published immediately? | No. The open-source posture review is the gate, and it includes the licence and the data statement |
| 3 | Who owns the GitHub repository and its releases? | Whoever runs this build owns the repository; the checklist states the required gates rather than a person |
| 4 | Should the release checklist be automated? | No. It names the human gates deliberately, because those gates are the ones a script must not be able to satisfy |
