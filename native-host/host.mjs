#!/usr/bin/env node
import net from 'node:net';
import { randomUUID, randomInt } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRuntimeDirectory } from './paths.mjs';
import { nativeFrame, nativeReader, lineReader, writeLine, REQUEST_MAX, UUID, object, keys, actions } from './wire.mjs';

export async function startHost({ input = process.stdin, output = process.stdout, directory, requestTimeout = 30_000 } = {}) {
  const dir = await checkRuntimeDirectory(directory, true);
  const socketPath = join(dir, `${randomUUID()}.sock`);
  const sockets = new Set();
  let owner, stopped = false, closePromise;
  const send = value => {
    if (output.destroyed || output.writableEnded) return;
    try { output.write(nativeFrame(value)); } catch { queueMicrotask(() => { void close(); }); }
  };
  const disconnect = session => {
    if (owner !== session) return;
    clearTimeout(session.timer);
    // Queue revocation before releasing the slot, including on local cancellation.
    send({ type: 'disconnect', sessionId: session.id });
    owner = undefined;
    session.socket.destroy();
  };
  const server = net.createServer(socket => {
    if (stopped || owner) { socket.destroy(); return; }
    sockets.add(socket);
    let session;
    const helloTimer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => { if (session) disconnect(session); });
    socket.on('close', () => {
      clearTimeout(helloTimer); sockets.delete(socket);
      if (session) disconnect(session);
    });
    socket.on('data', lineReader(REQUEST_MAX, message => {
      if (stopped || socket.destroyed) return;
      if (!session) {
        if (owner || !keys(message, ['type', 'version', 'label']) || message.type !== 'hello' || message.version !== 1 ||
            typeof message.label !== 'string' || message.label.length > 120) { socket.destroy(); return; }
        clearTimeout(helloTimer);
        session = { socket, id: randomUUID(), pending: null, timer: null };
        owner = session;
        const code = String(randomInt(100000, 1000000));
        writeLine(socket, { type: 'welcome', version: 1, sessionId: session.id, code });
        send({ type: 'session', sessionId: session.id, label: message.label, code });
        return;
      }
      if (owner !== session || !keys(message, ['type', 'id', 'params']) || message.type !== 'request' ||
          typeof message.id !== 'string' || !UUID.test(message.id) || !object(message.params) || !actions.has(message.params.action) || session.pending) {
        disconnect(session); return;
      }
      session.pending = message.id;
      session.timer = setTimeout(() => disconnect(session), requestTimeout);
      send({ type: 'request', sessionId: session.id, id: message.id, params: message.params });
    }, () => { if (session) disconnect(session); else socket.destroy(); }));
  });
  function close() {
    if (closePromise) return closePromise;
    stopped = true;
    if (owner) disconnect(owner);
    for (const socket of sockets) socket.destroy();
    input.off('data', onData);
    input.pause();
    input.off('end', onEnd);
    input.off('error', onEnd);
    // Keep the output error listener installed: a delayed EPIPE must not crash.
    // net.Server removes the Unix socket it created when it closes.
    closePromise = new Promise(resolveClose => server.close(() => resolveClose()));
    return closePromise;
  }
  const onEnd = () => { void close(); };
  const onData = nativeReader(message => {
    if (stopped) return;
    if (keys(message, ['type', 'sessionId', 'reason']) && message.type === 'revoked' &&
        typeof message.sessionId === 'string' && typeof message.reason === 'string') {
      if (owner?.id === message.sessionId) {
        writeLine(owner.socket, message);
        // end() flushes the revocation event before the close.
        const session = owner;
        clearTimeout(session.timer);
        send({ type: 'disconnect', sessionId: session.id });
        owner = undefined;
        session.socket.end();
        const timer = setTimeout(() => session.socket.destroy(), 1000);
        session.socket.once('close', () => clearTimeout(timer));
      }
      return;
    }
    const response = object(message) && message.type === 'response' && typeof message.sessionId === 'string' &&
      typeof message.id === 'string' && UUID.test(message.id) &&
      (keys(message, ['type', 'sessionId', 'id', 'result']) ||
       (keys(message, ['type', 'sessionId', 'id', 'error']) && typeof message.error === 'string'));
    if (!response) { void close(); return; }
    if (!owner || message.sessionId !== owner.id || message.id !== owner.pending) return;
    clearTimeout(owner.timer); owner.pending = null;
    writeLine(owner.socket, message);
  }, onEnd);
  output.on('error', onEnd);
  server.on('error', onEnd);
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolveListen(); });
    });
    await chmod(socketPath, 0o600);
    input.on('data', onData); input.on('end', onEnd); input.on('error', onEnd);
    send({ type: 'ready', version: 1 });
    if (input.readableEnded || output.destroyed) await close();
  } catch (error) { await close(); throw error; }
  return { socketPath, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startHost().then(host => {
    process.once('SIGTERM', () => { void host.close(); });
    process.once('SIGINT', () => { void host.close(); });
  }).catch(() => { process.stderr.write('Browser bridge could not start.\n'); process.exitCode = 1; });
}
