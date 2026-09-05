// Single source of truth for colour. The timeline, log buttons, week strip and
// charts all read from here, so changing the palette is one file.
//
// These values are measured, not eyeballed: min pairwise CIEDE2000 across normal
// vision and all three colourblindness types is 13.6 on fills. If you change one,
// re-run palette-check.py at the repo root. See PLAN.md "Theme".

export const c = {
  bg: '#FDFBF9',       // warm off-white, never pure white
  surface: '#FFFFFF',
  border: '#EFE8E2',
  text: '#3A3532',     // warm near-black, never #000
  muted: '#8C837C',
  accent: '#E8877D',
  danger: '#B3261E',
  warnBg: '#FDECEA',
};

// fill = large areas (timeline blocks, buttons). ink = small marks (dots,
// strokes, coloured text). A pastel dot on an off-white page is invisible:
// bottle's fill is 1.16:1 against bg, its ink is 4.50:1.
export const types = {
  nurse:  { fill: '#F2B7C4', ink: '#9C3E5B', label: 'Nurse',  icon: '🤱' },
  bottle: { fill: '#FCE9C1', ink: '#897230', label: 'Bottle', icon: '🍼' },
  diaper: { fill: '#9CB981', ink: '#225D00', label: 'Diaper', icon: '💩' },
  pump:   { fill: '#D8D3FF', ink: '#6361A7', label: 'Pump',   icon: '🥛' },
  sleep:  { fill: '#79A2D8', ink: '#004DA1', label: 'Sleep',  icon: '🌙' },
  other:  { fill: '#CFC6BE', ink: '#6A5D50', label: 'Other',  icon: '📝' },
};

// An event's type on the wire is not always its visual type: a bottle feed and a
// nursing feed are both `feed`.
export function styleFor(event) {
  if (event.type === 'feed') {
    return event.payload?.method === 'bottle' ? types.bottle : types.nurse;
  }
  return types[event.type] || types.other;
}

// What to call an event in a list. A free-form event carries its own title --
// "Vitamin D" is the whole point of logging it, and "Other" is not.
export function titleFor(event) {
  return event.payload?.label || styleFor(event).label;
}

export const radius = 14;
export const space = 16;
