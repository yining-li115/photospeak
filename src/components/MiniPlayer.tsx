import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePlayer } from '../context/player';
import { colors, radius, shadow, spacing } from '../theme';

export function MiniPlayer() {
  const player = usePlayer();
  const router = useRouter();
  const pathname = usePathname();

  if (!player.current) return null;

  // Hide on the full player screen so we don't double up.
  const onPlayerScreen = pathname?.startsWith(
    `/listening/${player.current.sessionId}`
  );
  if (onPlayerScreen) return null;

  const goToPlayer = () => {
    router.push(`/listening/${player.current!.sessionId}`);
  };

  return (
    <Pressable
      onPress={goToPlayer}
      style={({ pressed }) => [
        styles.container,
        pressed && { opacity: 0.95 },
      ]}
    >
      <Image
        source={{ uri: player.current.photoThumbnailUri }}
        style={styles.thumb}
      />
      <View style={styles.text}>
        <Text style={styles.sentence} numberOfLines={1}>
          {player.current.sentenceText}
        </Text>
        <View style={styles.metaRow}>
          {player.loopSingle && (
            <Ionicons name="repeat" size={11} color={colors.accentText} />
          )}
          <Text style={styles.meta} numberOfLines={1}>
            {`${player.currentIndex + 1} / ${player.queue.length}`}
            {player.loopSingle ? ' · loop' : ''}
          </Text>
        </View>
      </View>
      <Pressable
        onPress={(e) => {
          e.stopPropagation();
          player.togglePlay();
        }}
        hitSlop={10}
        style={({ pressed }) => [
          styles.playButton,
          pressed && { opacity: 0.85 },
        ]}
      >
        <Ionicons
          name={player.isPlaying ? 'pause' : 'play'}
          size={18}
          color={colors.textPrimary}
        />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    gap: spacing.md,
    ...shadow,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: radius.thumb,
    backgroundColor: colors.pillBg,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  sentence: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  meta: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
