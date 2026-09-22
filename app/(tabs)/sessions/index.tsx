import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Swipeable,
  RectButton,
} from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card } from '../../../src/components/Card';
import { usePlayer } from '../../../src/context/player';
import { countCardsBySession } from '../../../src/db/cards';
import {
  listSessionSummaries,
  type SessionCursor,
  type SessionSummary,
} from '../../../src/db/sessions';
import { deleteSessionCascade } from '../../../src/services/delete';
import { colors, radius, spacing, text } from '../../../src/theme';

const PAGE_SIZE = 30;

export default function SessionsScreen() {
  const router = useRouter();
  const player = usePlayer();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<SessionCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

  const reload = useCallback(async () => {
    const page = await listSessionSummaries({ limit: PAGE_SIZE });
    setSessions(page.items);
    setNextCursor(page.nextCursor);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          await reload();
        } catch (error) {
          if (!cancelled) {
            Alert.alert(
              'Could not load sessions',
              error instanceof Error ? error.message : String(error)
            );
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [reload])
  );

  const startNewSession = () => {
    const id = Crypto.randomUUID();
    router.push(`/sessions/${id}`);
  };

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await listSessionSummaries({
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setSessions((previous) => {
        const known = new Set(previous.map((item) => item.id));
        return [
          ...previous,
          ...page.items.filter((item) => !known.has(item.id)),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      Alert.alert(
        'Could not load more sessions',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor]);

  const confirmDelete = async (session: SessionSummary) => {
    const cardCount = await countCardsBySession(session.id);
    const podcastNote =
      session.podcast_generated && session.sentence_count > 0
        ? `Its podcast in Listening`
        : null;
    const cardsNote =
      cardCount > 0
        ? `${cardCount} card${cardCount === 1 ? '' : 's'} in Cards`
        : null;
    const both = [podcastNote, cardsNote].filter(Boolean).join(' and ');
    const message = both
      ? `${both} will also be deleted. This can't be undone.`
      : `This can't be undone.`;

    Alert.alert('Delete this session?', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            // If the player is currently using this session, silence native
            // playback before removing files from beneath its queue.
            if (player.queue.some((track) => track.sessionId === session.id)) {
              await player.stop();
            }
            await deleteSessionCascade(session.id);
            await reload();
          } catch (e) {
            Alert.alert(
              'Delete failed',
              e instanceof Error ? e.message : String(e)
            );
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Sessions</Text>
        <Pressable
          onPress={startNewSession}
          hitSlop={12}
          accessibilityLabel="Start new session"
          style={({ pressed }) => [
            styles.addButton,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.addButtonGlyph}>+</Text>
        </Pressable>
      </View>

      {loading ? null : sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              onPress={() => router.push(`/sessions/${item.id}`)}
              onRequestDelete={() => confirmDelete(item)}
            />
          )}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator
                style={styles.listFooter}
                color={colors.textTertiary}
              />
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

function EmptyState() {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name="camera-outline" size={28} color={colors.textTertiary} />
      </View>
      <Text style={styles.emptyTitle}>No sessions yet</Text>
      <Text style={styles.emptySubtitle}>
        Tap the + above to describe your first photo.
      </Text>
    </View>
  );
}

function SessionRow({
  session,
  onPress,
  onRequestDelete,
}: {
  session: SessionSummary;
  onPress: () => void;
  onRequestDelete: () => void;
}) {
  const swipeRef = useRef<Swipeable>(null);
  const date = new Date(session.created_at).toLocaleDateString();
  const firstChunk = session.summary_title || 'New session';

  const renderRightActions = () => (
    <RectButton
      style={styles.deleteAction}
      onPress={() => {
        swipeRef.current?.close();
        onRequestDelete();
      }}
    >
      <Ionicons name="trash-outline" size={20} color="#fff" />
      <Text style={styles.deleteActionLabel}>Delete</Text>
    </RectButton>
  );

  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      overshootRight={false}
      friction={2}
      rightThreshold={40}
    >
      <Pressable
        onPress={onPress}
        style={({ pressed }) => pressed && { opacity: 0.85 }}
      >
        <Card style={styles.row} padding="md">
          <Image
            source={{ uri: session.photo_thumbnail_uri }}
            style={styles.thumb}
          />
          <View style={styles.rowText}>
            <Text style={styles.rowDate}>{date}</Text>
            <Text style={styles.rowChunk} numberOfLines={1}>
              {firstChunk}
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={18}
            color={colors.textTertiary}
          />
        </Card>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  headerTitle: {
    ...text.screenTitle,
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonGlyph: {
    fontSize: 24,
    fontWeight: '900',
    color: colors.textPrimary,
    lineHeight: 26,
    marginTop: -2,
  },
  listContent: {
    padding: spacing.lg,
    paddingTop: 0,
  },
  listFooter: {
    paddingVertical: spacing.lg,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.pillBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  emptyTitle: {
    ...text.cardTitle,
    fontSize: 17,
    marginBottom: 4,
  },
  emptySubtitle: {
    ...text.caption,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radius.thumb,
    backgroundColor: colors.pillBg,
  },
  rowText: {
    flex: 1,
  },
  rowDate: {
    ...text.cardTitle,
  },
  rowChunk: {
    ...text.caption,
    marginTop: 2,
  },
  deleteAction: {
    width: 88,
    backgroundColor: colors.rating.againText,
    borderRadius: radius.card,
    marginLeft: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  deleteActionLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});
