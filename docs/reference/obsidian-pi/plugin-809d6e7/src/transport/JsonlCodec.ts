/**
 * Strict JSONL framing codec.
 *
 * Protocol contract:
 *   - Records are delimited by LF (\n) ONLY.
 *   - A trailing \r before the \n is stripped (tolerates \r\n line endings from
 *     non-compliant senders without breaking spec).
 *   - Node `readline` is intentionally NOT used: it also splits on U+2028 and
 *     U+2029, which are valid inside JSON strings and would corrupt those records.
 *   - UTF-8 multi-byte sequences that straddle chunk boundaries are handled
 *     correctly via StringDecoder.
 */

import { StringDecoder } from 'string_decoder';

/**
 * Attach an LF-only JSONL reader to a readable stream.
 *
 * @param stream  Any Node.js Readable (child_process stdout, etc.)
 * @param onLine  Called with each complete JSONL record (already stripped of
 *                the trailing \n and any \r before it).
 * @returns A cleanup function that detaches the listeners.
 */
export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const emitLine = (raw: string): void => {
    onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      emitLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  };

  const onEnd = (): void => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = '';
    }
  };

  stream.on('data', onData);
  stream.on('end', onEnd);

  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };
}

/**
 * Serialise a value to a single strict JSONL record (JSON + LF).
 * The returned string is ready to write directly to stdin.
 */
export function serializeLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}
