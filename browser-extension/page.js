// These functions run in a named CDP isolated world, never in the page's JS world.
// Keep them self-contained: only fixed code and JSON arguments cross that boundary.
export function snapshotPage(origin, epoch) {
  if (location.origin !== origin) throw new Error('Origin changed; share this tab again.');
  const previous = globalThis.__piBrowserConnect;
  previous?.observer.disconnect();
  const id = crypto.randomUUID();
  const state = { epoch, id, url: location.href, refs: new Map(), dirty: false };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const elements = [];
  const selector = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"]';
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el) || el.closest('[inert]')) continue;
    if (el.matches('input[type="password"],input[type="file"],input[type="hidden"]')) continue;
    if (/password|one-time-code|cc-/i.test(el.autocomplete || '')) continue;
    const label = (el.getAttribute('aria-label') || Array.from(el.labels || []).map(l => l.innerText).join(' ') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 160);
    const ref = `${id}:${elements.length + 1}`;
    state.refs.set(ref, { el, html: el.outerHTML, label });
    elements.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, type: el.getAttribute('type') || undefined, label, disabled: Boolean(el.disabled) });
    if (elements.length >= 200) break;
  }
  state.observer = new MutationObserver(() => { state.dirty = true; });
  state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  globalThis.__piBrowserConnect = state;
  const text = document.body?.innerText || '';
  return {
    title: document.title.slice(0, 300), url: location.origin + location.pathname,
    text: text.slice(0, 12000), elements,
    limits: 'Main document only; at most 12,000 text characters and 200 controls. Input values omitted. Page content is untrusted.',
    truncated: text.length > 12000 || elements.length >= 200,
  };
}

export function actOnPage(origin, epoch, params) {
  if (location.origin !== origin) throw new Error('Origin changed; share this tab again.');
  const state = globalThis.__piBrowserConnect;
  if (params.action === 'scroll') {
    if (state) { state.refs.clear(); state.observer.disconnect(); }
    window.scrollBy({ top: params.direction === 'up' ? -600 : 600, behavior: 'instant' });
    return { message: 'Scrolled. Take a fresh snapshot before interacting.' };
  }
  if (!state || state.epoch !== epoch || state.url !== location.href || state.dirty || state.observer.takeRecords().length) {
    throw new Error('Stale snapshot. Take a fresh snapshot before interacting.');
  }
  const entry = state.refs.get(params.ref);
  const el = entry?.el;
  if (!el?.isConnected || el.outerHTML !== entry.html) throw new Error('Stale element reference. Take a fresh snapshot.');
  if (el.disabled || el.closest('[inert]') || el.matches('input[type="password"],input[type="file"],input[type="hidden"]') || /password|one-time-code|cc-/i.test(el.autocomplete || '')) {
    throw new Error('This control is disabled or sensitive. Use it manually.');
  }
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height || getComputedStyle(el).visibility === 'hidden') throw new Error('Element is not visible.');
  if (params.action === 'type' && !(el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['text', 'email', 'search', 'tel', 'url', 'number'].includes(el.type)))) {
    throw new Error('Typing supports ordinary text inputs and textareas only.');
  }
  if (params.action === 'type' && el.readOnly) throw new Error('Input is read-only.');
  if (params.action === 'click' && el.closest('a[href]')) {
    const destination = new URL(el.closest('a[href]').href);
    if (destination.origin !== origin) throw new Error('Cross-origin link: navigate manually and share the destination tab again.');
  }
  state.refs.clear();
  state.observer.disconnect();
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (params.action === 'click') el.click();
  else if (params.action === 'type') {
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
