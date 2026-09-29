import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_SUITE_NOTE } from '../empty-suite/sample.js';

test('the passing fixture selects one test and it passes', () => {
  assert.equal(typeof EMPTY_SUITE_NOTE, 'string');
  assert.match(EMPTY_SUITE_NOTE, /no test file/);
});
