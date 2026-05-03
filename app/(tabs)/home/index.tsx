import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import { countMasteredCards, listCardsDueBy } from '../../../src/db/cards';
import {
  getCurrentStreak,
  getListeningSecondsBetween,
  getStatsRange,
  getTotalListeningSeconds,
} from '../../../src/db/stats';
import { colors, spacing, text } from '../../../src/theme';

const WEEK_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

interface HomeStats {
  streak: number;
  weekDoneFlags: boolean[];
  weekListeningSeconds: number;
  totalListeningSeconds: number;
  cardsMastered: number;
  cardsDueToday: number;
}

const ZERO_STATS: HomeStats = {
  streak: 0,
  weekDoneFlags: [false, false, false, false, false, false, false],
  weekListeningSeconds: 0,
  totalListeningSeconds: 0,
  cardsMastered: 0,
  cardsDueToday: 0,
};

export default function HomeScreen() {
  const [stats, setStats] = useState<HomeStats>(ZERO_STATS);
  const greeting = currentGreeting();
  const todayIndex = (new Date().getDay() + 6) % 7; // Mon=0..Sun=6

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const next = await loadHomeStats();
        if (!cancelled) setStats(next);
      })();
      return () => {
        cancelled = true;
      };
    }, [])
  );

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
            <Text style={styles.streakNumber}>{stats.streak}</Text>
            <Text style={styles.streakUnit}>
              day{stats.streak === 1 ? '' : 's'}
            </Text>
          </View>

          <View style={styles.weekStrip}>
            {WEEK_LABELS.map((label, i) => {
              const done = stats.weekDoneFlags[i];
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
          <StatRow
            label="This week"
            value={formatMinutes(stats.weekListeningSeconds)}
          />
          <StatRow
            label="All time"
            value={formatMinutes(stats.totalListeningSeconds)}
          />
          <StatRow label="Cards mastered" value={String(stats.cardsMastered)} />
          <StatRow
            label="Cards due today"
            value={String(stats.cardsDueToday)}
            hideDivider
          />
        </Card>

        {stats.streak === 0 && (
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
        )}
      </ScrollView>
    </Screen>
  );
}

async function loadHomeStats(): Promise<HomeStats> {
  const now = new Date();
  const today = isoDay(now);
  const monday = startOfWeekMonday(now);
  const mondayIso = isoDay(monday);

  const [
    streak,
    weekRows,
    weekListening,
    totalListening,
    cardsMastered,
    dueCards,
  ] = await Promise.all([
    getCurrentStreak(today),
    getStatsRange(mondayIso, today),
    getListeningSecondsBetween(mondayIso, today),
    getTotalListeningSeconds(),
    countMasteredCards(),
    listCardsDueBy(now.toISOString()),
  ]);

  const doneSet = new Set(
    weekRows.filter((r) => r.session_count > 0).map((r) => r.date)
  );
  const weekDoneFlags: boolean[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    weekDoneFlags.push(doneSet.has(isoDay(d)));
  }

  return {
    streak,
    weekDoneFlags,
    weekListeningSeconds: weekListening,
    totalListeningSeconds: totalListening,
    cardsMastered,
    cardsDueToday: dueCards.length,
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeekMonday(d: Date): Date {
  // UTC-based to match how stats rows are keyed (toISOString().slice(0,10)).
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const dayOfWeek = (monday.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  monday.setUTCDate(monday.getUTCDate() - dayOfWeek);
  return monday;
}

function formatMinutes(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
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
