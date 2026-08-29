import AsyncStorage from '@react-native-async-storage/async-storage';

// A nursing timer that works with no connection.
//
// Normally a running feed lives on the server so both phones see it. That is
// impossible offline, so this is the fallback: the same accumulator arithmetic,
// kept on the device, saved as one complete event when the connection returns.
//
// The trade is deliberate and one-way: a feed started offline stays local until
// saved, even if the connection comes back mid-feed. Promoting it halfway would
// mean reconciling two clocks against a partner who may also have started one.

const KEY = 'babylog.localTimer';

export const empty = (startedAt = new Date()) => ({
  started_at: startedAt.toISOString(),
  right_sec: 0,
  left_sec: 0,
  running_side: null,
  running_since: null,
  last_side: null,
  notes: '',
});

// --- pure arithmetic, mirroring the server's _bank_running_side --------------

export function bank(state, at) {
  const { running_side: side, running_since: since } = state;
  const next = { ...state, running_side: null, running_since: null };
  if (!side || !since) return next;
  const key = side === 'R' ? 'right_sec' : 'left_sec';
  // A clock that jumps backwards must never subtract time already banked.
  const elapsed = Math.max(0, Math.round((at.getTime() - new Date(since).getTime()) / 1000));
  next[key] = (next[key] || 0) + elapsed;
  return next;
}

// Tapping the running side stops it; tapping the other switches. Sides never
// overlap, which is what the real export shows and what the server enforces.
export function tap(state, side, at) {
  const banked = bank(state, at);
  if (state.running_side === side) return banked;
  return {
    ...banked,
    running_side: side,
    running_since: at.toISOString(),
    last_side: side,
  };
}

export function secsFor(state, side, now) {
  const banked = (side === 'R' ? state.right_sec : state.left_sec) || 0;
  if (state.running_side !== side || !state.running_since) return banked;
  const live = Math.max(0, Math.round((now - new Date(state.running_since).getTime()) / 1000));
  return banked + live;
}

export const total = (state, now) => secsFor(state, 'R', now) + secsFor(state, 'L', now);

// The event body to queue when the feed is saved. Shaped exactly like one the
// server would have produced, so the outbox can POST it unchanged.
export function toEvent(state, at, { baby, tz, id }) {
  const done = bank(state, at);
  return {
    id,
    baby,
    type: 'feed',
    started_at: done.started_at,
    ended_at: at.toISOString(),
    tz,
    in_progress: false,
    notes: done.notes || '',
    payload: {
      method: 'breast',
      ...(done.right_sec ? { right_sec: done.right_sec } : {}),
      ...(done.left_sec ? { left_sec: done.left_sec } : {}),
      ...(done.last_side ? { last_side: done.last_side } : {}),
    },
  };
}

// --- persistence ------------------------------------------------------------

export async function load() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function save(state) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* a dead battery is the thing this guards; a full disk is not worth crashing for */
  }
}

export async function clear() {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
