import { AiProviderError } from './types.js';

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      throw new AiProviderError('timeout', 'AI provider request timed out');
    }
    throw new AiProviderError(
      'unavailable',
      error instanceof Error ? error.message : 'AI provider unavailable'
    );
  }
}

/** Read a response without allowing an upstream server to exhaust our heap. */
export async function readTextBounded(
  response: Response,
  maxBytes: number
): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    throw new AiProviderError('bad_response', 'AI provider response too large');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AiProviderError(
          'bad_response',
          'AI provider response too large'
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      throw new AiProviderError('timeout', 'AI provider response timed out');
    }
    throw new AiProviderError(
      'unavailable',
      error instanceof Error
        ? error.message
        : 'Failed to read AI provider response'
    );
  } finally {
    reader.releaseLock();
  }
}
