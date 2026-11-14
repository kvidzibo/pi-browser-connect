import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { bundledExtensionId } from '../native-host/install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const extensionPath = join(root, 'browser-extension');
const extensionId = await bundledExtensionId();

async function eventually(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error('Timed out waiting for browser state');
}

test('isolated Chromium → native host → loaded Pi tool: sharing, actions, revocation, reload', { timeout: 90000 }, async t => {
  assert.ok(process.env.DISPLAY, 'Run with xvfb-run and a private D-Bus session');
  const home = await mkdtemp(join(tmpdir(), 'pi-browser-connect-e2e-'));
  const runtime = join(home, 'runtime');
  let server;
  let context;
  const previousDirectory = process.env.PI_BROWSER_CONNECT_DIR;
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  process.env.PI_BROWSER_CONNECT_DIR = runtime;
  t.after(async () => {
    await context?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDirectory === undefined) delete process.env.PI_BROWSER_CONNECT_DIR;
    else process.env.PI_BROWSER_CONNECT_DIR = previousDirectory;
    await rm(home, { recursive: true, force: true });
  });
  const loader = new DefaultResourceLoader({ cwd: home, agentDir: join(home, 'agent'), settingsManager: SettingsManager.inMemory({ packages: [] }), noExtensions: true, additionalExtensionPaths: [join(root, 'index.ts')], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extension = loader.getExtensions().extensions[0];
  const command = extension.commands.get('browser-connect').handler;
  const tool = extension.tools.get('browser_connect').definition;
  const notices = [];
  const confirmations = [];
  let approve = false;
  const ctx = { hasUI: true, cwd: home, sessionManager: { getSessionId: () => 'integration-session' }, ui: {
    notify: message => notices.push(message),
    select: async (_title, options) => { assert.ok(options.includes('Chromium')); return 'Chromium'; },
    confirm: async (title, body) => { confirmations.push({ title, body }); return approve; },
  } };
  const call = async params => tool.execute('integration', params, new AbortController().signal, undefined, ctx);
  const data = result => JSON.parse(result.content[0].text.replace(/^UNTRUSTED BROWSER DATA\n/, ''));
  await assert.rejects(call({ action: 'snapshot' }), /Not connected/);
  const connecting = command('', ctx);
  t.after(async () => { await command('disconnect', ctx); await connecting; });
  // Pi replaces consecutive info notices; setup instructions and waiting status must stay together.
  await eventually(async () => notices.some(message => message.includes(extensionPath) && message.includes('Waiting up to')));
  const registration = JSON.parse(await readFile(join(home, '.config/chromium/NativeMessagingHosts/com.kvidzibo.pi_browser_connect.json'), 'utf8'));
  assert.deepEqual(registration.allowed_origins, [`chrome-extension://${extensionId}/`]);
  // Chromium-for-Testing uses its own config root; keep both registrations in the temporary HOME.
  const installed = await readFile(join(home, '.config/chromium/NativeMessagingHosts/com.kvidzibo.pi_browser_connect.json'));
  for (const name of ['google-chrome', 'google-chrome-for-testing']) {
    await mkdir(join(home, '.config', name, 'NativeMessagingHosts'), { recursive: true });
    await writeFile(join(home, '.config', name, 'NativeMessagingHosts/com.kvidzibo.pi_browser_connect.json'), installed);
  }
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>Shared tab fixture</title></head><body style="font:20px system-ui;padding:48px"><h1>Browser Connect fixture</h1><label>Message <input id="message"></label><button id="save" onclick="document.querySelector('#result').textContent='Saved: '+document.querySelector('#message').value">Save draft</button><p id="result">Not saved</p><input type="password" value="fixture-secret"><a href="http://localhost:${server.address().port}/other">Other origin</a><div style="height:1200px"></div><p>Bottom</p></body></html>`);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = join(home, '.config/chromium');
  await mkdir(join(profile, 'Default'), { recursive: true });
  await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ extensions: { pinned_extensions: [extensionId] } }));
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(process.env.BROWSER_CONNECT_CHROMIUM ? { executablePath: process.env.BROWSER_CONNECT_CHROMIUM } : {}),
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PI_BROWSER_CONNECT_DIR: runtime },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1000, height: 800 },
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const indicator = async shared => {
    await eventually(async () => await worker.evaluate(() => chrome.action.getTitle({})) === `Pi Browser Connect — ${shared ? 'Tab shared' : 'Not sharing'}`);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '');
  };
  await indicator(false);
  const fixture = await context.newPage();
  await fixture.goto(url);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await connecting;
  await eventually(async () => await popup.locator('#badge').textContent() === 'Awaiting your permission');
  await assert.rejects(call({ action: 'snapshot' }), /No shared tab/);
  // A bridge and pairing session are not permission to share: the dot stays red.
  await indicator(false);
  await command('connect', ctx);
  const code = await popup.locator('#code').textContent();
  assert.match(code, /^\d{6}$/);
  assert.ok(notices.some(message => message.includes(code)));
  assert.deepEqual(data(await call({ action: 'tabs' })).tabs, []);
  await assert.rejects(call({ action: 'snapshot' }), /No shared tab/);
  // The same popup document stays open as a background tab so its active-tab query
  // sees the fixture, exactly as the toolbar popup does. No test-only extension APIs.
  await fixture.bringToFront();
  // A real browser shortcut grants activeTab, just like clicking the toolbar icon.
  execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+y']);
  await delay(300);
  await eventually(async () => !(await popup.locator('#share').isDisabled()));
  const captures = process.env.BROWSER_CONNECT_SCREENSHOTS;
  if (captures) {
    assert.ok(resolve(captures).startsWith('/tmp/'), 'Screenshots must stay under /tmp');
    await mkdir(captures, { recursive: true });
    await popup.locator('main').screenshot({ path: join(captures, 'browser-connect-pairing.png') });
    execFileSync('import', ['-window', 'root', join(captures, 'toolbar-disconnected.png')]);
  }
  await popup.evaluate(() => document.querySelector('#share').click());
  await eventually(async () => await popup.locator('#badge').textContent() === 'Tab shared');
  await indicator(true);
  if (captures) execFileSync('import', ['-window', 'root', join(captures, 'toolbar-shared.png')]);
  assert.equal(data(await call({ action: 'tabs' })).tabs.length, 1);
  let snapshot = data(await call({ action: 'snapshot' }));
  assert.match(snapshot.text, /Browser Connect fixture/);
  assert.ok(!JSON.stringify(snapshot).includes('fixture-secret'));
  const input = snapshot.elements.find(element => element.label === 'Message');
  assert.ok(input);
  await assert.rejects(call({ action: 'type', ref: input.ref, text: 'Hello from Pi' }), /denied/);
  assert.equal(await fixture.locator('#message').inputValue(), '');
  approve = true;
  await call({ action: 'type', ref: input.ref, text: 'Hello from Pi' });
  assert.equal(await fixture.locator('#message').inputValue(), 'Hello from Pi');
  await assert.rejects(call({ action: 'type', ref: input.ref, text: 'repeat' }), /reference/);
  snapshot = data(await call({ action: 'snapshot' }));
  const save = snapshot.elements.find(element => element.label === 'Save draft');
  await call({ action: 'click', ref: save.ref });
  assert.equal(await fixture.locator('#result').textContent(), 'Saved: Hello from Pi');
  snapshot = data(await call({ action: 'snapshot' }));
  const field = snapshot.elements.find(element => element.label === 'Message');
  await call({ action: 'press', ref: field.ref, key: 'Backspace' });
  assert.equal(await fixture.locator('#message').inputValue(), 'Hello from P');
  snapshot = data(await call({ action: 'snapshot' }));
  const old = snapshot.elements.find(element => element.label === 'Save draft');
  await fixture.locator('#save').evaluate(element => { element.textContent = 'Changed action'; });
  await assert.rejects(call({ action: 'click', ref: old.ref }), /Stale/);
  const image = await call({ action: 'screenshot' });
  assert.equal(image.content[1].type, 'image');
  assert.ok(Buffer.from(image.content[1].data, 'base64').length > 1000);
  await call({ action: 'snapshot' });
  await call({ action: 'scroll', direction: 'down' });
  assert.ok(await fixture.evaluate(() => scrollY > 0));
  await assert.rejects(call({ action: 'navigate', url: 'https://example.com' }), /Cross-origin/);
  await call({ action: 'navigate', url: url + 'next' });
  await fixture.waitForURL(url + 'next');
  await call({ action: 'snapshot' });
  if (captures) {
    await popup.locator('main').screenshot({ path: join(captures, 'browser-connect-shared.png') });
    await popup.setViewportSize({ width: 320, height: 900 });
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await popup.locator('main').screenshot({ path: join(captures, 'browser-connect-narrow.png') });
  }
  await fixture.goto(`http://localhost:${server.address().port}/other`);
  await eventually(async () => { try { await call({ action: 'snapshot' }); return false; } catch (error) { return /Not connected|revoked|changed|closed/.test(error.message); } });
  await indicator(false);
  if (captures) execFileSync('import', ['-window', 'root', join(captures, 'toolbar-revoked.png')]);
  await command('disconnect', ctx);
  await assert.rejects(call({ action: 'tabs' }), /Not connected/);
  assert.ok(confirmations.length >= 6);
  for (const handler of extension.handlers.get('session_shutdown')) await handler({ type: 'session_shutdown', reason: 'reload' }, ctx);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const reloaded = loader.getExtensions().extensions[0].tools.get('browser_connect').definition;
  await assert.rejects(reloaded.execute('reload', { action: 'tabs' }, undefined, undefined, ctx), /Not connected/);
});
