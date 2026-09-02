import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Events, Imports } from '../src/api';
import DateTimeField from '../src/DateTimeField';
import EventFields from '../src/EventFields';
import MicButton from '../src/MicButton';
import { useSession } from '../src/session';
import { c, space, styleFor } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';

// Where a spoken sentence stops being the model's and becomes yours.
//
// Nothing here has been written. Every card is editable and deselectable, rows
// the server flagged start unchecked and red, and the only thing that reaches
// the database is `import_commit` -- reached by pressing the button at the
// bottom, with a finger.
export default function Review() {
  const router = useRouter();
  const { babyId, household } = useSession();
  const units = household?.units || 'metric';
  const params = useLocalSearchParams();

  const [rows, setRows] = useState([]);
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // A flagged row starts unchecked, so the failure mode is "you notice" rather
  // than "it saved something wrong".
  const load = (next) => {
    setRows(next);
    setChecked(Object.fromEntries(next.map((r) => [r.id, !r.errors?.length])));
  };

  // The first draft arrives as a param so the mic can hand off without a
  // second round trip.
  useEffect(() => {
    if (!params.draft) return;
    try {
      load(JSON.parse(params.draft));
    } catch {
      setError(new Error('Could not read that draft.'));
    }
    // Only ever on the handoff: re-running would undo edits made since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.draft]);

  // Any edit clears that row's flags: they described the model's version, and
  // this is no longer it. Nothing is lost by being optimistic here --
  // `import_commit` re-runs `row_errors` and skips anything still wrong.
  const patch = (id, changes) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...changes, errors: [] } : r)));

  const selected = useMemo(() => rows.filter((r) => checked[r.id]), [rows, checked]);
  const blocked = selected.filter((r) => r.errors?.length);

  // A correction is a fresh parse with the current draft as context: the model
  // returns a whole revised draft, validated identically, and it replaces what
  // is on screen. It still commits nothing.
  const revise = async (text) => {
    setBusy(true);
    setError(null);
    try {
      const body = await Events.parse(text, rows);
      load(body.events || []);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await Imports.commit(babyId, selected);
      // The server gets the last word. If it refused a row, say so rather than
      // navigating away as though everything landed.
      if (body.skipped?.length) {
        // Keep only what did not land, carrying the server's reasons back onto
        // the cards so the next attempt is informed.
        const why = Object.fromEntries(body.skipped.map((sk) => [sk.id, sk.errors]));
        load(rows.filter((r) => why[r.id]).map((r) => ({ ...r, errors: why[r.id] })));
        setError(new Error(
          `Saved ${body.saved}. ${body.skipped.length} still need fixing.`));
        setBusy(false);
        return;
      }
      router.back();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 14, paddingBottom: 40 }}>
      <Text style={s.muted}>
        {rows.length
          ? 'Nothing is saved until you press the button.'
          : 'Nothing to review.'}
      </Text>

      {rows.map((r) => (
        <Card
          key={r.id}
          row={r}
          units={units}
          checked={!!checked[r.id]}
          onToggle={() => setChecked((c0) => ({ ...c0, [r.id]: !c0[r.id] }))}
          onChange={(changes) => patch(r.id, changes)}
        />
      ))}

      <ErrorNote error={error} />
      {blocked.length ? (
        <Text style={{ color: c.danger }}>
          Fix or untick {blocked.length} row{blocked.length > 1 ? 's' : ''} before saving.
        </Text>
      ) : null}

      {rows.length ? (
        <>
          <MicButton
            inline
            label="Change something"
            busy={busy}
            onText={revise}
            onError={setError}
          />
          <Button
            title={busy ? 'Saving…' : `Save ${selected.length} event${selected.length === 1 ? '' : 's'}`}
            onPress={save}
            disabled={busy || !selected.length || !!blocked.length}
          />
        </>
      ) : null}
      <Button title="Discard" tone="plain" onPress={() => router.back()} disabled={busy} />
    </ScrollView>
  );
}

function Card({ row, units, checked, onToggle, onChange }) {
  const t = styleFor(row);
  const bad = !!row.errors?.length;
  const at = new Date(row.started_at);
  const setP = (p) => onChange({ payload: { ...row.payload, ...p } });

  return (
    <View style={[s.card, {
      gap: 10,
      borderColor: bad ? c.danger : c.border,
      backgroundColor: bad ? c.warnBg : c.surface,
    }]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        style={[s.row, { gap: 10 }]}
      >
        <View style={{
          width: 22, height: 22, borderRadius: 6, borderWidth: 2,
          borderColor: checked ? c.accent : c.border,
          backgroundColor: checked ? c.accent : 'transparent',
          alignItems: 'center', justifyContent: 'center',
        }}>
          {checked ? <Text style={{ color: '#FFF', fontWeight: '900' }}>✓</Text> : null}
        </View>
        <Text style={{ fontSize: 18 }}>{t.icon}</Text>
        <Text style={[s.h2, { flex: 1 }]}>{t.label}</Text>
        <Text style={s.muted}>
          {at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </Text>
      </Pressable>

      {bad ? (
        <View style={{ gap: 2 }}>
          {row.errors.map((e) => (
            <Text key={e} style={{ color: c.danger, fontSize: 13 }}>{e}</Text>
          ))}
        </View>
      ) : null}

      <DateTimeField
        value={at}
        onChange={(d) => onChange({ started_at: d.toISOString() })}
      />
      <EventFields type={row.type} payload={row.payload || {}} setP={setP} units={units} />

      <TextInput
        style={[s.input, { minHeight: 40 }]}
        value={row.notes || ''}
        onChangeText={(v) => onChange({ notes: v })}
        placeholder="Notes"
        placeholderTextColor={c.muted}
      />
    </View>
  );
}
