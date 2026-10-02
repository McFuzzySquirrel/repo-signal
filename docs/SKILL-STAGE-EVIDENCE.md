# Project-skill stage evidence

**Stage:** `forge-build-project-skills` (skills)
**Mode:** headless, authorized defaults, proceeding without prompts
**Date:** 2026-10-02
**Input:** `docs/SKILL-CANDIDATES.json` - immutable, version 1, 11 candidates
**Launcher-recorded input fingerprint:** `bc38cb95ebcb588fd1c9fabb3da726653e1d35407a653ff9759dde99eb61f313`
(owned by the launcher, recorded at stage start, left untouched here)
**Observable sha256 of the handoff file as read:** `b3372b041d0f0c2ef860b42dd898d8b3aaa8269223912f317e0502c7009996ed`

This file records what was decided and observed for the skills stage. Heuristic quality scores are
deliberately kept out of it: they live in `docs/SKILL-AUDIT.md`, which is the `skill-review`
artifact.

## Stage contract resolution

| Check | Result |
|-------|--------|
| Handoff exists and parses as `{ "version": 1, "candidates": [...] }` | Yes |
| Every candidate has a name, description, consumers, action and reason | Yes, 11 candidates |
| Candidate names are stable kebab-case and unique | Yes |
| Actions are drawn from `reuse`, `extend`, `create`, `omit` | Yes: 7 `reuse`, 2 `extend`, 2 `omit` |
| Handoff is empty or all-`omit` (would complete as `no-skills-required`) | No - two `extend` actions, so the stage ran and completed `complete` |
| Harness, mode, authorization, model resolved before generation | `opencode` runner, `opencode/space-bunny-free`, headless with supplied authorization; no prompt was raised |

The handoff changed between the previous skills stage and this one: at commit `ac9e68a` it carried
nine `create` and two `omit` actions, and at commit `37d1110` it carries seven `reuse`, two `extend`
and two `omit`. Every candidate name from the previous run is still present, so no package needed
adopting, retiring or matching by a different name.

## Per-candidate decision

| Candidate | Action | Outcome | Files written |
|-----------|--------|---------|---------------|
| `forge-task-implementation` | reuse | Reused unchanged - the team re-read the task blocks and found no gap | none |
| `honest-data-rendering` | reuse | Reused unchanged | none |
| `token-and-egress-safety` | reuse | Reused unchanged | none |
| `github-rest-contract` | reuse | Reused unchanged | none |
| `archive-storage-discipline` | extend | Extended additively on the runtime floor | `SKILL.md`, `references/write-shape-rules.md` |
| `cli-command-surface` | reuse | Reused unchanged | none |
| `accessible-server-rendered-views` | reuse | Reused unchanged | none |
| `verification-loop` | extend | Extended additively on the runtime floor | `SKILL.md`, `references/failure-recovery.md` |
| `documentation-contract-tests` | reuse | Reused unchanged | none |
| `human-review-gate-protocol` | omit | Honoured - nothing authored, nothing deleted, nothing vendored | n/a |
| `node-sqlite-upgrade-drill` | omit | Honoured - nothing authored, nothing deleted, nothing vendored | n/a |

No candidate was downgraded or upgraded from its handoff action. No package was created, because no
candidate asked for one. No package outside the handoff was touched.

### What the two extensions added

Both extensions answer the same PRD revision of 2026-09-30, which moved the hard engine floor from
"the release where `node:sqlite` dropped `--experimental-sqlite`" to "the release that exposes
`enableDefensive`". The correction is traceable in the immutable input: `docs/PRD.md` 6.1 and 16
question 10, `docs/features/telemetry-storage.md` `RS-DB-01`, and `docs/features/foundation-and-runtime.md`
`RS-FND-01`.

`archive-storage-discipline` gained: the `enableDefensive` guard named as the thing that sets the
floor; 24.12.0 as that floor with 22.13.0 explicitly demoted to a milestone that cannot run the
archive; the rule that a `PRAGMA` is not a substitute for `SQLITE_DBCONFIG_DEFENSIVE`; the fail-closed
behaviour when the runtime lacks the API; a `## Connection settings` reference section; two gotchas
including the import-succeeds-then-connection-fails symptom; and two validation items. Its steps 2 to
7, its per-table write rules and its structure were left as they were.

`verification-loop` gained: the corrected floor and corrected symptom in its gotcha, the corrected
`node:sqlite` row in the recovery table, and a new row for the connection-time API-drift error. Its
wrapper rule, type-check step, mirroring convention, temporary-home rule and spawn-not-import rule
were left as they were.

## Structural checks

Every line below is observed output, not an expectation. Script: `/tmp/opencode/skills-stage/verify-structure.mjs`,
executed from `.opencode/skills/skill-review` so `gray-matter` resolves. Result: 22 of 22 passed,
exit 0.

| Check | Result |
|-------|--------|
| Frontmatter `name` parses to the exact parent directory name | Yes, 2 of 2 (`archive-storage-discipline`, `verification-loop`) |
| No frontmatter `name` carries wrapping or embedded quote characters | Yes, 2 of 2 |
| `description` is one double-quoted single-line YAML scalar | Yes, 2 of 2 |
| Every Markdown reference is a relative path from the skill root and exists on disk | Yes, 2 of 2 |
| Reference chain depth is one level | Yes - no reference file loads another |
| `SKILL.md` under 500 lines | Yes - 145 and 110 |
| The retired Node 22.13 floor no longer appears as a floor | Yes - no old phrasing remains in either package |

Names were written as YAML string values, not as JSON-encoded strings: the value
`name: archive-storage-discipline` parses to `archive-storage-discipline`, which the script compared
against the directory name rather than trusting the source text.

## Boundary checks

| Check | Result |
|-------|--------|
| `docs/SKILL-CANDIDATES.json` unchanged | Yes - `sha256sum -c` against the pre-run digest returned `OK` |
| Agent team, ownership and handoff unchanged | Yes - all 12 files under `.opencode/agents/` matched their pre-run digests |
| No execution manifest created or replaced | Yes - `docs/EXECUTION-MANIFEST.json` matched its pre-run digest. It already existed from an earlier execution stage, so the previous run's claim that it did not exist no longer applies |
| Unaffected packages byte-for-byte unchanged | Yes - a sha256 of all 151 files under `.opencode/skills/` before and after differs in exactly the four files belonging to the two `extend` candidates |
| No new package directory created | Yes - `git status` shows four modified files and no untracked file under `.opencode/skills/` |
| Build not started | Yes - no `src/`, `tests/`, `scripts/` or `spikes/` file was created or modified |
| Manifest IDs preserved | Yes - the manifest was not read as an output and not written, so no ID was disturbed |

## Review gate outcome

`skill-review` was run against the two changed candidate files only, never against the whole
`.opencode/skills/` tree, so the pre-existing `forge-*` tooling skills were not scored as newly
generated project skills.

- Every axis of both candidates scored 3 of 3.
- No structural issue was reported.
- Exit code 0 with `--min-score 2 --fail-below --min-axis 2 --fail-axis-below --fail-structural`.

One near-miss is worth recording: `--files` is variadic, and passing the two paths as one
comma-separated argument made the tool print `Missing files` and `No skill files to audit.` while
still exiting 0. The pass above was therefore confirmed by reading the report body - it names two
audited skills - and not by the exit code alone. A sensitivity control is recorded in
`docs/SKILL-AUDIT.md`: the same gate exits 1 against a `/tmp` copy with a missing axis, which
proves the gate is live.

## Stage status

`docs/authoring-state.json` was updated by the stage: the `skills` stage moved from `running` to
`complete`, its four outputs were listed, and `completedAt` was set to `2026-10-02T10:10:56.713Z`.
The launcher's `inputFingerprint` and the whole `invocation` block were left exactly as recorded.

`outputFingerprint` was **not** written. The launcher computes it with tooling that is not present in
this repository, and nine plausible reconstructions over the known-good `team` entry - concatenated
bytes in order and sorted, concatenated hex digests with and without a trailing newline, `sha256sum`
lines, and two JSON shapes - none reproduced the recorded
`d34a07071de1d951d52efd90814871c67c9a5b1b81509ca75d565c4828ee7d20`. Writing a self-computed value
under the launcher's key would have looked launcher-computed while meaning something else, so the key
is absent rather than wrong. An equivalent, honestly labelled digest for this run's four outputs is
available from the same sha256 sweep recorded above.

## Retryability

Any single candidate can be amended without regenerating the team. Re-running this stage in
incremental or reconciliation mode will match existing packages by candidate name; a changed team
input invalidates readiness only for the candidates whose content depends on it. A `reuse` name that
resolves nowhere is not detectable from this stage, because the launcher cannot enumerate every
harness's global skill roots - if a project-local package must really be validated, the team should
have chosen `extend`.
