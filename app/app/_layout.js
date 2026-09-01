import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import TabBar from '../src/TabBar';
import ErrorBoundary from '../src/ErrorBoundary';
import { SessionProvider, useSession } from '../src/session';
import '../src/outbox'; // registers the write queue with the API layer
import { c } from '../src/theme';

function Gate() {
  const { ready, signedIn } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    // /join must stay reachable while signed out -- it is how you get an account.
    const onAuthScreen = segments[0] === 'login' || segments[0] === 'join';
    if (!signedIn && !onAuthScreen) router.replace('/login');
    if (signedIn && onAuthScreen) router.replace('/');
  }, [ready, signedIn, segments, router]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center' }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.bg },
          headerShadowVisible: false,
          headerTintColor: c.text,
          contentStyle: { backgroundColor: c.bg },
          // Otherwise iOS labels it with the previous screen's title, which for
          // the tab screens is the route group name: "(tabs)".
          headerBackTitle: 'Back',
        }}
      >
        <Stack.Screen name="(tabs)/index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)/calendar" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)/insights" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="join" options={{ headerShown: false }} />
        <Stack.Screen name="nurse" options={{ title: 'Nursing' }} />
        <Stack.Screen name="log/bottle" options={{ title: 'Bottle' }} />
        <Stack.Screen name="log/diaper" options={{ title: 'Diaper' }} />
        <Stack.Screen name="log/pump" options={{ title: 'Pump' }} />
        <Stack.Screen name="import" options={{ title: 'Import' }} />
        <Stack.Screen name="event/[id]" options={{ title: 'Edit event' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
      <TabBar />
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <SessionProvider>
          <Gate />
        </SessionProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
