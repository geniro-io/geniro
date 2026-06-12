import { StringDecoder } from 'node:string_decoder';

/**
 * Cap on the partial-line buffer. A newline-less stream (a hostile in-sandbox
 * writer flooding the bridge's stdout) would otherwise grow one JS string to
 * V8's limit and throw a RangeError synchronously inside the consumer's
 * stream 'data' handler — uncaught in the API process. Real protocol frames
 * are tool results capped at 500K chars; 10M chars leaves generous headroom.
 */
const MAX_PARTIAL_LINE_CHARS = 10_000_000;

/**
 * Incremental newline-delimited JSON parser, safe against frames split across
 * stream chunks. Used on both protocol ends: the host parses bridge stdout,
 * the bridge parses host stdin.
 */
export class JsonLineParser<TFrame = unknown> {
  private buffer = '';
  // Stateful UTF-8 decoding: a chunk boundary can fall inside a multi-byte
  // character; Buffer.toString() per chunk would emit U+FFFD on both halves
  // and silently corrupt otherwise-valid JSON frames.
  private readonly decoder = new StringDecoder('utf8');

  /**
   * Feed a chunk; returns every complete frame it finished. Non-JSON lines
   * are reported through `onInvalidLine` (never thrown) so a stray log line
   * on the stream cannot kill the pump.
   */
  push(
    chunk: string | Buffer,
    onInvalidLine?: (line: string, error: Error) => void,
  ): TFrame[] {
    this.buffer +=
      typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    if (this.buffer.length > MAX_PARTIAL_LINE_CHARS) {
      const discarded = this.buffer;
      this.buffer = '';
      onInvalidLine?.(
        `${discarded.slice(0, 200)}…`,
        new Error(
          `partial line exceeded ${MAX_PARTIAL_LINE_CHARS} chars — discarded`,
        ),
      );
    }

    const frames: TFrame[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      try {
        frames.push(JSON.parse(line) as TFrame);
      } catch (error) {
        onInvalidLine?.(
          line,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return frames;
  }

  /** Remaining partial line (diagnostics for unexpected stream end). */
  pending(): string {
    return this.buffer;
  }
}

export function serializeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}
