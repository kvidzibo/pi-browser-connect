import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

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
