/**
 * Parser für Server-Sent Events (Issue #60), wie ihn der ChatHub sendet:
 * benannte Ereignisse (status, progress, notice, message, error, deleted),
 * JSON in data, Keepalive-Kommentare. Verträgt beliebig geteilte
 * Netzwerkblöcke, auch mitten in einem UTF-8-Zeichen, und \r\n.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  /** Nach \r am Blockende: ein \n am Anfang des nächsten Blocks gehört noch dazu */
  private pendingCr = false;

  /** Nimmt einen Block entgegen und gibt die darin vollständigen Ereignisse zurück */
  push(chunk: Uint8Array | string): SseEvent[] {
    let text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.pendingCr = text.endsWith("\r");
    this.buffer += text;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // Ein \r am Ende kann der Anfang von \r\n sein; das \n kommt dann im nächsten Block
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.dataLines.length === 0) {
        this.eventName = "";
        return null;
      }
      const event = { event: this.eventName || "message", data: this.dataLines.join("\n") };
      this.eventName = "";
      this.dataLines = [];
      return event;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
    return null;
  }
}
