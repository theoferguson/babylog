import assert from 'node:assert/strict';
import { layout } from './timelineLayout.js';

const NY = 'America/New_York';
const at = (h, m = 0) => `2026-08-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`;
const ev = (id, h, m, endH, endM) => ({
  id, type: 'feed', tz: NY, started_at: at(h, m),
  ended_at: endH == null ? null : at(endH, endM),
});
const by = (rows) => Object.fromEntries(rows.map((r) => [r.event.id, r]));

// One event alone spans the whole width.
let r = by(layout([ev('a', 7, 0, 8, 0)], { tz: NY }));
assert.equal(r.a.widthPct, 100);
assert.equal(r.a.leftPct, 0);
assert.equal(r.a.top, 7 * 44);
assert.equal(r.a.height, 44, 'an hour is one hour tall');

// A short feed is floored at the minimum height: 22 minutes is 16px at
// 44px/hour, which would be unreadable and untappable.
r = by(layout([ev('short', 7, 0, 7, 22)], { tz: NY }));
assert.equal(r.short.height, 22);

// An instant event gets the minimum height, not zero.
r = by(layout([ev('d', 9, 0)], { tz: NY }));
assert.equal(r.d.height, 22);

// A diaper during a feed splits the width; the feed keeps the left column.
r = by(layout([ev('feed', 7, 0, 7, 40), ev('diaper', 7, 10)], { tz: NY }));
assert.equal(r.feed.widthPct, 50);
assert.equal(r.diaper.widthPct, 50);
assert.equal(r.feed.leftPct, 0);
assert.equal(r.diaper.leftPct, 50);

// Three at once -> thirds.
r = by(layout([ev('a', 7, 0, 7, 40), ev('b', 7, 5), ev('c', 7, 10)], { tz: NY }));
assert.deepEqual([r.a.widthPct, r.b.widthPct, r.c.widthPct].map(Math.round), [33, 33, 33]);
assert.deepEqual([r.a.leftPct, r.b.leftPct, r.c.leftPct].map(Math.round), [0, 33, 67]);

// Events far apart do not share width, even in the same day.
r = by(layout([ev('morning', 7, 0, 7, 20), ev('evening', 19, 0, 19, 20)], { tz: NY }));
assert.equal(r.morning.widthPct, 100);
assert.equal(r.evening.widthPct, 100);

// Two instants minutes apart visibly collide even though neither has duration.
r = by(layout([ev('x', 9, 0), ev('y', 9, 10)], { tz: NY }));
assert.equal(r.x.widthPct, 50, 'rendered overlap, not logical overlap');

// ...but once they are far enough apart to clear the minimum height, they are
// each full width again.
r = by(layout([ev('x', 9, 0), ev('y', 9, 45)], { tz: NY }));
assert.equal(r.x.widthPct, 100);
assert.equal(r.y.widthPct, 100);

// A column is reused once its previous block has ended, so a long feed beside
// two short back-to-back events yields two columns, not three.
r = by(layout([ev('long', 7, 0, 9, 0), ev('first', 7, 5), ev('second', 8, 0)], { tz: NY }));
assert.equal(r.long.columns, 2);
assert.equal(r.first.leftPct, 50);
assert.equal(r.second.leftPct, 50);

// Input order must not matter.
const forward = layout([ev('a', 7, 0, 7, 40), ev('b', 7, 10)], { tz: NY });
const backward = layout([ev('b', 7, 10), ev('a', 7, 0, 7, 40)], { tz: NY });
assert.deepEqual(by(forward).a, by(backward).a);

assert.deepEqual(layout([], { tz: NY }), []);

console.log('OK  timelineLayout.js');

// --- how tall a block is -----------------------------------------------------
import { visibleSpanSec } from './timelineLayout.js';

const feed = (extra) => ({
  type: 'feed', tz: NY, started_at: at(17, 30),
  payload: { method: 'breast', right_sec: 4 * 60, left_sec: 15 * 60 }, ...extra,
});

// A paused feed with no segment history is drawn as its nursing time, not the
// span it happened to cover -- otherwise 19 minutes of nursing reads as 105.
assert.equal(visibleSpanSec(feed({ ended_at: at(19, 15), duration_sec: 19 * 60 })), 19 * 60);

// With segments there is something worth showing, so the real span is drawn and
// the nursing stretches are picked out inside it.
assert.equal(
  visibleSpanSec(feed({
    ended_at: at(19, 15),
    duration_sec: 19 * 60,
    payload: {
      method: 'breast', right_sec: 4 * 60, left_sec: 15 * 60,
      segments: [
        { side: 'R', from: at(17, 30), to: at(17, 34) },
        { side: 'L', from: at(19, 0), to: at(19, 15) },
      ],
    },
  })),
  105 * 60,
);

// A single stretch is not worth fading, so it uses nursing time like any other.
assert.equal(
  visibleSpanSec(feed({
    ended_at: at(17, 49), duration_sec: 19 * 60,
    payload: { method: 'breast', right_sec: 19 * 60,
               segments: [{ side: 'R', from: at(17, 30), to: at(17, 49) }] },
  })),
  19 * 60,
);

// Sleep and bottle are unaffected: for them the two numbers are the same thing.
assert.equal(visibleSpanSec({ type: 'sleep', started_at: at(1, 0), ended_at: at(2, 30),
                              duration_sec: 90 * 60, payload: {} }), 90 * 60);
assert.equal(visibleSpanSec({ type: 'feed', started_at: at(9, 0), ended_at: null,
                              duration_sec: null, payload: { method: 'bottle' } }), 0);

console.log('OK  visibleSpanSec');
