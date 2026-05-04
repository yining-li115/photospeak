/**
 * Welcome / login entry. Layout ported from familycourt's
 * WelcomeScreen — privacy-modal gated, two circular login buttons
 * (Apple + phone). Adapted for PhotoSpeak's amber theme and Expo
 * Router (instead of React Navigation).
 */
import * as AppleAuthentication from 'expo-apple-authentication';
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
import { useAuth } from '../../src/context/auth';
import { colors } from '../../src/theme';

const { height: SCREEN_H } = Dimensions.get('window');

export default function WelcomeScreen() {
  const { loginWithApple } = useAuth();
  const [loading, setLoading] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [pendingAction, setPendingAction] = useState<'apple' | 'phone' | null>(
    null
  );

  function requireAgreement(action: 'apple' | 'phone') {
    if (agreed) executeAction(action);
    else {
      setPendingAction(action);
      setShowPrivacy(true);
    }
  }

  function onAgree() {
    setAgreed(true);
    setShowPrivacy(false);
    if (pendingAction) {
      executeAction(pendingAction);
      setPendingAction(null);
    }
  }

  function executeAction(action: 'apple' | 'phone') {
    if (action === 'apple') handleAppleLogin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      await loginWithApple(credential.identityToken, credential.fullName);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('登录失败', e.message || '请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={s.container}>
      {/* Brand area: PhotoSpeak's icon + name + slogan, vertically
          centered around 60% screen height (matches familycourt). */}
      <View style={s.brandArea}>
        <Image
          source={require('../../assets/images/icon.png')}
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
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => requireAgreement('phone')}
            disabled={loading}
          >
            <Ionicons name="phone-portrait-outline" size={26} color={colors.card} />
          </Pressable>
        </View>

        <Text style={s.privacy}>
          登录即代表同意{' '}
          <Text style={s.privacyLink} onPress={() => setShowPrivacy(true)}>
            用户协议与隐私政策
          </Text>
        </Text>
      </View>

      {/* Privacy modal */}
      <Modal visible={showPrivacy} animationType="slide" transparent>
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
                1. 您选择的照片、录音、生成的英语稿件属于您个人内容，仅在您的设备本地存储和服务器之间传输。{'\n'}
                2. 我们仅收集您的 Apple ID 或手机号用于账号验证。语音、照片、文本会加密传输至 MiMo（小米）和阿里云 DashScope 用于 AI 分析与语音生成；服务商不会将其用于模型训练。{'\n'}
                3. 您可以随时注销账号，注销后数据将在 7 天冷静期后删除。
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
            </ScrollView>
            <View style={m.checkRow}>
              <Switch
                value={agreed}
                onValueChange={setAgreed}
                trackColor={{ true: colors.accent, false: colors.separator }}
                thumbColor="#FFF"
              />
              <Text style={m.checkLabel}>我已阅读并同意以上协议</Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                m.agreeBtn,
                !agreed && m.agreeBtnDisabled,
                pressed && agreed && { opacity: 0.85 },
              ]}
              onPress={onAgree}
              disabled={!agreed}
            >
              <Text style={m.agreeBtnText}>同意并继续</Text>
            </Pressable>
            <Pressable
              style={m.cancelBtn}
              onPress={() => {
                setShowPrivacy(false);
                setPendingAction(null);
              }}
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
  privacy: { fontSize: 11, color: colors.textTertiary },
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
