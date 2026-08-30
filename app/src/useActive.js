import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { Events } from './api';

// Poll only while a timer is running, plus once whenever the app comes back to
// the foreground. That is what makes a feed startable on one phone and
// stoppable on the other without a socket, a broker, or a background service.
const INTERVAL_MS = 3000;

export function useActiveEvents() {
  const [events, setEvents] = useState([]);
  const [skewMs, setSkewMs] = useState(0);
  // "No timer is running" and "I have not looked yet" are different answers, and
  // a screen that confuses them will offer to start a feed that already exists.
  const [loaded, setLoaded] = useState(false);
  const timer = useRef(null);

  const poll = useCallback(async () => {
    try {
      const { events: rows, now } = await Events.active();
      setEvents(rows || []);
      setLoaded(true);
      // Trust the server's clock for elapsed time; a phone whose clock drifts
      // would otherwise render a different duration than its partner.
      if (now) setSkewMs(new Date(now).getTime() - Date.now());
      return rows || [];
    } catch {
      // Offline: keep showing the last known state, but stop blocking the UI --
      // a local timer is still better than a spinner that never ends.
      setLoaded(true);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const rows = await poll();
      if (cancelled) return;
      clearTimeout(timer.current);
      // Idle costs nothing: with no timer running we only re-check on foreground.
      if (rows && rows.length) timer.current = setTimeout(tick, INTERVAL_MS);
    };
    tick();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') tick();
    });
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      sub.remove();
    };
  }, [poll]);

  return { events, skewMs, loaded, refresh: poll, setEvents };
}

// A ticking clock that re-renders once a second, used only while something runs.
export function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
