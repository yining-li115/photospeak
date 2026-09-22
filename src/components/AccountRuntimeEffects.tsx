import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '../context/auth';
import { usePlayer } from '../context/player';
import { claimLegacyData, hasLegacyData } from '../db/owner';

interface Props {
  onLegacyDataImported: () => void;
}

/**
 * Coordinates process-local resources that span screens but must never span
 * accounts: the native playback queue and quarantined beta data.
 */
export function AccountRuntimeEffects({ onLegacyDataImported }: Props) {
  const { user } = useAuth();
  const { stop } = usePlayer();
  const previousUserId = useRef<string | null | undefined>(undefined);
  const promptedUserId = useRef<string | null>(null);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (previousUserId.current !== userId) {
      void stop().catch((error: unknown) => {
        console.warn('[account-runtime] player stop failed', error);
      });
      previousUserId.current = userId;
    }
  }, [stop, userId]);

  useEffect(() => {
    let cancelled = false;
    if (!userId || promptedUserId.current === userId) return;
    promptedUserId.current = userId;

    void hasLegacyData()
      .then((present) => {
        if (!present || cancelled) return;
        Alert.alert(
          '发现内测学习数据',
          '这些数据尚未归属任何账号。只有确认数据属于当前账号时才导入；在共享设备上请选“稍后”。',
          [
            { text: '稍后', style: 'cancel' },
            {
              text: '导入',
              onPress: () => {
                void claimLegacyData(userId)
                  .then(() => {
                    onLegacyDataImported();
                    Alert.alert('导入完成', '内测学习数据已归入当前账号。');
                  })
                  .catch((error) => {
                    promptedUserId.current = null;
                    Alert.alert(
                      '导入失败',
                      error instanceof Error ? error.message : '请稍后重试'
                    );
                  });
              },
            },
          ]
        );
      })
      .catch(() => {
        promptedUserId.current = null;
      });

    return () => {
      cancelled = true;
    };
  }, [onLegacyDataImported, userId]);

  return null;
}
