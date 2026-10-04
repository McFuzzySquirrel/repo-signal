# Document test patterns

## The eleven document-plus-contract pairs

Each of these tasks produces one document claim and one test that fails when the claim drifts. They are
the same artefact at different surfaces, so a pattern that works for one works for the rest.

| Task | Document | Test |
|------|----------|------|
| `RS-STO-CONTRACT-01` | the README's storage section and the backup runbook | the storage contract test |
| `RS-INS-CONTRACT-01` | the documented insight and insufficiency claims | the insight contract test |
| `RS-SRV-CONTRACT-01` | the dashboard's served claims | the server contract test |
| `RS-VWS-CONTRACT-01` | the documented page structure and accessibility claims | the views contract test |
| `RS-COL-CONTRACT-01` | the scheduled-collection runbook and the request budget figures | the collect contract test |
| `RS-BKL-CONTRACT-01` | the documented backfill window and refusal behaviour | the backfill contract test |
| `RS-FND-CONTRACT-02` | the README inventory and the release checklist | the release contract test |
| `RS-GHC-CONTRACT-01` | the privacy note's transport and environment-variable claims | the transport contract test |
| `RS-SUP-CONTRACT-01` | the report's documented shape and state vocabulary | the report contract test |
| `RS-TUI-07` | the README's setup section and the scheduled-collection runbook | the setup command contract test |
| `RS-OPS-POST-01` | the posture dossier | the posture dossier test |

## Authority-import assertion

The strongest pattern in this repository: assert the document against the constant the code exports,
rather than against a literal in the test.

```js
import { CREDENTIAL_FILE_MODE, HOME_DIRECTORY_MODE } from '../src/paths.js';
import { TRAFFIC_PERMISSION } from '../src/supervision/errors.js';
import { TRAFFIC_REQUESTS_PER_REPOSITORY, BACKFILL_REQUESTS_FLOOR }
  from '../src/collect/run.js';

const readme = readFileSync('README.md', 'utf8');
assert.match(readme, new RegExp(`0o?${CREDENTIAL_FILE_MODE.toString(8).slice(-3)}`));
assert.match(readme, new RegExp(TRAFFIC_PERMISSION.replace(/[()]/g, '\\$&')));
assert.match(readme, new RegExp(`${TRAFFIC_REQUESTS_PER_REPOSITORY}[^.]*requests`));
```

The mode check above has a shape worth copying: it pads or slices the octal to the four-digit form the
documents actually print, because a document writes `0600` and the constant is `0o600`.

## Required-statement assertion

One assertion per statement, each naming the document and the statement, so a failure points at the
sentence that was lost rather than at a whole-document comparison.

```js
assert.match(readme, /clone is not adoption/i);
assert.match(readme, /may not be redistributed/i);
assert.match(readme, /Administration repository permission \(read\)/);
assert.match(readme, /24\.12\.0/);
```

A single test asserting a whole document against a golden file fails on every harmless edit and gets
deleted within a week. Named statement assertions survive editing.

## Command-existence assertion

Resolve the subcommand against the registry, or spawn the entry point and read the generated usage.

```js
const result = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
for (const command of commandsNamedIn('docs/operations/backup-and-migrate.md')) {
  assert.ok(result.stdout.includes(command),
    `runbook names ${command}, which the CLI does not provide`);
}
```

Extract commands from fenced code blocks and inline code spans that begin with the entry point or the
product name, then normalise the group and subcommand before comparing. When a document legitimately
describes a command that has not landed yet, the failure is the finding: report it and let the test name
the gap rather than relaxing the assertion.

## Workflow-file assertion

Parse the workflow and assert its shape, not its prose:

- a clean install step;
- the type check step;
- the whole suite invoked through the wrapper rather than the bare runner;
- the backup drill step;
- a matrix covering two Node versions, one of which is the declared floor;
- read-only repository permissions, no secret reference, no deploy, publish or release step, and no
  scheduled trigger.

## Checklist assertion

Assert that the release checklist names each required gate by its artefact rather than by a phrase, plus
the schema version, the supported Node range, the licence and the package version, each beside the
authority for it. A checklist that names a gate as "sign-off" without an artefact is not a gate, and a
test must not assert that an absent review artefact means the gate failed.

## Repository-hygiene assertion

- No tracked path matches the credential file, the database file or the home-directory pattern.
- The ignore file covers those paths, so a local run cannot stage them by accident.
- A licence file exists, names MIT, and carries a copyright line.

## State-word assertion

The troubleshooting document must use the words the product emits. Extract the state enumeration from the
module that owns it and assert each word appears in the document, so a renamed state breaks the test
rather than the operator's trust.

## What not to assert

- A test result, an approval or a compliance claim. Those are observations, and asserting one in a
  document fabricates it.
- Exact paragraph layout, heading order or word counts. Those fail on every copy edit and get deleted.
- A document's own length or completeness, beyond the named statements it must keep.
- That a human review file contains an approval. No agent authors those files, and their absence is a
  legitimate state.

## Known live instances of drift to assert against

- The README's non-runtime command inventory omits `report`, although the install sequence and every
  runbook use it.
- `discover` and `report` print a pointer to their own `--help` that they do not parse, so a document
  telling an operator to run it sends them to a usage error.
- Two environment variables exist in code and in no document: the GitHub base URL override and the
  loopback transport gate.
- The home inventory lists three files, while write-ahead logging adds two side files beside the
  archive.