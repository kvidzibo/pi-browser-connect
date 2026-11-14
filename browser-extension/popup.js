const $ = id => document.getElementById(id);
let current;
let tab;
let sending = false;

async function render(state) {
  current = state;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const shared = Boolean(state.shared);
  document.body.classList.toggle('pending', Boolean(state.session) && !shared);
  $('badge').textContent = shared ? 'Tab shared' : state.session ? 'Awaiting your permission' : state.ready ? 'Bridge ready' : 'Not connected';
  $('badge').classList.toggle('active', shared);
  $('status').textContent = shared ? 'Session: ' + state.session.label + '. Disconnect at any time.' : state.session ? 'Verify the session below before sharing.' : state.ready ? 'Run /browser-connect in Pi. This popup updates automatically.' : 'In Pi, run /browser-connect to set up the bridge, then reopen this popup.';
  $('pairing').hidden = !state.session || shared;
  $('session').textContent = state.session?.label || '';
  $('code').textContent = state.session?.code || '';
  $('target').hidden = !state.session;
  $('title').textContent = shared ? 'Currently shared tab' : tab?.title || 'No tab selected';
  let origin = '';
  try { origin = new URL(tab.url).origin; } catch {}
  $('origin').textContent = state.shared?.origin || origin;
  $('connect').hidden = Boolean(state.ready);
  $('share').hidden = !state.session || shared;
  $('share').disabled = !tab?.url?.match(/^https?:\/\//) || tab.incognito;
  $('disconnect').hidden = !state.session;
  $('error').hidden = !state.error;
  $('error').textContent = state.error || '';
}

async function send(action) {
  if (sending) return;
  sending = true;
  const buttons = Array.from(document.querySelectorAll('button'));
  buttons.forEach(button => { button.disabled = true; });
  try {
    const origin = tab?.url?.match(/^https?:\/\//) ? new URL(tab.url).origin : undefined;
    const state = await chrome.runtime.sendMessage({ action, tabId: tab?.id, origin, sessionId: current?.session?.sessionId });
    await render(state);
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent = error.message;
  } finally {
    sending = false;
    buttons.forEach(button => { button.disabled = false; });
    $('share').disabled = !tab?.url?.match(/^https?:\/\//) || tab.incognito;
  }
}
$('connect').onclick = () => send('connect');
$('share').onclick = () => send('share');
$('disconnect').onclick = () => send('disconnect');
// Opening the popup starts only the transport, never tab sharing.
await send('connect');
async function refresh() {
  await send('status');
  setTimeout(refresh, 500);
}
setTimeout(refresh, 500);
