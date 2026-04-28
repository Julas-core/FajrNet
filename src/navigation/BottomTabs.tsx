import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import HomeScreen      from '../screens/HomeScreen';
import CommunityScreen from '../screens/CommunityScreen';
import StreakScreen    from '../screens/StreakScreen';

const Tab = createBottomTabNavigator();

export default function BottomTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: '#1a1a2e', borderTopColor: '#333' },
        tabBarActiveTintColor: '#1d9e75',
        tabBarInactiveTintColor: '#666',
      }}
    >
      <Tab.Screen name="Home"      component={HomeScreen}      options={{ tabBarIcon: () => <Text>🕌</Text> }} />
      <Tab.Screen name="Circle"    component={CommunityScreen} options={{ tabBarIcon: () => <Text>👥</Text> }} />
      <Tab.Screen name="Streak"    component={StreakScreen}    options={{ tabBarIcon: () => <Text>🔥</Text> }} />
    </Tab.Navigator>
  );
}