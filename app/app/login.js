import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../src/session';
import { c, space } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';

export default function Login() {
  const { signIn } = useSession();
  const insets = useSafeAreaInsets();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
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
        <Text style={s.h1}>babylog</Text>
        <Text style={[s.muted, { marginBottom: 12 }]}>Sign in to your household.</Text>
        <TextInput
          style={s.input}
          placeholder="Username"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          value={username}
          onChangeText={setUsername}
        />
        <TextInput
          style={s.input}
          placeholder="Password"
          placeholderTextColor={c.muted}
          secureTextEntry
          autoComplete="current-password"
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />
        <Button
          title={busy ? 'Signing in…' : 'Sign in'}
          onPress={submit}
          disabled={busy || !username || !password}
          style={{ marginTop: space }}
        />
        <ErrorNote error={error} />
      </View>
    </KeyboardAvoidingView>
  );
}
