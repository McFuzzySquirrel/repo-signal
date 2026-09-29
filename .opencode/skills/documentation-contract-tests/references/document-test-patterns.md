# Document test patterns

## Required-statement assertion

One assertion per statement, each naming the document and the statement, so a failure points at the
sentence that was lost rather than at a whole-document comparison.

```js
const readme = readFileSync("README.md", "utf8");
assert.match(readme, /clone is not adoption/i);
assert.match(readme, /may not be redistributed/i);
assert.match(readme, /Administration/);
assert.match(readme, /22\.13\.0/);
```

A single test asserting the whole document against a golden file fails on every harmless edit and
gets deleted within a week. Named statement assertions survive editing.

## Command-existence assertion

A word match proves the sentence; the assertion must prove the command. Resolve the subcommand
against the registry, or spawn the entry point with `--help` and read the usage output.

```js
const result = spawnSync(process.execPath, ["src/cli.js", "--help"], { encoding: "utf8" });
const named = commandsNamedIn("docs/operations/backup-and-migrate.md");
for (const command of named) {
  assert.ok(result.stdout.includes(command), `runbook names ${command}, which the CLI does not provide`);
}
```

Extract commands from fenced code blocks and inline code spans that begin with the product name or
`node src/cli.js`, then normalise the group and subcommand before comparing.

## Workflow-file assertion

Parse the workflow as text or a parsed document and assert the shape, not the prose:

- a clean install step;
- the type check step;
- the repository test command, invoked through the wrapper rather than the bare runner;
- a matrix covering two Node versions, one of which is the supported floor;
- no secret requirement, and no deploy, publish or release step.

## Checklist assertion

Assert that the release checklist names each required human gate by its artefact name - the live
integration review, the seven-day soak review, the open-source posture review - plus the schema
version and the supported Node range. A checklist that names a gate as "sign-off" without an
artefact is not a gate.

## Repository-hygiene assertion

- No tracked path matches the credential file name, the database extension or the home directory
  pattern.
- The ignore file covers those paths, so a local run cannot stage them by accident.
- A licence file exists, names MIT, and carries a copyright line.

## State-word assertion

The troubleshooting document must use the same words the product shows. Extract the state words from
the product's own state enumeration in the vision's lifecycle table and assert each appears in the
troubleshooting page, so a renamed state breaks the test rather than the operator's trust.

## What not to assert

- A test result, an approval, or a compliance claim. Those are observations, and asserting one in a
  document fabricates it.
- Exact paragraph layout, heading order or word counts. Those make the test fail on every copy edit
  and get deleted.
- A document's own length or completeness, beyond the named statements it must keep.
- That a human review file contains an approval. Agents never author those files, and their absence
  is a legitimate state.
