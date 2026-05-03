import type { Track } from '../context/player';
import type { Session } from '../types';

export function tracksFromSession(session: Session): Track[] {
  const tracks: Track[] = [];
  for (let i = 0; i < session.polished_sentences.length; i++) {
    const audioUri = session.sentence_audio_uris[i];
    if (!audioUri) continue;
    tracks.push({
      sessionId: session.id,
      sentenceIndex: i,
      audioUri,
      sentenceText: session.polished_sentences[i],
      photoUri: session.photo_uri,
      photoThumbnailUri: session.photo_thumbnail_uri,
      sessionDate: session.created_at,
    });
  }
  return tracks;
}

export function tracksFromSessions(sessions: Session[]): Track[] {
  return sessions.flatMap(tracksFromSession);
}
