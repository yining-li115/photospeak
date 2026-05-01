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
import { listSessions } from '../../../src/db/sessions';
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
              <Ionicons name="add" size={28} color="#0a84ff" />
            </TouchableOpacity>
          ),
        }}
      />
      {loading ? null : sessions.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No sessions yet</Text>
          <Text style={styles.emptySubtitle}>
            Tap + to describe your first photo
          </Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
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

function SessionRow({
  session,
  onPress,
}: {
  session: Session;
  onPress: () => void;
}) {
  const date = new Date(session.created_at).toLocaleDateString();
  const firstChunk = session.chunks[0]?.chunk ?? '—';
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Image source={{ uri: session.photo_thumbnail_uri }} style={styles.thumb} />
      <View style={styles.rowText}>
        <Text style={styles.rowDate}>{date}</Text>
        <Text style={styles.rowChunk} numberOfLines={1}>
          {firstChunk}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 14,
    opacity: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#eee',
  },
  rowText: {
    flex: 1,
    marginLeft: 12,
  },
  rowDate: {
    fontSize: 14,
    fontWeight: '600',
  },
  rowChunk: {
    fontSize: 13,
    opacity: 0.7,
    marginTop: 2,
  },
});
