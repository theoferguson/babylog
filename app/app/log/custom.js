import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import InstantForm from '../../src/InstantForm';
import { c } from '../../src/theme';
import { s } from '../../src/ui';

// Anything the four fixed types do not cover: a medication, an appointment, a
// first smile. The title is the whole event, so it is the only required field.
export default function Custom() {
  const [label, setLabel] = useState('');
  return (
    <InstantForm
      type="note"
      valid={!!label.trim()}
      build={() => ({ label: label.trim() })}
    >
      <View style={{ gap: 8 }}>
        <Text style={s.h2}>What happened</Text>
        <TextInput
          style={s.input}
          placeholder="Vitamin D, 2 month checkup, first smile…"
          placeholderTextColor={c.muted}
          value={label}
          onChangeText={setLabel}
          autoFocus
        />
      </View>
    </InstantForm>
  );
}
