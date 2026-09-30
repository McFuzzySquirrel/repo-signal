import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, parseConfig } from '../src/config/load.js';
import { ConfigurationError, validateConfig } from '../src/config/schema.js';
import { resolveHomePaths } from '../src/paths.js';

/** @param {() => unknown} call @param {string} key @param {string} [code] */
function rejects(call, key, code = 'ERR_REPO_SIGNAL_CONFIG_INVALID') {
  assert.throws(call, error => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.code, code);
    assert.equal(error.key, key);
    assert.ok(error.message.includes(key));
    assert.match(error.message, /retry/);
    return true;
  });
}

test('unknown top-level key is rejected with the offending key', () => {
  rejects(() => parseConfig('{"enrolled":[],"unexpected":true}'), 'unexpected');
});

test('malformed JSON is rejected with the document key and no input excerpt', () => {
  rejects(() => parseConfig('{"enrolled":'), '$', 'ERR_REPO_SIGNAL_CONFIG_PARSE');
});

test('entry without a slash is rejected with its enrolled index', () => {
  rejects(() => validateConfig({ enrolled: ['repository'] }), 'enrolled[0]');
});

test('entry with surrounding whitespace is rejected rather than trimmed', () => {
  for (const repo of [' owner/repo', 'owner/repo ', '\towner/repo\n']) {
    rejects(() => validateConfig({ enrolled: [repo] }), 'enrolled[0]');
  }
});

test('hour outside 0-23 is rejected with collectionHourUtc named', () => {
  for (const collectionHourUtc of [-1, 24]) {
    rejects(() => validateConfig({ enrolled: [], collectionHourUtc }), 'collectionHourUtc');
  }
});

test('minimal valid configuration normalizes all omitted optional fields', () => {
  assert.deepEqual(parseConfig('{"enrolled":["Owner/Repo"]}'), {
    enrolled: ['Owner/Repo'], denyList: [], collectionHourUtc: 0, enabled: { 'Owner/Repo': true },
  });
});

test('empty enrolled list is valid with explicit empty defaults', () => {
  assert.deepEqual(validateConfig({ enrolled: [] }), {
    enrolled: [], denyList: [], collectionHourUtc: 0, enabled: {},
  });
});

test('explicit fields preserve case, order, duplicates, disabled entries and deny overlaps', () => {
  const input = {
    enrolled: ['Z/Repo', 'a/repo', 'Z/Repo'], denyList: ['Z/Repo', 'Other/Repo'],
    collectionHourUtc: 23, enabled: { 'Z/Repo': false, 'Other/Repo': true },
  };
  const before = JSON.stringify(input);
  const result = validateConfig(input);
  assert.deepEqual(result, { ...input, enabled: { 'Z/Repo': false, 'a/repo': true, 'Other/Repo': true } });
  result.enrolled.push('new/repo');
  result.denyList.push('new/repo');
  result.enabled['Z/Repo'] = true;
  assert.equal(JSON.stringify(input), before);
});

test('non-object documents and missing enrolled list are rejected', () => {
  for (const value of [null, [], 'text', 1, true]) rejects(() => validateConfig(value), '$');
  rejects(() => validateConfig({}), 'enrolled');
});

test('repository lists require arrays of strings and single nonempty pairs', () => {
  for (const key of ['enrolled', 'denyList']) {
    for (const value of [null, {}, 'owner/repo']) {
      rejects(() => validateConfig({ enrolled: [], [key]: value }), key);
    }
    for (const repo of [null, 1, {}, 'owner/repo/extra', '/repo', 'owner/', 'own er/repo', 'owner/re po', 'owner/\u0000repo']) {
      rejects(() => validateConfig({ enrolled: [], [key]: [repo] }), `${key}[0]`);
    }
  }
});

test('UTC hour must be an integer number and does not accept coercion', () => {
  for (const collectionHourUtc of [null, '12', 1.5, true, NaN, Infinity]) {
    rejects(() => validateConfig({ enrolled: [], collectionHourUtc }), 'collectionHourUtc');
  }
  assert.equal(validateConfig({ enrolled: [], collectionHourUtc: 0 }).collectionHourUtc, 0);
});

test('enabled flags require an object with repository keys and boolean values', () => {
  for (const enabled of [null, [], true]) rejects(() => validateConfig({ enrolled: [], enabled }), 'enabled');
  rejects(() => validateConfig({ enrolled: [], enabled: { repository: true } }), 'enabled.repository');
  for (const flag of ['false', 0, null, {}]) {
    rejects(() => validateConfig({ enrolled: [], enabled: { 'owner/repo': flag } }), 'enabled.owner/repo');
  }
});

test('configuration diagnostics never echo token-shaped values or JSON excerpts', () => {
  const token = 'github_pat_exampleSecret123';
  for (const call of [
    () => parseConfig(`{"enrolled": ["${token}"],`),
    () => validateConfig({ enrolled: [token] }),
    () => validateConfig({ enrolled: [], [token]: true }),
  ]) {
    assert.throws(call, error => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!String(error).includes(token));
      assert.ok(!error.key.includes(token));
      return true;
    });
  }
});

/** @param {import('node:test').TestContext} t */
function temporaryHome(t) {
  const root = mkdtempSync('/tmp/opencode/repo-signal-config-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { REPO_SIGNAL_HOME: path.join(root, 'home') } };
  return { options, paths: resolveHomePaths(options) };
}

test('missing configuration file has a dedicated error kind and resolved path', t => {
  const { options, paths } = temporaryHome(t);
  rejects(() => loadConfig(options), '$', 'ERR_REPO_SIGNAL_CONFIG_MISSING');
  assert.throws(() => loadConfig(options), { message: new RegExp(paths.configPath) });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(paths.home), []);
});

test('loader reads the home configuration and does not create other state files', t => {
  const { options, paths } = temporaryHome(t);
  writeFileSync(paths.configPath, '{"enrolled":["owner/repo"]}', { mode: 0o600 });
  assert.deepEqual(loadConfig(options), {
    enrolled: ['owner/repo'], denyList: [], collectionHourUtc: 0, enabled: { 'owner/repo': true },
  });
  assert.equal(statSync(paths.home).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(paths.home), ['config.json']);
});

test('loader distinguishes malformed JSON, schema failure and filesystem failure', t => {
  const { options, paths } = temporaryHome(t);
  writeFileSync(paths.configPath, '{');
  rejects(() => loadConfig(options), '$', 'ERR_REPO_SIGNAL_CONFIG_PARSE');
  writeFileSync(paths.configPath, '{"enrolled":["bad"]}');
  rejects(() => loadConfig(options), 'enrolled[0]');
  rmSync(paths.configPath);
  mkdirSync(paths.configPath);
  rejects(() => loadConfig(options), '$', 'ERR_REPO_SIGNAL_CONFIG_READ');
});
