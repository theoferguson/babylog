import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { Events, deviceTz } from '../src/api';
import { clock } from '../src/format';
import { useSession } from '../src/session';
import { c, space, types } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';
import { useActiveEvents, useNow } from '../src/useActive';

// A sleep is one stretch with a start and an end -- no sides, nothing to bank
// between taps -- so the server's generic `finish` closes it and none of the
// nursing screen's timer-intent machinery is needed. Like a feed it lives on
// the server, which is what lets one parent start it and the other stop it.
//
// ponytail: online only, no offline shadow timer. Add the localTimer path from
// nurse.js if starting a sleep out of signal turns out to matter.
export default function Sleep() {
  const router = useRouter();
  const { babyId } = useSession();
  const { events, skewMs, loaded, refresh } = useActiveEvents();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState('');

  const running =
    events.find((e) => e.type === 'sleep' && (!babyId || e.baby === babyId)) || null;
  const now = useNow(!!running) + skewMs;
  const secs = running
    ? Math.max(0, Math.round((now - new Date(running.started_at).getTime()) / 1000))
    : 0;

  const guard = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // createDirect, not create: a queued create would leave an in_progress event
  // with nothing to finish it.
  const start = () => guard(() => Events.createDirect({
    baby: babyId,
    type: 'sleep',
    started_at: new Date().toISOString(),
    tz: deviceTz(),
    in_progress: true,
    payload: {},
  }));

  const stop = () => guard(async () => {
    if (notes.trim()) await Events.update(running.id, { notes });
    await Events.finish(running.id);
    router.back();
  });

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 14 }}>
      <View
        style={[s.card, {
          alignItems: 'center', paddingVertical: 40,
          backgroundColor: running ? types.sleep.fill : c.surface,
          borderColor: running ? types.sleep.fill : c.border,
        }]}
      >
        <Text style={{ fontSize: 34, fontWeight: '800', color: c.text }}>
          {running ? clock(secs) : types.sleep.icon}
        </Text>
        <Text style={{ fontSize: 15, color: c.text, marginTop: 6 }}>
          {running ? 'Sleeping' : loaded ? 'Not sleeping' : 'Checking…'}
        </Text>
      </View>

      {running ? (
        <>
          <TextInput
            style={[s.input, { minHeight: 56, textAlignVertical: 'top' }]}
            placeholder="Notes (optional)"
            placeholderTextColor={c.muted}
            multiline
            value={notes}
            onChangeText={setNotes}
          />
          <Button title={busy ? 'Saving…' : 'Woke up'} onPress={stop} disabled={busy} />
        </>
      ) : (
        <Button
          title={busy ? 'Starting…' : 'Fell asleep'}
          onPress={start}
          disabled={busy || !loaded}
        />
      )}

      <ErrorNote error={error} />
    </ScrollView>
  );
}
