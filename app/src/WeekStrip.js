import { Pressable, ScrollView, Text, View } from 'react-native';
import { addDays, todayKey } from './days';
import { c } from './theme';

// Seven days ending today. Density dot shows how much was logged, so a quiet day
// is visible before you open it.
export default function WeekStrip({ tz, selected, counts, onSelect }) {
  const today = todayKey(tz);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {days.map((key) => {
        const on = key === selected;
        const n = counts?.[key] ?? null;
        const d = new Date(`${key}T12:00:00Z`);
        return (
          <Pressable
            key={key}
            onPress={() => onSelect(key)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            style={{
              paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, minWidth: 46,
              alignItems: 'center',
              backgroundColor: on ? c.accent : c.surface,
              borderWidth: 1, borderColor: on ? c.accent : c.border,
            }}
          >
            <Text style={{ fontSize: 11, color: on ? '#FFF' : c.muted }}>
              {d.toLocaleDateString([], { weekday: 'short' })}
            </Text>
            <Text style={{ fontSize: 16, fontWeight: '700', color: on ? '#FFF' : c.text }}>
              {d.getUTCDate()}
            </Text>
            <View
              style={{
                height: 4, width: n ? Math.min(18, 4 + n) : 4, borderRadius: 2, marginTop: 4,
                backgroundColor: n ? (on ? '#FFF' : c.accent) : 'transparent',
              }}
            />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
