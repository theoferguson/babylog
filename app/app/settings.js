import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Share, Text, TextInput, View } from 'react-native';
import { Babies, Invites, api } from '../src/api';
import DateField from '../src/DateField';
import { useSession } from '../src/session';
import { c, space } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';
import { offsetLabel, zoneOptions } from '../src/zones';

// Baby swatches, distinct from the event-type palette so a baby is never
// confused with a category.
const SWATCHES = ['#E8877D', '#7AA6C2', '#A8B87C', '#C9A0C8', '#E0A96D', '#8FBAAE'];

export default function Settings() {
  const router = useRouter();
  const { household, babies, refresh, signOut } = useSession();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const guard = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!household) {
    return (
      <View style={[s.screen, s.pad]}>
        <Text style={s.muted}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 22, paddingBottom: 48 }}>
      <HouseholdCard household={household} busy={busy} onSave={(patch) =>
        guard(() => api.patch(`/api/households/${household.id}/`, patch))} />

      <View style={{ gap: 10 }}>
        <Text style={s.h2}>Babies</Text>
        {babies.map((b) => (
          <BabyCard
            key={b.id}
            baby={b}
            busy={busy}
            onSave={(patch) => guard(() => Babies.update(b.id, patch))}
            onArchive={() => guard(() => Babies.update(b.id, { archived: true }))}
            onDelete={() => guard(() => Babies.remove(b.id))}
          />
        ))}
        {adding ? (
          <BabyCard
            baby={{ name: '', dob: null, color: SWATCHES[babies.length % SWATCHES.length] }}
            isNew
            busy={busy}
            onSave={async (patch) => {
              await guard(() => Babies.create(patch));
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button title="Add a baby" tone="plain" onPress={() => setAdding(true)} />
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={s.h2}>Who has access</Text>
        {(household.members || []).map((m) => (
          <View key={m.id} style={[s.card, { paddingVertical: 12 }]}>
            <Text style={s.body}>{m.username}</Text>
            {m.email ? <Text style={s.muted}>{m.email}</Text> : null}
          </View>
        ))}
        <Text style={s.muted}>
          Everyone here sees the same events and can start or stop the same timer.
        </Text>
        <InviteSection />
      </View>

      <ErrorNote error={error} />
      <Button title="Sign out" tone="plain" onPress={() => { signOut(); router.replace('/login'); }} />
    </ScrollView>
  );
}

function HouseholdCard({ household, busy, onSave }) {
  const [name, setName] = useState(household.name);
  const [units, setUnits] = useState(household.units);
  const [zone, setZone] = useState(household.timezone);
  const [pickZone, setPickZone] = useState(false);
  const dirty =
    name !== household.name || units !== household.units || zone !== household.timezone;

  return (
    <View style={{ gap: 10 }}>
      <Text style={s.h2}>Household</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Family name"
                 placeholderTextColor={c.muted} />

      <Text style={s.body}>Units</Text>
      <View style={[s.row, { gap: 8 }]}>
        {[['metric', 'Metric (ml, g, cm)'], ['imperial', 'Imperial (oz, lb, in)']].map(
          ([v, label]) => (
            <Pressable
              key={v}
              onPress={() => setUnits(v)}
              accessibilityRole="button"
              accessibilityState={{ selected: units === v }}
              style={{
                flex: 1, paddingVertical: 12, borderRadius: 14, alignItems: 'center',
                backgroundColor: units === v ? c.accent : c.surface,
                borderWidth: 1, borderColor: units === v ? c.accent : c.border,
              }}
            >
              <Text style={{ color: units === v ? '#FFF' : c.text, fontWeight: '600' }}>{label}</Text>
            </Pressable>
          ),
        )}
      </View>
      <Text style={s.muted}>
        Display only — everything is stored in ml, g and cm whichever you pick, so switching
        never changes a recorded number.
      </Text>

      <Text style={s.body}>Home timezone</Text>
      <Pressable onPress={() => setPickZone((v) => !v)} accessibilityRole="button" style={s.input}>
        <Text style={{ color: c.text, fontSize: 16 }}>
          {zone} {offsetLabel(zone)}
        </Text>
      </Pressable>
      {pickZone ? (
        <View style={[s.card, { maxHeight: 260, padding: 0 }]}>
          <ScrollView>
            {zoneOptions(zone).map((z) => (
              <Pressable
                key={z}
                onPress={() => { setZone(z); setPickZone(false); }}
                accessibilityRole="button"
                style={{ padding: 12, borderBottomWidth: 1, borderBottomColor: c.border }}
              >
                <Text style={{ color: z === zone ? c.accent : c.text }}>
                  {z} {offsetLabel(z)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <Text style={s.muted}>
        Used to decide which day an event belongs to. Each event also keeps the zone it was
        recorded in, so travelling does not move past days around.
      </Text>

      {dirty ? (
        <Button title={busy ? 'Saving…' : 'Save household'} disabled={busy}
                onPress={() => onSave({ name, units, timezone: zone })} />
      ) : null}
    </View>
  );
}

function BabyCard({ baby, isNew, busy, onSave, onArchive, onDelete, onCancel }) {
  const [open, setOpen] = useState(!!isNew);
  const [name, setName] = useState(baby.name);
  const [dob, setDob] = useState(baby.dob);
  const [color, setColor] = useState(baby.color);
  useEffect(() => { setName(baby.name); setDob(baby.dob); setColor(baby.color); }, [baby]);

  const dirty = name !== baby.name || dob !== baby.dob || color !== baby.color;

  const confirmDelete = () => {
    const msg = 'Delete this baby? Only possible while they have no logged events.';
    if (Platform.OS === 'web') {
      if (window.confirm(msg)) onDelete();
      return;
    }
    Alert.alert('Delete this baby?', 'Only possible while they have no logged events.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
  };

  return (
    <View style={[s.card, { gap: 10 }]}>
      <Pressable onPress={() => !isNew && setOpen((v) => !v)} accessibilityRole="button"
                 style={[s.row, { justifyContent: 'space-between' }]}>
        <View style={[s.row, { gap: 10 }]}>
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: color }} />
          <Text style={[s.body, { fontWeight: '700' }]}>{baby.name || 'New baby'}</Text>
        </View>
        {!isNew ? <Text style={s.muted}>{open ? '▲' : '▼'}</Text> : null}
      </Pressable>

      {open ? (
        <>
          <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Name"
                     placeholderTextColor={c.muted} autoFocus={isNew} />
          <DateField label="Date of birth" value={dob} onChange={setDob} maximumDate={new Date()} />
          <Text style={s.body}>Colour</Text>
          <View style={[s.row, { gap: 10 }]}>
            {SWATCHES.map((sw) => (
              <Pressable
                key={sw}
                onPress={() => setColor(sw)}
                accessibilityRole="button"
                accessibilityLabel={`Colour ${sw}`}
                accessibilityState={{ selected: color === sw }}
                style={{
                  width: 34, height: 34, borderRadius: 17, backgroundColor: sw,
                  borderWidth: color === sw ? 3 : 1,
                  borderColor: color === sw ? c.text : c.border,
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                {color === sw ? <Text style={{ color: '#FFF', fontWeight: '900' }}>✓</Text> : null}
              </Pressable>
            ))}
          </View>

          <Button
            title={busy ? 'Saving…' : isNew ? 'Add baby' : 'Save'}
            disabled={busy || !name.trim() || (!isNew && !dirty)}
            onPress={() => onSave({ name: name.trim(), dob, color })}
          />
          {isNew ? (
            <Button title="Cancel" tone="plain" onPress={onCancel} />
          ) : (
            <>
              <Button title="Archive" tone="plain" onPress={onArchive} disabled={busy} />
              <Button title="Delete" tone="plain" onPress={confirmDelete} disabled={busy} />
              <Text style={s.muted}>
                Archiving hides them but keeps every event. Deleting is only allowed while
                there is no history to lose.
              </Text>
            </>
          )}
        </>
      ) : null}
    </View>
  );
}


function InviteSection() {
  const [invites, setInvites] = useState(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = async () => {
    try {
      const r = await Invites.list();
      setInvites((r.results || r || []).filter((i) => i.is_usable));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => { load(); }, []);

  const run = async (fn, okMsg) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const body = await fn();
      // Delivery can fail for reasons the server cannot fix. Say so, and leave
      // the link available rather than pretending it was sent.
      setNote(body?.email_sent === false
        ? 'Could not send the email — share the link below instead.'
        : okMsg);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const share = async (invite) => {
    const message =
      `Join our babylog household — open this link to create your account:\n${invite.link}`;
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(invite.link);
        window.alert('Invite link copied to the clipboard.');
      } catch {
        window.prompt('Copy this invite link:', invite.link);
      }
      return;
    }
    await Share.share({ message });
  };

  return (
    <View style={{ gap: 10, marginTop: 6 }}>
      <Text style={s.h2}>Invite someone</Text>
      <TextInput
        style={s.input}
        placeholder="Their email address"
        placeholderTextColor={c.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <Button
        title={busy ? 'Sending…' : 'Send invite'}
        onPress={() => run(async () => {
          const body = await Invites.create(email.trim());
          setEmail('');
          return body;
        }, `Invite sent to ${email.trim()}.`)}
        disabled={busy || !email.trim()}
      />
      {note ? <Text style={s.muted}>{note}</Text> : null}

      {(invites || []).map((i) => (
        <View key={i.id} style={[s.card, { gap: 8 }]}>
          <Text style={[s.body, { fontWeight: '700' }]}>{i.email}</Text>
          <Text style={s.muted}>
            {i.sent_at ? 'Sent' : 'Not sent'} · expires{' '}
            {new Date(i.expires_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </Text>
          <View style={[s.row, { gap: 8 }]}>
            <Button title="Resend" tone="plain" disabled={busy} style={{ flex: 1 }}
                    onPress={() => run(() => Invites.resend(i.id), 'Sent again.')} />
            <Button title="Copy link" tone="plain" style={{ flex: 1 }}
                    onPress={() => share(i)} />
            <Button title="Revoke" tone="plain" disabled={busy} style={{ flex: 1 }}
                    onPress={() => run(() => Invites.revoke(i.id), 'Invite revoked.')} />
          </View>
        </View>
      ))}

      <Text style={s.muted}>
        The link creates exactly one account and then stops working. It expires after a week,
        and anyone holding it can see everything in this household — so only send it to the
        person it names.
      </Text>
      <ErrorNote error={error} />
    </View>
  );
}
