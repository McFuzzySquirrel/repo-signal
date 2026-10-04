/**
 * The prompt primitives the setup flow is built from.
 *
 * Every prompt here is driven the way a person drives it and the way the flow
 * has to be drivable: one typed line at a time on a stream the test owns. No
 * global stream is read and no terminal is required; the only terminal these
 * tests fake is the one the masked field needs, because echo is the one
 * behaviour that is invisible without it.
 *
 * The assertions that matter are the ones a passing transcript cannot hide: that
 * no fragment of a token reaches the output, that the terminal is left able to
 * echo on every exit path including a failed read, that a selection with nothing
 * chosen is refused rather than accepted, and that no prompt writes an escape
 * sequence no matter what colour the environment or the caller asks for.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough, Readable, Writable } from 'node:stream';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  closePromptSession,
  promptChoice,
  promptConfirm,
  promptSecret,
  promptSelection,
  promptText,
} from '../src/tui/prompts.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROMPTS_ENTRY = `${REPO_ROOT}src/tui/prompts.js`;

/** A token-shaped value no prompt is allowed to show, standing in for a real one. */
const TOKEN = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a';

const REPOSITORIES = [{ label: 'owner/one' }, { label: 'owner/two' }, { label: 'owner/three' }];

/**
 * Accepts an hour the way the collection schedule will use it, and refuses
 * anything else, in the validator's own shape so the field owns nothing of it.
 * @type {import('../src/tui/prompts.js').TextValidator}
 */
const HOUR_VALIDATOR = (value) =>
  /^\d{1,2}$/u.test(value)
    ? { ok: true, value }
    : { ok: false, message: 'an hour is a number from 0 to 23' };

/**
 * @typedef {PassThrough & {
 *   isTTY: true,
 *   isRaw: boolean,
 *   setRawMode: (mode: boolean) => unknown,
 * }} TerminalPipe
 * A pipe wearing a terminal's shape, which is the only way to watch what the
 * masked field does to a real terminal's echo without a real terminal.
 */

/**
 * @typedef {object} FakeTerminal
 * @property {TerminalPipe} stream The stream the prompt reads.
 * @property {boolean[]} modes Every raw-mode change made on it, in the order it happened.
 */

/**
 * @typedef {object} Capture
 * @property {Writable} output The stream the prompt writes.
 * @property {() => string} written Everything the prompt wrote, joined exactly as it was written.
 */

/**
 * @typedef {object} PromptUnderTest
 * @property {string} name How the prompt is named in a failure.
 * @property {(streams: { input: NodeJS.ReadableStream, output: NodeJS.WritableStream }) => Promise<{ ok: boolean, reason?: string }>} ask Runs one prompt against the given streams.
 */

/**
 * @param {{ raw?: boolean }} [options] The raw mode the terminal is found in.
 * @returns {FakeTerminal}
 */
function fakeTerminal(options = {}) {
  /** @type {boolean[]} */
  const modes = [];
  const stream = /** @type {TerminalPipe} */ (new PassThrough());
  stream.isTTY = true;
  stream.isRaw = options.raw === true;
  stream.setRawMode = (mode) => {
    modes.push(mode);
    stream.isRaw = mode;
    return stream;
  };
  return { stream, modes };
}

/**
 * @returns {Capture}
 */
function captureOutput() {
  /** @type {string[]} */
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { output, written: () => chunks.join('') };
}

/**
 * The answers as one chunk, which is what a heredoc delivers and what readline
 * splits into lines. A prompt that only worked when each answer arrived in its
 * own chunk would not be drivable from a pipe.
 * @param {string[]} answers One typed line each, in the order the prompts ask for them.
 * @returns {NodeJS.ReadableStream}
 */
function pipedInput(answers) {
  return Readable.from([answers.map((answer) => `${answer}\n`).join('')]);
}

/**
 * @param {string} secret The value that must not be shown.
 * @param {string} written Everything the prompt wrote.
 * @returns {string[]} Every six-character fragment of the value that reached the output.
 */
function leakedFragments(secret, written) {
  /** @type {string[]} */
  const leaked = [];
  for (let start = 0; start + 6 <= secret.length; start += 1) {
    const fragment = secret.slice(start, start + 6);
    if (written.includes(fragment)) leaked.push(fragment);
  }
  return leaked;
}

/** Every prompt in the module, so a rule that must hold at all of them is stated once. */
const EVERY_PROMPT = /** @type {PromptUnderTest[]} */ ([
  {
    name: 'the masked field',
    ask: ({ input, output }) => promptSecret({ input, output, message: 'GitHub token:' }),
  },
  {
    name: 'the numbered choice',
    ask: ({ input, output }) =>
      promptChoice({ input, output, message: 'Which repository?', choices: REPOSITORIES }),
  },
  {
    name: 'the multiple selection',
    ask: ({ input, output }) =>
      promptSelection({ input, output, message: 'Which repositories?', choices: REPOSITORIES }),
  },
  {
    name: 'the confirmation',
    ask: ({ input, output }) =>
      promptConfirm({ input, output, message: 'Write the templates?', defaultValue: true }),
  },
  {
    name: 'the free-text field',
    ask: ({ input, output }) =>
      promptText({ input, output, message: 'Collection hour:', validate: HOUR_VALIDATOR }),
  },
]);

test('the masked field returns the value typed and writes none of its characters', async () => {
  const capture = captureOutput();
  const input = pipedInput([TOKEN]);

  const answer = await promptSecret({ input, output: capture.output, message: 'GitHub token:' });

  assert.deepEqual(answer, { ok: true, value: TOKEN });
  const written = capture.written();
  assert.deepEqual(leakedFragments(TOKEN, written), [], `the masked field wrote part of the token:\n${written}`);
  assert.match(written, /not echoed|echo/i, 'the masked field does not say in words that nothing is echoed');
  assert.match(written, /nothing was echoed/, `the masked field does not state what it accepted:\n${written}`);
  closePromptSession(input);
});

test('the masked field writes none of its characters on a terminal either', async () => {
  const terminal = fakeTerminal();
  const capture = captureOutput();

  const answer = promptSecret({ input: terminal.stream, output: capture.output, message: 'GitHub token:' });
  terminal.stream.write(`${TOKEN}\r`);

  assert.deepEqual(await answer, { ok: true, value: TOKEN });
  const written = capture.written();
  assert.deepEqual(
    leakedFragments(TOKEN, written),
    [],
    `a terminal with echo off still wrote part of the token:\n${written}`,
  );
  assert.match(written, /nothing was echoed/, `the field did not state what it accepted:\n${written}`);
  closePromptSession(terminal.stream);
  assert.equal(terminal.stream.isRaw, false, 'the session left the terminal unable to echo');
});

test('the masked field puts the terminal back when Ctrl-C ends the read', async () => {
  const terminal = fakeTerminal();
  const capture = captureOutput();

  const answer = promptSecret({ input: terminal.stream, output: capture.output, message: 'GitHub token:' });
  const foundRaw = terminal.stream.isRaw;
  const beforeInterrupt = terminal.modes.length;
  terminal.stream.write('\u0003');

  assert.deepEqual(await answer, {
    ok: false,
    reason: 'cancelled',
    message: 'Ctrl-C ended the entry, and nothing was entered.',
  });
  assert.equal(terminal.modes.length, beforeInterrupt + 1, 'the restore did not run after the interruption');
  assert.equal(terminal.modes.at(-1), foundRaw, 'the restore did not put raw mode back as it was found');
  closePromptSession(terminal.stream);
  assert.equal(terminal.stream.isRaw, false);
});

test('the masked field puts the terminal back when the read itself fails', async () => {
  const terminal = fakeTerminal();
  const capture = captureOutput();

  const answer = promptSecret({ input: terminal.stream, output: capture.output, message: 'GitHub token:' });
  const foundRaw = terminal.stream.isRaw;
  const beforeFailure = terminal.modes.length;
  terminal.stream.emit('error', new Error('the pipe broke mid-read'));

  // A failed read is an operational failure, not a refusal, and it must not take
  // the process down either: readline re-emits an input error on its own
  // interface, so a prompt that leaves that event unlistened crashes the command.
  await assert.rejects(answer, /the pipe broke mid-read/);
  assert.equal(terminal.modes.length, beforeFailure + 1, 'the restore did not run when the read failed');
  assert.equal(terminal.modes.at(-1), foundRaw, 'the restore did not put raw mode back as it was found');
  closePromptSession(terminal.stream);
  assert.equal(terminal.stream.isRaw, false, 'the session left the terminal unable to echo after a failed read');
});

test('the masked field refuses an empty value rather than accepting nothing', async () => {
  const capture = captureOutput();
  const input = pipedInput(['']);

  const answer = await promptSecret({ input, output: capture.output, message: 'GitHub token:' });

  assert.deepEqual(answer, {
    ok: false,
    reason: 'refused',
    message: 'nothing was entered, so there is no value to use.',
  });
  assert.match(capture.written(), /^refused: /mu, 'the refusal was not written to the operator');
  closePromptSession(input);
});

test('the numbered choice lists its options as text and returns the chosen index', async () => {
  const capture = captureOutput();
  const input = pipedInput(['3']);

  const answer = await promptChoice({
    input,
    output: capture.output,
    message: 'Which repository?',
    choices: REPOSITORIES,
  });

  assert.deepEqual(answer, { ok: true, index: 3, label: 'owner/three' });
  const written = capture.written();
  assert.match(written, /^ {2}1\) owner\/one$/mu, `the options were not printed as numbered text:\n${written}`);
  assert.match(written, /^ {2}3\) owner\/three$/mu);
  assert.match(written, /1 to 3/, 'the prompt does not state which numbers it accepts');
  assert.match(written, /^chosen 3: owner\/three$/mu, 'the choice was not stated in words');
  closePromptSession(input);
});

test('the numbered choice refuses an answer that is not one of the numbers it listed', async () => {
  const capture = captureOutput();
  const input = pipedInput(['9']);

  const answer = await promptChoice({
    input,
    output: capture.output,
    message: 'Which repository?',
    choices: REPOSITORIES,
  });

  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'refused');
  assert.match(String(answer.message), /answer with a number from 1 to 3/, 'the refusal does not name what was expected');
  closePromptSession(input);
});

test('the numbered choice with no options offered refuses rather than asking', async () => {
  const capture = captureOutput();
  const input = pipedInput(['1']);

  const answer = await promptChoice({ input, output: capture.output, message: 'Which repository?', choices: [] });

  assert.deepEqual(answer, {
    ok: false,
    reason: 'refused',
    message: 'there are no choices to offer, so nothing can be chosen.',
  });
  closePromptSession(input);
});

test('the multiple selection returns the chosen rows in ascending order however they were toggled', async () => {
  const capture = captureOutput();
  const input = pipedInput(['3 ', '1 ', '']);

  const answer = await promptSelection({
    input,
    output: capture.output,
    message: 'Which repositories?',
    choices: REPOSITORIES,
  });

  assert.deepEqual(answer, {
    ok: true,
    indices: [1, 3],
    labels: ['owner/one', 'owner/three'],
  });
  const written = capture.written();
  assert.match(written, /row 3 \(owner\/three\) is now selected/mu);
  assert.match(written, /Chosen 1 of 3 \(rows 3\)/mu, 'the count after a toggle was not stated in words');
  assert.match(written, /accepted 2 of 3: owner\/one, owner\/three/mu, 'the accepted rows were not stated in words');
  closePromptSession(input);
});

test('the multiple selection accepts a, n and i, and states every change in words', async () => {
  const capture = captureOutput();
  const input = pipedInput(['a', 'n', '1 ', 'i', '']);

  const answer = await promptSelection({
    input,
    output: capture.output,
    message: 'Which repositories?',
    choices: REPOSITORIES,
  });

  // a selects every row, n clears them, 1 toggles row one back on and i inverts,
  // so the two rows that were not chosen are what an empty line accepts.
  assert.deepEqual(answer, {
    ok: true,
    indices: [2, 3],
    labels: ['owner/two', 'owner/three'],
  });
  const written = capture.written();
  assert.match(written, /all 3 rows are now selected/mu, 'select-all was not stated in words');
  assert.match(written, /no rows are now selected/mu, 'select-none was not stated in words');
  assert.match(written, /row 1 \(owner\/one\) is now selected/mu, 'a toggled row was not stated in words');
  assert.match(written, /selection inverted: 2 of 3 rows are now selected/mu, 'invert was not stated in words');
  // The listing states each row's state in words when it is drawn, and every
  // change after it is announced in words, so nothing depends on a colour.
  assert.match(written, /^ {2}1\) owner\/one - not selected$/mu);
  assert.match(written, /^ {2}2\) owner\/two - not selected$/mu);
  assert.match(written, /Chosen 2 of 3 \(rows 2, 3\)/mu, 'the chosen rows were not stated in words');
  assert.match(written, /^accepted 2 of 3: owner\/two, owner\/three\./mu);
  closePromptSession(input);
});

test('the multiple selection refuses an empty selection instead of accepting nothing', async () => {
  const capture = captureOutput();
  const input = pipedInput(['a', 'n', '']);

  const answer = await promptSelection({
    input,
    output: capture.output,
    message: 'Which repositories?',
    choices: REPOSITORIES,
  });

  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'refused');
  assert.match(
    String(answer.message),
    /nothing is chosen/,
    'the refusal does not name what was expected of the selection',
  );
  assert.doesNotMatch(capture.written(), /^accepted/mu, 'an empty selection was announced as accepted');
  closePromptSession(input);
});

test('the multiple selection returns a cancellation when q is typed and leaves the rows as they were', async () => {
  const capture = captureOutput();
  const input = pipedInput(['1 ', 'q']);

  const answer = await promptSelection({
    input,
    output: capture.output,
    message: 'Which repositories?',
    choices: REPOSITORIES,
  });

  assert.deepEqual(answer, {
    ok: false,
    reason: 'cancelled',
    message: 'the selection was left as it was, because q cancels.',
  });
  assert.match(capture.written(), /row 1 \(owner\/one\) is now selected/mu, 'the rows chosen before the cancel were lost');
  assert.doesNotMatch(capture.written(), /^accepted/mu);
  closePromptSession(input);
});

test('the multiple selection refuses a row number that is not on the list', async () => {
  const capture = captureOutput();
  const input = pipedInput(['4 ', '1 ', '']);

  const answer = await promptSelection({
    input,
    output: capture.output,
    message: 'Which repositories?',
    choices: REPOSITORIES,
  });

  assert.deepEqual(answer, { ok: true, indices: [1], labels: ['owner/one'] });
  assert.match(capture.written(), /refused: 4 is not one of the numbered rows, 1 to 3/mu);
  closePromptSession(input);
});

test('the confirmation takes the stated default when the answer is empty', async () => {
  for (const [defaultValue, stated] of /** @type {Array<[boolean, string]>} */ ([
    [true, 'yes'],
    [false, 'no'],
  ])) {
    const capture = captureOutput();
    const input = pipedInput(['']);

    const answer = await promptConfirm({
      input,
      output: capture.output,
      message: 'Write the templates?',
      defaultValue,
    });

    assert.deepEqual(answer, { ok: true, value: defaultValue }, `an empty answer did not take the ${stated} default`);
    assert.match(capture.written(), new RegExp(`default: ${stated}`, 'u'), 'the default was not stated before the answer');
    assert.match(capture.written(), new RegExp(`answered ${stated}, the stated default`, 'u'));
    closePromptSession(input);
  }
});

test('the confirmation does not take the default when q cancels it', async () => {
  const capture = captureOutput();
  const input = pipedInput(['q']);

  const answer = await promptConfirm({
    input,
    output: capture.output,
    message: 'Write the templates?',
    defaultValue: true,
  });

  // An empty answer takes the default; q is the escape every prompt ends with,
  // so it cancels rather than quietly answering yes on the operator's behalf.
  assert.deepEqual(answer, {
    ok: false,
    reason: 'cancelled',
    message: 'q cancels, so the default was not taken either.',
  });
  const written = capture.written();
  assert.match(written, /default: yes/u, 'the default was not stated, so a q answer could be mistaken for it');
  assert.match(written, /Type q to cancel/u);
  assert.doesNotMatch(written, /^answered/mu, 'a cancelled confirmation claimed an answer');
  closePromptSession(input);
});

test('the confirmation refuses an answer that is neither yes nor no', async () => {
  const capture = captureOutput();
  const input = pipedInput(['maybe']);

  const answer = await promptConfirm({
    input,
    output: capture.output,
    message: 'Write the templates?',
    defaultValue: true,
  });

  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'refused');
  assert.match(String(answer.message), /neither yes nor no/, 'the refusal does not name what was expected');
  closePromptSession(input);
});

test('the free-text field returns the trimmed value its validator accepted', async () => {
  const capture = captureOutput();
  const input = pipedInput(['  4  ']);

  const answer = await promptText({
    input,
    output: capture.output,
    message: 'Collection hour:',
    validate: HOUR_VALIDATOR,
  });

  assert.deepEqual(answer, { ok: true, value: '4' });
  assert.match(capture.written(), /^accepted\.$/mu);
  closePromptSession(input);
});

test('the free-text field returns the validator refusal unchanged, naming what was expected', async () => {
  const capture = captureOutput();
  const input = pipedInput(['  four  ']);

  const answer = await promptText({
    input,
    output: capture.output,
    message: 'Collection hour:',
    validate: HOUR_VALIDATOR,
  });

  assert.deepEqual(answer, { ok: false, reason: 'refused', message: 'an hour is a number from 0 to 23' });
  assert.match(capture.written(), /^refused: an hour is a number from 0 to 23$/mu);
  closePromptSession(input);
});

test('one input stream answers several prompts in order, so no answer reaches the wrong question', async () => {
  const capture = captureOutput();
  // Everything a short flow would need, delivered as one block the way a piped
  // script arrives: a confirmation, a token, a choice, and an accepted selection.
  const input = pipedInput(['y', TOKEN, '2', '1 2 ', '']);

  const confirmed = await promptConfirm({
    input,
    output: capture.output,
    message: 'Write the templates?',
    defaultValue: false,
  });
  const secret = await promptSecret({ input, output: capture.output, message: 'GitHub token:' });
  const chosen = await promptChoice({
    input,
    output: capture.output,
    message: 'Which repository?',
    choices: REPOSITORIES,
  });
  const selection = await promptSelection({
    input,
    output: capture.output,
    message: 'Which repositories?',
    choices: REPOSITORIES,
  });

  assert.deepEqual(confirmed, { ok: true, value: true });
  assert.deepEqual(secret, { ok: true, value: TOKEN });
  assert.deepEqual(chosen, { ok: true, index: 2, label: 'owner/two' });
  assert.deepEqual(selection, { ok: true, indices: [1, 2], labels: ['owner/one', 'owner/two'] });
  closePromptSession(input);
});

test('an input that ends before an answer cancels the prompt, naming why', async () => {
  const capture = captureOutput();
  const input = Readable.from([]);

  const answer = await promptChoice({
    input,
    output: capture.output,
    message: 'Which repository?',
    choices: REPOSITORIES,
  });

  assert.deepEqual(answer, {
    ok: false,
    reason: 'cancelled',
    message: 'standard input ended before a choice was made.',
  });
  closePromptSession(input);
});

test('every prompt takes a typed q as its cancellation and says how to cancel', async () => {
  /** @type {string[]} */
  const outcomes = [];
  for (const entry of EVERY_PROMPT) {
    const capture = captureOutput();
    const input = pipedInput(['q']);

    const answer = await entry.ask({ input, output: capture.output });

    assert.match(capture.written(), /Type q/u, `the ${entry.name} never stated that q cancels`);
    outcomes.push(`${entry.name}: ${answer.ok ? 'accepted' : answer.reason ?? 'refused'}`);
    closePromptSession(input);
  }
  assert.deepEqual(
    outcomes,
    EVERY_PROMPT.map((entry) => `${entry.name}: cancelled`),
    'every prompt must accept q as its cancellation',
  );
});

test('a line whose only content is q cancels at every prompt, whatever surrounds it', async () => {
  // The rule has to be one rule: an operator who types a stray space before q
  // meant to cancel, and a prompt that treats that as a value teaches them the
  // escape does not work.
  /** @type {string[]} */
  const outcomes = [];
  for (const entry of EVERY_PROMPT) {
    const capture = captureOutput();
    const input = pipedInput([' q ']);

    const answer = await entry.ask({ input, output: capture.output });

    outcomes.push(`${entry.name}: ${answer.ok ? 'accepted' : answer.reason ?? 'refused'}`);
    closePromptSession(input);
  }
  assert.deepEqual(
    outcomes,
    EVERY_PROMPT.map((entry) => `${entry.name}: cancelled`),
    'a q with whitespace around it is still a cancellation, not a value',
  );
});

test('every prompt writes no escape sequence with colour disabled, and states its options in words', async (t) => {
  const before = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
  process.env.NO_COLOR = '1';
  process.env.TERM = 'dumb';
  t.after(() => {
    for (const name of /** @type {const} */ (['NO_COLOR', 'TERM'])) {
      const value = before[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const capture = captureOutput();
  const input = pipedInput([TOKEN, '2', 'a', 'n', '1 ', 'i', '', '', '7']);

  await promptSecret({ input, output: capture.output, message: 'GitHub token:' });
  await promptChoice({ input, output: capture.output, message: 'Which repository?', choices: REPOSITORIES });
  await promptSelection({ input, output: capture.output, message: 'Which repositories?', choices: REPOSITORIES });
  await promptConfirm({ input, output: capture.output, message: 'Write the templates?', defaultValue: true });
  await promptText({ input, output: capture.output, message: 'Collection hour:', validate: HOUR_VALIDATOR });

  const written = capture.written();
  assert.doesNotMatch(written, /\u001b/u, `an escape sequence reached the output:\n${JSON.stringify(written)}`);
  // Every option, state and selection is a word, so a colour-blind, colourless
  // or captured reading is the same reading.
  assert.match(written, /^ {2}1\) owner\/one - not selected$/mu);
  assert.match(written, /^ {2}3\) owner\/three - not selected$/mu);
  assert.match(written, /Chosen 2 of 3 \(rows 2, 3\)/mu);
  assert.match(written, /answered yes, the stated default/mu);
  assert.match(written, /^accepted\.$/mu);
  closePromptSession(input);
});

test('a message or a label carrying a colour escape is written without it and keeps its words', async () => {
  const capture = captureOutput();
  const input = pipedInput(['1']);

  await promptChoice({
    input,
    output: capture.output,
    message: '\u001b[31mWhich repository?\u001b[0m',
    choices: [{ label: '\u001b[1mowner/one\u001b[0m' }],
  });

  const written = capture.written();
  assert.doesNotMatch(written, /\u001b/u, `an escape sequence reached the output:\n${JSON.stringify(written)}`);
  assert.match(written, /Which repository\?/u);
  assert.match(written, /owner\/one/u);
  closePromptSession(input);
});

test('closing a prompt session is safe on a stream no prompt used, and safe twice', () => {
  const unused = pipedInput(['q']);
  closePromptSession(unused);

  const input = pipedInput(['q']);
  closePromptSession(input);
  closePromptSession(input);
});

test('the module is built from node:readline and node:tty alone, with no cursor addressing', () => {
  const source = readFileSync(PROMPTS_ENTRY, 'utf8');
  const imported = [...source.matchAll(/^import .*from '([^']+)';$/gmu)].map((match) => match[1]);
  assert.deepEqual(imported, ['node:readline'], `the prompts import ${JSON.stringify(imported)}`);
  assert.match(source, /import\('node:tty'\)\.ReadStream/u, 'the terminal side is not the node:tty ReadStream');
  for (const forbidden of [
    'process.stdin',
    'process.stdout',
    'process.stderr',
    'process.env',
    'emitKeypressEvents',
    'cursorTo',
    'moveCursor',
    'clearScreen',
    'enterAlternativeScreen',
  ]) {
    assert.equal(source.includes(forbidden), false, `the prompts use ${forbidden}`);
  }
  assert.doesNotMatch(source, /\u001b/u, 'the prompts contain a raw escape sequence');
});