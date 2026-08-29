import assert from 'node:assert/strict';
import { addDays, dayBounds, dayKey, hourOffset, startOfDay } from './days.js';

const NY = 'America/New_York';
const LIS = 'Europe/Lisbon';

// An instant late in a New York evening is still that NY day, even though it is
// already tomorrow in UTC.
assert.equal(dayKey('2026-08-27T23:46:00-04:00', NY), '2026-08-27');
assert.equal(dayKey('2026-08-28T03:46:00Z', NY), '2026-08-27');
assert.equal(dayKey('2026-08-28T03:46:00Z', 'UTC'), '2026-08-28');

// Local midnight, expressed as a UTC instant. EDT is -04:00, EST is -05:00.
assert.equal(startOfDay('2026-08-27', NY).toISOString(), '2026-08-27T04:00:00.000Z');
assert.equal(startOfDay('2026-01-15', NY).toISOString(), '2026-01-15T05:00:00.000Z');

// DST transitions: the day that springs forward is 23h, the one that falls back
// is 25h. Naive arithmetic gets both wrong.
const spring = dayBounds('2026-03-08', NY);
assert.equal((spring.until - spring.since) / 3600000, 23);
const fall = dayBounds('2026-11-01', NY);
assert.equal((fall.until - fall.since) / 3600000, 25);
const normal = dayBounds('2026-08-27', NY);
assert.equal((normal.until - normal.since) / 3600000, 24);

// The travel case the whole design exists for: one instant, two zones. A 2am
// Lisbon feed stays on the Lisbon night instead of sliding to the prior day.
const feed = '2026-08-28T01:00:00+01:00';
assert.equal(dayKey(feed, LIS), '2026-08-28');
assert.equal(dayKey(feed, NY), '2026-08-27');
assert.equal(hourOffset(feed, LIS), 1);
assert.equal(hourOffset(feed, NY), 20);

// Placement on the 24h axis.
assert.equal(hourOffset('2026-08-27T15:13:00-04:00', NY), 15 + 13 / 60);
assert.equal(hourOffset('2026-08-27T00:00:00-04:00', NY), 0);

assert.equal(addDays('2026-08-31', 1), '2026-09-01');
assert.equal(addDays('2026-01-01', -1), '2025-12-31');
assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // leap year

console.log('OK  days.js');
