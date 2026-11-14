import { endianness } from 'node:os';

export const NATIVE_IN_MAX = 8 * 1024 * 1024;
export const NATIVE_OUT_MAX = 512 * 1024;
export const REQUEST_MAX = 32 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const actions = new Set(['tabs', 'snapshot', 'click', 'type', 'press', 'scroll', 'navigate', 'screenshot']);
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const keys = (value, required) => object(value) && Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
const little = endianness() === 'LE';

export function nativeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > NATIVE_OUT_MAX) throw new Error('Native output too large');
  const header = Buffer.alloc(4);
  if (little) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

// Bounded, incremental readers: reject length headers before allocating bodies.
export function nativeReader(onMessage, onError) {
  let header = Buffer.alloc(4), headerUsed = 0, body, used = 0, failed = false;
  return chunk => {
    if (failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!body) {
          const count = Math.min(4 - headerUsed, chunk.length - offset);
          chunk.copy(header, headerUsed, offset, offset + count);
          headerUsed += count; offset += count;
          if (headerUsed < 4) continue;
          const size = little ? header.readUInt32LE() : header.readUInt32BE();
          if (!size || size > NATIVE_IN_MAX) throw new Error('Invalid native frame size');
          body = Buffer.alloc(size); used = 0; headerUsed = 0;
        }
        const count = Math.min(body.length - used, chunk.length - offset);
        chunk.copy(body, used, offset, offset + count);
        used += count; offset += count;
        if (used === body.length) {
          const message = JSON.parse(body.toString('utf8'));
          body = undefined;
          onMessage(message);
        }
      }
    } catch (error) { failed = true; onError(error); }
  };
}

export function lineReader(max, onMessage, onError) {
  let chunks = [], size = 0, failed = false;
  return chunk => {
    if (failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
        size += part.length;
        if (size > max) throw new Error('Message too large');
        chunks.push(part);
        if (end < 0) break;
        const message = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        chunks = []; size = 0; offset = end + 1;
        onMessage(message);
      }
    } catch (error) { failed = true; onError(error); }
  };
}

export function writeLine(socket, value) {
  socket.write(JSON.stringify(value) + '\n');
}
