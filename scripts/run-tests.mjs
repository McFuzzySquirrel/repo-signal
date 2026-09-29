import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TARGETS = ['tests'];

const TEST_EXTENSION_PATTERN = /\.(?:js|mjs|cjs|ts|mts|cts)$/;
const TEST_NAME_SUFFIXES = ['.test', '_test', '-test'];
const SKIPPED_DIRECTORIES = new Set(['node_modules']);
const TAP_SUMMARY_PATTERN = /^\s*# (tests|pass|fail) (\d+)\s*$/;
const TAP_RESULT_PATTERN = /^(?:ok|not ok) \d+ - (.+)$/;

/**
 * @typedef {object} TapSummary
 * @property {number} tests Number of tests the runner selected.
 * @property {number} passed Number of tests that passed.
 * @property {number} failed Number of tests that failed.
 * @property {string[]} names Names the runner reported, one per selected test.
 * @property {boolean} complete True when the runner printed all three counter lines.
 */

/**
 * @typedef {object} RunnerResult
 * @property {number | null} code Exit code of the Node test runner.
 * @property {NodeJS.Signals | null} signal Signal that killed the runner, or null.
 * @property {string} output Captured stdout of the runner.
 */

/**
 * Mirror of the Node test runner's own default file pattern,
 * `**\/{test,test/**\/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}`, because the
 * runner treats a directory argument as a file to execute on Node 22 rather than
 * as a directory to search.
 * @param {string} filePath Path of a file, using this platform's separator.
 * @returns {boolean}
 */
function isTestFilePath(filePath) {
  if (!TEST_EXTENSION_PATTERN.test(filePath)) return false;
  const segments = filePath.split(path.sep);
  const base = segments[segments.length - 1] ?? '';
  const stem = base.replace(TEST_EXTENSION_PATTERN, '');
  if (stem === 'test' || stem.startsWith('test-')) return true;
  if (TEST_NAME_SUFFIXES.some((suffix) => stem.endsWith(suffix))) return true;
  return segments.slice(0, -1).includes('test');
}

/**
 * @param {string} directory
 * @returns {string[]} Test files inside the directory, sorted, symlinks not followed.
 */
function collectTestFilesIn(directory) {
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(entryPath);
      } else if (entry.isFile() && isTestFilePath(entryPath)) {
        found.push(entryPath);
      }
    }
  }
  return found.sort();
}

/**
 * @param {string} target A file or a directory, exactly as it was named.
 * @returns {string[]} The test files that target contributes, sorted.
 */
function resolveTarget(target) {
  const stats = statSync(target);
  if (stats.isDirectory()) return collectTestFilesIn(target);
  return [target];
}

/**
 * Read the counters the TAP reporter writes at the end of a run. A run that
 * never reached its summary reports zero tests, and the caller treats that as a
 * failure rather than as a pass.
 * @param {string} output Raw stdout of the test runner.
 * @returns {TapSummary}
 */
function parseTapSummary(output) {
  let tests = null;
  let passed = null;
  let failed = null;
  /** @type {string[]} */
  const names = [];
  for (const line of output.split('\n')) {
    const counter = TAP_SUMMARY_PATTERN.exec(line);
    if (counter !== null) {
      const value = Number(counter[2]);
      if (counter[1] === 'tests') tests = value;
      else if (counter[1] === 'pass') passed = value;
      else failed = value;
      continue;
    }
    const result = TAP_RESULT_PATTERN.exec(line);
    if (result !== null) names.push(result[1].trim());
  }
  return {
    tests: tests ?? 0,
    passed: passed ?? 0,
    failed: failed ?? 0,
    complete: tests !== null && passed !== null && failed !== null,
    names,
  };
}

/**
 * @param {string[]} files Absolute or repository-relative test files.
 * @returns {Promise<RunnerResult>}
 */
function runNodeTest(files) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, output });
    });
  });
}

/**
 * @param {unknown} error
 * @returns {string} The operating-system code when there is one, the message otherwise.
 */
function describeError(error) {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code);
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string[]} targets Files or directories named on the command line.
 * @returns {Promise<number>} Exit code the wrapper hands back to npm.
 */
async function runWrapper(targets) {
  const selected = targets.length > 0 ? targets : DEFAULT_TARGETS;
  /** @type {string[]} */
  let files = [];
  for (const target of selected) {
    try {
      files = files.concat(resolveTarget(target));
    } catch (error) {
      const reason = describeError(error);
      process.stderr.write(
        `tests: cannot use ${target} (${String(reason)}); ` +
          'pass a test file or a directory that exists, relative to the repository root\n',
      );
      return 1;
    }
  }
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) {
    process.stderr.write(
      `tests: no tests were selected by ${selected.join(' ')}; ` +
        'that path holds no file matching the Node test patterns ' +
        '(test.js, test-*.js, *.test.js, *-test.js, *_test.js, or a file under a test/ directory)\n',
    );
    return 1;
  }
  const command = `node --test --test-reporter=tap ${unique.join(' ')}`;
  let result;
  try {
    result = await runNodeTest(unique);
  } catch (error) {
    process.stderr.write(
      `tests: the test runner could not be started (${describeError(error)}); node is at ${process.execPath}\n`,
    );
    return 1;
  }
  if (result.signal !== null) {
    process.stderr.write(
      `tests: the test runner was killed by signal ${result.signal} before it reported a summary\n`,
    );
    return 1;
  }
  const summary = parseTapSummary(result.output);
  if (!summary.complete) {
    process.stderr.write(
      `tests: ${command} reported no test summary, so no result can be trusted; ` +
        'run that same command by hand to read the runner error it printed above\n',
    );
    return 1;
  }
  if (summary.tests === 0) {
    process.stderr.write(
      `tests: the test runner selected 0 tests from ${unique.length} named file(s); ` +
        'a named test file that contains no test is a failure, not a pass\n',
    );
    return 1;
  }
  // A test file that declares no test is reported by the Node 22 runner as one
  // passing subtest named after the file itself, so the counters alone let it
  // through. A result named after a file this run handed over is that case.
  const selfReported = summary.names.filter((name) => unique.some((file) => name.endsWith(file)));
  if (selfReported.length > 0) {
    process.stderr.write(
      `tests: ${selfReported.join(', ')} reported only itself, so it declares no test; ` +
        'a named test file that contains no test is a failure, not a pass\n',
    );
    return 1;
  }
  if (summary.failed > 0 || result.code !== 0) {
    process.stderr.write(
      `tests: ${summary.failed} of ${summary.tests} selected tests failed; ` +
        'each failure above names the file, the test and the assertion\n',
    );
    return 1;
  }
  return 0;
}

process.exitCode = await runWrapper(process.argv.slice(2));
