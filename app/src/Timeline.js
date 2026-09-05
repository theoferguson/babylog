import { Pressable, Text, View } from 'react-native';
import { summarize, timeOfDay } from './format';
import { c, styleFor, titleFor } from './theme';
import { layout, usableSegments, visibleSpanSec } from './timelineLayout';

const HOUR = 44; // px per hour
const GUTTER = 44;
const MIN_BLOCK = 22;

// 24h vertical axis.
//
// Every event is a solid block in its own type colour -- instant events used to
// be an outline, which read as a different class of thing rather than a shorter
// one. Anything that overlaps on screen shares the width instead of drawing on
// top; see timelineLayout.js.
//
// Placement uses each event's OWN recorded zone, not the viewer's, so a day
// logged in another timezone still reads correctly after you fly home.
export default function Timeline({ events, units, tz, onPress }) {
  const blocks = layout(events, { tz, hourPx: HOUR, minPx: MIN_BLOCK });
  return (
    <View style={{ height: 24 * HOUR, marginTop: 8 }}>
      {Array.from({ length: 24 }, (_, h) => (
        <View key={h} style={{ position: 'absolute', top: h * HOUR, left: 0, right: 0 }}>
          <View style={{ height: 1, backgroundColor: c.border, marginLeft: GUTTER }} />
          <Text
            style={{
              position: 'absolute', top: -7, width: GUTTER - 8,
              textAlign: 'right', fontSize: 11, color: c.muted,
            }}
          >
            {h % 12 === 0 ? 12 : h % 12}
            {h < 12 ? 'a' : 'p'}
          </Text>
        </View>
      ))}

      <View style={{ position: 'absolute', left: GUTTER + 6, right: 6, top: 0, bottom: 0 }}>
        {blocks.map(({ event: e, top, height, leftPct, widthPct, gapPx, columns }) => {
          const t = styleFor(e);
          const detail = summarize(e, units);
          // In a narrow column the detail line will not fit beside the label.
          const roomy = columns === 1;
          return (
            <Pressable
              key={e.id}
              onPress={() => onPress?.(e)}
              accessibilityRole="button"
              accessibilityLabel={`${t.label} at ${timeOfDay(e.started_at)}${detail ? `, ${detail}` : ''}. Tap to edit.`}
              style={({ pressed }) => ({
                position: 'absolute',
                top,
                height,
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                // A 2px gap of page between adjacent fills, so two blocks read as
                // two rather than one wide one.
                paddingRight: gapPx,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View
                style={{
                  flex: 1,
                  // A paused feed is drawn faded across its whole span with the
                  // stretches it was actually nursing picked out solid. Without
                  // segments (imported rows, instant events) it is solid
                  // throughout, which is what those are.
                  backgroundColor: t.fill,
                  opacity: usableSegments(e) ? 0.35 : 1,
                  borderRadius: 8,
                  justifyContent: 'center',
                  paddingHorizontal: 8,
                  overflow: 'hidden',
                }}
              />
              {usableSegments(e)?.map((seg, i) => {
                const from = new Date(seg.from).getTime();
                const to = new Date(seg.to).getTime();
                const span = visibleSpanSec(e) * 1000;
                if (span <= 0) return null;
                const topPct = ((from - new Date(e.started_at).getTime()) / span) * 100;
                const hPct = ((to - from) / span) * 100;
                return (
                  <View
                    key={i}
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      left: 0, right: gapPx,
                      top: `${Math.max(0, topPct)}%`,
                      height: `${Math.max(1, hPct)}%`,
                      backgroundColor: t.fill,
                      borderRadius: 4,
                    }}
                  />
                );
              })}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0, right: gapPx, top: 0, bottom: 0,
                  justifyContent: 'center',
                  paddingHorizontal: 8,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {/* Colour is never the only signal: icon and label always show. */}
                  <Text style={{ fontSize: 12 }}>{t.icon}</Text>
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 12, fontWeight: '700', color: c.text, flexShrink: 1 }}
                  >
                    {titleFor(e)}
                    {e.in_progress ? ' · running' : ''}
                  </Text>
                  {roomy && detail ? (
                    <Text numberOfLines={1} style={{ fontSize: 12, color: c.text, flexShrink: 1 }}>
                      {detail}
                    </Text>
                  ) : null}
                </View>
                {!roomy && detail && height > 30 ? (
                  <Text numberOfLines={1} style={{ fontSize: 11, color: c.text }}>
                    {detail}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
