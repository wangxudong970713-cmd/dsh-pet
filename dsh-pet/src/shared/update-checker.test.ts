import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareSemver } = require('../../runtime/electron-helper/update-checker.js');

describe('update-checker —— 语义化版本比对', () => {
  test('远程版本高于当前版本返回 1', () => {
    assert.equal(compareSemver('0.3.1', '0.3.0'), 1);
    assert.equal(compareSemver('v0.4.0', '0.3.0'), 1);
    assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
  });

  test('远程版本等于当前版本返回 0', () => {
    assert.equal(compareSemver('0.3.0', '0.3.0'), 0);
    assert.equal(compareSemver('v0.3.0', '0.3.0'), 0);
  });

  test('远程版本低于当前版本返回 -1', () => {
    assert.equal(compareSemver('0.2.11', '0.3.0'), -1);
    assert.equal(compareSemver('0.1.99', '0.2.0'), -1);
  });
});
