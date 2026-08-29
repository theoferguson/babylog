import { memo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Choice } from './InstantForm';
import { summarize, timeOfDay, toMl, volume } from './format';
import { c, styleFor } from './theme';
import { s } from './ui';

const SIZES = ['small', 'medium', 'large'].map((v) => ({ value: v, label: v }));

// One reviewable row: checkbox, what it is, and any reason it would be skipped.
// Tapping opens the editor for that row's type.
function ImportRow({ row, checked, units, onToggle, onChange }) {
  const [open, setOpen] = useState(false);
  const t = styleFor(row);
  const bad = row.errors?.length > 0;

  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        backgroundColor: bad ? c.warnBg : 'transparent',
      }}
    >
      <View style={[s.row, { paddingVertical: 10, paddingHorizontal: 12, gap: 10 }]}>
        <Pressable
          onPress={onToggle}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          accessibilityLabel={`${t.label} at ${timeOfDay(row.started_at)}`}
          hitSlop={8}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: checked ? c.accent : c.muted,
            backgroundColor: checked ? c.accent : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {checked ? <Text style={{ color: '#FFF', fontWeight: '900', fontSize: 14 }}>✓</Text> : null}
        </Pressable>

        <Pressable style={{ flex: 1 }} onPress={() => setOpen((v) => !v)} accessibilityRole="button">
          <View style={[s.row, { gap: 6 }]}>
            <Text style={{ fontSize: 13 }}>{t.icon}</Text>
            <Text style={{ fontWeight: '700', color: c.text }}>{t.label}</Text>
            <Text style={s.muted}>
              {new Date(row.started_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
              {timeOfDay(row.started_at)}
            </Text>
          </View>
          <Text style={s.muted}>{summarize(row, units) || '—'}</Text>
          {bad ? (
            <Text style={[s.errorText, { marginTop: 2 }]}>⚠ {row.errors.join('. ')}</Text>
          ) : null}
          {row.already_imported ? (
            <Text style={[s.muted, { marginTop: 2 }]}>ⓘ already imported — will update</Text>
          ) : null}
        </Pressable>

        <Text style={{ color: c.muted }}>{open ? '▲' : '▼'}</Text>
      </View>

      {open ? <Editor row={row} units={units} onChange={onChange} /> : null}
    </View>
  );
}

function Editor({ row, units, onChange }) {
  const p = row.payload || {};
  const set = (patch) => onChange({ ...row, ...patch });
  const setP = (patch) => set({ payload: { ...p, ...patch } });
  const shift = (m) =>
    set({ started_at: new Date(new Date(row.started_at).getTime() + m * 60000).toISOString() });

  return (
    <View style={{ padding: 12, gap: 12, backgroundColor: c.surface }}>
      <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
        <Text style={s.body}>Time</Text>
        {[-60, -5, 5, 60].map((m) => (
          <Pressable
            key={m}
            onPress={() => shift(m)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            <Text style={s.body}>{m > 0 ? `+${m}` : m}m</Text>
          </Pressable>
        ))}
      </View>

      {row.type === 'diaper' ? (
        <>
          <Choice label="Pee" options={SIZES} value={p.pee ?? null}
                  onChange={(v) => setP({ pee: v ?? undefined })} tint={styleFor(row).fill} />
          <Choice label="Poo" options={SIZES} value={p.poo ?? null}
                  onChange={(v) => setP({ poo: v ?? undefined })} tint={styleFor(row).fill} />
        </>
      ) : null}

      {row.type === 'feed' && p.method === 'bottle' ? (
        <NumberField
          label={`Amount (${units === 'imperial' ? 'oz' : 'ml'})`}
          value={p.volume_ml}
          units={units}
          onChange={(ml) => setP({ volume_ml: ml })}
        />
      ) : null}

      {row.type === 'feed' && p.method === 'breast' ? (
        <View style={[s.row, { gap: 12 }]}>
          {[['Left (min)', 'left_sec'], ['Right (min)', 'right_sec']].map(([label, key]) => (
            <View key={key} style={{ flex: 1 }}>
              <Text style={s.body}>{label}</Text>
              <TextInput
                style={s.input}
                keyboardType="number-pad"
                defaultValue={p[key] ? String(Math.round(p[key] / 60)) : ''}
                onChangeText={(v) => {
                  const n = parseInt(v, 10);
                  setP({ [key]: isFinite(n) ? n * 60 : undefined });
                }}
              />
            </View>
          ))}
        </View>
      ) : null}

      {row.type === 'pump' ? (
        <View style={[s.row, { gap: 12 }]}>
          {[['Left', 'left_ml'], ['Right', 'right_ml']].map(([label, key]) => (
            <View key={key} style={{ flex: 1 }}>
              <NumberField label={label} value={p[key]} units={units}
                           onChange={(ml) => setP({ [key]: ml })} />
            </View>
          ))}
        </View>
      ) : null}

      <View>
        <Text style={s.body}>Notes</Text>
        <TextInput
          style={s.input}
          defaultValue={row.notes || ''}
          onChangeText={(v) => set({ notes: v })}
          placeholder="—"
          placeholderTextColor={c.muted}
        />
      </View>
    </View>
  );
}

// Values are stored ml but shown in the household's units, so the field edits
// the displayed unit and converts back on the way out.
function NumberField({ label, value, units, onChange }) {
  const shown = value == null ? '' : String(volume(value, units)).replace(/(ml|oz)$/, '');
  return (
    <View>
      <Text style={s.body}>{label}</Text>
      <TextInput
        style={s.input}
        keyboardType="decimal-pad"
        defaultValue={shown}
        onChangeText={(v) => onChange(v === '' ? undefined : toMl(v, units))}
      />
    </View>
  );
}

export default memo(ImportRow);
