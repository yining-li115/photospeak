import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import * as Sentry from '@sentry/react-native';
import { friendlyTranscribeMessage } from '../../../src/api/streaming-asr';
import {
  analyzeSession,
  AiServiceError,
  followUpChat,
  type AnalysisResult,
} from '../../../src/api/ai';
import { SpeechSynthesisError } from '../../../src/api/tts';
import { Card } from '../../../src/components/Card';
import { deleteCompletedAiIntent } from '../../../src/db/ai-intents';
import {
  assertAccountOperationScope,
  captureAccountOperationScope,
  isAccountOperationScopeCurrent,
  type AccountOperationScope,
} from '../../../src/services/account-operation';
import {
  generateSession,
  type GenerateProgress,
} from '../../../src/services/generate';
import { Pill } from '../../../src/components/Pill';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import {
  appendSessionChatMessages,
  assertSessionIdAvailable,
  getSession,
} from '../../../src/db/sessions';
import {
  RecorderRecoveryRequiredError,
  useRecorder,
  type RecorderPhase,
  type RecorderStoppedEvent,
} from '../../../src/hooks/useAudioRecorder';
import type { RecordingPeriod } from '../../../src/recording/policy';
import {
  PlaybackRecoveryRequiredError,
  usePlayer,
} from '../../../src/context/player';
import { savePhoto, type SavedPhoto } from '../../../src/storage/photos';
import {
  ensureSessionStorageCapacity,
} from '../../../src/storage/maintenance';
import { StorageCapacityError } from '../../../src/storage/quota';
import {
  pickFromLibrary,
  pickRandomFromLibrary,
  type PickerError,
  type PickerResult,
} from '../../../src/storage/picker';
import {
  deleteRecording,
  deleteTemporaryRecording,
  persistRecording,
} from '../../../src/storage/recordings';
import { colors, radius, shadow, spacing, text } from '../../../src/theme';
import type { ChatMessage } from '../../../src/types';

type Mode = 'loading' | 'new' | 'existing';

// Self-rendered header height (excluding the status-bar safe area
// inset, which is added separately). We render our own header so we
// can opt out of iOS 26's "Liquid Glass" headerRight button chrome —
// the white capsule it puts around custom buttons doesn't fit our
// flat amber theme. Same pattern as the sessions / listening list
// screens.
const HEADER_BODY_HEIGHT = 44;
const MAX_VISIBLE_CHAT_MESSAGES = 100;

interface SavedRecording {
  uri: string;
  durationMs: number;
}

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const player = usePlayer();
  const [mode, setMode] = useState<Mode>('loading');
  const [photo, setPhoto] = useState<SavedPhoto | null>(null);
  const [picking, setPicking] = useState(false);
  const [recording, setRecording] = useState<SavedRecording | null>(null);
  const [savingRecording, setSavingRecording] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatPending, setChatPending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateProgress, setGenerateProgress] =
    useState<GenerateProgress | null>(null);
  // True briefly right after Save & Generate succeeds so the
  // AnalysisChatView shows a "Saved" hint above the chat composer.
  const [showSavedHint, setShowSavedHint] = useState(false);
  // Help modal (the ? icon in the header).
  const [helpVisible, setHelpVisible] = useState(false);
  const [recordingStopNotice, setRecordingStopNotice] = useState<string | null>(
    null
  );
  const recordingScopeRef = useRef<AccountOperationScope | null>(null);

  const handleAutoStopped = useCallback(
    async (event: RecorderStoppedEvent) => {
      const scope = recordingScopeRef.current;
      if (!scope) {
        deleteTemporaryRecording(event.fileUri);
        return;
      }
      setSavingRecording(true);
      let persistedUri: string;
      try {
        assertAccountOperationScope(scope);
        await assertSessionIdAvailable(id);
        assertAccountOperationScope(scope);
        if (!event.fileUri) {
          throw new Error('The recorder did not return an audio file.');
        }
        persistedUri = persistRecording(event.fileUri, id, scope);
        assertAccountOperationScope(scope);
        setRecording({ uri: persistedUri, durationMs: event.durationMs });
        if (event.reason === 'background') {
          setRecordingStopNotice(
            'Recording stopped because PhotoSpeak went to the background.'
          );
        } else if (event.reason === 'interruption') {
          setRecordingStopNotice(
            'Recording stopped safely after an audio interruption.'
          );
        } else {
          setRecordingStopNotice(null);
        }
      } catch (error) {
        deleteTemporaryRecording(event.fileUri);
        console.warn('[recorder] failed to save auto-stopped recording', error);
        Sentry.captureException(error, {
          tags: { area: 'session.recording.auto-save', reason: event.reason },
        });
        Alert.alert('保存录音失败', '录音已停止，请重新录一次');
        return;
      } finally {
        if (isAccountOperationScopeCurrent(scope)) setSavingRecording(false);
      }

      // The 70-second hard limit completes the intended exercise, so continue
      // directly into transcription. Background/interruption stops stay on
      // the review step and let the user choose whether to keep the partial.
      if (event.reason !== 'limit') return;

      setTranscribing(true);
      try {
        const text = await event.transcript;
        assertAccountOperationScope(scope);
        if (text.trim().length === 0) {
          Alert.alert(
            '没听清',
            '录音里没识别到内容。试着说大声一点，或者凑近麦克风。'
          );
          return;
        }
        setTranscript(text);
      } catch (error) {
        console.warn('[recorder] auto transcription failed', error);
        Sentry.captureException(error, {
          tags: { area: 'session.transcribe.auto' },
        });
        Alert.alert('识别失败', friendlyTranscribeMessage(error));
      } finally {
        if (isAccountOperationScopeCurrent(scope)) setTranscribing(false);
      }
    },
    [id]
  );

  const handleGraceStarted = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
      () => {}
    );
  }, []);

  const recorder = useRecorder({
    onAutoStop: handleAutoStopped,
    onGraceStarted: handleGraceStarted,
  });
  const discardRecording = recorder.discard;
  const recordingActionInFlightRef = useRef(false);

  // Tabs remain mounted when users switch away. Treat losing focus as an
  // audio privacy boundary so a recorder can never continue while another
  // tab starts the native player.
  useFocusEffect(
    useCallback(
      () => () => {
        void discardRecording()
          .catch((error: unknown) => {
            console.warn('[recorder] focus-loss discard failed', error);
          })
          .finally(() => {
            recordingScopeRef.current = null;
          });
      },
      [discardRecording]
    )
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const scope = captureAccountOperationScope();
      const s = await getSession(id);
      assertAccountOperationScope(scope);
      if (cancelled) return;
      if (s) {
        // Hydrate the same state shape new-session mode uses, so we can
        // reuse AnalysisChatView for archived chat replay.
        setPhoto({
          photo_uri: s.photo_uri,
          photo_thumbnail_uri: s.photo_thumbnail_uri,
          version: 0,
        });
        setTranscript(s.transcript);
        setAnalysis({
          corrected_sentences: s.corrected_sentences,
          polished_sentences: s.polished_sentences,
          chunks: s.chunks,
        });
        setChatMessages(s.chat_history);
        setMode('existing');
      } else {
        // A route id is user-controlled (deep links included). Refuse an id
        // already owned by another local account before any draft media is
        // written. Owner-namespaced storage is a second line of defence.
        await assertSessionIdAvailable(id);
        assertAccountOperationScope(scope);
        setMode('new');
      }
    })().catch((error) => {
      if (cancelled) return;
      console.warn('[session] failed to open route', error);
      Alert.alert('无法打开练习', '这个练习链接无效或属于其他账号', [
        { text: '返回', onPress: () => router.back() },
      ]);
    });
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  const handlePick = async (source: 'random' | 'choose') => {
    if (recorder.phase !== 'idle' || savingRecording) return;
    const scope = captureAccountOperationScope();
    setPicking(true);
    try {
      const result: PickerResult =
        source === 'random'
          ? await pickRandomFromLibrary()
          : await pickFromLibrary();
      if (!result.ok) {
        showPickerError(result.error);
        return;
      }
      assertAccountOperationScope(scope);
      await ensureSessionStorageCapacity();
      assertAccountOperationScope(scope);
      await assertSessionIdAvailable(id);
      assertAccountOperationScope(scope);
      const saved = await savePhoto(result.uri, id, scope);
      assertAccountOperationScope(scope);
      setPhoto(saved);
      setRecording(null);
      setTranscript(null);
      setAnalysis(null);
      setChatMessages([]);
      setRecordingStopNotice(null);
    } catch (e) {
      if (!isAccountOperationScopeCurrent(scope)) return;
      console.warn('[handlePick] error', e);
      Sentry.captureException(e, { tags: { area: 'session.pick' } });
      Alert.alert(
        e instanceof StorageCapacityError ? '存储空间不足' : '照片打不开',
        e instanceof Error && e instanceof StorageCapacityError
          ? e.message
          : '换一张照片试试'
      );
    } finally {
      if (isAccountOperationScopeCurrent(scope)) setPicking(false);
    }
  };

  const handleToggleRecord = async () => {
    if (
      recordingActionInFlightRef.current ||
      (recorder.phase !== 'idle' && recorder.phase !== 'recording')
    ) {
      return;
    }
    recordingActionInFlightRef.current = true;
    let temporaryUri: string | null = null;
    try {
      if (recorder.phase === 'recording') {
        const scope = recordingScopeRef.current;
        if (!scope) throw new Error('Recording account scope is unavailable');
        const ms = recorder.durationMs;
        setSavingRecording(true);
        try {
          temporaryUri = await recorder.stop();
          assertAccountOperationScope(scope);
          if (!temporaryUri) return;
          await assertSessionIdAvailable(id);
          assertAccountOperationScope(scope);
          const persistedUri = persistRecording(temporaryUri, id, scope);
          temporaryUri = null;
          assertAccountOperationScope(scope);
          setRecording({ uri: persistedUri, durationMs: ms });
          setRecordingStopNotice(null);
        } catch (e) {
          deleteTemporaryRecording(temporaryUri);
          console.warn('[handleToggleRecord] stop error', e);
          Sentry.captureException(e, {
            tags: { area: 'session.recording.save' },
          });
          if (isAccountOperationScopeCurrent(scope)) {
            Alert.alert('保存录音失败', '重新录一次试试');
          }
        } finally {
          if (isAccountOperationScopeCurrent(scope)) {
            setSavingRecording(false);
          }
        }
      } else {
        const scope = captureAccountOperationScope();
        recordingScopeRef.current = scope;
        // A live player and recorder must never contend for the audio session
        // or let generated speech leak back into the microphone.
        await player.stop();
        assertAccountOperationScope(scope);
        await assertSessionIdAvailable(id);
        assertAccountOperationScope(scope);
        setRecordingStopNotice(null);
        try {
          const ok = await recorder.start();
          assertAccountOperationScope(scope);
          if (ok) return;
          if (recordingScopeRef.current === scope) {
            recordingScopeRef.current = null;
          }
          Alert.alert(
            '录音未开始',
            '请允许麦克风权限，并保持 PhotoSpeak 在前台后重试。'
          );
        } catch (error) {
          if (recordingScopeRef.current === scope) {
            recordingScopeRef.current = null;
          }
          console.warn('[handleToggleRecord] start error', error);
          if (isAccountOperationScopeCurrent(scope)) {
            Alert.alert(
              error instanceof RecorderRecoveryRequiredError
                ? '录音组件正在恢复'
                : '录音无法开始',
              error instanceof RecorderRecoveryRequiredError
                ? error.message
                : '请确认没有其他应用占用麦克风，然后重试。'
            );
          }
        }
      }
    } catch (error) {
      recordingScopeRef.current = null;
      console.warn('[handleToggleRecord] audio transition failed', error);
      Alert.alert(
        error instanceof PlaybackRecoveryRequiredError
          ? '播放器正在恢复'
          : '录音无法开始',
        error instanceof Error
          ? error.message
          : '请稍后重试。'
      );
    } finally {
      recordingActionInFlightRef.current = false;
    }
  };

  const handleBack = useCallback(async () => {
    try {
      if (recorder.phase !== 'idle') {
        await recorder.discard();
      }
    } catch (error) {
      Alert.alert(
        '录音组件需要恢复',
        error instanceof Error ? error.message : '请重新打开 PhotoSpeak'
      );
    } finally {
      router.back();
    }
  }, [recorder, router]);

  const handleTranscribe = async () => {
    if (!recording) return;
    const scope = recordingScopeRef.current;
    if (!scope) {
      Alert.alert('识别失败', '录音所属账号已变化，请重新录一次');
      return;
    }
    setTranscribing(true);
    try {
      // Streaming STT is already in flight from the moment stop()
      // was called — this just awaits whatever's left of the
      // finalisation round-trip. Typical wait: < 500ms.
      const t = await recorder.getTranscript();
      assertAccountOperationScope(scope);
      if (t.length === 0) {
        Alert.alert(
          '没听清',
          '录音里没识别到内容。试着多录几秒、说大声一点，或者凑近麦克风。'
        );
        return;
      }
      setTranscript(t);
    } catch (e) {
      // Keep technical detail in logs; show the user a short,
      // actionable Chinese message keyed off the failure stage.
      console.warn('[handleTranscribe] error', e);
      // The recorder hook may have already captured this when the
      // upstream task-failed event arrived; Sentry de-dupes by
      // fingerprint so reporting here too is safe and gives us the
      // "user tapped Transcribe and saw an alert" data point.
      Sentry.captureException(e, { tags: { area: 'session.transcribe' } });
      Alert.alert('识别失败', friendlyTranscribeMessage(e));
    } finally {
      if (isAccountOperationScopeCurrent(scope)) setTranscribing(false);
    }
  };

  const handleAnalyze = async (
    mode: 'polish' | 'expand',
    restartExpired = false
  ) => {
    if (!photo || !transcript) return;
    const scope = captureAccountOperationScope();
    setAnalyzing(true);
    try {
      const result = await analyzeSession({
        sessionId: id,
        photoUri: photoUriForAnalysis(photo),
        transcript,
        mode,
        restartExpired,
      });
      assertAccountOperationScope(scope);
      setAnalysis(result);
    } catch (e) {
      if (!isAccountOperationScopeCurrent(scope)) return;
      if (e instanceof StorageCapacityError) {
        Alert.alert('存储空间不足', e.message);
        return;
      }
      if (
        e instanceof AiServiceError &&
        requiresExplicitAiRestart(e.code) &&
        !restartExpired
      ) {
        const uncertain = e.code === 'AI_OPERATION_UNCERTAIN';
        Alert.alert(
          uncertain ? '上次请求结果不确定' : '上次结果无法继续使用',
          uncertain
            ? '模型服务可能已经处理并计费，但结果未能安全保存。App 不会自动重试；如果继续，可能再次计费。是否仍要发起一次新请求？'
            : '为避免重复计费，App 没有自动再次调用 AI。是否确认重新生成？',
          [
            { text: '取消', style: 'cancel' },
            {
              text: uncertain ? '仍要重新生成' : '重新生成',
              onPress: () => void handleAnalyze(mode, true),
            },
          ]
        );
        return;
      }
      console.warn('[handleAnalyze] error', e);
      Sentry.captureException(e, { tags: { area: 'session.analyze', mode } });
      Alert.alert('分析失败', '网络不太稳，请稍后再试');
    } finally {
      if (isAccountOperationScopeCurrent(scope)) setAnalyzing(false);
    }
  };

  const handleSendChat = async (
    question: string,
    restartExpired = false
  ) => {
    if (!photo || !transcript || !analysis) return;
    const trimmed = question.trim();
    if (!trimmed) return;
    const scope = captureAccountOperationScope();
    const userMsg: ChatMessage = {
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };
    const historyForApi = chatMessages;
    setChatMessages((prev) => appendVisibleMessages(prev, userMsg));
    setChatPending(true);
    try {
      const followUp = await followUpChat({
        sessionId: id,
        photoUri: photoUriForAnalysis(photo),
        transcript,
        analysis,
        history: historyForApi,
        question: trimmed,
        restartExpired,
      });
      assertAccountOperationScope(scope);
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: followUp.content,
        timestamp: new Date().toISOString(),
      };
      // Persist the pair only after the AI reply succeeds. This avoids orphan
      // user rows after a network failure and keeps sequence assignment atomic.
      if (mode === 'existing') {
        await appendSessionChatMessages(id, [userMsg, assistantMsg]);
        assertAccountOperationScope(scope);
        // The server tombstone remains authoritative. Once this exact reply is
        // durably appended locally, its mobile retry row is no longer needed.
        await deleteCompletedAiIntent({
          ...followUp.completedIntent,
          expectedOwner: scope.owner,
        }).catch((error) => {
          console.warn('[handleSendChat] intent cleanup failed', error);
        });
      }
      setChatMessages((prev) => appendVisibleMessages(prev, assistantMsg));
    } catch (e) {
      if (!isAccountOperationScopeCurrent(scope)) return;
      if (e instanceof StorageCapacityError) {
        setChatMessages(historyForApi);
        Alert.alert('存储空间不足', e.message);
        return;
      }
      if (
        e instanceof AiServiceError &&
        requiresExplicitAiRestart(e.code) &&
        !restartExpired
      ) {
        const uncertain = e.code === 'AI_OPERATION_UNCERTAIN';
        setChatMessages(historyForApi);
        Alert.alert(
          uncertain ? '上次提问结果不确定' : '上次回复无法继续使用',
          uncertain
            ? '模型服务可能已经处理并计费，但回复未能安全保存。App 不会自动重试；如果继续，可能再次计费。是否仍要发起一次新提问？'
            : '为避免重复计费，App 没有自动再次提问。是否确认重新生成回复？',
          [
            { text: '取消', style: 'cancel' },
            {
              text: uncertain ? '仍要提问' : '重新生成',
              onPress: () => void handleSendChat(trimmed, true),
            },
          ]
        );
        return;
      }
      console.warn('[handleSendChat] error', e);
      Sentry.captureException(e, { tags: { area: 'session.chat' } });
      Alert.alert('回复失败', '网络不太稳，请稍后再试');
      setChatMessages(historyForApi);
    } finally {
      if (isAccountOperationScopeCurrent(scope)) setChatPending(false);
    }
  };

  const handleConfirmGenerate = async (restartExpired = false) => {
    if (!photo || !recording || !transcript || !analysis) return;
    const scope = captureAccountOperationScope();
    setGenerating(true);
    setGenerateProgress(null);
    try {
      await generateSession({
        sessionId: id,
        photoUri: photo.photo_uri,
        photoThumbnailUri: photo.photo_thumbnail_uri,
        recordingUri: recording.uri,
        transcript,
        analysis,
        chatHistory: chatMessages,
        restartExpired,
        onProgress: setGenerateProgress,
      });
      assertAccountOperationScope(scope);
      // Stay on the page. Transition to 'existing' mode so the
      // AnalysisChatView re-renders without the Save button and with
      // the chat composer enabled. Show the saved-hint banner so the
      // user knows what just happened.
      setMode('existing');
      setShowSavedHint(true);
    } catch (e) {
      if (!isAccountOperationScopeCurrent(scope)) return;
      if (e instanceof StorageCapacityError) {
        Alert.alert('存储空间不足', e.message);
        return;
      }
      if (
        e instanceof SpeechSynthesisError &&
        requiresExplicitAiRestart(e.code) &&
        !restartExpired
      ) {
        const uncertain = e.code === 'AI_OPERATION_UNCERTAIN';
        Alert.alert(
          uncertain ? '上次语音结果不确定' : '上次语音无法继续使用',
          uncertain
            ? '语音服务可能已经处理并计费，但音频未能安全保存。已完成句子仍会复用；如果继续，缺失句子可能再次计费。是否仍要重新生成？'
            : '已完成的句子会继续复用。缺失句子是否确认重新生成？',
          [
            { text: '取消', style: 'cancel' },
            {
              text: uncertain ? '仍要重新生成' : '重新生成',
              onPress: () => void handleConfirmGenerate(true),
            },
          ]
        );
        return;
      }
      Alert.alert(
        'Generation failed',
        e instanceof Error ? e.message : String(e)
      );
    } finally {
      if (isAccountOperationScopeCurrent(scope)) {
        setGenerating(false);
        setGenerateProgress(null);
      }
    }
  };

  const handleRetakeRecording = () => {
    const scope = recordingScopeRef.current;
    if (scope && isAccountOperationScopeCurrent(scope)) {
      try {
        deleteRecording(id, scope);
      } catch {
        // The orphan janitor can finish cleanup after a transient file error.
      }
    }
    recordingScopeRef.current = null;
    setRecording(null);
    setTranscript(null);
    setAnalysis(null);
    setChatMessages([]);
    setRecordingStopNotice(null);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <SessionHeader
        title={mode === 'new' ? 'New session' : 'Session'}
        onHelp={() => setHelpVisible(true)}
        onBack={handleBack}
      />

      <SessionHelpModal
        visible={helpVisible}
        onClose={() => setHelpVisible(false)}
      />

      {mode === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textTertiary} />
        </View>
      )}

      {mode === 'existing' && photo && transcript && analysis && (
        <AnalysisChatView
          photo={photo}
          transcript={transcript}
          analysis={analysis}
          chatMessages={chatMessages}
          chatPending={chatPending}
          analyzing={false}
          showSavedHint={showSavedHint}
          onSendChat={handleSendChat}
        />
      )}

      {mode === 'new' && analysis && transcript && photo ? (
        <AnalysisChatView
          photo={photo}
          transcript={transcript}
          analysis={analysis}
          chatMessages={chatMessages}
          chatPending={chatPending}
          analyzing={false}
          generating={generating}
          generateProgress={generateProgress}
          onSendChat={handleSendChat}
          onConfirm={handleConfirmGenerate}
          onRetake={handleRetakeRecording}
        />
      ) : mode === 'new' && analyzing && transcript && photo ? (
        <AnalysisChatView
          photo={photo}
          transcript={transcript}
          analysis={null}
          chatMessages={[]}
          chatPending={false}
          analyzing={true}
          generating={false}
          generateProgress={null}
          onSendChat={() => {}}
          onConfirm={() => {}}
          onRetake={handleRetakeRecording}
        />
      ) : mode === 'new' ? (
        <PreAnalysisView
          photo={photo}
          picking={picking}
          recording={recording}
          recorderPhase={recorder.phase}
          recorderRemainingMs={recorder.remainingMs}
          recorderPeriod={recorder.period}
          savingRecording={savingRecording}
          recordingStopNotice={recordingStopNotice}
          transcribing={transcribing}
          transcript={transcript}
          onPick={handlePick}
          onToggleRecord={handleToggleRecord}
          onTranscribe={handleTranscribe}
          onTranscriptChange={setTranscript}
          onAnalyze={handleAnalyze}
          onRetakeRecording={handleRetakeRecording}
        />
      ) : null}
    </View>
  );
}

function appendVisibleMessages(
  messages: readonly ChatMessage[],
  next: ChatMessage
): ChatMessage[] {
  return [...messages, next].slice(-MAX_VISIBLE_CHAT_MESSAGES);
}

function requiresExplicitAiRestart(code?: string): boolean {
  return (
    code === 'IDEMPOTENCY_RESULT_EXPIRED' ||
    code === 'IDEMPOTENCY_KEY_EXPIRED' ||
    code === 'IDEMPOTENCY_RECOVERY_FENCE' ||
    code === 'AI_OPERATION_POLICY_CHANGED' ||
    code === 'AI_OPERATION_UNCERTAIN'
  );
}

function PreAnalysisView({
  photo,
  picking,
  recording,
  recorderPhase,
  recorderRemainingMs,
  recorderPeriod,
  savingRecording,
  recordingStopNotice,
  transcribing,
  transcript,
  onPick,
  onToggleRecord,
  onTranscribe,
  onTranscriptChange,
  onAnalyze,
  onRetakeRecording,
}: {
  photo: SavedPhoto | null;
  picking: boolean;
  recording: SavedRecording | null;
  recorderPhase: RecorderPhase;
  recorderRemainingMs: number;
  recorderPeriod: RecordingPeriod;
  savingRecording: boolean;
  recordingStopNotice: string | null;
  transcribing: boolean;
  transcript: string | null;
  onPick: (source: 'random' | 'choose') => void;
  onToggleRecord: () => void;
  onTranscribe: () => void;
  onTranscriptChange: (text: string) => void;
  onAnalyze: (mode: 'polish' | 'expand') => void;
  onRetakeRecording: () => void;
}) {
  const pickerLocked = recorderPhase !== 'idle' || savingRecording;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.preRoot}
      // No offset needed — we render our own header (headerShown: false),
      // so KAV's frame is measured against absolute screen coords and
      // doesn't need to compensate for a navigator-rendered header.
      keyboardVerticalOffset={0}
    >
      <ScrollView
        contentContainerStyle={styles.preContainer}
        // 'always' so taps on cards / outside the input don't dismiss
        // the keyboard — users need to scroll the page around while
        // editing the transcript without losing the keyboard.
        keyboardShouldPersistTaps="always"
        // Drag-down inside the scroll view is the explicit "I want to
        // dismiss" gesture (matches iOS Messages / Mail).
        keyboardDismissMode="interactive"
      >
        <PhotoArea photo={photo} />

        <View style={styles.pickerRow}>
          <Pill
            label="Random"
            onPress={pickerLocked ? undefined : () => onPick('random')}
            variant="filter"
            active={false}
            style={pickerLocked ? styles.disabledControl : undefined}
          />
          <Pill
            label="Choose"
            onPress={pickerLocked ? undefined : () => onPick('choose')}
            variant="filter"
            active={false}
            style={pickerLocked ? styles.disabledControl : undefined}
          />
        </View>

        {photo && (
          <View style={styles.actionArea}>
            {transcript ? (
              <TranscriptStage
                transcript={transcript}
                onChange={onTranscriptChange}
                onAnalyze={onAnalyze}
                onRetake={onRetakeRecording}
              />
            ) : transcribing ? (
              <BusyStage label="Transcribing…" />
            ) : recording ? (
              <RecordingDoneStage
                durationMs={recording.durationMs}
                notice={recordingStopNotice}
                onTranscribe={onTranscribe}
                onRetake={onRetakeRecording}
              />
            ) : (
              <RecordStage
                phase={recorderPhase}
                remainingMs={recorderRemainingMs}
                period={recorderPeriod}
                busy={savingRecording || picking}
                onToggle={onToggleRecord}
              />
            )}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function PhotoArea({ photo }: { photo: SavedPhoto | null }) {
  if (!photo) {
    return (
      <View style={styles.photoPlaceholder}>
        <Ionicons name="image-outline" size={36} color={colors.textTertiary} />
        <Text style={styles.photoHint}>Pick a photo to describe</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: `${photo.photo_uri}?v=${photo.version}` }}
      style={styles.photo}
      contentFit="cover"
    />
  );
}

function RecordStage({
  phase,
  remainingMs,
  period,
  busy,
  onToggle,
}: {
  phase: RecorderPhase;
  remainingMs: number;
  period: RecordingPeriod;
  busy: boolean;
  onToggle: () => void;
}) {
  const recording = phase === 'recording';
  const inactive = busy || phase === 'starting' || phase === 'stopping';
  const grace = period === 'grace';
  const hint =
    phase === 'starting'
      ? 'Starting microphone…'
      : phase === 'stopping' || busy
        ? 'Saving recording…'
        : grace
          ? 'Wrap up — recording stops automatically'
          : recording
            ? 'Describe the photo · tap to stop early'
            : 'Tap to start · 1 minute + 10 seconds to wrap up';

  return (
    <View style={styles.recordCenter}>
      {recording && (
        <Text style={[styles.recordPeriodLabel, grace && styles.graceText]}>
          {grace ? 'WRAP UP' : 'TIME LEFT'}
        </Text>
      )}
      <Text style={[styles.timer, grace && styles.graceText]}>
        {recording ? formatCountdown(remainingMs) : '01:00'}
      </Text>
      <Text style={[styles.recordHint, grace && styles.graceText]}>{hint}</Text>
      <Pressable
        onPress={onToggle}
        disabled={inactive}
        accessibilityRole="button"
        accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
        accessibilityState={{ disabled: inactive }}
        style={({ pressed }) => [
          styles.recordButton,
          recording && styles.recordButtonRecording,
          grace && styles.recordButtonGrace,
          pressed && !inactive && { opacity: 0.85 },
          inactive && { opacity: 0.5 },
        ]}
        hitSlop={8}
      >
        <Ionicons
          name={recording ? 'stop' : 'mic'}
          size={32}
          color={recording ? '#fff' : colors.textPrimary}
        />
      </Pressable>
    </View>
  );
}

function RecordingDoneStage({
  durationMs,
  notice,
  onTranscribe,
  onRetake,
}: {
  durationMs: number;
  notice: string | null;
  onTranscribe: () => void;
  onRetake: () => void;
}) {
  return (
    <View style={styles.actionStack}>
      <Text style={styles.recordedLabel}>
        Recorded {formatDuration(durationMs)}
      </Text>
      {notice && <Text style={styles.recordingStopNotice}>{notice}</Text>}
      <PrimaryButton
        label="Transcribe"
        icon="sparkles-outline"
        onPress={onTranscribe}
        fullWidth
      />
      <Pressable onPress={onRetake} style={styles.linkButton}>
        <Text style={styles.linkText}>Re-record</Text>
      </Pressable>
    </View>
  );
}

function TranscriptStage({
  transcript,
  onChange,
  onAnalyze,
  onRetake,
}: {
  transcript: string;
  onChange: (text: string) => void;
  onAnalyze: (mode: 'polish' | 'expand') => void;
  onRetake: () => void;
}) {
  const empty = transcript.trim().length === 0;
  return (
    <View style={styles.actionStack}>
      <View style={styles.transcriptHeader}>
        <Text style={styles.sectionLabel}>Transcript</Text>
        <Text style={styles.transcriptHint}>Tap to edit</Text>
      </View>
      <Card style={styles.transcriptCard} padding="md">
        <TextInput
          style={styles.transcriptInput}
          value={transcript}
          onChangeText={onChange}
          multiline
          textAlignVertical="top"
          scrollEnabled
          placeholder="Edit your transcript here…"
          placeholderTextColor={colors.textTertiary}
        />
      </Card>
      <PrimaryButton
        label="Polish my words"
        icon="create-outline"
        onPress={() => onAnalyze('polish')}
        fullWidth
        disabled={empty}
      />
      <PrimaryButton
        label="Help me say more"
        icon="sparkles-outline"
        variant="ghost"
        onPress={() => onAnalyze('expand')}
        fullWidth
        disabled={empty}
      />
      <Pressable onPress={onRetake} style={styles.linkButton}>
        <Text style={styles.linkText}>Re-record</Text>
      </Pressable>
    </View>
  );
}

function BusyStage({ label }: { label: string }) {
  return (
    <View style={styles.busyStage}>
      <ActivityIndicator color={colors.textTertiary} />
      <Text style={styles.busyLabel}>{label}</Text>
    </View>
  );
}

/**
 * Versioned files were normalized and size-bounded by the current storage
 * pipeline. Legacy beta originals may contain HEIC bytes behind a .jpg name,
 * so their known-good JPEG thumbnail remains the safe compatibility input.
 */
function photoUriForAnalysis(photo: SavedPhoto): string {
  return /-\d+\.jpg$/i.test(photo.photo_uri)
    ? photo.photo_uri
    : photo.photo_thumbnail_uri;
}

function AnalysisChatView({
  photo,
  transcript,
  analysis,
  chatMessages,
  chatPending,
  analyzing,
  generating = false,
  generateProgress = null,
  showSavedHint = false,
  onSendChat,
  onConfirm,
  onRetake,
}: {
  photo: SavedPhoto;
  transcript: string;
  analysis: AnalysisResult | null;
  chatMessages: ChatMessage[];
  chatPending: boolean;
  analyzing: boolean;
  generating?: boolean;
  generateProgress?: GenerateProgress | null;
  /** True briefly right after Save & Generate succeeds — shows the
   *  "Saved. Ask follow-up questions… chat won't change saved
   *  content" hint banner above the chat composer. */
  showSavedHint?: boolean;
  onSendChat: (text: string) => void;
  onConfirm?: () => void;
  onRetake?: () => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const [draft, setDraft] = useState('');
  // Pre-generation: only show Save & Generate button, no chat composer
  // (chat is meant for clarification questions about the saved
  // content, which doesn't exist yet). Post-generation: chat composer
  // appears, Save button is gone.
  const isPreGen = !!onConfirm;

  useEffect(() => {
    const t = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      60
    );
    return () => clearTimeout(t);
  }, [chatMessages.length, chatPending, analyzing]);

  const submit = () => {
    const v = draft.trim();
    if (!v || chatPending) return;
    onSendChat(v);
    setDraft('');
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.chatRoot}
      // No offset — see the matching comment in PreAnalysisView.
      keyboardVerticalOffset={0}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.chatScroll}
        contentContainerStyle={styles.chatScrollInner}
        // 'always' so users can scroll while typing without losing
        // the keyboard. Drag-down dismisses (interactive mode).
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="interactive"
      >
        <Image
          source={{ uri: `${photo.photo_uri}?v=${photo.version}` }}
          style={styles.chatPhoto}
          contentFit="cover"
        />

        <UserBubble text={transcript} />

        {analysis ? (
          <AnalysisBubble analysis={analysis} />
        ) : analyzing ? (
          <AssistantBubbleCenter>
            <ActivityIndicator color={colors.textTertiary} />
            <Text style={styles.busyLabel}>Analyzing…</Text>
          </AssistantBubbleCenter>
        ) : null}

        {chatMessages.map((m, i) =>
          m.role === 'user' ? (
            <UserBubble key={i} text={m.content} />
          ) : (
            <AssistantBubble key={i}>
              <Markdown style={markdownStyles}>{m.content}</Markdown>
            </AssistantBubble>
          )
        )}

        {chatPending && (
          <AssistantBubble>
            <ActivityIndicator color={colors.textTertiary} />
          </AssistantBubble>
        )}

        {analysis && onConfirm && (
          <View style={styles.analysisFooter}>
            <PrimaryButton
              label={
                generating
                  ? formatGenerateProgress(generateProgress ?? null)
                  : 'Save & Generate'
              }
              icon={generating ? undefined : 'sparkles-outline'}
              fullWidth
              disabled={generating}
              onPress={onConfirm}
              variant="amber"
            />
            {generating && (
              <View style={styles.progressBarTrack}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${progressPercent(generateProgress ?? null)}%`,
                    },
                  ]}
                />
              </View>
            )}
            {!generating && onRetake && (
              <Pressable onPress={onRetake} style={styles.linkButton}>
                <Text style={styles.linkText}>Re-record</Text>
              </Pressable>
            )}
          </View>
        )}
      </ScrollView>

      {!isPreGen && (
        <>
          {showSavedHint && (
            <View style={styles.savedHintBanner}>
              <Ionicons
                name="checkmark-circle"
                size={16}
                color={colors.accentText}
              />
              <Text style={styles.savedHintText}>
                Saved. Ask follow-up questions below — chat won’t change
                the saved podcast or cards.
              </Text>
            </View>
          )}
          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="Ask a follow-up…"
              placeholderTextColor={colors.textTertiary}
              editable={!!analysis && !chatPending}
              multiline
              returnKeyType="send"
              onSubmitEditing={submit}
              blurOnSubmit
            />
            <Pressable
              onPress={submit}
              disabled={!analysis || chatPending || draft.trim().length === 0}
              style={({ pressed }) => [
                styles.composerSend,
                (!analysis || chatPending || draft.trim().length === 0) && {
                  opacity: 0.4,
                },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Ionicons name="arrow-up" size={18} color={colors.textPrimary} />
            </Pressable>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <View style={styles.userBubbleRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userBubbleText}>{text}</Text>
      </View>
    </View>
  );
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.assistantBubbleRow}>
      <View style={styles.assistantBubble}>{children}</View>
    </View>
  );
}

function AssistantBubbleCenter({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.assistantBubbleRow}>
      <View style={[styles.assistantBubble, styles.assistantBubbleCenter]}>
        {children}
      </View>
    </View>
  );
}

function AnalysisBubble({ analysis }: { analysis: AnalysisResult }) {
  return (
    <AssistantBubble>
      {analysis.corrected_sentences.length > 0 && (
        <View style={styles.bubbleSection}>
          <Text style={styles.sectionLabel}>Corrections</Text>
          {analysis.corrected_sentences.map((c, i) => (
            <View key={i} style={styles.correctionBlock}>
              <Text style={styles.correctionStrike}>{c.original}</Text>
              <Text style={styles.correctionFixed}>{c.corrected}</Text>
              {c.explanation ? (
                <Text style={styles.correctionNote}>{c.explanation}</Text>
              ) : null}
            </View>
          ))}
        </View>
      )}

      <View style={styles.bubbleSection}>
        <Text style={styles.sectionLabel}>Polished</Text>
        <Text style={styles.bubbleText}>
          {analysis.polished_sentences.join(' ')}
        </Text>
      </View>

      {analysis.chunks.length > 0 && (
        <View style={styles.bubbleSection}>
          <Text style={styles.sectionLabel}>Chunks to remember</Text>
          <View style={styles.chunkRow}>
            {analysis.chunks.map((chunk) => (
              <Pill key={chunk.id} label={chunk.chunk} variant="chunk" />
            ))}
          </View>
          {analysis.chunks.map((chunk) => (
            <View key={`note-${chunk.id}`} style={styles.chunkNoteBlock}>
              <Text style={styles.chunkNoteHeader}>{chunk.chunk}</Text>
              {chunk.usage_note ? (
                <Text style={styles.chunkNote}>{chunk.usage_note}</Text>
              ) : null}
              {chunk.examples.map((ex, i) => (
                <Text key={i} style={styles.chunkExample}>
                  · {ex.text}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}
    </AssistantBubble>
  );
}

function SessionHeader({
  title,
  onHelp,
  onBack,
}: {
  title: string;
  onHelp: () => void;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top, height: insets.top + HEADER_BODY_HEIGHT },
      ]}
    >
      <Pressable
        onPress={onBack}
        hitSlop={10}
        style={({ pressed }) => [
          styles.headerSide,
          pressed && { opacity: 0.5 },
        ]}
      >
        <Ionicons
          name="chevron-back"
          size={24}
          color={colors.textPrimary}
        />
        <Text style={styles.headerBackLabel}>Sessions</Text>
      </Pressable>

      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>

      <Pressable
        onPress={onHelp}
        hitSlop={10}
        style={({ pressed }) => [
          styles.headerSide,
          styles.headerRight,
          pressed && { opacity: 0.5 },
        ]}
      >
        <Ionicons
          name="help-circle-outline"
          size={24}
          color={colors.textSecondary}
        />
      </Pressable>
    </View>
  );
}

function SessionHelpModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.helpOverlay}>
        <View style={styles.helpSheet}>
          <ScrollView
            style={styles.helpScroll}
            contentContainerStyle={styles.helpContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.helpTitle}>How PhotoSpeak Sessions Work</Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>1. </Text>
              <Text style={styles.helpStepBold}>Record</Text> for one minute
              describing the photo in English. At 1:00 you get 10 seconds to
              wrap up; recording stops automatically at 1:10.
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>2. </Text>
              <Text style={styles.helpStepBold}>Transcribe</Text> turns the
              audio into text.
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>3. </Text>Choose{' '}
              <Text style={styles.helpStepBold}>Polish my words</Text>{' '}
              (faithful rewrite) or{' '}
              <Text style={styles.helpStepBold}>Help me say more</Text> (AI
              expands your words into a longer monologue).
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>4. </Text>Read the polished
              version and the reusable phrases (chunks).
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>5. </Text>Tap{' '}
              <Text style={styles.helpStepBold}>Save & Generate</Text> to
              lock it in. Each polished sentence becomes audio (added to
              your Listening library), and each chunk becomes a flashcard.
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>6. </Text>After saving, you
              can ask follow-up questions in chat. The AI will explain in
              Chinese, but the chat won’t change the saved podcast or
              cards — it’s for understanding only.
            </Text>
            <Text style={styles.helpTip}>
              Tip: if you don’t like the polished result, just re-record
              before saving.
            </Text>

            <View style={styles.helpDivider} />

            <Text style={styles.helpTitle}>PhotoSpeak 会话流程</Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>1. </Text>
              <Text style={styles.helpStepBold}>录音</Text>{' '}
              1 分钟，用英语描述照片。到 1:00 后有 10 秒收尾时间，1:10
              自动停止。
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>2. </Text>
              <Text style={styles.helpStepBold}>转写</Text>{' '}
              AI 把语音转成文字。
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>3. </Text>选{' '}
              <Text style={styles.helpStepBold}>Polish my words</Text>{' '}
              (忠实改写) 或{' '}
              <Text style={styles.helpStepBold}>Help me say more</Text>{' '}
              (基于你的开头扩展成更长段落)。
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>4. </Text>
              阅读 polished 版本和可复用短语 (chunks)。
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>5. </Text>点{' '}
              <Text style={styles.helpStepBold}>Save & Generate</Text>{' '}
              定稿。每句 polished 生成 TTS 音频（进入听力库），每个 chunk
              生成一张复习卡片。
            </Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>6. </Text>
              保存后可以在对话框追问任何疑问，AI 用中文解释。
              <Text style={styles.helpStepBold}>
                聊天不会修改已生成的播客和卡片
              </Text>
              ，仅供答疑。
            </Text>
            <Text style={styles.helpTip}>
              提示：如果对 polished 结果不满意，保存前可以直接重新录音。
            </Text>
          </ScrollView>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [
              styles.helpCloseBtn,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={styles.helpCloseBtnText}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function showPickerError(error: PickerError): void {
  if (error.kind === 'cancelled') return;
  if (error.kind === 'permission_denied') {
    Alert.alert(
      'Photo access needed',
      'Grant photo library access in Settings to continue.'
    );
    return;
  }
  if (error.kind === 'no_photos') {
    Alert.alert('No photos found', 'Your library appears to be empty.');
    return;
  }
}

function formatGenerateProgress(p: GenerateProgress | null): string {
  if (!p) return 'Starting…';
  switch (p.kind) {
    case 'sentence':
      return `Synthesizing sentence ${p.current}/${p.total}…`;
    case 'persisting':
      return 'Saving…';
    case 'done':
      return 'Done';
  }
}

function progressPercent(p: GenerateProgress | null): number {
  if (!p) return 4;
  switch (p.kind) {
    case 'sentence':
      return Math.min(95, 4 + (p.current / Math.max(p.total, 1)) * 91);
    case 'persisting':
      return 97;
    case 'done':
      return 100;
  }
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60).toString().padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(total / 60).toString().padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

// react-native-markdown-display takes a separate style object (not a
// StyleSheet) keyed by element name. We tune it to match the chat
// bubble's body text and only diverge for emphasis (bold / italic /
// code / lists).
const markdownStyles = {
  body: { ...text.body, color: colors.textPrimary },
  paragraph: {
    marginTop: 0,
    marginBottom: 8,
  },
  strong: { fontWeight: '700' as const },
  em: { fontStyle: 'italic' as const },
  // Headings: scale modestly — chat doesn't want huge h1s.
  heading1: {
    fontSize: 17,
    fontWeight: '700' as const,
    color: colors.textPrimary,
    marginTop: 4,
    marginBottom: 6,
  },
  heading2: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: colors.textPrimary,
    marginTop: 4,
    marginBottom: 6,
  },
  heading3: {
    fontSize: 15,
    fontWeight: '700' as const,
    color: colors.textPrimary,
    marginTop: 4,
    marginBottom: 6,
  },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginBottom: 4 },
  code_inline: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    backgroundColor: colors.pillBg,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  fence: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    backgroundColor: colors.pillBg,
    padding: 8,
    borderRadius: 6,
    marginVertical: 4,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.separator,
    paddingLeft: 10,
    marginVertical: 4,
  },
  link: { color: colors.accentText, textDecorationLine: 'underline' as const },
  hr: {
    backgroundColor: colors.separator,
    height: 1,
    marginVertical: 8,
  },
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  placeholderTitle: {
    ...text.cardTitle,
    fontSize: 17,
    marginBottom: 4,
  },
  placeholderSubtitle: {
    ...text.caption,
  },

  preRoot: {
    flex: 1,
  },
  preContainer: {
    flexGrow: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  photo: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.card,
    backgroundColor: colors.pillBg,
  },
  photoPlaceholder: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    ...shadow,
  },
  photoHint: {
    ...text.caption,
    color: colors.textTertiary,
  },
  pickerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  disabledControl: {
    opacity: 0.45,
  },
  actionArea: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  recordCenter: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  timer: {
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
    color: colors.textPrimary,
  },
  recordPeriodLabel: {
    ...text.micro,
    color: colors.textTertiary,
    letterSpacing: 1.2,
    marginBottom: -4,
  },
  graceText: {
    color: '#B63D3D',
  },
  recordHint: {
    ...text.caption,
    color: colors.textTertiary,
  },
  recordButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    ...shadow,
  },
  recordButtonRecording: {
    backgroundColor: '#C84B4B',
  },
  recordButtonGrace: {
    backgroundColor: '#B63D3D',
  },
  actionStack: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  recordedLabel: {
    ...text.cardTitle,
    textAlign: 'center',
  },
  recordingStopNotice: {
    ...text.caption,
    color: colors.textTertiary,
    textAlign: 'center',
  },
  linkButton: {
    alignSelf: 'center',
    padding: spacing.sm,
  },
  linkText: {
    ...text.caption,
    color: colors.accentText,
    fontWeight: '600',
  },
  busyStage: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  busyLabel: {
    ...text.caption,
  },

  sectionLabel: {
    ...text.micro,
    marginBottom: 6,
  },
  transcriptCard: {
    backgroundColor: colors.card,
    maxHeight: 200,
  },
  transcriptText: {
    ...text.body,
  },
  transcriptHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  transcriptHint: {
    ...text.caption,
    color: colors.textTertiary,
    fontSize: 11,
  },
  transcriptInput: {
    ...text.body,
    minHeight: 80,
    maxHeight: 180,
    padding: 0,
  },

  chatRoot: {
    flex: 1,
  },
  chatScroll: {
    flex: 1,
  },
  chatScrollInner: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  chatPhoto: {
    width: '100%',
    height: 180,
    borderRadius: radius.card,
    backgroundColor: colors.pillBg,
  },
  userBubbleRow: {
    alignItems: 'flex-end',
  },
  userBubble: {
    maxWidth: '85%',
    backgroundColor: colors.textPrimary,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.inner,
    borderBottomRightRadius: 4,
  },
  userBubbleText: {
    color: colors.card,
    fontSize: 15,
    lineHeight: 22,
  },
  assistantBubbleRow: {
    alignItems: 'flex-start',
  },
  assistantBubble: {
    maxWidth: '95%',
    backgroundColor: colors.card,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.card,
    borderBottomLeftRadius: 6,
    ...shadow,
  },
  assistantBubbleCenter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  bubbleText: {
    ...text.body,
  },
  bubbleSection: {
    marginTop: spacing.md,
  },
  correctionBlock: {
    marginTop: 8,
  },
  correctionStrike: {
    fontSize: 14,
    color: colors.textTertiary,
    textDecorationLine: 'line-through',
  },
  correctionFixed: {
    fontSize: 15,
    color: colors.textPrimary,
    fontWeight: '700',
    marginTop: 2,
  },
  correctionNote: {
    fontSize: 13,
    color: colors.textTertiary,
    fontStyle: 'italic',
    marginTop: 4,
    lineHeight: 19,
  },
  chunkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: spacing.sm,
  },
  chunkNoteBlock: {
    marginTop: 10,
  },
  chunkNoteHeader: {
    fontSize: 14,
    color: colors.accentText,
    fontWeight: '700',
  },
  chunkNote: {
    fontSize: 13,
    color: colors.textPrimary,
    marginTop: 2,
    lineHeight: 19,
  },
  chunkExample: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  analysisFooter: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  progressBarTrack: {
    height: 4,
    backgroundColor: colors.pillBg,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  // ── Self-rendered header (replaces native header to avoid iOS 26
  //    Liquid Glass button chrome on the headerRight icon)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  headerSide: {
    minWidth: 90,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  headerRight: {
    justifyContent: 'flex-end',
  },
  headerBackLabel: {
    fontSize: 17,
    color: colors.textPrimary,
    marginLeft: -2,
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
  },

  // ── Session help modal ─────────────────────────────────────────
  helpOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  helpSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    maxHeight: '85%',
  },
  helpScroll: { marginBottom: spacing.md },
  helpContent: { paddingBottom: spacing.md },
  helpTitle: {
    ...text.cardTitle,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  helpStep: {
    ...text.body,
    fontSize: 14,
    lineHeight: 22,
    marginBottom: 10,
  },
  helpStepNum: { fontWeight: '700' },
  helpStepBold: { fontWeight: '700' },
  helpTip: {
    fontSize: 13,
    color: colors.textSecondary,
    fontStyle: 'italic',
    marginTop: 4,
  },
  helpDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginVertical: spacing.lg,
  },
  helpCloseBtn: {
    backgroundColor: colors.textPrimary,
    borderRadius: 24,
    paddingVertical: 14,
    alignItems: 'center',
  },
  helpCloseBtnText: {
    color: colors.card,
    fontSize: 15,
    fontWeight: '700',
  },

  savedHintBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    backgroundColor: colors.accentBgSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
  savedHintText: {
    flex: 1,
    fontSize: 12,
    color: colors.accentText,
    lineHeight: 16,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
  },
  composerInput: {
    flex: 1,
    backgroundColor: colors.pillBg,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    color: colors.textPrimary,
    minHeight: 40,
    maxHeight: 120,
  },
  composerSend: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
