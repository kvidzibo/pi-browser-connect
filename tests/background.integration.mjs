// Background work in a real browser: Playwright would enable focus emulation itself,
// so this test drives Chromium through a plain DevTools socket, on its own Xvfb
// display with a private i3. It never uses an inherited display or window manager.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { bundledExtensionId } from '../native-host/install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const extensionPath = join(root, 'browser-extension');
const hostManifest = 'NativeMessagingHosts/com.kvidzibo.pi_browser_connect.json';

async function eventually(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await fn()) return; } catch { /* Retry until the deadline. */ } await delay(100); }
  throw new Error('Timed out waiting for browser state');
}

test('shared new tab works unfocused, on another workspace, and as a background tab without taking focus', { timeout: 90000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-browser-connect-bg-'));
  const previous = { HOME: process.env.HOME, PI_BROWSER_CONNECT_DIR: process.env.PI_BROWSER_CONNECT_DIR };
  process.env.HOME = home;
  process.env.PI_BROWSER_CONNECT_DIR = join(home, 'runtime');
  const children = [];
  let server;
  let disconnect = async () => {};
  t.after(async () => {
    await disconnect();
    for (const child of children) child.kill();
    server?.closeAllConnections();
    await new Promise(resolveClose => server ? server.close(resolveClose) : resolveClose());
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });

  // A private display and window manager; the i3 socket lives in the temporary home.
  const display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1600x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  children.push(display);
  const number = await new Promise((resolveDisplay, reject) => { display.stdio[3].once('data', data => resolveDisplay(String(data).trim())); display.once('exit', () => reject(new Error('Xvfb did not start'))); });
  const { I3SOCK: _live, SWAYSOCK: _sway, XAUTHORITY: _authority, WAYLAND_DISPLAY: _wayland, ...clean } = process.env;
  const wmEnv = { ...clean, DISPLAY: `:${number}`, XDG_RUNTIME_DIR: join(home, 'wm') };
  await mkdir(wmEnv.XDG_RUNTIME_DIR, { mode: 0o700 });
  await writeFile(join(home, 'i3.conf'), '# i3 config file (v4)\nfont pango:monospace 8\n');
  children.push(spawn('i3', ['-c', join(home, 'i3.conf')], { env: wmEnv, stdio: 'ignore' }));
  let socket;
  await eventually(() => { socket = execFileSync('i3', ['--get-socketpath'], { env: wmEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); return socket.startsWith(home); });
  const i3 = command => execFileSync('i3-msg', ['-s', socket, command], { env: wmEnv, stdio: 'ignore' });
  const focused = () => execFileSync('xdotool', ['getwindowfocus', 'getwindowname'], { env: wmEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url !== '/agent' ? `<title>${req.url === '/user' ? 'USERPAGE' : 'COVERPAGE'}</title><h1>Your page</h1>` : `<title>AGENTPAGE</title><label>Query <input id="q"></label><button onclick="report()">Go</button><p id="r"></p><p id="k"></p><script>q.addEventListener('keydown',e=>{k.textContent='key '+e.key+' trusted='+e.isTrusted});let last=performance.now(),slow=0;setInterval(()=>{const now=performance.now();if(now-last>500)slow++;last=now},50);function report(){r.textContent='clicked: '+q.value+' slow-timers='+slow+' vis='+document.visibilityState+' focus='+document.hasFocus()}</script>`);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;

  const loader = new DefaultResourceLoader({ cwd: home, agentDir: join(home, 'agent'), settingsManager: SettingsManager.inMemory({ packages: [] }), noExtensions: true, additionalExtensionPaths: [join(root, 'index.ts')], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extension = loader.getExtensions().extensions[0];
  const command = extension.commands.get('browser-connect').handler;
  const tool = extension.tools.get('browser_connect').definition;
  const ctx = { hasUI: true, cwd: home, sessionManager: { getSessionId: () => 'background-session' }, ui: { notify: () => {}, select: async (_title, options) => options.includes('Chromium') ? 'Chromium' : 'Approve all for this session' } };
  const call = async params => JSON.parse((await tool.execute('background', params, new AbortController().signal, undefined, ctx)).content[0].text.replace(/^UNTRUSTED BROWSER DATA\n/, ''));
  const connecting = command('', ctx);
  disconnect = async () => { await command('disconnect', ctx); await connecting; };
  const profile = join(home, '.config/chromium');
  await eventually(async () => Boolean(await readFile(join(profile, hostManifest))));
  for (const name of ['google-chrome', 'google-chrome-for-testing']) {
    await mkdir(join(home, '.config', name, 'NativeMessagingHosts'), { recursive: true });
    await copyFile(join(profile, hostManifest), join(home, '.config', name, hostManifest));
  }

  children.push(spawn(process.env.BROWSER_CONNECT_CHROMIUM || chromium.executablePath(), [`--user-data-dir=${profile}`, '--remote-debugging-port=0', `--load-extension=${extensionPath}`, `--disable-extensions-except=${extensionPath}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run', '--no-default-browser-check', '--password-store=basic', `http://127.0.0.1:${port}/user`], { stdio: 'ignore', env: { ...wmEnv, HOME: home, XDG_CONFIG_HOME: join(home, '.config') } }));
  let devtools;
  await eventually(async () => { devtools = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return Boolean(devtools); });
  await eventually(() => focused().startsWith('USERPAGE'));
  // Attach only to the popup document, never to the shared tab.
  const popupUrl = `chrome-extension://${await bundledExtensionId()}/popup.html`;
  const target = await (await fetch(`http://127.0.0.1:${devtools}/json/new?${popupUrl}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  t.after(() => ws.close());
  await new Promise((resolveOpen, reject) => { ws.onopen = resolveOpen; ws.onerror = reject; });
  let id = 0;
  const waits = new Map();
  ws.onmessage = event => { const message = JSON.parse(event.data); waits.get(message.id)?.(message); waits.delete(message.id); };
  const popup = async expression => {
    const message = await new Promise((resolveReply, reject) => {
      waits.set(++id, resolveReply);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      setTimeout(() => reject(new Error(`No reply from the popup: ${expression.slice(0, 80)}`)), 10000);
    });
    if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description || 'Evaluation failed');
    return message.result?.result?.value;
  };
  // You open a new window; the popup document rides along as its background tab.
  await eventually(() => popup(`Boolean(chrome.tabs)`));
  const windowId = await popup(`(async () => { const win = await chrome.windows.create({ focused: true }); await chrome.tabs.move((await chrome.tabs.getCurrent()).id, { windowId: win.id, index: -1 }); return win.id; })()`);
  await connecting;
  await eventually(async () => await popup(`document.querySelector('#badge').textContent`) === 'Awaiting your permission');
  assert.equal(await popup(`document.querySelector('#origin').textContent`), 'Sharing opens a blank page in this tab.');
  await popup(`document.querySelector('#share').click()`);
  await eventually(async () => await popup(`document.querySelector('#badge').textContent`) === 'Tab shared');
  assert.deepEqual((await call({ action: 'tabs' })).tabs.map(tab => tab.url), ['about:blank']);

  const work = async (label, origin) => {
    i3('[title="USERPAGE"] focus');
    await eventually(() => focused().startsWith('USERPAGE'));
    await call({ action: 'navigate', url: `${origin}/agent` });
    let snapshot;
    await eventually(async () => { snapshot = await call({ action: 'snapshot' }); return snapshot.title === 'AGENTPAGE'; });
    const ref = () => snapshot.elements.find(element => element.label === 'Query').ref;
    await call({ action: 'type', ref: ref(), text: label });
    snapshot = await call({ action: 'snapshot' });
    await call({ action: 'press', ref: ref(), key: 'ArrowLeft' });
    // Give throttled timers time to show before the page reports on the click.
    await delay(700);
    snapshot = await call({ action: 'snapshot' });
    await call({ action: 'click', ref: snapshot.elements.find(element => element.label === 'Go').ref });
    assert.ok((await tool.execute('background', { action: 'screenshot' }, new AbortController().signal, undefined, ctx)).content[1].data.length > 1000, label);
    const { text, url } = await call({ action: 'snapshot' });
    assert.equal(url, `${origin}/agent`, label);
    // The page writes to the DOM only in response to Pi's own actions, so references stay valid.
    assert.match(text, new RegExp(`clicked: ${label} slow-timers=0 vis=visible focus=true`), label);
    assert.match(text, /key ArrowLeft trusted=true/, label);
    assert.match(focused(), /^USERPAGE/, `${label}: actions must not take window focus`);
  };
  await work('unfocused window', `http://127.0.0.1:${port}`);
  i3('[title="AGENTPAGE"] move container to workspace 2');
  await delay(500);
  await work('another workspace', `http://localhost:${port}`);
  await popup(`chrome.tabs.create({ windowId: ${windowId}, url: 'http://127.0.0.1:${port}/cover', active: true }).then(() => 0)`);
  await delay(500);
  await work('background tab', `http://127.0.0.1:${port}`);
});
