import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Events, deviceTz } from '../src/api';
import { clock } from '../src/format';
import { useSession } from '../src/session';
import { c, space, types } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';
import { useActiveEvents, useNow } from '../src/useActive';

// The running timer belongs to the household, not this phone: it is an Event
// with ended_at null, created on the FIRST tap. Either parent can start, stop,
// edit and save it, and both see it live. The server owns the accumulators --
// this screen only ever sends intents.
export default function Nurse() {
  const router = useRouter();
  const { babyId } = useSession();
  const { events, skewMs, refresh } = useActiveEvents();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);

  const event = events.find((e) => e.type === 'feed') || null;
  const p = event?.payload || {};
  const now = useNow(!!p.running_side) + skewMs;

  useEffect(() => {
    // Don't stomp what the other parent is typing, or what you typed here.
    if (event && !notesDirty) setNotes(event.notes || '');
  }, [event, notesDirty]);

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

  const tapSide = (side) =>
    guard(async () => {
      if (!event) {
        const created = await Events.create({
          baby: babyId,
          type: 'feed',
          started_at: new Date().toISOString(),
          tz: deviceTz(),
          in_progress: true,
          payload: { method: 'breast' },
        });
        await Events.tick(created.id, 'start', side);
        return;
      }
      // Tapping the running side stops it; tapping the other switches.
      if (p.running_side === side) await Events.tick(event.id, 'stop');
      else await Events.tick(event.id, 'start', side);
    });

  const save = () =>
    guard(async () => {
      if (notesDirty) await Events.update(event.id, { notes });
      await Events.finish(event.id);
      router.back();
    });

  const discard = () => {
    const go = () => guard(async () => {
      await Events.remove(event.id);
      router.back();
    });
    if (typeof window !== 'undefined' && window.confirm) {
      if (window.confirm('Discard this feed? It will not be saved.')) go();
      return;
    }
    Alert.alert('Discard this feed?', 'It will not be saved.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: go },
    ]);
  };

  const liveSecs = p.running_since
    ? Math.max(0, Math.round((now - new Date(p.running_since).getTime()) / 1000))
    : 0;
  const secsFor = (side) => {
    const banked = (side === 'R' ? p.right_sec : p.left_sec) || 0;
    return banked + (p.running_side === side ? liveSecs : 0);
  };
  const total = secsFor('R') + secsFor('L');

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 14 }}>
      <Text style={[s.h1, { textAlign: 'center' }]}>{clock(total)}</Text>
      <Text style={[s.muted, { textAlign: 'center' }]}>
        {!event
          ? 'Tap a side to start'
          : p.running_side
            ? `${p.running_side} side running`
            : 'Paused — tap a side, or save'}
      </Text>

      <View style={[s.row, { gap: 12 }]}>
        {['L', 'R'].map((side) => (
          <SideButton
            key={side}
            side={side}
            secs={secsFor(side)}
            running={p.running_side === side}
            disabled={busy}
            onPress={() => tapSide(side)}
          />
        ))}
      </View>

      {p.last_side && !p.running_side ? (
        <Text style={[s.muted, { textAlign: 'center' }]}>
          Last side: {p.last_side} — start on {p.last_side === 'L' ? 'R' : 'L'} next
        </Text>
      ) : null}

      {event ? (
        <>
          <TextInput
            style={[s.input, { minHeight: 64, textAlignVertical: 'top' }]}
            placeholder="Notes (optional)"
            placeholderTextColor={c.muted}
            multiline
            value={notes}
            onChangeText={(t) => {
              setNotes(t);
              setNotesDirty(true);
            }}
          />
          <Button title={busy ? 'Saving…' : 'Save feed'} onPress={save} disabled={busy} />
          <Button title="Discard" tone="plain" onPress={discard} disabled={busy} />
        </>
      ) : null}

      <ErrorNote error={error} />
    </ScrollView>
  );
}

function SideButton({ side, secs, running, disabled, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: running }}
      accessibilityLabel={`${side === 'L' ? 'Left' : 'Right'} side, ${Math.round(secs / 60)} minutes${running ? ', running' : ''}`}
      style={({ pressed }) => ({
        flex: 1,
        backgroundColor: running ? types.nurse.ink : types.nurse.fill,
        borderRadius: 20,
        paddingVertical: 40,
        alignItems: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: 34, fontWeight: '800', color: running ? '#FFF' : c.text }}>
        {side}
      </Text>
      <Text style={{ fontSize: 15, color: running ? '#FFF' : c.text, marginTop: 6 }}>
        {clock(secs)}
      </Text>
      {/* Colour alone must not carry "which side is running". */}
      <Text style={{ fontSize: 12, color: running ? '#FFF' : c.muted, marginTop: 2 }}>
        {running ? '● running' : 'tap to start'}
      </Text>
    </Pressable>
  );
}
