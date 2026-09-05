import { Text, TextInput, View } from 'react-native';
import { Choice } from './InstantForm';
import { toMl, volume } from './format';
import { c } from './theme';
import { s } from './ui';

const opts = (vs) => vs.map((v) => ({ value: v, label: v }));
const SIZES = opts(['small', 'medium', 'large']);
export const POO_COLOURS = opts(['yellow', 'brown', 'green', 'black']);
export const POO_TEXTURES = opts(['runny', 'loose', 'seedy', 'firm']);

// The per-type payload fields, in one place.
//
// Two screens need exactly these: the event editor, where you correct
// something already saved, and the voice review screen, where you correct
// something not saved yet. They differ in what surrounds the fields -- a
// header and a delete button versus a card and a checkbox -- but not in the
// fields themselves, so a new field is added here once.
export default function EventFields({ type, payload, setP, units, disabled }) {
  const isBreast = type === 'feed' && payload.method === 'breast';
  return (
    <>
      {type === 'diaper' ? (
        <>
          <Choice label="Pee" options={SIZES} value={payload.pee ?? null}
                  onChange={(v) => setP({ pee: v ?? undefined })} />
          <Choice label="Poo" options={SIZES} value={payload.poo ?? null}
                  onChange={(v) => setP(v
                    ? { poo: v }
                    : { poo: undefined, color: undefined, consistency: undefined })} />
          {payload.poo ? (
            <>
              <Choice label="Colour" options={POO_COLOURS} value={payload.color ?? null}
                      onChange={(v) => setP({ color: v ?? undefined })} />
              <Choice label="Consistency" options={POO_TEXTURES} value={payload.consistency ?? null}
                      onChange={(v) => setP({ consistency: v ?? undefined })} />
            </>
          ) : null}
        </>
      ) : null}

      {type === 'note' ? (
        <View style={{ gap: 6 }}>
          <Text style={s.body}>Title</Text>
          <TextInput
            style={s.input}
            editable={!disabled}
            defaultValue={payload.label || ''}
            placeholder="What happened"
            placeholderTextColor={c.muted}
            onChangeText={(v) => setP({ label: v.trim() || undefined })}
          />
        </View>
      ) : null}

      {isBreast ? (
        <View style={[s.row, { gap: 12 }]}>
          {[['Left (min)', 'left_sec'], ['Right (min)', 'right_sec']].map(([label, key]) => (
            <View key={key} style={{ flex: 1, gap: 6 }}>
              <Text style={s.body}>{label}</Text>
              <TextInput
                style={s.input}
                keyboardType="number-pad"
                editable={!disabled}
                defaultValue={payload[key] ? String(Math.round(payload[key] / 60)) : ''}
                onChangeText={(v) => {
                  const n = parseInt(v, 10);
                  setP({ [key]: isFinite(n) ? n * 60 : undefined });
                }}
              />
            </View>
          ))}
        </View>
      ) : null}

      {type === 'feed' && payload.method === 'bottle' ? (
        <Num label={`Amount (${units === 'imperial' ? 'oz' : 'ml'})`}
             value={payload.volume_ml} units={units} disabled={disabled}
             onChange={(ml) => setP({ volume_ml: ml })} />
      ) : null}

      {type === 'pump' ? (
        <View style={[s.row, { gap: 12 }]}>
          <View style={{ flex: 1 }}>
            <Num label="Left" value={payload.left_ml} units={units} disabled={disabled}
                 onChange={(ml) => setP({ left_ml: ml })} />
          </View>
          <View style={{ flex: 1 }}>
            <Num label="Right" value={payload.right_ml} units={units} disabled={disabled}
                 onChange={(ml) => setP({ right_ml: ml })} />
          </View>
        </View>
      ) : null}
    </>
  );
}

function Num({ label, value, units, disabled, onChange }) {
  const shown = value == null ? '' : String(volume(value, units)).replace(/(ml|oz)$/, '');
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.body}>{label}</Text>
      <TextInput
        style={s.input}
        keyboardType="decimal-pad"
        editable={!disabled}
        defaultValue={shown}
        onChangeText={(v) => onChange(v === '' ? undefined : toMl(v, units))}
      />
    </View>
  );
}
