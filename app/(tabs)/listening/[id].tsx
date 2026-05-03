import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Card } from '../../../src/components/Card';
import { Pill } from '../../../src/components/Pill';
import {
  usePlayer,
  type PlaybackSpeed,
} from '../../../src/context/player';
import { getSession } from '../../../src/db/sessions';
import { tracksFromSession } from '../../../src/services/queue';
import { colors, radius, spacing, text } from '../../../src/theme';
import type { Session } from '../../../src/types';

const SPEEDS: PlaybackSpeed[] = [0.75, 1, 1.25];

export default function PlayerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSession(id);
      if (!cancelled) {
        setSession(s);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <Stack.Screen options={{ title: 'Player' }} />
        <ActivityIndicator color={colors.textTertiary} />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={[styles.container, styles.center]}>
        <Stack.Screen options={{ title: 'Player' }} />
        <Text style={text.cardTitle}>Session not found</Text>
      </View>
    );
  }

  return <PlayerView session={session} />;
}

function PlayerView({ session }: { session: Session }) {
  const player = usePlayer();
  const sentences = session.polished_sentences;
  const audioUris = session.sentence_audio_uris;

  // Is this session the one currently in the global queue?
  const sessionIsCurrent = player.current?.sessionId === session.id;

  // Map current global track back to this session's local sentence index.
  const activeLocalIndex = useMemo(() => {
    if (!sessionIsCurrent || !player.current) return -1;
    return player.current.sentenceIndex;
  }, [sessionIsCurrent, player.current]);

  const startThisSession = (sentenceIndex: number) => {
    const tracks = tracksFromSession(session);
    if (tracks.length === 0) return;
    player.loadQueue(tracks, sentenceIndex);
  };

  const handlePlayPauseTap = () => {
    if (sessionIsCurrent) {
      player.togglePlay();
    } else {
      startThisSession(0);
    }
  };

  const handleSentenceTap = (i: number) => {
    if (sessionIsCurrent) {
      const globalIdx = player.queue.findIndex(
        (t) => t.sessionId === session.id && t.sentenceIndex === i
      );
      if (globalIdx >= 0) player.jumpTo(globalIdx);
    } else {
      startThisSession(i);
    }
  };

  const handleNextTap = () => {
    if (sessionIsCurrent) player.next();
  };

  const handlePrevTap = () => {
    if (sessionIsCurrent) player.prev();
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Player' }} />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Image
          source={{ uri: session.photo_uri }}
          style={styles.photo}
          contentFit="cover"
        />

        {audioUris.length === 0 ? (
          <Card padding="lg">
            <Text style={text.body}>
              No audio yet. Confirm & Generate this session in the Sessions
              tab to create the podcast.
            </Text>
          </Card>
        ) : (
          <>
            <Card style={styles.sentenceCard} padding="md">
              {sentences.map((s, i) => {
                const active = i === activeLocalIndex;
                return (
                  <Pressable
                    key={i}
                    onPress={() => handleSentenceTap(i)}
                    style={({ pressed }) => [
                      styles.sentenceRow,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View
                      style={[
                        styles.activeBar,
                        active && styles.activeBarOn,
                      ]}
                    />
                    <Text
                      style={[
                        styles.sentenceText,
                        active && styles.sentenceTextActive,
                      ]}
                    >
                      {s}
                    </Text>
                  </Pressable>
                );
              })}
            </Card>

            <View style={styles.speedRow}>
              {SPEEDS.map((s) => (
                <Pill
                  key={s}
                  label={`${s}×`}
                  active={player.speed === s}
                  onPress={() => player.setSpeed(s)}
                />
              ))}
            </View>

            <View style={styles.controls}>
              <ControlButton
                icon="play-skip-back"
                onPress={handlePrevTap}
                disabled={!sessionIsCurrent || player.currentIndex === 0}
              />
              <Pressable
                onPress={handlePlayPauseTap}
                style={({ pressed }) => [
                  styles.playButton,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Ionicons
                  name={
                    sessionIsCurrent && player.isPlaying ? 'pause' : 'play'
                  }
                  size={28}
                  color={colors.textPrimary}
                />
              </Pressable>
              <ControlButton
                icon="play-skip-forward"
                onPress={handleNextTap}
                disabled={
                  !sessionIsCurrent ||
                  player.currentIndex >= player.queue.length - 1
                }
              />
            </View>

            <Pressable
              onPress={player.toggleLoopMode}
              style={({ pressed }) => [
                styles.modeToggle,
                player.loopSingle && styles.modeToggleActive,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons
                name="repeat"
                size={16}
                color={
                  player.loopSingle ? colors.accentText : colors.textSecondary
                }
              />
              <Text
                style={[
                  styles.modeToggleLabel,
                  player.loopSingle && styles.modeToggleLabelActive,
                ]}
              >
                {player.loopSingle ? 'Looping current sentence' : 'Play through'}
              </Text>
            </Pressable>

            {!sessionIsCurrent && (
              <Text style={styles.tapHint}>
                Tap any sentence to start there.
              </Text>
            )}
            {sessionIsCurrent && player.queue.length > sentences.length && (
              <Text style={styles.tapHint}>
                Playing all podcasts in sequence ({player.currentIndex + 1} of
                {' '}
                {player.queue.length})
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ControlButton({
  icon,
  onPress,
  disabled,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.sideButton,
        pressed && !disabled && { opacity: 0.7 },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Ionicons name={icon} size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  photo: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.card,
    backgroundColor: colors.pillBg,
  },
  sentenceCard: {
    paddingVertical: spacing.md,
  },
  sentenceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    gap: spacing.md,
  },
  activeBar: {
    width: 2,
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
    borderRadius: 1,
  },
  activeBarOn: {
    backgroundColor: colors.accent,
  },
  sentenceText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textTertiary,
  },
  sentenceTextActive: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  speedRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.lg,
  },
  sideButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.pillBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.pillBg,
  },
  modeToggleActive: {
    backgroundColor: colors.accentBgSoft,
  },
  modeToggleLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  modeToggleLabelActive: {
    color: colors.accentText,
  },
  tapHint: {
    ...text.caption,
    color: colors.textTertiary,
    textAlign: 'center',
  },
});
