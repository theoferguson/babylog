import DateTimePicker from '@react-native-community/datetimepicker';
import { createElement, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { c } from './theme';
import { s } from './ui';

// A date and a time, for logging something that happened yesterday. The quick
// -5/-15/-30m chips stay the fast path; this is the escape hatch when the event
// was not today.

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function withDate(current, ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(current);
  next.setFullYear(y, m - 1, d);
  return next;
}
function withTime(current, hm) {
  const [h, min] = hm.split(':').map(Number);
  const next = new Date(current);
  next.setHours(h, min, 0, 0);
  return next;
}

export default function DateTimeField({ value, onChange, maxDate = new Date() }) {
  const [picking, setPicking] = useState(null); // 'date' | 'time' | null

  if (Platform.OS === 'web') {
    const input = (type, val, onInput) =>
      createElement('input', {
        type,
        value: val,
        max: type === 'date' ? dateStr(maxDate) : undefined,
        onChange: (e) => e.target.value && onInput(e.target.value),
        style: {
          font: 'inherit', fontSize: 16, color: c.text, backgroundColor: c.surface,
          border: `1px solid ${c.border}`, borderRadius: 14, padding: '10px 12px', flex: 1,
        },
      });
    return (
      <View style={[s.row, { gap: 8 }]}>
        {input('date', dateStr(value), (v) => onChange(withDate(value, v)))}
        {input('time', timeStr(value), (v) => onChange(withTime(value, v)))}
      </View>
    );
  }

  return (
    <View style={[s.row, { gap: 8 }]}>
      {[
        ['date', value.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })],
        ['time', value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })],
      ].map(([mode, label]) => (
        <Pressable
          key={mode}
          onPress={() => setPicking(mode)}
          accessibilityRole="button"
          accessibilityLabel={`Change ${mode}`}
          style={[s.input, { flex: 1 }]}
        >
          <Text style={{ color: c.text, fontSize: 16 }}>{label}</Text>
        </Pressable>
      ))}
      {picking ? (
        <DateTimePicker
          value={value}
          mode={picking}
          maximumDate={picking === 'date' ? maxDate : undefined}
          onChange={(event, picked) => {
            setPicking(null);
            if (event.type === 'dismissed' || !picked) return;
            // Never let a future time through: an event cannot have happened yet,
            // and the server rejects it anyway.
            onChange(picked > maxDate ? maxDate : picked);
          }}
        />
      ) : null}
    </View>
  );
}
