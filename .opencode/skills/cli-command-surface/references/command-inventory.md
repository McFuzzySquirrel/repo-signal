# Command inventory

One registry, `src/commands/index.js`, resolved by the composition root `src/cli.js`. Every command
is reached as `node src/cli.js <group> <subcommand>`.

| Command | Owning task | Flags | Output contract | Exit codes |
|---------|-------------|-------|-----------------|------------|
| `config init` | `RS-FND-06` | `--force` | Writes a configuration template and a credential template, both mode 0600; refuses to overwrite without `--force` | 0 written, 1 refused, 2 bad usage |
| `config check` | `RS-FND-06` | none | One line per check plus a final `ok` or the first failure; never the token | 0 all checks pass, 1 a check failed |
| `db migrate` | `RS-DB-04` | none | Applies pending migrations; reports the applied versions | 0 applied or nothing pending, 1 checksum abort, 2 bad usage |
| `db status` | `RS-DB-04` | none | Database path, the code's schema version, the on-disk version, whether a migration is pending; never row contents | 0, 1, 2 |
| `db verify` | `RS-DB-04` | none | The integrity-check result | 0 passes, 1 fails, 2 |
| `db backup` | `RS-DB-04` | destination path | Writes a consistent copy; no observation values or repository names | 0, 1, 2 |
| `db restore` | `RS-DB-04` | source path | Loads a copy, re-verifies, reports per-table row counts | 0, 1 on truncation or integrity failure, 2 |
| `discover` | `RS-ENR-02` | `--json`, optional include-organization flag | A table of `owner/name`, visibility, enrolment state and permission, then a fenced block of configuration lines; `--json` prints one object with `repositories` and `configLines` | 0, 1, 2 |
| `collect` | `RS-COL-03` | `--dry-run`, `--repo owner/name` | One line per repository (`ok`, `failed <kind>`, or `planned`), a final summary with counts and the run identifier | 0 all succeeded, 1 any repository failed, 2 bad usage |
| `serve` | `RS-UI-01` | `--port` (0 allowed) | The URL actually listened on | 0 on close, 1 startup failure, 2 bad usage |

## Universal rules

- Global flags are parsed by `src/cli.js`; a subcommand parses its own.
- A failure the maintainer can act on names the action: the permission, the token, the file mode,
  the path, or the inverted range.
- No command prints credential material, observation values or row contents where its contract
  forbids it: `config check` never prints the token, and `db backup` and `db restore` never print
  observation values or repository names.
- No command enrols, collects or writes configuration as a side effect. Discovery is read-only.
- Unknown subcommand and unknown flag both exit 2 and print usage.

## Reachability test shape

```bash
const result = spawnSync(process.execPath, ["src/cli.js", "collect", "--dry-run"], {
  env: { ...process.env, REPO_SIGNAL_HOME: tempHome, REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: "1" },
  encoding: "utf8",
});
assert.equal(result.status, 0);
assert.match(result.stdout, /planned/);
```

Assert the exit code, the printed shape, and - for a dry run - that no row was written. Importing
the command module proves none of the three.
