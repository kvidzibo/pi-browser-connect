import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, lstat } from 'node:fs/promises';

export function runtimeDirectory() {
  return resolve(process.env.PI_BROWSER_CONNECT_DIR ||
    join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-browser-connect-${process.getuid()}`));
}

export async function checkRuntimeDirectory(directory = runtimeDirectory(), create = false) {
  if (create) await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Unsafe browser bridge runtime directory');
  }
  return directory;
}
