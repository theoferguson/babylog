import assert from 'node:assert/strict';
import { bank, empty, secsFor, tap, toEvent, total } from './localTimer.js';

const T0 = new Date('2026-08-29T02:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);

let s = empty(T0);
assert.equal(total(s, T0.getTime()), 0);
assert.equal(s.running_side, null);

// Start R, run 13 minutes.
s = tap(s, 'R', T0);
assert.equal(s.running_side, 'R');
assert.equal(s.last_side, 'R');
assert.equal(secsFor(s, 'R', at(13).getTime()), 13 * 60);
assert.equal(secsFor(s, 'L', at(13).getTime()), 0);

// Switch to L: R banks, L starts. Sides never overlap.
s = tap(s, 'L', at(13));
assert.equal(s.right_sec, 13 * 60);
assert.equal(s.running_side, 'L');
assert.equal(secsFor(s, 'R', at(20).getTime()), 13 * 60, 'a banked side stops counting');

// Back to R -- an accumulator, not a single stretch.
s = tap(s, 'R', at(21));
assert.equal(s.left_sec, 8 * 60);
s = tap(s, 'R', at(25)); // same side again = stop
assert.equal(s.running_side, null);
assert.equal(s.right_sec, (13 + 4) * 60);
assert.equal(s.last_side, 'R');
assert.equal(total(s, at(99).getTime()), (13 + 4 + 8) * 60, 'paused total does not drift');

// Sides never exceed wall clock -- the invariant the server also enforces.
const wall = 25 * 60;
assert.ok(s.right_sec + s.left_sec <= wall);

// A backwards clock must not subtract banked time.
let b = tap(empty(T0), 'R', T0);
b = bank(b, at(-5));
assert.equal(b.right_sec, 0);

// The queued body is shaped exactly like a server-produced event.
const ev = toEvent(s, at(25), { baby: 'baby-1', tz: 'America/New_York', id: 'id-1' });
assert.equal(ev.type, 'feed');
assert.equal(ev.in_progress, false);
assert.equal(ev.ended_at, at(25).toISOString());
assert.equal(ev.started_at, T0.toISOString());
const { segments, ...totals } = ev.payload;
assert.deepEqual(totals, {
  method: 'breast', right_sec: 17 * 60, left_sec: 8 * 60, last_side: 'R',
});
// One stretch per run of a side, in order, adding up to the totals.
assert.deepEqual(segments.map((g) => g.side), ['R', 'L', 'R']);
assert.equal(
  segments.reduce((a, g) => a + (new Date(g.to) - new Date(g.from)) / 1000, 0),
  25 * 60,
);

// A single-side feed omits the side that never ran, matching the importer.
let one = tap(empty(T0), 'L', T0);
one = tap(one, 'L', at(9));
const ev2 = toEvent(one, at(9), { baby: 'b', tz: 'UTC', id: 'i' });
const { segments: seg2, ...totals2 } = ev2.payload;
assert.deepEqual(totals2, { method: 'breast', left_sec: 9 * 60, last_side: 'L' });
assert.equal(seg2.length, 1);

// Saving while a side is still running banks it rather than losing it.
let running = tap(empty(T0), 'R', T0);
const ev3 = toEvent(running, at(10), { baby: 'b', tz: 'UTC', id: 'i' });
assert.equal(ev3.payload.right_sec, 10 * 60);

console.log('OK  localTimer.js');

// An offline feed ends when the timer stopped, not when Save was pressed.
{
  const t = (m) => new Date(Date.UTC(2026, 8, 1, 12, m, 0));
  let st = empty(t(0));
  st = tap(st, 'R', t(0));
  st = tap(st, 'R', t(20));            // stop at +20m
  const ev = toEvent(st, t(35), { baby: 'b', tz: 'UTC', id: 'x' });
  assert.equal(ev.ended_at, t(20).toISOString(), 'ends at the last stretch, not the save');
  assert.equal(ev.payload.right_sec, 20 * 60);
  assert.equal(ev.payload.segments.length, 1);
  // A feed the timer never ran for has nothing to clamp to.
  const bare = toEvent(empty(t(0)), t(5), { baby: 'b', tz: 'UTC', id: 'y' });
  assert.equal(bare.ended_at, t(5).toISOString());
}
console.log('OK  localTimer ends at the last stretch');
