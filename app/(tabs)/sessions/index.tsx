import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
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
import { listSessions } from '../../../src/db/sessions';
import { colors, radius, spacing, text } from '../../../src/theme';
import type { Session } from '../../../src/types';

export default function SessionsScreen() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const rows = await listSessions();
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

  const startNewSession = () => {
    const id = Crypto.randomUUID();
    router.push(`/sessions/${id}`);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Sessions',
          headerRight: () => (
            <TouchableOpacity
              onPress={startNewSession}
              hitSlop={12}
              accessibilityLabel="Start new session"
            >
              <View style={styles.addButton}>
                <Ionicons name="add" size={22} color={colors.textPrimary} />
              </View>
            </TouchableOpacity>
          ),
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
            <SessionRow
              session={item}
              onPress={() => router.push(`/sessions/${item.id}`)}
            />
          )}
        />
      )}
    </View>
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
}: {
  session: Session;
  onPress: () => void;
}) {
  const date = new Date(session.created_at).toLocaleDateString();
  const firstChunk = session.chunks[0]?.chunk ?? 'New session';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.85 }}>
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
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  addButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    padding: spacing.lg,
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
});
