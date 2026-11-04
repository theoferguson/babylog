import AsyncStorage from '@react-native-async-storage/async-storage';

// Last-known-good responses, so every screen renders instantly and keeps
// working on a dead connection. Reads only -- writes go through the outbox.

const PREFIX = 'babylog.cache.';

export async function readCache(key) {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function writeCache(key, value) {
  try {
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* a full disk must not break the app */
  }
}

export const isAuthError = (e) => e?.status === 401 || e?.status === 403;

// Fetch, falling back to cache when the network is gone. `stale` tells the UI
// it is looking at old data so it can say so rather than quietly lying.
// A refused token is not "the network is gone": serving the cache over it would
// keep a revoked session looking signed in forever.
export async function cached(key, fetcher) {
  try {
    const fresh = await fetcher();
    await writeCache(key, fresh);
    return { data: fresh, stale: false };
  } catch (e) {
    if (isAuthError(e)) throw e;
    const fallback = await readCache(key);
    if (fallback == null) throw e;
    return { data: fallback, stale: true };
  }
}
