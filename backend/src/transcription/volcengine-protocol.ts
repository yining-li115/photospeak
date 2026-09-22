import { gunzipSync, gzipSync } from 'node:zlib';

const PROTOCOL_VERSION = 1;
const HEADER_WORDS = 1;
const MESSAGE_FULL_CLIENT_REQUEST = 0x1;
const MESSAGE_AUDIO_ONLY_REQUEST = 0x2;
const MESSAGE_FULL_SERVER_RESPONSE = 0x9;
const MESSAGE_ERROR = 0xf;
const FLAG_LAST_PACKET = 0x2;
const SERIALIZATION_NONE = 0x0;
const SERIALIZATION_JSON = 0x1;
const COMPRESSION_NONE = 0x0;
const COMPRESSION_GZIP = 0x1;
const MAX_DECOMPRESSED_RESPONSE_BYTES = 512 * 1024;

export interface VolcengineAsrRequest {
  user: { uid: string };
  audio: {
    format: 'pcm';
    codec: 'raw';
    rate: 16000;
    bits: 16;
    channel: 1;
  };
  request: {
    model_name: 'bigmodel';
    enable_nonstream: boolean;
    enable_itn: true;
    enable_punc: true;
    enable_ddc: false;
    show_utterances: true;
    result_type: 'full';
    end_window_size: number;
  };
}

export interface VolcengineAsrResult {
  text: string;
  final: boolean;
}

export type ParsedVolcengineFrame =
  | {
      type: 'response';
      isLast: boolean;
      sequence?: number;
      payload: unknown;
    }
  | {
      type: 'error';
      code: number;
      message: string;
    };

export function encodeVolcengineConfig(
  request: VolcengineAsrRequest
): Buffer {
  return encodePayload(
    MESSAGE_FULL_CLIENT_REQUEST,
    0,
    SERIALIZATION_JSON,
    Buffer.from(JSON.stringify(request), 'utf8')
  );
}

export function encodeVolcengineAudio(
  audio: Buffer,
  isLast: boolean
): Buffer {
  return encodePayload(
    MESSAGE_AUDIO_ONLY_REQUEST,
    isLast ? FLAG_LAST_PACKET : 0,
    SERIALIZATION_NONE,
    audio
  );
}

export function parseVolcengineServerFrame(
  frame: Buffer
): ParsedVolcengineFrame {
  if (frame.byteLength < 4) throw protocolError('frame is shorter than header');

  const version = frame[0]! >> 4;
  const headerWords = frame[0]! & 0x0f;
  const messageType = frame[1]! >> 4;
  const flags = frame[1]! & 0x0f;
  const serialization = frame[2]! >> 4;
  const compression = frame[2]! & 0x0f;
  const headerBytes = headerWords * 4;

  if (version !== PROTOCOL_VERSION) {
    throw protocolError(`unsupported protocol version ${version}`);
  }
  if (headerWords < HEADER_WORDS || frame.byteLength < headerBytes) {
    throw protocolError('invalid header size');
  }

  if (messageType === MESSAGE_ERROR) {
    if (frame.byteLength < headerBytes + 8) {
      throw protocolError('truncated error response');
    }
    const code = frame.readUInt32BE(headerBytes);
    const payloadSize = frame.readUInt32BE(headerBytes + 4);
    const payload = readPayload(
      frame,
      headerBytes + 8,
      payloadSize,
      compression
    );
    return { type: 'error', code, message: errorMessage(payload) };
  }

  if (messageType !== MESSAGE_FULL_SERVER_RESPONSE) {
    throw protocolError(`unexpected server message type ${messageType}`);
  }
  if (serialization !== SERIALIZATION_JSON) {
    throw protocolError('server response is not JSON');
  }

  let offset = headerBytes;
  let sequence: number | undefined;
  if ((flags & 0x1) !== 0) {
    if (frame.byteLength < offset + 4) {
      throw protocolError('truncated response sequence');
    }
    sequence = frame.readInt32BE(offset);
    offset += 4;
  }
  if (frame.byteLength < offset + 4) {
    throw protocolError('truncated response size');
  }
  const payloadSize = frame.readUInt32BE(offset);
  offset += 4;
  const payloadBytes = readPayload(frame, offset, payloadSize, compression);

  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw protocolError('server response contains invalid JSON');
  }
  return {
    type: 'response',
    isLast: (flags & FLAG_LAST_PACKET) !== 0,
    sequence,
    payload,
  };
}

export function extractVolcengineResult(
  payload: unknown
): VolcengineAsrResult | null {
  if (!isRecord(payload) || !isRecord(payload.result)) return null;
  const text = payload.result.text;
  if (typeof text !== 'string') return null;

  const utterances = payload.result.utterances;
  const final =
    Array.isArray(utterances) &&
    utterances.length > 0 &&
    utterances.every(
      (utterance) => isRecord(utterance) && utterance.definite === true
    );
  return { text, final };
}

function encodePayload(
  messageType: number,
  flags: number,
  serialization: number,
  payload: Buffer
): Buffer {
  const compressed = gzipSync(payload);
  const header = Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_WORDS,
    (messageType << 4) | flags,
    (serialization << 4) | COMPRESSION_GZIP,
    0,
  ]);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(compressed.byteLength);
  return Buffer.concat([header, size, compressed]);
}

function readPayload(
  frame: Buffer,
  offset: number,
  payloadSize: number,
  compression: number
): Buffer {
  if (payloadSize > MAX_DECOMPRESSED_RESPONSE_BYTES) {
    throw protocolError('provider payload is too large');
  }
  if (offset + payloadSize !== frame.byteLength) {
    throw protocolError('provider payload length does not match frame');
  }
  const payload = frame.subarray(offset, offset + payloadSize);
  if (compression === COMPRESSION_NONE) return payload;
  if (compression !== COMPRESSION_GZIP) {
    throw protocolError('unsupported provider compression');
  }
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(payload, {
      maxOutputLength: MAX_DECOMPRESSED_RESPONSE_BYTES,
    });
  } catch {
    throw protocolError('invalid compressed provider payload');
  }
  if (decompressed.byteLength > MAX_DECOMPRESSED_RESPONSE_BYTES) {
    throw protocolError('decompressed provider payload is too large');
  }
  return decompressed;
}

function errorMessage(payload: Buffer): string {
  const text = payload.toString('utf8').trim();
  if (!text) return 'provider rejected the transcription request';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      for (const field of ['message', 'error_message', 'error']) {
        if (typeof parsed[field] === 'string') return parsed[field];
      }
    }
  } catch {
    // The documented error payload can also be a plain UTF-8 string.
  }
  return text.slice(0, 300);
}

function protocolError(message: string): Error {
  return new Error(`Volcengine ASR protocol error: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
