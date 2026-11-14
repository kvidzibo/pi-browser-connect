const $ = id => document.getElementById(id);
let current;
let tab;
$('setup').textContent = 'pi-browser-connect setup chromium ' + chrome.runtime.id;

async function render(state) {
  current = state;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const shared = Boolean(state.shared);
  document.body.classList.toggle('pending', Boolean(state.session) && !shared);
  $('badge').textContent = shared ? 'Tab shared' : state.session ? 'Awaiting your permission' : state.ready ? 'Bridge ready' : 'Not connected';
  $('badge').classList.toggle('active', shared);
  $('status').textContent = shared ? 'Session: ' + state.session.label + '. Disconnect at any time.' : state.session ? 'Verify the session below before sharing.' : state.ready ? 'Run /browser-connect connect in Pi, then refresh here.' : 'Start the bridge after completing setup below.';
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
    buttons.forEach(button => { button.disabled = false; });
    $('share').disabled = !tab?.url?.match(/^https?:\/\//) || tab.incognito;
  }
}
$('connect').onclick = () => send('connect');
$('share').onclick = () => send('share');
$('disconnect').onclick = () => send('disconnect');
$('refresh').onclick = () => send('status');
await send('status');
