import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Events, deviceTz } from '../src/api';
import DateTimeField from '../src/DateTimeField';
import { clock } from '../src/format';
import * as local from '../src/localTimer';
import OfflineBar from '../src/OfflineBar';
import { enqueue, isOffline, newId } from '../src/outbox';
import { useSession } from '../src/session';
import { c, space, types } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';
import { useActiveEvents, useNow } from '../src/useActive';

// The running timer belongs to the household, not this phone: it is an Event
// with ended_at null, created on the FIRST tap, and the server owns the
// accumulators so two phones cannot clobber each other.
//
// Offline there are two cases, and they are not the same:
//
//  1. A feed is already running on the server and the connection drops. Timer
//     intents carry their own `at`, so they queue and replay in order and the
//     server still computes the right totals. We shadow the arithmetic locally
//     just to keep the screen ticking.
//  2. No feed exists and we cannot create one. Then the timer is purely local
//     and is saved as one complete event when the connection returns.
//
// A feed that goes local stays local until saved, even if the connection comes
// back mid-feed -- promoting it halfway would mean reconciling against a partner
// who may have been tapping too.
function fromEvent(event) {
  const p = event.payload || {};
  return {
    started_at: event.started_at,
    right_sec: p.right_sec || 0,
    left_sec: p.left_sec || 0,
    running_side: p.running_side || null,
    running_since: p.running_since || null,
    last_side: p.last_side || null,
    notes: event.notes || '',
    remoteId: event.id,
  };
}

export default function Nurse() {
  const router = useRouter();
  const { babyId } = useSession();
  const { events, skewMs, refresh } = useActiveEvents();
  const [offlineState, setOfflineState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [editStart, setEditStart] = useState(false);

  const remote = events.find((e) => e.type === 'feed') || null;

  // A timer left running when the app died is picked back up here.
  useEffect(() => {
    local.load().then((saved) => saved && setOfflineState(saved));
  }, []);

  // Once we are driving locally we stay there, so a late poll cannot yank the
  // screen back and lose taps made while offline.
  const view = offlineState || (remote ? fromEvent(remote) : null);
  // Server skew corrects a server-issued running_since. A local timer's
  // running_since came from this device's clock, so adding skew would make it
  // start at zero (or jump) for the length of the drift.
  const now = useNow(!!view?.running_side) + (offlineState ? 0 : skewMs);

  useEffect(() => {
    if (view && !notesDirty) setNotes(view.notes || '');
  }, [view, notesDirty]);

  // Offline notes live only in React state otherwise, so an app kill mid-feed
  // would restore the timer with the notes blank.
  useEffect(() => {
    if (!offlineState || !notesDirty) return;
    if (offlineState.notes === notes) return;
    local.save({ ...offlineState, notes });
  }, [notes, notesDirty, offlineState]);

  const goLocal = async (next) => {
    setOfflineState(next);
    await local.save(next);
  };

  const tapSide = async (side) => {
    setBusy(true);
    setError(null);
    const at = new Date();
    let bootstrapped = null;
    try {
      if (offlineState) {
        const next = local.tap(offlineState, side, at);
        // If this feed exists on the server, the intent still queues and
        // replays; the local copy is only what the screen draws.
        if (offlineState.remoteId) {
          await enqueue({
            method: 'POST',
            path: `/api/events/${offlineState.remoteId}/timer/`,
            body: sideIntent(offlineState, side, at),
          });
        }
        await goLocal(next);
        return;
      }
      if (remote) {
        const p = remote.payload || {};
        await (p.running_side === side
          ? Events.tick(remote.id, 'stop', null, at)
          : Events.tick(remote.id, 'start', side, at));
        await refresh();
        return;
      }
      // createDirect, not create: a queued create would leave an in_progress
      // event with nothing to finish it.
      const created = await Events.createDirect({
        baby: babyId,
        type: 'feed',
        started_at: at.toISOString(),
        tz: deviceTz(),
        in_progress: true,
        payload: { method: 'breast' },
      });
      bootstrapped = created.id;
      await Events.tick(created.id, 'start', side, at);
      await refresh();
    } catch (e) {
      if (!isOffline(e)) {
        setError(e);
        return;
      }
      // Drop to a local timer rather than losing the tap. If the feed already
      // exists on the server, the tap that discovered the outage must still be
      // queued -- otherwise the server banks the whole stretch to the wrong side.
      const base = bootstrapped
        ? { ...local.empty(at), remoteId: bootstrapped }
        : view || local.empty(at);
      if (base.remoteId) {
        await enqueue({
          method: 'POST',
          path: `/api/events/${base.remoteId}/timer/`,
          body: sideIntent(base, side, at),
        });
      }
      await goLocal(local.tap(base, side, at));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const at = new Date();
    try {
      if (offlineState) {
        if (offlineState.remoteId) {
          if (notesDirty) {
            await enqueue({
              method: 'PATCH',
              path: `/api/events/${offlineState.remoteId}/`,
              body: { notes },
            });
          }
          await enqueue({
            method: 'POST',
            path: `/api/events/${offlineState.remoteId}/finish/`,
            body: { at: at.toISOString() },
          });
        } else {
          // No server event was ever created: queue the whole finished feed.
          const body = local.toEvent({ ...offlineState, notes }, at, {
            baby: babyId,
            tz: deviceTz(),
            id: newId(),
          });
          await enqueue({ method: 'POST', path: '/api/events/', body });
        }
        await local.clear();
        setOfflineState(null);
        router.back();
        return;
      }
      if (notesDirty) await Events.update(remote.id, { notes });
      await Events.finish(remote.id, at);
      await refresh();
      router.back();
    } catch (e) {
      if (!isOffline(e)) {
        setError(e);
        setBusy(false);
        return;
      }
      // The connection went while saving. Queue the finish with the time the
      // button was pressed, so the feed does not stay in progress forever.
      await enqueue({
        method: 'POST',
        path: `/api/events/${remote.id}/finish/`,
        body: { at: at.toISOString() },
      });
      await local.clear();
      setOfflineState(null);
      router.back();
    }
  };

  const discard = () => {
    const go = async () => {
      setBusy(true);
      try {
        if (offlineState) {
          if (offlineState.remoteId) await Events.remove(offlineState.remoteId);
          await local.clear();
          setOfflineState(null);
        } else if (remote) {
          await Events.remove(remote.id);
          await refresh();
        }
        router.back();
      } catch (e) {
        setError(e);
        setBusy(false);
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Discard this feed? It will not be saved.')) go();
      return;
    }
    Alert.alert('Discard this feed?', 'It will not be saved.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: go },
    ]);
  };

  const secs = (side) => (view ? local.secsFor(view, side, now) : 0);
  const totalSecs = secs('R') + secs('L');

  // Correcting the start time works whether the timer is running or paused --
  // the side accumulators are independent of it, so nothing is lost either way.
  const changeStart = (next) =>
    guard(async () => {
      if (offlineState) {
        await goLocal({ ...offlineState, started_at: next.toISOString() });
        return;
      }
      await Events.update(event.id, { started_at: next.toISOString() });
    });

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 14 }}>
      <Text style={[s.h1, { textAlign: 'center' }]}>{clock(totalSecs)}</Text>
      <Text style={[s.muted, { textAlign: 'center' }]}>
        {!view
          ? 'Tap a side to start'
          : view.running_side
            ? `${view.running_side} side running`
            : 'Paused — tap a side, or save'}
      </Text>

      {offlineState ? (
        <Text style={[s.muted, { textAlign: 'center' }]}>
          Offline — timing on this phone. It will sync when you save.
        </Text>
      ) : null}

      <View style={[s.row, { gap: 12 }]}>
        {['L', 'R'].map((side) => (
          <SideButton
            key={side}
            side={side}
            secs={secs(side)}
            running={view?.running_side === side}
            disabled={busy}
            onPress={() => tapSide(side)}
          />
        ))}
      </View>

      {view?.last_side && !view.running_side ? (
        <Text style={[s.muted, { textAlign: 'center' }]}>
          Last side: {view.last_side} — start on {view.last_side === 'L' ? 'R' : 'L'} next
        </Text>
      ) : null}

      {view ? (
        <>
          <Pressable
            onPress={() => setEditStart((v) => !v)}
            accessibilityRole="button"
            style={{ alignItems: 'center', paddingVertical: 4 }}
          >
            <Text style={s.muted}>
              Started {new Date(view.started_at).toLocaleTimeString([], {
                hour: 'numeric', minute: '2-digit',
              })}
              {editStart ? '' : ' — tap to adjust'}
            </Text>
          </Pressable>
          {editStart ? (
            <DateTimeField value={new Date(view.started_at)} onChange={changeStart} />
          ) : null}

          <TextInput
            style={[s.input, { minHeight: 64, textAlignVertical: 'top' }]}
            placeholder="Notes (optional)"
            placeholderTextColor={c.muted}
            multiline
            value={notes}
            onChangeText={(t) => {
              setNotes(t);
              setNotesDirty(true);
            }}
          />
          <Button title={busy ? 'Saving…' : 'Save feed'} onPress={save} disabled={busy} />
          <Button title="Discard" tone="plain" onPress={discard} disabled={busy} />
        </>
      ) : null}

      <OfflineBar onFlushed={refresh} />
      <ErrorNote error={error} />
    </ScrollView>
  );
}

// Tapping the running side stops it; tapping the other switches.
function sideIntent(state, side, at) {
  return state.running_side === side
    ? { action: 'stop', at: at.toISOString() }
    : { action: 'start', side, at: at.toISOString() };
}

function SideButton({ side, secs, running, disabled, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: running }}
      accessibilityLabel={`${side === 'L' ? 'Left' : 'Right'} side, ${Math.round(secs / 60)} minutes${running ? ', running' : ''}`}
      style={({ pressed }) => ({
        flex: 1,
        backgroundColor: running ? types.nurse.ink : types.nurse.fill,
        borderRadius: 20,
        paddingVertical: 40,
        alignItems: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: 34, fontWeight: '800', color: running ? '#FFF' : c.text }}>
        {side}
      </Text>
      <Text style={{ fontSize: 15, color: running ? '#FFF' : c.text, marginTop: 6 }}>
        {clock(secs)}
      </Text>
      {/* Colour alone must not carry "which side is running". */}
      <Text style={{ fontSize: 12, color: running ? '#FFF' : c.muted, marginTop: 2 }}>
        {running ? '● running' : 'tap to start'}
      </Text>
    </Pressable>
  );
}
