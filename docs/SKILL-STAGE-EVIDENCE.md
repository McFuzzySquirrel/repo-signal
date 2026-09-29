# Project-skill stage evidence

**Stage:** `forge-build-project-skills` (skills)
**Mode:** headless, authorized defaults
**Date:** 2026-09-29
**Input:** `docs/SKILL-CANDIDATES.json` (immutable, version 1, fingerprint
`524926811c66e38866d43edb8a3c7e1fc6f6b139ca2c24a213698f8b70a71818`)

This file records what was decided and observed for the skills stage. Heuristic quality scores are
deliberately kept out of it: they live in `docs/SKILL-AUDIT.md`, which is the `skill-review`
artifact.

## Stage contract resolution

| Check | Result |
|-------|--------|
| Handoff exists and parses as `{ "version": 1, "candidates": [...] }` | Yes |
| Every candidate has a name, description, consumers, action and reason | Yes, 11 candidates |
| Candidate names are stable kebab-case and unique | Yes |
| Actions are drawn from `reuse`, `extend`, `create`, `omit` | Yes |
| Handoff is empty or all-`omit` (would complete as `no-skills-required`) | No - nine `create` actions, so the stage ran and completed `complete` |
| Harness, mode, authorization, model resolved before generation | `opencode` runner, `opencode/space-bunny-free` from `docs/authoring-config.json`, headless with supplied authorization |

## Per-candidate decision

| Candidate | Action | Outcome | Package |
|-----------|--------|---------|---------|
| `forge-task-implementation` | create | Authored | `SKILL.md` + `references/contract-fields.md` |
| `honest-data-rendering` | create | Authored | `SKILL.md` + `references/honest-output-shapes.md` |
| `token-and-egress-safety` | create | Authored | `SKILL.md` + `references/redaction-surfaces.md` |
| `github-rest-contract` | create | Authored | `SKILL.md` + `references/vendor-documentation.md` |
| `archive-storage-discipline` | create | Authored | `SKILL.md` + `references/write-shape-rules.md` |
| `cli-command-surface` | create | Authored | `SKILL.md` + `references/command-inventory.md` |
| `accessible-server-rendered-views` | create | Authored | `SKILL.md` + `references/structural-assertions.md` |
| `verification-loop` | create | Authored | `SKILL.md` + `references/failure-recovery.md` |
| `documentation-contract-tests` | create | Authored | `SKILL.md` + `references/document-test-patterns.md` |
| `human-review-gate-protocol` | omit | Honoured - nothing authored, nothing deleted | n/a |
| `node-sqlite-upgrade-drill` | omit | Honoured - nothing authored, nothing deleted | n/a |

No candidate was downgraded to `reuse` or `extend`, and no candidate was upgraded. No existing
package was vendored, and no package outside the handoff was created.

## Structural checks

| Check | Result |
|-------|--------|
| Each `SKILL.md` exists with YAML frontmatter that parses | Yes, 9 of 9 |
| Each frontmatter `name` equals its parent directory name after YAML parsing | Yes, 9 of 9 |
| No frontmatter `name` carries wrapping JSON quote characters | Yes - names were copied as YAML string values, not JSON-encoded |
| `description` is a single-line double-quoted YAML scalar in every package | Yes, 9 of 9 |
| Every Markdown file reference is a relative path from the skill root and exists on disk | Yes |
| Reference chain depth is one level | Yes - no reference file loads another |
| Every `SKILL.md` is under 500 lines | Yes, longest is the forge-task package |
| `skill-review` passes with `--fail-axis-below --min-axis 2 --fail-structural` | Yes, exit 0 |

## Boundary checks

| Check | Result |
|-------|--------|
| `docs/SKILL-CANDIDATES.json` unchanged | Yes, `git status` shows no modification |
| Agent team, ownership and handoff unchanged | Yes, no file under `.opencode/agents/` was written |
| No execution manifest created or replaced | Yes, `docs/EXECUTION-MANIFEST.json` does not exist |
| Build not started | Yes, no `src/`, `tests/`, `scripts/` or `spikes/` path was created |
| Pre-existing `forge-*` tooling skills unchanged | Yes, only the nine new directories were added under `.opencode/skills/` |
| Unaffected packages and manifest IDs preserved | No manifest exists yet, so no ID was disturbed |

## Content provenance

Every package was written from the team's own immutable input rather than from generic material:
`docs/PRD.md` (sections 6 through 16), the eleven `docs/features/*.md` task contracts, the
`forge-build-prd` task-authoring contract, and the generated agent descriptions. Each package names
the canonical requirement IDs it enforces (`RS-DU-02`, `RS-HO-01`, `RS-SC-02`, `RS-TC-04`, and the
rest) so a reader can check a rule against the plan that set it.

## Review gate outcome

`skill-review` was run against the nine candidate files only, never against the whole
`.opencode/skills/` tree, so the pre-existing `forge-*` tooling skills were not scored as
newly generated project skills.

- Every axis of every candidate scored 3 of 3.
- No structural issue was reported.
- Exit code 0 with `--min-score 2 --fail-below --min-axis 2 --fail-axis-below --fail-structural`.

The full report is `docs/SKILL-AUDIT.md`. Its numbers are a deterministic heuristic proxy, not a
human judgement, and they say nothing about whether these packages are the right ones until the
execution stage exercises them.

## Retryability

Any single candidate can be regenerated or amended without regenerating the team. Re-running this
stage in incremental or reconciliation mode will match existing packages by candidate name, and a
changed team input invalidates readiness only for the candidates whose content depends on it.
