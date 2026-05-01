import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';

const PHOTOS_SUBDIR = 'photos';
const THUMBS_SUBDIR = 'thumbnails';
const THUMBNAIL_SIZE = 200;

export interface SavedPhoto {
  photo_uri: string;
  photo_thumbnail_uri: string;
}

function ensureSubdir(name: string): Directory {
  const dir = new Directory(Paths.document, name);
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

export async function savePhoto(
  sourceUri: string,
  sessionId: string
): Promise<SavedPhoto> {
  const photosDir = ensureSubdir(PHOTOS_SUBDIR);
  const thumbsDir = ensureSubdir(THUMBS_SUBDIR);

  const fullDest = new File(photosDir, `${sessionId}.jpg`);
  if (fullDest.exists) fullDest.delete();
  new File(sourceUri).copy(fullDest);

  const thumbResult = await ImageManipulator.manipulateAsync(
    sourceUri,
    [{ resize: { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE } }],
    { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
  );
  const thumbDest = new File(thumbsDir, `${sessionId}.jpg`);
  if (thumbDest.exists) thumbDest.delete();
  new File(thumbResult.uri).move(thumbDest);

  return {
    photo_uri: fullDest.uri,
    photo_thumbnail_uri: thumbDest.uri,
  };
}

export function deletePhotoFiles(sessionId: string): void {
  const photo = new File(Paths.document, PHOTOS_SUBDIR, `${sessionId}.jpg`);
  const thumb = new File(Paths.document, THUMBS_SUBDIR, `${sessionId}.jpg`);
  if (photo.exists) photo.delete();
  if (thumb.exists) thumb.delete();
}
