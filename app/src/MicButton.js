import { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
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
function Listening({ onTranscript, onEnd, onError }) {
  const mod = Speech.ExpoSpeechRecognitionModule;
  const useSpeechRecognitionEvent = Speech.useSpeechRecognitionEvent;

  useSpeechRecognitionEvent('result', (e) => {
    onTranscript(e.results?.[0]?.transcript ?? '');
  });
  useSpeechRecognitionEvent('end', () => onEnd());
  useSpeechRecognitionEvent('error', (e) => {
    onEnd();
    // A silence is not a fault worth shouting about.
    if (e.error && e.error !== 'no-speech') onError(new Error(e.message || e.error));
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { granted } = await mod.requestPermissionsAsync();
        if (!granted) {
          onError(new Error('Microphone access is off for babylog.'));
          onEnd();
          return;
        }
        // On-device: the audio never leaves the phone, which matters when the
        // sentences are about an infant's health.
        if (alive) {
          mod.start({
            lang: 'en-US',
            interimResults: true,
            continuous: false,
            requiresOnDeviceRecognition: true,
          });
        }
      } catch (e) {
        onError(e);
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
export default function MicButton({ inline, label, busy, onText, onError }) {
  const [open, setOpen] = useState(false);
  const [heard, setHeard] = useState('');
  const [listening, setListening] = useState(canListen);

  const close = () => {
    setOpen(false);
    setHeard('');
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
                onError={(e) => { setListening(false); onError?.(e); }}
              />
            ) : null}

            <Text style={s.h2}>
              {listening ? 'Listening…' : canListen ? 'Check it, then Done' : 'Type what happened'}
            </Text>
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
