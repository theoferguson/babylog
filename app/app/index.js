import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Events } from '../src/api';
import { cached } from '../src/cache';
import OfflineBar from '../src/OfflineBar';
import { flush } from '../src/outbox';
import { addDays, dayBounds, dayKey, label as dayLabel, todayKey } from '../src/days';
import { ago, summarize, timeOfDay } from '../src/format';
import { useSession } from '../src/session';
import { c, space, styleFor, types } from '../src/theme';
import Timeline from '../src/Timeline';
import WeekStrip from '../src/WeekStrip';
import { ErrorNote, s } from '../src/ui';
import { useActiveEvents, useNow } from '../src/useActive';
import { clock } from '../src/format';

export default function Home() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { household, babies, babyId, setBabyId, signOut } = useSession();
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

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // Anything queued while offline goes up before we read, so the screen
      // does not show a stale server view that omits your own writes.
      await flush();
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

  const running = active[0];
  const now = useNow(!!running) + skewMs;
  const isToday = day === todayKey(tz);

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
          <Pressable onPress={() => router.push('/insights')} accessibilityRole="button">
            <Text style={s.muted}>Insights</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/import')} accessibilityRole="button">
            <Text style={s.muted}>Import</Text>
          </Pressable>
          <Pressable onPress={signOut} accessibilityRole="button">
            <Text style={s.muted}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      {running ? (
        <RunningBanner event={running} now={now} onPress={() => router.push('/nurse')} />
      ) : (
        <Summary latest={latest} units={units} />
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: space }}>
        <LogButton t={types.nurse} onPress={() => router.push('/nurse')} />
        <LogButton t={types.bottle} onPress={() => router.push('/log/bottle')} />
        <LogButton t={types.diaper} onPress={() => router.push('/log/diaper')} />
        <LogButton t={types.pump} onPress={() => router.push('/log/pump')} />
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
                  onPress={(e) => router.push(e.in_progress ? '/nurse' : `/event/${e.id}`)} />
      ) : (
        <DayList events={events} units={units} router={router} />
      )}
    </ScrollView>
  );
}

function DayList({ events, units, router }) {
  const rows = [...events].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  return (
    <View style={{ marginTop: 8 }}>
      {rows.map((e) => {
        const t = styleFor(e);
        return (
          <Pressable
            key={e.id}
            onPress={() => router.push(e.in_progress ? '/nurse' : `/event/${e.id}`)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <View style={{ width: 8, height: 32, borderRadius: 4, backgroundColor: t.ink }} />
            <Text style={{ fontSize: 15 }}>{t.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '700', color: c.text }}>
                {t.label}
                {e.in_progress ? ' · running' : ''}
              </Text>
              <Text style={s.muted}>{summarize(e, units) || '—'}</Text>
            </View>
            <Text style={s.muted}>{timeOfDay(e.started_at)}</Text>
          </Pressable>
        );
      })}
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

function RunningBanner({ event, now, onPress }) {
  const p = event.payload || {};
  const live = p.running_since
    ? Math.round((now - new Date(p.running_since).getTime()) / 1000)
    : 0;
  const total = (p.right_sec || 0) + (p.left_sec || 0) + live;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[s.card, { marginTop: space, backgroundColor: types.nurse.fill, borderColor: types.nurse.fill }]}
    >
      <Text style={[s.h2, { color: c.text }]}>
        {types.nurse.icon} Nursing · {clock(total)}
      </Text>
      <Text style={{ color: c.text, marginTop: 4 }}>
        {p.running_side ? `${p.running_side} side running` : 'Paused'} — tap to open
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
