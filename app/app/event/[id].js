import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { Events } from '../../src/api';
import DateTimeField from '../../src/DateTimeField';
import EventFields from '../../src/EventFields';
import { useSession } from '../../src/session';
import { c, space, styleFor, titleFor } from '../../src/theme';
import { Button, ErrorNote, s } from '../../src/ui';

// Every event on the calendar opens here. One editor for all types rather than a
// second set of screens, because the payload differs but the shape does not.
export default function EditEvent() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const { household } = useSession();
  const units = household?.units || 'metric';

  const [event, setEvent] = useState(null);
  const [payload, setPayload] = useState({});
  const [notes, setNotes] = useState('');
  const [startedAt, setStartedAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const e = await Events.get(id);
        setEvent(e);
        setPayload(e.payload || {});
        setNotes(e.notes || '');
        setStartedAt(new Date(e.started_at));
      } catch (err) {
        setError(err);
      }
    })();
  }, [id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await Events.update(id, { payload, notes, started_at: startedAt.toISOString() });
      router.back();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const remove = () => {
    const go = async () => {
      setBusy(true);
      try {
        await Events.remove(id);
        router.back();
      } catch (e) {
        setError(e);
        setBusy(false);
      }
    };
    const msg = 'Delete this event? It will disappear on both phones.';
    if (Platform.OS === 'web') {
      if (window.confirm(msg)) go();
      return;
    }
    Alert.alert('Delete event?', msg, [
      { text: 'Keep', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: go },
    ]);
  };

  if (!event) {
    return (
      <View style={[s.screen, s.pad]}>
        <ErrorNote error={error} />
        {!error ? <Text style={s.muted}>Loading...</Text> : null}
      </View>
    );
  }

  const t = styleFor(event);
  const setP = (patch) => setPayload((p) => ({ ...p, ...patch }));
  const shift = (m) => setStartedAt((d) => new Date(d.getTime() + m * 60000));
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 14 }}>
      <Text style={s.h2}>
        {t.icon} {titleFor({ ...event, payload })}
      </Text>

      <View style={{ gap: 8 }}>
        <Text style={s.h2}>When</Text>
        <Text style={[s.body, { fontWeight: '700' }]}>
          {startedAt.toLocaleString([], {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
          })}
        </Text>
        <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
          {[-60, -15, -5, 5, 15, 60].map((m) => (
            <Button
              key={m}
              title={m > 0 ? `+${m}m` : `${m}m`}
              tone="plain"
              onPress={() => shift(m)}
              style={{ paddingVertical: 8, paddingHorizontal: 12 }}
            />
          ))}
        </View>
        <DateTimeField value={startedAt} onChange={setStartedAt} />
        {event.tz && event.tz !== household?.timezone ? (
          <Text style={s.muted}>Recorded in {event.tz}</Text>
        ) : null}
      </View>

      <EventFields type={event.type} payload={payload} setP={setP} units={units} />

      <View style={{ gap: 6 }}>
        <Text style={s.body}>Notes</Text>
        <TextInput
          style={[s.input, { minHeight: 56, textAlignVertical: 'top' }]}
          multiline value={notes} onChangeText={setNotes}
          placeholder="-" placeholderTextColor={c.muted}
        />
      </View>

      <Button title={busy ? 'Saving...' : 'Save changes'} onPress={save} disabled={busy} />
      <Button title="Delete" tone="plain" onPress={remove} disabled={busy} />
      <ErrorNote error={error} />
    </ScrollView>
  );
}

