# Project Idea

## Repository Adoption Intelligence

**Stars tell you who liked it.
Forks tell you who copied it.
Clones tell you who got it.
RepoSignal tries to tell you what happened next.**

A local-first tool that helps an open-source maintainer understand how their GitHub
repositories are actually being discovered, used, and adopted — beyond stars and forks.

Stars and forks are intentional social actions. A clone is much closer to "I needed this
code." It still doesn't prove production use (someone can clone a repo to glance at it),
but it is a materially different signal, and today it is also the signal a maintainer can
see for the shortest time. GitHub's traffic API only exposes the last 14 days.

That constraint is the product. RepoSignal periodically collects a maintainer's own repo
telemetry, stores each observation immutably, and gradually builds the adoption history
GitHub itself will never hand you. Then it shows that history as evidence.

The goal is not to claim a clone proves real-world usage, and not to reduce everything to
a single popularity score. It is to give a maintainer a richer set of evidence about what
is happening around their project, and to be honest about the limits of that evidence.

### The signal dimensions

| Dimension | Signals | Source |
|---|---|---|
| ⭐ Recognition | Stars, star growth, watchers | Backfillable (`starred_at`) |
| 🍴 Propagation | Forks, fork growth | Backfillable via repo record |
| 📥 Acquisition | Clones, unique cloners | Collection only — 14-day window |
| 👀 Interest | Views, unique visitors | Collection only — 14-day window |
| 🔗 Discovery | Referrers, popular paths | Collection only — top 10, no dates |
| 🔨 Development | Commits, contributors, PRs | Free 52-week `/stats/*` backfill |
| 💬 Community | Issues, PRs, discussions | Partial backfill (future) |
| 📦 Usage | Releases, package/container downloads | GitHub releases now; ecosystems later |

Clones are the centre of gravity. Compare:

> **1,200 stars / 8,500 unique cloners**
>
> **8,000 stars / 900 unique cloners**

Those are different stories. The first has a small visible community and substantial
actual developer interest. The second looks far more popular than it is used.

**A clone ≠ adoption, and the tool must never pretend otherwise.**

## User

A solo open-source maintainer, looking at their own personal repositories, in the moment
where they want to know *is anyone actually using this work?* Not an org admin, not a team
lead building a business case, not a portfolio of other people's projects.

## Distribution

Local-first, single-user, no public signup. If it works for one maintainer across their own
repos over 90 days, the idea is proven.

- **Node/TypeScript CLI** with two subcommands: `collect` (idempotent, cron-safe, safe to
  run unattended forever) and `serve` (dashboard on `127.0.0.1`).
- **No desktop packaging.** There is no reason this needs to be a window.
- **No hosted service, no accounts, no email, no sessions.**

## Credentials

One fine-grained personal access token per install, in a gitignored config file with
`0600` permissions.

The traffic endpoints (`/traffic/clones`, `/traffic/views`, `/traffic/popular/referrers`,
`/traffic/popular/paths`) require **write** access to the repository. For a fine-grained
PAT or GitHub App this means the **Administration: read** permission — not Contents — and a
`403` persists until that is granted and the installation accepts the upgrade.

The token sits behind a credential interface so an OAuth or GitHub App path can replace it
later without the collector changing.

## Collection

- **Cadence:** daily around 09:00 UTC, plus a manual `--now` for a spike check. The data is
  day-resolution; hourly collection buys nothing.
- **Day-series signals** (clones, views) **upsert by `owner/repo/date`**, last write wins.
  GitHub can revise a 14-day window, and this makes revisions self-correcting.
- **Referrers and popular paths** are top-10 with no timestamps, so they are stored as
  **append-only timestamped snapshots** — there is no day dimension to correct.
- **Every row records its collection time**, so a later revision is distinguishable from a
  later day.
- Rate-limit headers are respected, not brute-forced. `/stats/*` returns `202` while GitHub
  compiles its cache; those calls retry with backoff.

GitHub returns the same 14 days on every request. Collection is the only way to see day 15.

## Data

A single SQLite file, with a schema-migration mechanism in place from the first commit.
The data is append-only and will be lived with for years.

- Day-series facts in one table keyed by repo + date.
- Separate snapshot tables for referrers, popular paths, and backfill records.
- A `source` column marking each row `backfill` or `collected`.

## Cold start

A brand-new install has no history, because GitHub will not give it any. Some signals are
cheaply reconstructable on first connect; others are gone before you can ask.

**Backfilled on first connect:**
- Full star history, via `Accept: application/vnd.github.star+json` (one paginated pass)
- 52 weeks of commit and contributor activity, free from `/stats/participation` and
  `/stats/commit_activity`

**Not backfilled:** commits, PRs, and issues by pagination. Six repos of full history is a
lot of API budget for a chart nobody looks at, and the `202` retry behaviour makes it
fragile.

**Unrecoverable, ever:** clones, views, referrers, popular paths.

The dashboard therefore shows the live 14-day window immediately, labelled as *since
connection, not history*, and draws a visible provenance boundary where collected data
begins. Every backfilled day is marked with its `source`.

**No fabricated clone history. A made-up adoption curve is the one thing that would make
this product a lie.**

## Insight layer (v1)

Descriptive only. Evidence, not verdicts.

- Week-over-week and 7d-vs-prior-7d deltas on every series
- A stars-vs-clones divergence indicator
- A flat list of what changed
- Gaps rendered as gaps — never as zeros, never interpolated

**No adoption score. No composite ranking. No anomaly claims. No thresholds. No
"🟢 clone activity increasing."**

Named signals with explicit minimum-volume floors arrive only after 90 days of real data to
calibrate against. A repo with 3 clones/day will report a 300% increase on a single clone;
"clones went 3 → 9" is honest, "adoption is surging" is not.

## Ecosystem metrics

npm, PyPI, Docker Hub, NuGet, and friends are **explicitly later** — and they are arguably
the best signal in the whole product, since 90+ days of download history beats 14 days of
clones. Package downloads are closer to proof-of-use than anything GitHub exposes.

The schema is shaped so each ecosystem is a **new source of day-series rows** and nothing
else changes. That is the discipline: do not build the connector abstraction before the
GitHub-only path works end to end, or the interface will be guessed wrong. If the schema
is right, ecosystem metrics are additive forever.

## Repo enrollment

**Explicit list in config, plus `repo-signal discover`** — which lists everything the token
can reach and prints ready-to-paste config lines.

Opt-in by construction: nothing is collected until it is named. A token with
Administration: read can see an entire org, so "track everything by default" would mean
shared maintainers can never opt out. Deny lists exist for anyone who wants broad
enrollment.

## Frontend

Server-rendered pages, one hand-rolled SVG chart component, no chart library.

No React, no bundler, no build step, so the tool stays `git clone && node src/cli.js` and
keeps running years from now. Repo and date range live in the URL. `serve` binds to
`127.0.0.1` only. If interactivity becomes genuinely painful, a client-side island earns
its place then — not before.

## Durability is v1, not v2

The premise is long-term accumulation, so these decide whether there is any data in March.
None are interesting features; all are load-bearing.

- Collector is idempotent and safe to re-run after failure
- Heartbeat and per-repo error state, so a silent death is visible *in the dashboard*
- Gaps render as gaps, never as zeros or interpolation
- Token expiry surfaces an explicit re-authenticate state, not an auth error in a log
- Documented backup-and-migrate story for the SQLite file
- Rate-limit headers respected

**Acceptance test for v1:** install it, connect 6 repos, let it run 90 days unattended, and
the history is complete and correct.

## Privacy and data handling

- The SQLite file and credential file live in a gitignored directory, never in the repo tree
- The token is never logged, never echoed in errors, and never sent anywhere but
  `api.github.com`
- No outbound telemetry of any kind — outbound calls would break the local-first promise
- The token is read-only for the collector's purposes
- The README states plainly that repository traffic data is GitHub's aggregate data, not
  ours to redistribute

## Open source posture

Public, with a permissive license. The config format and SQLite schema are **versioned
public contracts**. Repository renames, transfers, and deletions are handled explicitly — a
repo that stops existing is marked, not a collector crash.

The portability of "anyone can run this on their own repos" is also the honest test of
whether the idea works at all.

## Success signals

Falsifiable, and measured after 90 days:

- The collector survived 90 unattended days with no manual intervention
- The history has no unexplained gaps
- The 14-day-gap problem proved tolerable rather than fatal
- At least three questions answered that **only the archive could answer** — e.g. "clones
  doubled after the Reddit thread but stars didn't move," or "the referrer mix shifted to
  Hacker News"

If after 90 days you are staring at charts and learning nothing, the insight layer is what
needs rebuilding — not the collector.

## Non-goals for v1

- No adoption score or composite ranking of any kind
- No ecosystem / package-registry connectors
- No anomaly detection or auto-generated narrative
- No multi-user, no accounts, no hosted service, no public signup
- No comparison or leaderboard across *other people's* repos
- No alerting (email, Slack, webhook)
- No mobile app
- No GitHub Enterprise Server support

If any of these get built, v1 shipped and something changed.

## Risks

1. **The value is invisible for two weeks and compounds only if the cron keeps running.**
   The durability work above is the product, not housekeeping. Most likely failure is not a
   bug — it is a laptop that sleeps and a collector that quietly stopped three weeks ago.
2. **The 90-day calibration gap.** v1's honesty-first stance is a deliberate choice that may
   read as under-featured until real data arrives to justify opinionated signals.
3. **Small repos may be noise.** A 3-clone repo can swing 300% on one clone. Whether small
   repos are worth charting at all is an open question, not an oversight.

## Open Questions

Deliberately unresolved. Each is ungrillable by conversation, and each has a cheap way to
settle it.

1. **Does the dashboard read well?** Whether a repo's story is legible at a glance, or
   whether the layout buries the one number that matters. *Settle it:* a throwaway static
   HTML file with hardcoded fake data for three made-up repos — one spiking, one flat, one
   decaying. Build only that, look at it, delete it. About an hour; saves days of building
   the wrong chart order.
2. **Is a small repo worth charting?** Whether "clones 3 → 9" is information or noise, and
   whether sparse repos should be hidden or shown honestly. Depends on the real distribution
   of these repos, which does not exist yet. *Settle it:* after the first collection run,
   dump the actual 14-day numbers for all 6 repos and look at them before designing the view.
3. **Do ecosystem metrics deserve promotion to v1?** 90 days of npm history is better data
   than 14 days of clones, so this may deserve to move up. *Settle it:* point the existing
   collector at one npm package for a week and see whether the download numbers change any
   decision that would actually be made.

---

> Input for: `@workspace /forge-auto-build-prd Use docs/IDEA.md as the project idea`
> Grilled and settled 2026-09-29. Originally generated by forge-launcher on
> 2026-09-29T10:45:48Z.
