# Prompt, flow and refusal shapes

## Prompt primitives

| Primitive | Behaviour | Refuses |
|-----------|-----------|---------|
| Masked secret | disables terminal echo through `node:tty`, restores it in a `finally` block, writes no characters | a value handed to any output function |
| Numbered single choice | lists options numbered from one, states them in text, returns the chosen index | an index that is not listed |
| Multiple selection | toggles on space, also accepts `a` for all, `n` for none and `i` to invert, returns chosen indices in ascending order | a save with nothing chosen |
| Confirmation | states the default explicitly, an empty answer takes that default | an answer that is neither yes nor no |
| Free text | trims, then runs a caller-supplied validator returning the value or a refusal naming what was expected | a value the validator rejects |

Every prompt additionally: states its options as plain text, reads one line at a time, accepts `q` to
cancel the current step, works with colour disabled, and takes its input and output streams as
parameters.

## First-run sequence

1. State the resolved home and whether a configuration already exists.
2. Ask whether to write both templates, defaulting to yes when neither file exists.
3. Ask for the token through the masked field, then state in one line which permission it needs and where
   to read about it.
4. Run discovery through the existing client and policy, and print how many repositories the token can
   reach, with each one's permission state.
5. Present them as a numbered list with a space-bar toggle, `a`, `n` and `i`, then show the chosen count
   and ask for confirmation.
6. Ask for the collection hour, defaulting to the configured value or zero.
7. Run the existing configuration check and print its own lines.
8. Offer the first collection, and print whatever the command would print.

## Returning visit

A menu over: add or remove an enrolment, toggle one off, edit the deny list, change the collection hour,
refresh discovery, then return to the menu. Behind one more menu, the run actions: collect now, print the
report, print the health summary, start the dashboard. `q` cancels the current step and returns to the
previous one; Ctrl-C at any point ends the run without writing a partial file.

## Refusal shapes to keep consistent

| Situation | Shape | Never |
|-----------|-------|-------|
| Standard input is not a terminal | the same instructions, exit 1, naming the command to run instead | a read that waits forever |
| Selection is empty | a refusal naming what was expected, nothing written | an empty enrolment saved |
| Repository is on the deny list | a refusal naming the deny entry | enrolling it in either case |
| Free text fails its validator | the trimmed value refused, naming what was expected | the raw value coerced |
| Interrupted at a write | the previous file byte-identical, no credential file created | a truncated destination file |
| Run action fails | the command's own message, then the menu | a session that ends |
| Token entered | stored only at mode 0600 by the existing writer | any echo, log or printed value |

## Module boundaries

| Module | Owns | Must not |
|--------|------|----------|
| prompt primitives | echo control, line reading, option rendering, cancellation | read the global process streams, or add a dependency |
| first-run flow | the sequence, the prompts and the refusals | parse JSON, resolve a path, validate a token shape, or call GitHub |
| configuration manager | the menu, edits applied to the loaded configuration, saving whole | write a configuration the existing loader would reject |
| run actions | the menu and the delegation | reimplement collection, reporting or serving, or add a request |
| the command | registration, its own help, the non-interactive output | contain any of the flow's logic |

## Test layers

| Level | Scope | Shape |
|-------|-------|-------|
| Unit, per module | parsing, refusal, masking, cancellation | drive the module with piped streams |
| Unit, the command | registry entry, help text, non-interactive output | spawn the entry point |
| Unit, accessibility | keyboard-only operation, no colour meaning, non-terminal refusal, interruption | drive the real command from a pipe |
| Integration | the real command against the loopback stub | spawn the entry point with scripted answers and the transport override scoped to the child |
| Contract | the command is registered and documented | assert the registry and the document agree |
| Human | the journey as a person experiences it | the recorded review, which no agent authors |

Two failure modes are worth stating once because neither is visible in a passing run: a masked field
that leaks when the echo restore fails, and a prompt whose state is expressed only in colour. Both have
to be asserted from scripted standard input, alongside the non-terminal refusal that must exit 1 and
name the command to run.