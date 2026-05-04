import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import { useAuth } from '../../../src/context/auth';
import { countMasteredCards, listCardsDueBy } from '../../../src/db/cards';
import {
  getCurrentStreak,
  getListeningSecondsBetween,
  getStatsRange,
  getTotalListeningSeconds,
} from '../../../src/db/stats';
import { colors, spacing, text } from '../../../src/theme';

const HEATMAP_WEEKS = 16;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;
const HEAT_GAP = 3;

interface HeatmapCell {
  date: string;
  count: number;
  isFuture: boolean;
}

interface HomeStats {
  streak: number;
  heatmap: HeatmapCell[];
  weekListeningSeconds: number;
  totalListeningSeconds: number;
  cardsMastered: number;
  cardsDueToday: number;
}

const ZERO_STATS: HomeStats = {
  streak: 0,
  heatmap: [],
  weekListeningSeconds: 0,
  totalListeningSeconds: 0,
  cardsMastered: 0,
  cardsDueToday: 0,
};

export default function HomeScreen() {
  const [stats, setStats] = useState<HomeStats>(ZERO_STATS);
  const greeting = currentGreeting();
  const { user, logout, deleteAccount } = useAuth();

  const handleLogout = () => {
    Alert.alert('退出登录', '确定要退出当前账号吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: async () => {
          try {
            await logout();
          } catch (err) {
            const msg = err instanceof Error ? err.message : '请稍后重试';
            Alert.alert('退出失败', msg);
          }
        },
      },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      '注销账号',
      '注销后账号进入 7 天冷静期，期间重新登录可恢复。冷静期后所有数据将被永久删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认注销',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccount();
            } catch (err) {
              const msg = err instanceof Error ? err.message : '请稍后重试';
              Alert.alert('注销失败', msg);
            }
          },
        },
      ]
    );
  };

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

          <Heatmap cells={stats.heatmap} />

          <View style={styles.heatmapLegendRow}>
            <Text style={styles.heatmapHint}>Last {HEATMAP_WEEKS} weeks</Text>
            <View style={styles.heatmapLegend}>
              <Text style={styles.heatmapHint}>Less</Text>
              {[0, 1, 2, 3].map((lvl) => (
                <View
                  key={lvl}
                  style={[
                    styles.legendCell,
                    { backgroundColor: levelColor(lvl) },
                  ]}
                />
              ))}
              <Text style={styles.heatmapHint}>More</Text>
            </View>
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

        <Card style={styles.accountCard}>
          <Text style={styles.sectionLabel}>Account</Text>
          {user && (
            <Text style={styles.accountWho}>
              {user.nickname}
              {user.phone ? ` · ${user.phone}` : ''}
            </Text>
          )}
          <Pressable
            style={({ pressed }) => [
              styles.accountRow,
              pressed && { opacity: 0.6 },
            ]}
            onPress={handleLogout}
          >
            <Ionicons
              name="log-out-outline"
              size={18}
              color={colors.textPrimary}
            />
            <Text style={styles.accountRowText}>退出登录</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.accountRow,
              styles.accountRowLast,
              pressed && { opacity: 0.6 },
            ]}
            onPress={handleDeleteAccount}
          >
            <Ionicons
              name="trash-outline"
              size={18}
              color={colors.rating.againText}
            />
            <Text
              style={[
                styles.accountRowText,
                { color: colors.rating.againText },
              ]}
            >
              注销账号
            </Text>
          </Pressable>
        </Card>
      </ScrollView>
    </Screen>
  );
}

async function loadHomeStats(): Promise<HomeStats> {
  const now = new Date();
  const today = isoDay(now);
  const monday = startOfWeekMonday(now);
  const mondayIso = isoDay(monday);

  const heatmapDates = buildHeatmapDates(now);
  const heatmapStart = heatmapDates[0];
  const heatmapEnd = heatmapDates[heatmapDates.length - 1];

  const [
    streak,
    heatmapRows,
    weekListening,
    totalListening,
    cardsMastered,
    dueCards,
  ] = await Promise.all([
    getCurrentStreak(today),
    getStatsRange(heatmapStart, heatmapEnd),
    getListeningSecondsBetween(mondayIso, today),
    getTotalListeningSeconds(),
    countMasteredCards(),
    listCardsDueBy(now.toISOString()),
  ]);

  const countByDate = new Map(
    heatmapRows.map((r) => [r.date, r.session_count])
  );
  const heatmap: HeatmapCell[] = heatmapDates.map((date) => ({
    date,
    count: countByDate.get(date) ?? 0,
    isFuture: date > today,
  }));

  return {
    streak,
    heatmap,
    weekListeningSeconds: weekListening,
    totalListeningSeconds: totalListening,
    cardsMastered,
    cardsDueToday: dueCards.length,
  };
}

function buildHeatmapDates(today: Date): string[] {
  // Anchor on the Monday of the current week, then walk back
  // (HEATMAP_WEEKS - 1) full weeks. The grid reads left→right as
  // oldest→newest week; each column is M..S top→bottom.
  const thisMonday = startOfWeekMonday(today);
  const start = new Date(thisMonday);
  start.setUTCDate(thisMonday.getUTCDate() - (HEATMAP_WEEKS - 1) * 7);

  const dates: string[] = [];
  for (let i = 0; i < HEATMAP_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    dates.push(isoDay(d));
  }
  return dates;
}

function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  // Group cells into weeks (columns) of 7 days each.
  const weeks: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  return (
    <View style={styles.heatmapGrid}>
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.heatmapWeek}>
          {week.map((day) => (
            <View
              key={day.date}
              style={[
                styles.heatCell,
                { backgroundColor: levelColor(day.count) },
                day.isFuture && styles.heatCellFuture,
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function levelColor(count: number): string {
  if (count <= 0) return '#EDE9E3'; // pillBg
  if (count === 1) return '#FBE3B5';
  if (count === 2) return '#F2C572';
  return '#E8A84A'; // accent
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
  heatmapGrid: {
    flexDirection: 'row',
    gap: HEAT_GAP,
    marginTop: spacing.sm,
    alignSelf: 'stretch',
  },
  heatmapWeek: {
    flexDirection: 'column',
    gap: HEAT_GAP,
    flex: 1,
  },
  heatCell: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 3,
    backgroundColor: colors.pillBg,
  },
  heatCellFuture: {
    opacity: 0.35,
  },
  heatmapLegendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  heatmapHint: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  heatmapLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendCell: {
    width: 10,
    height: 10,
    borderRadius: 2,
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
  accountCard: {
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  accountWho: {
    ...text.body,
    marginTop: 4,
    marginBottom: spacing.md,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  accountRowLast: {
    borderBottomWidth: 0,
  },
  accountRowText: {
    ...text.body,
    fontWeight: '500',
  },
});
