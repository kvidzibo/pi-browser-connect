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
  const approvals = [];
  let approval;
  let onApproval;
  const approvalChoices = ['Deny', 'Approve once', 'Approve all for this session'];
  const ctx = { hasUI: true, cwd: home, sessionManager: { getSessionId: () => 'integration-session' }, ui: {
    notify: message => notices.push(message),
    select: async (title, options) => {
      if (options.includes('Chromium')) return 'Chromium';
      assert.deepEqual(options, approvalChoices);
      approvals.push(title);
      return onApproval ? await onApproval() : approval;
    },
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
    res.end(`<!doctype html><html><head><title>Shared tab fixture</title><style>.blur-parent { filter: blur(8px); }</style></head><body style="font:20px system-ui;padding:48px"><h1>Browser Connect fixture</h1><label>Message <input id="message"></label><button id="save" onclick="document.querySelector('#result').textContent='Saved: '+document.querySelector('#message').value">Save draft</button><p id="result">Not saved</p><input type="password" value="fixture-secret"><form id="form-secret"><img class="form-image"></form><a href="http://localhost:${server.address().port}/other">Other origin</a><div class="blur-parent"><img class="picture" role="img" style=\'filter:url("https://example.test/a)fixture-url-secret")\' src="/fixture-image-secret.png" onerror="void('fixture-event-secret')" data-private="fixture-data-secret"></div>${'<div class="inspect-match"></div>'.repeat(12)}<div style="height:1200px"></div><p>Bottom</p></body></html>`);
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
  // Observe successful real API calls, without replacing icon rendering or grants.
  await worker.evaluate(() => {
    globalThis.scriptEvaluations = [];
    const sendCommand = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Runtime.evaluate' && params.timeout === 5000) {
        globalThis.scriptEvaluations.push({ contextId: params.contextId, timeout: params.timeout, awaitPromise: params.awaitPromise, returnByValue: params.returnByValue });
      }
      return sendCommand(target, method, params);
    };
    globalThis.completedIconPaths = chrome.runtime.getManifest().action.default_icon;
    const setIcon = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = async details => {
      await setIcon(details);
      globalThis.completedIconPaths = details.path;
    };
  });
  const indicator = async shared => {
    const expected = { 16: `icons/icon-${shared ? 'connected-' : ''}16.png`, 32: `icons/icon-${shared ? 'connected-' : ''}32.png` };
    await eventually(async () => JSON.stringify(await worker.evaluate(() => globalThis.completedIconPaths)) === JSON.stringify(expected));
    await eventually(async () => await worker.evaluate(() => chrome.action.getTitle({})) === `Pi Browser Connect — ${shared ? 'Tab shared' : 'Not sharing'}`);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '');
    // Verify both resolution variants actually contain the requested status color.
    const colors = await worker.evaluate(async () => Promise.all(Object.entries(globalThis.completedIconPaths).map(async ([size, path]) => {
      const bitmap = await createImageBitmap(await (await fetch(chrome.runtime.getURL(path))).blob());
      const canvas = new OffscreenCanvas(Number(size), Number(size));
      const drawing = canvas.getContext('2d');
      drawing.drawImage(bitmap, 0, 0);
      bitmap.close();
      const center = Math.floor(Number(size) * 104 / 128);
      return Array.from(drawing.getImageData(center, center, 1, 1).data);
    })));
    assert.deepEqual(colors, [16, 32].map(() => shared ? [34, 197, 94, 255] : [239, 68, 68, 255]));
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
  // Inspection is read-only, even before mutation approval, and must preserve snapshot refs.
  const approvalsBeforeInspect = approvals.length;
  const inspected = data(await call({ action: 'inspect', selector: 'img.picture' }));
  assert.equal(inspected.elements.length, 1);
  assert.equal(inspected.truncated, false);
  assert.match(inspected.limits, /sanitized opening tags/);
  const picture = inspected.elements[0];
  assert.equal(picture.tag, 'img');
  assert.deepEqual(picture.classes, ['picture']);
  assert.equal(picture.styles.filter, '[URL omitted]');
  assert.doesNotMatch(JSON.stringify(inspected), /fixture-url-secret/);
  assert.match(picture.html, /^<img(?:\s+(?:id|class|role)="[^"]*")*\s*>$/);
  assert.ok(picture.ancestors.length > 0 && picture.ancestors.length <= 5);
  const parent = picture.ancestors[0];
  assert.equal(parent.tag, 'div');
  assert.ok(parent.classes.includes('blur-parent'));
  assert.equal(parent.styles.filter, 'blur(8px)');
  for (const ancestor of picture.ancestors) assert.equal('ancestors' in ancestor, false);
  assert.doesNotMatch(JSON.stringify(inspected), /fixture-(?:image|event|data)-secret|src=|onerror|data-private/);
  const inputs = data(await call({ action: 'inspect', selector: 'input' }));
  assert.deepEqual(inputs.elements, []);
  assert.deepEqual(data(await call({ action: 'inspect', selector: 'form,button,form img' })).elements, []);
  const body = data(await call({ action: 'inspect', selector: 'body' }));
  assert.equal(body.elements.length, 1);
  assert.equal(body.elements[0].html, '<body>');
  assert.doesNotMatch(JSON.stringify({ inputs, body }), /fixture-secret|value=|<input|<script|<style|href=|src=|onclick/);
  const bounded = data(await call({ action: 'inspect', selector: 'div' }));
  assert.equal(bounded.elements.length, 10);
  assert.equal(bounded.truncated, true);
  await assert.rejects(call({ action: 'inspect', selector: 'body:has(input[type="password"][value^="fixture"])' }), /simple CSS/);
  await assert.rejects(call({ action: 'inspect', selector: '[' }), /selector|CSS|invalid/i);
  await assert.rejects(call({ action: 'inspect' }), /selector/i);
  await assert.rejects(call({ action: 'inspect', selector: '   ' }), /selector/i);
  await assert.rejects(call({ action: 'inspect', selector: 'a'.repeat(501) }), /selector/i);
  assert.equal(approvals.length, approvalsBeforeInspect);
  await assert.rejects(call({ action: 'type', ref: input.ref, text: 'Hello from Pi' }), /denied/);
  assert.equal(await fixture.locator('#message').inputValue(), '');
  assert.equal(approvals.length, 1, 'Dismissing the selector denies the mutation');
  assert.match(approvals[0], /type/);
  assert.match(approvals[0], /Message/);
  assert.match(approvals[0], /Hello from Pi/);
  approval = 'Deny';
  await assert.rejects(call({ action: 'type', ref: input.ref, text: 'Hello from Pi' }), /denied/);
  assert.equal(await fixture.locator('#message').inputValue(), '');
  assert.equal(approvals.length, 2);
  const cancelled = new AbortController();
  onApproval = () => { cancelled.abort(); return 'Approve all for this session'; };
  await assert.rejects(tool.execute('cancelled', { action: 'type', ref: input.ref, text: 'Cancelled' }, cancelled.signal, undefined, ctx), { name: 'AbortError' });
  onApproval = undefined;
  await assert.rejects(call({ action: 'type', ref: input.ref, text: 'Still denied' }), /denied/);
  assert.equal(await fixture.locator('#message').inputValue(), '');
  approval = 'Approve once';
  await call({ action: 'type', ref: input.ref, text: 'Hello from Pi' });
  assert.equal(approvals.length, 5);
  assert.equal(await fixture.locator('#message').inputValue(), 'Hello from Pi');
  await assert.rejects(call({ action: 'type', ref: input.ref, text: 'repeat' }), /reference/);
  snapshot = data(await call({ action: 'snapshot' }));
  const save = snapshot.elements.find(element => element.label === 'Save draft');
  await call({ action: 'click', ref: save.ref });
  assert.equal(approvals.length, 6, 'Approve once must prompt again for the next mutation');
  assert.match(approvals.at(-1), /click/);
  assert.match(approvals.at(-1), /Save draft/);
  assert.equal(await fixture.locator('#result').textContent(), 'Saved: Hello from Pi');
  snapshot = data(await call({ action: 'snapshot' }));
  const field = snapshot.elements.find(element => element.label === 'Message');
  approval = 'Approve all for this session';
  await call({ action: 'press', ref: field.ref, key: 'Backspace' });
  assert.equal(approvals.length, 7);
  assert.equal(await fixture.locator('#message').inputValue(), 'Hello from P');
  const sessionApprovalCount = approvals.length;
  approval = 'Deny'; // Any unexpected prompt now denies rather than silently approving.
  await assert.rejects(call({ action: 'press', ref: field.ref, key: 'Backspace' }), /reference/);
  snapshot = data(await call({ action: 'snapshot' }));
  const currentField = snapshot.elements.find(element => element.label === 'Message');
  await assert.rejects(tool.execute('noninteractive', { action: 'type', ref: currentField.ref, text: 'Must not be typed' }, new AbortController().signal, undefined, { ...ctx, hasUI: false }), /interactive approval/);
  assert.equal(await fixture.locator('#message').inputValue(), 'Hello from P');
  await call({ action: 'type', ref: currentField.ref, text: 'Hello from Pi' });
  assert.equal(await fixture.locator('#message').inputValue(), 'Hello from Pi');
  assert.equal(approvals.length, sessionApprovalCount, 'Session approval skips prompts but retains UI and reference validation');
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
  assert.equal(approvals.length, sessionApprovalCount, 'Session approval also suppresses navigation prompts');
  if (captures) {
    await popup.locator('main').screenshot({ path: join(captures, 'browser-connect-shared.png') });
    await popup.setViewportSize({ width: 320, height: 900 });
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await popup.locator('main').screenshot({ path: join(captures, 'browser-connect-narrow.png') });
  }
  // Session approval from a normal mutation covers scripts, but still requires UI.
  const approvedScript = { action: 'evaluate', expression: '1' };
  await assert.rejects(tool.execute('noninteractive-approved-script', approvedScript, undefined, undefined, { ...ctx, hasUI: false }), /interactive approval/);
  assert.deepEqual(data(await call(approvedScript)), { result: '1', truncated: false });
  assert.equal(approvals.length, sessionApprovalCount, 'Mutation session approval suppresses script prompts, not the UI requirement');
  // Disconnect, reconnect, and explicitly share the fixture to reset session approval.
  await command('disconnect', ctx);
  await indicator(false);
  await command('connect', ctx);
  await eventually(async () => await popup.locator('#badge').textContent() === 'Awaiting your permission');
  await fixture.bringToFront();
  execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+y']);
  await delay(300);
  await eventually(async () => !(await popup.locator('#share').isDisabled()));
  await popup.evaluate(() => document.querySelector('#share').click());
  await eventually(async () => await popup.locator('#badge').textContent() === 'Tab shared');
  await indicator(true);
  const evaluateStart = approvals.length;
  const unblur = { action: 'evaluate', expression: `(() => { const node = document.querySelector('.blur-parent'); node.style.filter = 'none'; return getComputedStyle(node).filter; })()` };
  const filter = () => fixture.locator('.blur-parent').evaluate(node => getComputedStyle(node).filter);
  assert.equal(await filter(), 'blur(8px)');
  approval = 'Deny';
  await assert.rejects(call(unblur), /denied/);
  approval = undefined;
  await assert.rejects(call(unblur), /denied/);
  assert.equal(await filter(), 'blur(8px)', 'Denied and dismissed scripts must not change the DOM');
  const scriptCancelled = new AbortController();
  onApproval = () => { scriptCancelled.abort(); return 'Approve all for this session'; };
  await assert.rejects(tool.execute('cancelled-script', unblur, scriptCancelled.signal, undefined, ctx), { name: 'AbortError' });
  onApproval = undefined;
  const beforeNoUI = approvals.length;
  await assert.rejects(tool.execute('noninteractive-script', unblur, undefined, undefined, { ...ctx, hasUI: false }), /interactive approval/);
  assert.equal(approvals.length, beforeNoUI);
  assert.equal(await filter(), 'blur(8px)');
  snapshot = data(await call({ action: 'snapshot' }));
  const scriptRef = snapshot.elements.find(element => element.label === 'Message').ref;
  approval = 'Approve once';
  assert.deepEqual(data(await call(unblur)), { result: '"none"', truncated: false });
  assert.equal(await filter(), 'none');
  await assert.rejects(call({ action: 'type', ref: scriptRef, text: 'Consumed' }), /reference/);
  await assert.rejects(call({ action: 'scroll', direction: 'down' }), /fresh snapshot/);
  if (captures) await fixture.screenshot({ path: join(captures, 'evaluate-unblurred.png') });
  await fixture.evaluate(() => { globalThis.pageOnlyFixture = 'page secret'; });
  assert.deepEqual(data(await call({ action: 'evaluate', expression: 'typeof pageOnlyFixture' })), { result: '"undefined"', truncated: false });
  assert.deepEqual(data(await call({ action: 'evaluate', expression: 'globalThis.scriptOnlyFixture = 42' })), { result: '42', truncated: false });
  assert.deepEqual(data(await call({ action: 'evaluate', expression: 'typeof scriptOnlyFixture' })), { result: '"undefined"', truncated: false });
  assert.deepEqual(data(await call({ action: 'evaluate', expression: `'x'.repeat(12001)` })), { result: '"' + 'x'.repeat(11999), truncated: true });
  for (const expression of ['(() => { throw new Error("fixture failure"); })()', 'Promise.resolve(1)', '(() => { const value = {}; value.self = value; return value; })()']) {
    await assert.rejects(call({ action: 'evaluate', expression }), /Browser script failed/);
  }
  assert.equal(approvals.length - evaluateStart, 11, 'Without session approval every script call prompts; cancellation must not grant session approval');
  const scriptEvaluations = await worker.evaluate(() => globalThis.scriptEvaluations);
  assert.equal(scriptEvaluations.length, 9, 'Only approved scripts reach CDP, including the session-approved script');
  assert.equal(new Set(scriptEvaluations.map(entry => entry.contextId)).size, 9, 'Each script gets a fresh isolated world');
  for (const entry of scriptEvaluations) {
    assert.equal(entry.timeout, 5000);
    assert.equal(entry.awaitPromise, false);
    assert.equal(entry.returnByValue, true);
  }
  // Session approval selected from a script covers both scripts and normal mutations.
  approval = 'Approve all for this session';
  assert.deepEqual(data(await call(approvedScript)), { result: '1', truncated: false });
  assert.equal(approvals.length - evaluateStart, 12);
  assert.match(approvals.at(-1), /^Run JavaScript/);
  const scriptSessionApprovalCount = approvals.length;
  approval = 'Deny';
  assert.deepEqual(data(await call({ action: 'evaluate', expression: '2' })), { result: '2', truncated: false });
  snapshot = data(await call({ action: 'snapshot' }));
  await call({ action: 'type', ref: snapshot.elements.find(element => element.label === 'Message').ref, text: 'Session still approved' });
  assert.equal(approvals.length, scriptSessionApprovalCount, 'Script session approval suppresses script and normal mutation prompts');
  assert.equal(await fixture.locator('#message').inputValue(), 'Session still approved');
  await assert.rejects(call({ action: 'evaluate', expression: '(() => { while (true) {} })()' }), /timed out|terminated/i);
  assert.deepEqual(data(await call({ action: 'evaluate', expression: '1' })), { result: '1', truncated: false });
  assert.equal(approvals.length, scriptSessionApprovalCount, 'Timeout and recovery retain session approval');
  approval = 'Deny';
  const approvalsBeforeReconnect = approvals.length;
  // Tree navigation disconnects; reconnect and share again: approval must not survive.
  for (const handler of extension.handlers.get('session_tree')) await handler({ type: 'session_tree' }, ctx);
  await assert.rejects(call({ action: 'tabs' }), /Not connected/);
  await indicator(false);
  await command('connect', ctx);
  await eventually(async () => await popup.locator('#badge').textContent() === 'Awaiting your permission');
  await fixture.bringToFront();
  execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+y']);
  await delay(300);
  await eventually(async () => !(await popup.locator('#share').isDisabled()));
  await popup.evaluate(() => document.querySelector('#share').click());
  await eventually(async () => await popup.locator('#badge').textContent() === 'Tab shared');
  await indicator(true);
  snapshot = data(await call({ action: 'snapshot' }));
  const reconnectedField = snapshot.elements.find(element => element.label === 'Message');
  await assert.rejects(call({ action: 'type', ref: reconnectedField.ref, text: 'After reconnect' }), /denied/);
  await assert.rejects(call(approvedScript), /denied/);
  assert.equal(approvals.length, approvalsBeforeReconnect + 2, 'Tree navigation and reconnection reset session approval for mutations and scripts');
  assert.equal(await fixture.locator('#message').inputValue(), 'Session still approved');
  approval = 'Approve once';
  await call({ action: 'type', ref: reconnectedField.ref, text: 'After reconnect' });
  assert.equal(await fixture.locator('#message').inputValue(), 'After reconnect');
  snapshot = data(await call({ action: 'snapshot' }));
  onApproval = async () => { await command('disconnect', ctx); return 'Approve all for this session'; };
  await assert.rejects(call({ action: 'type', ref: snapshot.elements.find(element => element.label === 'Message').ref, text: 'Changed connection' }), /Connection changed/);
  onApproval = undefined;
  await command('connect', ctx);
  await eventually(async () => await popup.locator('#badge').textContent() === 'Awaiting your permission');
  await fixture.bringToFront();
  execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+y']);
  await delay(300);
  await eventually(async () => !(await popup.locator('#share').isDisabled()));
  await popup.evaluate(() => document.querySelector('#share').click());
  await eventually(async () => await popup.locator('#badge').textContent() === 'Tab shared');
  snapshot = data(await call({ action: 'snapshot' }));
  approval = 'Deny';
  await assert.rejects(call({ action: 'type', ref: snapshot.elements.find(element => element.label === 'Message').ref, text: 'Still denied' }), /denied/);
  assert.equal(await fixture.locator('#message').inputValue(), 'After reconnect');
  await fixture.goto(`http://localhost:${server.address().port}/other`);
  await eventually(async () => { try { await call({ action: 'snapshot' }); return false; } catch (error) { return /Not connected|revoked|changed|closed/.test(error.message); } });
  await indicator(false);
  await assert.rejects(call({ action: 'evaluate', expression: '1' }), /Not connected|revoked|No shared tab/);
  if (captures) execFileSync('import', ['-window', 'root', join(captures, 'toolbar-revoked.png')]);
  await command('disconnect', ctx);
  await assert.rejects(call({ action: 'tabs' }), /Not connected/);
  assert.ok(approvals.length >= 6);
  // Evaluation cannot grant tab access, and approval cannot survive a changed connection.
  await command('connect', ctx);
  await eventually(async () => await popup.locator('#badge').textContent() === 'Awaiting your permission');
  approval = 'Approve once';
  await assert.rejects(call({ action: 'evaluate', expression: '1' }), /No shared tab/);
  assert.deepEqual(data(await call({ action: 'tabs' })).tabs, []);
  await indicator(false);
  onApproval = async () => { await command('disconnect', ctx); return 'Approve once'; };
  await assert.rejects(call({ action: 'evaluate', expression: '1' }), /Connection changed/);
  onApproval = undefined;
  for (const handler of extension.handlers.get('session_shutdown')) await handler({ type: 'session_shutdown', reason: 'reload' }, ctx);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const reloaded = loader.getExtensions().extensions[0].tools.get('browser_connect').definition;
  await assert.rejects(reloaded.execute('reload', { action: 'tabs' }, undefined, undefined, ctx), /Not connected/);
});
