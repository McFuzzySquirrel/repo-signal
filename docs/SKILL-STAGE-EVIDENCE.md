# Project-skill stage evidence

**Stage:** `forge-build-project-skills` (skills)
**Mode:** headless - authorized defaults, no prompt raised; every handoff candidate re-verified, nothing authored
**Date:** 2026-10-02
**Input:** `docs/SKILL-CANDIDATES.json` - immutable, version 1, 11 candidates
**Launcher-recorded input fingerprint:** `8aefa416aca937c3711e3444cec3f2c4c2f5ca2a97ca682c522b7fbb49f708b0`
(owned by the launcher, recorded at stage start, left untouched here)
**Observable sha256 of the handoff file as read:** `d5803405ff0e565d383bc9d3cf8dc0525b5c2537c1093260d7eaf41e19359b0e`

This file records what was decided and observed for the skills stage. Heuristic quality scores are
deliberately kept out of it: they live in `docs/SKILL-AUDIT.md`, which is the `skill-review`
artifact. This file supersedes the record of the previous run of this stage (commit `ac92feb`), which
covered an earlier handoff; that content is recoverable from git history.

## Stage contract resolution

| Check | Result |
|-------|--------|
| Handoff exists and parses as `{ "version": 1, "candidates": [...] }` | Yes |
| Every candidate has a name, description, consumers, action and reason | Yes, 11 candidates |
| Candidate names are stable kebab-case and unique | Yes |
| Actions are drawn from `reuse`, `extend`, `create`, `omit` | Yes: 9 `reuse`, 0 `extend`, 0 `create`, 2 `omit` |
| Handoff is empty or all-`omit`, which would complete as `no-skills-required` | No - nine `reuse` actions, so the stage ran and completed `complete` |
| Harness, mode, authorization, model resolved before any generation | `opencode` runner, `opencode/space-bunny-free`, headless with supplied authorization; no prompt was raised |

An all-`reuse` handoff is not a no-skills result. It completes as a normal `complete` stage whose
authored outputs are empty, which is what happened here.

The handoff changed between the previous skills stage and this one. At commit `ac9e68a` it carried
nine `create` and two `omit`; at `ac92feb`'s run it carried seven `reuse`, two `extend` and two
`omit`; it now carries nine `reuse` and two `omit`. The two candidates that were `extend` last time -
`archive-storage-discipline` and `verification-loop` - are now `reuse`, on the team's explicit
finding that the extension landed and nothing in the source invalidates it. Every candidate name from
the earlier runs is still present, so no package needed adopting, retiring or matching by a different
name.

## Per-candidate decision

| Candidate | Action | Outcome | Files written |
|-----------|--------|---------|---------------|
| `forge-task-implementation` | reuse | Reused unchanged - responsibility satisfied, review gate green | none |
| `honest-data-rendering` | reuse | Reused unchanged | none |
| `token-and-egress-safety` | reuse | Reused unchanged, with one factual drift recorded in `docs/SKILL-AUDIT.md` and deliberately not edited | none |
| `github-rest-contract` | reuse | Reused unchanged | none |
| `archive-storage-discipline` | reuse | Reused unchanged - the previous run's extension, now asserted by the team | none |
| `cli-command-surface` | reuse | Reused unchanged | none |
| `accessible-server-rendered-views` | reuse | Reused unchanged | none |
| `verification-loop` | reuse | Reused unchanged - the previous run's extension, now asserted by the team | none |
| `documentation-contract-tests` | reuse | Reused unchanged | none |
| `human-review-gate-protocol` | omit | Honoured - nothing authored, nothing deleted, nothing vendored | n/a |
| `node-sqlite-upgrade-drill` | omit | Honoured - nothing authored, nothing deleted, nothing vendored | n/a |

No candidate was downgraded or upgraded from its handoff action. No package was created and none was
extended, because the handoff asked for neither. No package outside the handoff was touched.

The two omitted candidates were not silently dropped. Both absences were checked: neither
`human-review-gate-protocol` nor `node-sqlite-upgrade-drill` has a directory under `.opencode/skills/`,
so the `omit` decisions are honoured in both directions - nothing was authored on their behalf, and
nothing pre-existing was deleted to satisfy them. No retirement marker was written, because
reconciliation did not mark either candidate retired.

## Structural checks

Every line below is observed output, not an expectation. Script:
`/tmp/opencode/skills-stage-2/verify-structure.mjs`, run with the repository root as its argument and
`gray-matter` resolved from `.opencode/skills/skill-review/package.json` so the reviewer and this
script parse frontmatter with the same implementation. Result: 24 of 24 passed, exit 0.

| Check | Result |
|-------|--------|
| Handoff version is 1 and `candidates` is an array | Yes, 11 candidates |
| Every candidate has name, description, consumers, action, reason | Yes |
| Candidate names are unique | Yes |
| Every declared consumer resolves to a file under `.opencode/agents/` | Yes, 59 consumer references across 11 candidates |
| Every `reuse` / `extend` / `create` candidate has a package | Yes, 9 of 9 |
| Frontmatter `name` parses to the exact parent directory name | Yes, 9 of 9 |
| No frontmatter `name` carries wrapping or embedded quote characters | Yes, 9 of 9 |
| `description` is one double-quoted single-line YAML scalar | Yes, 9 of 9 |
| Every Markdown reference is a relative path from the skill root and exists on disk | Yes, 9 of 9 |
| Reference chain depth is one level | Yes - no reference file loads another |
| `SKILL.md` under 500 lines | Yes - 109 to 145 |
| No omitted candidate has a vendored package directory | Yes, 2 of 2 |
| No package on disk is outside the handoff candidate list | Yes - the eight non-tooling project packages on disk are exactly the eight project candidates that are not `forge-task-implementation` |

Names were read as YAML values and compared to the directory name, not compared as source text, so a
JSON-quoted value such as `'"archive-storage-discipline"'` could not have passed silently.

## Boundary checks

| Check | Result |
|-------|--------|
| `docs/SKILL-CANDIDATES.json` unchanged | Yes - pre- and post-run sha256 both `d5803405ff0e565d383bc9d3cf8dc0525b5c2537c1093260d7eaf41e19359b0e` |
| Agent team, ownership and handoff unchanged | Yes - all 12 files under `.opencode/agents/` matched their pre-run digests |
| No execution manifest created or replaced | Yes - `docs/EXECUTION-MANIFEST.json` matched its pre-run digest `1211b1f852a982f59f5c09a6f8bf73a96f432c86ca9da19031cd187bd4cddd32`. It already existed from an earlier execution stage; this stage neither read nor wrote it |
| Unaffected packages byte-for-byte unchanged | Yes - a sha256 of all 151 files under `.opencode/skills/` before and after this run is identical, so nothing at all moved |
| No new or retired package directory | Yes - `git status` shows no added, deleted or renamed path under `.opencode/skills/` |
| Build not started | Yes - no `src/`, `tests/`, `scripts/` or `spikes/` file was created or modified |
| Manifest IDs preserved | Yes - the manifest was not an output of this stage and was not written, so no ID was disturbed |
| No team regeneration | Yes - the 12 agent files and the handoff are unchanged, and no agent description, ownership line or handoff was rewritten |

The only files this run modified are the two evidence artifacts in `docs/` and the launcher's
`docs/authoring-state.json`.

## Review gate outcome

`skill-review` was run against the nine reuse candidates only, never against the whole
`.opencode/skills/` tree, so the pre-existing `forge-*`, `skill-*` tooling skills were not scored as
project skills.

- All nine skills were audited - read out of the report body, which names them, not inferred from
  exit code 0 alone.
- Every one of the six axes scored 3 of 3 for all nine packages.
- No structural issue was reported.
- Exit code 0 with `--min-score 2 --fail-below --min-axis 2 --fail-axis-below --fail-structural`.

Because nothing was authored, this gate is a verification of the team's `reuse` assertions rather
than a gate on new text, and its limits are recorded honestly: a heuristic score says nothing about
whether a package is accurate about this repository. Two hand-run controls confirm the gate is live -
a copy with its `## Validation` section removed exits 1 on the per-axis rule while still scoring 2.5
overall, and a copy with a dangling reference exits 1 on the structural rule. Behavioural checks
against the source, and the one factual drift they found, are in `docs/SKILL-AUDIT.md`.

## Stage status

`docs/authoring-state.json` was updated by the stage: the `skills` stage moved from `running` to
`complete`, the mode was recorded as `headless`, its eleven outputs were listed, and `completedAt` was
set. The launcher's `inputFingerprint` and the whole `invocation` block were left exactly as recorded.

`outputFingerprint` was **not** written. The launcher computes it with tooling that is not present in
this repository, and the previous run of this stage already established that no plausible
reconstruction of the known-good `team` entry reproduces the launcher's digest. Writing a
self-computed value under the launcher's key would look launcher-computed while meaning something
else, so the key is absent rather than wrong. The stage's own honestly labelled digest sweep is the
pre/post sha256 list referenced above.

## Retryability

Any single candidate can be amended without regenerating the team. Re-running this stage in
incremental or reconciliation mode will match existing packages by candidate name; a changed team
input invalidates readiness only for the candidates whose content depends on it. Two follow-ups are
worth carrying into the next team stage rather than this one:

1. The `token-and-egress-safety` Step 6 suite count is stale. The team owns the action, so the fix is
   either a reword in the handoff or an `extend` that a later skills stage can act on.
2. A `reuse` name that resolves outside this repository is not detectable from here, because the
   launcher cannot enumerate every harness's global skill roots. All nine reuse candidates in this
   handoff were verified to resolve project-locally, so the caveat did not bite this run; if a future
   handoff reuses a global package and that package must actually be validated, the team should have
   chosen `extend`.