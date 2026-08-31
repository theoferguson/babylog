import Ionicons from '@expo/vector-icons/Ionicons';
import { usePathname, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scrollToTop } from './scrollTop';
import { c } from './theme';

const TABS = [
  { key: 'index', href: '/', label: 'Home', icon: 'home' },
  { key: 'calendar', href: '/calendar', label: 'Cal', icon: 'calendar' },
  { key: 'insights', href: '/insights', label: 'Insights', icon: 'stats-chart' },
];

// Deliberately not a Tabs navigator. The log forms and the event editor are
// pushed screens with their own headers and back buttons, and a tab navigator
// above them hides its bar the moment you push. Rendering the bar as a sibling
// of the Stack keeps it on every screen, forms included.
export default function TabBar() {
  const router = useRouter();
  const path = usePathname();
  const insets = useSafeAreaInsets();
  // Signing in is not a place to be offered navigation.
  if (path === '/login' || path === '/join') return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: c.surface,
        borderTopWidth: 1,
        borderTopColor: c.border,
        paddingBottom: insets.bottom || 8,
        paddingTop: 6,
      }}
    >
      {TABS.map((t) => {
        const active = path === t.href;
        const tint = active ? c.accent : c.muted;
        return (
          <Pressable
            key={t.key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t.label}
            // replace, not push: tabs are destinations, not history.
            onPress={() => (active ? scrollToTop(t.key) : router.replace(t.href))}
            style={({ pressed }) => ({
              flex: 1, alignItems: 'center', paddingVertical: 4, gap: 2,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons name={t.icon} size={22} color={tint} />
            <Text style={{ fontSize: 11, fontWeight: '600', color: tint }}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
