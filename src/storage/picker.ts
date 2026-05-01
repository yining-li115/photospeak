import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';

const RANDOM_POOL_SIZE = 500;

export type PickerError =
  | { kind: 'permission_denied' }
  | { kind: 'no_photos' }
  | { kind: 'cancelled' };

export type PickerResult =
  | { ok: true; uri: string }
  | { ok: false; error: PickerError };

export async function pickFromLibrary(): Promise<PickerResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    return { ok: false, error: { kind: 'permission_denied' } };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  });

  if (result.canceled || result.assets.length === 0) {
    return { ok: false, error: { kind: 'cancelled' } };
  }

  return { ok: true, uri: result.assets[0].uri };
}

export async function pickRandomFromLibrary(): Promise<PickerResult> {
  const perm = await MediaLibrary.requestPermissionsAsync();
  if (perm.status !== 'granted') {
    return { ok: false, error: { kind: 'permission_denied' } };
  }

  const page = await MediaLibrary.getAssetsAsync({
    mediaType: MediaLibrary.MediaType.photo,
    first: RANDOM_POOL_SIZE,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  });

  if (page.assets.length === 0) {
    return { ok: false, error: { kind: 'no_photos' } };
  }

  const pick = page.assets[Math.floor(Math.random() * page.assets.length)];
  const info = await MediaLibrary.getAssetInfoAsync(pick);
  return { ok: true, uri: info.localUri ?? pick.uri };
}
