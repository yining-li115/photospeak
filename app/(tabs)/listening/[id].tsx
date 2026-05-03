import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card } from '../../../src/components/Card';
import { Pill } from '../../../src/components/Pill';
import { colors, radius, spacing, text } from '../../../src/theme';

const PLACEHOLDER_SENTENCES = [
  'The photo captures a quiet morning street washed in golden light.',
  'A woman in a long coat is walking past the bakery on the corner.',
  'Her shadow stretches across the cobblestones, long and thin.',
];

export default function PlayerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const activeIndex = 1;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Player' }} />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.photoPlaceholder}>
          <Ionicons
            name="image-outline"
            size={36}
            color={colors.textTertiary}
          />
        </View>

        <Card style={styles.sentenceCard} padding="md">
          {PLACEHOLDER_SENTENCES.map((s, i) => (
            <View key={i} style={styles.sentenceRow}>
              <View
                style={[
                  styles.activeBar,
                  i === activeIndex && styles.activeBarOn,
                ]}
              />
              <Text
                style={[
                  styles.sentenceText,
                  i === activeIndex && styles.sentenceTextActive,
                ]}
              >
                {s}
              </Text>
            </View>
          ))}
        </Card>

        <View style={styles.speedRow}>
          <Pill label="0.75×" onPress={() => {}} />
          <Pill label="1×" active onPress={() => {}} />
          <Pill label="1.25×" onPress={() => {}} />
        </View>

        <View style={styles.controls}>
          <ControlButton icon="play-skip-back" />
          <View style={styles.playButton}>
            <Ionicons name="play" size={26} color={colors.textPrimary} />
          </View>
          <ControlButton icon="play-skip-forward" />
        </View>

        <Text style={styles.note}>id: {id}</Text>
        <Text style={styles.placeholderNote}>
          Player UI is a Phase 2 placeholder — Step 11 will wire real audio
          playback.
        </Text>
      </ScrollView>
    </View>
  );
}

function ControlButton({
  icon,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
}) {
  return (
    <View style={styles.sideButton}>
      <Ionicons name={icon} size={20} color={colors.textSecondary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  photoPlaceholder: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.card,
    backgroundColor: colors.pillBg,
    alignItems: 'center',
    justifyContent: 'center',
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
  note: {
    ...text.caption,
    textAlign: 'center',
  },
  placeholderNote: {
    ...text.caption,
    color: colors.textTertiary,
    textAlign: 'center',
  },
});
