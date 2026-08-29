import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import InstantForm, { Choice } from '../../src/InstantForm';
import { toMl } from '../../src/format';
import { useSession } from '../../src/session';
import { c, types } from '../../src/theme';
import { s } from '../../src/ui';

export default function Bottle() {
  const { household } = useSession();
  const units = household?.units || 'metric';
  const [amount, setAmount] = useState('');
  const [contents, setContents] = useState('Breast Milk');
  const ml = toMl(amount, units);

  return (
    <InstantForm
      type="feed"
      valid={ml != null && ml >= 0}
      build={() => ({ method: 'bottle', contents, volume_ml: ml })}
    >
      <View style={{ gap: 8 }}>
        <Text style={s.h2}>Amount ({units === 'imperial' ? 'oz' : 'ml'})</Text>
        <TextInput
          style={[s.input, { fontSize: 34, fontWeight: '700', textAlign: 'center' }]}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={c.border}
          value={amount}
          onChangeText={setAmount}
          autoFocus
        />
      </View>
      <Choice
        label="Contents"
        options={[
          { value: 'Breast Milk', label: 'Breast milk' },
          { value: 'Formula', label: 'Formula' },
        ]}
        value={contents}
        onChange={(v) => setContents(v || 'Breast Milk')}
        tint={types.bottle.fill}
      />
    </InstantForm>
  );
}
