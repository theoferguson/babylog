import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Events } from '../../src/api';
import Bars, { Stat } from '../../src/Bars';
import { cached } from '../../src/cache';
import { addDays, dayBounds, todayKey } from '../../src/days';
import { volume } from '../../src/format';
import OfflineBar from '../../src/OfflineBar';
import { useSession } from '../../src/session';
import { summary } from '../../src/stats';
import { c, space, types } from '../../src/theme';
import { ErrorNote, s } from '../../src/ui';

const RANGES = [7, 14, 30];

export default function Insights() {
  const { household } = useSession();
  const units = household?.units || 'metric';
  const tz = household?.timezone || 'UTC';

  const [days, setDays] = useState(7);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    try {
      const end = todayKey(tz);
      const { since } = dayBounds(addDays(end, -(days - 1)), tz);
      const r = await cached(`insights:${days}`, () =>
        Events.list({ since: since.toISOString(), limit: 1000 }));
      setEvents(r.data.results || r.data || []);
      setStale(r.stale);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [days, tz]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const st = useMemo(
    () => summary(events, tz, days, todayKey(tz)),
    [events, tz, days],
  );

  const series = (pick) =>
    st.per.map((d) => ({
      key: d.key,
      value: pick(d),
      label: new Date(`${d.key}T12:00:00Z`).toLocaleDateString([], { month: 'numeric', day: 'numeric' }),
    }));

  const nightShare = st.totalFeeds
    ? Math.round((st.nightFeeds / st.totalFeeds) * 100)
    : 0;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, paddingBottom: 48 }}>
      <View style={[s.row, { gap: 8 }]}>
        {RANGES.map((n) => (
          <Pressable
            key={n}
            onPress={() => setDays(n)}
            accessibilityRole="button"
            accessibilityState={{ selected: days === n }}
            style={{
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
              backgroundColor: days === n ? c.accent : c.surface,
              borderWidth: 1, borderColor: days === n ? c.accent : c.border,
            }}
          >
            <Text style={{ color: days === n ? '#FFF' : c.text, fontWeight: '600' }}>{n}d</Text>
          </Pressable>
        ))}
      </View>

      <OfflineBar stale={stale} onFlushed={load} />
      <ErrorNote error={error} />

      {st.activeDays === 0 ? (
        <Text style={[s.muted, { marginTop: space }]}>No events in this range yet.</Text>
      ) : (
        <>
          <Text style={[s.muted, { marginTop: 12 }]}>
            {st.activeDays} day{st.activeDays === 1 ? '' : 's'} with data. Averages use those days
            only.
          </Text>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            <Stat label="Feeds / day" value={st.avgFeeds.toFixed(1)} />
            <Stat
              label="Typical gap"
              value={st.medianIntervalMin ? fmtGap(st.medianIntervalMin) : '—'}
              hint="median, feed to feed"
            />
            <Stat label="Nursing / day" value={`${Math.round(st.avgNursingMin)}m`} />
            <Stat label="Diapers / day" value={st.avgDiapers.toFixed(1)} />
            <Stat label="Night feeds" value={`${nightShare}%`} hint="7pm–7am" />
            <Stat label="Pumped" value={volume(st.totalPumpedMl, units) || '—'} hint="range total" />
          </View>

          <Bars title="Feeds per day" data={series((d) => d.feeds)} color={types.nurse.ink} />
          <Bars title="Nursing minutes per day" data={series((d) => d.nursingMin)}
                color={types.nurse.ink} unit="m" />
          <Bars title="Diapers per day" data={series((d) => d.diapers)} color={types.diaper.ink} />
          <Bars
            title={`Pumped per day (${units === 'imperial' ? 'oz' : 'ml'})`}
            data={series((d) => d.pumpedMl)}
            color={types.pump.ink}
            format={(v) => volume(v, units) || '0'}
          />
          {st.per.some((d) => d.sleepMin) ? (
            <Bars title="Sleep minutes per day" data={series((d) => d.sleepMin)}
                  color={types.sleep.ink} unit="m" />
          ) : (
            <Text style={[s.muted, { marginTop: 20 }]}>
              Sleep charts appear once you start logging sleep — that history is also what nap
              predictions will need.
            </Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

function fmtGap(min) {
  const h = Math.floor(min / 60);
  return h ? `${h}h ${Math.round(min % 60)}m` : `${Math.round(min)}m`;
}
