/**
 * Phone-number entry screen. Layout ported from familycourt's
 * PhoneInputScreen with PhotoSpeak's amber theme. Calls
 * /auth/send-code, then routes to /(auth)/verify with the phone
 * number as a query param.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { authApi } from '../../src/api/auth';
import { colors, shadow } from '../../src/theme';

export default function PhoneInputScreen() {
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSend() {
    const trimmed = phone.trim();
    if (!/^1[3-9]\d{9}$/.test(trimmed)) {
      return Alert.alert('提示', '请输入正确的手机号');
    }
    setLoading(true);
    try {
      await authApi.sendCode(trimmed);
      router.push({
        // Expo Router's typed routes regenerate at metro startup; the
        // (auth) group hasn't been picked up yet at type-check time.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pathname: '/(auth)/verify' as any,
        params: { phone: trimmed },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '请稍后重试';
      Alert.alert('发送失败', msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={10}>
        <Text style={s.backText}>‹ 返回</Text>
      </Pressable>

      <View style={s.content}>
        <Text style={s.title}>手机号登录</Text>
        <Text style={s.hint}>我们将向您发送验证码</Text>

        <View style={s.inputCard}>
          <Text style={s.prefix}>+86</Text>
          <TextInput
            style={s.input}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            placeholder="请输入手机号"
            placeholderTextColor={colors.textTertiary}
            maxLength={11}
            autoFocus
          />
        </View>

        <Pressable
          style={({ pressed }) => [
            s.btn,
            loading && s.btnDisabled,
            pressed && !loading && { opacity: 0.85 },
          ]}
          onPress={handleSend}
          disabled={loading}
        >
          <Text style={s.btnText}>{loading ? '发送中…' : '获取验证码'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  backBtn: { paddingHorizontal: 24, paddingTop: 60 },
  backText: { fontSize: 16, color: colors.textPrimary, fontWeight: '500' },

  content: { flex: 1, paddingHorizontal: 32, paddingTop: 40 },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  hint: { fontSize: 13, color: colors.textSecondary, marginBottom: 40 },

  inputCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 16,
    marginBottom: 28,
    ...shadow,
  },
  prefix: {
    fontSize: 18,
    color: colors.textPrimary,
    fontWeight: '700',
    marginRight: 12,
    paddingRight: 12,
    borderRightWidth: 1,
    borderRightColor: colors.separator,
  },
  input: { flex: 1, fontSize: 22, color: colors.textPrimary, letterSpacing: 2 },

  btn: {
    backgroundColor: colors.textPrimary,
    borderRadius: 28,
    paddingVertical: 16,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: colors.card, fontSize: 16, fontWeight: '700' },
});
