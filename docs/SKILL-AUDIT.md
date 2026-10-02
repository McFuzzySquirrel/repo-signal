# Skill Audit Report

**Generated:** 2026-10-02
**Audited by:** `skill-review` (`.opencode/skills/skill-review`, tsx script, stdout provider)
**Skills audited:** 2 - `archive-storage-discipline`, `verification-loop`
**Scope:** the two candidates whose handoff action was `extend`. The seven `reuse` candidates and the
pre-existing `forge-*` tooling skills were deliberately **not** passed to the reviewer, so no
bootstrapped tooling skill was scored as a newly generated project skill.

## Command run

```bash
npm --prefix .opencode/skills/skill-review run skill-review -- \
  --files .opencode/skills/archive-storage-discipline/SKILL.md \
          .opencode/skills/verification-loop/SKILL.md \
  --provider stdout --min-score 2 --fail-below --min-axis 2 \
  --fail-axis-below --fail-structural
```

Exit code: **0**. `--files` is a variadic option, so the two paths must be separate arguments; a
comma-separated single argument is silently reported as a missing file and the run then prints
`No skill files to audit.` while still exiting 0. That near-miss was observed during this run and is
why the exit code alone was not treated as the result - the report body was read to confirm two
skills were actually audited.

## Summary scores

| Skill | Context economy | Gotchas coverage | Procedural clarity | Progressive disclosure | Calibration | Validation | Overall |
|-------|-----------------|------------------|--------------------|------------------------|-------------|------------|---------|
| `archive-storage-discipline` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `verification-loop` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |

**Score interpretation (as reported by the tool):**
- 2.5-3.0: Strong - follows best practices well
- 1.5-2.4: Adequate - works but has improvement opportunities
- 1.0-1.4: Needs work - significant gaps against best practices

No axis fell below 2 and no structural issue was reported for either package.

## Per-skill findings

### `archive-storage-discipline`

**Overall score:** 3 (strong) - **Path:** `.opencode/skills/archive-storage-discipline/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)

**Strengths:** strong on all six axes.

**Improvement opportunities:** none reported by the heuristic.

**What this run changed** (for the human reviewer, not a suggestion):
- frontmatter `description` now names the `enableDefensive` guard, matching the candidate description.
- Step 1 states the 24.12.0 floor as the `enableDefensive` release, demotes 22.13.0 to a different
  milestone that cannot run the archive, adds the PRAGMA-is-not-a-substitute rule, and states the
  fail-closed behaviour when the runtime lacks the API.
- Two gotchas added: the import-succeeds-then-connection-fails symptom, and the defensively-looking
  `PRAGMA`.
- Two validation items added: prove the defensive setting by reading the connection back, and prove
  the fail-closed error.
- `references/write-shape-rules.md` gained a `## Connection settings` section and a `## Per-table
  rules` heading above the untouched per-table table; the reference load trigger now also fires on
  opening or changing the connection settings.

### `verification-loop`

**Overall score:** 3 (strong) - **Path:** `.opencode/skills/verification-loop/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)

**Strengths:** strong on all six axes.

**Improvement opportunities:** none reported by the heuristic.

**What this run changed** (for the human reviewer, not a suggestion):
- the Node-floor gotcha now says a host below 24.12 imports `node:sqlite` and fails at
  `new DatabaseSync(...)` with an unknown-option or missing-method error, instead of failing at
  import time on a missing experimental flag.
- `references/failure-recovery.md` had its `node:sqlite` row corrected to the 24.12.0 floor and a new
  row added for the connection-time API-drift error.
- The wrapper rule, the type-check step, the mirroring convention, the temporary-home rule, the
  spawn-not-import rule and the frontmatter description are unchanged.

## Gate sensitivity control

A green exit code is only evidence if the gate can go red. The same gate was run against a throwaway
copy of `verification-loop` under `/tmp` with its `## Validation` section removed:

| Metric | Value |
|--------|-------|
| Overall score | 2.7 (still above `--min-score 2`) |
| Failing axis | `verification-loop: Validation=1` |
| Exit code | **1** |
| Blocking line | `Quality axes below minimum (2): - verification-loop: Validation=1` |

This is the concrete demonstration of the "average-only review is unsafe" rule: an average of 2.7
would have passed the score gate, and the per-axis gate is what stopped it. The control file lives
outside the repository and no project file was involved.

## Behavioural evidence, kept separate from the scores

The scores above are a deterministic heuristic proxy. They say nothing about whether the packages are
the right ones, and they were not treated as such. The following were checked by hand instead:

| Claim | How it was checked | Result |
|-------|--------------------|--------|
| Frontmatter `name` equals its parent directory, with no wrapping quotes | Parsed with `gray-matter` and compared to the directory name | Both match; no quote characters present |
| Both `description` values are one double-quoted single-line YAML scalar | Regex on the raw frontmatter line | Both match |
| Every Markdown reference resolves on disk | Extracted every `](...)` target and stat-ed it from the skill root | Both targets exist |
| Reference chain depth is one | Scanned every `references/` file for further `.md` links | None found |
| `SKILL.md` under 500 lines | Line count | 145 and 110 |
| The retired 22.13 floor is gone | Grep for the old floor phrasings across both packages | No occurrence remains; the two surviving `22.13.0` mentions explicitly mark it as *not* a supported line |
| The corrected floor is traceable to the immutable input | Read `docs/PRD.md` 6.1 and 16 (Q10), `docs/features/telemetry-storage.md` RS-DB-01, `docs/features/foundation-and-runtime.md` RS-FND-01 acceptance criteria | All three name 24.12.0 as the `enableDefensive` floor |

The structural assertions above were executed by a script whose output is recorded in
`docs/SKILL-STAGE-EVIDENCE.md`; the reviewer was not asked to infer them from prose.

## Not audited

The following packages exist under `.opencode/skills/` and were left byte-for-byte unchanged by this
run, so they were not re-scored: `forge-task-implementation`, `honest-data-rendering`,
`token-and-egress-safety`, `github-rest-contract`, `cli-command-surface`,
`accessible-server-rendered-views`, `documentation-contract-tests`. They carry a `reuse` action,
which asserts the team re-read them against the source and found no gap. Re-scoring them here would
have produced no new evidence and would have muddied the record of what this run changed.

## Next steps

A human reviewer still owns the judgement this proxy cannot make: whether the `enableDefensive`
framing in `archive-storage-discipline` matches what the vendor actually exposes on the 24.12.0 line,
and whether the connection-time failure mode described in `verification-loop` is the message the
runtime really produces. Both are recorded against PRD 6.1 and PRD 16 Q10 and can be re-checked
against `https://nodejs.org/docs/latest-v24.x/api/sqlite.html`.
