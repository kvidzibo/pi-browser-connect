import { snapshotPage, inspectPage, actOnPage } from './page.js';
import { validateParams, sharedPage, shareTarget, keys } from './policy.js';

let port;
let ready = false;
let session;
let grant;
let busy = false;
let connecting = false;
let lastError = '';
let detachBarrier = Promise.resolve();
let iconUpdates = Promise.resolve();

function post(message) {
  try { port?.postMessage(message); } catch { /* Disconnect handler revokes access. */ }
}
function iconFiles(shared) {
  return {
    16: `icons/icon-${shared ? 'connected-' : ''}16.png`,
    32: `icons/icon-${shared ? 'connected-' : ''}32.png`,
  };
}
function paintIndicator(tabId, shared) {
  const path = iconFiles(shared);
  const title = `Pi Browser Connect — ${shared ? 'Tab shared' : 'Not sharing'}`;
  // Serialize image loading so a late green update cannot overwrite revocation.
  iconUpdates = iconUpdates.then(async () => {
    await chrome.action.setIcon(tabId == null ? { path } : { tabId, path });
    await chrome.action.setTitle(tabId == null ? { title } : { tabId, title });
    if (tabId == null) await chrome.action.setBadgeText({ text: '' });
  }).catch(() => {});
}
function updateIcon(tabId = grant?.tabId) {
  // Global action state is shown in every window. Keep it not-sharing and
  // paint the green indicator only on the shared tab.
  paintIndicator(undefined, false);
  if (tabId != null) paintIndicator(tabId, Boolean(grant) && tabId === grant.tabId);
}
// Reset persisted action state whenever the worker starts without a grant.
updateIcon();
void (async () => {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) if (target.attached && target.tabId != null) updateIcon(target.tabId);
  } catch { /* No attached target to reset. */ }
})();
function revoke(reason, notify = true) {
  const old = grant;
  const owner = session;
  grant = undefined;
  session = undefined;
  lastError = reason;
  updateIcon(old?.tabId);
  if (notify && owner) post({ type: 'revoked', sessionId: owner.sessionId, reason });
  if (old) detachBarrier = detachBarrier.then(() => chrome.debugger.detach({ tabId: old.tabId })).catch(() => {});
  return detachBarrier;
}
function connect() {
  if (port) return;
  lastError = '';
  const connection = chrome.runtime.connectNative('com.kvidzibo.pi_browser_connect');
  port = connection;
  connection.onDisconnect.addListener(() => {
    if (port !== connection) return;
    const reason = chrome.runtime.lastError?.message || 'Browser bridge disconnected.';
    port = undefined;
    ready = false;
    void revoke(reason, false);
  });
  connection.onMessage.addListener(message => {
    if (port !== connection || !message || typeof message !== 'object') return;
    if (message.type === 'ready' && message.version === 1) ready = true;
    else if (message.type === 'session') {
      void revoke('', false);
      session = { sessionId: message.sessionId, label: String(message.label).slice(0, 120), code: String(message.code) };
      lastError = '';
    } else if (message.type === 'disconnect' && message.sessionId === session?.sessionId) {
      void revoke('Pi disconnected. Share again after reconnecting.', false);
    } else if (message.type === 'request') void respond(message);
  });
}

// The grant covers the tab, wherever it navigates. Tab URLs are read through CDP:
// activeTab stops exposing them once the tab leaves the origin it was shared on.
function assertGrant(expected) {
  if (!expected || grant !== expected || session?.sessionId !== expected.sessionId) throw new Error('No shared tab. Use the browser extension to share a tab.');
}
async function cdp(expected, method, params = {}) {
  assertGrant(expected);
  const result = await chrome.debugger.sendCommand({ tabId: expected.tabId }, method, params);
  if (grant !== expected) throw new Error('Access revoked while the action was running; it may already have run.');
  return result;
}
function supported(current) {
  if (current.unreachableUrl) throw new Error('The page failed to load. Navigate to another URL.');
  try { sharedPage(current.url); } catch { throw new Error('Only HTTP(S) and blank pages are supported.'); }
  return current;
}
async function frame(expected) {
  return supported((await cdp(expected, 'Page.getFrameTree')).frameTree.frame);
}
// Context IDs can repeat in another renderer process. Code refuses to run unless
// its world holds the token placed there while the document was verified.
const guard = current => `if (globalThis.__piBrowserConnectWorld !== ${JSON.stringify(current.token)}) throw new Error('Document changed. Take a fresh snapshot.');`;
async function evaluate(expected, fn, args, current) {
  const result = await cdp(expected, 'Runtime.evaluate', {
    expression: `(() => { ${guard(current)} return (${fn.toString()})(...${JSON.stringify(args)}); })()`, contextId: current.contextId,
    returnByValue: true, awaitPromise: false,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 500) || 'Page action failed. Take a fresh snapshot.');
  return result.result?.value;
}
async function world(expected, suffix = '') {
  const current = await frame(expected);
  const result = await cdp(expected, 'Page.createIsolatedWorld', { frameId: current.id, worldName: `pi-browser-connect-${expected.epoch}${suffix}` });
  // Snapshot and inspection share one world; keep its first token so references stay valid.
  const token = (await cdp(expected, 'Runtime.evaluate', { expression: `globalThis.__piBrowserConnectWorld ??= ${JSON.stringify(crypto.randomUUID())}`, contextId: result.executionContextId, returnByValue: true })).result?.value;
  // Frame IDs survive navigation: make sure the world and token belong to the checked document.
  if ((await frame(expected)).loaderId !== current.loaderId) throw new Error('Document changed. Take a fresh snapshot.');
  return { contextId: result.executionContextId, loaderId: current.loaderId, token };
}
async function execute(params, expected) {
  validateParams(params);
  if (params.action === 'tabs' && !expected) return { tabs: [], message: 'No tab shared. Click the browser extension and compare the pairing code.' };
  assertGrant(expected);
  if (params.action === 'tabs') {
    let current;
    try { current = await frame(expected); } catch {
      assertGrant(expected);
      // Still shared, so Pi can recover by navigating; expose nothing from the document.
      return { tabs: [{ url: 'Failed or unsupported page. Navigate to another URL.' }] };
    }
    const page = sharedPage(current.url);
    const { targetInfo } = await cdp(expected, 'Target.getTargetInfo');
    return { tabs: [{ title: targetInfo.title?.slice(0, 300), url: page === 'about:blank' ? page : page + new URL(current.url).pathname }] };
  }
  if (params.action === 'snapshot') {
    const current = await world(expected);
    const result = await evaluate(expected, snapshotPage, [expected.epoch, crypto.randomUUID()], current);
    if ((await frame(expected)).loaderId !== current.loaderId) throw new Error('Document changed during snapshot. Take another snapshot.');
    expected.world = current;
    return result;
  }
  if (params.action === 'inspect') {
    const current = await world(expected);
    const result = await evaluate(expected, inspectPage, [params.selector], current);
    if ((await frame(expected)).loaderId !== current.loaderId) throw new Error('Document changed during inspection; result discarded.');
    return result;
  }
  if (params.action === 'evaluate') {
    // Invalidate both the browser's reference store and Pi's refs before dispatch.
    expected.world = undefined;
    // Do not let scripts alter globals used by snapshot/action safety checks.
    const current = await world(expected, `-script-${crypto.randomUUID()}`);
    const result = await cdp(expected, 'Runtime.evaluate', {
      expression: `(() => {
        ${guard(current)}
        const value = (0, eval)(${JSON.stringify(params.expression)});
        if (value && typeof value.then === 'function') throw new Error('Return a synchronous value, not a Promise.');
        const serialized = JSON.stringify(value) ?? String(value);
        return { result: serialized.slice(0, 12000), truncated: serialized.length > 12000 };
      })()`,
      contextId: current.contextId, returnByValue: true, awaitPromise: false,
      timeout: 5000,
    });
    if ((await frame(expected)).loaderId !== current.loaderId) throw new Error('Document changed during script execution; result discarded. Side effects may already have occurred.');
    if (result.exceptionDetails) throw new Error('Browser script failed; side effects may already have occurred. Take a fresh snapshot.');
    return result.result?.value;
  }
  if (params.action === 'navigate') {
    expected.world = undefined;
    const result = await cdp(expected, 'Page.navigate', { url: params.url });
    if (result.errorText) throw new Error(`Navigation failed: ${String(result.errorText).slice(0, 200)}`);
    return { message: 'Navigation dispatched. Wait for the page to load, then take a snapshot.' };
  }
  if (params.action === 'screenshot') {
    const before = await frame(expected);
    const result = await cdp(expected, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false });
    if ((await frame(expected)).loaderId !== before.loaderId) throw new Error('Document changed during capture; screenshot discarded.');
    if (typeof result.data !== 'string' || result.data.length > 6 * 1024 * 1024) throw new Error('Screenshot too large. Reduce the browser window size.');
    return { image: result.data, mimeType: 'image/jpeg' };
  }
  const current = expected.world;
  if (!current || (await frame(expected)).loaderId !== current.loaderId) throw new Error('Take a fresh snapshot before interacting.');
  // Consume references before dispatch, even when a later step fails.
  expected.world = undefined;
  const result = await evaluate(expected, actOnPage, [expected.epoch, params], current);
  if (params.action === 'press') {
    if ((await frame(expected)).loaderId !== current.loaderId) throw new Error('Document changed; keypress cancelled.');
    const key = keys[params.key];
    await cdp(expected, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    if ((await frame(expected)).loaderId !== current.loaderId) throw new Error('Document changed after keyDown; action may already have run.');
    const { text: _text, ...release } = key;
    await cdp(expected, 'Input.dispatchKeyEvent', { type: 'keyUp', ...release });
  }
  return result;
}
async function respond(message) {
  const owner = session;
  if (!owner || owner.sessionId !== message.sessionId) return;
  const reply = { type: 'response', sessionId: owner.sessionId, id: message.id };
  if (busy) { post({ ...reply, error: 'Another browser action is running.' }); return; }
  busy = true;
  try {
    const result = await execute(message.params, grant);
    if (session === owner) post({ ...reply, result });
  } catch (error) {
    if (session === owner) post({ ...reply, error: String(error.message || error).slice(0, 700) });
  } finally { busy = false; }
}
async function share(tabId, sessionId, expectedPage) {
  if (connecting) throw new Error('Sharing is already in progress.');
  if (!session || session.sessionId !== sessionId) throw new Error('Pi session changed. Refresh and compare the code again.');
  if (grant) throw new Error('A tab is already shared. Disconnect first.');
  connecting = true;
  const owner = session;
  let attached = false;
  try {
    await detachBarrier;
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito || tab.pendingUrl) throw new Error('Incognito or loading tabs cannot be shared.');
    if (shareTarget(tab.url) !== expectedPage) throw new Error('Tab changed. Refresh and verify the tab before sharing.');
    if (owner !== session) throw new Error('Pi disconnected.');
    const blank = tab.url === undefined;
    if (blank) await chrome.tabs.update(tabId, { url: 'about:blank' });
    for (let tries = 0; ; tries++) {
      try { await chrome.debugger.attach({ tabId }, '1.3'); break; }
      catch (error) {
        // New-tab and internal pages stay undebuggable until about:blank commits.
        if (!blank || tries >= 30) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
        if (owner !== session) throw new Error('Pi disconnected while sharing.');
      }
    }
    attached = true;
    if (owner !== session) throw new Error('Pi disconnected while sharing.');
    // Finish setup before publishing the grant, so no request can act earlier.
    const send = (method, params) => {
      if (owner !== session) throw new Error('Pi disconnected while sharing.');
      return chrome.debugger.sendCommand({ tabId }, method, params);
    };
    await send('Page.enable');
    for (let tries = 0; blank; tries++) {
      if ((await send('Page.getFrameTree')).frameTree.frame.url === 'about:blank') break;
      if (tries >= 30) throw new Error('Unable to open a blank page in this tab.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Keep the page focused and visible to itself, so timers, focus and key events
    // work while the user is in another tab, window or workspace.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    supported((await send('Page.getFrameTree')).frameTree.frame);
    if (owner !== session) throw new Error('Pi disconnected while sharing.');
    grant = { tabId, sessionId: owner.sessionId, epoch: crypto.randomUUID() };
    lastError = '';
    updateIcon();
  } catch (error) {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    throw error;
  } finally { connecting = false; }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const current = grant;
  if (!current || source.tabId !== current.tabId) return;
  // Chromium resets tab-specific toolbar state on navigation; repaint the shared indicator.
  if (method === 'Page.loadEventFired') updateIcon();
  if (method !== 'Page.frameNavigated' || params.frame.parentId) return;
  current.world = undefined;
  updateIcon();
  if (params.frame.unreachableUrl) return;
  try { sharedPage(params.frame.url); } catch { void revoke('Tab opened an unsupported page. Share a tab again.'); }
});
chrome.debugger.onDetach.addListener(source => {
  if (grant?.tabId === source.tabId) void revoke('Browser debugging detached. Share the tab again.');
});
chrome.tabs.onRemoved.addListener(tabId => { if (grant?.tabId === tabId) void revoke('Shared tab closed.'); });

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  void (async () => {
    if (message.action === 'connect') connect();
    else if (message.action === 'share') await share(message.tabId, message.sessionId, message.page);
    else if (message.action === 'disconnect') await revoke('Disconnected by you.');
    else if (message.action !== 'status') throw new Error('Unknown UI action.');
    return { ready, session, shared: grant ? { tabId: grant.tabId } : null, error: lastError };
  })().then(reply, error => reply({ error: String(error.message || error) }));
  return true;
});
