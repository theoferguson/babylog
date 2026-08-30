import { addDays, dayKey, todayKey } from './days.js';

// Calendar-grid maths for the day picker. Weeks start Sunday, matching the
// week strip and US convention.

export function monthKey(key) {
  return key.slice(0, 7); // 'YYYY-MM'
}

export function monthLabel(mKey) {
  const [y, m] = mKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString([], {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function shiftMonth(mKey, n) {
  const [y, m] = mKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Six rows of seven, so the grid never changes height as you page through
// months -- a jumping layout is the classic date-picker annoyance.
export function monthGrid(mKey) {
  const [y, m] = mKey.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    return { key, day: d.getUTCDate(), inMonth: key.slice(0, 7) === mKey };
  });
}

// Sunday-based week containing `key`.
export function weekOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const start = addDays(key, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function weekLabel(keys) {
  const fmt = (k, opts) =>
    new Date(`${k}T12:00:00Z`).toLocaleDateString([], { timeZone: 'UTC', ...opts });
  const a = keys[0];
  const b = keys[6];
  const sameMonth = a.slice(0, 7) === b.slice(0, 7);
  return sameMonth
    ? `${fmt(a, { month: 'short', day: 'numeric' })} – ${fmt(b, { day: 'numeric' })}`
    : `${fmt(a, { month: 'short', day: 'numeric' })} – ${fmt(b, { month: 'short', day: 'numeric' })}`;
}

// Days that already happened, so the picker can grey out the future.
export const isFuture = (key, tz) => key > todayKey(tz);

export const keyOf = (iso, tz) => dayKey(iso, tz);
