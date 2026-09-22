import { Ionicons } from '@expo/vector-icons';
import {
  ErrorCode,
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  showManageSubscriptionsIOS,
  syncIOS,
  type Product,
  type Purchase,
} from 'expo-iap';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  PLUS_ANNUAL_PRODUCT_ID,
  PLUS_MONTHLY_PRODUCT_ID,
  PLUS_PRODUCT_IDS,
  subscriptionsApi,
  type SubscriptionState,
} from '../api/subscriptions';
import { backendPublicDocumentUrl } from '../api/backend';
import { colors, radius, shadow, spacing } from '../theme';

interface SubscriptionContextValue {
  state: SubscriptionState | null;
  loading: boolean;
  isPlus: boolean;
  presentPaywall: () => void;
  refresh: () => Promise<void>;
}

const SubscriptionContext = createContext<SubscriptionContextValue | null>(
  null
);

function isPlusProduct(productId: string): boolean {
  return PLUS_PRODUCT_IDS.some((id) => id === productId);
}

export function SubscriptionProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [paywallVisible, setPaywallVisible] = useState(false);
  const [storeReady, setStoreReady] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [purchasePending, setPurchasePending] = useState(false);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const refresh = useCallback(async () => {
    if (!userIdRef.current) {
      setState(null);
      return;
    }
    setLoading(true);
    try {
      setState(await subscriptionsApi.status());
    } finally {
      setLoading(false);
    }
  }, []);

  const verifyAndFinish = useCallback(async (purchase: Purchase) => {
    if (!userIdRef.current || !isPlusProduct(purchase.productId)) {
      return;
    }
    const signedTransaction = purchase.purchaseToken;
    if (!signedTransaction) {
      throw new Error('App Store 未返回可验证的购买凭证');
    }
    const next = await subscriptionsApi.verifyAppleTransaction(
      signedTransaction
    );
    await finishTransaction({ purchase, isConsumable: false });
    setState(next);
    setPaywallVisible(false);
  }, []);

  useEffect(() => {
    if (!userId || Platform.OS !== 'ios') {
      setStoreReady(false);
      setProducts([]);
      setState(null);
      return;
    }
    let cancelled = false;
    const updated = purchaseUpdatedListener((purchase) => {
      setPurchasePending(true);
      void verifyAndFinish(purchase)
        .catch((error) => {
          Alert.alert(
            '购买验证失败',
            error instanceof Error ? error.message : '请稍后恢复购买'
          );
        })
        .finally(() => setPurchasePending(false));
    });
    const failed = purchaseErrorListener((error) => {
      setPurchasePending(false);
      if (error.code !== ErrorCode.UserCancelled) {
        Alert.alert('购买未完成', error.message || '请稍后重试');
      }
    });

    void Promise.all([
      refresh().catch(() => {}),
      initConnection()
        .then(async (connected) => {
          if (!connected || cancelled) return;
          setStoreReady(true);
          const loaded = await fetchProducts({
            skus: [...PLUS_PRODUCT_IDS],
            type: 'subs',
          });
          if (!cancelled) setProducts((loaded ?? []) as Product[]);
        })
        .catch(() => {
          if (!cancelled) setStoreReady(false);
        }),
    ]);

    return () => {
      cancelled = true;
      updated.remove();
      failed.remove();
      void endConnection().catch(() => {});
    };
  }, [refresh, userId, verifyAndFinish]);

  const purchase = useCallback(
    async (productId: string) => {
      if (!userIdRef.current || !storeReady) {
        Alert.alert('App Store 暂不可用', '请检查网络后重试');
        return;
      }
      setPurchasePending(true);
      try {
        await requestPurchase({
          request: {
            apple: {
              sku: productId,
              appAccountToken: userIdRef.current,
            },
          },
          type: 'subs',
        });
      } catch (error) {
        setPurchasePending(false);
        throw error;
      }
    },
    [storeReady]
  );

  const restore = useCallback(async () => {
    setPurchasePending(true);
    try {
      await syncIOS();
      const purchases = await getAvailablePurchases({
        onlyIncludeActiveItemsIOS: true,
      });
      const eligible = purchases.filter((purchase) =>
        isPlusProduct(purchase.productId)
      );
      for (const purchase of eligible) await verifyAndFinish(purchase);
      await refresh();
      Alert.alert(
        eligible.length ? '恢复成功' : '没有可恢复的订阅',
        eligible.length
          ? 'Plus 权益已经同步到当前账号。'
          : '当前 Apple ID 没有有效的 PhotoSpeak Plus 订阅。'
      );
    } catch (error) {
      Alert.alert(
        '恢复失败',
        error instanceof Error ? error.message : '请稍后重试'
      );
    } finally {
      setPurchasePending(false);
    }
  }, [refresh, verifyAndFinish]);

  const value = useMemo<SubscriptionContextValue>(
    () => ({
      state,
      loading,
      isPlus: state?.plan === 'plus',
      presentPaywall: () => setPaywallVisible(true),
      refresh,
    }),
    [loading, refresh, state]
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
      <Paywall
        visible={paywallVisible}
        products={products}
        storeReady={storeReady}
        pending={purchasePending}
        onClose={() => !purchasePending && setPaywallVisible(false)}
        onPurchase={(id) => void purchase(id).catch((error) => {
          Alert.alert(
            '购买未完成',
            error instanceof Error ? error.message : '请稍后重试'
          );
        })}
        onRestore={() => void restore()}
      />
    </SubscriptionContext.Provider>
  );
}

export function useSubscription(): SubscriptionContextValue {
  const value = useContext(SubscriptionContext);
  if (!value) {
    throw new Error('useSubscription must be used inside SubscriptionProvider');
  }
  return value;
}

function Paywall({
  visible,
  products,
  storeReady,
  pending,
  onClose,
  onPurchase,
  onRestore,
}: {
  visible: boolean;
  products: Product[];
  storeReady: boolean;
  pending: boolean;
  onClose: () => void;
  onPurchase: (id: string) => void;
  onRestore: () => void;
}) {
  const monthly = products.find((item) => item.id === PLUS_MONTHLY_PRODUCT_ID);
  const annual = products.find((item) => item.id === PLUS_ANNUAL_PRODUCT_ID);
  const openDocument = (document: 'privacy' | 'terms') => {
    void Linking.openURL(backendPublicDocumentUrl(document)).catch(() => {
      Alert.alert('暂时无法打开', '请检查网络后重试');
    });
  };
  const manageSubscriptions = () => {
    void showManageSubscriptionsIOS().catch(() => {
      Alert.alert('暂时无法打开', '请稍后在系统设置的 Apple 订阅中管理');
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.brand}>PhotoSpeak Plus</Text>
          <Pressable onPress={onClose} disabled={pending} hitSlop={12}>
            <Ionicons name="close" size={26} color={colors.textPrimary} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>让每一张照片都成为口语练习</Text>
          <Text style={styles.subtitle}>正常个人学习不限 Session 和追问次数</Text>
          {[
            '完整 AI 纠错与自然表达优化',
            '流式语音转写与标准发音音频',
            '保存 Listening 与复习卡片',
            '没有月度练习次数提示',
          ].map((copy) => (
            <View key={copy} style={styles.benefit}>
              <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
              <Text style={styles.benefitText}>{copy}</Text>
            </View>
          ))}

          <PlanButton
            title="年付 · 推荐"
            price={annual?.displayPrice}
            suffix="/年"
            badge="最划算"
            disabled={!annual || pending}
            onPress={() => onPurchase(PLUS_ANNUAL_PRODUCT_ID)}
          />
          <PlanButton
            title="月付"
            price={monthly?.displayPrice}
            suffix="/月"
            disabled={!monthly || pending}
            onPress={() => onPurchase(PLUS_MONTHLY_PRODUCT_ID)}
          />

          {!storeReady && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.legalText}>正在连接 App Store…</Text>
            </View>
          )}
          {pending && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.legalText}>正在等待 App Store 确认…</Text>
            </View>
          )}

          <Pressable onPress={onRestore} disabled={pending} style={styles.linkButton}>
            <Text style={styles.linkText}>恢复购买</Text>
          </Pressable>
          <Pressable
            onPress={manageSubscriptions}
            disabled={pending}
            style={styles.linkButton}
          >
            <Text style={styles.linkText}>管理订阅</Text>
          </Pressable>

          <Text style={styles.legalText}>
            付款将由 Apple ID 确认。订阅会自动续订；如不续订，请至少在当前周期结束前 24 小时在 Apple 订阅设置中取消。实际价格以 App Store 确认页显示的当地货币为准。
          </Text>
          <View style={styles.legalLinks}>
            <Pressable onPress={() => openDocument('terms')}>
              <Text style={styles.linkText}>用户协议</Text>
            </Pressable>
            <Text style={styles.legalText}> · </Text>
            <Pressable onPress={() => openDocument('privacy')}>
              <Text style={styles.linkText}>隐私政策</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function PlanButton({
  title,
  price,
  suffix,
  badge,
  disabled,
  onPress,
}: {
  title: string;
  price?: string;
  suffix: string;
  badge?: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.plan,
        badge && styles.planFeatured,
        disabled && styles.disabled,
        pressed && !disabled && { opacity: 0.82 },
      ]}
    >
      <View>
        <View style={styles.planTitleRow}>
          <Text style={styles.planTitle}>{title}</Text>
          {badge && <Text style={styles.badge}>{badge}</Text>}
        </View>
        <Text style={styles.planHint}>随时可在 Apple 订阅中取消</Text>
      </View>
      <Text style={styles.price}>{price ? `${price}${suffix}` : '加载中…'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  brand: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  content: { padding: spacing.lg, paddingBottom: 48 },
  title: {
    fontSize: 28,
    lineHeight: 35,
    fontWeight: '800',
    color: colors.textPrimary,
    marginTop: spacing.md,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 24,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  benefit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  benefitText: { fontSize: 15, color: colors.textPrimary, flex: 1 },
  plan: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.separator,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...shadow,
  },
  planFeatured: { borderColor: colors.accent, borderWidth: 2 },
  planTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  planTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  badge: {
    color: colors.accentText,
    backgroundColor: colors.accent,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  planHint: { color: colors.textTertiary, fontSize: 12, marginTop: 4 },
  price: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  loadingRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.md,
  },
  linkButton: { alignSelf: 'center', padding: 8, marginTop: 4 },
  linkText: { color: colors.accentText, fontSize: 14, fontWeight: '600' },
  legalText: {
    color: colors.textTertiary,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  legalLinks: { flexDirection: 'row', justifyContent: 'center', marginTop: 6 },
});
