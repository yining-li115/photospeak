import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import {
  analyzeSession,
  followUpChat,
  type AnalysisResult,
} from '../../../src/api/mimo';
import { Card } from '../../../src/components/Card';
import {
  generateSession,
  type GenerateProgress,
} from '../../../src/services/generate';
import { Pill } from '../../../src/components/Pill';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { getSession, updateSession } from '../../../src/db/sessions';
import { useRecorder } from '../../../src/hooks/useAudioRecorder';
import { savePhoto, type SavedPhoto } from '../../../src/storage/photos';
import {
  pickFromLibrary,
  pickRandomFromLibrary,
  type PickerError,
  type PickerResult,
} from '../../../src/storage/picker';
import { persistRecording } from '../../../src/storage/recordings';
import { colors, radius, shadow, spacing, text } from '../../../src/theme';
import type { ChatMessage, Session } from '../../../src/types';

type Mode = 'loading' | 'new' | 'existing';

// Self-rendered header height (excluding the status-bar safe area
// inset, which is added separately). We render our own header so we
// can opt out of iOS 26's "Liquid Glass" headerRight button chrome —
// the white capsule it puts around custom buttons doesn't fit our
// flat amber theme. Same pattern as the sessions / listening list
// screens.
const HEADER_BODY_HEIGHT = 44;

interface SavedRecording {
  uri: string;
  durationMs: number;
}

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [mode, setMode] = useState<Mode>('loading');
  const [existingSession, setExistingSession] = useState<Session | null>(null);
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

  const recorder = useRecorder();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSession(id);
      if (cancelled) return;
      if (s) {
        setExistingSession(s);
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
        setMode('new');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handlePick = async (source: 'random' | 'choose') => {
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
      const saved = await savePhoto(result.uri, id);
      setPhoto(saved);
      setRecording(null);
      setTranscript(null);
      setAnalysis(null);
      setChatMessages([]);
    } catch (e) {
      Alert.alert('Could not load photo', String(e));
    } finally {
      setPicking(false);
    }
  };

  const handleToggleRecord = async () => {
    if (recorder.isRecording) {
      const ms = recorder.durationMs;
      setSavingRecording(true);
      try {
        const tmpUri = await recorder.stop();
        if (!tmpUri) return;
        const persistedUri = persistRecording(tmpUri, id);
        setRecording({ uri: persistedUri, durationMs: ms });
      } catch (e) {
        Alert.alert('Could not save recording', String(e));
      } finally {
        setSavingRecording(false);
      }
    } else {
      const ok = await recorder.start();
      if (!ok) {
        Alert.alert(
          'Microphone access needed',
          'Grant microphone access in Settings to continue.'
        );
      }
    }
  };

  const handleTranscribe = async () => {
    if (!recording) return;
    setTranscribing(true);
    try {
      // Streaming STT is already in flight from the moment stop()
      // was called — this just awaits whatever's left of the
      // finalisation round-trip. Typical wait: < 500ms.
      const t = await recorder.getTranscript();
      if (t.length === 0) {
        Alert.alert(
          '没听清',
          '录音里没识别到内容。试着多录几秒、说大声一点，或者凑近麦克风。'
        );
        return;
      }
      setTranscript(t);
    } catch (e) {
      Alert.alert('Transcription failed', e instanceof Error ? e.message : String(e));
    } finally {
      setTranscribing(false);
    }
  };

  const handleAnalyze = async (mode: 'polish' | 'expand') => {
    if (!photo || !transcript) return;
    setAnalyzing(true);
    try {
      const result = await analyzeSession({
        photoUri: photo.photo_thumbnail_uri,
        transcript,
        mode,
      });
      setAnalysis(result);
    } catch (e) {
      Alert.alert('Analysis failed', e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSendChat = async (question: string) => {
    if (!photo || !transcript || !analysis) return;
    const trimmed = question.trim();
    if (!trimmed) return;
    const userMsg: ChatMessage = {
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };
    const historyForApi = chatMessages;
    setChatMessages((prev) => [...prev, userMsg]);
    setChatPending(true);
    try {
      const reply = await followUpChat({
        photoUri: photo.photo_thumbnail_uri,
        transcript,
        analysis,
        history: historyForApi,
        question: trimmed,
      });
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: reply,
        timestamp: new Date().toISOString(),
      };
      setChatMessages((prev) => {
        const next = [...prev, assistantMsg];
        // Existing sessions persist follow-ups so the replay survives
        // app restarts. New sessions persist the whole bundle at
        // Confirm & Generate time, so we don't write here.
        if (mode === 'existing') {
          updateSession(id, { chat_history: next }).catch(() => {});
        }
        return next;
      });
    } catch (e) {
      Alert.alert('Reply failed', e instanceof Error ? e.message : String(e));
      setChatMessages((prev) => prev.slice(0, -1));
    } finally {
      setChatPending(false);
    }
  };

  const handleConfirmGenerate = async () => {
    if (!photo || !recording || !transcript || !analysis) return;
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
        onProgress: setGenerateProgress,
      });
      // Stay on the page. Transition to 'existing' mode so the
      // AnalysisChatView re-renders without the Save button and with
      // the chat composer enabled. Show the saved-hint banner so the
      // user knows what just happened.
      setMode('existing');
      setShowSavedHint(true);
    } catch (e) {
      Alert.alert(
        'Generation failed',
        e instanceof Error ? e.message : String(e)
      );
    } finally {
      setGenerating(false);
      setGenerateProgress(null);
    }
  };

  const handleRetakeRecording = () => {
    setRecording(null);
    setTranscript(null);
    setAnalysis(null);
    setChatMessages([]);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <SessionHeader
        title={mode === 'new' ? 'New session' : 'Session'}
        onHelp={() => setHelpVisible(true)}
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
          recorderActive={recorder.isRecording}
          recorderDurationMs={recorder.durationMs}
          savingRecording={savingRecording}
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

function PreAnalysisView({
  photo,
  picking,
  recording,
  recorderActive,
  recorderDurationMs,
  savingRecording,
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
  recorderActive: boolean;
  recorderDurationMs: number;
  savingRecording: boolean;
  transcribing: boolean;
  transcript: string | null;
  onPick: (source: 'random' | 'choose') => void;
  onToggleRecord: () => void;
  onTranscribe: () => void;
  onTranscriptChange: (text: string) => void;
  onAnalyze: (mode: 'polish' | 'expand') => void;
  onRetakeRecording: () => void;
}) {
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
            onPress={() => onPick('random')}
            variant="filter"
            active={false}
          />
          <Pill
            label="Choose"
            onPress={() => onPick('choose')}
            variant="filter"
            active={false}
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
                onTranscribe={onTranscribe}
                onRetake={onRetakeRecording}
              />
            ) : (
              <RecordStage
                recording={recorderActive}
                durationMs={recorderDurationMs}
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
  recording,
  durationMs,
  busy,
  onToggle,
}: {
  recording: boolean;
  durationMs: number;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={styles.recordCenter}>
      <Text style={styles.timer}>
        {recording ? formatDuration(durationMs) : '00:00'}
      </Text>
      <Text style={styles.recordHint}>
        {busy
          ? 'Saving…'
          : recording
            ? 'Tap again to stop'
            : 'Tap to start recording'}
      </Text>
      <Pressable
        onPress={onToggle}
        disabled={busy}
        style={({ pressed }) => [
          styles.recordButton,
          recording && styles.recordButtonRecording,
          pressed && !busy && { opacity: 0.85 },
          busy && { opacity: 0.5 },
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
  onTranscribe,
  onRetake,
}: {
  durationMs: number;
  onTranscribe: () => void;
  onRetake: () => void;
}) {
  return (
    <View style={styles.actionStack}>
      <Text style={styles.recordedLabel}>
        Recorded {formatDuration(durationMs)}
      </Text>
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
                Saved. Ask follow-up questions below — chat won't change
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
}: {
  title: string;
  onHelp: () => void;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top, height: insets.top + HEADER_BODY_HEIGHT },
      ]}
    >
      <Pressable
        onPress={() => router.back()}
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
              <Text style={styles.helpStepBold}>Record</Text> about a minute
              describing the photo in English.
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
              Chinese, but the chat won't change the saved podcast or
              cards — it's for understanding only.
            </Text>
            <Text style={styles.helpTip}>
              Tip: if you don't like the polished result, just re-record
              before saving.
            </Text>

            <View style={styles.helpDivider} />

            <Text style={styles.helpTitle}>PhotoSpeak 会话流程</Text>
            <Text style={styles.helpStep}>
              <Text style={styles.helpStepNum}>1. </Text>
              <Text style={styles.helpStepBold}>录音</Text>{' '}
              约 1 分钟，用英语描述照片。
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
  actionStack: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  recordedLabel: {
    ...text.cardTitle,
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
