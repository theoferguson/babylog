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

// The typical gap over the last few days, for the "next feed" banner. Recent
// days only, because the gap grows week to week and a month-old median would
// keep calling feeds early. Null until there are enough feeds to trust.
const LEARN_HOURS = 72;
const LEARN_MIN_GAPS = 5;
export function learnedInterval(events, now = Date.now()) {
  const recent = events.filter(
    (e) => new Date(e.started_at).getTime() >= now - LEARN_HOURS * 3600000);
  const gaps = feedIntervals(recent);
  return gaps.length >= LEARN_MIN_GAPS ? median(gaps) : null;
}

// What Auto falls back to before there is anything to learn from. Matches the
// server's default for a household that never picked a gap.
export const DEFAULT_FEED_MIN = 180;

// Nights are the hours parents care about separately: [from, to) in local
// hours, 7pm-7am unless the viewer picks another window.
export const NIGHT = [19, 7];
// One formatter per zone: building them is slow on Hermes, and this runs per
// feed every time the night window changes.
const hourFmts = new Map();
const hourIn = (tz) => {
  if (!hourFmts.has(tz)) {
    hourFmts.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
  }
  return hourFmts.get(tz);
};
export const isNight = (e, tz, [from, to] = NIGHT) => {
  const h = Number(hourIn(e.tz || tz).format(new Date(e.started_at)).replace('24', '0'));
  return from > to ? h >= from || h < to : h >= from && h < to;
};

// `endKey` is today, which is still in progress: its bar is drawn, but it stays
// out of the averages, or a 9am "today" with three feeds drags every per-day
// number down each morning. It only counts when it is the only day there is.
export function summary(events, tz, days, endKey, night = NIGHT) {
  const buckets = byDay(events, tz, days, endKey);
  const per = buckets.map((b) => ({ ...b, ...dayStats(b.events) }));
  // Only days that actually have data should shape an average.
  const active = per.filter((d) => d.events.length);
  const complete = active.filter((d) => d.key !== endKey);
  const basis = complete.length ? complete : active;
  const avg = (pick) =>
    basis.length ? basis.reduce((a, d) => a + pick(d), 0) / basis.length : 0;
  const feeds = events.filter((e) => e.type === 'feed');
  return {
    per,
    activeDays: active.length,
    avgDays: basis.length,
    avgFeeds: avg((d) => d.feeds),
    avgNursingMin: avg((d) => d.nursingMin),
    avgBottleMl: avg((d) => d.bottleMl),
    avgDiapers: avg((d) => d.diapers),
    avgPees: avg((d) => d.pees),
    avgPoos: avg((d) => d.poos),
    totalPumpedMl: per.reduce((a, d) => a + d.pumpedMl, 0),
    medianIntervalMin: median(feedIntervals(events)),
    nightFeeds: feeds.filter((e) => isNight(e, tz, night)).length,
    totalFeeds: feeds.length,
  };
}
