/**
 * Live-Ereignisse eines Gesprächs für tybo (Issue #60): hält die
 * SSE-Verbindung offen und verbindet nach Abbruch selbst neu (1 s, dann
 * doppelt so lange bis 15 s). Kommt länger als idleTimeoutMs nichts, auch
 * kein Keepalive (Server alle 20 s), gilt die Verbindung als tot.
 *
 * Der Server kennt keine Ereignis-IDs zum Nachholen. onConnected meldet
 * deshalb jede neue Verbindung, damit der Aufrufer den Verlauf abgleicht.
 */

import { ApiError, type ApiClient } from "./api";
import { SseParser } from "./sse";

export interface LiveEvent {
  event: string;
  data: unknown;
}

export interface LiveHandlers {
  /** Jede (Wieder-)Verbindung, vor ihrem ersten Ereignis */
  onConnected(reconnect: boolean): void;
  onEvent(event: LiveEvent): void;
  /** Verbindung weg, nächster Versuch in retryMs */
  onDisconnected(retryMs: number): void;
  /** Gespräch gelöscht oder nicht mehr vorhanden; keine weiteren Versuche */
  onGone(): void;
}

export interface LiveOptions {
  retryMinMs?: number;
  retryMaxMs?: number;
  idleTimeoutMs?: number;
}

export class LiveConnection {
  private closed = false;
  private controller: AbortController | null = null;
  private wake: (() => void) | null = null;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly idleTimeoutMs: number;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly client: ApiClient,
    private readonly conversationId: string,
    private readonly handlers: LiveHandlers,
    options: LiveOptions = {}
  ) {
    this.retryMinMs = options.retryMinMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 15_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  }

  start(): void {
    if (!this.loop) this.loop = this.run();
  }

  /** Beendet die Verbindung; wartet, bis die Schleife fertig ist */
  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    let delay = this.retryMinMs;
    let reconnect = false;
    while (!this.closed) {
      const controller = new AbortController();
      this.controller = controller;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), this.idleTimeoutMs);
      };
      try {
        const res = await this.client.events(this.conversationId, controller.signal);
        const reader = res.body!.getReader();
        const parser = new SseParser();
        let first = true;
        armIdle();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.closed) break;
          armIdle();
          for (const raw of parser.push(value)) {
            let data: unknown = null;
            try {
              data = raw.data ? JSON.parse(raw.data) : null;
            } catch {
              continue;
            }
            if (first) {
              first = false;
              delay = this.retryMinMs;
              this.handlers.onConnected(reconnect);
            }
            if (raw.event === "deleted") {
              this.closed = true;
              this.handlers.onGone();
              break;
            }
            this.handlers.onEvent({ event: raw.event, data });
          }
          if (this.closed) break;
        }
        await reader.cancel().catch(() => {});
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          this.closed = true;
          this.handlers.onGone();
        }
      } finally {
        clearTimeout(idle);
      }
      if (this.closed) break;
      reconnect = true;
      this.handlers.onDisconnected(delay);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
      delay = Math.min(delay * 2, this.retryMaxMs);
    }
  }
}
