// Plain node, no framework: node src/routes.test.mjs
import assert from 'node:assert/strict';
import { eventPath } from './routes.js';
import { titleFor, styleFor } from './theme.js';

// A tap on a running timer has to reach the screen that can stop it. Sending a
// running sleep to /nurse would show an idle nursing screen and no way to wake.
assert.equal(eventPath({ id: 'a', type: 'sleep', in_progress: true }), '/sleep');
assert.equal(eventPath({ id: 'a', type: 'feed', in_progress: true }), '/nurse');
assert.equal(eventPath({ id: 'a', type: 'sleep' }), '/event/a');
assert.equal(eventPath({ id: 'a', type: 'diaper' }), '/event/a');

// A free-form event is its title; everything else is its type.
assert.equal(titleFor({ type: 'note', payload: { label: 'Vitamin D' } }), 'Vitamin D');
assert.equal(titleFor({ type: 'note', payload: {} }), 'Other');
assert.equal(titleFor({ type: 'note' }), 'Other');
assert.equal(titleFor({ type: 'diaper', payload: {} }), 'Diaper');
assert.equal(titleFor({ type: 'feed', payload: { method: 'bottle' } }), 'Bottle');
// An unknown type must still draw, not crash.
assert.equal(styleFor({ type: 'growth' }).label, 'Other');

console.log('OK  routes/titleFor');
