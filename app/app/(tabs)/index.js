import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { registerScroller } from '../../src/scrollTop';
import { Events } from '../../src/api';
import { cached } from '../../src/cache';
import DayList from '../../src/DayList';
import MicButton from '../../src/MicButton';
import OfflineBar from '../../src/OfflineBar';
import { flush } from '../../src/outbox';
import { eventPath } from '../../src/routes';
import { addDays, dayBounds, dayKey, label as dayLabel, todayKey } from '../../src/days';
import { ago, clock, countdown, summarize, timeOfDay } from '../../src/format';
import { useSession } from '../../src/session';
import * as localTimer from '../../src/localTimer';
import { c, space, styleFor, titleFor, types } from '../../src/theme';
import Timeline from '../../src/Timeline';
import WeekStrip from '../../src/WeekStrip';
import { ErrorNote, s } from '../../src/ui';
import { useActiveEvents, useNow } from '../../src/useActive';

export default function Home() {
  const scroller = useRef(null);
  useEffect(() => registerScroller('index', scroller), []);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { household, babies, babyId, setBabyId } = useSession();
  const units = household?.units || 'metric';
  const tz = household?.timezone || 'UTC';

  const { events: active, skewMs } = useActiveEvents();
  const [day, setDay] = useState(() => todayKey(tz));
  const [view, setView] = useState('timeline');
  const [latest, setLatest] = useState({});
  const [events, setEvents] = useState([]);
  const [week, setWeek] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  // A timer started with no connection lives only on this device, so the server
  // cannot report it. Without this it would be invisible here -- the moment you
  // most want reassurance it is still counting.
  const [offlineTimer, setOfflineTimer] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // Anything queued while offline goes up before we read, so the screen
      // does not show a stale server view that omits your own writes.
      await flush();
      setOfflineTimer(await localTimer.load());
      const { since, until } = dayBounds(day, tz);
      // One week query feeds both the strip's density dots and the day list.
      const wk = dayBounds(addDays(todayKey(tz), -6), tz);
      const [l, d, w] = await Promise.all([
        cached('latest', () => Events.latest()),
        cached(`day:${day}`, () =>
          Events.list({ since: since.toISOString(), until: until.toISOString() })),
        cached('week', () => Events.list({ since: wk.since.toISOString(), limit: 500 })),
      ]);
      setLatest(l.data || {});
      setEvents(d.data.results || d.data || []);
      const counts = {};
      for (const e of w.data.results || w.data || []) {
        const k = dayKey(e.started_at, e.tz || tz);
        counts[k] = (counts[k] || 0) + 1;
      }
      setWeek(counts);
      setStale(l.stale || d.stale || w.stale);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [day, tz]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, active.length]),
  );

  // Every running timer is shown, not just the first: two babies can nurse at
  // once, and a silently hidden timer is worse than no timer.
  const remoteIds = new Set(active.map((e) => e.id));
  const banners = [
    ...active.map((e) => ({ key: e.id, state: fromEvent(e), event: e, offline: false })),
    // ...unless this device is shadowing one of them locally.
    ...(offlineTimer && !remoteIds.has(offlineTimer.remoteId)
      ? [{ key: 'local', state: offlineTimer, event: null, offline: true }]
      : []),
  ];
  const anyRunning = banners.some((b) => b.state.running_since);
  const now = useNow(anyRunning) + skewMs;
  const isToday = day === todayKey(tz);

  // Voice logging: parse, then hand the draft to the review screen. This
  // screen never writes -- it does not even know what came back.
  const speak = useCallback(async (text) => {
    setBusy(true);
    setError(null);
    try {
      const body = await Events.parse(text);
      if (!body.events?.length) {
        setError(new Error("Couldn't make an event out of that. Try again?"));
        return;
      }
      router.push({ pathname: '/review', params: { draft: JSON.stringify(body.events) } });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [router]);

  const rollup = useMemo(() => {
    const feeds = events.filter((e) => e.type === 'feed');
    const nursing = feeds.filter((e) => e.payload?.method === 'breast');
    const mins = Math.round(nursing.reduce((a, e) => a + (e.duration_sec || 0), 0) / 60);
    const pumped = events
      .filter((e) => e.type === 'pump')
      .reduce((a, e) => a + (e.payload?.left_ml || 0) + (e.payload?.right_ml || 0), 0);
    return {
      feeds: feeds.length,
      mins,
      diapers: events.filter((e) => e.type === 'diaper').length,
      pumped,
    };
  }, [events]);

  return (
    <ScrollView
      ref={scroller}
      style={s.screen}
      contentContainerStyle={{ padding: space, paddingTop: insets.top + 8, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={c.muted} />}
    >
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        {babies.length > 1 ? (
          <View style={[s.row, { gap: 8 }]}>
            {babies.map((b) => (
              <Pressable key={b.id} onPress={() => setBabyId(b.id)}>
                <Text style={[s.h1, { color: b.id === babyId ? c.text : c.muted }]}>{b.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={s.h1}>{babies[0]?.name || 'babylog'}</Text>
        )}
        <View style={[s.row, { gap: 16 }]}>
          <Pressable onPress={() => router.push('/import')} accessibilityRole="button">
            <Text style={s.muted}>Import</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/settings')} accessibilityRole="button">
            <Text style={s.muted}>Settings</Text>
          </Pressable>
        </View>
      </View>

      <NextFeed last={latest.feed} intervalMin={household?.feed_interval_min} />

      {banners.map((b) => (
        <RunningBanner
          key={b.key}
          state={b.state}
          event={b.event}
          offline={b.offline}
          babyName={babies.length > 1 ? babies.find((x) => x.id === b.event?.baby)?.name : null}
          now={now}
          onPress={() => router.push(b.event ? eventPath(b.event) : '/nurse')}
        />
      ))}
      {/* The summary stays visible alongside a running timer: "when did he last
          eat" is still the question, even mid-feed. */}
      <Summary latest={latest} units={units} />

      {/* One grid, so the mic's dead centre is the centre of the middle row --
          it sits in the gap between Diaper and Pump, smaller than either. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: space }}>
        <LogButton t={types.nurse} onPress={() => router.push('/nurse')} />
        <LogButton t={types.bottle} onPress={() => router.push('/log/bottle')} />
        <LogButton t={types.diaper} onPress={() => router.push('/log/diaper')} />
        <LogButton t={types.pump} onPress={() => router.push('/log/pump')} />
        <LogButton t={types.sleep} onPress={() => router.push('/sleep')} />
        <LogButton t={types.other} onPress={() => router.push('/log/custom')} />
        <MicButton busy={busy} onText={speak} />
      </View>

      <OfflineBar stale={stale} onFlushed={load} />
      <ErrorNote error={error} />

      <View style={{ marginTop: space * 1.5, gap: 10 }}>
        <WeekStrip tz={tz} selected={day} counts={week} onSelect={setDay} />

        <View style={[s.row, { justifyContent: 'space-between' }]}>
          <View style={[s.row, { gap: 12 }]}>
            <Pressable onPress={() => setDay(addDays(day, -1))} hitSlop={10} accessibilityRole="button"
                       accessibilityLabel="Previous day">
              <Text style={{ fontSize: 20, color: c.muted }}>‹</Text>
            </Pressable>
            <Text style={s.h2}>{dayLabel(day, tz)}</Text>
            <Pressable onPress={() => setDay(addDays(day, 1))} hitSlop={10} disabled={isToday}
                       accessibilityRole="button" accessibilityLabel="Next day">
              <Text style={{ fontSize: 20, color: isToday ? c.border : c.muted }}>›</Text>
            </Pressable>
          </View>
          <Pressable onPress={() => setView((v) => (v === 'timeline' ? 'list' : 'timeline'))}
                     accessibilityRole="button">
            <Text style={{ color: c.accent, fontWeight: '600' }}>
              {view === 'timeline' ? 'List' : 'Timeline'}
            </Text>
          </Pressable>
        </View>

        {events.length ? (
          <Text style={s.muted}>
            {rollup.feeds} feeds{rollup.mins ? ` · ${rollup.mins}m nursing` : ''} ·{' '}
            {rollup.diapers} diapers
            {rollup.pumped ? ` · ${Math.round(rollup.pumped)}ml pumped` : ''}
          </Text>
        ) : null}
      </View>

      {events.length === 0 && !busy ? (
        <Text style={[s.muted, { marginTop: 12 }]}>Nothing logged on this day.</Text>
      ) : view === 'timeline' ? (
        <Timeline events={events} units={units} tz={tz}
                  onPress={(e) => router.push(eventPath(e))} />
      ) : (
        <DayList events={events} units={units}
                 onPress={(e) => router.push(eventPath(e))} />
      )}
    </ScrollView>
  );
}


// When the next feed is expected. Measured from the last feed's START, so a
// long nursing session does not push the next one out by its own length.
function NextFeed({ last, intervalMin }) {
  // Its own slow tick: the shared one only runs while a timer does, and this
  // banner has to keep counting down on a screen left open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  if (!last || !intervalMin) return null;
  const due = new Date(new Date(last.started_at).getTime() + intervalMin * 60000);
  const overdue = due.getTime() <= now;
  return (
    <View
      style={[s.card, {
        marginTop: space, paddingVertical: 12,
        backgroundColor: overdue ? c.warnBg : c.surface,
        borderColor: overdue ? c.accent : c.border,
      }]}
    >
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.body}>{overdue ? 'Feed due' : 'Next feed'}</Text>
        <Text style={[s.body, { fontWeight: '700' }]}>
          {timeOfDay(due.toISOString())} · {countdown(due.toISOString(), now)}
        </Text>
      </View>
      <Text style={s.muted}>
        {Math.round(intervalMin / 60 * 10) / 10}h after the last feed started — change it in
        Settings.
      </Text>
    </View>
  );
}

function Summary({ latest, units }) {
  const rows = [
    ['feed', 'Last feed'],
    ['diaper', 'Last diaper'],
    ['pump', 'Last pump'],
  ].filter(([k]) => latest[k]);
  if (!rows.length) return null;
  return (
    <View style={[s.card, { marginTop: space, gap: 10 }]}>
      {rows.map(([k, label]) => {
        const e = latest[k];
        const detail = summarize(e, units);
        return (
          <View key={k}>
            <View style={[s.row, { justifyContent: 'space-between' }]}>
              <Text style={s.body}>{label}</Text>
              <Text style={[s.body, { fontWeight: '700' }]}>{ago(e.started_at)}</Text>
            </View>
            {detail ? <Text style={s.muted}>{detail}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

// Normalises a server event into the same shape the offline timer uses, so one
// banner renders both.
function fromEvent(e) {
  const p = e.payload || {};
  // A sleep has no sides and cannot be paused: it has been running since it
  // started, so the whole span is the elapsed time.
  if (e.type === 'sleep') {
    return {
      started_at: e.started_at, left_sec: 0, right_sec: 0,
      running_side: null, running_since: e.started_at, sleeping: true,
    };
  }
  return {
    started_at: e.started_at,
    right_sec: p.right_sec || 0,
    left_sec: p.left_sec || 0,
    running_side: p.running_side || null,
    running_since: p.running_since || null,
  };
}

function RunningBanner({ state, event, offline, babyName, now, onPress }) {
  const t = event ? styleFor(event) : types.nurse;
  // Time the timer actually ran, matching the nurse screen.
  const live = state.running_since
    ? Math.max(0, Math.round((now - new Date(state.running_since).getTime()) / 1000))
    : 0;
  const total = (state.right_sec || 0) + (state.left_sec || 0) + live;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${t.label} in progress, ${Math.round(total / 60)} minutes. Tap to open.`}
      style={[s.card, { marginTop: space, backgroundColor: t.fill, borderColor: t.fill }]}
    >
      <Text style={[s.h2, { color: c.text }]}>
        {t.icon} {babyName ? `${babyName} · ` : ''}{t.label} · {clock(total)}
      </Text>
      <Text style={{ color: c.text, marginTop: 4 }}>
        {state.sleeping ? 'Sleeping'
          : state.running_side ? `${state.running_side} side running` : 'Paused'}
        {offline ? ' · on this phone only' : ''} — tap to open
      </Text>
    </Pressable>
  );
}

function LogButton({ t, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Log ${t.label}`}
      style={({ pressed }) => ({
        flexGrow: 1, flexBasis: '46%', backgroundColor: t.fill, borderRadius: 14,
        paddingVertical: 22, alignItems: 'center', opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: 22 }}>{t.icon}</Text>
      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginTop: 4 }}>{t.label}</Text>
    </Pressable>
  );
}
