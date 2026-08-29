import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Events } from '../src/api';
import { ago, clock, summarize } from '../src/format';
import { useSession } from '../src/session';
import { c, space, types } from '../src/theme';
import Timeline from '../src/Timeline';
import { ErrorNote, s } from '../src/ui';
import { useActiveEvents, useNow } from '../src/useActive';

const dayBounds = (d = new Date()) => {
  const from = new Date(d);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
};

export default function Home() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { household, babies, babyId, setBabyId, signOut } = useSession();
  const units = household?.units || 'metric';
  const { events: active, skewMs } = useActiveEvents();
  const [latest, setLatest] = useState({});
  const [today, setToday] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!babyId) return;
    setBusy(true);
    try {
      const { from, to } = dayBounds();
      const [l, t] = await Promise.all([
        Events.latest(),
        Events.list({ since: from.toISOString(), until: to.toISOString() }),
      ]);
      setLatest(l || {});
      setToday(t.results || t || []);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [babyId]);

  // Returning from a log screen does not remount this one, so refetch on focus.
  // Polling alone is not enough: it stops when nothing is running, so a feed
  // saved on the nurse screen would otherwise never appear here.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, active.length]),
  );

  const running = active[0];
  const now = useNow(!!running) + skewMs;

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

      <ErrorNote error={error} />

      <Text style={[s.h2, { marginTop: space * 1.5 }]}>Today</Text>
      {today.length === 0 && !busy ? (
        <Text style={[s.muted, { marginTop: 8 }]}>Nothing logged yet today.</Text>
      ) : (
        <Timeline events={today} units={units} onPress={(e) => e.in_progress && router.push('/nurse')} />
      )}
    </ScrollView>
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
        flexGrow: 1,
        flexBasis: '46%',
        backgroundColor: t.fill,
        borderRadius: 14,
        paddingVertical: 22,
        alignItems: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: 22 }}>{t.icon}</Text>
      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginTop: 4 }}>{t.label}</Text>
    </Pressable>
  );
}
