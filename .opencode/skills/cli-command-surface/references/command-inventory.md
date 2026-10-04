# Command inventory

One registry, `src/commands/index.js`, resolved by the composition root `src/cli.js`. Every command is
reached as `node src/cli.js <group> <subcommand>`. Regenerate this table from the registry and from each
command's own flag parsing; never edit it by hand, because the README's inventory is already recorded as
disagreeing with the registry about `report`.

## Registered commands

| Command | Usage shape | What it does | Owning task |
|---------|-------------|--------------|-------------|
| `discover` | `[--json] [--include-organizations]` | Lists reachable repositories and prints ready-to-paste configuration lines; `--json` prints one object with `repositories` and `configLines` | `RS-FND-CONTRACT-01` |
| `collect` | `[--dry-run] [--repo owner/name]` | Collects every enrolled repository now, or plans the run without contacting GitHub | `RS-COL-CONTRACT-01` |
| `config init` | `[--force]` | Creates private configuration and credential templates at mode 0600; refuses to overwrite without the force flag | `RS-FND-C02` |
| `config check` | none | Validates local configuration and credentials without printing the token | `RS-FND-C02` |
| `db migrate` | none | Applies pending archive migrations forward-only and reports what it applied | `RS-STO-CONTRACT-01` |
| `db status` | none | Prints the database path, the code's schema version, the on-disk version and whether a migration is pending | `RS-STO-CONTRACT-01` |
| `db verify` | none | Runs an integrity check over the archive and exits non-zero on failure | `RS-STO-CONTRACT-01` |
| `db backup` | `<path>` | Writes a consistent copy of the archive to a chosen path | `RS-STO-CONTRACT-01` |
| `db restore` | `<path>` | Loads a backup over the archive, re-verifies it and prints per-table counts | `RS-STO-CONTRACT-01` |
| `report` | `[--repo owner/name] [--from YYYY-MM-DD] [--to YYYY-MM-DD]` | Prints a written summary of what the archive holds, contacting no host | `RS-SUP-CONTRACT-01` |
| `serve` | `[--port 0]` | Starts the read-only dashboard on loopback and prints the URL it is listening on | `RS-SRV-CONTRACT-01` |
| `setup` | `[--help] [--non-interactive]` plus the interactive flow | Guided first run, returning configuration manager and run menu | `RS-TUI-02` |

`setup` is the only command whose own `--help` is mandatory under its own contract, because the global
flag is parsed before the command name and the interactive flow needs its own steps printed.

## Global rules

- `--help` and `-h` are global flags parsed before the command name, and the entry point prints the
  generated usage and exits 0. A flag after the command name is the command's own to parse or refuse.
- A command name is one or two lower-case words separated by single spaces, matching how it is typed.
- A name that resolves to nothing exits 2 and prints the registered names that sit under what was typed.
- No command prints credential material. `config check` reports presence, mode and parse state, never the
  value.
- `db backup` and `db restore` print no observation values and no repository names.
- No command enrols, collects or writes configuration as a side effect. Discovery is read-only.
- `report` contacts no host and reads no credential; it exits 0 whenever it read the archive, whatever
  states it reports.

## Flag rules that are easy to get wrong

| Flag | Rule |
|------|------|
| `--dry-run` | reads no credential, opens no socket, writes nothing, reports zero requests, and returns before the run journal is opened |
| `--repo owner/name` | accepts exactly one owner and one name; anything else is a usage error naming what was given |
| `--port 0` | binds an ephemeral port; a port that cannot be honoured is a usage error, not a silent fallback |
| `--json` | prints exactly the documented object shape; the human table is not that shape |
| `--non-interactive` | prints the scriptable equivalent of every step and exits 0 without touching a file |

## Reachability test shape

```js
const result = spawnSync(process.execPath, ['src/cli.js', 'collect', '--dry-run'], {
  env: { ...process.env, REPO_SIGNAL_HOME: tempHome, REPO_SIGNAL_ALLOW_LOCAL_TRANSPORT: '1' },
  encoding: 'utf8',
});
assert.equal(result.status, 0);
assert.match(result.stdout, /planned/);
```

Assert the exit code, the printed shape, and - for a dry run - that no row was written. Importing the
command module proves none of the three.