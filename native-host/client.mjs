import net from 'node:net';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDirectory, checkRuntimeDirectory } from './paths.mjs';
import { lineReader, writeLine, NATIVE_IN_MAX, REQUEST_MAX, UUID, keys, object, actions } from './wire.mjs';

const uncertainty = 'Browser request may already have run; do not retry automatically';
const aborted = () => new Error('Browser connection aborted');
const noHost = () => Object.assign(new Error('No live browser host'), { code: 'NO_HOST' });

function dial(path, signal, timeout) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const socket = net.createConnection(path);
    const finish = error => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      socket.off('connect', onConnect); socket.off('error', onError);
      if (error) { socket.destroy(); reject(error); } else resolve(socket);
    };
    const onConnect = () => finish();
    const onError = error => finish(error);
    const onAbort = () => finish(aborted());
    const timer = setTimeout(() => finish(new Error('Browser connection timed out')), Math.max(1, timeout));
    socket.once('connect', onConnect); socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class BrowserClient {
  #socket;
  #pending;
  #connected = false;
  #ready;
  #welcomeResolve;
  #welcomeReject;
  #welcomeCleanup = () => {};
  code;
  sessionId;

  static async connect(label, { signal } = {}) {
    if (typeof label !== 'string' || label.length > 120) throw new Error('Invalid session label');
    if (signal?.aborted) throw aborted();
    const deadline = Date.now() + 5000;
    const directory = runtimeDirectory();
    try { await checkRuntimeDirectory(directory); }
    catch (error) { if (error.code === 'ENOENT') throw noHost(); throw error; }
    const candidates = (await readdir(directory)).filter(name => name.endsWith('.sock'));
    const live = (await Promise.all(candidates.map(async name => {
      const path = join(directory, name);
      let stat;
      try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return;
      try {
        const socket = await dial(path, signal, deadline - Date.now());
        socket.on('error', () => {});
        socket.destroy(); // No hello: discovery never reserves a session.
        return path;
      } catch (error) {
        if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) return;
        throw error;
      }
    }))).filter(Boolean);
    if (live.length !== 1) throw live.length ? new Error('Multiple live browser hosts; close all but one') : noHost();
    const socket = await dial(live[0], signal, deadline - Date.now());
    const client = new BrowserClient(socket);
    const onAbort = () => client.#fail(aborted());
    const timer = setTimeout(() => client.#fail(new Error('Browser handshake timed out')), Math.max(1, deadline - Date.now()));
    client.#welcomeCleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else writeLine(socket, { type: 'hello', version: 1, label });
    await client.#ready;
    return client;
  }

  constructor(socket) {
    this.#socket = socket;
    this.#ready = new Promise((resolve, reject) => { this.#welcomeResolve = resolve; this.#welcomeReject = reject; });
    socket.on('error', () => this.#fail(new Error('Browser connection failed')));
    socket.on('close', () => this.#fail(new Error('Browser connection closed')));
    socket.on('end', () => this.#fail(new Error('Browser connection ended')));
    socket.on('data', lineReader(NATIVE_IN_MAX, message => this.#message(message), () => this.#fail(new Error('Invalid browser protocol'))));
  }

  get connected() { return this.#connected && !this.#socket.destroyed; }

  #message(message) {
    if (!this.#connected) {
      if (!keys(message, ['type', 'version', 'sessionId', 'code']) || message.type !== 'welcome' || message.version !== 1 ||
          typeof message.sessionId !== 'string' || !UUID.test(message.sessionId) || typeof message.code !== 'string' || !/^\d{6}$/.test(message.code)) {
        this.#fail(new Error('Invalid browser handshake')); return;
      }
      this.sessionId = message.sessionId; this.code = message.code; this.#connected = true;
      this.#welcomeCleanup(); this.#welcomeResolve(); return;
    }
    if (keys(message, ['type', 'sessionId', 'reason']) && message.type === 'revoked' && message.sessionId === this.sessionId && typeof message.reason === 'string') {
      this.#fail(new Error('Browser access revoked')); return;
    }
    if (!object(message) || message.type !== 'response' ||
        !(keys(message, ['type', 'sessionId', 'id', 'result']) ||
          (keys(message, ['type', 'sessionId', 'id', 'error']) && typeof message.error === 'string'))) {
      this.#fail(new Error('Invalid browser protocol')); return;
    }
    if (message.sessionId !== this.sessionId || message.id !== this.#pending?.id) return;
    const pending = this.#pending; this.#pending = undefined; pending.cleanup();
    if (Object.hasOwn(message, 'error')) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  request(params, signal) {
    if (!this.connected) return Promise.reject(new Error('Browser is not connected'));
    if (this.#pending) return Promise.reject(new Error('A browser request is already in flight'));
    if (signal?.aborted) return Promise.reject(aborted());
    if (!object(params) || !actions.has(params.action)) return Promise.reject(new Error('Invalid browser action'));
    const id = randomUUID();
    let data;
    try {
      data = JSON.stringify({ type: 'request', id, params }) + '\n';
      if (Buffer.byteLength(data) - 1 > REQUEST_MAX) throw new Error('Browser request too large');
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#fail(new Error('Browser request aborted'));
      const timer = setTimeout(() => this.#fail(new Error('Browser request timed out')), 30_000);
      this.#pending = { id, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.#socket.write(data); } catch (error) { this.#fail(error); }
    });
  }

  #fail(error) {
    this.#connected = false; this.#welcomeCleanup(); this.#welcomeReject(error);
    if (this.#pending) {
      const pending = this.#pending; this.#pending = undefined; pending.cleanup();
      pending.reject(new Error(`${error.message}; ${uncertainty}`));
    }
    this.#socket.destroy();
  }

  close() { this.#fail(new Error('Browser connection closed')); }
}
