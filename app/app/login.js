import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../src/session';
import { c, space } from '../src/theme';
import { Button, ErrorNote, s } from '../src/ui';

export default function Login() {
  const { signIn, signUp } = useSession();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState('in'); // 'in' | 'join'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const joining = mode === 'join';
  const ready = username && password && (!joining || code);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (joining) await signUp({ code, username, password });
      else await signIn(username.trim(), password);
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
        <Text style={[s.muted, { marginBottom: 12 }]}>
          {joining ? 'Join a household with an invite code.' : 'Sign in to your household.'}
        </Text>

        {joining ? (
          <TextInput
            style={s.input}
            placeholder="Invite code"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            value={code}
            onChangeText={setCode}
          />
        ) : null}

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
          placeholder={joining ? 'Choose a password' : 'Password'}
          placeholderTextColor={c.muted}
          secureTextEntry
          autoComplete={joining ? 'new-password' : 'current-password'}
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />

        <Button
          title={busy ? 'Working…' : joining ? 'Join household' : 'Sign in'}
          onPress={submit}
          disabled={busy || !ready}
          style={{ marginTop: space }}
        />

        <Pressable
          onPress={() => { setMode(joining ? 'in' : 'join'); setError(null); }}
          accessibilityRole="button"
          style={{ paddingVertical: 12, alignItems: 'center' }}
        >
          <Text style={{ color: c.accent, fontWeight: '600' }}>
            {joining ? 'I already have an account' : 'I have an invite code'}
          </Text>
        </Pressable>

        <ErrorNote error={error} />
      </View>
    </KeyboardAvoidingView>
  );
}
