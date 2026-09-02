import { useEffect, useState } from 'react';
import { Animated, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { c, radius, space } from './theme';
import { Button, s } from './ui';

// Speech recognition is a native module, so it is only present in a build that
// included it. Requiring it lazily means the web bundle and any older build
// still run -- they fall back to typing, which is also the accessible path.
let Speech = null;
try {
  Speech = require('expo-speech-recognition');
} catch {
  Speech = null;
}
// Web has no native recogniser here. Both names are checked because this
// module's surface has already moved once under me: if a rename lands, the
// button should quietly become the typed box rather than take the app down.
export const canListen =
  Platform.OS !== 'web'
  && typeof Speech?.ExpoSpeechRecognitionModule?.start === 'function'
  && typeof Speech?.useSpeechRecognitionEvent === 'function';

// Listening lives in its own component because `useSpeechRecognitionEvent` is
// a hook -- it cannot be called from inside an effect, and it cannot be called
// conditionally. Mounting this only while the sheet is open is how the
// subscription gets scoped without breaking the rules of hooks.
function Listening({ onTranscript, onEnd, onStatus, level }) {
  const mod = Speech.ExpoSpeechRecognitionModule;
  const useSpeechRecognitionEvent = Speech.useSpeechRecognitionEvent;

  useSpeechRecognitionEvent('start', () => onStatus({ note: 'Listening…' }));
  // The recogniser reports input volume roughly -2 (silence) to 10 (loud).
  // Animating from that rather than a timer is the difference between showing
  // that we started and showing that we can hear you.
  useSpeechRecognitionEvent('volumechange', (e) => {
    const v = Math.max(0, Math.min(1, ((e.value ?? 0) + 2) / 8));
    Animated.timing(level, { toValue: v, duration: 90, useNativeDriver: true }).start();
  });
  useSpeechRecognitionEvent('result', (e) => {
    onTranscript(e.results?.[0]?.transcript ?? '');
  });
  useSpeechRecognitionEvent('end', () => onEnd());
  useSpeechRecognitionEvent('error', (e) => {
    onEnd();
    // A silence is not a fault worth reporting.
    if (e.error && e.error !== 'no-speech') {
      onStatus({ error: e.message || e.error });
    }
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!mod.isRecognitionAvailable()) {
          onStatus({ error: 'Speech recognition is not available on this device.' });
          onEnd();
          return;
        }
        // Requested separately so a refusal names the one that is missing --
        // iOS asks twice and it is easy to grant one and dismiss the other.
        const speech = await mod.requestSpeechRecognizerPermissionsAsync();
        if (!speech.granted) {
          onStatus({ error: 'Speech recognition is off for babylog in Settings.' });
          onEnd();
          return;
        }
        const microphone = await mod.requestMicrophonePermissionsAsync();
        if (!microphone.granted) {
          onStatus({ error: 'Microphone access is off for babylog in Settings.' });
          onEnd();
          return;
        }
        if (!alive) return;

        // On-device keeps the audio on the phone, which is the point when the
        // sentences are about an infant's health -- but it needs the locale
        // downloaded, and asking for it when it is unavailable just fails.
        // Say which one is happening rather than quietly doing the other.
        const onDevice = mod.supportsOnDeviceRecognition();
        onStatus({
          note: onDevice ? 'Listening — on this phone.' : 'Listening — via Apple.',
        });
        mod.start({
          lang: 'en-US',
          interimResults: true,
          continuous: false,
          requiresOnDeviceRecognition: onDevice,
        });
      } catch (e) {
        onStatus({ error: String(e?.message || e) });
        onEnd();
      }
    })();
    return () => {
      alive = false;
      try { mod.stop(); } catch { /* already stopped */ }
    };
    // Mount/unmount only: re-running would restart the recogniser mid-sentence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

// Voice in, text out. Nothing here knows what the text means.
export default function MicButton({ inline, label, busy, onText }) {
  const [open, setOpen] = useState(false);
  const [heard, setHeard] = useState('');
  const [listening, setListening] = useState(canListen);
  // Status belongs to the sheet, not the screen behind it. Reporting a
  // recogniser failure to the parent put the message underneath the modal,
  // where a real error and plain silence look exactly the same.
  const [status, setStatus] = useState(null);
  // An Animated.Value rather than state: volume events arrive many times a
  // second and re-rendering the sheet on each one would be absurd.
  const [level] = useState(() => new Animated.Value(0));

  const close = () => {
    level.setValue(0);
    setOpen(false);
    setHeard('');
    setStatus(null);
    setListening(canListen);
  };

  const finish = () => {
    const text = heard.trim();
    close();
    if (text) onText(text);
  };

  const trigger = inline ? (
    <Button title={label || 'Say something'} tone="plain"
            onPress={() => setOpen(true)} disabled={busy} />
  ) : (
    <Pressable
      onPress={() => setOpen(true)}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="Log by voice"
      style={({ pressed }) => ({
        // Centred on both axes. `alignSelf` would only do the cross axis, and
        // the tile grid is a row, so that centres vertically and leaves this
        // pinned to the left edge.
        position: 'absolute', top: '50%', left: '50%',
        marginTop: -32, marginLeft: -32,
        width: 64, height: 64, borderRadius: 32,
        backgroundColor: c.accent,
        // A ring of page colour, so it reads as floating above the four tiles
        // rather than a hole cut through them.
        borderWidth: 4, borderColor: c.bg,
        alignItems: 'center', justifyContent: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: 26 }}>🎙️</Text>
    </Pressable>
  );

  return (
    <>
      {trigger}
      <Modal visible={open} animationType="slide" transparent onRequestClose={close}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0006' }}>
          <View style={{
            backgroundColor: c.bg, padding: space, gap: 12,
            borderTopLeftRadius: radius * 2, borderTopRightRadius: radius * 2,
          }}>
            {open && canListen && listening ? (
              <Listening
                onTranscript={setHeard}
                onEnd={() => setListening(false)}
                onStatus={setStatus}
                level={level}
              />
            ) : null}

            <View style={[s.row, { gap: 10 }]}>
              {listening ? <Level value={level} /> : null}
              <Text style={[s.h2, { flex: 1 }]}>
                {status?.note && listening ? status.note
                  : listening ? 'Starting…'
                  : canListen ? 'Check it, then Done'
                  : 'Type what happened'}
              </Text>
            </View>
            {status?.error ? (
              <View style={s.error}>
                <Text style={s.errorText}>{status.error}</Text>
                <Text style={[s.errorText, { marginTop: 4 }]}>
                  You can still type it below.
                </Text>
              </View>
            ) : null}
            <TextInput
              style={[s.input, { minHeight: 80, textAlignVertical: 'top' }]}
              multiline
              autoFocus={!canListen}
              value={heard}
              onChangeText={setHeard}
              placeholder="fed 20 minutes on the left, then a wet diaper"
              placeholderTextColor={c.muted}
            />
            <Text style={s.muted}>
              You will get a chance to check and change this before anything is saved.
            </Text>
            <Button title="Done" onPress={finish} disabled={!heard.trim()} />
            <Button title="Cancel" tone="plain" onPress={close} />
          </View>
        </View>
      </Modal>
    </>
  );
}


// Three bars that rise with what the microphone is actually picking up. Silence
// leaves them at rest, which is the honest answer to "is it hearing me?" -- a
// decorative pulse would say yes either way.
function Level({ value }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 22 }}>
      {[0.7, 1, 0.8].map((weight, i) => (
        <Animated.View
          key={i}
          style={{
            width: 4,
            height: 22,
            borderRadius: 2,
            backgroundColor: c.accent,
            // scaleY is about the centre by default, which would grow each bar
            // in both directions like a spike rather than a level.
            transformOrigin: 'bottom',
            transform: [
              {
                scaleY: value.interpolate({
                  inputRange: [0, 1],
                  // Never fully flat: a resting bar still reads as "on".
                  outputRange: [0.18, 0.18 + 0.82 * weight],
                }),
              },
            ],
          }}
        />
      ))}
    </View>
  );
}
