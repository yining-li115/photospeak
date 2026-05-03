import { Ionicons } from '@expo/vector-icons';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import { colors, radius, spacing, text } from '../../../src/theme';

const WEEK_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export default function HomeScreen() {
  const greeting = currentGreeting();
  // Placeholder data — wired to real stats in Step 15.
  const streak: number = 0;
  const completedThisWeek = [false, false, false, false, false, false, false];
  const todayIndex = (new Date().getDay() + 6) % 7;

  return (
    <Screen>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.appLogo}>
          Photo<Text style={styles.appLogoBold}> Speak</Text>
        </Text>

        <View style={styles.greetingRow}>
          <Text style={styles.greeting}>{greeting}</Text>
        </View>

        <Card style={styles.streakCard}>
          <Text style={styles.sectionLabel}>Current streak</Text>
          <View style={styles.streakNumberRow}>
            <Text style={styles.streakNumber}>{streak}</Text>
            <Text style={styles.streakUnit}>day{streak === 1 ? '' : 's'}</Text>
          </View>

          <View style={styles.weekStrip}>
            {WEEK_LABELS.map((label, i) => {
              const done = completedThisWeek[i];
              const isToday = i === todayIndex;
              return (
                <View key={i} style={styles.dayCell}>
                  <View
                    style={[
                      styles.dayDot,
                      done && styles.dayDotDone,
                      isToday && !done && styles.dayDotToday,
                    ]}
                  />
                  <Text
                    style={[
                      styles.dayLabel,
                      isToday && styles.dayLabelToday,
                    ]}
                  >
                    {label}
                  </Text>
                </View>
              );
            })}
          </View>
        </Card>

        <Card style={styles.statsCard}>
          <StatRow label="This week" value="0 min" />
          <StatRow label="All time" value="0 min" />
          <StatRow label="Cards mastered" value="0" />
          <StatRow label="Cards due today" value="0" hideDivider />
        </Card>

        <Card style={styles.tipCard}>
          <View style={styles.tipIcon}>
            <Ionicons
              name="sparkles-outline"
              size={18}
              color={colors.accentText}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.tipTitle}>Start your first session</Text>
            <Text style={styles.tipBody}>
              Pick a photo, describe it in English for about a minute, and
              the AI will help you polish it.
            </Text>
          </View>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function StatRow({
  label,
  value,
  hideDivider,
}: {
  label: string;
  value: string;
  hideDivider?: boolean;
}) {
  return (
    <View style={[styles.statRow, !hideDivider && styles.statRowDivider]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function currentGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: {
    padding: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  appLogo: {
    ...text.hero,
    fontSize: 24,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  appLogoBold: {
    fontWeight: '700',
  },
  greetingRow: {
    marginBottom: spacing.sm,
  },
  greeting: {
    ...text.greeting,
  },
  sectionLabel: {
    ...text.micro,
  },
  streakCard: {
    paddingVertical: spacing.lg,
  },
  streakNumberRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  streakNumber: {
    ...text.streakNumber,
  },
  streakUnit: {
    ...text.body,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  weekStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  dayCell: {
    alignItems: 'center',
    gap: 6,
  },
  dayDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.pillBg,
  },
  dayDotDone: {
    backgroundColor: colors.accent,
  },
  dayDotToday: {
    backgroundColor: colors.bg,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  dayLabel: {
    fontSize: 11,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  dayLabelToday: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  statsCard: {
    paddingVertical: spacing.sm,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  statRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  statLabel: {
    ...text.body,
    color: colors.textSecondary,
  },
  statValue: {
    ...text.body,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  tipCard: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  tipIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accentBgSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tipTitle: {
    ...text.cardTitle,
    marginBottom: 4,
  },
  tipBody: {
    ...text.caption,
    lineHeight: 19,
  },
});
