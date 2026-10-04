# Failure recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| `tests: cannot use <path>` and exit 1 | The named path does not resolve from the repository root | Pass a path relative to the repository root, and check it exists |
| `tests: no tests were selected by <paths>` and exit 1 | The path holds no file matching the Node test patterns | Name the file with a `.test.js` suffix, or name the directory that holds the tests |
| `tests: ... reported no test summary` and exit 1 | The runner was killed or printed no TAP counters | Run the same command by hand to read the runner error above the wrapper's message |
| `tests: the test runner selected 0 tests` and exit 1 | The file resolved but declares no test | Add the test; an empty file is a failure by `RS-NF-05`, not a pass |
| `tests: <file> reported only itself` and exit 1 | The file resolved and the runner counted the file as one passing subtest, so the counters alone let an empty file through | Add the test the file is supposed to declare |
| `SQLITE_CANTOPEN`, or a database in an unexpected state | The test inherited a real or shared home | Set `REPO_SIGNAL_HOME` to a fresh temporary directory per test |
| `database is locked` only in a full run | Two suites share one home or one database file | Give each test its own home; do not reuse a module-level path |
| `pending migration` or a version mismatch in a full run | A previous suite migrated the home this suite is reading | Isolate the home; never point a test at the developer's home |
| `EADDRINUSE` on the dashboard port | A fixed port collides with a running dashboard or a parallel suite | Start with `--port 0` and read the URL the server printed |
| `EADDRNOTAVAIL` binding 127.0.0.1 | A sandbox without loopback | The dashboard is loopback-only by design; report the environment rather than widening the bind address |
| Unknown option or missing driver method while opening `DatabaseSync`, on a host that imports `node:sqlite` cleanly | The runtime is below 24.12.0, so `enableDefensive` does not exist: the import succeeds and only the connection fails | Check `node -v` against the `RS-C14` floor before reading it as a product defect; the storage layer fails closed there on purpose |
| A retry test takes minutes, or is flaky | The test waits on real backoff | Inject the clock and the sleep function; assert the chosen delays instead |
| `tsc` errors in a module that runs correctly | The JSDoc annotation is wrong, or an import type is missing | Fix the `@type` or the return annotation; do not cast the value to `any` |
| `tsc` cannot resolve a `node:` type | The Node type definitions are not installed | Run `npm install`; the two dev dependencies are the whole install step |
| A suite passes alone and fails in a full run | A test wrote into shared state, or a port or a home is shared | Give every test its own home and its own ephemeral port |
| A seeded archive is missing a constraint the test expects | Seed data was inserted with direct SQL | Seed through the repositories so the constraints are enforced |
| A network call is attempted during a test | The local transport override was not set for this process | Set it in the child environment only, and never globally |
| A contract test fails after a number changed in `src/` | The test restated the value instead of importing it | Import the exported constant and compare against it |

## Reporting rules

- A command that was not run is reported as not run. An implied pass is a false report.
- A command that ran and proved nothing is reported as proving nothing, with the reason.
- A failing command is reported with its exit code and the relevant output, not summarised as
  "issues remain".
- A test-only task that exposes a production defect reports the defect with the file and the observed
  output, and does not edit `src/`.