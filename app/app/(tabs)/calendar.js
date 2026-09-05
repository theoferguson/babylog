import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { registerScroller } from '../../src/scrollTop';
import { Events } from '../../src/api';
import { cached } from '../../src/cache';
import DayPicker from '../../src/DayPicker';
import { addDays, dayBounds, dayKey, label as dayLabel, todayKey } from '../../src/days';
import { summarize, timeOfDay } from '../../src/format';
import { weekLabel, weekOf } from '../../src/month';
import OfflineBar from '../../src/OfflineBar';
import { useSession } from '../../src/session';
import DayList from '../../src/DayList';
import { eventPath } from '../../src/routes';
import { c, space, styleFor } from '../../src/theme';
import Timeline from '../../src/Timeline';
import WeekView from '../../src/WeekView';
import { ErrorNote, s } from '../../src/ui';

// Day and week views over the same data, with a month picker so reaching last
// Tuesday is one tap rather than six.
export default function Calendar() {
  const scroller = useRef(null);
  useEffect(() => registerScroller('calendar', scroller), []);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { household } = useSession();
  const units = household?.units || 'metric';
  const tz = household?.timezone || 'UTC';

  const [day, setDay] = useState(() => todayKey(tz));
  const [mode, setMode] = useState('day'); // day | week | list
  const [picking, setPicking] = useState(false);
  const [events, setEvents] = useState([]);
  const [monthCounts, setMonthCounts] = useState({});
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(null);

  const week = useMemo(() => weekOf(day), [day]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // Fetch the whole week either way: the day view needs one day of it and
      // the week view needs all seven, so one request serves both and switching
      // modes costs nothing.
      const from = dayBounds(week[0], tz).since;
      const to = dayBounds(week[6], tz).until;
      const [wk, wide] = await Promise.all([
        cached(`week:${week[0]}`, () =>
          Events.list({ since: from.toISOString(), until: to.toISOString(), limit: 1000 })),
        // A wider window purely to dot the month picker.
        cached(`picker:${day.slice(0, 7)}`, () =>
          Events.list({
            since: dayBounds(addDays(day, -45), tz).since.toISOString(),
            until: dayBounds(addDays(day, 45), tz).until.toISOString(),
            limit: 2000,
          })),
      ]);
      setEvents(wk.data.results || wk.data || []);
      const counts = {};
      for (const e of wide.data.results || wide.data || []) {
        const k = dayKey(e.started_at, e.tz || tz);
        counts[k] = (counts[k] || 0) + 1;
      }
      setMonthCounts(counts);
      setStale(wk.stale || wide.stale);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [week, day, tz]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const byDay = useMemo(() => {
    const out = Object.fromEntries(week.map((k) => [k, []]));
    for (const e of events) {
      const k = dayKey(e.started_at, e.tz || tz);
      if (out[k]) out[k].push(e);
    }
    return out;
  }, [events, week, tz]);

  const dayEvents = byDay[day] || [];
  const isToday = day === todayKey(tz);
  const openEvent = (e) => router.push(eventPath(e));

  // The date and the mode toggle stay pinned while scrolling: a day of 20+
  // events scrolls the heading away, and a list of bare times then says nothing
  // about which day you are reading.
  return (
    <ScrollView
      ref={scroller}
      style={s.screen}
      contentContainerStyle={{ paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={c.muted} />}
      stickyHeaderIndices={[0]}
    >
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: space,
          paddingBottom: 10,
          backgroundColor: c.bg,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
        }}
      >
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Pressable onPress={() => setPicking(true)} accessibilityRole="button"
                   accessibilityLabel="Choose a date"
                   style={[s.row, { gap: 6 }]}>
          <Text style={s.h1}>{mode === 'week' ? weekLabel(week) : dayLabel(day, tz)}</Text>
          <Text style={{ fontSize: 14, color: c.muted }}>▾</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/settings')} accessibilityRole="button">
          <Text style={s.muted}>Settings</Text>
        </Pressable>
      </View>

      <View style={[s.row, { gap: 8, marginTop: 10 }]}>
        {[['day', 'Day'], ['week', 'Week'], ['list', 'List']].map(([v, label]) => (
          <Pressable
            key={v}
            onPress={() => setMode(v)}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === v }}
            style={{
              paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999,
              backgroundColor: mode === v ? c.accent : c.surface,
              borderWidth: 1, borderColor: mode === v ? c.accent : c.border,
            }}
          >
            <Text style={{ color: mode === v ? '#FFF' : c.text, fontWeight: '600' }}>{label}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => setDay(addDays(day, mode === 'week' ? -7 : -1))} hitSlop={10}
                   accessibilityRole="button" accessibilityLabel="Previous">
          <Text style={{ fontSize: 22, color: c.muted }}>‹</Text>
        </Pressable>
        <Pressable
          onPress={() => setDay(addDays(day, mode === 'week' ? 7 : 1))}
          hitSlop={10}
          disabled={isToday}
          accessibilityRole="button"
          accessibilityLabel="Next"
        >
          <Text style={{ fontSize: 22, color: isToday ? c.border : c.muted }}>›</Text>
        </Pressable>
      </View>
      </View>

      <View style={{ paddingHorizontal: space }}>
      <OfflineBar stale={stale} onFlushed={load} />
      <ErrorNote error={error} />

      {mode === 'week' ? (
        <WeekView
          days={week}
          eventsByDay={byDay}
          tz={tz}
          selected={day}
          onPickDay={(k) => { setDay(k); setMode('day'); }}
          onPressEvent={openEvent}
        />
      ) : dayEvents.length === 0 && !busy ? (
        <Text style={[s.muted, { marginTop: 16 }]}>Nothing logged on this day.</Text>
      ) : mode === 'day' ? (
        <>
          <Rollup events={dayEvents} units={units} />
          <Timeline events={dayEvents} units={units} tz={tz} onPress={openEvent} />
        </>
      ) : (
        <>
          <Rollup events={dayEvents} units={units} />
          <DayList events={dayEvents} units={units} onPress={openEvent}
                   label={dayLabel(day, tz)} />
        </>
      )}

      </View>

      <DayPicker
        visible={picking}
        selected={day}
        tz={tz}
        counts={monthCounts}
        onPick={setDay}
        onClose={() => setPicking(false)}
      />
    </ScrollView>
  );
}

function Rollup({ events, units }) {
  const feeds = events.filter((e) => e.type === 'feed');
  const mins = Math.round(
    feeds.filter((e) => e.payload?.method === 'breast')
      .reduce((a, e) => a + (e.duration_sec || 0), 0) / 60,
  );
  const diapers = events.filter((e) => e.type === 'diaper').length;
  const pumped = events.filter((e) => e.type === 'pump')
    .reduce((a, e) => a + (e.payload?.left_ml || 0) + (e.payload?.right_ml || 0), 0);
  if (!events.length) return null;
  return (
    <Text style={[s.muted, { marginTop: 10 }]}>
      {feeds.length} feeds{mins ? ` · ${mins}m nursing` : ''} · {diapers} diapers
      {pumped ? ` · ${Math.round(pumped)}ml pumped` : ''}
    </Text>
  );
}

