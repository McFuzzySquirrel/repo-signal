# Failure recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| Test command exits 0 but names no tests | Selection found nothing, and the wrapper is absent or the path was not passed after `--` | Pass the path after `--`; if the wrapper is missing, report the command as proving nothing |
| `Cannot find module 'node:sqlite'` or an experimental-flag error | Host is below the release that removed the experimental flag, so far below the supported floor | Check `node -v`; the engine floor is 24.12.0, the release that exposes `node:sqlite`'s `enableDefensive`, and 24 is the supported line |
| Unknown option or missing driver method while opening `DatabaseSync`, on a host that imports `node:sqlite` cleanly | Runtime is below 24.12.0, so `enableDefensive` does not exist; the import succeeds and only the connection fails | Check `node -v` against the 24.12.0 floor before reading it as a product defect; the storage layer fails closed there on purpose rather than opening without the flag |
| `SQLITE_CANTOPEN` or a database in an unexpected state | A test inherited a real or shared home | Set `REPO_SIGNAL_HOME` to a fresh temporary directory per test |
| `database is locked` only in a full run | Two suites share one home or one database file | Give each test its own home; do not reuse a module-level path |
| `pending migration` or a version mismatch in a full run | A previous suite migrated a home this suite is reading | Isolate the home; never point a test at the developer's home |
| `EADDRINUSE` on 4173 | A fixed port collides with a running dashboard or a parallel suite | Start with `--port 0` and read the printed URL |
| A retry test takes minutes or is flaky | The test waits on real backoff | Inject the clock and the sleep function; assert the delays instead |
| `tsc` errors in a module that runs correctly | JSDoc annotation is wrong or missing an import type | Fix the `@type` or the return annotation; do not cast the value to `any` |
| `tsc` cannot resolve a `node:` type | The Node type definitions are not installed | Run `npm install`; the two dev dependencies are the whole install step |
| A suite passes alone and fails in a full run | A test wrote into shared state, or a port or home is shared | Give every test its own home and ephemeral port |
| A seeded archive is missing a constraint the test expects | Seed data was inserted with direct SQL | Seed through the repositories so the constraints are enforced |
| A network call is attempted in a test | The local transport override was not set for this process | Set it in the child environment only, and never globally |
| `EADDRNOTAVAIL` binding 127.0.0.1 | A sandbox without loopback | The dashboard is loopback-only by design; report the environment, do not widen the bind address |

## Reporting rules

- A command that was not run is reported as not run. An implied pass is a false report.
- A command that ran and proved nothing is reported as proving nothing, with the reason.
- A failing command is reported with its exit code and the relevant output, not summarised as
  "issues remain".
- A test-only task that exposes a production defect reports the defect with the file and the observed
  output, and does not edit `src/`.
