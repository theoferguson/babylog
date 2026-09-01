// "2h 14m ago" -- the number you actually want half-asleep, not a clock time.
export function ago(iso, now = Date.now()) {
  if (!iso) return '—';
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

// "in 1h 12m" / "25m ago" -- the same phrasing as ago(), pointing forwards.
export function countdown(iso, now = Date.now()) {
  const secs = Math.round((new Date(iso).getTime() - now) / 1000);
  const m = Math.floor(Math.abs(secs) / 60);
  if (m < 1) return 'now';
  const span = m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  return secs > 0 ? `in ${span}` : `${span} ago`;
}

// Which side was nursed most recently, so the timer can suggest the other one.
// Takes a list response -- paginated `{results}` or a bare array -- newest
// first. Bottles in between are skipped rather than ending the search: they
// are feeds, but they are not a side.
export function lastNursedSide(body) {
  const rows = body?.results || body || [];
  const last = rows.find((e) => e.payload?.method === 'breast' && e.payload?.last_side);
  return last?.payload?.last_side || null;
}

export function clock(secs) {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function mins(secs) {
  if (!secs) return null;
  return `${Math.round(secs / 60)}m`;
}

export const timeOfDay = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Volumes are stored in ml. Imperial is a display preference, never storage.
const ML_PER_OZ = 29.5735295625;
export function volume(ml, units) {
  if (ml == null) return null;
  return units === 'imperial'
    ? `${(ml / ML_PER_OZ).toFixed(2).replace(/\.?0+$/, '')}oz`
    : `${Math.round(ml)}ml`;
}
export function toMl(value, units) {
  const n = parseFloat(value);
  if (!isFinite(n)) return null;
  return units === 'imperial' ? Math.round(n * ML_PER_OZ * 100) / 100 : n;
}

// One-line summary of an event for lists and the timeline.
export function summarize(e, units) {
  const p = e.payload || {};
  if (e.type === 'feed' && p.method === 'bottle') return volume(p.volume_ml, units);
  if (e.type === 'feed') {
    const parts = [];
    if (e.duration_sec) parts.push(mins(e.duration_sec));
    if (p.right_sec) parts.push(`R ${Math.round(p.right_sec / 60)}`);
    if (p.left_sec) parts.push(`L ${Math.round(p.left_sec / 60)}`);
    return parts.join(' · ');
  }
  if (e.type === 'diaper') {
    const bits = [];
    if (p.pee) bits.push(`pee ${p.pee}`);
    if (p.poo) bits.push(`poo ${p.poo}`);
    return bits.join(', ');
  }
  if (e.type === 'pump') {
    const total = (p.left_ml || 0) + (p.right_ml || 0);
    return total ? volume(total, units) : null;
  }
  if (e.type === 'sleep') return mins(e.duration_sec);
  return p.label || null;
}
