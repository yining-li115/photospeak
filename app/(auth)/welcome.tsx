/**
 * Welcome / login entry. Layout ported from familycourt's
 * WelcomeScreen — privacy-modal gated, two circular login buttons
 * (Apple + phone). Adapted for PhotoSpeak's amber theme and Expo
 * Router (instead of React Navigation).
 */
import * as AppleAuthentication from 'expo-apple-authentication';
import * as WebBrowser from 'expo-web-browser';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Dimensions,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { backendPublicDocumentUrl } from '../../src/api/backend';
import { useAuth } from '../../src/context/auth';
import { colors } from '../../src/theme';

const { height: SCREEN_H } = Dimensions.get('window');

export default function WelcomeScreen() {
  const {
    consent,
    acceptCurrentConsent,
    withdrawCurrentConsent,
    loginWithApple,
  } = useAuth();
  const [loading, setLoading] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [modalAccepted, setModalAccepted] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [pendingAction, setPendingAction] = useState<'apple' | 'phone' | null>(
    null
  );

  const hasConsent = consent !== null;

  function requireAgreement(action: 'apple' | 'phone') {
    if (hasConsent) executeAction(action);
    else {
      setPendingAction(action);
      setModalAccepted(false);
      setShowPrivacy(true);
    }
  }

  function closeConsentDialog() {
    setShowPrivacy(false);
    setPendingAction(null);
    setModalAccepted(false);
  }

  async function toggleConsent() {
    if (consentSaving) return;
    setConsentSaving(true);
    try {
      if (hasConsent) {
        await withdrawCurrentConsent();
        setModalAccepted(false);
      } else {
        await acceptCurrentConsent();
        setModalAccepted(true);
      }
    } catch {
      Alert.alert('无法保存隐私选择', '请检查设备存储后重试');
    } finally {
      setConsentSaving(false);
    }
  }

  async function onAgree() {
    if (consentSaving || !modalAccepted) return;
    setConsentSaving(true);
    try {
      await acceptCurrentConsent();
      setShowPrivacy(false);
      if (pendingAction) {
        executeAction(pendingAction);
        setPendingAction(null);
      }
    } catch {
      Alert.alert('无法保存隐私选择', '请检查设备存储后重试');
    } finally {
      setConsentSaving(false);
    }
  }

  function executeAction(action: 'apple' | 'phone') {
    if (action === 'apple') handleAppleLogin();
    if (action === 'phone') router.push('/(auth)/phone' as any);
  }

  async function handleAppleLogin() {
    if (loading) return;
    setLoading(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        throw new Error('Apple 登录未返回 identityToken');
      }
      if (!credential.authorizationCode) {
        throw new Error('Apple 登录未返回 authorizationCode');
      }
      await loginWithApple(
        credential.identityToken,
        credential.authorizationCode,
        credential.fullName
      );
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('登录失败', e.message || '请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }

  function openLegalDocument(document: 'privacy' | 'terms' | 'support') {
    let url: string;
    try {
      url = backendPublicDocumentUrl(document);
    } catch {
      Alert.alert('暂时无法打开', '后端地址未配置，请联系支持人员');
      return;
    }
    void WebBrowser.openBrowserAsync(url).catch(() => {
      Alert.alert('暂时无法打开', '请检查网络后重试');
    });
  }

  return (
    <View style={s.container}>
      {/* Brand area: PhotoSpeak's icon + name + slogan, vertically
          centered around 60% screen height (matches familycourt). */}
      <View style={s.brandArea}>
        <Image
          source={require('../../assets/images/welcome-logo.png')}
          style={s.logo}
          contentFit="contain"
        />
        <Text style={s.appName}>PhotoSpeak</Text>
        <Text style={s.slogan}>每天一张照片，开口说英语</Text>
      </View>

      {/* Bottom login buttons */}
      <View style={s.bottomArea}>
        <View style={s.loginRow}>
          {Platform.OS === 'ios' && (
            <Pressable
              style={({ pressed }) => [
                s.loginCircle,
                !hasConsent && s.loginCirclePending,
                pressed && { opacity: 0.85 },
              ]}
              onPress={() => requireAgreement('apple')}
              disabled={loading}
            >
              <Ionicons name="logo-apple" size={28} color={colors.card} />
            </Pressable>
          )}
          <Pressable
            style={({ pressed }) => [
              s.loginCircle,
              !hasConsent && s.loginCirclePending,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => requireAgreement('phone')}
            disabled={loading}
          >
            <Ionicons name="phone-portrait-outline" size={26} color={colors.card} />
          </Pressable>
        </View>

        <View style={s.consentRow}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: hasConsent }}
            accessibilityLabel="同意用户协议与隐私政策"
            onPress={() => void toggleConsent()}
            disabled={consentSaving}
            hitSlop={8}
          >
            <Ionicons
              name={hasConsent ? 'checkbox' : 'square-outline'}
              size={18}
              color={hasConsent ? colors.accent : colors.textTertiary}
            />
          </Pressable>
          <Text style={s.privacy}>
            登录或注册前，请阅读并同意
            <Text style={s.privacyLink} onPress={() => openLegalDocument('terms')}>
              《用户协议》
            </Text>
            和
            <Text style={s.privacyLink} onPress={() => openLegalDocument('privacy')}>
              《隐私政策》
            </Text>
          </Text>
        </View>
      </View>

      {/* Privacy modal */}
      <Modal
        visible={showPrivacy}
        animationType="slide"
        transparent
        onRequestClose={closeConsentDialog}
      >
        <View style={m.overlay}>
          <View style={m.sheet}>
            <Text style={m.title}>用户协议与隐私政策</Text>
            <ScrollView style={m.scroll} showsVerticalScrollIndicator={false}>
              <Text style={m.heading}>一、服务说明</Text>
              <Text style={m.body}>
                PhotoSpeak 是一款帮助你通过描述照片练习英语口语的应用。每天选一张照片，录一段英语，AI 自动批改、改写、生成播客和复习卡片。使用本应用即表示您接受以下条款。
              </Text>
              <Text style={m.heading}>二、隐私保护</Text>
              <Text style={m.body}>
                1. 您选择的照片、录音和生成的学习内容默认保存在您的设备上；为完成识别、分析和语音合成，必要内容会发送到我们的服务器及隐私政策中列明的 AI 服务商。{'\n'}
                2. 我们仅按功能所需处理账号与学习数据，并使用加密连接传输。为避免断网重试造成重复调用，分析和追问结果会加密缓存最多 72 小时，合成语音最多 24 小时；请求中的照片、录音和转写正文不会写入长期运维记录。具体服务商、处理目的和保留期限以完整隐私政策为准。{'\n'}
                3. 崩溃、错误与少量性能诊断默认关闭。登录后，您可以在 Account 中自愿开启；诊断不包含照片、录音、转写、AI 正文或认证请求内容。{'\n'}
                4. 您可以随时注销账号；冷静期结束后，我们会按隐私政策删除账号及关联云端数据，并立即清除本机对应账号的数据。
              </Text>
              <Text style={m.heading}>三、用户行为规范</Text>
              <Text style={m.body}>
                1. 禁止上传违法、淫秽、骚扰他人的内容。{'\n'}
                2. 不得用本应用从事任何商业用途的批量内容生成。
              </Text>
              <Text style={m.heading}>四、免责声明</Text>
              <Text style={m.body}>
                AI 生成的英语建议仅供学习参考，不保证语法绝对准确，正式场合请人工复核。
              </Text>
              <Text style={m.heading}>五、联系我们</Text>
              <Text style={m.body}>
                如有疑问，请联系：
                <Text
                  style={m.link}
                  onPress={() => Linking.openURL('mailto:heyyiru@gmail.com')}
                >
                  heyyiru@gmail.com
                </Text>
              </Text>
              <View style={m.legalLinks}>
                <Text
                  style={m.legalLink}
                  onPress={() => openLegalDocument('privacy')}
                >
                  查看完整隐私政策
                </Text>
                <Text
                  style={m.legalLink}
                  onPress={() => openLegalDocument('terms')}
                >
                  查看完整用户协议
                </Text>
              </View>
            </ScrollView>
            <View style={m.checkRow}>
              <Switch
                value={modalAccepted}
                onValueChange={setModalAccepted}
                disabled={consentSaving}
                trackColor={{ true: colors.accent, false: colors.separator }}
                thumbColor="#FFF"
              />
              <Text style={m.checkLabel}>我已阅读并同意以上协议</Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                m.agreeBtn,
                (!modalAccepted || consentSaving) && m.agreeBtnDisabled,
                pressed && modalAccepted && !consentSaving && { opacity: 0.85 },
              ]}
              onPress={onAgree}
              disabled={!modalAccepted || consentSaving}
            >
              <Text style={m.agreeBtnText}>
                {consentSaving ? '保存中…' : '同意并继续'}
              </Text>
            </Pressable>
            <Pressable
              style={m.cancelBtn}
              onPress={closeConsentDialog}
            >
              <Text style={m.cancelBtnText}>暂不同意</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  brandArea: {
    position: 'absolute',
    top: SCREEN_H * 0.28,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  logo: {
    width: 96,
    height: 96,
    marginBottom: 24,
  },
  appName: {
    fontSize: 36,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: 2,
    marginBottom: 8,
  },
  slogan: {
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  bottomArea: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  loginRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 80,
    marginBottom: 16,
  },
  loginCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.textPrimary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loginCirclePending: { opacity: 0.72 },
  consentRow: {
    maxWidth: 320,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
  },
  privacy: {
    flex: 1,
    fontSize: 11,
    lineHeight: 17,
    color: colors.textTertiary,
  },
  privacyLink: {
    color: colors.accentText,
    textDecorationLine: 'underline',
  },
});

const m = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    paddingBottom: 40,
    maxHeight: '85%',
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: 16,
  },
  scroll: { maxHeight: 320, marginBottom: 16 },
  heading: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
    marginTop: 12,
    marginBottom: 4,
  },
  body: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
  link: { color: colors.accentText, textDecorationLine: 'underline' },
  legalLinks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
    marginTop: 12,
    marginBottom: 4,
  },
  legalLink: {
    color: colors.accentText,
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  checkLabel: { fontSize: 14, color: colors.textPrimary, flex: 1 },
  agreeBtn: {
    backgroundColor: colors.textPrimary,
    borderRadius: 24,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  agreeBtnDisabled: { opacity: 0.3 },
  agreeBtnText: { color: colors.card, fontSize: 16, fontWeight: '700' },
  cancelBtn: { alignItems: 'center', paddingVertical: 10 },
  cancelBtnText: { color: colors.textSecondary, fontSize: 14 },
});
