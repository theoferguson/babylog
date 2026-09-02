import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { c, radius, space, types } from './theme';
import { Button, s } from './ui';

// Speech recognition is a native module, so it is only present in a build that
// included it. Requiring it lazily means the web bundle and any older build
// still run -- they just fall back to typing.
let Speech = null;
try {
  Speech = require('expo-speech-recognition');
} catch {
  Speech = null;
}
export const canListen = !!Speech?.ExpoSpeechRecognitionModule;

// Voice in, text out. Nothing here knows what the text means.
//
// The typed fallback is not a lesser path for accessibility or a quiet room --
// it is the same input by a different route, and it is what runs on web.
export default function MicButton({ inline, label, busy, onText, onError }) {
  const [open, setOpen] = useState(false);
  const [heard, setHeard] = useState('');
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!canListen || !open) return undefined;
    const mod = Speech.ExpoSpeechRecognitionModule;
    const subs = [
      Speech.addSpeechRecognitionListener('result', (e) => {
        setHeard(e.results?.[0]?.transcript ?? '');
      }),
      Speech.addSpeechRecognitionListener('end', () => setListening(false)),
      Speech.addSpeechRecognitionListener('error', (e) => {
        setListening(false);
        // "no speech detected" is a silence, not a fault worth shouting about.
        if (e.error && e.error !== 'no-speech') onError?.(new Error(e.message || e.error));
      }),
    ];
    (async () => {
      try {
        const { granted } = await mod.requestPermissionsAsync();
        if (!granted) {
          onError?.(new Error('Microphone access is off for babylog.'));
          return;
        }
        // On-device: the audio never leaves the phone, which matters when the
        // sentences are about an infant's health.
        mod.start({ lang: 'en-US', interimResults: true, requiresOnDeviceRecognition: true });
        setListening(true);
      } catch (e) {
        onError?.(e);
      }
    })();
    return () => {
      subs.forEach((sub) => sub?.remove?.());
      try { mod.stop(); } catch { /* already stopped */ }
    };
  }, [open, onError]);

  const finish = () => {
    const text = heard.trim();
    setOpen(false);
    setHeard('');
    setListening(false);
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
        position: 'absolute', alignSelf: 'center', top: '50%',
        marginTop: -32, width: 64, height: 64, borderRadius: 32,
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
      <Modal visible={open} animationType="slide" transparent
             onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0006' }}>
          <View style={{
            backgroundColor: c.bg, padding: space, gap: 12,
            borderTopLeftRadius: radius * 2, borderTopRightRadius: radius * 2,
          }}>
            <Text style={s.h2}>
              {listening ? 'Listening…' : canListen ? 'Tap done when finished' : 'Type what happened'}
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
            <Button title="Cancel" tone="plain" onPress={() => { setOpen(false); setHeard(''); }} />
          </View>
        </View>
      </Modal>
    </>
  );
}
