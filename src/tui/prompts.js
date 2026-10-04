/**
 * The line-oriented prompt primitives the setup flow is built from.
 *
 * Every prompt states its options as plain text, reads one line at a time,
 * accepts `q` to cancel, and takes its input and output streams as parameters so
 * a test can drive it from a pipe. Nothing is drawn over previous output and
 * nothing is written with cursor addressing or an alternate screen, so scrolling
 * back stays a valid way to read what happened (`RS-TUI-C01`).
 *
 * Two decisions shape the code below, and both are about what the terminal is
 * allowed to show.
 *
 * Nothing written here ever contains a character the operator typed. The
 * readline interface is created with no output stream, so it has nowhere to echo
 * to at all, and a value that must not be shown also has the terminal's own echo
 * switched off through `node:tty` and restored from `finally`: with no readline
 * output the terminal itself is the only thing left that could show it. The cost
 * of that is that no prompt echoes as it is typed; every prompt states in words
 * what it accepted, so the answer is on the record even though the keystrokes
 * were not shown (`RS-TUI-C02`).
 *
 * There is no colour anywhere in this module and no state is carried by one: a
 * selection, a default and a refusal are all words, so the surface reads the
 * same under `NO_COLOR` and on a dumb terminal (`RS-TUI-C05`).
 *
 * No prompt asks twice. Each one reads a line, states what it accepted or why it
 * stopped, and returns that, so a caller that wants to ask again can loop over a
 * refusal and a caller that wants to stop returns it upward: the text an operator
 * reads has already been written by the time the caller sees it.
 */

import readline from 'node:readline';

/** @typedef {import('node:tty').ReadStream} TerminalInput */

/**
 * The word that cancels any prompt, whatever it is asking. A line whose only
 * content is this word cancels and a line with anything else in it is an answer,
 * so the rule is stated the same way at every prompt rather than per prompt.
 */
const CANCEL_WORD = 'q';

/** Ctrl-C, which readline reports as an event rather than delivering a signal in raw mode. */
const INTERRUPTED = Symbol('interrupted by Ctrl-C');

/** Standard input ended before the prompt had an answer to work with. */
const ENDED = Symbol('the input stream ended');

/** Anything that could open an escape sequence, stripped from text that is not this module's own. */
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
/** Every control character, so that one written line stays one written line. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * @typedef {object} PromptStreams
 * @property {NodeJS.ReadableStream} input Read one line at a time from here, so a test can pass a pipe instead of a terminal.
 * @property {NodeJS.WritableStream} output Every line the prompt writes goes here, so a test can read back what the operator saw.
 */

/**
 * @typedef {object} PromptChoice
 * @property {string} label One line of plain text describing the option; the prompt adds the number.
 */

/**
 * @typedef {object} PromptRefusal
 * @property {false} ok
 * @property {'cancelled' | 'refused'} reason `cancelled` when the operator typed q or pressed Ctrl-C, `refused` when the answer was not one the prompt could accept.
 * @property {string} message What stopped the prompt and what it expected, already written to the output stream.
 */

/**
 * @typedef {{ ok: true, value: string }} SecretAnswer
 * @typedef {{ ok: true, index: number, label: string }} ChoiceAnswer Row number as it was printed, counting from one.
 * @typedef {{ ok: true, indices: number[], labels: string[] }} SelectionAnswer Row numbers as they were printed, counting from one, in ascending order.
 * @typedef {{ ok: true, value: boolean }} ConfirmAnswer
 * @typedef {{ ok: true, value: string }} TextAnswer
 * @typedef {PromptRefusal | SecretAnswer} SecretResult
 * @typedef {PromptRefusal | ChoiceAnswer} ChoiceResult
 * @typedef {PromptRefusal | SelectionAnswer} SelectionResult
 * @typedef {PromptRefusal | ConfirmAnswer} ConfirmResult
 * @typedef {PromptRefusal | TextAnswer} TextResult
 */

/**
 * @callback TextValidator
 * @param {string} value The trimmed answer, exactly as typed.
 * @returns {{ ok: true, value: string } | { ok: false, message: string }} The value to use, or a refusal naming what was expected.
 */

/**
 * One line of plain text with nothing in it that could move the cursor or open
 * an escape sequence. Labels reach the terminal through here, because a
 * repository name that came from GitHub or from a configuration file is not
 * something this module can vouch for.
 * @param {string} text
 * @returns {string}
 */
function plainLine(text) {
  return text.replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHARACTER, ' ');
}

/**
 * @param {NodeJS.WritableStream} output
 * @param {string} text
 * @returns {void}
 */
function writeLine(output, text) {
  output.write(`${plainLine(text)}\n`);
}

/**
 * The `node:tty` side of a stream. A `ReadStream` is the only stream with
 * `setRawMode`, which is the operation that takes the terminal's own echo away
 * and puts it back. A pipe has no such side, which is why every prompt here
 * works from a pipe without a terminal being involved at all.
 * @param {NodeJS.ReadableStream} input
 * @returns {TerminalInput | null} The terminal behind the stream, or null when the input is not one.
 */
function terminalOf(input) {
  const candidate = /** @type {Partial<TerminalInput>} */ (input);
  if (candidate.isTTY !== true || typeof candidate.setRawMode !== 'function') return null;
  return /** @type {TerminalInput} */ (candidate);
}

/**
 * The reader one input stream is read through.
 *
 * One readline interface is created per stream and kept for as long as the flow
 * lasts, because a piped script arrives as a single chunk: an interface that
 * closed after its first line would swallow the answers to every question after
 * it, which is how an answer arrives against the wrong question.
 */
class LineReader {
  /**
   * @param {NodeJS.ReadableStream} input
   */
  constructor(input) {
    /** @type {NodeJS.ReadableStream} */
    this.input = input;
    /** @type {TerminalInput | null} */
    this.terminal = terminalOf(input);
    /** @type {Array<string | typeof INTERRUPTED>} */
    this.lines = [];
    /** @type {{ settle: (line: string | typeof INTERRUPTED | typeof ENDED) => void, reject: (error: unknown) => void } | null} */
    this.waiting = null;
    /** @type {unknown} */
    this.failure = null;
    this.ended = false;
    this.held = false;
    /** @type {import('node:readline').Interface} */
    this.interface = readline.createInterface({
      input,
      // Terminal mode is readline's own line editing, which is what keeps Enter
      // arriving as a line at all and what puts the terminal into raw mode.
      terminal: this.terminal !== null,
      crlfDelay: Infinity,
    });
    // No output is given here on purpose: readline echoes every character it
    // reads to the output it was handed, so an interface given none cannot show
    // a typed character however the prompt that owns it behaves.
    this.interface.on('line', (line) => {
      this.lines.push(line);
      this.settle();
    });
    this.interface.on('SIGINT', () => {
      this.lines.push(INTERRUPTED);
      this.settle();
    });
    this.interface.on('close', () => {
      this.ended = true;
      this.settle();
    });
    /**
     * A read that fails is an operational failure rather than a refusal, and it
     * is recorded here instead of thrown: readline re-emits an input error on the
     * interface it built, and an 'error' event with no listener takes the whole
     * process down rather than handing the failure to the prompt waiting on the
     * read, so the interface needs the listener as much as the input does.
     * @param {unknown} error
     * @returns {void}
     */
    const recordFailure = (error) => {
      this.failure = error;
      this.settle();
    };
    this.interface.on('error', recordFailure);
    input.on('error', recordFailure);
  }

  /**
   * Hand a queued line to whoever is waiting, or record that the stream ended.
   * @returns {void}
   */
  settle() {
    const waiting = this.waiting;
    if (waiting === null) return;
    const queued = this.lines.shift();
    if (queued !== undefined) {
      this.waiting = null;
      waiting.settle(queued);
      return;
    }
    if (this.failure !== null) {
      const failure = this.failure;
      this.waiting = null;
      waiting.reject(failure);
      return;
    }
    if (this.ended) {
      this.waiting = null;
      waiting.settle(ENDED);
    }
  }

  /**
   * @returns {Promise<string | typeof INTERRUPTED | typeof ENDED>} The next line, or why there is none.
   */
  readLine() {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve(ENDED);
    return new Promise((resolve, reject) => {
      this.waiting = {
        settle: (line) => {
          this.waiting = null;
          resolve(line);
        },
        reject: (error) => {
          this.waiting = null;
          reject(error);
        },
      };
    });
  }

  /**
   * Take exclusive hold of the reader, because two prompts reading one stream at
   * once is how an answer arrives against the wrong question.
   * @returns {() => void} The release, which must run on every exit path.
   */
  acquire() {
    if (this.held) {
      throw new Error(
        'another prompt already holds this input stream; one prompt reads standard input at a time',
      );
    }
    this.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held = false;
    };
  }

  /**
   * Switch the terminal's own echo off for the length of one read. `setRawMode`
   * from `node:tty` is the only way to do that, and with readline holding no
   * output it is the only thing that could show the value being typed, so the
   * returned restore puts the terminal back exactly as it was found. Every
   * prompt that reads a value calls it from `finally`.
   * @returns {() => void} The restore.
   */
  muteTerminal() {
    const terminal = this.terminal;
    if (terminal === null) return () => {};
    const previousRaw = terminal.isRaw === true;
    terminal.setRawMode(true);
    return () => {
      terminal.setRawMode(previousRaw);
    };
  }

  /**
   * @returns {void}
   */
  close() {
    this.interface.close();
    // A readline interface keeps its input resumed, which would hold the process
    // open after the last prompt; pausing is what lets the command end.
    this.input.pause();
  }
}

/** @type {WeakMap<NodeJS.ReadableStream, LineReader>} */
const readers = new WeakMap();

/**
 * The one reader bound to this input stream.
 * @param {NodeJS.ReadableStream} input
 * @returns {LineReader}
 */
function readerFor(input) {
  const existing = readers.get(input);
  if (existing !== undefined) return existing;
  const reader = new LineReader(input);
  readers.set(input, reader);
  return reader;
}

/**
 * Close the session bound to this input stream and forget it. The command calls
 * this before it returns, because a prompt surface that leaves standard input
 * resumed is a command that never exits.
 * @param {NodeJS.ReadableStream} input The stream the prompts were driven from.
 * @returns {void}
 */
export function closePromptSession(input) {
  const reader = readers.get(input);
  if (reader === undefined) return;
  readers.delete(input);
  reader.close();
}

/**
 * @template T
 * @param {NodeJS.ReadableStream} input
 * @param {(reader: LineReader) => Promise<T>} body The prompt, run while the reader is held.
 * @returns {Promise<T>}
 */
async function holding(input, body) {
  const reader = readerFor(input);
  const release = reader.acquire();
  try {
    return await body(reader);
  } finally {
    release();
  }
}

/**
 * A piped answer is echoed by nobody, so the line it was typed on is closed here
 * before the next prompt writes anything.
 * @param {NodeJS.ReadableStream} input
 * @param {NodeJS.WritableStream} output
 * @returns {void}
 */
function closeTypedLine(input, output) {
  if (terminalOf(input) === null) output.write('\n');
}

/**
 * @param {NodeJS.WritableStream} output
 * @param {string} message
 * @returns {PromptRefusal}
 */
function cancelled(output, message) {
  writeLine(output, `cancelled: ${message}`);
  return { ok: false, reason: 'cancelled', message };
}

/**
 * @param {NodeJS.WritableStream} output
 * @param {string} message
 * @returns {PromptRefusal}
 */
function refused(output, message) {
  writeLine(output, `refused: ${message}`);
  return { ok: false, reason: 'refused', message };
}

/**
 * Ask for a value that must not be shown. Nothing typed here is echoed: not by
 * readline, whose output is taken away for the read, and not by the terminal,
 * whose own echo is switched off through `node:tty` and restored from `finally`.
 * The returned value is the only place those characters exist; this function
 * never passes them to an output function.
 * @param {PromptStreams & { message: string }} options The prompt text and the streams to read and write.
 * @returns {Promise<SecretResult>}
 */
export async function promptSecret(options) {
  const { input, message, output } = options;
  return holding(input, async (reader) => {
    writeLine(output, message);
    writeLine(output, 'Nothing typed here is echoed. Press Enter when the value is complete.');
    writeLine(output, `Type ${CANCEL_WORD} on its own to cancel.`);
    const restore = reader.muteTerminal();
    /** @type {string | typeof INTERRUPTED | typeof ENDED} */
    let line;
    try {
      line = await reader.readLine();
    } finally {
      restore();
    }
    // The terminal showed nothing while the value was typed, so the line the
    // operator pressed Enter on is closed here rather than echoed.
    output.write('\n');
    if (line === INTERRUPTED) {
      return cancelled(output, 'Ctrl-C ended the entry, and nothing was entered.');
    }
    if (line === ENDED) {
      return cancelled(output, 'standard input ended before a value was entered.');
    }
    if (line.trim() === CANCEL_WORD) {
      return cancelled(output, `no value was entered, because ${CANCEL_WORD} cancels.`);
    }
    if (line.trim() === '') {
      return refused(output, 'nothing was entered, so there is no value to use.');
    }
    writeLine(output, 'accepted; nothing was echoed.');
    return { ok: true, value: line };
  });
}

/**
 * Ask which one of a numbered list the operator meant. The options are written as
 * text, so answering needs nothing but reading back the number that was printed.
 * @param {PromptStreams & { message: string, choices: PromptChoice[] }} options The question, the options and the streams.
 * @returns {Promise<ChoiceResult>}
 */
export async function promptChoice(options) {
  const { choices, input, message, output } = options;
  if (choices.length === 0) {
    return refused(output, 'there are no choices to offer, so nothing can be chosen.');
  }
  return holding(input, async (reader) => {
    writeLine(output, message);
    choices.forEach((choice, index) => {
      writeLine(output, `  ${index + 1}) ${choice.label}`);
    });
    writeLine(output, `Answer with the number of one choice, 1 to ${choices.length}.`);
    writeLine(output, `Type ${CANCEL_WORD} to cancel.`);
    const line = await reader.readLine();
    closeTypedLine(input, output);
    if (line === INTERRUPTED) {
      return cancelled(output, 'Ctrl-C ended the question, and no choice was made.');
    }
    if (line === ENDED) {
      return cancelled(output, 'standard input ended before a choice was made.');
    }
    if (line.trim() === CANCEL_WORD) {
      return cancelled(output, `no choice was made, because ${CANCEL_WORD} cancels.`);
    }
    const answer = line.trim();
    const chosen = Number(answer);
    if (!/^\d+$/u.test(answer) || chosen < 1 || chosen > choices.length) {
      const typed = answer === '' ? 'no number was typed' : `"${answer}" is not one of the numbered choices`;
      return refused(
        output,
        `${typed}, so answer with a number from 1 to ${choices.length}, or type ${CANCEL_WORD} to cancel.`,
      );
    }
    const choice = choices[chosen - 1];
    if (choice === undefined) {
      return refused(output, `${chosen} names no choice, which cannot happen for a list of ${choices.length}.`);
    }
    writeLine(output, `chosen ${chosen}: ${choice.label}`);
    return { ok: true, index: chosen, label: choice.label };
  });
}

/**
 * @typedef {{ kind: 'toggle', row: number } | { kind: 'all' } | { kind: 'none' } | { kind: 'invert' }} SelectionAction
 */

/**
 * Read one typed line as a run of selection keys. Digits build a row number, a
 * space toggles the row that number named, and the three words act on the whole
 * list. A row number that never reached a space is refused rather than dropped,
 * because a half-typed number that is ignored looks exactly like one that was
 * never wanted.
 * @param {string} line The line as typed.
 * @returns {{ actions: SelectionAction[], refusal: string | null }} What the line did, and the first thing it did wrong.
 */
function readSelectionKeys(line) {
  /** @type {SelectionAction[]} */
  const actions = [];
  let row = '';
  /** @type {string | null} */
  let refusal = null;
  for (const character of line) {
    if (character >= '0' && character <= '9') {
      row += character;
      continue;
    }
    if (character === ' ') {
      // A space toggles what was just named. A space with nothing named has
      // nothing to toggle, which the keys line has already stated.
      if (row !== '') actions.push({ kind: 'toggle', row: Number(row) });
      row = '';
      continue;
    }
    if (character === 'a' || character === 'n' || character === 'i') {
      actions.push({ kind: character === 'a' ? 'all' : character === 'n' ? 'none' : 'invert' });
      row = '';
      continue;
    }
    refusal ??=
      `"${character}" is not a selection key; a row number, a space to toggle it, and a, n or i are.`;
  }
  if (refusal === null && row !== '') {
    refusal = `${row} was named but never toggled; a row number needs a space after it, for example "${row} ".`;
  }
  return { actions, refusal };
}

/**
 * @typedef {object} SelectionOptions
 * @property {string} message The question to put above the rows.
 * @property {PromptChoice[]} choices The rows to choose from, numbered from one.
 * @property {number[]} [selected] Rows already chosen, so a second visit starts where the last one ended.
 * @property {NodeJS.ReadableStream} input Read one line at a time from here.
 * @property {NodeJS.WritableStream} output Every line the prompt writes goes here.
 */

/**
 * Choose any number of rows from a numbered list, one line at a time. Each line
 * is a run of keys: a row number and a space toggle that row, `a` selects every
 * row, `n` selects none, `i` inverts, and an empty line accepts what is chosen.
 * Every line states what it changed and how many rows are chosen, because the
 * selection is a set of words and never a colour.
 * @param {SelectionOptions} options The question, the rows, the rows already chosen and the streams.
 * @returns {Promise<SelectionResult>}
 */
export async function promptSelection(options) {
  const { choices, input, message, output } = options;
  /** @type {number[]} */
  const initial = options.selected ?? [];
  const chosen = new Set(initial.filter((row) => row >= 1 && row <= choices.length));
  return holding(input, async (reader) => {
    const rows = () => [...chosen].sort((left, right) => left - right);
    /** @param {number} row */
    const labelOf = (row) => choices[row - 1]?.label ?? `row ${row}`;
    const state = () => `Chosen ${chosen.size} of ${choices.length} (rows ${rows().join(', ') || 'none'}).`;

    writeLine(output, message);
    choices.forEach((choice, index) => {
      writeLine(
        output,
        `  ${index + 1}) ${choice.label} - ${chosen.has(index + 1) ? 'selected' : 'not selected'}`,
      );
    });
    writeLine(output, 'On one line: a row number then a space toggles that row; a selects all, n selects none, i inverts.');
    writeLine(output, `Press Enter on an empty line to accept. Type ${CANCEL_WORD} to cancel.`);
    writeLine(output, state());

    for (;;) {
      const line = await reader.readLine();
      closeTypedLine(input, output);
      if (line === INTERRUPTED) {
        return cancelled(output, 'Ctrl-C ended the selection, and nothing was chosen.');
      }
      if (line === ENDED) {
        return cancelled(output, 'standard input ended before a selection was accepted.');
      }
      if (line.trim() === CANCEL_WORD) {
        return cancelled(output, `the selection was left as it was, because ${CANCEL_WORD} cancels.`);
      }
      if (line.trim() === '') {
        if (chosen.size === 0) {
          return refused(
            output,
            'nothing is chosen; press space on at least one row, or a to select all of them, before an empty line accepts.',
          );
        }
        const indices = rows();
        writeLine(
          output,
          `accepted ${indices.length} of ${choices.length}: ${indices.map(labelOf).join(', ')}.`,
        );
        return { ok: true, indices, labels: indices.map(labelOf) };
      }
      const { actions, refusal } = readSelectionKeys(line);
      for (const action of actions) {
        if (action.kind === 'all') {
          choices.forEach((_choice, index) => chosen.add(index + 1));
          writeLine(output, `all ${choices.length} rows are now selected.`);
          continue;
        }
        if (action.kind === 'none') {
          chosen.clear();
          writeLine(output, 'no rows are now selected.');
          continue;
        }
        if (action.kind === 'invert') {
          choices.forEach((_choice, index) => {
            if (chosen.has(index + 1)) chosen.delete(index + 1);
            else chosen.add(index + 1);
          });
          writeLine(output, `selection inverted: ${chosen.size} of ${choices.length} rows are now selected.`);
          continue;
        }
        const row = action.row;
        if (row < 1 || row > choices.length) {
          writeLine(
            output,
            `refused: ${row} is not one of the numbered rows, 1 to ${choices.length}; a row number names a row that is listed.`,
          );
          continue;
        }
        if (chosen.has(row)) chosen.delete(row);
        else chosen.add(row);
        writeLine(output, `row ${row} (${labelOf(row)}) is now ${chosen.has(row) ? 'selected' : 'not selected'}.`);
      }
      if (refusal !== null) writeLine(output, `refused: ${refusal}`);
      writeLine(output, state());
    }
  });
}

/**
 * Ask a yes or no question and state which answer an empty line takes, because a
 * default nobody was told about is not a default. `q` is the cancel escape every
 * prompt has, so it cancels this one too instead of quietly taking the default.
 * @param {PromptStreams & { message: string, defaultValue?: boolean }} options The question, the default and the streams.
 * @returns {Promise<ConfirmResult>}
 */
export async function promptConfirm(options) {
  const { input, message, output } = options;
  const defaultValue = options.defaultValue ?? true;
  return holding(input, async (reader) => {
    writeLine(output, message);
    writeLine(output, 'Answer y or n.');
    writeLine(output, `Press Enter for the default: ${defaultValue ? 'yes' : 'no'}.`);
    writeLine(output, `Type ${CANCEL_WORD} to cancel.`);
    const line = await reader.readLine();
    closeTypedLine(input, output);
    if (line === INTERRUPTED) {
      return cancelled(output, 'Ctrl-C ended the question, and the default was not taken.');
    }
    if (line === ENDED) {
      return cancelled(output, 'standard input ended before the question was answered.');
    }
    if (line.trim() === CANCEL_WORD) {
      return cancelled(output, `${CANCEL_WORD} cancels, so the default was not taken either.`);
    }
    const answer = line.trim().toLowerCase();
    if (answer === '') {
      writeLine(output, `answered ${defaultValue ? 'yes' : 'no'}, the stated default.`);
      return { ok: true, value: defaultValue };
    }
    if (answer === 'y' || answer === 'yes') {
      writeLine(output, 'answered yes.');
      return { ok: true, value: true };
    }
    if (answer === 'n' || answer === 'no') {
      writeLine(output, 'answered no.');
      return { ok: true, value: false };
    }
    return refused(
      output,
      `"${line.trim()}" is neither yes nor no; answer y or n, press Enter for the default ${
        defaultValue ? 'yes' : 'no'
      }, or type ${CANCEL_WORD} to cancel.`,
    );
  });
}

/**
 * Ask for a value the caller will use, and let the caller's validator decide
 * whether it is one. The answer is trimmed before the validator sees it, and the
 * validator's refusal is returned unchanged, so one rule owns what a value may be
 * instead of two disagreeing about it.
 * @param {PromptStreams & { message: string, validate: TextValidator }} options The question, the validator and the streams.
 * @returns {Promise<TextResult>}
 */
export async function promptText(options) {
  const { input, message, output, validate } = options;
  return holding(input, async (reader) => {
    writeLine(output, message);
    writeLine(output, 'Type a value and press Enter.');
    writeLine(output, `Type ${CANCEL_WORD} to cancel.`);
    // Nothing is shown as it is typed here either: the reader's interface holds
    // no output, so the accepted value is stated below in words instead. The
    // masked field is the same read with the terminal's echo switched off.
    const line = await reader.readLine();
    closeTypedLine(input, output);
    if (line === INTERRUPTED) {
      return cancelled(output, 'Ctrl-C ended the entry, and no value was entered.');
    }
    if (line === ENDED) {
      return cancelled(output, 'standard input ended before a value was entered.');
    }
    if (line.trim() === CANCEL_WORD) {
      return cancelled(output, `no value was entered, because ${CANCEL_WORD} cancels.`);
    }
    const accepted = validate(line.trim());
    if (accepted.ok) {
      writeLine(output, 'accepted.');
      return { ok: true, value: accepted.value };
    }
    return refused(output, accepted.message);
  });
}
