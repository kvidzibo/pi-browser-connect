import { shareTarget } from './policy.js';

const $ = id => document.getElementById(id);
// Origin, or about:blank for blank, new-tab and internal pages; undefined when the tab cannot be shared.
const page = () => { try { return tab ? shareTarget(tab.url) : undefined; } catch { return undefined; } };
let current;
let tab;
let sending = false;

async function render(state) {
  current = state;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sharedHere = state.shared?.tabId === tab?.id;
  const sharedElsewhere = Boolean(state.shared) && !sharedHere;
  document.body.classList.toggle('pending', Boolean(state.session) && !state.shared);
  $('badge').textContent = sharedHere ? 'Tab shared' : sharedElsewhere ? 'Not this tab' : state.session ? 'Awaiting your permission' : state.ready ? 'Bridge ready' : 'Not connected';
  $('badge').classList.toggle('active', sharedHere);
  $('status').textContent = sharedHere ? 'Session: ' + state.session.label + '. Disconnect at any time.' : sharedElsewhere ? 'Another tab is shared. This tab is not. Disconnect to stop it.' : state.session ? 'Verify the session below before sharing.' : state.ready ? 'Run /browser-connect in Pi. This popup updates automatically.' : 'In Pi, run /browser-connect to set up the bridge, then reopen this popup.';
  $('pairing').hidden = !state.session || Boolean(state.shared);
  $('session').textContent = state.session?.label || '';
  $('code').textContent = state.session?.code || '';
  $('target').hidden = !state.session;
  $('title').textContent = sharedHere ? 'Currently shared tab' : tab?.title || (tab ? 'New or internal tab' : 'No tab selected');
  $('origin').textContent = page() !== 'about:blank' ? page() || '' : sharedHere ? '' : 'Sharing opens a blank page in this tab.';
  $('connect').hidden = Boolean(state.ready);
  $('share').hidden = !state.session || Boolean(state.shared);
  $('share').disabled = !page() || tab.incognito;
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
    const state = await chrome.runtime.sendMessage({ action, tabId: tab?.id, page: page(), sessionId: current?.session?.sessionId });
    await render(state);
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent = error.message;
  } finally {
    sending = false;
    buttons.forEach(button => { button.disabled = false; });
    $('share').disabled = !page() || tab.incognito;
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
