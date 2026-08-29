import { Pressable, StyleSheet, Text, View } from 'react-native';
import { c, radius, space } from './theme';

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  pad: { padding: space },
  card: {
    backgroundColor: c.surface,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: c.border,
    padding: space,
  },
  h1: { fontSize: 26, fontWeight: '700', color: c.text },
  h2: { fontSize: 17, fontWeight: '700', color: c.text },
  body: { fontSize: 15, color: c.text },
  muted: { fontSize: 13, color: c.muted },
  row: { flexDirection: 'row', alignItems: 'center' },
  input: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: c.text,
  },
  error: {
    backgroundColor: c.warnBg,
    borderColor: c.danger,
    borderWidth: 1,
    borderRadius: radius,
    padding: 12,
  },
  errorText: { color: c.danger, fontSize: 14 },
});

export function Button({ title, onPress, disabled, tone = 'accent', style }) {
  const bg = tone === 'accent' ? c.accent : c.surface;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderRadius: radius,
          paddingVertical: 15,
          alignItems: 'center',
          borderWidth: tone === 'accent' ? 0 : 1,
          borderColor: c.border,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <Text style={{ color: tone === 'accent' ? '#FFF' : c.text, fontSize: 16, fontWeight: '600' }}>
        {title}
      </Text>
    </Pressable>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <View style={[s.error, { marginTop: 12 }]}>
      <Text style={s.errorText}>{String(error.message || error)}</Text>
    </View>
  );
}

// Colour is never the only signal -- every event carries an icon and a label
// too. Pastels this close in lightness are indistinguishable to a colourblind
// user and wash out in sunlight.
export function Chip({ style: t, children }) {
  return (
    <View style={[s.row, { gap: 6 }]}>
      <Text style={{ fontSize: 13 }}>{t.icon}</Text>
      <Text style={{ color: t.ink, fontWeight: '600', fontSize: 13 }}>{children ?? t.label}</Text>
    </View>
  );
}
