import DateTimePicker from '@react-native-community/datetimepicker';
import { createElement, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { c } from './theme';
import { Button, s } from './ui';

// A date and a time, for logging something that happened yesterday, or for
// correcting the start of a feed that is already running.

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
  // iOS fires onChange on every scroll tick. Holding a draft means one update
  // when you are done, instead of one per tick -- which on a screen that PATCHes
  // the server was a request per flick of the wheel.
  const [draft, setDraft] = useState(null);

  const commit = (next) => onChange(next > maxDate ? maxDate : next);

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
        {input('date', dateStr(value), (v) => commit(withDate(value, v)))}
        {input('time', timeStr(value), (v) => commit(withTime(value, v)))}
      </View>
    );
  }

  const open = (mode) => {
    setDraft(value);
    setPicking(mode);
  };

  return (
    <View style={{ gap: 8 }}>
      <View style={[s.row, { gap: 8 }]}>
        {[
          ['date', value.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })],
          ['time', value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })],
        ].map(([mode, label]) => (
          <Pressable
            key={mode}
            onPress={() => open(mode)}
            accessibilityRole="button"
            accessibilityLabel={`Change ${mode}`}
            style={[s.input, { flex: 1 }]}
          >
            <Text style={{ color: c.text, fontSize: 16 }}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {picking ? (
        <View style={{ gap: 8 }}>
          <DateTimePicker
            value={draft || value}
            mode={picking}
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            maximumDate={picking === 'date' ? maxDate : undefined}
            onChange={(e, picked) => {
              // Android shows a modal dialog and reports once, set or dismissed.
              if (Platform.OS !== 'ios') {
                setPicking(null);
                if (e.type === 'set' && picked) commit(picked);
                return;
              }
              // iOS renders inline and reports continuously. Unmounting here --
              // which is what the previous version did -- tears down the native
              // view mid-gesture and takes the app with it.
              if (picked) setDraft(picked);
            }}
          />
          {Platform.OS === 'ios' ? (
            <View style={[s.row, { gap: 8 }]}>
              <Button title="Cancel" tone="plain" style={{ flex: 1 }}
                      onPress={() => setPicking(null)} />
              <Button title="Done" style={{ flex: 1 }}
                      onPress={() => { setPicking(null); commit(draft || value); }} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
