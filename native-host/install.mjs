#!/usr/bin/env node
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, lstat, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_NAME = 'com.kvidzibo.pi_browser_connect';
const description = 'Pi Browser Connect managed native host';
const marker = '# pi-browser-connect managed launcher v1\n';
export const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), '../browser-extension');
export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function bundledExtensionId() {
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  return createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}

async function existing(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error(`Refusing unrelated file: ${path}`);
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function setup(browser, extensionId, { home = homedir(), platform = process.platform, execPath = process.execPath, hostPath = fileURLToPath(new URL('./host.mjs', import.meta.url)) } = {}) {
  if (platform !== 'linux') throw new Error('Native host setup supports Linux only');
  if (!['chromium', 'chrome'].includes(browser)) throw new Error('Expected chromium or chrome');
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid Chromium extension ID');
  home = resolve(home);
  const launcher = join(home, '.local/share/pi-browser-connect/host');
  const manifestPath = join(home, '.config', browser === 'chrome' ? 'google-chrome' : 'chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
  const oldLauncher = await existing(launcher);
  if (oldLauncher !== null && !oldLauncher.startsWith(`#!/bin/sh\n${marker}exec `)) throw new Error(`Refusing unrelated launcher: ${launcher}`);
  const oldManifest = await existing(manifestPath);
  if (oldManifest !== null) {
    let value;
    try { value = JSON.parse(oldManifest); } catch { throw new Error(`Refusing unrelated manifest: ${manifestPath}`); }
    if (value.name !== HOST_NAME || value.description !== description || value.path !== launcher || value.type !== 'stdio' ||
        !Array.isArray(value.allowed_origins) || value.allowed_origins.length !== 1 || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(value.allowed_origins[0])) {
      throw new Error(`Refusing unrelated manifest: ${manifestPath}`);
    }
  }
  const script = `#!/bin/sh\n${marker}exec ${shellQuote(resolve(execPath))} ${shellQuote(resolve(hostPath))} "$@"\n`;
  const manifest = { name: HOST_NAME, description, path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(launcher, script, { mode: 0o700, flag: oldLauncher === null ? 'wx' : 'w' });
  await chmod(launcher, 0o700);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: oldManifest === null ? 'wx' : 'w' });
  return { launcher, manifestPath };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === 'path') { process.stdout.write(extensionPath + '\n'); return; }
  if ([2, 3].includes(args.length) && args[0] === 'setup') { await setup(args[1], args[2] ?? await bundledExtensionId()); return; }
  throw new Error('Usage: pi-browser-connect path | setup chromium|chrome [EXTENSION_ID]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
