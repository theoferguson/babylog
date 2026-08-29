// Plain node, no framework: node src/format.test.mjs
import assert from 'node:assert/strict';
import { ago, clock, summarize, toMl, volume } from './format.js';

const T = (s) => new Date(Date.UTC(2026, 7, 28, 12, 0, 0)).getTime() + s * 1000;
const now = T(0);
assert.equal(ago(new Date(T(-30)).toISOString(), now), 'just now');
assert.equal(ago(new Date(T(-90)).toISOString(), now), '1m ago');
assert.equal(ago(new Date(T(-8040)).toISOString(), now), '2h 14m ago');
assert.equal(ago(new Date(T(-86400 * 2)).toISOString(), now), '2d ago');
assert.equal(ago(null, now), '—');
// A clock that drifted forward must not render a negative age.
assert.equal(ago(new Date(T(600)).toISOString(), now), 'just now');

assert.equal(clock(0), '00:00');
assert.equal(clock(61), '01:01');
assert.equal(clock(3600), '60:00');
assert.equal(clock(-5), '00:00');

// Volumes are stored ml; imperial is display only, and must round-trip.
assert.equal(volume(103.51, 'imperial'), '3.5oz');
assert.equal(volume(103.51, 'metric'), '104ml');
assert.equal(volume(null, 'metric'), null);
assert.equal(Math.round(toMl('3.5', 'imperial') * 100) / 100, 103.51);
assert.equal(toMl('60', 'metric'), 60);
assert.equal(toMl('', 'metric'), null);
assert.equal(toMl('abc', 'metric'), null);

assert.equal(
  summarize({ type: 'feed', duration_sec: 1260, payload: { method: 'breast', right_sec: 780, left_sec: 480 } }),
  '21m · R 13 · L 8',
);
assert.equal(summarize({ type: 'feed', payload: { method: 'bottle', volume_ml: 103.51 } }, 'imperial'), '3.5oz');
assert.equal(summarize({ type: 'diaper', payload: { pee: 'medium', poo: 'large' } }), 'pee medium, poo large');
assert.equal(summarize({ type: 'pump', payload: { left_ml: 59.15, right_ml: 44.36 } }, 'imperial'), '3.5oz');
// A single-side feed omits the side it did not use.
assert.equal(
  summarize({ type: 'feed', duration_sec: 540, payload: { method: 'breast', left_sec: 540 } }),
  '9m · L 9',
);

console.log('OK  format.js');
