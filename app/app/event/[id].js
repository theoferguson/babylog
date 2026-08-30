import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { Events } from '../../src/api';
import DateTimeField from '../../src/DateTimeField';
import { Choice } from '../../src/InstantForm';
import { toMl, volume } from '../../src/format';
import { useSession } from '../../src/session';
import { c, space, styleFor } from '../../src/theme';
import { Button, ErrorNote, s } from '../../src/ui';

const SIZES = ['small', 'medium', 'large'].map((v) => ({ value: v, label: v }));

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
  const isBreast = event.type === 'feed' && payload.method === 'breast';

  // A nursing feed lasts as long as the timer ran. Nothing about the recorded
  // end constrains that, so the sides are free to be whatever they were.
  const sidesSec = (payload.right_sec || 0) + (payload.left_sec || 0);
  const durationMin = isBreast ? Math.round(sidesSec / 60) : null;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 14 }}>
      <Text style={s.h2}>
        {t.icon} {t.label}
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

      {event.type === 'diaper' ? (
        <>
          <Choice label="Pee" options={SIZES} value={payload.pee ?? null}
                  onChange={(v) => setP({ pee: v ?? undefined })} tint={t.fill} />
          <Choice label="Poo" options={SIZES} value={payload.poo ?? null}
                  onChange={(v) => setP({ poo: v ?? undefined })} tint={t.fill} />
        </>
      ) : null}

      {isBreast ? (
        <View style={[s.row, { gap: 12 }]}>
          {[['Left (min)', 'left_sec'], ['Right (min)', 'right_sec']].map(([label, key]) => (
            <View key={key} style={{ flex: 1, gap: 6 }}>
              <Text style={s.body}>{label}</Text>
              <TextInput
                style={s.input}
                keyboardType="number-pad"
                defaultValue={payload[key] ? String(Math.round(payload[key] / 60)) : ''}
                onChangeText={(v) => {
                  const n = parseInt(v, 10);
                  setP({ [key]: isFinite(n) ? n * 60 : undefined });
                }}
              />
            </View>
          ))}
        </View>
      ) : null}

      {event.type === 'feed' && payload.method === 'bottle' ? (
        <Num label={`Amount (${units === 'imperial' ? 'oz' : 'ml'})`} value={payload.volume_ml}
             units={units} onChange={(ml) => setP({ volume_ml: ml })} />
      ) : null}

      {event.type === 'pump' ? (
        <View style={[s.row, { gap: 12 }]}>
          <View style={{ flex: 1 }}>
            <Num label="Left" value={payload.left_ml} units={units}
                 onChange={(ml) => setP({ left_ml: ml })} />
          </View>
          <View style={{ flex: 1 }}>
            <Num label="Right" value={payload.right_ml} units={units}
                 onChange={(ml) => setP({ right_ml: ml })} />
          </View>
        </View>
      ) : null}

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

function Num({ label, value, units, onChange }) {
  const shown = value == null ? '' : String(volume(value, units)).replace(/(ml|oz)$/, '');
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.body}>{label}</Text>
      <TextInput
        style={s.input}
        keyboardType="decimal-pad"
        defaultValue={shown}
        onChangeText={(v) => onChange(v === '' ? undefined : toMl(v, units))}
      />
    </View>
  );
}
