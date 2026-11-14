import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateParams, webOrigin } from '../browser-extension/policy.js';

test('browser boundary accepts only the narrow action API and HTTP(S) origins', () => {
  const ref = '12345678-1234-1234-1234-123456789abc:1';
  for (const params of [{ action: 'snapshot' }, { action: 'click', ref }, { action: 'type', ref, text: '' }, { action: 'press', ref, key: 'Enter' }, { action: 'navigate', url: 'https://example.com/path' }]) assert.equal(validateParams(params), params);
  for (const params of [null, { action: 'evaluate', expression: '1' }, { action: 'snapshot', tabId: 123 }, { action: 'click', ref: '#button' }, { action: 'type', ref, text: 'a'.repeat(4001) }, { action: 'press', ref, key: 'toString' }, { action: 'navigate', url: 'file:///etc/passwd' }, { action: 'navigate', url: 'https://user:pass@example.com' }]) assert.throws(() => validateParams(params));
  assert.equal(webOrigin('https://example.com/path'), 'https://example.com');
});
