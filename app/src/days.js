// Day boundaries in a named zone, not the browser's.
//
// An event belongs to the local day it happened in, in the zone it was recorded
// in. A 2am feed in Lisbon must stay on the Lisbon night, not slide onto the
// previous afternoon when you get home. Everything here is Intl-based, so DST
// transitions are handled by the platform rather than by arithmetic.

function offsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUTC = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second,
  );
  return date.getTime() - asUTC;
}

// 'YYYY-MM-DD' for an instant, as seen in `tz`.
export function dayKey(instant, tz) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The instant at which a local day starts in `tz`.
export function startOfDay(key, tz) {
  const guess = new Date(`${key}T00:00:00Z`);
  // Apply the offset twice: the first pass can land on the wrong side of a DST
  // change, and re-measuring at the corrected instant settles it.
  let out = new Date(guess.getTime() + offsetMs(guess, tz));
  out = new Date(guess.getTime() + offsetMs(out, tz));
  return out;
}

export function dayBounds(key, tz) {
  return { since: startOfDay(key, tz), until: startOfDay(addDays(key, 1), tz) };
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export const todayKey = (tz) => dayKey(new Date(), tz);

// How far into its own local day an event sits, as hours. This is what places a
// block on the 24h axis, and why the axis is correct on a travel day.
export function hourOffset(instant, tz) {
  const d = new Date(instant);
  const start = startOfDay(dayKey(d, tz), tz);
  return (d.getTime() - start.getTime()) / 3600000;
}

export function label(key, tz) {
  const today = todayKey(tz);
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString([], {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}
