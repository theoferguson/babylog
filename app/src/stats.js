import { addDays, dayKey } from './days.js';

// All aggregation happens client-side over events already fetched. A week of
// this household is a few hundred rows; a server endpoint would be a second
// place for the same arithmetic to be wrong.

export const isNursing = (e) => e.type === 'feed' && e.payload?.method === 'breast';
export const isBottle = (e) => e.type === 'feed' && e.payload?.method === 'bottle';

// Group by the local day each event happened in, in its OWN recorded zone, so a
// travel day is not smeared across two columns.
export function byDay(events, tz, days, endKey) {
  const keys = Array.from({ length: days }, (_, i) => addDays(endKey, i - days + 1));
  const buckets = Object.fromEntries(keys.map((k) => [k, []]));
  for (const e of events) {
    const k = dayKey(e.started_at, e.tz || tz);
    if (buckets[k]) buckets[k].push(e);
  }
  return keys.map((key) => ({ key, events: buckets[key] }));
}

export function dayStats(events) {
  const feeds = events.filter((e) => e.type === 'feed');
  const nursing = feeds.filter(isNursing);
  return {
    feeds: feeds.length,
    nursingMin: Math.round(nursing.reduce((a, e) => a + (e.duration_sec || 0), 0) / 60),
    bottleMl: feeds.filter(isBottle).reduce((a, e) => a + (e.payload?.volume_ml || 0), 0),
    diapers: events.filter((e) => e.type === 'diaper').length,
    pees: events.filter((e) => e.type === 'diaper' && e.payload?.pee).length,
    poos: events.filter((e) => e.type === 'diaper' && e.payload?.poo).length,
    pumpedMl: events
      .filter((e) => e.type === 'pump')
      .reduce((a, e) => a + (e.payload?.left_ml || 0) + (e.payload?.right_ml || 0), 0),
    sleepMin: Math.round(
      events.filter((e) => e.type === 'sleep').reduce((a, e) => a + (e.duration_sec || 0), 0) / 60,
    ),
  };
}

// Median, not mean: one four-hour overnight gap would drag an average far from
// what the days actually look like.
export function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Minutes between the START of consecutive feeds -- that is the number parents
// mean by "how often is he eating", not the gap between end and next start.
// Gaps spanning a day boundary are kept: a 3am feed follows a midnight one.
export function feedIntervals(events) {
  const starts = events
    .filter((e) => e.type === 'feed')
    .map((e) => new Date(e.started_at).getTime())
    .sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < starts.length; i += 1) {
    out.push(Math.round((starts[i] - starts[i - 1]) / 60000));
  }
  return out;
}

// Nights are the hours parents care about separately. 7pm-7am local.
export const isNight = (e, tz) => {
  const h = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: e.tz || tz, hour: 'numeric', hour12: false })
      .format(new Date(e.started_at))
      .replace('24', '0'),
  );
  return h >= 19 || h < 7;
};

export function summary(events, tz, days, endKey) {
  const buckets = byDay(events, tz, days, endKey);
  const per = buckets.map((b) => ({ ...b, ...dayStats(b.events) }));
  // Only days that actually have data should shape an average.
  const active = per.filter((d) => d.events.length);
  const avg = (pick) =>
    active.length ? active.reduce((a, d) => a + pick(d), 0) / active.length : 0;
  const intervals = feedIntervals(events);
  return {
    per,
    activeDays: active.length,
    avgFeeds: avg((d) => d.feeds),
    avgNursingMin: avg((d) => d.nursingMin),
    avgDiapers: avg((d) => d.diapers),
    totalPumpedMl: per.reduce((a, d) => a + d.pumpedMl, 0),
    medianIntervalMin: median(intervals),
    nightFeeds: events.filter((e) => e.type === 'feed' && isNight(e, tz)).length,
    totalFeeds: events.filter((e) => e.type === 'feed').length,
  };
}
