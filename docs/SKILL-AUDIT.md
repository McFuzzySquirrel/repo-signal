# Skill Audit Report

**Generated:** 2026-10-02
**Audited by:** `skill-review` (`.opencode/skills/skill-review`, tsx script, stdout provider)
**Skills audited:** 9 - the nine candidates whose handoff action was `reuse`
**Scope:** every candidate this stage was asked to honour as an existing package. The two `omit`
candidates have no package and were not passed to the reviewer. The pre-existing `forge-*`, `skill-*`
tooling skills were deliberately **not** passed, so no bootstrapped tooling skill was scored as a
project skill.

This file supersedes the audit of the previous run of this stage (commit `ac92feb`), which covered
the two candidates whose action was then `extend`. That content is recoverable from git history.

## Command run

```bash
npm --prefix .opencode/skills/skill-review run skill-review -- \
  --files .opencode/skills/forge-task-implementation/SKILL.md \
          .opencode/skills/honest-data-rendering/SKILL.md \
          .opencode/skills/token-and-egress-safety/SKILL.md \
          .opencode/skills/github-rest-contract/SKILL.md \
          .opencode/skills/archive-storage-discipline/SKILL.md \
          .opencode/skills/cli-command-surface/SKILL.md \
          .opencode/skills/accessible-server-rendered-views/SKILL.md \
          .opencode/skills/verification-loop/SKILL.md \
          .opencode/skills/documentation-contract-tests/SKILL.md \
  --provider stdout --min-score 2 --fail-below --min-axis 2 \
  --fail-axis-below --fail-structural
```

Exit code: **0**. `--files` is variadic, so the nine paths must be separate arguments; a
comma-separated single argument is silently reported as a missing file, the run then prints
`No skill files to audit.` and still exits 0. The result below was therefore read out of the report
body - it names nine audited skills - and not taken from the exit code alone.

## Summary scores

| Skill | Context economy | Gotchas coverage | Procedural clarity | Progressive disclosure | Calibration | Validation | Overall |
|-------|-----------------|------------------|--------------------|------------------------|-------------|------------|---------|
| `forge-task-implementation` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `honest-data-rendering` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `token-and-egress-safety` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `github-rest-contract` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `archive-storage-discipline` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `cli-command-surface` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `accessible-server-rendered-views` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `verification-loop` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| `documentation-contract-tests` | 3 | 3 | 3 | 3 | 3 | 3 | 3 |

**Score interpretation (as reported by the tool):**
- 2.5-3.0: Strong - follows best practices well
- 1.5-2.4: Adequate - works but has improvement opportunities
- 1.0-1.4: Needs work - significant gaps against best practices

No axis fell below 2, and no structural issue was reported, for any of the nine. A strong average
was not accepted as a substitute for either gate: both `--fail-axis-below` and `--fail-structural`
were enabled, and the sensitivity controls below show both can go red on this tool.

## What this run changed

Nothing. All nine packages were reused unchanged, so the review confirms the packages the previous
run left in place; it introduced no edit to any of them.

## Gate sensitivity controls

A green exit code is evidence only if the gate can go red. Both controls ran against throwaway
copies under `/tmp/opencode/skills-stage-2/control/`, outside the repository, and no project file
was involved.

| Control | Mutation | Blocking line | Exit |
|---------|----------|---------------|------|
| A - per-axis gate | copy of `documentation-contract-tests` with its `## Validation` section removed (23 lines) | `Quality axes below minimum (2): - doc-no-validation: Validation=1` | **1** |
| B - structural gate | copy of `documentation-contract-tests` with one reference retargeted at `references/no-such-file.md` | `2 structural issue(s) found across 1 skill(s)`, naming the missing referenced file | **1** |

Control A also demonstrates the average-only trap concretely: the mutated copy still scored **2.5
overall**, above `--min-score 2`, so only the per-axis gate stopped it. Control B is the concrete
form of the "references are files" rule - a Markdown link to a missing reference is a blocking
structural failure, not advisory. Control B also shows the reviewer applies the same
frontmatter-name-versus-directory check this stage's structural script mirrors.

## Behavioural evidence, kept separate from the scores

The scores above are a deterministic heuristic proxy. They say nothing about whether a package is
accurate about this repository, and they were not treated as such. The following were checked by
hand against the source instead.

### Claims verified against the source

| Claim in the package | How it was checked | Result |
|-------|--------------------|--------|
| `archive-storage-discipline`: `enableDefensive` sets the floor, 24.12.0 or newer | `src/db/connection.js` | Guard at lines 14-17 refuses a runtime lacking the method and names 24.12.0; `db.enableDefensive(true)` at line 26 |
| `archive-storage-discipline`: forward-only migrations with content checksums | `src/db/migrate.js`, `src/db/migrations/001-core-schema.js` | `schema_migrations.checksum` is `TEXT ... length = 64`; digests are SHA-256 over the migration source; recorded checksums are validated before any write |
| `verification-loop`: a zero-test selection fails the run | `scripts/run-tests.mjs` | Lines 203-215 throw when the runner selects 0 tests from named files, twice, once per code path |
| `verification-loop`: type-check over `checkJs` JSDoc types | `tsconfig.json` | `"checkJs": true` with `"noEmit": true` |
| `verification-loop`: tests mirror the source layout | `tests/` against `src/` | `tests/day-series-repo.test.js`, `tests/github-http.test.js`, `tests/router.test.js` and 24 others sit at the mirrored path |
| `cli-command-surface`: one registry, 0 / 1 / 2 exit contract, spawn-not-import | `src/commands/index.js` | `EXIT_SUCCESS = 0`, `EXIT_OPERATIONAL_FAILURE = 1`, `EXIT_USAGE_ERROR = 2`, `registerCommand`, `resolveCommand`, `UsageError` all present; 8 of the inventory's 9 commands registered so far (`collect` and `serve` are `RS-COL-03` / `RS-UI-01`, not yet built) |
| `github-rest-contract`: 2026-03-10 version constant | `src/github/http.js` | `export const GITHUB_API_VERSION = '2026-03-10'` |
| `github-rest-contract`: 14-day traffic window bound | `src/github/traffic-client.js` | Line 93 rejects a day breakdown longer than 14 entries |
| `github-rest-contract`: 202 retryable only for statistics | `src/github/retry.js`, `src/github/stats-client.js` | `status === 202 && endpointType === 'statistics'` gates the retry; a non-statistics 202 is returned untouched |
| `github-rest-contract`: stargazer star-timestamp media type, last-page pagination | `src/github/stars-client.js` | `STARGAZER_ACCEPT = 'application/vnd.github.star+json'`; pagination follows the RFC 8288 `Link` header, never a page count |
| `honest-data-rendering`: a stored zero is distinguishable from a missing day | `src/db/day-series-repo.js` | `export function calendarDays(from, to)` at line 40 |
| `token-and-egress-safety`: the local-transport gate exists and is read in the transport | `src/github/http.js` | `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` is referenced in the transport and set per-process by tests |
| `accessible-server-rendered-views`: one escaping helper per context, plus the shared shell | `src/server/html.js` | `escapeText`, `escapeAttribute`, `escapeUrl`, `documentShell` exported at lines 15, 30, 44, 64 |
| `forge-task-implementation`: the version-2 task contract shape | `docs/features/*.md` | Forge-task blocks carry `"version": 2` |

### One factual drift found, in a package this run reused

`token-and-egress-safety/SKILL.md`, Step 6, states in the present tense:

> "The **five** test suites that use the local stub - collect command, discover command, collection
> end-to-end, server end-to-end and dashboard end-to-end - set it only for the child process they
> spawn or for their own test process..."

Only one of those five exists and sets the gate today:

| Suite named in the package | File today | Sets `REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT` |
|------|--------|------|
| collect command | absent | - |
| discover command | `tests/discover-command.test.js` | yes (line 56) |
| collection end-to-end | absent | - |
| server end-to-end | `tests/server.test.js` | no |
| dashboard end-to-end | absent | - |

`tests/github-http.test.js` does set and delete the flag around its own cases, but it is the
transport unit suite, not one of the five stub consumers.

This is drift in a countable claim, not in the rule the package teaches: the gate, the allowlist,
the redaction boundary and the four named assertions all still match the source, and the guidance
remains correct for the suites that will be built. The package was nevertheless left
**byte-for-byte unchanged**, because its handoff action is `reuse` and the stage may not edit an
unaffected package. Fixing it belongs to the team stage, which owns the action: either reword Step 6
to name the suites that exist, or move the candidate to `extend` so a later skills stage can correct
it. Recorded here so the next team run sees it rather than inheriting it silently.

### Packages whose claims are deliberately forward-looking

These two state obligations for surfaces that do not exist yet. They are specifications for later
tasks, not assertions about the current tree, so the current tree does not falsify them:

- `cli-command-surface/references/command-inventory.md` - a nine-row table keyed to owning task IDs;
  `collect` (`RS-COL-03`) and `serve` (`RS-UI-01`) are not registered yet. The package makes no count
  claim about the live registry, so there is no drift.
- `documentation-contract-tests` - requires tests asserting the README still states no-fabrication,
  redistribution, permission and Node-range. `README.md` is currently three lines with none of those
  statements; the package is the procedure for the operations tasks that must add them and the tests
  that keep them.

## Not audited

`human-review-gate-protocol` and `node-sqlite-upgrade-drill` carry an `omit` action, so no package
exists for either and nothing was vendored on their behalf. There was nothing to score.

## Next steps

A human reviewer still owns two judgements this proxy cannot make:

1. Whether the `enableDefensive` framing in `archive-storage-discipline` matches what the vendor
   actually exposes on the 24.12.0 line, and whether the connection-time failure mode described in
   `verification-loop` is the message the runtime really produces. Both are recorded against PRD 6.1
   and PRD 16 Q10 and can be re-checked against
   `https://nodejs.org/docs/latest-v24.x/api/sqlite.html`.
2. Whether Step 6 of `token-and-egress-safety` should be reworded now or corrected as an `extend` in
   the next team stage, as described above.