import { Pressable, Text, View } from 'react-native';
import { styleFor, c } from './theme';
import { summarize, timeOfDay } from './format';

const HOUR = 44; // px per hour
const GUTTER = 44;

// 24h vertical axis. Interval events (nursing, sleep) are blocks; instant events
// (bottle, diaper, pump) are dots on the axis. Hand-rolled -- no library renders
// this view well, and it is ~100 lines.
export default function Timeline({ events, units, onPress }) {
  const rows = [...events].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  return (
    <View style={{ height: 24 * HOUR, marginTop: 8 }}>
      {Array.from({ length: 24 }, (_, h) => (
        <View key={h} style={{ position: 'absolute', top: h * HOUR, left: 0, right: 0 }}>
          <View style={{ height: 1, backgroundColor: c.border, marginLeft: GUTTER }} />
          <Text
            style={{
              position: 'absolute',
              top: -7,
              width: GUTTER - 8,
              textAlign: 'right',
              fontSize: 11,
              color: c.muted,
            }}
          >
            {h % 12 === 0 ? 12 : h % 12}
            {h < 12 ? 'a' : 'p'}
          </Text>
        </View>
      ))}
      {rows.map((e) => {
        const t = styleFor(e);
        const start = new Date(e.started_at);
        const top = (start.getHours() + start.getMinutes() / 60) * HOUR;
        const end = e.ended_at ? new Date(e.ended_at) : null;
        const durH = end ? (end - start) / 3600000 : 0;
        const detail = summarize(e, units);
        const interval = durH > 0 || e.in_progress;
        return (
          <Pressable
            key={e.id}
            onPress={() => onPress?.(e)}
            accessibilityRole="button"
            accessibilityLabel={`${t.label} at ${timeOfDay(e.started_at)}${detail ? `, ${detail}` : ''}`}
            style={{
              position: 'absolute',
              top,
              left: GUTTER + 6,
              right: 6,
              minHeight: 22,
              height: interval ? Math.max(22, durH * HOUR) : 22,
              backgroundColor: interval ? t.fill : 'transparent',
              borderRadius: 8,
              borderLeftWidth: interval ? 0 : 3,
              borderLeftColor: t.ink,
              justifyContent: 'center',
              paddingHorizontal: 8,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 12 }}>{t.icon}</Text>
              <Text style={{ fontSize: 12, fontWeight: '700', color: interval ? c.text : t.ink }}>
                {t.label}
                {e.in_progress ? ' · running' : ''}
              </Text>
              {detail ? (
                <Text style={{ fontSize: 12, color: interval ? c.text : c.muted }}>{detail}</Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
