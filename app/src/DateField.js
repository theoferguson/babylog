import DateTimePicker from '@react-native-community/datetimepicker';
import { createElement, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { c } from './theme';
import { s } from './ui';

// Dates are stored as 'YYYY-MM-DD' with no time, so they are parsed as UTC to
// avoid a birthday shifting a day for anyone west of Greenwich.
const parse = (v) => (v ? new Date(`${v}T12:00:00Z`) : new Date());
const fmt = (d) => d.toISOString().slice(0, 10);

export default function DateField({ label, value, onChange, maximumDate }) {
  const [open, setOpen] = useState(false);

  // On the web the browser's own date input is better than anything worth
  // building, and react-native-web renders DOM elements directly.
  if (Platform.OS === 'web') {
    return (
      <View style={{ gap: 6 }}>
        {label ? <Text style={s.body}>{label}</Text> : null}
        {createElement('input', {
          type: 'date',
          value: value || '',
          max: maximumDate ? fmt(maximumDate) : undefined,
          onChange: (e) => onChange(e.target.value || null),
          style: {
            font: 'inherit', fontSize: 16, color: c.text, backgroundColor: c.surface,
            border: `1px solid ${c.border}`, borderRadius: 14, padding: '12px 14px',
          },
        })}
      </View>
    );
  }

  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={s.body}>{label}</Text> : null}
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" style={s.input}>
        <Text style={{ color: value ? c.text : c.muted, fontSize: 16 }}>
          {value
            ? parse(value).toLocaleDateString([], {
                timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
              })
            : 'Choose a date'}
        </Text>
      </Pressable>
      {open ? (
        <DateTimePicker
          value={parse(value)}
          mode="date"
          maximumDate={maximumDate}
          onChange={(event, picked) => {
            setOpen(Platform.OS === 'ios' && event.type !== 'dismissed' ? false : false);
            if (event.type !== 'dismissed' && picked) onChange(fmt(picked));
          }}
        />
      ) : null}
    </View>
  );
}
