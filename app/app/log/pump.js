import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import InstantForm from '../../src/InstantForm';
import { toMl, volume } from '../../src/format';
import { useSession } from '../../src/session';
import { c } from '../../src/theme';
import { s } from '../../src/ui';

// A pump session has no baby as its subject -- it is a parent event that shares
// the timeline. The total is what matters; the per-side split is informational.
export default function Pump() {
  const { household } = useSession();
  const units = household?.units || 'metric';
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const l = toMl(left, units);
  const r = toMl(right, units);
  const total = (l || 0) + (r || 0);

  return (
    <InstantForm
      type="pump"
      needsBaby={false}
      valid={l != null || r != null}
      build={() => ({ ...(l != null ? { left_ml: l } : {}), ...(r != null ? { right_ml: r } : {}) })}
    >
      <View style={[s.row, { gap: 12 }]}>
        {[
          ['Left', left, setLeft],
          ['Right', right, setRight],
        ].map(([label, value, set]) => (
          <View key={label} style={{ flex: 1, gap: 8 }}>
            <Text style={s.h2}>{label}</Text>
            <TextInput
              style={[s.input, { fontSize: 28, fontWeight: '700', textAlign: 'center' }]}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={c.border}
              value={value}
              onChangeText={set}
            />
          </View>
        ))}
      </View>
      <Text style={[s.body, { textAlign: 'center' }]}>
        Total {volume(total, units) || '—'}
      </Text>
    </InstantForm>
  );
}
