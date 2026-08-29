import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../src/session';
import { c, space } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';

// Landing page for an invite link: /join?code=...
// The code arrives in the URL, so the person invited never types it.
export default function Join() {
  const params = useLocalSearchParams();
  const { signUp } = useSession();
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState(String(params.code || ''));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signUp({ code, username, password });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[s.screen, { paddingTop: insets.top }]}
    >
      <View style={[s.pad, { flex: 1, justifyContent: 'center', gap: 12 }]}>
        <Text style={s.h1}>Join the household</Text>
        <Text style={[s.muted, { marginBottom: 12 }]}>
          Pick a username and password. You will see the same feeds, diapers and timers as
          everyone else in it.
        </Text>

        {params.code ? null : (
          <TextInput
            style={s.input}
            placeholder="Invite code"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            value={code}
            onChangeText={setCode}
          />
        )}

        <TextInput
          style={s.input}
          placeholder="Choose a username"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          value={username}
          onChangeText={setUsername}
        />
        <TextInput
          style={s.input}
          placeholder="Choose a password"
          placeholderTextColor={c.muted}
          secureTextEntry
          autoComplete="new-password"
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />

        <Button
          title={busy ? 'Joining…' : 'Create my account'}
          onPress={submit}
          disabled={busy || !code || !username || !password}
          style={{ marginTop: space }}
        />
        <ErrorNote error={error} />
      </View>
    </KeyboardAvoidingView>
  );
}
