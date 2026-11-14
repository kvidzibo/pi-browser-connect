export const actions = ['tabs', 'snapshot', 'inspect', 'click', 'type', 'press', 'scroll', 'navigate', 'screenshot', 'evaluate'];
export const keys = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
};

export function webOrigin(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only HTTP(S) tabs without URL credentials can be shared.');
  return parsed.origin;
}

export function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || !actions.includes(params.action)) throw new Error('Unknown browser action.');
  const fields = { tabs: [], snapshot: [], inspect: ['selector'], click: ['ref'], type: ['ref', 'text'], press: ['ref', 'key'], scroll: ['direction'], navigate: ['url'], screenshot: [], evaluate: ['expression'] }[params.action];
  if (Object.keys(params).some(key => key !== 'action' && !fields.includes(key))) throw new Error('Unexpected action parameter.');
  if (fields.includes('ref') && (typeof params.ref !== 'string' || !/^[a-f0-9-]{36}:\d{1,3}$/.test(params.ref))) throw new Error('Use an element reference from the latest snapshot.');
  if (params.action === 'inspect' && (typeof params.selector !== 'string' || !params.selector.trim() || params.selector.length > 500)) throw new Error('Use a nonblank CSS selector of at most 500 characters.');
  if (params.action === 'inspect' && !/^[a-zA-Z0-9_.*#,\s>+~-]+$/.test(params.selector)) throw new Error('Use simple CSS selectors: tags, IDs, classes and combinators only; no attributes, pseudo-classes or escapes.');
  if (params.action === 'evaluate' && (typeof params.expression !== 'string' || !params.expression.trim() || params.expression.length > 4000)) throw new Error('Use a nonblank JavaScript expression of at most 4,000 characters.');
  if (params.action === 'type' && (typeof params.text !== 'string' || params.text.length > 4000)) throw new Error('Text must be at most 4,000 characters.');
  if (params.action === 'press' && !Object.hasOwn(keys, params.key)) throw new Error('Unsupported key.');
  if (params.action === 'scroll' && !['up', 'down'].includes(params.direction)) throw new Error('Direction must be up or down.');
  if (params.action === 'navigate') {
    if (typeof params.url !== 'string' || params.url.length > 2048) throw new Error('Invalid URL.');
    webOrigin(params.url);
  }
  return params;
}
