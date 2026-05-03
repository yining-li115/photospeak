import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Card } from '../../../src/components/Card';
import { usePlayer } from '../../../src/context/player';
import { listSessionsWithPodcast } from '../../../src/db/sessions';
import {
  tracksFromSession,
  tracksFromSessions,
} from '../../../src/services/queue';
import { colors, radius, spacing, text } from '../../../src/theme';
import type { Session } from '../../../src/types';

export default function ListeningScreen() {
  const router = useRouter();
  const player = usePlayer();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const rows = await listSessionsWithPodcast();
        if (!cancelled) {
          setSessions(rows);
          setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [])
  );

  const playRow = (session: Session) => {
    const queue = tracksFromSession(session);
    if (queue.length === 0) return;
    player.loadQueue(queue, 0);
    router.push(`/listening/${session.id}`);
  };

  const playAll = () => {
    const queue = tracksFromSessions(sessions);
    if (queue.length === 0) return;
    player.loadQueue(queue, 0);
    router.push(`/listening/${sessions[0].id}`);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Listening',
          headerRight: () =>
            sessions.length > 1 ? (
              <TouchableOpacity onPress={playAll} hitSlop={12}>
                <View style={styles.playAllPill}>
                  <Ionicons
                    name="play"
                    size={12}
                    color={colors.textPrimary}
                  />
                  <Text style={styles.playAllLabel}>Play all</Text>
                </View>
              </TouchableOpacity>
            ) : null,
        }}
      />

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
              onPress={() => playRow(item)}
            />
          )}
        />
      )}
    </View>
  );
}

function PodcastRow({
  session,
  isCurrent,
  onPress,
}: {
  session: Session;
  isCurrent: boolean;
  onPress: () => void;
}) {
  const date = new Date(session.created_at).toLocaleDateString();
  const sentenceCount = session.polished_sentences.length;
  return (
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
          <Text style={styles.rowTitle}>{date}</Text>
          <Text style={styles.rowMeta}>
            {sentenceCount} sentence{sentenceCount === 1 ? '' : 's'}
            {isCurrent ? ' · now playing' : ''}
          </Text>
        </View>
        <View style={styles.playBadge}>
          <Ionicons
            name={isCurrent ? 'pause' : 'play'}
            size={14}
            color={colors.textPrimary}
          />
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
  listContent: {
    padding: spacing.lg,
  },
  playAllPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
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
