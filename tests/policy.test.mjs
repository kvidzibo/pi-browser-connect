import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateParams, webOrigin, sharedPage, shareTarget } from '../browser-extension/policy.js';

test('browser boundary accepts only the narrow action API and HTTP(S) origins', () => {
  const ref = '12345678-1234-1234-1234-123456789abc:1';
  for (const params of [{ action: 'snapshot' }, { action: 'evaluate', expression: '1' }, { action: 'evaluate', expression: 'a'.repeat(4000) }, { action: 'inspect', selector: 'img' }, { action: 'click', ref }, { action: 'type', ref, text: '' }, { action: 'press', ref, key: 'Enter' }, { action: 'navigate', url: 'https://example.com/path' }]) assert.equal(validateParams(params), params);
  for (const params of [null, { action: 'inspect' }, { action: 'inspect', selector: ' ' }, { action: 'inspect', selector: 'a'.repeat(501) }, { action: 'inspect', selector: 'img', expression: '1' }, { action: 'evaluate' }, { action: 'evaluate', expression: '' }, { action: 'evaluate', expression: ' \n\t' }, { action: 'evaluate', expression: 1 }, { action: 'evaluate', expression: null }, { action: 'evaluate', expression: 'a'.repeat(4001) }, { action: 'evaluate', expression: '1', ref }, { action: 'evaluate', expression: '1', selector: 'body' }, { action: 'snapshot', expression: '1' }, { action: 'snapshot', tabId: 123 }, { action: 'click', ref: '#button' }, { action: 'type', ref, text: 'a'.repeat(4001) }, { action: 'press', ref, key: 'toString' }, { action: 'navigate', url: 'file:///etc/passwd' }, { action: 'navigate', url: 'https://user:pass@example.com' }]) assert.throws(() => validateParams(params));
  assert.equal(webOrigin('https://example.com/path'), 'https://example.com');
  assert.equal(sharedPage('about:blank'), 'about:blank');
  assert.equal(shareTarget(undefined), 'about:blank');
  assert.equal(shareTarget('https://example.com/path'), 'https://example.com');
  for (const url of ['chrome://newtab/', 'chrome://settings/', 'file:///etc/passwd', 'about:blankish', 'chrome-error://chromewebdata/', undefined]) assert.throws(() => sharedPage(url));
  for (const url of ['chrome://settings/', 'file:///etc/passwd', 'https://user:pass@example.com']) assert.throws(() => shareTarget(url));
});
