import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Pill } from '../../../src/components/Pill';
import { colors, spacing, text } from '../../../src/theme';

export default function ListeningScreen() {
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Listening' }} />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.filterRow}>
          <Pill label="All" active onPress={() => {}} />
          <Pill label="This week" onPress={() => {}} />
          <Pill label="Favorites" onPress={() => {}} />
        </View>

        <View style={styles.empty}>
          <View style={styles.emptyIcon}>
            <Ionicons
              name="headset-outline"
              size={28}
              color={colors.textTertiary}
            />
          </View>
          <Text style={styles.emptyTitle}>No podcasts yet</Text>
          <Text style={styles.emptySubtitle}>
            Confirm a session in the Sessions tab and we&apos;ll generate a
            podcast you can replay here.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  empty: {
    marginTop: spacing.xxl,
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.pillBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  emptyTitle: {
    ...text.cardTitle,
    fontSize: 17,
  },
  emptySubtitle: {
    ...text.caption,
    textAlign: 'center',
    lineHeight: 19,
  },
});
