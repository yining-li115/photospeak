import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
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
import { getSession } from '../../../src/db/sessions';
import {
  useSentencePlayer,
  type PlaybackSpeed,
} from '../../../src/hooks/useSentencePlayer';
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
  const sentences = session.polished_sentences;
  const audioUris = session.sentence_audio_uris;
  const player = useSentencePlayer(audioUris);

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
                const active = i === player.currentIndex;
                const looping = active && player.loopSingle;
                return (
                  <Pressable
                    key={i}
                    onPress={() => player.playFrom(i, { loop: true })}
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
                    <View style={styles.sentenceTextWrap}>
                      <Text
                        style={[
                          styles.sentenceText,
                          active && styles.sentenceTextActive,
                        ]}
                      >
                        {s}
                      </Text>
                      {looping && (
                        <View style={styles.loopTag}>
                          <Ionicons
                            name="repeat"
                            size={12}
                            color={colors.accentText}
                          />
                          <Text style={styles.loopTagText}>Looping</Text>
                        </View>
                      )}
                    </View>
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
                onPress={player.prev}
                disabled={player.currentIndex === 0}
              />
              <Pressable
                onPress={player.togglePlay}
                style={({ pressed }) => [
                  styles.playButton,
                  pressed && { opacity: 0.85 },
                  !player.isLoaded && { opacity: 0.5 },
                ]}
                disabled={!player.isLoaded}
              >
                <Ionicons
                  name={player.isPlaying ? 'pause' : 'play'}
                  size={28}
                  color={colors.textPrimary}
                />
              </Pressable>
              <ControlButton
                icon="play-skip-forward"
                onPress={player.next}
                disabled={player.currentIndex >= sentences.length - 1}
              />
            </View>

            <Text style={styles.tapHint}>
              Tap any sentence to loop it. Tap again to stop looping with
              prev/next.
            </Text>
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
  sentenceTextWrap: {
    flex: 1,
  },
  sentenceText: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textTertiary,
  },
  sentenceTextActive: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  loopTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    alignSelf: 'flex-start',
    backgroundColor: colors.accentBgSoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  loopTagText: {
    fontSize: 11,
    color: colors.accentText,
    fontWeight: '600',
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
  tapHint: {
    ...text.caption,
    color: colors.textTertiary,
    textAlign: 'center',
  },
});
