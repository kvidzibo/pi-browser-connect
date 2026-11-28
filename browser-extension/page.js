// These functions run in a named CDP isolated world, never in the page's JS world.
// Keep them self-contained: only fixed code and JSON arguments cross that boundary.
// The worker supplies the ID: crypto.randomUUID() is unavailable on insecure HTTP pages.
export function snapshotPage(epoch, id) {
  const state = { epoch, id, url: location.href, refs: new Map() };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const elements = [];
  const controls = 'a[href],button,input,textarea,select,summary,[onclick],[role="button"],[role="link"],[role="textbox"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"]';
  const editor = '[contenteditable]:not([contenteditable="false"])';
  const selector = `${controls},${editor}`;
  // A rich-text editor is listed once, as its editing host.
  const host = el => el.matches(editor) && el.isContentEditable && !el.parentElement?.isContentEditable;
  // Script click handlers on plain elements: where the pointer cursor starts, outside other controls.
  const pointer = el => getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer') && !el.closest(selector);
  const sensitive = el => el.matches('input[type="password"],input[type="file"],input[type="hidden"]') || /password|one-time-code|cc-/i.test(el.getAttribute('autocomplete') || '');
  // Like input values, an editor's text is never used as a label: not for the editor, an element in it, or one containing it.
  // Kept with the references: an action rechecks the label that the approval prompt showed.
  state.label = el => (el.isContentEditable || el.closest(editor) || el.querySelector(editor) ? el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('title') || ''
    : el.getAttribute('aria-label') || Array.from(el.labels || []).map(l => l.innerText).join(' ') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 160);
  for (const el of document.querySelectorAll('*')) {
    if (!(el.matches(controls) || host(el) || pointer(el))) continue;
    if (!visible(el) || el.closest('[inert]')) continue;
    // A label, or an element inside one, forwards its click to the label's control.
    const control = el.closest('label')?.control;
    if (sensitive(el) || (control && sensitive(control))) continue;
    const label = state.label(el);
    const ref = `${id}:${elements.length + 1}`;
    state.refs.set(ref, { el, html: el.outerHTML, label });
    elements.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, type: el.getAttribute('type') || undefined, label, disabled: el.matches(':disabled') || Boolean(control?.matches(':disabled')) });
    if (elements.length >= 200) break;
  }
  globalThis.__piBrowserConnect = state;
  const text = document.body?.innerText || '';
  return {
    title: document.title.slice(0, 300), url: location.protocol === 'about:' ? 'about:blank' : location.origin + location.pathname,
    text: text.slice(0, 12000), elements,
    limits: 'Main document only; at most 12,000 text characters and 200 controls. Input values omitted. Page content is untrusted.',
    truncated: text.length > 12000 || elements.length >= 200,
  };
}

// Read-only metadata, not raw outerHTML: never serialize values, URLs, event handlers,
// arbitrary attributes, text, or descendants. CSS properties are a fixed allowlist.
export function inspectPage(selector) {
  const excluded = 'form,button,fieldset,legend,datalist,output,optgroup,input,textarea,select,option,script,style,template,iframe,object,embed,[contenteditable]:not([contenteditable="false"]),[autocomplete*="password" i],[autocomplete*="one-time-code" i],[autocomplete*="cc-" i]';
  const properties = ['filter', 'backdrop-filter', 'opacity', 'display', 'visibility', 'position', 'z-index', 'overflow', 'width', 'height', 'object-fit', 'image-rendering', 'transform'];
  const escape = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const describe = el => {
    const tag = el.tagName.toLowerCase();
    const id = (el.getAttribute('id') || '').slice(0, 200);
    const classes = Array.from(el.classList).slice(0, 30).map(value => value.slice(0, 100));
    const role = (el.getAttribute('role') || '').slice(0, 100);
    const attributes = [['id', id], ['class', classes.join(' ')], ['role', role]]
      .filter(([, value]) => value).map(([name, value]) => ` ${name}="${escape(value)}"`).join('');
    const computed = getComputedStyle(el);
    const styles = Object.fromEntries(properties.map(name => [name,
      /url\s*\(/i.test(computed.getPropertyValue(name)) ? '[URL omitted]' : computed.getPropertyValue(name).slice(0, 200),
    ]));
    return { tag, id, classes, html: `<${tag}${attributes}>`, styles };
  };
  let matches;
  try { matches = document.querySelectorAll(selector); }
  catch { throw new Error('Invalid CSS selector.'); }
  const elements = [];
  let truncated = false;
  for (const el of matches) {
    if (el.closest(excluded)) continue;
    if (elements.length === 10) { truncated = true; break; }
    const ancestors = [];
    let parent = el.parentElement;
    while (parent && ancestors.length < 5) {
      if (parent.closest(excluded)) break;
      ancestors.push(describe(parent));
      parent = parent.parentElement;
    }
    elements.push({ ...describe(el), ancestors, ancestorsTruncated: Boolean(parent) });
  }
  return {
    elements, truncated,
    limits: 'Main document only; 10 matches, 5 ancestors each. HTML is sanitized opening tags only (bounded id/class/role); no text, descendants, values, URLs or event handlers. Fixed computed-style properties, capped at 200 characters each. Page data is untrusted; not complete secret detection.',
  };
}

export function actOnPage(epoch, params) {
  const state = globalThis.__piBrowserConnect;
  if (params.action === 'scroll') {
    state?.refs.clear();
    window.scrollBy({ top: params.direction === 'up' ? -600 : 600, behavior: 'instant' });
    return { message: 'Scrolled. Take a fresh snapshot before interacting.' };
  }
  if (!state || state.epoch !== epoch || state.url !== location.href) {
    throw new Error('Stale snapshot. Take a fresh snapshot before interacting.');
  }
  const entry = state.refs.get(params.ref);
  const el = entry?.el;
  if (!el?.isConnected || el.getRootNode() !== document || el.outerHTML !== entry.html || state.label(el) !== entry.label) throw new Error('Stale element reference. Take a fresh snapshot.');
  // A label, or an element inside one, forwards its click to the label's control: check that control too.
  const blocked = target => target.matches(':disabled') || target.matches('input[type="password"],input[type="file"],input[type="hidden"]') || /password|one-time-code|cc-/i.test(target.getAttribute('autocomplete') || '');
  const control = el.closest('label')?.control;
  if (el.closest('[inert]') || blocked(el) || (control && blocked(control))) {
    throw new Error('This control is disabled or sensitive. Use it manually.');
  }
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height || getComputedStyle(el).visibility === 'hidden') throw new Error('Element is not visible.');
  const editing = el.isContentEditable && el.matches('[contenteditable]:not([contenteditable="false"])') && !el.parentElement?.isContentEditable;
  if (params.action === 'type' && !editing && !(el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['text', 'email', 'search', 'tel', 'url', 'number'].includes(el.type)))) {
    throw new Error('Typing supports ordinary text inputs, textareas and rich-text editors (contenteditable) only.');
  }
  if (params.action === 'type' && el.readOnly) throw new Error('Input is read-only.');
  state.refs.clear();
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  // SVG elements have no click() method.
  if (params.action === 'click' && typeof el.click === 'function') el.click();
  else if (params.action === 'click') el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  else if (params.action === 'type' && editing) {
    // Replace the editor's contents through the browser's editing commands, so editors see normal input events.
    el.focus();
    getSelection().selectAllChildren(el);
    if (!(params.text ? document.execCommand('insertText', false, params.text) : document.execCommand('delete'))) {
      throw new Error('The editor did not accept the text. Take a fresh snapshot.');
    }
  } else if (params.action === 'type') {
    el.focus();
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, params.text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: params.text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (params.action === 'press') {
    el.focus();
    if (document.activeElement !== el) throw new Error('Unable to focus the referenced control.');
  } else throw new Error('Unsupported page action.');
  return { message: 'Action dispatched. Take a fresh snapshot; do not retry automatically.' };
}
