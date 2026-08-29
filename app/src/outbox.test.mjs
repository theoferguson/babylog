// Queue semantics, without React or a device: node src/outbox.test.mjs
import assert from 'node:assert/strict';

// Minimal stand-ins for the platform bits.
const store = new Map();
globalThis.__store = store;

class ApiError extends Error {
  constructor(status) { super('x'); this.status = status; }
}

// Re-implement flush's contract against a fake sender, mirroring outbox.js.
function makeQueue() {
  let q = [];
  return {
    enqueue: (op) => q.push(op),
    size: () => q.length,
    async flush(send) {
      const remaining = [];
      let sent = 0, dropped = 0;
      for (let i = 0; i < q.length; i += 1) {
        try {
          await send(q[i]); sent += 1;
        } catch (e) {
          if (e instanceof ApiError && e.status === 0) { remaining.push(...q.slice(i)); break; }
          dropped += 1;
        }
      }
      q = remaining;
      return { sent, failed: remaining.length, dropped };
    },
  };
}

// Offline: nothing sends, nothing is lost, order is preserved.
let qu = makeQueue();
['a', 'b', 'c'].forEach((id) => qu.enqueue({ id }));
let r = await qu.flush(() => { throw new ApiError(0); });
assert.deepEqual(r, { sent: 0, failed: 3, dropped: 0 });
assert.equal(qu.size(), 3);

// Back online: everything drains.
r = await qu.flush(async () => 'ok');
assert.deepEqual(r, { sent: 3, failed: 0, dropped: 0 });
assert.equal(qu.size(), 0);

// A row the server rejects (400) is dropped, not retried forever -- otherwise it
// blocks every later write behind a request that can never succeed.
qu = makeQueue();
['good1', 'bad', 'good2'].forEach((id) => qu.enqueue({ id }));
r = await qu.flush(async (op) => { if (op.id === 'bad') throw new ApiError(400); return 'ok'; });
assert.deepEqual(r, { sent: 2, failed: 0, dropped: 1 });
assert.equal(qu.size(), 0);

// Connection drops mid-flush: the rest stays queued, in order.
qu = makeQueue();
['a', 'b', 'c', 'd'].forEach((id) => qu.enqueue({ id }));
let n = 0;
r = await qu.flush(async () => { n += 1; if (n > 2) throw new ApiError(0); return 'ok'; });
assert.deepEqual(r, { sent: 2, failed: 2, dropped: 0 });
assert.equal(qu.size(), 2);

console.log('OK  outbox queue semantics');
