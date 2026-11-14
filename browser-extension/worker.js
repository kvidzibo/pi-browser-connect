import { snapshotPage, actOnPage } from './page.js';
import { validateParams, webOrigin, keys } from './policy.js';

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
function updateIcon() {
  const shared = Boolean(grant);
  // Serialize image loading so a late green update cannot overwrite revocation.
  iconUpdates = iconUpdates.then(async () => {
    await chrome.action.setIcon({ path: {
      16: `icons/icon-${shared ? 'connected-' : ''}16.png`,
      32: `icons/icon-${shared ? 'connected-' : ''}32.png`,
    } });
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: `Pi Browser Connect — ${shared ? 'Tab shared' : 'Not sharing'}` });
  }).catch(() => {});
}
// Reset persisted action state whenever the worker starts without a grant.
updateIcon();
function revoke(reason, notify = true) {
  const old = grant;
  const owner = session;
  grant = undefined;
  session = undefined;
  lastError = reason;
  updateIcon();
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

async function assertGrant(expected) {
  if (!expected || grant !== expected || session?.sessionId !== expected.sessionId) throw new Error('No shared tab. Use the browser extension to share a tab.');
  const tab = await chrome.tabs.get(expected.tabId);
  if (grant !== expected || tab.pendingUrl || webOrigin(tab.url) !== expected.origin) {
    if (grant === expected) void revoke('The tab navigated. Share it again.');
    throw new Error('Tab changed or access was revoked.');
  }
  return tab;
}
async function cdp(expected, method, params = {}) {
  await assertGrant(expected);
  const result = await chrome.debugger.sendCommand({ tabId: expected.tabId }, method, params);
  if (grant !== expected) throw new Error('Access revoked while the action was running; it may already have run.');
  return result;
}
async function frame(expected) {
  const result = await cdp(expected, 'Page.getFrameTree');
  if (webOrigin(result.frameTree.frame.url) !== expected.origin) throw new Error('Document origin changed.');
  return result.frameTree.frame;
}
async function evaluate(expected, fn, args, contextId) {
  const result = await cdp(expected, 'Runtime.evaluate', {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`, contextId,
    returnByValue: true, awaitPromise: false,
  });
  await assertGrant(expected);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 500) || 'Page action failed. Take a fresh snapshot.');
  return result.result?.value;
}
async function world(expected) {
  const current = await frame(expected);
  const result = await cdp(expected, 'Page.createIsolatedWorld', { frameId: current.id, worldName: `pi-browser-connect-${expected.epoch}` });
  return { contextId: result.executionContextId, loaderId: current.loaderId };
}
async function execute(params, expected) {
  validateParams(params);
  if (params.action === 'tabs' && !expected) return { tabs: [], message: 'No tab shared. Click the browser extension and compare the pairing code.' };
  const tab = await assertGrant(expected);
  if (params.action === 'tabs') return { tabs: [{ title: tab.title?.slice(0, 300), url: expected.origin + new URL(tab.url).pathname }] };
  if (params.action === 'snapshot') {
    const current = await world(expected);
    const result = await evaluate(expected, snapshotPage, [expected.origin, expected.epoch], current.contextId);
    if ((await frame(expected)).loaderId !== current.loaderId) throw new Error('Document changed during snapshot. Take another snapshot.');
    expected.world = current;
    return result;
  }
  if (params.action === 'navigate') {
    if (webOrigin(params.url) !== expected.origin) throw new Error('Cross-origin navigation is not allowed. Navigate manually and share the destination again.');
    expected.world = undefined;
    await cdp(expected, 'Page.navigate', { url: params.url });
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
  const result = await evaluate(expected, actOnPage, [expected.origin, expected.epoch, params], current.contextId);
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
async function share(tabId, sessionId, expectedOrigin) {
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
    const origin = webOrigin(tab.url);
    if (origin !== expectedOrigin) throw new Error('Tab origin changed. Refresh and verify the tab before sharing.');
    if (owner !== session) throw new Error('Pi disconnected.');
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    if (owner !== session) throw new Error('Pi disconnected while sharing.');
    grant = { tabId, origin, sessionId: owner.sessionId, epoch: crypto.randomUUID() };
    await cdp(grant, 'Page.enable');
    lastError = '';
    updateIcon();
  } catch (error) {
    if (grant?.sessionId === owner.sessionId) await revoke('Unable to share tab.');
    else if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    throw error;
  } finally { connecting = false; }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const current = grant;
  if (!current || source.tabId !== current.tabId || method !== 'Page.frameNavigated' || params.frame.parentId) return;
  current.world = undefined;
  try {
    if (webOrigin(params.frame.url) !== current.origin) void revoke('Tab left the shared origin. Share the destination again.');
  } catch { void revoke('Tab left the shared origin.'); }
});
chrome.debugger.onDetach.addListener(source => {
  if (grant?.tabId === source.tabId) void revoke('Browser debugging detached. Share the tab again.');
});
chrome.tabs.onRemoved.addListener(tabId => { if (grant?.tabId === tabId) void revoke('Shared tab closed.'); });

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  void (async () => {
    if (message.action === 'connect') connect();
    else if (message.action === 'share') await share(message.tabId, message.sessionId, message.origin);
    else if (message.action === 'disconnect') await revoke('Disconnected by you.');
    else if (message.action !== 'status') throw new Error('Unknown UI action.');
    return { ready, session, shared: grant ? { tabId: grant.tabId, origin: grant.origin } : null, error: lastError };
  })().then(reply, error => reply({ error: String(error.message || error) }));
  return true;
});
