import { Ionicons } from '@expo/vector-icons';
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card } from '../../../src/components/Card';
import { usePlayer } from '../../../src/context/player';
import {
  getSession,
  listSessionSummaries,
  type SessionCursor,
  type SessionSummary,
} from '../../../src/db/sessions';
import {
  tracksFromSession,
  tracksFromSessions,
} from '../../../src/services/queue';
import { colors, radius, spacing, text } from '../../../src/theme';

const PAGE_SIZE = 30;
const PLAY_RECENT_SESSION_LIMIT = 10;

export default function ListeningScreen() {
  const router = useRouter();
  const player = usePlayer();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<SessionCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const loadingMoreRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const page = await listSessionSummaries({
            limit: PAGE_SIZE,
            podcastOnly: true,
          });
          if (!cancelled) {
            setSessions(page.items);
            setNextCursor(page.nextCursor);
          }
        } catch (error) {
          if (!cancelled) {
            Alert.alert(
              'Could not load podcasts',
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
    }, [])
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await listSessionSummaries({
        limit: PAGE_SIZE,
        cursor: nextCursor,
        podcastOnly: true,
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
        'Could not load more podcasts',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor]);

  const playRow = async (summary: SessionSummary) => {
    if (loadingSessionId || loadingQueue) return;
    setLoadingSessionId(summary.id);
    try {
      const session = await getSession(summary.id, { chatLimit: 0 });
      if (!session) throw new Error('Session not found');
      const queue = tracksFromSession(session);
      if (queue.length === 0) throw new Error('This podcast has no playable audio');
      if (await player.loadQueue(queue, 0)) {
        router.push(`/listening/${summary.id}`);
      } else {
        throw new Error('The audio player could not start');
      }
    } catch (error) {
      Alert.alert(
        'Could not play podcast',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setLoadingSessionId(null);
    }
  };

  const playRecent = async () => {
    if (loadingQueue || loadingSessionId || sessions.length === 0) return;
    setLoadingQueue(true);
    try {
      const loaded = await Promise.all(
        sessions
          .slice(0, PLAY_RECENT_SESSION_LIMIT)
          .map((summary) => getSession(summary.id, { chatLimit: 0 }))
      );
      const playable = loaded.filter((session) => session !== null);
      const queue = tracksFromSessions(playable);
      if (queue.length === 0) throw new Error('No playable audio was found');
      if (await player.loadQueue(queue, 0)) {
        router.push(`/listening/${queue[0].sessionId}`);
      } else {
        throw new Error('The audio player could not start');
      }
    } catch (error) {
      Alert.alert(
        'Could not start playback',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setLoadingQueue(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Listening</Text>
        {sessions.length > 1 && (
          <Pressable
            onPress={() => void playRecent()}
            disabled={loadingQueue || loadingSessionId !== null}
            hitSlop={12}
            accessibilityLabel="Play all podcasts"
            style={({ pressed }) => [
              styles.playAllPill,
              pressed && { opacity: 0.85 },
            ]}
          >
            {loadingQueue ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <Ionicons name="play" size={12} color={colors.textPrimary} />
            )}
            <Text style={styles.playAllLabel}>Play recent</Text>
          </Pressable>
        )}
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
            <PodcastRow
              session={item}
              isCurrent={
                player.current?.sessionId === item.id && player.isPlaying
              }
              loading={loadingSessionId === item.id}
              onPress={() => void playRow(item)}
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

function PodcastRow({
  session,
  isCurrent,
  loading,
  onPress,
}: {
  session: SessionSummary;
  isCurrent: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  const date = new Date(session.created_at).toLocaleDateString();
  const sentenceCount = session.sentence_count;
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => pressed && { opacity: 0.85 }}
    >
      <Card style={styles.row} padding="md">
        <Image
          source={{ uri: session.photo_thumbnail_uri }}
          style={styles.thumb}
        />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{date}</Text>
          <Text style={styles.rowMeta}>
            {sentenceCount} sentence{sentenceCount === 1 ? '' : 's'}
            {isCurrent ? ' · now playing' : ''}
          </Text>
        </View>
        <View style={styles.playBadge}>
          {loading ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <Ionicons
              name={isCurrent ? 'pause' : 'play'}
              size={14}
              color={colors.textPrimary}
            />
          )}
        </View>
      </Card>
    </Pressable>
  );
}

function EmptyState() {
  return (
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
  listContent: {
    padding: spacing.lg,
    paddingTop: 0,
  },
  listFooter: {
    paddingVertical: spacing.lg,
  },
  playAllPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.accent,
    borderRadius: 999,
  },
  playAllLabel: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
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
  rowTitle: {
    ...text.cardTitle,
  },
  rowMeta: {
    ...text.caption,
    marginTop: 2,
  },
  playBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
