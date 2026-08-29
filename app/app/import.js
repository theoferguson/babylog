import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { Imports, deviceTz } from '../src/api';
import ImportRow from '../src/ImportRow';
import { useSession } from '../src/session';
import { c, space } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';

// Nothing reaches the database from a file without being seen first: preview
// parses and saves nothing, you check/uncheck and edit, then commit saves only
// what you sent. Commit is per-row, so a bad row is skipped and reported rather
// than sinking the batch.
export default function Import() {
  const router = useRouter();
  const { household, babyId } = useSession();
  const units = household?.units || 'metric';

  const [rows, setRows] = useState(null);
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const pick = async () => {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({
      type: ['text/csv', 'text/comma-separated-values', 'application/csv', '*/*'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    setBusy(true);
    try {
      const body = await Imports.preview(res.assets[0], household?.timezone || deviceTz());
      setRows(body.events);
      // All selected by default.
      setChecked(Object.fromEntries(body.events.map((e) => [e.id, true])));
      setResult(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const update = useCallback((next) => {
    setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)));
  }, []);

  const toggle = useCallback((id) => {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const stats = useMemo(() => {
    if (!rows) return null;
    const sel = rows.filter((r) => checked[r.id]);
    return {
      total: rows.length,
      selected: sel.length,
      warned: rows.filter((r) => r.errors?.length).length,
      seen: rows.filter((r) => r.already_imported).length,
    };
  }, [rows, checked]);

  const allOn = stats && stats.selected === stats.total;
  const setAll = (on) =>
    setChecked(Object.fromEntries(rows.map((r) => [r.id, on])));

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const selected = rows.filter((r) => checked[r.id]);
      const body = await Imports.commit(babyId, selected);
      setResult(body);
      if (!body.skipped?.length) {
        setRows(null);
        setChecked({});
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!rows) {
    return (
      <View style={[s.screen, s.pad, { gap: 14 }]}>
        <Text style={s.h2}>Import from Huckleberry</Text>
        <Text style={s.muted}>
          Pick your CSV export. Nothing is saved until you review the rows and press Import.
        </Text>
        <Button title={busy ? 'Reading…' : 'Choose CSV file'} onPress={pick} disabled={busy} />
        {result ? <Result result={result} onDone={() => router.replace('/')} /> : null}
        <ErrorNote error={error} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={{ padding: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Text style={s.h2}>
          {stats.total} rows · {stats.selected} selected
          {stats.warned ? ` · ${stats.warned} with warnings` : ''}
        </Text>
        {stats.seen ? (
          <Text style={s.muted}>{stats.seen} already imported — re-importing updates them.</Text>
        ) : null}
        <View style={[s.row, { gap: 16 }]}>
          <Pressable onPress={() => setAll(!allOn)} accessibilityRole="button">
            <Text style={{ color: c.accent, fontWeight: '600' }}>
              {allOn ? 'Deselect all' : 'Select all'}
            </Text>
          </Pressable>
          <Pressable onPress={() => { setRows(null); setChecked({}); }} accessibilityRole="button">
            <Text style={s.muted}>Choose a different file</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        initialNumToRender={20}
        windowSize={10}
        renderItem={({ item }) => (
          <ImportRow
            row={item}
            checked={!!checked[item.id]}
            units={units}
            onToggle={() => toggle(item.id)}
            onChange={update}
          />
        )}
      />

      <View style={{ padding: space, gap: 10, borderTopWidth: 1, borderTopColor: c.border }}>
        {result ? <Result result={result} onDone={() => router.replace('/')} /> : null}
        <ErrorNote error={error} />
        <Button
          title={busy ? 'Importing…' : `Import ${stats.selected} row${stats.selected === 1 ? '' : 's'}`}
          onPress={commit}
          disabled={busy || stats.selected === 0}
        />
        {busy ? <ActivityIndicator color={c.accent} /> : null}
      </View>
    </View>
  );
}

function Result({ result, onDone }) {
  const skipped = result.skipped || [];
  return (
    <View style={[s.card, { gap: 6 }]}>
      <Text style={s.h2}>Saved {result.saved}</Text>
      {skipped.length ? (
        <>
          <Text style={s.errorText}>
            {skipped.length} skipped — fix them above and import again.
          </Text>
          {skipped.slice(0, 5).map((sk) => (
            <Text key={sk.index} style={s.muted}>
              row {sk.index + 1}: {sk.errors.join('. ')}
            </Text>
          ))}
        </>
      ) : (
        <Button title="Done" onPress={onDone} />
      )}
    </View>
  );
}
