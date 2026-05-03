import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import { listCardsDueBy } from '../../../src/db/cards';
import { colors, radius, spacing, text } from '../../../src/theme';
import type { Card as CardModel } from '../../../src/types';

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
  const [dueCards, setDueCards] = useState<CardModel[]>([]);
  const [reviewedToday, setReviewedToday] = useState(0);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const now = new Date().toISOString();
        const due = await listCardsDueBy(now);
        if (!cancelled) {
          setDueCards(due);
          setReviewedToday(0);
          setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [])
  );

  const totalToday = dueCards.length + reviewedToday;
  const remaining = dueCards.length;
  const progress = totalToday === 0 ? 0 : reviewedToday / totalToday;
  const currentCard = dueCards[0];

  const handleRate = () => {
    setDueCards((prev) => prev.slice(1));
    setReviewedToday((n) => n + 1);
  };

  if (loading) return <Screen />;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Cards</Text>
          <Text style={styles.subtitle}>
            {remaining === 0 && totalToday === 0
              ? 'Nothing due today'
              : `${remaining} of ${totalToday} due today`}
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

        {!currentCard ? (
          <EmptyState reviewedToday={reviewedToday} />
        ) : (
          <>
            <Flashcard card={currentCard} />
            <View style={styles.ratingRow}>
              {RATINGS.map((r) => (
                <Pressable
                  key={r.label}
                  onPress={handleRate}
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
            <Text style={styles.ratingHint}>
              FSRS scheduling lands in Step 13. Tapping any rating just
              advances to the next card for now.
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function EmptyState({ reviewedToday }: { reviewedToday: number }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons
          name={
            reviewedToday > 0
              ? 'checkmark-circle-outline'
              : 'albums-outline'
          }
          size={28}
          color={colors.textTertiary}
        />
      </View>
      <Text style={styles.emptyTitle}>
        {reviewedToday > 0 ? 'All done for today' : 'No cards due'}
      </Text>
      <Text style={styles.emptySubtitle}>
        {reviewedToday > 0
          ? `Reviewed ${reviewedToday} card${reviewedToday === 1 ? '' : 's'}. Come back tomorrow.`
          : 'Confirm a session in Sessions to start building your spaced-repetition deck.'}
      </Text>
    </View>
  );
}

function Flashcard({ card }: { card: CardModel }) {
  const date = new Date(card.created_at).toLocaleDateString();
  return (
    <Card style={styles.flashcard}>
      <Text style={styles.cardChunk}>{card.chunk}</Text>
      <View style={styles.cardMetaRow}>
        <Image
          source={{ uri: card.photo_thumbnail_uri }}
          style={styles.cardThumb}
        />
        <Text style={styles.cardMeta}>From session · {date}</Text>
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
  ratingHint: {
    ...text.caption,
    color: colors.textTertiary,
    textAlign: 'center',
  },
});
