import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '../src/session';
import { c } from '../src/theme';

function Gate() {
  const { ready, signedIn } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const onLogin = segments[0] === 'login';
    if (!signedIn && !onLogin) router.replace('/login');
    if (signedIn && onLogin) router.replace('/');
  }, [ready, signedIn, segments, router]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center' }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: c.bg },
        headerShadowVisible: false,
        headerTintColor: c.text,
        contentStyle: { backgroundColor: c.bg },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="nurse" options={{ title: 'Nursing' }} />
      <Stack.Screen name="log/bottle" options={{ title: 'Bottle' }} />
      <Stack.Screen name="log/diaper" options={{ title: 'Diaper' }} />
      <Stack.Screen name="log/pump" options={{ title: 'Pump' }} />
      <Stack.Screen name="import" options={{ title: 'Import' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
