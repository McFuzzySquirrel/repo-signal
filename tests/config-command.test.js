import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli.js');
const TOKEN = 'ghp_' + 'OBVIOUSLY_FAKE_TEST_TOKEN_ONLY';
const TOKEN_SHAPE = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/;

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const directory = mkdtempSync('/tmp/opencode/repo-signal-config-command-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const config = path.join(home, 'config.json');
  const credentials = path.join(home, 'credentials.json');
  /** @param {string[]} args @param {string} [homeOverride] */
  const run = (args, homeOverride = home) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: directory,
    env: { ...process.env, REPO_SIGNAL_HOME: homeOverride, NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { directory, home, config, credentials, run };
}

/** @param {ReturnType<typeof spawnSync>} result @param {number} status */
function outcome(result, status) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, String(result.stderr));
  assert.doesNotMatch(String(result.stdout) + String(result.stderr), TOKEN_SHAPE);
}

test('config init then config check succeed through the entry point with private commented templates', t => {
  const f = fixture(t);
  const init = f.run(['config', 'init']);
  outcome(init, 0);
  assert.match(init.stdout, /configuration template created/);
  assert.match(init.stdout, /replace the non-secret placeholder/);
  assert.equal(statSync(f.home).mode & 0o7777, 0o700);
  assert.equal(statSync(f.config).mode & 0o7777, 0o600);
  assert.equal(statSync(f.credentials).mode & 0o7777, 0o600);
  assert.match(readFileSync(f.config, 'utf8'), /\/\/ Explicit opt-in/);
  assert.deepEqual(JSON.parse(readFileSync(f.credentials, 'utf8')), { token: 'REPLACE_WITH_YOUR_GITHUB_TOKEN' });
  assert.deepEqual(readdirSync(f.home).sort(), ['config.json', 'credentials.json']);
  assert.deepEqual(readdirSync(f.directory), ['home']);
  const configBeforeCheck = readFileSync(f.config, 'utf8');
  const credentialsBeforeCheck = readFileSync(f.credentials, 'utf8');
  const check = f.run(['config', 'check']);
  outcome(check, 0);
  assert.equal(check.stdout.trim().split('\n').length, 3);
  assert.match(check.stdout, /^configuration ok:/m);
  assert.match(check.stdout, /^credentials ok:/m);
  assert.match(check.stdout, /GitHub authentication not checked/);
  assert.match(check.stdout, /config check: ok\n$/);
  assert.equal(readFileSync(f.config, 'utf8'), configBeforeCheck);
  assert.equal(readFileSync(f.credentials, 'utf8'), credentialsBeforeCheck);
  assert.deepEqual(readdirSync(f.home).sort(), ['config.json', 'credentials.json']);
});

test('config check never prints a configured token or repository values', t => {
  const f = fixture(t);
  outcome(f.run(['config', 'init']), 0);
  writeFileSync(f.config, JSON.stringify({ enrolled: ['owner/' + TOKEN] }));
  writeFileSync(f.credentials, JSON.stringify({ token: TOKEN }));
  const check = f.run(['config', 'check']);
  outcome(check, 0);
  assert.equal(check.stdout.includes(TOKEN), false);
  assert.equal(check.stderr, '');
});

test('config check never retrieves or prints an opaque credential value', t => {
  const f = fixture(t);
  outcome(f.run(['config', 'init']), 0);
  const opaqueToken = 'OBVIOUSLY_FAKE_OPAQUE_CREDENTIAL_ONLY';
  writeFileSync(f.credentials, JSON.stringify({ token: opaqueToken }));
  const check = f.run(['config', 'check']);
  outcome(check, 0);
  assert.equal(check.stdout.includes(opaqueToken), false);
  assert.equal(check.stderr, '');
});

test('config init keeps token-shaped and multiline home paths safe in terminal output', t => {
  const f = fixture(t);
  const home = path.join(f.directory, TOKEN + '\ninjected-line');
  const result = f.run(['config', 'init'], home);
  outcome(result, 0);
  assert.match(result.stdout, /\[REDACTED\] injected-line/);
  assert.equal(result.stdout.trim().split('\n').length, 4);
  assert.equal(statSync(path.join(home, 'config.json')).mode & 0o7777, 0o600);
  assert.equal(statSync(path.join(home, 'credentials.json')).mode & 0o7777, 0o600);
  outcome(f.run(['config', 'check'], home), 0);
});

for (const existing of ['config', 'credentials']) {
  test(`config init refuses an existing ${existing} without changing or creating either file`, t => {
    const f = fixture(t);
    mkdirSync(f.home, { mode: 0o700 });
    const file = existing === 'config' ? f.config : f.credentials;
    const other = existing === 'config' ? f.credentials : f.config;
    writeFileSync(file, 'preserve these bytes', { mode: 0o600 });
    const result = f.run(['config', 'init']);
    outcome(result, 1);
    assert.match(result.stderr, /already exists.*--force/);
    assert.equal(readFileSync(file, 'utf8'), 'preserve these bytes');
    assert.equal(existsSync(other), false);
  });
}

test('config init --force replaces both templates and tightens both modes to 0600', t => {
  const f = fixture(t);
  outcome(f.run(['config', 'init']), 0);
  for (const file of [f.config, f.credentials]) {
    writeFileSync(file, 'old bytes');
    chmodSync(file, 0o644);
  }
  outcome(f.run(['config', 'init', '--force']), 0);
  for (const file of [f.config, f.credentials]) assert.equal(statSync(file).mode & 0o7777, 0o600);
  outcome(f.run(['config', 'check']), 0);
});

test('config check reports both missing files and a failed verdict', t => {
  const f = fixture(t);
  const result = f.run(['config', 'check']);
  outcome(result, 1);
  assert.match(result.stdout, /^configuration failed:.*missing/m);
  assert.match(result.stdout, /^credentials failed:.*missing/m);
  assert.match(result.stdout, /config check: failed\n$/);
  assert.equal(statSync(f.home).mode & 0o7777, 0o700);
  assert.deepEqual(readdirSync(f.home), []);
});

for (const mode of [0o644, 0o666]) {
  test(`config check refuses credentials with mode ${mode.toString(8)} without leaking contents`, t => {
    const f = fixture(t);
    outcome(f.run(['config', 'init']), 0);
    writeFileSync(f.credentials, JSON.stringify({ token: TOKEN }));
    chmodSync(f.credentials, mode);
    const result = f.run(['config', 'check']);
    outcome(result, 1);
    assert.match(result.stdout, /^configuration ok:/m);
    assert.match(result.stdout, new RegExp(`credentials failed:.*mode 0${mode.toString(8)}`));
    assert.equal(statSync(f.credentials).mode & 0o7777, mode);
  });
}

test('config check redacts invalid configuration keys and malformed credential parser excerpts', t => {
  const f = fixture(t);
  outcome(f.run(['config', 'init']), 0);
  writeFileSync(f.config, JSON.stringify({ enrolled: [], [TOKEN]: true }));
  writeFileSync(f.credentials, '{"token": "' + TOKEN + '" broken}');
  const result = f.run(['config', 'check']);
  outcome(result, 1);
  assert.match(result.stdout, /configuration failed:.*\[REDACTED\]/);
  assert.match(result.stdout, /credentials failed:.*malformed JSON/);
});

test('config check rejects empty token strings and does not repair the file', t => {
  const f = fixture(t);
  outcome(f.run(['config', 'init']), 0);
  const text = '{"token":" "}';
  writeFileSync(f.credentials, text);
  const result = f.run(['config', 'check']);
  outcome(result, 1);
  assert.match(result.stdout, /credentials failed:.*empty token/);
  assert.equal(readFileSync(f.credentials, 'utf8'), text);
});

test('whole-line comments do not change strings or relax schema and JSON validation', t => {
  const f = fixture(t);
  outcome(f.run(['config', 'init']), 0);
  writeFileSync(f.config, '{\n// guidance\n"enrolled":["owner/repo//suffix"]\n}\n');
  outcome(f.run(['config', 'check']), 1); // Invalid owner/name, not silently rewritten.
  writeFileSync(f.config, '{\n// guidance\n"enrolled":[],\n}\n');
  const result = f.run(['config', 'check']);
  outcome(result, 1);
  assert.match(result.stdout, /configuration failed:.*malformed JSON/);
  writeFileSync(f.config, '{\n"enrolled":[] // inline comments are not accepted\n}\n');
  const inlineComment = f.run(['config', 'check']);
  outcome(inlineComment, 1);
  assert.match(inlineComment.stdout, /configuration failed:.*malformed JSON/);
});

for (const args of [['config', 'init', '--unknown'], ['config', 'init', '--force', '--force'], ['config', 'check', '--force']]) {
  test(`${args.join(' ')} is a usage error and writes no home`, t => {
    const f = fixture(t);
    const result = f.run(args);
    outcome(result, 2);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /config init \[--force\]/);
    assert.equal(existsSync(f.home), false);
  });
}

test('help and unknown config subcommands list only the scoped commands without writes', t => {
  const f = fixture(t);
  const help = f.run(['--help']);
  outcome(help, 0);
  assert.match(help.stdout, /config init \[--force\]/);
  assert.match(help.stdout, /config check/);
  assert.doesNotMatch(help.stdout, /\b(?:collect|serve|backfill)\b/);
  const unknown = f.run(['config', 'unknown']);
  outcome(unknown, 2);
  assert.match(unknown.stderr, /Usage:/);
  assert.equal(existsSync(f.home), false);
});

test('init refuses symlinks even with force and leaves the target unchanged', t => {
  const f = fixture(t);
  mkdirSync(f.home, { mode: 0o700 });
  const target = path.join(f.directory, 'target');
  writeFileSync(target, 'untouched', { mode: 0o600 });
  symlinkSync(target, f.config);
  outcome(f.run(['config', 'init']), 1);
  outcome(f.run(['config', 'init', '--force']), 1);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.equal(existsSync(f.credentials), false);
});

test('home resolution failures redact token-shaped paths in both commands', t => {
  const f = fixture(t);
  const home = path.join(f.directory, TOKEN);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(path.join(home, '.git'));
  for (const command of ['init', 'check']) {
    const result = f.run(['config', command], home);
    outcome(result, 1);
    assert.match(result.stdout + result.stderr, /\[REDACTED\]/);
  }
});

for (const kind of ['symlink', 'directory']) {
  test(`config init --force preflights a credential ${kind} before changing the configuration`, t => {
    const f = fixture(t);
    mkdirSync(f.home, { mode: 0o700 });
    writeFileSync(f.config, 'preserve configuration bytes', { mode: 0o600 });
    const target = path.join(f.directory, 'target');
    if (kind === 'symlink') {
      writeFileSync(target, 'preserve credential bytes', { mode: 0o600 });
      symlinkSync(target, f.credentials);
    } else {
      mkdirSync(f.credentials);
    }
    const result = f.run(['config', 'init', '--force']);
    outcome(result, 1);
    assert.match(result.stderr, /not a regular file/);
    assert.equal(readFileSync(f.config, 'utf8'), 'preserve configuration bytes');
    assert.equal(statSync(f.home).mode & 0o7777, 0o700);
    if (kind === 'symlink') assert.equal(readFileSync(target, 'utf8'), 'preserve credential bytes');
    else assert.deepEqual(readdirSync(f.credentials), []);
  });
}
