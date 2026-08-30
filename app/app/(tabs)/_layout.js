import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { scrollToTop } from '../../src/scrollTop';
import { c } from '../../src/theme';

// Re-tapping the active tab returns it to the top rather than doing nothing.
const toTop = (key) => ({ navigation }) => ({
  tabPress: () => {
    if (navigation.isFocused()) scrollToTop(key);
  },
});

// A compact bottom bar: icon plus a small label, standard iOS height, nothing
// that eats into the timeline.
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.muted,
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopColor: c.border,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarItemStyle: { paddingVertical: 4 },
        sceneStyle: { backgroundColor: c.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        listeners={toTop('index')}
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size - 2} color={color} />,
        }}
      />
      <Tabs.Screen
        name="calendar"
        listeners={toTop('calendar')}
        options={{
          title: 'Cal',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar" size={size - 2} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="insights"
        listeners={toTop('insights')}
        options={{
          title: 'Insights',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="stats-chart" size={size - 2} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
