/**
 * Issue #253, Checkbox 3: Abschnitt „Eigene Stimme" (src/web/public/voice-clone.js)
 * ohne Browser, mit Attrappen für Mikrofon, MediaRecorder, AudioContext,
 * fetch und Uhr. Ohne Häkchen kein getUserMedia-Aufruf; das Mikrofon wird
 * nach Stopp, Verwerfen, Entfernen des Häkchens und Verlassen frei; die
 * Aufnahme geht als WAV mit consent=ja nur an POST /api/speech/voices.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "..", "src", "web", "public", "voice-clone.js"), "utf8");

interface El {
  tag: string;
  props: Record<string, any>;
  children: El[];
  listeners: Record<string, (e?: any) => void>;
  checked?: boolean;
  value?: string;
  addEventListener(type: string, fn: (e?: any) => void): void;
  appendChild(child: El): El;
  append(...c: El[]): void;
  play?: () => Promise<void>;
}

function h(tag: string, props: Record<string, any> = {}, children: (El | null)[] = []): El {
  return {
    tag,
    props,
    children: children.filter(Boolean) as El[],
    listeners: {},
    value: props.value,
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...c) {
      this.children.push(...c);
    },
    play: async () => {},
  };
}
const sectionNode = (id: string, title: string, hints: string[], children: (El | null)[]) =>
  h("section", { id, title }, [...hints.map(text => h("p", { className: "actions-hint", text })), ...children]);
const all = (nodes: El[]): El[] => nodes.flatMap(n => [n, ...all(n.children)]);
const byKey = (nodes: El[], key: string) => all(nodes).find(n => n.props["data-focus-key"] === key);
const text = (nodes: El[]) => all(nodes).map(n => n.props.text ?? "").filter(Boolean).join("\n");

const TEXTS = { consent: "Das ist meine eigene Stimme, oder die Person hat mir ausdrücklich erlaubt, ihre Stimme zu klonen.", reading: "Heute ist ein ruhiger Morgen.", probe: "Hallo", minSeconds: 5, maxSeconds: 30 };

function harness(o: { engine?: boolean; voices?: any[]; inUse?: boolean; mic?: "grant" | "deny"; secure?: boolean; slowDecode?: boolean } = {}) {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const setTimeout = (fn: () => void, ms = 0) => {
    timers.set(++seq, { at: now + ms, fn });
    return seq;
  };
  const setInterval = (fn: () => void, ms: number) => {
    timers.set(++seq, { at: now + ms, fn, every: ms });
    return seq;
  };
  const clear = (id: number) => void timers.delete(id);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r));
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every?: number }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      now = next[1].at;
      if (next[1].every) next[1].at = now + next[1].every;
      else timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  }
  const FakeDate = { now: () => now } as unknown as DateConstructor;
  const RealDate = Date;
  const DateProxy = new Proxy(RealDate, { get: (t, p) => (p === "now" ? () => now : (t as any)[p]) });

  const streams: { stopped: number; getTracks(): { stop(): void }[] }[] = [];
  const gum: any[] = [];
  const getUserMedia = async (c: any) => {
    gum.push(c);
    if (o.mic === "deny") throw Object.assign(new Error("nein"), { name: "NotAllowedError" });
    const s = { stopped: 0, getTracks: () => [{ stop: () => void s.stopped++ }] };
    streams.push(s);
    return s;
  };
  const recorders: any[] = [];
  class FakeRecorder {
    state = "inactive";
    mimeType: string;
    ondataavailable: ((e: any) => void) | null = null;
    onstop: (() => void) | null = null;
    static isTypeSupported = () => true;
    constructor(_s: unknown, opts: { mimeType?: string } = {}) {
      this.mimeType = opts.mimeType ?? "audio/webm";
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
      this.onstop?.();
    }
  }
  // Verzögerte Dekodierung: erst finishDecode() lässt decodeAudioData weiterlaufen
  const decodeWaits: (() => void)[] = [];
  const finishDecode = () => {
    for (const r of decodeWaits.splice(0)) r();
  };
  class FakeAudioContext {
    async decodeAudioData() {
      if (o.slowDecode) await new Promise<void>(r => decodeWaits.push(r));
      const rate = 48_000;
      const ch = new Float32Array(rate * 6).fill(0.25);
      return { sampleRate: rate, numberOfChannels: 2, getChannelData: () => ch };
    }
    async close() {}
  }
  const urls: string[] = [];
  const revoked: string[] = [];
  const fetches: { path: string; init: any }[] = [];
  const responses: Response[] = [];
  const win: any = {
    isSecureContext: o.secure ?? true,
    navigator: { mediaDevices: { getUserMedia } },
    MediaRecorder: FakeRecorder,
    AudioContext: FakeAudioContext,
    Blob,
    URL: { createObjectURL: () => `blob:${urls.push("x")}`, revokeObjectURL: (u: string) => void revoked.push(u) },
    fetch: async (path: string, init: any) => {
      fetches.push({ path, init });
      return responses.shift() ?? new Response(JSON.stringify({ voice: { id: "0123456789abcdef" } }), { status: 201 });
    },
  };
  const voices = o.voices ?? [];
  const apiCalls: [string, string, unknown][] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    apiCalls.push([method, path, body]);
    if (path === "/api/speech/voices") {
      return { ok: true, status: 200, data: { voices, engine: o.engine === false ? { ready: false, reason: "Keine Klon-Engine eingerichtet." } : { ready: true, id: "pocket", label: "Pocket TTS mit Stimmenklonen (Kyutai)" }, inUse: !!o.inUse, texts: TEXTS } };
    }
    return { ok: true, status: 200, data: { ok: true } };
  };
  const mod = new Function("setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", SOURCE + "\nreturn { createVoiceCloneSettings, voiceCloneWav, voiceCloneResample, voiceCloneMono, VOICE_CLONE_UI_TEXT };")(setTimeout, clear, setInterval, clear, DateProxy);
  let changed = 0;
  const ui = mod.createVoiceCloneSettings({ api, win, render: () => {}, h, sectionNode, changed: () => void changed++ });
  void FakeDate;
  return { mod, ui, gum, streams, recorders, fetches, responses, apiCalls, advance, flush, revoked, finishDecode, decoding: () => decodeWaits.length, changed: () => changed, nodes: () => ui.nodes() as El[] };
}

async function ready(o: Parameters<typeof harness>[0] = {}) {
  const t = harness(o);
  t.ui.open();
  await t.flush();
  return t;
}

function check(t: ReturnType<typeof harness>, on = true) {
  const box = byKey(t.nodes(), "voice-clone:consent")!;
  box.checked = on;
  box.listeners.change!();
}

describe("WAV im Browser", () => {
  test("PCM 16 Bit, mono, 24 kHz, Kopf und Daten; Werte begrenzt", () => {
    const { mod } = harness();
    const wav: Uint8Array = mod.voiceCloneWav(new Float32Array([0, 0.5, -1, 2]), 24_000);
    const b = Buffer.from(wav);
    expect(b.toString("latin1", 0, 4)).toBe("RIFF");
    expect(b.toString("latin1", 8, 16)).toBe("WAVEfmt ");
    expect(b.readUInt16LE(20)).toBe(1);
    expect(b.readUInt16LE(22)).toBe(1);
    expect(b.readUInt32LE(24)).toBe(24_000);
    expect(b.readUInt16LE(34)).toBe(16);
    expect(b.readUInt32LE(40)).toBe(8);
    expect([b.readInt16LE(44), b.readInt16LE(46), b.readInt16LE(48), b.readInt16LE(50)]).toEqual([0, 16383, -32768, 32767]);
  });

  test("mischt zu mono und rechnet um", () => {
    const { mod } = harness();
    expect(Array.from(mod.voiceCloneMono([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
    expect(mod.voiceCloneResample(new Float32Array(48_000), 48_000, 24_000).length).toBe(24_000);
  });
});

describe("Einwilligung vor dem Mikrofon", () => {
  test("ohne Häkchen: kein Aufnahmeknopf, kein Namensfeld, kein getUserMedia", async () => {
    const t = await ready();
    expect(byKey(t.nodes(), "voice-clone:consent")).toBeDefined();
    expect(text(t.nodes())).toContain(TEXTS.consent);
    expect(byKey(t.nodes(), "voice-clone:start")).toBeUndefined();
    expect(byKey(t.nodes(), "voice-clone:name")).toBeUndefined();
    expect(t.gum).toEqual([]);
  });

  test("kein Dateidialog, kein Ziehen: es gibt kein Datei-Feld und keinen drop-Empfänger", async () => {
    const t = await ready();
    check(t);
    const nodes = all(t.nodes());
    expect(nodes.filter(n => n.tag === "input" && n.props.type === "file")).toEqual([]);
    expect(nodes.filter(n => n.listeners.drop || n.listeners.dragover)).toEqual([]);
    expect(SOURCE).not.toMatch(/type:\s*"file"|ondrop|"drop"|dataTransfer|showOpenFilePicker/);
  });

  test("mit Häkchen: Aufnahme öffnet das Mikrofon genau einmal", async () => {
    const t = await ready();
    check(t);
    byKey(t.nodes(), "voice-clone:start")!.listeners.click!();
    await t.flush();
    expect(t.gum).toHaveLength(1);
    expect(t.recorders[0].state).toBe("recording");
    expect(byKey(t.nodes(), "voice-clone:stop")).toBeDefined();
  });

  test("Häkchen während der Aufnahme entfernt: Aufnahme verworfen, Mikrofon frei", async () => {
    const t = await ready();
    check(t);
    byKey(t.nodes(), "voice-clone:start")!.listeners.click!();
    await t.flush();
    check(t, false);
    expect(t.streams[0]!.stopped).toBeGreaterThanOrEqual(1);
    expect(t.ui.isBusy()).toBe(false);
    expect(byKey(t.nodes(), "voice-clone:stop")).toBeUndefined();
  });

  test("Mikrofon verweigert: Hinweis, keine Aufnahme", async () => {
    const t = await ready({ mic: "deny" });
    check(t);
    byKey(t.nodes(), "voice-clone:start")!.listeners.click!();
    await t.flush();
    expect(text(t.nodes())).toContain("nicht freigegeben");
    expect(t.ui.isBusy()).toBe(false);
  });

  test("ohne sicheren Kontext: Hinweis statt Aufnahmeknopf", async () => {
    const t = await ready({ secure: false });
    check(t);
    expect(byKey(t.nodes(), "voice-clone:start")).toBeUndefined();
    expect(text(t.nodes())).toContain("kein Mikrofon");
  });
});

describe("Aufnahme, Anhören, Speichern", () => {
  async function recorded(seconds: number, o: Parameters<typeof harness>[0] = {}) {
    const t = await ready(o);
    check(t);
    const name = byKey(t.nodes(), "voice-clone:name")!;
    name.value = "Alex";
    name.listeners.input!();
    byKey(t.nodes(), "voice-clone:start")!.listeners.click!();
    await t.flush();
    await t.advance(seconds * 1000);
    byKey(t.nodes(), "voice-clone:stop")?.listeners.click!();
    await t.flush();
    return t;
  }

  test("Stopp gibt das Mikrofon frei, danach Anhören, Speichern, Wiederholen", async () => {
    const t = await recorded(12);
    expect(t.streams[0]!.stopped).toBeGreaterThanOrEqual(1);
    expect(all(t.nodes()).some(n => n.tag === "audio")).toBe(true);
    expect(byKey(t.nodes(), "voice-clone:save")!.props.disabled).toBe(false);
    expect(byKey(t.nodes(), "voice-clone:again")).toBeDefined();
  });

  test("Speichern schickt WAV mit consent=ja an POST /api/speech/voices", async () => {
    const t = await recorded(12);
    byKey(t.nodes(), "voice-clone:save")!.listeners.click!();
    await t.flush();
    expect(t.fetches).toHaveLength(1);
    const f = t.fetches[0]!;
    expect(f.path).toBe("/api/speech/voices?name=Alex&consent=ja");
    expect(f.init.method).toBe("POST");
    expect(f.init.headers["Content-Type"]).toBe("audio/wav");
    const wav = Buffer.from(f.init.body as Uint8Array);
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(6 * 24_000 * 2);
    expect(text(t.nodes())).toContain("Gespeichert.");
    expect(t.ui.isBusy()).toBe(false);
  });

  test("Häkchen während der Umrechnung entfernt: keine Speicheranfrage", async () => {
    const t = await recorded(12, { slowDecode: true });
    byKey(t.nodes(), "voice-clone:save")!.listeners.click!();
    await t.flush();
    expect(t.decoding()).toBe(1);
    check(t, false);
    t.finishDecode();
    await t.flush();
    expect(t.fetches).toEqual([]);
    expect(t.ui.isBusy()).toBe(false);
  });

  test("Reiter während der Umrechnung verlassen: keine Speicheranfrage", async () => {
    const t = await recorded(12, { slowDecode: true });
    byKey(t.nodes(), "voice-clone:save")!.listeners.click!();
    await t.flush();
    expect(t.decoding()).toBe(1);
    t.ui.close();
    t.finishDecode();
    await t.flush();
    expect(t.fetches).toEqual([]);
    expect(t.ui.isBusy()).toBe(false);
  });

  test("Häkchen entfernt und wieder gesetzt: die alte Aufnahme geht trotzdem nicht hoch", async () => {
    const t = await recorded(12, { slowDecode: true });
    byKey(t.nodes(), "voice-clone:save")!.listeners.click!();
    await t.flush();
    check(t, false);
    check(t, true);
    t.finishDecode();
    await t.flush();
    expect(t.fetches).toEqual([]);
  });

  test("unter 5 Sekunden: Speichern gesperrt mit Hinweis", async () => {
    const t = await recorded(3);
    expect(byKey(t.nodes(), "voice-clone:save")!.props.disabled).toBe(true);
    expect(text(t.nodes())).toContain("mindestens 5 Sekunden");
  });

  test("nach 30 Sekunden stoppt die Aufnahme selbst", async () => {
    const t = await ready();
    check(t);
    byKey(t.nodes(), "voice-clone:start")!.listeners.click!();
    await t.flush();
    await t.advance(31_000);
    expect(t.recorders[0].state).toBe("inactive");
    expect(t.streams[0]!.stopped).toBeGreaterThanOrEqual(1);
    expect(text(t.nodes())).toContain("Längste Aufnahme erreicht");
  });

  test("ohne Namen: Hinweis, nichts gesendet", async () => {
    const t = await recorded(8);
    const name = byKey(t.nodes(), "voice-clone:name")!;
    name.value = "  ";
    name.listeners.input!();
    byKey(t.nodes(), "voice-clone:save")!.listeners.click!();
    await t.flush();
    expect(t.fetches).toEqual([]);
    expect(text(t.nodes())).toContain("Bitte einen Namen");
  });

  test("Fehler des Servers erscheint, die Aufnahme bleibt zum erneuten Versuch", async () => {
    const t = await recorded(8);
    t.responses.push(new Response(JSON.stringify({ error: "Ohne Einwilligung wird nichts gespeichert", reason: "einwilligung" }), { status: 400 }));
    byKey(t.nodes(), "voice-clone:save")!.listeners.click!();
    await t.flush();
    expect(text(t.nodes())).toContain("Ohne Einwilligung wird nichts gespeichert");
    expect(byKey(t.nodes(), "voice-clone:save")).toBeDefined();
  });

  test("Verlassen (close) gibt das Mikrofon frei", async () => {
    const t = await ready();
    check(t);
    byKey(t.nodes(), "voice-clone:start")!.listeners.click!();
    await t.flush();
    t.ui.close();
    expect(t.streams[0]!.stopped).toBeGreaterThanOrEqual(1);
    expect(t.recorders[0].state).toBe("inactive");
    expect(t.ui.isBusy()).toBe(false);
  });
});

describe("Liste der Stimmen", () => {
  const voice = { id: "0123456789abcdef", name: "Alex", label: "Alex (KI-Stimme)", createdAt: "2026-10-01T10:00:00Z", seconds: 14.2, active: false };

  test("Name mit „(KI-Stimme)\", Probe und Verwenden mit Engine", async () => {
    const t = await ready({ voices: [voice] });
    expect(text(t.nodes())).toContain("Alex (KI-Stimme)");
    expect(byKey(t.nodes(), `voice-clone:probe:${voice.id}`)!.props.disabled).toBe(false);
    byKey(t.nodes(), `voice-clone:use:${voice.id}`)!.listeners.click!();
    await t.flush();
    expect(t.apiCalls).toContainEqual(["POST", `/api/speech/voices/${voice.id}/use`, {}]);
    expect(t.changed()).toBe(1);
  });

  test("ohne Engine: Probe und Verwenden gesperrt, Hinweis zur Einrichtung", async () => {
    const t = await ready({ voices: [voice], engine: false });
    expect(byKey(t.nodes(), `voice-clone:probe:${voice.id}`)!.props.disabled).toBe(true);
    expect(byKey(t.nodes(), `voice-clone:use:${voice.id}`)!.props.disabled).toBe(true);
    expect(text(t.nodes())).toContain("Keine Klon-Engine eingerichtet");
  });

  test("Löschen fragt erst nach, dann DELETE", async () => {
    const t = await ready({ voices: [voice] });
    byKey(t.nodes(), `voice-clone:remove:${voice.id}`)!.listeners.click!();
    expect(text(t.nodes())).toContain("Aufnahme, Text und Einwilligung werden entfernt");
    byKey(t.nodes(), `voice-clone:remove-yes:${voice.id}`)!.listeners.click!();
    await t.flush();
    expect(t.apiCalls).toContainEqual(["DELETE", `/api/speech/voices/${voice.id}`, undefined]);
  });

  test("Probe holt WAV über POST und zeigt einen Abspieler", async () => {
    const t = await ready({ voices: [voice] });
    t.responses.push(new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { "content-type": "audio/wav" } }));
    byKey(t.nodes(), `voice-clone:probe:${voice.id}`)!.listeners.click!();
    await t.flush();
    expect(t.fetches[0]!.path).toBe(`/api/speech/voices/${voice.id}/probe`);
    expect(all(t.nodes()).some(n => n.tag === "audio")).toBe(true);
  });

  test("gewählt und im Einsatz: Hinweis, Verwenden gesperrt", async () => {
    const t = await ready({ voices: [{ ...voice, active: true }], inUse: true });
    expect(text(t.nodes())).toContain("Liest im Sprechmodus vor");
    expect(byKey(t.nodes(), `voice-clone:use:${voice.id}`)!.props.disabled).toBe(true);
  });
});
