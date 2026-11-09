/**
 * Unit tests for the strict JSONL framing codec.
 *
 * Covers the edge cases called out in the module docstring and TECHNICAL.md:
 *   - LF-only splitting (never Node `readline`, which also splits on U+2028/U+2029)
 *   - \r\n tolerance (trailing \r stripped)
 *   - UTF-8 multi-byte sequences straddling chunk boundaries
 *   - Partial-chunk reassembly (a line arriving across multiple `data` events)
 *   - Flushing a trailing unterminated record on `end`
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { attachJsonlReader, serializeLine } from './JsonlCodec';

/** Minimal fake NodeJS.ReadableStream driven manually via emit('data'/'end'). */
function fakeStream(): EventEmitter & NodeJS.ReadableStream {
  return new EventEmitter() as EventEmitter & NodeJS.ReadableStream;
}

describe('attachJsonlReader', () => {
  it('splits records on a single LF', () => {
    const stream = fakeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));

    stream.emit('data', Buffer.from('{"a":1}\n{"b":2}\n'));

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('strips a trailing \\r before \\n (tolerates \\r\\n line endings)', () => {
    const stream = fakeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));

    stream.emit('data', Buffer.from('{"a":1}\r\n{"b":2}\r\n'));

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does NOT split on U+2028/U+2029 embedded inside a JSON string', () => {
    const stream = fakeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));

    const payload = JSON.stringify({ text: 'line1\u2028line2\u2029line3' });
    stream.emit('data', Buffer.from(payload + '\n'));

    expect(lines).toEqual([payload]);
    expect(JSON.parse(lines[0]).text).toBe('line1\u2028line2\u2029line3');
  });

  it('reassembles a record split across multiple data chunks', () => {
    const stream = fakeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));

    const full = '{"hello":"world","n":42}\n';
    stream.emit('data', Buffer.from(full.slice(0, 5)));
    stream.emit('data', Buffer.from(full.slice(5, 15)));
    stream.emit('data', Buffer.from(full.slice(15)));

    expect(lines).toEqual(['{"hello":"world","n":42}']);
  });

  it('reassembles a UTF-8 multi-byte character straddling a chunk boundary', () => {
    const stream = fakeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));

    // "💡" is a 4-byte UTF-8 sequence (surrogate pair in UTF-16).
    const payload = JSON.stringify({ emoji: '💡 idea' }) + '\n';
    const buf = Buffer.from(payload, 'utf8');
    // Split in the middle of the emoji's byte sequence.
    const splitAt = buf.indexOf(Buffer.from('💡', 'utf8')) + 2;
    stream.emit('data', buf.subarray(0, splitAt));
    stream.emit('data', buf.subarray(splitAt));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).emoji).toBe('💡 idea');
  });

  it('flushes a trailing unterminated record on stream end', () => {
    const stream = fakeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));

    stream.emit('data', Buffer.from('{"a":1}\n{"b":2}')); // no trailing \n
    stream.emit('end');

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does not emit an empty trailing record when the stream ends cleanly', () => {
    const stream = fakeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));

    stream.emit('data', Buffer.from('{"a":1}\n'));
    stream.emit('end');

    expect(lines).toEqual(['{"a":1}']);
  });

  it('detaches listeners when the returned cleanup function is called', () => {
    const stream = fakeStream();
    const onLine = vi.fn();
    const detach = attachJsonlReader(stream, onLine);

    detach();
    stream.emit('data', Buffer.from('{"a":1}\n'));

    expect(onLine).not.toHaveBeenCalled();
  });
});

describe('serializeLine', () => {
  it('serializes a value to JSON followed by a single LF', () => {
    expect(serializeLine({ a: 1 })).toBe('{"a":1}\n');
  });

  it('round-trips through attachJsonlReader', () => {
    const stream = fakeStream();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));

    const value = { id: 'abc', nested: { text: 'line1\u2028line2' } };
    stream.emit('data', Buffer.from(serializeLine(value)));

    expect(JSON.parse(lines[0])).toEqual(value);
  });
});
