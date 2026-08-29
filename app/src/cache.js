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

// Fetch, falling back to cache when the network is gone. `stale` tells the UI
// it is looking at old data so it can say so rather than quietly lying.
export async function cached(key, fetcher) {
  try {
    const fresh = await fetcher();
    await writeCache(key, fresh);
    return { data: fresh, stale: false };
  } catch (e) {
    const fallback = await readCache(key);
    if (fallback == null) throw e;
    return { data: fallback, stale: true };
  }
}
