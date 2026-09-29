# Skill Audit Report

> **Scope.** This report covers only the nine packages this stage created, named as
> `create` candidates in `docs/SKILL-CANDIDATES.json`. The pre-existing `forge-*` tooling skills
> were not audited: they are not handoff candidates and were left byte-for-byte unchanged.
>
> **Evidence class.** Every score below is a deterministic heuristic proxy produced by
> `skill-review`'s rubric script, not a human judgement. Behavioural evidence for this stage is
> recorded separately in `docs/SKILL-STAGE-EVIDENCE.md` and is not mixed into these numbers.
>
> **Command.**
> `npm run skill-review -- --files <the nine candidate SKILL.md files> --provider stdout
> --min-score 2 --fail-below --min-axis 2 --fail-axis-below --fail-structural` (exit 0).
> Run from `.opencode/skills/skill-review`. An average is advisory; every axis and every structural
> check must pass.

---

**Generated:** 2026-09-29
**Audited by:** `skill-review`
**Skills audited:** 9

---

## Summary Scores

| Skill | Context economy | Gotchas coverage | Procedural clarity | Progressive disclosure | Calibration | Validation | Overall |
|-------|---|---|---|---|---|---|---------|
| `forge-task-implementation` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `honest-data-rendering` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `token-and-egress-safety` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `github-rest-contract` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `archive-storage-discipline` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `cli-command-surface` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `accessible-server-rendered-views` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `verification-loop` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `documentation-contract-tests` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |

**Score interpretation:**
- 2.5–3.0: Strong - follows best practices well
- 1.5–2.4: Adequate - works but has improvement opportunities
- 1.0–1.4: Needs work - significant gaps against best practices

---

### `forge-task-implementation`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/forge-task-implementation/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `honest-data-rendering`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/honest-data-rendering/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `token-and-egress-safety`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/token-and-egress-safety/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `github-rest-contract`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/github-rest-contract/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `archive-storage-discipline`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/archive-storage-discipline/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `cli-command-surface`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/cli-command-surface/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `accessible-server-rendered-views`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/accessible-server-rendered-views/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `verification-loop`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/verification-loop/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

### `documentation-contract-tests`
**Overall score:** 3 🟢 (strong)
**Path:** `/home/mcfuzzysquirrel/Projects/repo-signal/.opencode/skills/documentation-contract-tests/SKILL.md`
**Reviewer-style proxy:** 3 (proxy)
**Strengths:**
- Strong context economy
- Strong gotchas coverage
- Strong procedural clarity
- Strong progressive disclosure
- Strong calibration
- Strong validation
**Improvement opportunities:** None - all axes scored 3

---

## Stage Note

All nine candidates scored 3 on all six axes with no structural issue, so the tool's suggested-change
list is empty for every package. Real-world execution feedback - whether a specialist actually finds
these packages useful, and whether any rule is wrong for the code it eventually governs - is the
input this proxy cannot supply, and it belongs to the execution stage, not to this one.
