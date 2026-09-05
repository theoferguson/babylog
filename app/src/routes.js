// Where a tap on an event goes. A running timer opens the screen that can stop
// it; anything else opens the editor.
export function eventPath(e) {
  if (!e.in_progress) return `/event/${e.id}`;
  return e.type === 'sleep' ? '/sleep' : '/nurse';
}
