import assert from 'node:assert/strict';
import { byDay, dayStats, feedIntervals, isNight, median, summary } from './stats.js';

const NY = 'America/New_York';
const feed = (iso, extra = {}) => ({ type: 'feed', started_at: iso, tz: NY, payload: { method: 'breast' }, ...extra });

assert.equal(median([]), null);
assert.equal(median([5]), 5);
assert.equal(median([1, 2, 3]), 2);
assert.equal(median([1, 2, 3, 4]), 2.5);
// The reason it is a median: one huge overnight gap must not move it.
assert.equal(median([120, 130, 140, 600]), 135);

// Intervals are start-to-start, and survive a day boundary.
const across = [
  feed('2026-08-27T23:00:00-04:00'),
  feed('2026-08-28T02:00:00-04:00'),
  feed('2026-08-28T05:30:00-04:00'),
];
assert.deepEqual(feedIntervals(across), [180, 210]);
// Order of input must not matter.
assert.deepEqual(feedIntervals([...across].reverse()), [180, 210]);
assert.deepEqual(feedIntervals([feed('2026-08-28T05:00:00-04:00')]), []);

// Night is 7pm-7am local.
assert.equal(isNight(feed('2026-08-27T22:00:00-04:00'), NY), true);
assert.equal(isNight(feed('2026-08-28T03:00:00-04:00'), NY), true);
assert.equal(isNight(feed('2026-08-28T12:00:00-04:00'), NY), false);
assert.equal(isNight(feed('2026-08-28T19:00:00-04:00'), NY), true);
assert.equal(isNight(feed('2026-08-28T06:59:00-04:00'), NY), true);
assert.equal(isNight(feed('2026-08-28T07:00:00-04:00'), NY), false);
// Midnight must read as hour 0, not 24.
assert.equal(isNight(feed('2026-08-28T00:30:00-04:00'), NY), true);

const day = [
  feed('2026-08-28T08:00:00-04:00', { duration_sec: 1260 }),
  { type: 'feed', started_at: '2026-08-28T11:00:00-04:00', tz: NY, payload: { method: 'bottle', volume_ml: 100 } },
  { type: 'diaper', started_at: '2026-08-28T09:00:00-04:00', tz: NY, payload: { pee: 'small' } },
  { type: 'diaper', started_at: '2026-08-28T13:00:00-04:00', tz: NY, payload: { poo: 'large', pee: 'medium' } },
  { type: 'pump', started_at: '2026-08-28T10:00:00-04:00', tz: NY, payload: { left_ml: 60, right_ml: 40 } },
];
const st = dayStats(day);
assert.equal(st.feeds, 2);
assert.equal(st.nursingMin, 21);
assert.equal(st.bottleMl, 100);
assert.equal(st.diapers, 2);
assert.equal(st.pees, 2);
assert.equal(st.poos, 1);
assert.equal(st.pumpedMl, 100);

// Buckets cover the whole window, including days with nothing in them.
const buckets = byDay(day, NY, 3, '2026-08-28');
assert.deepEqual(buckets.map((b) => b.key), ['2026-08-26', '2026-08-27', '2026-08-28']);
assert.deepEqual(buckets.map((b) => b.events.length), [0, 0, 5]);

// Averages use only days with data -- otherwise importing a 10-day history and
// looking at 30 days would halve every number.
const sum = summary(day, NY, 30, '2026-08-28');
assert.equal(sum.activeDays, 1);
assert.equal(sum.avgFeeds, 2);
assert.equal(sum.avgDiapers, 2);
assert.equal(sum.totalPumpedMl, 100);

// A late-evening event in NY belongs to the NY day, not the UTC one.
const lateNight = byDay([feed('2026-08-28T23:30:00-04:00')], NY, 2, '2026-08-28');
assert.equal(lateNight[1].events.length, 1);

console.log('OK  stats.js');
