/**
 * Minimal streaming SSE parser.
 *
 * Feeds chunks in, yields complete events. Events are separated by a blank
 * line (\n\n); anything before the final blank line stays in the buffer.
 */

export interface SSEEvent {
  event: string;
  data: string;
}

export class SSEParser {
  private buffer = '';

  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const out: SSEEvent[] = [];

    // Normalize CRLF to LF (ChatGPT uses LF, but defensive)
    const parts = this.buffer.split('\n\n');
    this.buffer = parts.pop() ?? '';

    for (const part of parts) {
      const evt = this.parseBlock(part);
      if (evt) out.push(evt);
    }
    return out;
  }

  /** Emit whatever's left, even if it didn't end with \n\n. */
  flush(): SSEEvent | null {
    if (!this.buffer.trim()) return null;
    const evt = this.parseBlock(this.buffer);
    this.buffer = '';
    return evt;
  }

  private parseBlock(block: string): SSEEvent | null {
    let event = 'message';
    const dataLines: string[] = [];

    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      if (line.startsWith(':')) continue; // SSE comment
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
  }
}
