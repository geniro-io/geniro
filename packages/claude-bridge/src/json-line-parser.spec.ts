import { describe, expect, it, vi } from 'vitest';

import { JsonLineParser, serializeFrame } from './json-line-parser';

describe('JsonLineParser', () => {
  it('parses complete frames from a single chunk', () => {
    const parser = new JsonLineParser<{ type: string }>();

    const frames = parser.push('{"type":"a"}\n{"type":"b"}\n');

    expect(frames).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(parser.pending()).toBe('');
  });

  it('reassembles a frame split across chunks', () => {
    const parser = new JsonLineParser<{ type: string; n: number }>();

    expect(parser.push('{"type":"spl')).toEqual([]);
    expect(parser.pending()).toBe('{"type":"spl');
    expect(parser.push('it","n":1}\n{"ty')).toEqual([{ type: 'split', n: 1 }]);
    expect(parser.push('pe":"next","n":2}\n')).toEqual([
      { type: 'next', n: 2 },
    ]);
  });

  it('reassembles a frame intact when a chunk boundary splits a multi-byte UTF-8 character', () => {
    // Stream chunking is byte-oriented: the runtime exec stream can hand the
    // parser a Buffer that ends mid-way through a multi-byte character (any
    // non-ASCII assistant text). Decoding each chunk independently must not
    // corrupt the code point into U+FFFD replacement characters.
    const parser = new JsonLineParser<{ text: string }>();
    const onInvalid = vi.fn();

    const frame = Buffer.from('{"text":"résultat"}\n', 'utf8');
    const splitAt = frame.indexOf(0xc3) + 1; // one byte INTO the 2-byte "é"

    expect(parser.push(frame.subarray(0, splitAt), onInvalid)).toEqual([]);
    const frames = parser.push(frame.subarray(splitAt), onInvalid);

    expect(onInvalid).not.toHaveBeenCalled();
    expect(frames).toEqual([{ text: 'résultat' }]);
  });

  it('handles a chunk containing many frames and a trailing partial', () => {
    const parser = new JsonLineParser<{ i: number }>();

    const frames = parser.push('{"i":1}\n{"i":2}\n{"i":3}\n{"i":4');

    expect(frames).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    expect(parser.pending()).toBe('{"i":4');
  });

  it('skips empty lines', () => {
    const parser = new JsonLineParser<{ i: number }>();

    expect(parser.push('\n\n{"i":1}\n\n')).toEqual([{ i: 1 }]);
  });

  it('reports invalid lines without throwing and keeps pumping', () => {
    const parser = new JsonLineParser<{ i: number }>();
    const onInvalid = vi.fn();

    const frames = parser.push('not-json\n{"i":1}\n', onInvalid);

    expect(frames).toEqual([{ i: 1 }]);
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(onInvalid.mock.calls[0]![0]).toBe('not-json');
    expect(onInvalid.mock.calls[0]![1]).toBeInstanceOf(Error);
  });

  it('accepts Buffer chunks', () => {
    const parser = new JsonLineParser<{ ok: boolean }>();

    expect(parser.push(Buffer.from('{"ok":true}\n'))).toEqual([{ ok: true }]);
  });
});

describe('serializeFrame', () => {
  it('emits one newline-terminated JSON line', () => {
    expect(serializeFrame({ type: 'ready' })).toBe('{"type":"ready"}\n');
  });
});
