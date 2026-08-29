import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Events, deviceTz } from '../src/api';
import { useSession } from '../src/session';
import { c, space } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';

// Bottle, diaper and pump are instant events: no timer, timestamp defaults to
// now, with a tappable chip to back it up when you are logging late.
export default function InstantForm({ type, needsBaby = true, children, build, valid }) {
  const router = useRouter();
  const { babyId } = useSession();
  const [at, setAt] = useState(new Date());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await Events.create({
        baby: needsBaby ? babyId : null,
        type,
        started_at: at.toISOString(),
        tz: deviceTz(),
        notes,
        payload: build(),
      });
      router.back();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const shift = (mins) => setAt((d) => new Date(d.getTime() + mins * 60000));

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 14 }}>
      {children}

      <View style={{ gap: 8 }}>
        <Text style={s.h2}>When</Text>
        <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
          <Text style={[s.body, { fontWeight: '700', minWidth: 76 }]}>
            {at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </Text>
          {[-30, -15, -5].map((m) => (
            <Pressable
              key={m}
              onPress={() => shift(m)}
              accessibilityRole="button"
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.surface,
              }}
            >
              <Text style={s.body}>{m}m</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => setAt(new Date())}
            accessibilityRole="button"
            style={{ paddingHorizontal: 12, paddingVertical: 8 }}
          >
            <Text style={{ color: c.accent, fontWeight: '600' }}>now</Text>
          </Pressable>
        </View>
      </View>

      <TextInput
        style={[s.input, { minHeight: 56, textAlignVertical: 'top' }]}
        placeholder="Notes (optional)"
        placeholderTextColor={c.muted}
        multiline
        value={notes}
        onChangeText={setNotes}
      />

      <Button title={busy ? 'Saving…' : 'Save'} onPress={save} disabled={busy || !valid} />
      <ErrorNote error={error} />
    </ScrollView>
  );
}

export function Choice({ label, options, value, onChange, tint }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.h2}>{label}</Text>
      <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
        {options.map((o) => {
          const on = value === o.value;
          return (
            <Pressable
              key={String(o.value)}
              onPress={() => onChange(on ? null : o.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderRadius: 999,
                backgroundColor: on ? tint : c.surface,
                borderWidth: 1,
                borderColor: on ? tint : c.border,
              }}
            >
              <Text style={{ color: c.text, fontWeight: on ? '700' : '400' }}>
                {on ? '✓ ' : ''}
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
