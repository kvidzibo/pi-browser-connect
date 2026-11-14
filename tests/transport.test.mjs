import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, chmod, lstat, symlink, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { startHost } from '../native-host/host.mjs';
import { BrowserClient } from '../native-host/client.mjs';
import { runtimeDirectory, checkRuntimeDirectory } from '../native-host/paths.mjs';
import { nativeFrame, nativeReader, lineReader, writeLine, NATIVE_IN_MAX, REQUEST_MAX } from '../native-host/wire.mjs';
import { setup, HOST_NAME, extensionPath } from '../native-host/install.mjs';

const run = promisify(execFile);
function inbox(stream, reader) {
  const values = [], waiters = [];
  stream.on('data', reader(value => { if (waiters.length) waiters.shift()(value); else values.push(value); }, error => { throw error; }));
  return () => values.length ? Promise.resolve(values.shift()) : new Promise(resolve => waiters.push(resolve));
}
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'pbc-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture(t, options = {}) {
  const directory = await temporary(t);
  const input = new PassThrough(), output = new PassThrough();
  const next = inbox(output, nativeReader);
  const host = await startHost({ input, output, directory, ...options });
  t.after(() => host.close());
  assert.deepEqual(await next(), { type: 'ready', version: 1 });
  return { ...host, directory, input, output, next };
}
async function raw(t, path) {
  const socket = net.createConnection(path);
  socket.on('error', () => {});
  const next = inbox(socket, (message, error) => lineReader(NATIVE_IN_MAX, message, error));
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return { socket, next };
}
function useDirectory(t, directory) {
  const previous = process.env.PI_BROWSER_CONNECT_DIR;
  process.env.PI_BROWSER_CONNECT_DIR = directory;
  t.after(() => { if (previous === undefined) delete process.env.PI_BROWSER_CONNECT_DIR; else process.env.PI_BROWSER_CONNECT_DIR = previous; });
}

test('private paths reject unsafe modes and symlinks without changing them', async t => {
  const root = await temporary(t);
  const dir = join(root, 'runtime');
  await checkRuntimeDirectory(dir, true);
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  await chmod(dir, 0o750);
  await assert.rejects(checkRuntimeDirectory(dir, true), /Unsafe/);
  assert.equal((await lstat(dir)).mode & 0o777, 0o750);
  await chmod(dir, 0o700);
  await symlink(dir, join(root, 'link'));
  await assert.rejects(checkRuntimeDirectory(join(root, 'link'), true), /Unsafe/);
  useDirectory(t, dir);
  assert.equal(runtimeDirectory(), dir);
});

test('native frames support arbitrary fragmentation, coalescing, and early size rejection', () => {
  const values = [], errors = [];
  const reader = nativeReader(value => values.push(value), error => errors.push(error));
  const frames = Buffer.concat([nativeFrame({ hello: 'é' }), nativeFrame([1, 2])]);
  for (const byte of frames) reader(Buffer.from([byte]));
  assert.deepEqual(values, [{ hello: 'é' }, [1, 2]]);
  const header = Buffer.alloc(4);
  header[endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](NATIVE_IN_MAX + 1);
  reader(header);
  assert.equal(errors.length, 1);
  assert.throws(() => nativeFrame({ text: 'x'.repeat(512 * 1024) }), /too large/);
});

test('one session, fragmented hello, allowlisted requests, and foreign/stale replies', async t => {
  const host = await fixture(t);
  assert.equal((await lstat(host.socketPath)).mode & 0o777, 0o600);
  const probe = await raw(t, host.socketPath);
  probe.socket.destroy(); // Discovery must not reserve ownership.
  const first = await raw(t, host.socketPath);
  const hello = JSON.stringify({ type: 'hello', version: 1, label: 'test' }) + '\n';
  for (const byte of Buffer.from(hello)) first.socket.write(Buffer.from([byte]));
  const welcome = await first.next();
  assert.equal(welcome.version, 1); assert.match(welcome.code, /^\d{6}$/);
  assert.deepEqual(await host.next(), { type: 'session', sessionId: welcome.sessionId, label: 'test', code: welcome.code });
  const second = await raw(t, host.socketPath);
  await new Promise(resolve => second.socket.once('close', resolve));
  const id = randomUUID(), params = { action: 'tabs' };
  writeLine(first.socket, { type: 'request', id, params });
  assert.deepEqual(await host.next(), { type: 'request', sessionId: welcome.sessionId, id, params });
  host.input.write(Buffer.concat([
    nativeFrame({ type: 'response', sessionId: randomUUID(), id, result: 'foreign' }),
    nativeFrame({ type: 'response', sessionId: welcome.sessionId, id: randomUUID(), result: 'stale' }),
    nativeFrame({ type: 'response', sessionId: welcome.sessionId, id, result: 'correct' }),
  ]));
  assert.equal((await first.next()).result, 'correct');
  const closed = once(first.socket, 'close');
  writeLine(first.socket, { type: 'request', id: randomUUID(), params: { action: 'exec' } });
  assert.deepEqual(await host.next(), { type: 'disconnect', sessionId: welcome.sessionId });
  await closed;
  const replacement = await raw(t, host.socketPath);
  writeLine(replacement.socket, { type: 'hello', version: 1, label: 'replacement' });
  assert.notEqual((await replacement.next()).sessionId, welcome.sessionId);
});

test('client discovery rejects zero/multiple hosts without claiming any session', async t => {
  const first = await fixture(t);
  useDirectory(t, first.directory);
  const otherInput = new PassThrough(), otherOutput = new PassThrough();
  otherOutput.resume();
  const other = await startHost({ input: otherInput, output: otherOutput, directory: first.directory });
  t.after(() => other.close());
  await assert.rejects(BrowserClient.connect('test'), /Multiple live/);
  await other.close();
  const client = await BrowserClient.connect('test'); t.after(() => client.close());
  assert.equal(client.connected, true);
  assert.equal((await first.next()).type, 'session');
  client.close();
  assert.equal((await first.next()).type, 'disconnect');
  await first.close();
  await assert.rejects(BrowserClient.connect('test'), /No live/);
});

test('discovery skips but never deletes stale sockets; pre-aborted operations do not send requests', async t => {
  const host = await fixture(t); useDirectory(t, host.directory);
  const original = join(host.directory, 'original.sock'), stale = join(host.directory, 'stale.sock');
  const server = net.createServer();
  await new Promise(resolve => server.listen(original, resolve));
  await chmod(original, 0o600);
  await rename(original, stale);
  await new Promise(resolve => server.close(resolve));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(BrowserClient.connect('aborted', { signal: controller.signal }), /aborted/);
  const client = await BrowserClient.connect('live'); t.after(() => client.close());
  assert.equal((await host.next()).type, 'session');
  assert.equal((await lstat(stale)).isSocket(), true);
  await assert.rejects(client.request({ action: 'tabs' }, controller.signal), /aborted/);
  const pending = client.request({ action: 'tabs' });
  const forwarded = await host.next();
  host.input.write(nativeFrame({ type: 'response', sessionId: client.sessionId, id: forwarded.id, result: 'only request' }));
  assert.equal(await pending, 'only request');
  assert.equal((await lstat(stale)).isSocket(), true);
});

test('client serializes, forwards errors, and cancellation closes with uncertainty and permits replacement', async t => {
  const host = await fixture(t); useDirectory(t, host.directory);
  const client = await BrowserClient.connect('Pi'); t.after(() => client.close());
  await host.next();
  const request = client.request({ action: 'snapshot' });
  const forwarded = await host.next();
  await assert.rejects(client.request({ action: 'tabs' }), /in flight/);
  host.input.write(nativeFrame({ type: 'response', sessionId: client.sessionId, id: forwarded.id, error: 'Denied' }));
  await assert.rejects(request, /Denied/);
  assert.equal(client.connected, true);
  const controller = new AbortController();
  const pending = client.request({ action: 'click', ref: 'r1' }, controller.signal);
  await host.next();
  const rejected = assert.rejects(pending, /may already have run; do not retry automatically/);
  controller.abort(); await rejected;
  assert.equal(client.connected, false);
  assert.deepEqual(await host.next(), { type: 'disconnect', sessionId: client.sessionId });
  const next = await BrowserClient.connect('replacement'); t.after(() => next.close());
  await host.next();
  const result = next.request({ action: 'tabs' });
  const message = await host.next();
  host.input.write(Buffer.concat([
    nativeFrame({ type: 'response', sessionId: client.sessionId, id: message.id, result: 'old' }),
    nativeFrame({ type: 'response', sessionId: next.sessionId, id: message.id, result: [] }),
  ]));
  assert.deepEqual(await result, []);
});

test('revocation is forwarded before close, and host timeouts disconnect pending work', async t => {
  const host = await fixture(t, { requestTimeout: 30 }); useDirectory(t, host.directory);
  const client = await BrowserClient.connect('test'); t.after(() => client.close());
  await host.next();
  const pending = client.request({ action: 'tabs' });
  const rejected = assert.rejects(pending, /may already have run/);
  await host.next();
  assert.equal((await host.next()).type, 'disconnect');
  await rejected;
  const peer = await raw(t, host.socketPath);
  writeLine(peer.socket, { type: 'hello', version: 1, label: 'raw' });
  const welcome = await peer.next(); await host.next();
  const closed = once(peer.socket, 'close');
  const revoked = { type: 'revoked', sessionId: welcome.sessionId, reason: 'user' };
  host.input.write(nativeFrame(revoked));
  assert.deepEqual(await peer.next(), revoked);
  await closed;
  assert.equal((await host.next()).type, 'disconnect');
});

test('oversized/unknown/concurrent client envelopes are rejected and EOF cleans only own socket', async t => {
  const host = await fixture(t);
  const unrelated = join(host.directory, 'unrelated'); await writeFile(unrelated, 'keep');
  for (const kind of ['oversize', 'unknown', 'concurrent']) {
    const peer = await raw(t, host.socketPath);
    writeLine(peer.socket, { type: 'hello', version: 1, label: kind });
    const welcome = await peer.next(); await host.next();
    const closed = once(peer.socket, 'close');
    if (kind === 'oversize') peer.socket.write('x'.repeat(REQUEST_MAX + 1));
    if (kind === 'unknown') writeLine(peer.socket, { type: 'surprise' });
    if (kind === 'concurrent') {
      writeLine(peer.socket, { type: 'request', id: randomUUID(), params: { action: 'tabs' } });
      await host.next();
      writeLine(peer.socket, { type: 'request', id: randomUUID(), params: { action: 'tabs' } });
    }
    assert.deepEqual(await host.next(), { type: 'disconnect', sessionId: welcome.sessionId });
    await closed;
  }
  const owner = await raw(t, host.socketPath);
  writeLine(owner.socket, { type: 'hello', version: 1, label: 'EOF' });
  const welcome = await owner.next(); await host.next();
  const ownerClosed = once(owner.socket, 'close');
  host.input.end();
  assert.deepEqual(await host.next(), { type: 'disconnect', sessionId: welcome.sessionId });
  await ownerClosed; await host.close();
  assert.deepEqual(await readdir(host.directory), ['unrelated']);
});

test('stdout failure closes sockets and invalid native headers shut down', async t => {
  for (const mode of ['output', 'header']) {
    const host = await fixture(t);
    const peer = await raw(t, host.socketPath);
    const closed = once(peer.socket, 'close');
    if (mode === 'output') host.output.emit('error', new Error('EPIPE'));
    else {
      const header = Buffer.alloc(4);
      header[endianness() === 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](NATIVE_IN_MAX + 1);
      host.input.write(header);
    }
    await closed; await host.close();
    await assert.rejects(lstat(host.socketPath), { code: 'ENOENT' });
  }
});

test('direct host CLI keeps stdout protocol-only and exits cleanly on stdin EOF', async t => {
  const directory = await temporary(t);
  const child = spawn(process.execPath, ['native-host/host.mjs'], {
    env: { ...process.env, PI_BROWSER_CONNECT_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  const next = inbox(child.stdout, nativeReader);
  const exited = once(child, 'exit');
  assert.deepEqual(await next(), { type: 'ready', version: 1 });
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.sock')).length, 1);
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  assert.equal(diagnostics, '');
  assert.deepEqual(await readdir(directory), []);
});

test('setup is explicit, validates input, quotes absolute paths, reinstalls owned files only', async t => {
  const root = await temporary(t);
  const home = join(root, "home with 'quotes");
  const hostPath = join(root, "host with 'quotes.mjs");
  await writeFile(hostPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const extensionId = 'a'.repeat(32);
  await assert.rejects(setup('chromium', extensionId, { home, platform: 'darwin' }), /Linux/);
  await assert.rejects(setup('firefox', extensionId, { home }), /chromium or chrome/);
  await assert.rejects(setup('chrome', 'not-an-id', { home }), /extension ID/);
  const execPath = join(root, "node with 'quotes");
  await symlink(process.execPath, execPath);
  const paths = await setup('chromium', extensionId, { home, hostPath, execPath });
  assert.equal((await lstat(paths.launcher)).mode & 0o777, 0o700);
  const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8'));
  assert.equal(manifest.name, HOST_NAME); assert.equal(manifest.path, paths.launcher);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal((await run(paths.launcher, ['a b', "c'd"])).stdout, JSON.stringify(['a b', "c'd"]));
  await setup('chromium', 'b'.repeat(32), { home, hostPath });
  await writeFile(paths.manifestPath, '{"unrelated":true}');
  const script = await readFile(paths.launcher, 'utf8');
  await assert.rejects(setup('chromium', extensionId, { home }), /unrelated manifest/);
  assert.equal(await readFile(paths.launcher, 'utf8'), script);
  await writeFile(paths.launcher, '# unrelated');
  await assert.rejects(setup('chrome', extensionId, { home }), /unrelated launcher/);
  await run(process.execPath, ['native-host/install.mjs', 'setup', 'chrome'], { env: { ...process.env, HOME: join(root, 'cli-home') } });
  const cliManifest = JSON.parse(await readFile(join(root, 'cli-home/.config/google-chrome/NativeMessagingHosts', `${HOST_NAME}.json`), 'utf8'));
  assert.deepEqual(cliManifest.allowed_origins, ['chrome-extension://lmiednaanfkhmeldhmbgimndmmilcibe/']);
  assert.equal((await run(process.execPath, ['native-host/install.mjs', 'path'])).stdout.trim(), extensionPath);
  assert.equal(isAbsolute(extensionPath), true);
});
