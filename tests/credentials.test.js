import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { inspect } from 'node:util';
import test from 'node:test';
import { resolveHomePaths } from '../src/paths.js';
import { CredentialConfigurationError, loadCredentials } from '../src/credentials/store.js';
import { redact, REDACTED } from '../src/credentials/redact.js';

const FAKE_TOKEN = 'ghp_' + 'obviouslyFAKEtestONLY'.repeat(3);

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const directory = mkdtempSync('/tmp/opencode/repo-signal-credentials-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = resolveHomePaths({ env: { REPO_SIGNAL_HOME: path.join(directory, 'home') } });
  if (process.platform !== 'win32') assert.equal(statSync(paths.home).mode & 0o777, 0o700);
  return paths;
}

/** @param {string} file @param {string} text @param {number} [mode] */
function writeCredential(file, text, mode = 0o600) {
  writeFileSync(file, text, { mode });
  chmodSync(file, mode); // Make the test independent of the caller's umask.
}

/** @param {() => unknown} action @param {string} code @param {string[]} [fragments] */
function rejectsCredential(action, code, fragments = []) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof CredentialConfigurationError);
    assert.equal(error.code, code);
    for (const fragment of fragments) assert.ok(error.message.includes(fragment));
    assert.ok(!inspect(error).includes(FAKE_TOKEN));
    assert.ok(!error.stack?.includes(FAKE_TOKEN));
    assert.equal(error.cause, undefined);
    return true;
  });
}

for (const mode of [0o644, 0o666, 0o400, 0o700, 0o4600]) {
  const observed = mode.toString(8).padStart(4, '0');
  test(`refuses mode ${observed} before parsing and names the observed mode`, {
    skip: process.platform === 'win32',
  }, (t) => {
    const paths = fixture(t);
    writeCredential(paths.credentialsPath, `invalid JSON ${FAKE_TOKEN}`, mode);
    rejectsCredential(() => loadCredentials(paths), 'ERR_CREDENTIAL_FILE_MODE',
      [paths.credentialsPath, observed, '0600']);
    assert.equal(statSync(paths.credentialsPath).mode & 0o7777, mode);
    assert.equal(readFileSync(paths.credentialsPath, 'utf8'), `invalid JSON ${FAKE_TOKEN}`);
  });
}

test('0600 credentials expose the exact token only through getToken', (t) => {
  const paths = fixture(t);
  writeCredential(paths.credentialsPath, JSON.stringify({ token: FAKE_TOKEN }));
  const provider = loadCredentials(paths);
  assert.ok(provider.getToken() === FAKE_TOKEN, 'getter returns the stored credential');
  assert.deepEqual(Object.keys(provider), ['getToken']);
  assert.ok(Object.isFrozen(provider));
  for (const output of [JSON.stringify(provider), inspect(provider), String(provider)]) {
    assert.ok(!output.includes(FAKE_TOKEN));
  }
});

for (const [label, value, code] of [
  ['missing token', {}, 'ERR_CREDENTIAL_TOKEN_MISSING'],
  ['empty token', { token: '' }, 'ERR_CREDENTIAL_TOKEN_EMPTY'],
  ['blank token', { token: ' \n\t' }, 'ERR_CREDENTIAL_TOKEN_EMPTY'],
  ['null token', { token: null }, 'ERR_CREDENTIAL_TOKEN_TYPE'],
  ['numeric token', { token: 42 }, 'ERR_CREDENTIAL_TOKEN_TYPE'],
  ['array document', [], 'ERR_CREDENTIAL_SCHEMA'],
  ['null document', null, 'ERR_CREDENTIAL_SCHEMA'],
]) {
  test(`${label} yields a distinct credential configuration error`, (t) => {
    const paths = fixture(t);
    writeCredential(paths.credentialsPath, JSON.stringify(value));
    rejectsCredential(() => loadCredentials(paths), String(code), [paths.credentialsPath]);
  });
}

test('missing credential file yields an actionable configuration error with no fallback', (t) => {
  const paths = fixture(t);
  rejectsCredential(() => loadCredentials(paths), 'ERR_CREDENTIAL_FILE_MISSING',
    [paths.credentialsPath, 'missing', '0600']);
});

test('a directory is refused as a credential file', (t) => {
  const paths = fixture(t);
  mkdirSync(paths.credentialsPath);
  rejectsCredential(() => loadCredentials(paths), 'ERR_CREDENTIAL_FILE_TYPE', ['regular file']);
});

test('malformed JSON cannot leak credential contents through message, stack or cause', (t) => {
  const paths = fixture(t);
  writeCredential(paths.credentialsPath, `{"token":"${FAKE_TOKEN}", invalid}`);
  rejectsCredential(() => loadCredentials(paths), 'ERR_CREDENTIAL_JSON', ['malformed JSON']);
});

test('token-shaped paths are redacted in filesystem error surfaces', (t) => {
  const paths = fixture(t);
  rejectsCredential(() => loadCredentials({ credentialsPath: path.join(paths.home, FAKE_TOKEN) }),
    'ERR_CREDENTIAL_FILE_MISSING', [REDACTED]);
});

test('redacts all token-shaped values in error text, including repeated and embedded values', () => {
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_']) {
    const fake = prefix + 'obviously_FAKE_test_ONLY_123';
    const output = redact(new Error(`failed: ${fake}; path=/${fake}/; again ${fake}`).message);
    assert.ok(!output.includes(fake));
    assert.equal(output, `failed: ${REDACTED}; path=/${REDACTED}/; again ${REDACTED}`);
    assert.equal(redact(output), output);
  }
});

test('redacts bearer credentials and explicitly supplied opaque secrets', () => {
  assert.equal(redact('Authorization: Bearer obviously-FAKE.test'), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redact('failure: opaque-FAKE-value', ['opaque-FAKE-value']), `failure: ${REDACTED}`);
});

test('redaction preserves ordinary diagnostic text and repository names', () => {
  const message = 'owner/repo traffic permission missing; mode 0644; retry with read permission';
  assert.equal(redact(message), message);
  assert.equal(redact('', ['']), '');
});
