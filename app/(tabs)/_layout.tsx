import { Ionicons } from '@expo/vector-icons';
import { BottomTabBar } from '@react-navigation/bottom-tabs';
import { Redirect, Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { MiniPlayer } from '../../src/components/MiniPlayer';
import { useAuth } from '../../src/context/auth';
import { colors } from '../../src/theme';

export default function TabsLayout() {
  // Declarative auth gate: render Redirect at render time instead of
  // pushing a route via useEffect. No imperative-redirect race window;
  // if user is null, this group never even mounts its tab navigator.
  const { user } = useAuth();
  if (!user) {
    return <Redirect href={'/(auth)/welcome' as never} />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.textPrimary,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabLabel,
      }}
      tabBar={(props) => (
        <View>
          <MiniPlayer />
          <BottomTabBar {...props} />
        </View>
      )}
    >
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons
              name={focused ? 'chatbubbles' : 'chatbubbles-outline'}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="listening"
        options={{
          title: 'Listening',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons
              name={focused ? 'headset' : 'headset-outline'}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="cards"
        options={{
          title: 'Cards',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons
              name={focused ? 'wallet' : 'wallet-outline'}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons
              name={focused ? 'calendar' : 'calendar-outline'}
              color={color}
              size={size}
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.card,
    borderTopColor: colors.separator,
    borderTopWidth: StyleSheet.hairlineWidth,
    height: 84,
    paddingTop: 6,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },
});
