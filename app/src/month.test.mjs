import assert from 'node:assert/strict';
import { monthGrid, monthKey, monthLabel, shiftMonth, weekLabel, weekOf } from './month.js';

assert.equal(monthKey('2026-08-30'), '2026-08');
assert.equal(monthLabel('2026-08'), 'August 2026');

// Month paging must roll the year, both ways.
assert.equal(shiftMonth('2026-12', 1), '2027-01');
assert.equal(shiftMonth('2026-01', -1), '2025-12');
assert.equal(shiftMonth('2026-08', 0), '2026-08');

// Always 42 cells, so the grid height never jumps between months.
for (const m of ['2026-08', '2026-02', '2028-02', '2026-11']) {
  assert.equal(monthGrid(m).length, 42, m);
}

// August 2026 starts on a Saturday, so the grid opens with six greyed July days.
const aug = monthGrid('2026-08');
assert.equal(aug[0].key, '2026-07-26');
assert.equal(aug[0].inMonth, false);
assert.equal(aug[6].key, '2026-08-01');
assert.equal(aug[6].inMonth, true);
assert.equal(aug.filter((c) => c.inMonth).length, 31);

// Leap year February has 29 in-month days.
assert.equal(monthGrid('2028-02').filter((c) => c.inMonth).length, 29);
assert.equal(monthGrid('2026-02').filter((c) => c.inMonth).length, 28);

// Every row starts on a Sunday.
for (let i = 0; i < 42; i += 7) {
  assert.equal(new Date(`${aug[i].key}T12:00:00Z`).getUTCDay(), 0);
}

// Weeks run Sunday to Saturday and contain the day asked for.
const w = weekOf('2026-08-30'); // a Sunday
assert.equal(w.length, 7);
assert.equal(w[0], '2026-08-30');
assert.equal(w[6], '2026-09-05');
const mid = weekOf('2026-08-27'); // a Thursday
assert.equal(mid[0], '2026-08-23');
assert.equal(mid[6], '2026-08-29');
assert.ok(mid.includes('2026-08-27'));

// A week spanning two months says both.
assert.equal(weekLabel(weekOf('2026-08-27')), 'Aug 23 – 29');
assert.equal(weekLabel(weekOf('2026-08-30')), 'Aug 30 – Sep 5');

console.log('OK  month.js');
