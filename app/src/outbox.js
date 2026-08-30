import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { ApiError, api, attachOutbox } from './api';

// Offline writes. The timer is server-authoritative (both phones must see it),
// so this queue is for the things that can wait: instant events, edits and
// deletes, plus a nursing feed finished while offline.
//
// Every queued create carries a client-generated UUID, so flushing twice cannot
// duplicate a row -- the server upserts on that id.

const KEY = 'babylog.outbox';
const listeners = new Set();
let queue = null;

async function read() {
  if (queue) return queue;
  try {
    queue = JSON.parse((await AsyncStorage.getItem(KEY)) || '[]');
  } catch {
    queue = [];
  }
  return queue;
}

async function write(next) {
  queue = next;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or unavailable: the in-memory queue still flushes */
  }
  listeners.forEach((fn) => fn(next.length));
}

export function onChange(fn) {
  listeners.add(fn);
  read().then((q) => fn(q.length));
  return () => listeners.delete(fn);
}

export const newId = () => randomUUID();

export async function pending() {
  return (await read()).length;
}

export async function enqueue(op) {
  const q = await read();
  await write([...q, { ...op, queued_at: new Date().toISOString() }]);
}

// Only a lost connection is queued. A 4xx means the server looked at the request
// and refused it; retrying forever would never succeed and would hide the error.
export function isOffline(e) {
  return e instanceof ApiError && e.status === 0;
}

async function send(op) {
  if (op.method === 'POST') return api.post(op.path, op.body);
  if (op.method === 'PATCH') return api.patch(op.path, op.body);
  if (op.method === 'DELETE') return api.del(op.path);
  throw new Error(`unknown op ${op.method}`);
}

export async function flush() {
  const q = await read();
  if (!q.length) return { sent: 0, failed: 0, dropped: 0 };
  const remaining = [];
  let sent = 0;
  let dropped = 0;
  for (let i = 0; i < q.length; i += 1) {
    const op = q[i];
    try {
      await send(op);
      sent += 1;
    } catch (e) {
      if (isOffline(e)) {
        // Still offline: keep this and everything after it, in order.
        remaining.push(...q.slice(i));
        break;
      }
      // Rejected on its merits. Dropping it is the only way the queue drains;
      // keeping it would block every later write behind a request that can
      // never succeed.
      dropped += 1;
    }
  }
  await write(remaining);
  return { sent, failed: remaining.length, dropped };
}

// Try the network; queue on failure and hand back what the UI should show.
export async function writeThrough({ method, path, body, optimistic }) {
  try {
    return { ok: true, data: await send({ method, path, body }) };
  } catch (e) {
    if (!isOffline(e)) throw e;
    await enqueue({ method, path, body });
    return { ok: false, queued: true, data: optimistic ?? body };
  }
}

// Wire the queue into the API layer. Done here rather than in api.js so the
// module graph stays acyclic.
attachOutbox({ newId, writeThrough });
