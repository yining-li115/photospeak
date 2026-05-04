/**
 * Code-verify screen. Layout ported from familycourt's
 * CodeVerifyScreen. On submit, calls authApi.verify which writes
 * tokens to SecureStore + sets user on AuthProvider; the root
 * layout then routes us into (tabs).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../../src/context/auth';
import { colors, shadow } from '../../src/theme';

export default function CodeVerifyScreen() {
  const params = useLocalSearchParams<{ phone?: string }>();
  const phone = (params.phone ?? '').toString();
  const { loginWithPhone } = useAuth();
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleVerify() {
    if (code.length !== 6) {
      return Alert.alert('提示', '请输入 6 位验证码');
    }
    setLoading(true);
    try {
      await loginWithPhone(phone, code, nickname.trim() || undefined);
      // _layout.tsx watches user state and routes us into (tabs).
    } catch (err) {
      const msg = err instanceof Error ? err.message : '请稍后重试';
      Alert.alert('验证失败', msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={s.container}>
      <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={10}>
        <Text style={s.backText}>‹ 返回</Text>
      </Pressable>

      <View style={s.content}>
        <Text style={s.title}>输入验证码</Text>
        <Text style={s.hint}>已发送至 {phone}</Text>

        <View style={s.codeCard}>
          <TextInput
            style={s.codeInput}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="000000"
            placeholderTextColor={colors.textTertiary}
            autoFocus
          />
        </View>

        <Text style={s.label}>昵称（选填）</Text>
        <View style={s.nickCard}>
          <TextInput
            style={s.nickInput}
            value={nickname}
            onChangeText={setNickname}
            placeholder="你希望别人怎么称呼你"
            placeholderTextColor={colors.textTertiary}
            maxLength={30}
          />
        </View>

        <Pressable
          style={({ pressed }) => [
            s.btn,
            loading && s.btnDisabled,
            pressed && !loading && { opacity: 0.85 },
          ]}
          onPress={handleVerify}
          disabled={loading}
        >
          <Text style={s.btnText}>{loading ? '验证中…' : '确认登录'}</Text>
        </Pressable>

        <Pressable onPress={() => router.back()} style={s.resend}>
          <Text style={s.resendText}>重新输入手机号</Text>
        </Pressable>
      </View>
    </View>
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
  hint: { fontSize: 13, color: colors.textSecondary, marginBottom: 36 },

  codeCard: {
    backgroundColor: colors.card,
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 14,
    marginBottom: 28,
    ...shadow,
  },
  codeInput: {
    fontSize: 32,
    letterSpacing: 10,
    color: colors.textPrimary,
    textAlign: 'center',
    fontWeight: '700',
  },

  label: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 8,
    fontWeight: '500',
  },
  nickCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 32,
    ...shadow,
  },
  nickInput: { fontSize: 16, color: colors.textPrimary },

  btn: {
    backgroundColor: colors.textPrimary,
    borderRadius: 28,
    paddingVertical: 16,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: colors.card, fontSize: 16, fontWeight: '700' },

  resend: { alignItems: 'center', marginTop: 20 },
  resendText: { fontSize: 13, color: colors.accentText },
});
