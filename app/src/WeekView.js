import { Pressable, ScrollView, Text, View } from 'react-native';
import { dayKey } from './days';
import { c, styleFor } from './theme';
import { layout } from './timelineLayout';

const HOUR = 26; // tighter than the day view: 24h of seven days has to fit
const GUTTER = 30;

// Seven days side by side on one 24h axis. Blocks carry no text at this width --
// the point is the shape of the week, not the detail of one feed. Tap a column
// header for that day, or a block to edit it.
export default function WeekView({ days, eventsByDay, tz, selected, onPickDay, onPressEvent }) {
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', marginLeft: GUTTER }}>
        {days.map((key) => {
          const d = new Date(`${key}T12:00:00Z`);
          const on = key === selected;
          const n = (eventsByDay[key] || []).length;
          return (
            <Pressable
              key={key}
              onPress={() => onPickDay(key)}
              accessibilityRole="button"
              accessibilityLabel={`${d.toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' })}, ${n} events`}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }}
            >
              <Text style={{ fontSize: 10, color: on ? c.accent : c.muted }}>
                {d.toLocaleDateString([], { weekday: 'narrow', timeZone: 'UTC' })}
              </Text>
              <Text style={{ fontSize: 13, fontWeight: on ? '800' : '600', color: on ? c.accent : c.text }}>
                {d.getUTCDate()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView style={{ height: 420 }} contentContainerStyle={{ height: 24 * HOUR }}>
        <View style={{ height: 24 * HOUR }}>
          {Array.from({ length: 24 }, (_, h) => (
            <View key={h} style={{ position: 'absolute', top: h * HOUR, left: 0, right: 0 }}>
              <View style={{ height: 1, backgroundColor: c.border, marginLeft: GUTTER }} />
              {h % 3 === 0 ? (
                <Text
                  style={{
                    position: 'absolute', top: -6, width: GUTTER - 6,
                    textAlign: 'right', fontSize: 9, color: c.muted,
                  }}
                >
                  {h % 12 === 0 ? 12 : h % 12}
                  {h < 12 ? 'a' : 'p'}
                </Text>
              ) : null}
            </View>
          ))}

          <View style={{ position: 'absolute', left: GUTTER, right: 0, top: 0, bottom: 0,
                         flexDirection: 'row' }}>
            {days.map((key) => (
              <View key={key} style={{ flex: 1, paddingHorizontal: 1 }}>
                {layout(eventsByDay[key] || [], { tz, hourPx: HOUR, minPx: 6, gapPx: 1 }).map(
                  ({ event: e, top, height, leftPct, widthPct, gapPx }) => (
                    <Pressable
                      key={e.id}
                      onPress={() => onPressEvent?.(e)}
                      accessibilityRole="button"
                      accessibilityLabel={`${styleFor(e).label} on ${dayKey(e.started_at, e.tz || tz)}`}
                      style={{
                        position: 'absolute', top, height,
                        left: `${leftPct}%`, width: `${widthPct}%`, paddingRight: gapPx,
                      }}
                    >
                      <View style={{ flex: 1, backgroundColor: styleFor(e).fill, borderRadius: 3 }} />
                    </Pressable>
                  ),
                )}
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
