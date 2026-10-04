# Skill audit report: project-skill stage

**Generated:** 2026-10-04
**Audited by:** `skill-review` (deterministic reviewer-style proxy, not a human judgement)
**Stage:** `forge-build-project-skills`, mode `headless`
**Candidates audited:** 9 of 12 (`docs/SKILL-CANDIDATES.json`)

This is a separate review artefact. It is deliberately not written to the conventional audit path,
because that path is inside the repository and the skills stage must not add a document claim that no
named test asserts; `RS-C12` makes an unasserted document into drift.

## Scope

Only the changed handoff candidates were passed to the reviewer. The bootstrapped `forge-*` tooling
skills and `skill-creator`, `skill-review`, `skill-review-updater` were not scanned as newly generated
project skills.

| Candidate | Action in handoff | Outcome |
|-----------|-------------------|---------|
| `forge-task-implementation` | `reuse` | resolved outside this stage; nothing authored |
| `verification-loop` | `create` | authored, gated |
| `honest-data-rendering` | `create` | authored, gated |
| `token-and-egress-safety` | `create` | authored, gated |
| `github-rest-contract` | `create` | authored, gated |
| `archive-storage-discipline` | `create` | authored, gated |
| `cli-command-surface` | `create` | authored, gated |
| `accessible-server-rendered-views` | `create` | authored, gated |
| `documentation-contract-tests` | `create` | authored, gated |
| `interactive-terminal-setup` | `create` | authored, gated |
| `human-review-gate-protocol` | `omit` | no package authored; the prohibition already lives in the task contract's `reviewFile` |
| `node-sqlite-upgrade-drill` | `omit` | no package authored; a single future event, and the guidance is inside `archive-storage-discipline` |

## Gate command

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

Exit code 0. No structural issue and no axis below 2 across the changed set.

## Summary scores

Heuristic scores from the rubric, reported separately from the behavioural evidence below.

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

The first pass scored procedural clarity at 2 for `token-and-egress-safety`, `cli-command-surface` and
`interactive-terminal-setup`, because each stated a decision across a line break and the rubric reads a
decision criterion on one line. Each of the three now carries an explicit `if ... then` decision in the
step it belongs to, and all nine score 3 on every axis.

## Behavioural evidence, separate from the heuristic scores

The rubric cannot see whether a skill is true. Each of these was checked against the repository.

| Claim the skill makes | Where it was checked |
|-----------------------|---------------------|
| `npm test` runs the wrapper that fails on a zero-test selection, and names five distinct refusals | `scripts/run-tests.mjs`, one refusal per early return |
| The pipeline runs a clean install, type check, suite and backup drill on the floor and the current LTS line | `.github/workflows/ci.yml` |
| The Node floor is 24.12.0 and the archive fails closed without the defensive option | `src/db/connection.js` names the running version and the floor |
| Repository state words and their fixed precedence | `src/supervision/health.js` and PRD section 10 |
| The credential file is refused at any mode other than 0600, naming the observed mode | `src/credentials/store.js` |
| Redaction strips token-shaped and bearer values and returns text, not an error object | `src/credentials/redact.js` |
| The pinned API version, the header set, the allowlist conditions and the redirect refusal | `src/github/http.js` |
| The 14-entry day bound, the 30-week page, the 100-page cap and the week-total refusal | `src/github/traffic-client.js`, `src/github/stars-client.js` |
| The stargazer listing restriction and its changelog date | `src/github/stars-client.js`, `src/github/retry.js`, PRD section 5 |
| Eleven registered commands with their usage shapes, and `setup` as the twelfth to land | `src/commands/index.js`, and the registry task in the setup feature |
| `--help` is global before the command name, and `serve` is the only command that parses its own | `src/cli.js`, `src/commands/serve.js` |
| `discover` and `report` print a pointer to their own `--help` that they do not parse | `src/commands/discover.js`, `src/commands/report.js`, PRD open question 2 |
| Escaping helpers per context, the shell, and the chart pairing helper | `src/server/html.js`, `src/server/views/a11y.js` |
| Contrast thresholds, declared pairs by role, and the rule that no other file declares a colour literal | `tests/contrast.test.js` |
| One polyline per contiguous run, a marker for a lone day, gap rows that say so in words | `src/views/components/line-chart.js` |
| Eleven document-plus-contract pairs, all owned by one agent | the task blocks in `docs/features/*.md` |
| Contract tests import the constant they assert rather than restating it | `tests/ci-contract.test.js`, `tests/release-contract.test.js`, `tests/troubleshooting-contract.test.js` |
| The three human gates, their review artefacts, and the schema version, Node range and licence authorities | `docs/operations/release-checklist.md` |
| Eight task blocks for the setup surface, and both invisible-in-a-passing-run failure modes | `docs/features/setup-terminal-ui.md` |

## Limits of this review

- The score is a deterministic proxy. It counts structure, not correctness, and no skill here has been
  exercised by an agent running a task against it.
- `forge-task-implementation` was recorded as `reuse`. That name resolves outside this stage, so it was
  not audited as a changed file and its absence from a project-local package is not a failure.
- Two handoff candidates carry an empty consumer list because the tasks that name them belong to agents
  the adopted team does not contain. The packages were still authored, because the responsibility is
  real; whether an agent will use them is a team question, not a skills question.