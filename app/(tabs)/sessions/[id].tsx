import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { transcribeAudio, WhisperError } from '../../../src/api/whisper';
import { getSession } from '../../../src/db/sessions';
import { useRecorder } from '../../../src/hooks/useAudioRecorder';
import { savePhoto, type SavedPhoto } from '../../../src/storage/photos';
import {
  pickFromLibrary,
  pickRandomFromLibrary,
  type PickerError,
  type PickerResult,
} from '../../../src/storage/picker';
import { persistRecording } from '../../../src/storage/recordings';
import type { Session } from '../../../src/types';

type Mode = 'loading' | 'new' | 'existing';

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

  const recorder = useRecorder();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await getSession(id);
      if (cancelled) return;
      if (s) {
        setExistingSession(s);
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
    } catch (e) {
      Alert.alert('Could not load photo', String(e));
    } finally {
      setPicking(false);
    }
  };

  const handleRecordStart = async () => {
    const ok = await recorder.start();
    if (!ok) {
      Alert.alert(
        'Microphone access needed',
        'Grant microphone access in Settings to continue.'
      );
    }
  };

  const handleRecordStop = async () => {
    if (!recorder.isRecording) return;
    const durationMs = recorder.durationMs;
    setSavingRecording(true);
    try {
      const tmpUri = await recorder.stop();
      if (!tmpUri) return;
      const persistedUri = persistRecording(tmpUri, id);
      setRecording({ uri: persistedUri, durationMs });
    } catch (e) {
      Alert.alert('Could not save recording', String(e));
    } finally {
      setSavingRecording(false);
    }
  };

  const handleTranscribe = async () => {
    if (!recording) return;
    setTranscribing(true);
    try {
      const text = await transcribeAudio(recording.uri);
      if (text.length === 0) {
        Alert.alert(
          'Empty transcript',
          'Whisper returned no text. Try recording again with clearer audio.'
        );
        return;
      }
      setTranscript(text);
    } catch (e) {
      const msg = e instanceof WhisperError ? e.message : String(e);
      Alert.alert('Transcription failed', msg);
    } finally {
      setTranscribing(false);
    }
  };

  const handleRetakePhoto = () => {
    setPhoto(null);
    setRecording(null);
    setTranscript(null);
  };

  const handleRetakeRecording = () => {
    setRecording(null);
    setTranscript(null);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{ title: mode === 'new' ? 'New session' : 'Session' }}
      />

      {mode === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      )}

      {mode === 'existing' && existingSession && (
        <View style={styles.center}>
          <Text style={styles.placeholderTitle}>Session detail</Text>
          <Text style={styles.placeholderSubtitle}>
            Chat view coming in Step 7
          </Text>
        </View>
      )}

      {mode === 'new' && !photo && (
        <View style={styles.center}>
          <Ionicons name="image-outline" size={64} color="#888" />
          <Text style={styles.title}>Pick a photo to describe</Text>
          <Text style={styles.subtitle}>
            We&apos;ll then ask you to record ~1 minute of English
          </Text>
          <View style={styles.buttonRow}>
            <PickerButton
              label="Random"
              icon="shuffle"
              disabled={picking}
              onPress={() => handlePick('random')}
            />
            <PickerButton
              label="Choose"
              icon="images-outline"
              disabled={picking}
              onPress={() => handlePick('choose')}
            />
          </View>
          {picking && <ActivityIndicator style={styles.spinner} />}
        </View>
      )}

      {mode === 'new' && photo && (
        <View style={styles.previewContainer}>
          <Image
            source={{ uri: photo.photo_uri }}
            style={styles.preview}
            contentFit="cover"
          />

          {!recording ? (
            <RecordingStage
              isRecording={recorder.isRecording}
              durationMs={recorder.durationMs}
              busy={savingRecording}
              onPressIn={handleRecordStart}
              onPressOut={handleRecordStop}
            />
          ) : transcribing ? (
            <TranscribingStage />
          ) : transcript ? (
            <TranscriptStage
              transcript={transcript}
              onRetake={handleRetakeRecording}
            />
          ) : (
            <RecordingDoneStage
              durationMs={recording.durationMs}
              onTranscribe={handleTranscribe}
              onRetake={handleRetakeRecording}
            />
          )}

          {!recorder.isRecording && !transcribing && (
            <Pressable
              onPress={handleRetakePhoto}
              style={styles.retakeButton}
              disabled={savingRecording}
            >
              <Text style={styles.retakeText}>Choose a different photo</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function RecordingStage({
  isRecording,
  durationMs,
  busy,
  onPressIn,
  onPressOut,
}: {
  isRecording: boolean;
  durationMs: number;
  busy: boolean;
  onPressIn: () => void;
  onPressOut: () => void;
}) {
  return (
    <View style={styles.recordContainer}>
      <Text style={styles.timer}>{formatDuration(durationMs)}</Text>
      <Pressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={busy}
        style={({ pressed }) => [
          styles.recordButton,
          (isRecording || pressed) && styles.recordButtonActive,
          busy && styles.buttonDisabled,
        ]}
      >
        <Ionicons
          name={isRecording ? 'stop' : 'mic'}
          size={36}
          color="#fff"
        />
      </Pressable>
      <Text style={styles.recordHint}>
        {busy
          ? 'Saving…'
          : isRecording
            ? 'Release to stop'
            : 'Press and hold to record'}
      </Text>
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
    <View style={styles.recordContainer}>
      <Text style={styles.recordedLabel}>
        Recorded {formatDuration(durationMs)}
      </Text>
      <Pressable
        onPress={onTranscribe}
        style={({ pressed }) => [
          styles.transcribeButton,
          pressed && styles.buttonPressed,
        ]}
      >
        <Ionicons name="sparkles-outline" size={18} color="#fff" />
        <Text style={styles.buttonLabel}>Transcribe</Text>
      </Pressable>
      <Pressable onPress={onRetake} style={styles.retakeButton}>
        <Text style={styles.retakeText}>Re-record</Text>
      </Pressable>
    </View>
  );
}

function TranscribingStage() {
  return (
    <View style={styles.recordContainer}>
      <ActivityIndicator />
      <Text style={styles.recordHint}>Transcribing…</Text>
    </View>
  );
}

function TranscriptStage({
  transcript,
  onRetake,
}: {
  transcript: string;
  onRetake: () => void;
}) {
  return (
    <View style={styles.transcriptContainer}>
      <Text style={styles.transcriptLabel}>Transcript</Text>
      <ScrollView style={styles.transcriptBubble}>
        <Text style={styles.transcriptText}>{transcript}</Text>
      </ScrollView>
      <View
        style={[styles.transcribeButton, styles.buttonDisabled]}
        accessibilityRole="button"
      >
        <Ionicons name="sparkles-outline" size={18} color="#fff" />
        <Text style={styles.buttonLabel}>Analyze (Step 6)</Text>
      </View>
      <Pressable onPress={onRetake} style={styles.retakeButton}>
        <Text style={styles.retakeText}>Re-record</Text>
      </Pressable>
    </View>
  );
}

function PickerButton({
  label,
  icon,
  disabled,
  onPress,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Ionicons name={icon} size={20} color="#fff" />
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
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

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60).toString().padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 16,
  },
  subtitle: {
    fontSize: 14,
    opacity: 0.6,
    marginTop: 8,
    textAlign: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 32,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0a84ff',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    gap: 8,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  spinner: {
    marginTop: 24,
  },
  placeholderTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  placeholderSubtitle: {
    fontSize: 14,
    opacity: 0.6,
    marginTop: 8,
  },
  previewContainer: {
    flex: 1,
    padding: 16,
    alignItems: 'center',
  },
  preview: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 16,
    backgroundColor: '#eee',
  },
  recordContainer: {
    marginTop: 24,
    alignItems: 'center',
    gap: 12,
  },
  timer: {
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
  },
  recordButton: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#0a84ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordButtonActive: {
    backgroundColor: '#ff3b30',
  },
  recordHint: {
    fontSize: 13,
    opacity: 0.6,
  },
  recordedLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  transcribeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0a84ff',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    gap: 8,
  },
  retakeButton: {
    marginTop: 16,
    padding: 8,
  },
  retakeText: {
    color: '#0a84ff',
    fontSize: 14,
  },
  transcriptContainer: {
    marginTop: 24,
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 12,
  },
  transcriptLabel: {
    fontSize: 13,
    fontWeight: '600',
    opacity: 0.7,
    alignSelf: 'flex-start',
  },
  transcriptBubble: {
    alignSelf: 'stretch',
    maxHeight: 180,
    backgroundColor: '#f1f3f5',
    borderRadius: 12,
    padding: 12,
  },
  transcriptText: {
    fontSize: 15,
    lineHeight: 22,
    color: '#222',
  },
});
