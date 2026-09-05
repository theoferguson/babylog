import { Pressable, Text, View } from 'react-native';
import { summarize, timeOfDay } from './format';
import { c, styleFor, titleFor } from './theme';
import { s } from './ui';

// The flat, newest-first list of a day's events. Home and the calendar both
// show it; they differ only in the optional heading and where a tap goes.
export default function DayList({ events, units, onPress, label }) {
  const rows = [...events].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  return (
    <View style={{ marginTop: 8 }}>
      {label ? (
        <Text
          style={{
            fontSize: 12, fontWeight: '700', color: c.muted,
            textTransform: 'uppercase', letterSpacing: 0.5,
            paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.border,
          }}
        >
          {label}
        </Text>
      ) : null}
      {rows.map((e) => {
        const t = styleFor(e);
        return (
          <Pressable
            key={e.id}
            onPress={() => onPress(e)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <View style={{ width: 8, height: 32, borderRadius: 4, backgroundColor: t.ink }} />
            <Text style={{ fontSize: 15 }}>{t.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '700', color: c.text }}>
                {titleFor(e)}
                {e.in_progress ? ' · running' : ''}
              </Text>
              <Text style={s.muted}>{summarize(e, units) || '—'}</Text>
            </View>
            <Text style={s.muted}>{timeOfDay(e.started_at)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
