import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import { listCardsDueBy, updateCard } from '../../../src/db/cards';
import { incrementCardsReviewed } from '../../../src/db/stats';
import { scheduleCard, type CardRating } from '../../../src/srs/fsrs';
import { colors, radius, spacing, text } from '../../../src/theme';
import type { Card as CardModel } from '../../../src/types';

const RATINGS: {
  label: string;
  rating: CardRating;
  bg: string;
  fg: string;
}[] = [
  { label: 'Again', rating: 1, bg: colors.rating.againBg, fg: colors.rating.againText },
  { label: 'Hard', rating: 2, bg: colors.rating.hardBg, fg: colors.rating.hardText },
  { label: 'Good', rating: 3, bg: colors.rating.goodBg, fg: colors.rating.goodText },
  { label: 'Easy', rating: 4, bg: colors.rating.easyBg, fg: colors.rating.easyText },
];

export default function CardsScreen() {
  const [dueCards, setDueCards] = useState<CardModel[]>([]);
  const [reviewedToday, setReviewedToday] = useState(0);
  const [loading, setLoading] = useState(true);
  const [flipped, setFlipped] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const now = new Date().toISOString();
        const due = await listCardsDueBy(now);
        if (!cancelled) {
          setDueCards(due);
          setReviewedToday(0);
          setFlipped(false);
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

  const handleRate = async (rating: CardRating) => {
    const card = currentCard;
    if (!card) return;

    setDueCards((prev) => prev.slice(1));
    setReviewedToday((n) => n + 1);
    setFlipped(false);

    try {
      const update = scheduleCard(card, rating);
      await updateCard(card.id, update);
      const today = new Date().toISOString().slice(0, 10);
      await incrementCardsReviewed(today);
    } catch (e) {
      Alert.alert(
        'Could not save review',
        e instanceof Error ? e.message : String(e)
      );
    }
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
            <Flashcard
              key={currentCard.id}
              card={currentCard}
              flipped={flipped}
              onFlip={() => setFlipped((f) => !f)}
            />
            {flipped ? (
              <View style={styles.ratingRow}>
                {RATINGS.map((r) => (
                  <Pressable
                    key={r.label}
                    onPress={() => handleRate(r.rating)}
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
            ) : (
              <Text style={styles.flipHint}>Tap the card to see usage</Text>
            )}
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

interface FlashcardProps {
  card: CardModel;
  flipped: boolean;
  onFlip: () => void;
}

function Flashcard({ card, flipped, onFlip }: FlashcardProps) {
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withTiming(flipped ? 180 : 0, { duration: 420 });
  }, [flipped, rotation]);

  const frontStyle = useAnimatedStyle(() => ({
    transform: [
      { perspective: 1000 },
      { rotateY: `${rotation.value}deg` },
    ],
    opacity: interpolate(
      rotation.value,
      [0, 89, 90, 180],
      [1, 1, 0, 0],
      Extrapolation.CLAMP
    ),
  }));

  const backStyle = useAnimatedStyle(() => ({
    transform: [
      { perspective: 1000 },
      { rotateY: `${rotation.value - 180}deg` },
    ],
    opacity: interpolate(
      rotation.value,
      [0, 90, 91, 180],
      [0, 0, 1, 1],
      Extrapolation.CLAMP
    ),
  }));

  return (
    <Pressable onPress={onFlip} style={styles.flipContainer}>
      <Animated.View style={[styles.flipFace, frontStyle]} pointerEvents="none">
        <CardFront card={card} />
      </Animated.View>
      <Animated.View style={[styles.flipFace, styles.flipBackPos, backStyle]}>
        <CardBack card={card} />
      </Animated.View>
    </Pressable>
  );
}

function CardFront({ card }: { card: CardModel }) {
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

function CardBack({ card }: { card: CardModel }) {
  return (
    <Card style={styles.flashcardBack}>
      <View style={styles.backHeader}>
        <Text style={styles.backChunk}>{card.chunk}</Text>
      </View>

      {card.usage_note ? (
        <View style={styles.backSection}>
          <Text style={styles.backSectionLabel}>Usage</Text>
          <Text style={styles.backUsageText}>{card.usage_note}</Text>
        </View>
      ) : null}

      {card.examples.length > 0 && (
        <View style={styles.backSection}>
          <Text style={styles.backSectionLabel}>Examples</Text>
          {card.examples.map((ex, i) => (
            <View key={i} style={styles.exampleRow}>
              <Text style={styles.exampleText}>{ex.text}</Text>
            </View>
          ))}
        </View>
      )}
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
  flipContainer: {
    minHeight: 320,
  },
  flipFace: {
    width: '100%',
  },
  flipBackPos: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  flashcard: {
    minHeight: 320,
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
  flashcardBack: {
    minHeight: 320,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  backHeader: {
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  backChunk: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.accentText,
  },
  backSection: {
    gap: 6,
  },
  backSectionLabel: {
    ...text.micro,
  },
  backUsageText: {
    ...text.body,
  },
  exampleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 6,
  },
  exampleText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textPrimary,
  },
  flipHint: {
    ...text.caption,
    color: colors.textTertiary,
    textAlign: 'center',
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
