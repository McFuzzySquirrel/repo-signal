# Forge-task contract field map

Each row states what the field authorises, what it forbids, and the overrun it invites. Field
names match the version-2 task contract used throughout `docs/features/*.md`.

| Field | Authorises | Forbids | Overrun it invites |
|-------|------------|---------|-------------------|
| `id` | Reporting the task by name | Renumbering or reusing an id | A renamed id breaks dependency resolution in a later plan edit |
| `ownerAgent` | The accountable specialist | Work by any other agent | Taking a neighbouring task's surface because it is "obviously needed" |
| `dependencies` | Reading those task outputs as inputs | Creating a stand-in for a missing prerequisite | Reimplementing a prerequisite privately, so the real module is bypassed |
| `expectedOutputs` | Creating or modifying exactly those paths | Any other file | Adding an unnamed helper module that no later task wires in |
| `validationCommands` | Running exactly those commands from the repository root | Substituting `echo passed`, a bare build, or an unconditional exit-zero | Reporting a command that exists but proves nothing |
| `contract.requirements` | Task-specific rules, stated inline | Inventing requirements the refs do not carry | Reading a whole feature document and treating sibling requirements as yours |
| `contract.requirementRefs` | Resolving selected `path#ID` content into the contract | Re-resolving IDs against a different document | Guessing an ID that does not exist, or expanding a section with sibling tasks |
| `contract.constraints` | The deny list for this task | Any excluded surface | Implementing a plausible half of a neighbour's responsibility |
| `contract.acceptanceCriteria` | The named checks the task must satisfy | Criteria with no corresponding assertion | Writing a general happy-path test and calling the criterion covered |
| `contract.references` | Reading the selected headings on demand | Depending on an entire document being injected | Ignoring them and re-deciding a decision the document already fixes |
| `contract.kind: human-review` | Producing reviewable evidence for a person | Authoring `reviewFile`, scoring a rubric, claiming approval | Writing a summary a reviewer could mistake for sign-off |

## Version-2 resolution order

1. Read the inline `requirements` and `constraints` arrays; both may legitimately be empty.
2. Resolve each `requirementRefs` and `constraintRefs` selector, which is `path#ID` or `path#exact heading`.
3. The resolved text joins the contract. A constraint that also appears in the vision is still read
   once, at the ref, so there is one home for it.
4. Read `references` last and only for the sections you must make a decision about.

## Reading order that avoids rework

1. `expectedOutputs` - you now know the file set.
2. `constraints` - you now know the deny list.
3. `contract.requirements` and the resolved refs - you now know the behaviour.
4. `acceptanceCriteria` - you now know the assertions, so the tests can be written before the code
   when the criterion is precise.
5. `description` - the prose resolves remaining wording, such as which of two files a split module
   belongs in.

## A task that modifies an existing file

Several tasks name a file another task created, with wording such as "which this task modifies":
`src/commands/index.js` is extended by the config, db, discover, collect and serve tasks, and
`src/collect/run.js` by the journal and lifecycle tasks. In that case the expected output is an
intentional edit, so keep every unrelated behaviour in the file intact and re-run the task that
first created it.
