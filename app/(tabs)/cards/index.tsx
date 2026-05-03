import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import { colors, radius, shadow, spacing, text } from '../../../src/theme';

const RATINGS: {
  label: string;
  bg: string;
  fg: string;
}[] = [
  { label: 'Again', bg: colors.rating.againBg, fg: colors.rating.againText },
  { label: 'Hard', bg: colors.rating.hardBg, fg: colors.rating.hardText },
  { label: 'Good', bg: colors.rating.goodBg, fg: colors.rating.goodText },
  { label: 'Easy', bg: colors.rating.easyBg, fg: colors.rating.easyText },
];

export default function CardsScreen() {
  // Placeholder: real data + flip + FSRS land in Steps 13-14.
  const dueCount = 0;
  const totalToday = 0;
  const progress = totalToday === 0 ? 0 : 1 - dueCount / totalToday;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Cards</Text>
          <Text style={styles.subtitle}>
            {dueCount} of {totalToday} due today
          </Text>
        </View>

        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.round(progress * 100)}%` },
            ]}
          />
        </View>

        {totalToday === 0 ? (
          <EmptyState />
        ) : (
          <>
            <FlashCardSample />
            <View style={styles.ratingRow}>
              {RATINGS.map((r) => (
                <Pressable
                  key={r.label}
                  onPress={() => {}}
                  style={({ pressed }) => [
                    styles.ratingPill,
                    { backgroundColor: r.bg },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[styles.ratingLabel, { color: r.fg }]}>
                    {r.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function EmptyState() {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons
          name="albums-outline"
          size={28}
          color={colors.textTertiary}
        />
      </View>
      <Text style={styles.emptyTitle}>No cards due</Text>
      <Text style={styles.emptySubtitle}>
        Confirm a session in Sessions to start building your spaced-
        repetition deck.
      </Text>
    </View>
  );
}

function FlashCardSample() {
  return (
    <Card style={styles.flashcard}>
      <Text style={styles.cardChunk}>captures a lively scene</Text>
      <View style={styles.cardMetaRow}>
        <View style={styles.cardThumb} />
        <Text style={styles.cardMeta}>From session · today</Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  header: {
    gap: 4,
  },
  title: {
    ...text.screenTitle,
  },
  subtitle: {
    ...text.caption,
  },
  progressTrack: {
    height: 6,
    backgroundColor: colors.pillBg,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  empty: {
    marginTop: spacing.xl,
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
  flashcard: {
    minHeight: 280,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    justifyContent: 'space-between',
  },
  cardChunk: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
    letterSpacing: -0.4,
    lineHeight: 36,
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  cardThumb: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.pillBg,
    ...shadow,
  },
  cardMeta: {
    ...text.caption,
  },
  ratingRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  ratingPill: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
});
