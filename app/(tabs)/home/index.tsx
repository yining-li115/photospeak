import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  BackendError,
  backendPublicDocumentUrl,
} from '../../../src/api/backend';
import { Card } from '../../../src/components/Card';
import { Screen } from '../../../src/components/Screen';
import { useAuth } from '../../../src/context/auth';
import { useSubscription } from '../../../src/context/subscription';
import { countCardsDueBy, countMasteredCards } from '../../../src/db/cards';
import {
  getCurrentStreak,
  getListeningSecondsBetween,
  getStatsRange,
  getTotalListeningSeconds,
} from '../../../src/db/stats';
import {
  isDiagnosticsEnabled,
  loadDiagnosticsPreference,
  setDiagnosticsEnabled,
} from '../../../src/privacy/diagnostics';
import {
  initializeSentryIfEnabled,
  shutdownSentry,
} from '../../../src/monitoring/sentry';
import { colors, radius, shadow, spacing, text } from '../../../src/theme';
import {
  addLocalDays,
  localDateKey,
  startOfLocalWeekMonday,
} from '../../../src/utils/local-date';

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
  const { user, logout, deleteAccount, updateProfile } = useAuth();
  const { state: subscription, isPlus, presentPaywall } = useSubscription();
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [diagnosticsEnabled, setDiagnosticsState] = useState(
    isDiagnosticsEnabled()
  );
  const [diagnosticsSaving, setDiagnosticsSaving] = useState(false);

  const openNicknameEditor = () => {
    setNicknameDraft(user?.nickname ?? '');
    setEditingNickname(true);
  };

  const saveNickname = async () => {
    const trimmed = nicknameDraft.trim();
    if (!trimmed) {
      return Alert.alert('提示', '昵称不能为空');
    }
    if (trimmed.length > 50) {
      return Alert.alert('提示', '昵称最多 50 个字符');
    }
    if (trimmed === user?.nickname) {
      setEditingNickname(false);
      return;
    }
    setNicknameSaving(true);
    try {
      await updateProfile({ nickname: trimmed });
      setEditingNickname(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '请稍后重试';
      Alert.alert('保存失败', msg);
    } finally {
      setNicknameSaving(false);
    }
  };

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
      '本机学习记录与音频会立即且不可恢复地删除。服务器账号进入 7 天冷静期，期间重新登录可恢复账号；冷静期后账号信息将永久删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认注销',
          style: 'destructive',
          onPress: async () => {
            try {
              const result = await deleteAccount();
              if (
                result.code === 'ACCOUNT_DELETION_PENDING' ||
                result.code === 'LOCAL_CLEANUP_PENDING'
              ) {
                Alert.alert('注销已受理', result.message);
              }
            } catch (err) {
              if (
                err instanceof BackendError &&
                err.code === 'AUTH_RECENT_LOGIN_REQUIRED'
              ) {
                Alert.alert(
                  '请重新确认身份',
                  '为防止他人拿到已解锁的手机后注销账号，请先退出并重新登录，再回到这里注销。',
                  [
                    { text: '取消', style: 'cancel' },
                    {
                      text: '退出并重新登录',
                      style: 'destructive',
                      onPress: () => void logout(),
                    },
                  ]
                );
                return;
              }
              const msg = err instanceof Error ? err.message : '请稍后重试';
              Alert.alert('注销失败', msg);
            }
          },
        },
      ]
    );
  };

  const openLegalDocument = (
    document: 'privacy' | 'terms' | 'support'
  ) => {
    let url: string;
    try {
      url = backendPublicDocumentUrl(document);
    } catch {
      Alert.alert('暂时无法打开', '后端地址未配置，请联系支持人员');
      return;
    }
    void Linking.openURL(url).catch(() => {
      Alert.alert('暂时无法打开', '请检查网络后重试');
    });
  };

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const [next, diagnostics] = await Promise.all([
            loadHomeStats(),
            loadDiagnosticsPreference(false),
          ]);
          if (!cancelled) {
            setStats(next);
            setDiagnosticsState(diagnostics);
          }
        } catch (error) {
          if (!cancelled) {
            Alert.alert(
              'Could not load progress',
              error instanceof Error ? error.message : String(error)
            );
          }
        }
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
          {user && (
            <Pressable
              onPress={openNicknameEditor}
              style={({ pressed }) => [
                styles.namePress,
                pressed && { opacity: 0.6 },
              ]}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 8 }}
            >
              <Text style={styles.greetingName}>{user.nickname}</Text>
              <Ionicons
                name="pencil-outline"
                size={14}
                color={colors.accent}
              />
            </Pressable>
          )}
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

        <Card style={styles.plusCard}>
          <View style={styles.plusHeader}>
            <View>
              <Text style={styles.plusTitle}>
                {isPlus ? 'PhotoSpeak Plus' : '升级 Plus'}
              </Text>
              <Text style={styles.plusBody}>
                {isPlus
                  ? '正常个人学习不限 Session 和追问次数'
                  : subscription
                    ? `本月已完成 ${subscription.usage.completedSessions}/${subscription.usage.sessionLimit} 个免费 Session`
                    : '解锁不限次数的正常个人口语练习'}
              </Text>
            </View>
            <Ionicons
              name={isPlus ? 'sparkles' : 'sparkles-outline'}
              size={24}
              color={colors.accent}
            />
          </View>
          {!isPlus && (
            <Pressable
              onPress={presentPaywall}
              style={({ pressed }) => [
                styles.plusButton,
                pressed && { opacity: 0.82 },
              ]}
            >
              <Text style={styles.plusButtonText}>查看 Plus 方案</Text>
            </Pressable>
          )}
        </Card>

        <Card style={styles.accountCard}>
          <Text style={styles.sectionLabel}>Account</Text>
          <View style={styles.accountRow}>
            <Ionicons
              name="analytics-outline"
              size={18}
              color={colors.textPrimary}
            />
            <View style={styles.accountRowCopy}>
              <Text style={styles.accountRowText}>发送诊断数据</Text>
              <Text style={styles.accountRowHint}>崩溃、错误与少量性能数据</Text>
            </View>
            <Switch
              value={diagnosticsEnabled}
              disabled={diagnosticsSaving}
              onValueChange={(enabled) => {
                setDiagnosticsSaving(true);
                void setDiagnosticsEnabled(enabled)
                  .then(async () => {
                    setDiagnosticsState(enabled);
                    if (enabled) initializeSentryIfEnabled();
                    else await shutdownSentry();
                  })
                  .catch(() => {
                    Alert.alert('保存失败', '无法更新诊断数据设置，请稍后重试');
                  })
                  .finally(() => setDiagnosticsSaving(false));
              }}
              trackColor={{ true: colors.accent, false: colors.separator }}
            />
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.accountRow,
              pressed && { opacity: 0.6 },
            ]}
            onPress={() => openLegalDocument('privacy')}
          >
            <Ionicons
              name="shield-checkmark-outline"
              size={18}
              color={colors.textPrimary}
            />
            <Text style={styles.accountRowText}>隐私政策</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.accountRow,
              pressed && { opacity: 0.6 },
            ]}
            onPress={() => openLegalDocument('terms')}
          >
            <Ionicons
              name="document-text-outline"
              size={18}
              color={colors.textPrimary}
            />
            <Text style={styles.accountRowText}>用户协议</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.accountRow,
              pressed && { opacity: 0.6 },
            ]}
            onPress={() => openLegalDocument('support')}
          >
            <Ionicons
              name="help-circle-outline"
              size={18}
              color={colors.textPrimary}
            />
            <Text style={styles.accountRowText}>帮助与支持</Text>
          </Pressable>
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

      <Modal
        visible={editingNickname}
        transparent
        animationType="fade"
        onRequestClose={() => !nicknameSaving && setEditingNickname(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => !nicknameSaving && setEditingNickname(false)}
          />
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>修改昵称</Text>
            <TextInput
              style={styles.modalInput}
              value={nicknameDraft}
              onChangeText={setNicknameDraft}
              maxLength={50}
              autoFocus
              placeholder="新昵称"
              placeholderTextColor={colors.textTertiary}
              returnKeyType="done"
              onSubmitEditing={saveNickname}
            />
            <View style={styles.modalRow}>
              <Pressable
                onPress={() => setEditingNickname(false)}
                disabled={nicknameSaving}
                style={({ pressed }) => [
                  styles.modalBtn,
                  styles.modalBtnGhost,
                  pressed && !nicknameSaving && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.modalBtnGhostText}>取消</Text>
              </Pressable>
              <Pressable
                onPress={saveNickname}
                disabled={nicknameSaving || nicknameDraft.trim().length === 0}
                style={({ pressed }) => [
                  styles.modalBtn,
                  styles.modalBtnPrimary,
                  (nicknameSaving || nicknameDraft.trim().length === 0) && {
                    opacity: 0.5,
                  },
                  pressed && !nicknameSaving && { opacity: 0.85 },
                ]}
              >
                <Text style={styles.modalBtnPrimaryText}>
                  {nicknameSaving ? '保存中…' : '保存'}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

async function loadHomeStats(): Promise<HomeStats> {
  const now = new Date();
  const today = localDateKey(now);
  const monday = startOfLocalWeekMonday(now);
  const mondayIso = localDateKey(monday);

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
    countCardsDueBy(now.toISOString()),
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
    cardsDueToday: dueCards,
  };
}

function buildHeatmapDates(today: Date): string[] {
  // Anchor on the Monday of the current week, then walk back
  // (HEATMAP_WEEKS - 1) full weeks. The grid reads left→right as
  // oldest→newest week; each column is M..S top→bottom.
  const thisMonday = startOfLocalWeekMonday(today);
  const start = addLocalDays(thisMonday, -(HEATMAP_WEEKS - 1) * 7);

  const dates: string[] = [];
  for (let i = 0; i < HEATMAP_DAYS; i++) {
    dates.push(localDateKey(addLocalDays(start, i)));
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
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: spacing.sm,
  },
  greeting: {
    ...text.greeting,
  },
  namePress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 8,
  },
  greetingName: {
    ...text.greeting,
    color: colors.accent,
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
  plusCard: {
    backgroundColor: colors.accentBgSoft,
    borderColor: colors.accent,
    borderWidth: 1,
  },
  plusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  plusTitle: {
    ...text.cardTitle,
    fontSize: 17,
    color: colors.accentText,
  },
  plusBody: {
    ...text.caption,
    marginTop: 5,
    lineHeight: 19,
    maxWidth: 275,
  },
  plusButton: {
    marginTop: spacing.md,
    backgroundColor: colors.textPrimary,
    borderRadius: radius.pill,
    alignItems: 'center',
    paddingVertical: 12,
  },
  plusButtonText: {
    color: colors.card,
    fontSize: 14,
    fontWeight: '700',
  },
  accountCard: {
    marginTop: spacing.md,
    padding: spacing.lg,
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
  accountRowCopy: {
    flex: 1,
  },
  accountRowHint: {
    ...text.caption,
    color: colors.textTertiary,
    marginTop: 2,
  },

  // ── Nickname edit modal ────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalSheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: spacing.xl,
    gap: spacing.md,
    ...shadow,
  },
  modalTitle: {
    ...text.cardTitle,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  modalInput: {
    ...text.body,
    backgroundColor: colors.bg,
    borderRadius: radius.inner,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  modalRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  modalBtn: {
    flex: 1,
    borderRadius: radius.pill,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalBtnGhost: {
    backgroundColor: colors.pillBg,
  },
  modalBtnGhostText: {
    ...text.body,
    fontWeight: '600',
  },
  modalBtnPrimary: {
    backgroundColor: colors.textPrimary,
  },
  modalBtnPrimaryText: {
    ...text.body,
    color: colors.card,
    fontWeight: '700',
  },
});
