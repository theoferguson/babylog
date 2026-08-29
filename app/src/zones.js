// A full IANA list is ~600 entries and Hermes does not ship
// Intl.supportedValuesOf, so offer the device's own zone plus the ones this
// household plausibly travels to, and never lose a value already set.
const COMMON = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Mexico_City',
  'Europe/London', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'Europe/Rome', 'Europe/Athens', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Dubai',
  'Australia/Sydney', 'UTC',
];

export function zoneOptions(current) {
  let device = 'UTC';
  try {
    device = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    /* keep UTC */
  }
  let all = COMMON;
  try {
    if (typeof Intl.supportedValuesOf === 'function') all = Intl.supportedValuesOf('timeZone');
  } catch {
    /* the curated list is the fallback */
  }
  return [...new Set([device, current, ...all].filter(Boolean))];
}

export function offsetLabel(zone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}
