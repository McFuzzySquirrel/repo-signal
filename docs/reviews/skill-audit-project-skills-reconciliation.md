# Skill audit report: project-skill stage, reconciliation run

**Generated:** 2026-10-04
**Audited by:** `skill-review` (deterministic reviewer-style proxy, not a human judgement)
**Stage:** `forge-build-project-skills`, mode `reconciliation` (headless, authorized defaults)
**Trigger:** the team stage regenerated the team at `9e67b55` and rewrote `docs/SKILL-CANDIDATES.json`
**Candidates reconciled:** 10 of 12; packages repaired this run: 2; packages authored this run: 0

This is a separate review artefact from `docs/reviews/skill-audit-project-skills.md`, which remains the
record of the run that authored the nine packages. It follows the same rule: the artefact lives outside
the paths a repository contract test asserts, because `RS-C12` makes an unasserted document into drift.

## What changed in the handoff, and what it means for the packages

The delta between the handoff this stage last consumed and the one on disk is confined to the
`consumers` lists and to the sentences in `reason` that explain them. No candidate's `name`,
`description` or `action` changed, so no package's identity or responsibility changed.

| Candidate | Action | What changed in the handoff | Decision this run | Authored |
|-----------|--------|------------------------------|-------------------|----------|
| `forge-task-implementation` | `reuse` | three task-executing consumers instead of one | reuse asserted by the team, nothing authored here | no |
| `verification-loop` | `create` | `cli-engineer`, `documentation-engineer` added | repair a miscount, otherwise adopt unchanged | 1 count corrected |
| `honest-data-rendering` | `create` | `documentation-engineer` added | adopt the existing package unchanged | no |
| `token-and-egress-safety` | `create` | `cli-engineer`, `documentation-engineer` added | adopt the existing package unchanged | no |
| `github-rest-contract` | `create` | `cli-engineer`, `documentation-engineer` added | adopt the existing package unchanged | no |
| `archive-storage-discipline` | `create` | `documentation-engineer` added | repair a miscount, otherwise adopt unchanged | 1 count corrected |
| `cli-command-surface` | `create` | `cli-engineer`, `documentation-engineer` added | adopt the existing package unchanged | no |
| `accessible-server-rendered-views` | `create` | `documentation-engineer` added | adopt the existing package unchanged | no |
| `documentation-contract-tests` | `create` | `documentation-engineer` recorded in place of an empty list | adopt the existing package unchanged | no |
| `interactive-terminal-setup` | `create` | `cli-engineer` added | adopt the existing package unchanged | no |
| `human-review-gate-protocol` | `omit` | unchanged | omission honoured, no package authored or retired | no |
| `node-sqlite-upgrade-drill` | `omit` | unchanged | omission honoured, no package authored or retired | no |

`consumers` is launcher routing metadata. A skill package is deliberately agent-neutral: it states the
process and the trigger conditions, so widening the consumer set adds no guidance to write and removing
a consumer removes none. Adopting the nine packages is therefore almost the whole of the correct output
of this run; writing anything into them to "reflect" the new consumer lists would be the scope creep
`RS-C12` and this stage's own contract warn against.

Re-reading the packages against the source, rather than trusting the authoring run's evidence table,
found two claims that were simply wrong. Both were counts of refusals, and both are the kind of number
an agent relies on when it decides whether a suite proved anything, so both were corrected and the two
reference tables were completed to match.

| Package | Claim as written | What the source says | Repair |
|---------|------------------|---------------------|--------|
| `verification-loop` | "The wrapper reports five distinct refusals", listing five | `scripts/run-tests.mjs` writes seven refusal messages and returns 1 for each: unresolved path, no file matching the test patterns, a runner that could not be started, a runner killed by a signal, no TAP summary, zero tests selected, and a file that reported only itself | Step 2 now names seven, including the two runner-level refusals that had no row in the failure table; `references/failure-recovery.md` gained those two rows |
| `archive-storage-discipline` | "The runner refuses six things by name", listing six | `src/db/migrate.js` refuses seven by name: the list omitted the invalid-filename refusal | Step 2 now names seven and leads with the filename rule; `references/write-shape-rules.md` gained the same item |

Nothing else was touched. The seven other packages, and every other file in the two repaired packages,
are byte-for-byte what the authoring run produced.

## Scope of the gate

Only the affected handoff candidates were passed to the reviewer. The bootstrapped `forge-*` tooling
skills and `skill-creator`, `skill-review`, `skill-review-updater` were not scanned as newly generated
project skills.

```bash
cd .opencode/skills/skill-review
npm run skill-review -- \
  --files .opencode/skills/verification-loop/SKILL.md \
           .opencode/skills/honest-data-rendering/SKILL.md \
           .opencode/skills/token-and-egress-safety/SKILL.md \
           .opencode/skills/github-rest-contract/SKILL.md \
           .opencode/skills/archive-storage-discipline/SKILL.md \
           .opencode/skills/cli-command-surface/SKILL.md \
           .opencode/skills/accessible-server-rendered-views/SKILL.md \
           .opencode/skills/documentation-contract-tests/SKILL.md \
           .opencode/skills/interactive-terminal-setup/SKILL.md \
  --provider stdout --min-score 2 --fail-below --min-axis 2 --fail-axis-below --fail-structural
```

Exit code 0. No structural issue and no axis below 2 across the nine affected packages.

One correction to how that command is run: `--files` is resolved against the repository root that
`git rev-parse --show-toplevel` reports, not against the current directory, so the paths above must be
repository-root-relative even though the command is executed from inside the `skill-review` package.
A relative `../../<name>/SKILL.md` form makes the reviewer print `Missing files` and audit nothing,
which exits 0 while reviewing nothing. The exit code alone does not prove the gate ran.

## Summary scores

Heuristic scores from the rubric, reported separately from the behavioural evidence below. The seven
untouched packages are unchanged from the authoring run; the two repaired packages were re-audited
after the repair and hold the same scores.

| Skill | Context | Gotchas | Procedure | Progressive | Calibration | Validation | Overall | Proxy |
|-------|---------|---------|-----------|-------------|-------------|------------|---------|-------|
| `verification-loop` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |
| `honest-data-rendering` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |
| `token-and-egress-safety` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |
| `github-rest-contract` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |
| `archive-storage-discipline` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |
| `cli-command-surface` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |
| `accessible-server-rendered-views` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |
| `documentation-contract-tests` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |
| `interactive-terminal-setup` | 3 | 3 | 3 | 3 | 3 | 3 | 3.0 | 3 |

## Structural checks, separate from the rubric

| Check | Result |
|-------|--------|
| `docs/SKILL-CANDIDATES.json` validates as immutable version 1 with 12 candidates | pass |
| Every candidate carries a name, a description, a consumers list, an action of reuse, extend, create or omit, and a reason | pass |
| Every consumer named in the handoff has an agent file under `.opencode/agents` | pass: `cli-engineer`, `documentation-engineer`, `qa-engineer` |
| Each frontmatter `name` parses to its exact parent directory name | pass for all nine |
| No frontmatter `name` carries wrapping quote characters copied from the JSON string | pass for all nine |
| Every Markdown link to a reference resolves to a file on disk | pass: nine references, nine files |
| `git diff 5b6a95c HEAD -- .opencode/skills` is confined to the two repaired files | pass: `verification-loop/SKILL.md`, `verification-loop/references/failure-recovery.md`, `archive-storage-discipline/SKILL.md`, `archive-storage-discipline/references/write-shape-rules.md` |
| `docs/EXECUTION-MANIFEST.json` does not exist | pass |

## Behavioural evidence, separate from the heuristic scores

The rubric cannot see whether a skill is true. Each of these was re-checked against the repository in
this run, not carried over from the authoring run.

| Claim the skill makes | Where it was checked in this run |
|-----------------------|--------------------------------|
| The wrapper names seven distinct refusals before it reports a result | `scripts/run-tests.mjs` lines 162, 171, 183, 189, 196, 203, 214: seven refusal messages, each followed by `return 1` |
| The migration runner refuses seven things by name | `src/db/migrate.js` lines 44, 48, 71, 75, 82, 128, 145 |
| The pipeline runs a clean install, type check, suite and backup drill on the floor and the current LTS line | `.github/workflows/ci.yml` lines 51-91, matrix including `24.12.0` |
| The archive fails closed without `enableDefensive` and names the running version and the floor | `src/db/connection.js` lines 14-26 |
| The credential file is refused at any mode other than exactly 0600, naming the observed mode | `src/credentials/store.js` lines 6, 48-52 |
| The pinned API version, the `api.github.com` allowlist and the redirect refusal | `src/github/http.js` lines 6-7, 77-82, 101, 111 |
| The 14-entry day bound and the 30-week page with the 100-page cap | `src/github/traffic-client.js` line 93, `src/github/stars-client.js` lines 14-16 |
| Eleven registered commands, with `setup` the twelfth to land | `src/commands/index.js`: eleven definitions, plus the `RS-TUI-02` registry task |
| The README's own inventory still disagrees with the registry about `report` | `README.md` line 194 lists the maintenance commands without `report`; `docs/PRD.md` line 484 records the same disagreement |
| Contrast thresholds are computed at 4.5:1 for text and 3:1 for non-text | `tests/contrast.test.js` lines 41ff |
| Repository state words and their fixed precedence | `src/supervision/health.js` lines 43-66, PRD section 10 |
| Eight task blocks for the setup surface, seven implementation and one human review | the `forge-task` blocks in `docs/features/setup-terminal-ui.md` |
| Eleven document-plus-contract tasks, every one of them owned by `documentation-engineer` | the `forge-task` blocks in `docs/features/*.md`; only `RS-FND-CONTRACT-01`, a code repair, sits with `cli-engineer` |
| Twenty task blocks in total, eighteen implementation and two human review, and neither human review names an owner agent while each carries its review file in the contract | every `forge-task` block in `docs/features/*.md`, parsed as JSON |
| The three human gates, their review artefacts, and the fact that no gate outcome is recorded | `docs/operations/release-checklist.md` lines 122-131 |
| Every `RS-*` identifier cited by the nine packages is defined in `docs/`, and every repository path they cite exists | 41 distinct identifiers and every backticked `src/`, `tests/`, `scripts/` and `docs/` path, checked programmatically |

## Limits of this review

- The score is a deterministic proxy. It counts structure, not correctness, and no skill here has been
  exercised by an agent running a task against it.
- This run authored no package. Seven were adopted unchanged and two were repaired, so its claim is that
  the nine packages the previous run authored satisfy the handoff once two miscounts are corrected.
- The repairs were verified by reading the source the counts describe, not by running a suite: the
  seven refusal messages in `scripts/run-tests.mjs` and the seven named refusals in `src/db/migrate.js`
  were each located in the file rather than inferred.
- `forge-task-implementation` was recorded as `reuse`. That name resolves outside this stage, so it was
  not audited as an affected file and its absence from the audited set is not a failure.
- The two omitted candidates were not re-derived. The team owns that decision; this run only confirmed
  that neither has a package to preserve and did not author one.

## The fingerprint recorded for this stage

`docs/authoring-state.json` records `outputFingerprint`
`3bcec7d0fefbef4f503c96ef916d7697cdf4f48715735afe449ec3b14e9bc55f` for the nine packages. The launcher's
own fingerprint function is not in this repository, so this value is stated with the algorithm that
produced it, so that anyone can recompute and disagree:

```python
h = hashlib.sha256()
for package in sorted(nine_packages):
    for path in sorted(every_file_under(package)):
        h.update(f"{package}/{relative_path}\0{sha256_hex(content)}\n".encode())
```

The value recorded by the authoring run, `eb14a5447608e23417b137b61499bd7ebbadfd35732671cc98e1035649ec84ea`,
described the packages as they were before the two repairs and is deliberately not carried forward.