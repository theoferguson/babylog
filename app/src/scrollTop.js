// Tapping the tab you are already on should return you to the top -- standard
// iOS behaviour, and the fastest way back after scrolling a long day.
const listeners = new Map();

export function registerScroller(key, ref) {
  listeners.set(key, ref);
  return () => listeners.delete(key);
}

export function scrollToTop(key) {
  listeners.get(key)?.current?.scrollTo?.({ y: 0, animated: true });
}
