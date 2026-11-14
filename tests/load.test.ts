import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { bundledExtensionId } from '../native-host/install.mjs';

test('package loads and reloads through Pi without connection or model requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-browser-connect-load-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true,
    additionalExtensionPaths: [fileURLToPath(new URL('../index.ts', import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  for (let i = 0; i < 2; i++) {
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.equal(extensions.length, 1);
    assert.deepEqual([...extensions[0].commands.keys()], ['browser-connect']);
    assert.deepEqual([...extensions[0].tools.keys()], ['browser_connect']);
    assert.deepEqual([...extensions[0].handlers.keys()].sort(), ['session_shutdown', 'session_tree']);
  }
});

test('guided setup requires user choice, registers the bundled ID, and cancels pending discovery', { timeout: 10000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'pi-browser-connect-setup-'));
  const previousHome = process.env.HOME;
  const previousDirectory = process.env.PI_BROWSER_CONNECT_DIR;
  process.env.HOME = home;
  process.env.PI_BROWSER_CONNECT_DIR = join(home, 'runtime');
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousDirectory === undefined) delete process.env.PI_BROWSER_CONNECT_DIR; else process.env.PI_BROWSER_CONNECT_DIR = previousDirectory;
    await rm(home, { recursive: true, force: true });
  });
  const loader = new DefaultResourceLoader({
    cwd: home, agentDir: home, settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, additionalExtensionPaths: [fileURLToPath(new URL('../index.ts', import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extension = loader.getExtensions().extensions[0];
  const command = extension.commands.get('browser-connect')!.handler;
  const notices: string[] = [];
  let choice: string | undefined;
  const ctx = {
    hasUI: true, cwd: home, sessionManager: { getSessionId: () => 'setup-test' },
    ui: { select: async () => choice, notify: (message: string) => notices.push(message) },
  } as any;
  const idle = async () => {
    for (let i = 0; i < 100; i++) {
      await command('status', ctx);
      if (notices.at(-1)!.startsWith('Disconnected')) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Pending connection did not stop');
  };
  await assert.rejects(command('setup chromium', { ...ctx, hasUI: false }), /interactive/);
  await command('', ctx); // Escape from setup must not write anything or wait.
  await idle();
  await assert.rejects(access(join(home, '.local/share/pi-browser-connect/host')), { code: 'ENOENT' });
  await command('setup firefox', ctx);
  assert.match(notices.pop()!, /Usage/);
  await command('setup chromium', ctx);
  const manifest = JSON.parse(await readFile(join(home, '.config/chromium/NativeMessagingHosts/com.kvidzibo.pi_browser_connect.json'), 'utf8'));
  assert.equal(await bundledExtensionId(), 'lmiednaanfkhmeldhmbgimndmmilcibe');
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://lmiednaanfkhmeldhmbgimndmmilcibe/']);
  choice = 'Already registered — wait for browser popup';
  const waiting = command('', ctx);
  t.after(async () => { await command('disconnect', ctx); await waiting; });
  while (!notices.some(message => message.includes('Waiting up to'))) await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(command('connect', ctx), /already pending/);
  for (const handler of extension.handlers.get('session_shutdown')!) await handler({ type: 'session_shutdown', reason: 'reload' }, ctx);
  await waiting;
  await idle();
  await command('status', ctx);
  assert.match(notices.at(-1)!, /^Disconnected/);
});
