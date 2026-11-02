import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Events } from '../../src/api';
import Bars, { Stat } from '../../src/Bars';
import { cached } from '../../src/cache';
import { addDays, dayBounds, todayKey } from '../../src/days';
import { gapLabel, volume } from '../../src/format';
import OfflineBar from '../../src/OfflineBar';
import { registerScroller } from '../../src/scrollTop';
import { useSession } from '../../src/session';
import { NIGHT, summary } from '../../src/stats';
import { space, types } from '../../src/theme';
import { Segmented, ErrorNote, s } from '../../src/ui';

const RANGES = [7, 14, 30];
// What counts as night is a family's own call, so the window is pickable. It is
// a viewing preference, kept on this device rather than on the household.
const NIGHTS = [[18, 6], [19, 7], [20, 6], [21, 7], [22, 6]];
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
const nightLabel = ([from, to]) => `${hourLabel(from)}–${hourLabel(to)}`;
const NIGHT_KEY = 'babylog.nightWindow';

export default function Insights() {
  const scroller = useRef(null);
  useEffect(() => registerScroller('insights', scroller), []);
  const { household } = useSession();
  const units = household?.units || 'metric';
  const tz = household?.timezone || 'UTC';

  const [days, setDays] = useState(7);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);
  const [night, setNight] = useState(NIGHT);

  useEffect(() => {
    AsyncStorage.getItem(NIGHT_KEY).then((v) => {
      const saved = NIGHTS.find((n) => nightLabel(n) === v);
      if (saved) setNight(saved);
    }).catch(() => { /* keep the default */ });
  }, []);
  const pickNight = (n) => {
    setNight(n);
    AsyncStorage.setItem(NIGHT_KEY, nightLabel(n)).catch(() => { /* still applies this session */ });
  };

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
    () => summary(events, tz, days, todayKey(tz), night),
    [events, tz, days, night],
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
    <ScrollView ref={scroller} style={s.screen} contentContainerStyle={{ padding: space, paddingBottom: 48 }}>
      <Segmented options={RANGES} selected={days} onPick={setDays} label={(n) => `${n}d`} />

      <OfflineBar stale={stale} onFlushed={load} />
      <ErrorNote error={error} />

      {st.activeDays === 0 ? (
        <Text style={[s.muted, { marginTop: space }]}>No events in this range yet.</Text>
      ) : (
        <>
          <Text style={[s.muted, { marginTop: 12 }]}>
            {st.activeDays} day{st.activeDays === 1 ? '' : 's'} with data. Averages use
            {st.avgDays < st.activeDays ? ' those days except today, which is not over yet.' : ' those days only.'}
          </Text>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            <Stat label="Feeds / day" value={st.avgFeeds.toFixed(1)} />
            <Stat
              label="Typical gap"
              value={st.medianIntervalMin ? gapLabel(st.medianIntervalMin) : '—'}
              hint="median, feed to feed"
            />
            <Stat label="Nursing / day" value={`${Math.round(st.avgNursingMin)}m`} />
            {st.avgBottleMl ? (
              <Stat label="Bottle / day" value={volume(st.avgBottleMl, units)} />
            ) : null}
            <Stat
              label="Diapers / day"
              value={st.avgDiapers.toFixed(1)}
              hint={`${st.avgPees.toFixed(1)} wet · ${st.avgPoos.toFixed(1)} dirty`}
            />
            <Stat label="Night feeds" value={`${nightShare}%`} hint={nightLabel(night)} />
            <Stat label="Pumped" value={volume(st.totalPumpedMl, units) || '—'} hint="range total" />
          </View>

          <Bars title="Feeds per day" data={series((d) => d.feeds)} color={types.nurse.ink} />
          <Bars title="Nursing minutes per day" data={series((d) => d.nursingMin)}
                color={types.nurse.ink} unit="m" />
          {st.avgBottleMl ? (
            <Bars
              title={`Bottle per day (${units === 'imperial' ? 'oz' : 'ml'})`}
              data={series((d) => d.bottleMl)}
              color={types.bottle.ink}
              format={(v) => volume(v, units) || '0'}
            />
          ) : null}
          <Bars title="Wet diapers per day" data={series((d) => d.pees)} color={types.diaper.ink} />
          <Bars title="Dirty diapers per day" data={series((d) => d.poos)} color={types.diaper.ink} />
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

          <Text style={[s.body, { marginTop: 24 }]}>Count as night</Text>
          <Segmented options={NIGHTS} selected={night} onPick={pickNight} label={nightLabel}
                   style={{ marginTop: 8 }} />
        </>
      )}
    </ScrollView>
  );
}
