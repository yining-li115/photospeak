import { File } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image as NativeImage } from 'react-native';
import {
  assertAccountOperationScope,
  type AccountOperationScope,
} from '../services/account-operation';
import { ensureAppStorageCapacityForWrite } from './quota';
import { ensureOwnerDirectoryFor, ownerDirectoryFor } from './owner-path';
import { assertSafeStorageKey } from './safety';

const PHOTOS_SUBDIR = 'photos';
const THUMBS_SUBDIR = 'thumbnails';
const MAX_PHOTO_WIDTH = 1600;
const MAX_ANALYSIS_PHOTO_BYTES = 1_800_000;
const THUMBNAIL_WIDTH = 240;
const PHOTO_QUALITY = 0.82;
const THUMBNAIL_QUALITY = 0.7;
let lastPhotoVersion = 0;

export interface SavedPhoto {
  photo_uri: string;
  photo_thumbnail_uri: string;
  /** Cache-bust token for image components. */
  version: number;
}

/**
 * Normalize every picked asset to a bounded JPEG. The beta copied HEIC/PNG
 * bytes into a .jpg path without resizing, which both mislabeled the content
 * and allowed a handful of photos to consume hundreds of megabytes.
 */
export async function savePhoto(
  sourceUri: string,
  sessionId: string,
  scope: AccountOperationScope
): Promise<SavedPhoto> {
  assertAccountOperationScope(scope);
  assertSafeStorageKey(sessionId, 'session identifier');
  const photosDir = ensureOwnerDirectoryFor(scope.owner, PHOTOS_SUBDIR);
  const thumbsDir = ensureOwnerDirectoryFor(scope.owner, THUMBS_SUBDIR);
  const version = nextPhotoVersion();
  const filename = `${sessionId}-${version}.jpg`;

  const resizeActions: ImageManipulator.Action[] = [];
  try {
    const size = await NativeImage.getSize(sourceUri);
    if (size.width > MAX_PHOTO_WIDTH) {
      resizeActions.push({ resize: { width: MAX_PHOTO_WIDTH } });
    }
  } catch {
    // The manipulator can still decode sources (notably some ph:// assets)
    // that React Native cannot probe. Compression still normalizes the file.
  }

  let fullResult = await ImageManipulator.manipulateAsync(
    sourceUri,
    resizeActions,
    { compress: PHOTO_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
  );
  assertAccountOperationScope(scope);

  // Highly detailed/noisy images can still be large after a width cap. Keep
  // the eventual base64 body comfortably below the API's 3 MB data-URL limit.
  for (const fallback of [
    { width: 1024, quality: 0.68 },
    { width: 768, quality: 0.55 },
  ]) {
    if (new File(fullResult.uri).size <= MAX_ANALYSIS_PHOTO_BYTES) break;
    const previous = fullResult;
    fullResult = await ImageManipulator.manipulateAsync(
      previous.uri,
      [{ resize: { width: fallback.width } }],
      {
        compress: fallback.quality,
        format: ImageManipulator.SaveFormat.JPEG,
      }
    );
    assertAccountOperationScope(scope);
    if (previous.uri !== fullResult.uri) deleteIfExists(new File(previous.uri));
  }

  let thumbResult: ImageManipulator.ImageResult | null = null;
  const fullDest = new File(photosDir, filename);
  const thumbDest = new File(thumbsDir, filename);
  try {
    const normalizedPhoto = new File(fullResult.uri);
    if (normalizedPhoto.size > MAX_ANALYSIS_PHOTO_BYTES) {
      throw new Error(
        '这张照片压缩后仍然过大，请裁剪照片或选择另一张照片'
      );
    }
    thumbResult = await ImageManipulator.manipulateAsync(
      fullResult.uri,
      [{ resize: { width: THUMBNAIL_WIDTH } }],
      {
        compress: THUMBNAIL_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      }
    );
    assertAccountOperationScope(scope);

    const thumbnail = new File(thumbResult.uri);
    ensureAppStorageCapacityForWrite(
      normalizedPhoto.size + thumbnail.size
    );
    assertAccountOperationScope(scope);

    normalizedPhoto.move(fullDest);
    thumbnail.move(thumbDest);
    deletePhotoFilesForOwner(scope.owner, sessionId, filename);
  } catch (error) {
    deleteIfExists(new File(fullResult.uri));
    if (thumbResult) deleteIfExists(new File(thumbResult.uri));
    deleteIfExists(fullDest);
    deleteIfExists(thumbDest);
    throw error;
  }

  return {
    photo_uri: fullDest.uri,
    photo_thumbnail_uri: thumbDest.uri,
    version,
  };
}

/** Delete legacy and versioned photo files for one validated session id. */
export function deletePhotoFiles(
  sessionId: string,
  scope: AccountOperationScope,
  keepFilename?: string
): void {
  assertAccountOperationScope(scope);
  deletePhotoFilesForOwner(scope.owner, sessionId, keepFilename);
}

function deletePhotoFilesForOwner(
  owner: string,
  sessionId: string,
  keepFilename?: string
): void {
  assertSafeStorageKey(sessionId, 'session identifier');
  for (const subdir of [PHOTOS_SUBDIR, THUMBS_SUBDIR]) {
    const dir = ownerDirectoryFor(owner, subdir);
    if (!dir.exists) continue;
    for (const entry of dir.list()) {
      if (!(entry instanceof File) || entry.name === keepFilename) continue;
      const isLegacy = entry.name === `${sessionId}.jpg`;
      const suffix = entry.name.slice(sessionId.length + 1);
      const isVersioned =
        entry.name.startsWith(`${sessionId}-`) && /^\d+\.jpg$/.test(suffix);
      if (isLegacy || isVersioned) deleteIfExists(entry);
    }
  }
}

function deleteIfExists(file: File): void {
  if (file.exists) file.delete();
}

function nextPhotoVersion(): number {
  lastPhotoVersion = Math.max(Date.now(), lastPhotoVersion + 1);
  return lastPhotoVersion;
}
