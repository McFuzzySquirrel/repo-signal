import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../src/config/schema.js';
import { resolveEnrollment } from '../src/enrollment/resolve.js';

/** @param {unknown} value @returns {import('../src/config/schema.js').Configuration} */
function config(value) {
  return validateConfig(value);
}

test('deny wins when the denied entry is declared first', () => {
  const result = resolveEnrollment(config({
    enrolled: ['owner/denied', 'owner/kept'],
    denyList: ['owner/denied'],
  }));
  assert.deepEqual(result, ['owner/kept']);
});

test('deny wins when the denied entry is listed first in the deny list', () => {
  const result = resolveEnrollment(config({
    enrolled: ['owner/kept', 'owner/denied'],
    denyList: ['owner/denied', 'owner/other'],
  }));
  assert.deepEqual(result, ['owner/kept']);
});

test('a repository only in the deny list is never returned even when also declared with different case', () => {
  const result = resolveEnrollment(config({
    enrolled: ['Owner/Denied', 'owner/kept'],
    denyList: ['owner/denied'],
  }));
  assert.deepEqual(result, ['owner/kept']);
  assert.ok(!result.some(repo => repo.toLowerCase() === 'owner/denied'));
});

test('a denied entry matching with different case in both directions is removed', () => {
  const a = resolveEnrollment(config({ enrolled: ['OWNER/REPO'], denyList: ['owner/repo'] }));
  const b = resolveEnrollment(config({ enrolled: ['owner/repo'], denyList: ['OWNER/REPO'] }));
  assert.deepEqual(a, []);
  assert.deepEqual(b, []);
});

test('entries differing only by case collapse to one survivor', () => {
  const result = resolveEnrollment(config({
    enrolled: ['Owner/Repo', 'owner/repo', 'OWNER/REPO', 'owner/other'],
  }));
  assert.deepEqual(result, ['Owner/Repo', 'owner/other']);
});

test('a disabled entry is dropped without error', () => {
  const result = resolveEnrollment(config({
    enrolled: ['owner/off', 'owner/on'],
    enabled: { 'owner/off': false },
  }));
  assert.deepEqual(result, ['owner/on']);
});

test('a disabled entry is distinguished from a configuration error because no throw occurs', () => {
  assert.doesNotThrow(() => resolveEnrollment(config({
    enrolled: ['owner/off'],
    enabled: { 'owner/off': false },
  })));
});

test('declared order of survivors is preserved', () => {
  const result = resolveEnrollment(config({
    enrolled: ['zeta/last', 'alpha/first', 'middle/repo', 'zeta/last', 'Alpha/First'],
    denyList: ['middle/blocked'],
  }));
  assert.deepEqual(result, ['zeta/last', 'alpha/first', 'middle/repo']);
});

test('an empty declared list resolves to an empty array and no error', () => {
  assert.deepEqual(resolveEnrollment(config({ enrolled: [] })), []);
});

test('a deny-only configuration resolves to an empty array', () => {
  assert.deepEqual(resolveEnrollment(config({ enrolled: [], denyList: ['owner/denied'] })), []);
});
