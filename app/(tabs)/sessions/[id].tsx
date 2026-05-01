import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getSession } from '../../../src/db/sessions';
import {
  pickFromLibrary,
  pickRandomFromLibrary,
  type PickerError,
  type PickerResult,
} from '../../../src/storage/picker';
import { savePhoto, type SavedPhoto } from '../../../src/storage/photos';
import type { Session } from '../../../src/types';

type Mode = 'loading' | 'new' | 'existing';

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [mode, setMode] = useState<Mode>('loading');
  const [existingSession, setExistingSession] = useState<Session | null>(null);
  const [photo, setPhoto] = useState<SavedPhoto | null>(null);
  const [picking, setPicking] = useState(false);

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

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: mode === 'new' ? 'New session' : 'Session' }} />

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
          <Image source={{ uri: photo.photo_uri }} style={styles.preview} contentFit="cover" />
          <View style={styles.recordPlaceholder}>
            <Ionicons name="mic-outline" size={28} color="#888" />
            <Text style={styles.recordPlaceholderText}>
              Hold to record (Step 4 — coming soon)
            </Text>
          </View>
          <Pressable
            onPress={() => setPhoto(null)}
            style={styles.retakeButton}
            disabled={picking}
          >
            <Text style={styles.retakeText}>Choose a different photo</Text>
          </Pressable>
        </View>
      )}
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
  recordPlaceholder: {
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#bbb',
  },
  recordPlaceholderText: {
    fontSize: 14,
    color: '#666',
  },
  retakeButton: {
    marginTop: 16,
    padding: 8,
  },
  retakeText: {
    color: '#0a84ff',
    fontSize: 14,
  },
});
