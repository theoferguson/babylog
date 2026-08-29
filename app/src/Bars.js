import { Text, View } from 'react-native';
import { c } from './theme';

// Single-series magnitude over time.
//
// One series per chart, so there is no legend and no cycled hue: the title names
// the series and the colour is the event type's own. Values are labelled
// selectively (max only) rather than on every bar, and all text uses text tokens
// rather than the series colour.
export default function Bars({ title, data, color, unit = '', height = 96, format }) {
  const values = data.map((d) => d.value);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const show = format || ((v) => `${Math.round(v)}${unit}`);

  return (
    <View style={{ gap: 8, marginTop: 20 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{title}</Text>
        <Text style={{ fontSize: 12, color: c.muted }}>peak {show(max)}</Text>
      </View>

      {total === 0 ? (
        <Text style={{ fontSize: 13, color: c.muted }}>Nothing recorded in this range.</Text>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 2 }}>
            {data.map((d) => {
              const h = d.value > 0 ? Math.max(3, (d.value / max) * height) : 0;
              const peak = d.value === max && d.value > 0;
              return (
                <View key={d.key} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
                  {peak ? (
                    <Text style={{ fontSize: 10, color: c.muted, marginBottom: 2 }}>{show(d.value)}</Text>
                  ) : null}
                  <View
                    accessible
                    accessibilityLabel={`${d.label}: ${show(d.value)}`}
                    style={{
                      width: '100%',
                      height: h,
                      backgroundColor: color,
                      // Rounded data-end, square against the baseline.
                      borderTopLeftRadius: 4,
                      borderTopRightRadius: 4,
                    }}
                  />
                </View>
              );
            })}
          </View>
          {/* Recessive baseline, not a full grid. */}
          <View style={{ height: 1, backgroundColor: c.border }} />
          <View style={{ flexDirection: 'row', gap: 2 }}>
            {data.map((d, i) => (
              <View key={d.key} style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ fontSize: 9, color: c.muted }}>
                  {i % Math.ceil(data.length / 7) === 0 ? d.label : ''}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

// A single headline number is not a chart.
export function Stat({ label, value, hint }) {
  return (
    <View
      style={{
        flexGrow: 1, flexBasis: '46%', backgroundColor: c.surface,
        borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 14,
      }}
    >
      <Text style={{ fontSize: 12, color: c.muted }}>{label}</Text>
      <Text style={{ fontSize: 26, fontWeight: '700', color: c.text, marginTop: 2 }}>{value}</Text>
      {hint ? <Text style={{ fontSize: 11, color: c.muted, marginTop: 2 }}>{hint}</Text> : null}
    </View>
  );
}
