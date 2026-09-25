export type SupportedAnalysisImageMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

const SIGNATURE_BYTES = 16;

function decodeBase64Prefix(base64: string): Uint8Array | null {
  if (!base64 || base64.length < 8) return null;
  try {
    const binary = atob(base64.slice(0, 4 * Math.ceil(SIGNATURE_BYTES / 3)));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Infer the encoded file type from its bytes instead of its filename. */
export function detectAnalysisImageMime(
  base64: string
): SupportedAnalysisImageMime | null {
  const bytes = decodeBase64Prefix(base64);
  if (!bytes) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Early beta builds could persist PNG/HEIC bytes under a `.jpg` filename.
 * Build the provider payload from the actual signature so valid legacy PNG or
 * WebP photos are not rejected as malformed JPEGs.
 */
export function analysisImageDataUrl(base64: string): string | null {
  const mime = detectAnalysisImageMime(base64);
  return mime ? `data:${mime};base64,${base64}` : null;
}
