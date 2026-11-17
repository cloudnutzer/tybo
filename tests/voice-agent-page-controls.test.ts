/**
 * Issue #495, Aufgabe 2: Erweiterungen der Gesprächsseite (sprachagent.js)
 * ohne Browser, mit SDK-Attrappe und einem Server als Fetch-Attrappe. Stumm
 * (input.setMuted) und Unterbrechen (sendUserActivity) nur verbunden, Wechsel zu
 * einem anderen Sprachagenten legt erst auf und wartet auf den Abschluss, auch
 * mitten in Tokenabruf und SDK-Aufbau, und ein Gespräch je Browser über die
 * Web Locks API. Server, Freigabe und Minuten prüft
 * tests/voice-agent-page-call.test.ts gegen den echten Server.
 *
 * Seit der Prüfung von PR #549: Die Sperre hält, bis ElevenLabs das Ende
 * bestätigt (202 ausstehend), fehlende oder gestörte Web Locks verhindern den
 * Start, Stumm gilt erst, wenn input.setMuted abgeschlossen ist und die
 * Mikrofonspur den Stand zeigt (Fehler, Widerspruch oder ein ausbleibender
 * Abschluss beenden das Gespräch), Unterbrechen erst mit Bestätigung des SDK. Die Attrappen setzen keinen Erfolg voraus; zusätzlich laufen Stumm
 * und Unterbrechen gegen die echte VoiceConversation des eingecheckten SDK.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PUBLIC = resolve(import.meta.dir, "..", "src", "web", "public");
const SOURCE = await readFile(join(PUBLIC, "sprachagent.js"), "utf8");
const page = new Function(
  `${SOURCE}\nreturn { createVoiceAgentCall, createVoiceAgentLock, switchVoiceAgent, voiceAgentButtons, voiceAgentStatusText, VOICE_AGENT_TEXT, VOICE_AGENT_LOCK_NAME, VOICE_AGENT_PENDING_CHECK_MS, VOICE_AGENT_MUTE_TIMEOUT_MS, VOICE_AGENT_INTERRUPT_CONFIRM_MS, VOICE_AGENT_LOCK_TIMEOUT_MS };`
)() as any;
const TEXT = page.VOICE_AGENT_TEXT;
const PENDING_MS: number = page.VOICE_AGENT_PENDING_CHECK_MS;
const MUTE_TIMEOUT_MS: number = page.VOICE_AGENT_MUTE_TIMEOUT_MS;
const INTERRUPT_MS: number = page.VOICE_AGENT_INTERRUPT_CONFIRM_MS;
const READY = { bereit: true };

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ticks(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}

/** Zeitgeber, die nur der Test auslöst */
interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}
function timers() {
  const list: Timer[] = [];
  return {
    list,
    setTimer(fn: () => void, ms: number) {
      const t = { fn, ms, cancelled: false };
      list.push(t);
      return () => void (t.cancelled = true);
    },
    /** Löst alle offenen Zeitgeber mit genau dieser Dauer aus; liefert die Anzahl */
    fire(ms: number): number {
      let n = 0;
      for (const t of list) {
        if (!t.cancelled && t.ms === ms) {
          t.cancelled = true;
          n++;
          t.fn();
        }
      }
      return n;
    },
    open: (ms: number) => list.filter((t) => !t.cancelled && t.ms === ms).length,
  };
}

/** Web Locks wie im Browser, aber für mehrere „Tabs“ in einem Prozess; steal() beendet eine gehaltene Anfrage */
function fakeLocks() {
  const held = new Map<string, (error: Error) => void>();
  return {
    held,
    request(name: string, _options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) {
      if (held.has(name)) return Promise.resolve(callback(null));
      return new Promise((resolve, reject) => {
        held.set(name, reject);
        Promise.resolve(callback({ name })).then(
          (value) => {
            if (held.get(name) === reject) held.delete(name);
            resolve(value);
          },
          (error) => {
            if (held.get(name) === reject) held.delete(name);
            reject(error);
          }
        );
      });
    },
    steal(name: string) {
      const reject = held.get(name);
      held.delete(name);
      reject?.(Object.assign(new Error("Lock broken by another request with the 'steal' option."), { name: "AbortError" }));
    },
  };
}

interface Harness {
  call: any;
  states: any[];
  requests: { url: string; body: string }[];
  sessions: any[];
  timers: ReturnType<typeof timers>;
  /** Hält den nächsten Tokenabruf bzw. startSession an */
  tokenHold: Promise<void> | null;
  connectHold: Promise<void> | null;
  /** Antwort auf /session/end; Standard: bestätigt mit einer Minute */
  endReply: () => Response | Promise<Response>;
  /**
   * Verhalten von input.setMuted: ok (Spur umgeschaltet, dann erfüllt), hold
   * (bleibt offen, bis der Test muteHolds auflöst), reject (abgelehnt), noop
   * (erfüllt, Spur unverändert wie bei getrenntem Raum), sync (wirft)
   */
  muteBehavior: "ok" | "hold" | "reject" | "noop" | "sync";
  muteHolds: { resolve: () => void; reject: () => void }[];
  noMuteApi: boolean;
  /** Wie das SDK: Raum zu, bevor endSession zurückkehrt, ist hier nicht nötig; offen = nicht getrennt */
  openRooms(): number;
}

function harness(options: { lock?: (onLost?: () => void) => Promise<(() => void) | null>; kennung?: string; sdk?: any } = {}): Harness {
  let counter = 0;
  const h: Harness = {
    call: null,
    states: [],
    requests: [],
    sessions: [],
    timers: timers(),
    tokenHold: null,
    connectHold: null,
    endReply: () => Response.json({ ok: true, minuten: 1 }),
    muteBehavior: "ok",
    muteHolds: [],
    noMuteApi: false,
    openRooms: () => h.sessions.filter((s) => s.connection.room.state !== "disconnected").length,
  };
  const sdk = options.sdk ?? {
    Conversation: {
      async startSession(o: any) {
        const hold = h.connectHold;
        h.connectHold = null;
        if (hold) await hold;
        // Mikrofonspur wie bei LiveKit
        const track = { isMuted: false, mediaStreamTrack: { enabled: true, readyState: "live" } };
        const room: any = {
          state: "connected",
          disconnect: async () => void (room.state = "disconnected"),
          localParticipant: { getTrackPublication: (source: string) => (source === "microphone" ? { track } : undefined) },
        };
        const session: any = {
          options: o,
          track,
          muted: [] as boolean[],
          activity: 0,
          ended: 0,
          connection: { room },
          async endSession() {
            session.ended++;
            void room.disconnect();
            o.onDisconnect?.({ reason: "user" });
          },
        };
        if (!h.noMuteApi) {
          // Wie WebRTCConnection: Das Flag steht sofort, die Spur folgt erst mit dem Abschluss
          let flag = false;
          session.input = {
            setMuted(m: boolean): Promise<void> {
              if (h.muteBehavior === "sync") throw new Error("kaputt");
              session.muted.push(m);
              flag = m;
              const apply = () => {
                track.isMuted = m;
                track.mediaStreamTrack.enabled = !m;
              };
              if (h.muteBehavior === "reject") return Promise.reject(new Error("NotReadableError"));
              if (h.muteBehavior === "noop") return Promise.resolve();
              if (h.muteBehavior === "hold") {
                return new Promise<void>((resolve, reject) =>
                  h.muteHolds.push({ resolve: () => (apply(), resolve()), reject: () => reject(new Error("NotReadableError")) })
                );
              }
              apply();
              return Promise.resolve();
            },
            isMuted: () => flag,
          };
          // Wie das SDK: schickt nur user_activity, bestätigt nichts
          session.sendUserActivity = () => void session.activity++;
        }
        h.sessions.push(session);
        o.onModeChange?.({ mode: "listening" });
        return session;
      },
    },
  };
  h.call = page.createVoiceAgentCall({
    kennung: options.kennung ?? "jarvis",
    fetch: async (url: string, init: any) => {
      h.requests.push({ url, body: String(init.body ?? "") });
      if (url.endsWith("/session")) {
        const hold = h.tokenHold;
        h.tokenHold = null;
        if (hold) await hold;
        counter++;
        return Response.json({ conversationToken: `token-${counter}`, conversationId: `conv_${counter}` });
      }
      return h.endReply();
    },
    loadSdk: async () => sdk,
    requestMicrophone: async () => ({ getTracks: () => [] }),
    acquireLock: options.lock,
    setTimer: h.timers.setTimer,
    onChange: (state: any) => h.states.push({ ...state }),
    toLogin: () => {},
  });
  return h;
}

const ends = (h: Harness) => h.requests.filter((r) => r.url.endsWith("/session/end")).map((r) => JSON.parse(r.body).conversationId);
const pending202 = () => Response.json({ ausstehend: true, error: "Aufgelegt. ElevenLabs meldet das Gespräch noch als aktiv.", bis: "2026-11-08T10:30:00Z" }, { status: 202 });
const status = (h: Harness) => page.voiceAgentStatusText(h.call.state, READY);
const buttons = (h: Harness) => page.voiceAgentButtons(h.call.state, READY);

describe("Stumm", () => {
  test("erst „Schalte …“, stumm erst nach abgeschlossenem Umschalten mit stummer Spur; währenddessen kein zweites; neuer Start ist nie stumm", async () => {
    const h = harness();
    expect(h.call.setMuted(true)).toBe(false);
    await h.call.start();
    expect(buttons(h).mute).toBe(TEXT.mute);
    expect(h.call.setMuted(true)).toBe(true);
    expect(h.sessions[0].muted).toEqual([true]);
    // Noch nicht abgeschlossen: Anzeige behauptet nichts, Knopf gesperrt
    expect(h.call.state).toMatchObject({ muted: false, muteTarget: true });
    expect(status(h)).toBe(TEXT.muting);
    expect(buttons(h).muteBusy).toBe(true);
    expect(h.call.setMuted(false)).toBe(false);
    await ticks();
    expect(h.sessions[0].track.isMuted).toBe(true);
    expect(h.call.state).toMatchObject({ muted: true, muteTarget: null });
    expect(h.timers.open(MUTE_TIMEOUT_MS)).toBe(0);
    expect(status(h)).toBe(TEXT.muted);
    expect(buttons(h)).toMatchObject({ mute: TEXT.unmute, muteBusy: false });
    expect(h.call.setMuted(false)).toBe(true);
    expect(status(h)).toBe(TEXT.unmuting);
    await ticks();
    expect(h.sessions[0].muted).toEqual([true, false]);
    expect(h.sessions[0].track.mediaStreamTrack.enabled).toBe(true);
    expect(status(h)).toBe(TEXT.listening);
    h.call.setMuted(true);
    await ticks();
    await h.call.hangUp();
    expect(h.call.setMuted(false)).toBe(false);
    expect(buttons(h).mute).toBeNull();
    await h.call.start();
    expect(h.call.state.muted).toBe(false);
  });

  test("[P1] Umschalten länger als eine Sekunde offen: SDK-Flag schon stumm, Spur nicht, Anzeige bleibt bei „Schalte …“; erst der Abschluss bestätigt", async () => {
    const h = harness();
    await h.call.start();
    h.muteBehavior = "hold";
    expect(h.call.setMuted(true)).toBe(true);
    await ticks();
    // Wie im gevendorten WebRTCConnection: _isMuted steht vor dem asynchronen track.mute()
    expect(h.sessions[0].input.isMuted()).toBe(true);
    expect(h.sessions[0].track.isMuted).toBe(false);
    // Über eine Sekunde hinaus nur die Frist für den Abschluss, sonst nichts
    expect(MUTE_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(h.timers.fire(1_000)).toBe(0);
    expect(h.timers.open(MUTE_TIMEOUT_MS)).toBe(1);
    expect(h.call.state).toMatchObject({ phase: "verbunden", muted: false, muteTarget: true });
    expect(status(h)).toBe(TEXT.muting);
    expect(h.openRooms()).toBe(1);
    h.muteHolds[0].resolve();
    await ticks();
    expect(h.call.state).toMatchObject({ phase: "verbunden", muted: true, muteTarget: null });
    expect(status(h)).toBe(TEXT.muted);
    expect(h.timers.open(MUTE_TIMEOUT_MS)).toBe(0);
    await h.call.hangUp();
  });

  test("[P1] Abschluss bleibt aus: nach der Frist nie „stumm“, Gespräch endet sicher; ein späterer Abschluss ändert nichts", async () => {
    const locks = fakeLocks();
    const h = harness({ lock: page.createVoiceAgentLock(locks) });
    await h.call.start();
    h.muteBehavior = "hold";
    h.call.setMuted(true);
    await ticks();
    expect(h.timers.fire(MUTE_TIMEOUT_MS)).toBe(1);
    await ticks();
    expect(h.states.some((s) => s.muted)).toBe(false);
    expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.muteFailed, muted: false, muteTarget: null });
    expect(h.sessions[0].ended).toBe(1);
    expect(h.openRooms()).toBe(0);
    expect(ends(h)).toEqual(["conv_1"]);
    expect(h.call.busy).toBe(false);
    expect(locks.held.size).toBe(0);
    h.muteHolds[0].resolve();
    await ticks();
    expect(h.call.state).toMatchObject({ phase: "fehler", muted: false });
  });

  test("[P1] Ablehnung erst nach über einer Sekunde: bis dahin nie „stumm“, dann endet das Gespräch", async () => {
    const h = harness();
    await h.call.start();
    h.muteBehavior = "hold";
    h.call.setMuted(true);
    await ticks();
    h.timers.fire(1_000);
    expect(h.call.state).toMatchObject({ phase: "verbunden", muted: false, muteTarget: true });
    h.muteHolds[0].reject();
    await ticks();
    expect(h.states.some((s) => s.muted)).toBe(false);
    expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.muteFailed, muteTarget: null });
    expect(h.openRooms()).toBe(0);
    expect(ends(h)).toEqual(["conv_1"]);
    // Die Frist läuft nicht mehr
    expect(h.timers.open(MUTE_TIMEOUT_MS)).toBe(0);
  });

  for (const when of ["abgelehnt", "synchron", "SDK-Fehler nach dem Abschluss"] as const) {
    test(`Fehler ${when}: Gespräch endet mit Satz, getrennt und gemeldet, Sperre frei`, async () => {
      const locks = fakeLocks();
      const h = harness({ lock: page.createVoiceAgentLock(locks) });
      await h.call.start();
      h.muteBehavior = when === "synchron" ? "sync" : when === "abgelehnt" ? "reject" : "ok";
      h.call.setMuted(true);
      await ticks();
      if (when === "SDK-Fehler nach dem Abschluss") {
        expect(h.call.state.muted).toBe(true);
        // Das SDK meldet später noch einen Fehler beim Umschalten
        h.sessions[0].options.onError("Failed to set input muted state", new Error("NotReadableError"));
        await ticks();
      } else {
        expect(h.states.some((s) => s.muted)).toBe(false);
      }
      expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.muteFailed, retryEnd: false, muteTarget: null });
      expect(status(h)).toBe(TEXT.muteFailed);
      expect(h.sessions[0].ended).toBe(1);
      expect(h.openRooms()).toBe(0);
      expect(ends(h)).toEqual(["conv_1"]);
      expect(h.call.busy).toBe(false);
      expect(locks.held.size).toBe(0);
    });
  }

  for (const why of ["Spur unverändert (Raum nicht verbunden)", "keine Mikrofonspur auffindbar"] as const) {
    test(`ohne Nachweis durch die Spur (${why}): nie „stumm“, Gespräch endet`, async () => {
      const h = harness();
      await h.call.start();
      if (why === "keine Mikrofonspur auffindbar") h.sessions[0].connection.room.localParticipant = undefined;
      else h.muteBehavior = "noop";
      h.call.setMuted(true);
      await ticks();
      expect(h.sessions[0].input.isMuted()).toBe(true);
      expect(h.states.some((s) => s.muted)).toBe(false);
      expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.muteFailed, muted: false });
      expect(ends(h)).toEqual(["conv_1"]);
    });
  }

  test("ohne input.setMuted geschieht nichts", async () => {
    const old = harness();
    old.noMuteApi = true;
    await old.call.start();
    expect(old.call.setMuted(true)).toBe(false);
    expect(old.call.interrupt()).toBe(false);
    expect(old.call.state.phase).toBe("verbunden");
  });
});

describe("Unterbrechen", () => {
  test("nur während der Agent spricht; „Unterbreche …“, bis das SDK onInterruption meldet", async () => {
    const h = harness();
    await h.call.start();
    expect(h.call.interrupt()).toBe(false);
    expect(buttons(h).interrupt).toBeNull();
    h.sessions[0].options.onModeChange({ mode: "speaking" });
    expect(buttons(h).interrupt).toBe(TEXT.interrupt);
    expect(h.call.interrupt()).toBe(true);
    expect(h.sessions[0].activity).toBe(1);
    // sendUserActivity allein belegt nichts: weiter „spricht“, Knopf gesperrt
    expect(h.call.state).toMatchObject({ mode: "spricht", interrupting: true });
    expect(status(h)).toBe(TEXT.interrupting);
    expect(buttons(h)).toMatchObject({ interrupt: TEXT.interrupt, interruptBusy: true });
    expect(h.call.interrupt()).toBe(false);
    expect(h.sessions[0].activity).toBe(1);
    h.sessions[0].options.onInterruption({ event_id: 7 });
    expect(h.call.state).toMatchObject({ mode: "hoert", interrupting: false, hint: "" });
    expect(status(h)).toBe(TEXT.listening);
    expect(buttons(h).interrupt).toBeNull();
    // Die Frist läuft danach ins Leere
    expect(h.timers.fire(INTERRUPT_MS)).toBe(0);
  });

  test("Bestätigung über den Wechsel aufs Zuhören (onModeChange)", async () => {
    const h = harness();
    await h.call.start();
    h.sessions[0].options.onModeChange({ mode: "speaking" });
    h.call.interrupt();
    h.sessions[0].options.onModeChange({ mode: "listening" });
    expect(h.call.state).toMatchObject({ mode: "hoert", interrupting: false });
  });

  test("Bestätigung bleibt aus: nach der Frist weiter „Spricht“ mit Hinweis, Knopf wieder frei; späte Bestätigung schaltet aufs Zuhören", async () => {
    const h = harness();
    await h.call.start();
    h.sessions[0].options.onModeChange({ mode: "speaking" });
    h.call.interrupt();
    expect(h.timers.fire(INTERRUPT_MS)).toBe(1);
    expect(h.call.state).toMatchObject({ mode: "spricht", interrupting: false, hint: TEXT.interruptUnconfirmed });
    expect(status(h)).toBe(`${TEXT.speaking} ${TEXT.interruptUnconfirmed}`);
    expect(buttons(h)).toMatchObject({ interrupt: TEXT.interrupt, interruptBusy: false });
    // Verspätet: ElevenLabs hält doch an
    h.sessions[0].options.onInterruption({ event_id: 9 });
    expect(h.call.state).toMatchObject({ mode: "hoert", hint: "" });
    expect(status(h)).toBe(TEXT.listening);
  });

  test("sendUserActivity wirft: kein Zuhören, Hinweis", async () => {
    const h = harness();
    await h.call.start();
    h.sessions[0].options.onModeChange({ mode: "speaking" });
    h.sessions[0].sendUserActivity = () => {
      throw new Error("kaputt");
    };
    expect(h.call.interrupt()).toBe(false);
    expect(h.call.state).toMatchObject({ mode: "spricht", interrupting: false, hint: TEXT.interruptUnconfirmed });
  });

  test("onInterruption (per Stimme) schaltet die Anzeige aufs Zuhören", async () => {
    const h = harness();
    await h.call.start();
    h.sessions[0].options.onModeChange({ mode: "speaking" });
    h.sessions[0].options.onInterruption({ event_id: 1 });
    expect(h.call.state.mode).toBe("hoert");
    expect(h.sessions[0].activity).toBe(0);
  });

  test("eine verlassene Sitzung schaltet nichts mehr", async () => {
    const h = harness();
    await h.call.start();
    const first = h.sessions[0];
    await h.call.hangUp();
    await h.call.start();
    first.options.onModeChange({ mode: "speaking" });
    first.options.onInterruption({});
    first.options.onError("Failed to set input muted state");
    expect(h.call.state).toMatchObject({ phase: "verbunden", mode: "hoert" });
    expect(h.call.interrupt()).toBe(false);
  });
});

/**
 * Das eingecheckte SDK (lib.iife.js) unverändert geladen, wie in
 * tests/voice-agent-page-call.test.ts: VoiceConversation, WebRTCConnection und
 * Room sind echt, nur Transport und lokale Spur sind Attrappen. Die Seite
 * bekommt das Gespräch genau so, wie startSession des SDK es liefert.
 */
const VENDOR = await readFile(join(PUBLIC, "vendor", "elevenlabs", "lib.iife.js"), "utf8");
const VENDOR_END = "\treturn exports;\n})({});";
const realLib = (() => {
  if (!VENDOR.includes(VENDOR_END)) throw new Error("lib.iife.js: Ende der IIFE nicht gefunden");
  const source = VENDOR.replace(VENDOR_END, "\texports.__Room = Room; exports.__ConnectionState = ConnectionState; exports.__parseFormat = parseFormat;\n" + VENDOR_END);
  return new Function(`${source}\nreturn ElevenLabsClient;`)() as any;
})();

/**
 * Lokale Mikrofonspur wie LocalAudioTrack von LiveKit: mute() schaltet
 * isMuted und mediaStreamTrack.enabled erst um, wenn before() erfüllt ist.
 */
function micTrack(before: () => Promise<void> = async () => {}) {
  const track: any = {
    calls: [] as string[],
    isMuted: false,
    mediaStreamTrack: { enabled: true, readyState: "live" },
    async mute() {
      track.calls.push("mute");
      await before();
      track.isMuted = true;
      track.mediaStreamTrack.enabled = false;
    },
    async unmute() {
      track.calls.push("unmute");
      track.isMuted = false;
      track.mediaStreamTrack.enabled = true;
    },
  };
  return track;
}

function realSdk(track: { mute(): Promise<void>; unmute(): Promise<void> }, setMicrophoneEnabled: (enabled: boolean) => Promise<void>) {
  const made: { conversation: any; room: any; sent: any[] }[] = [];
  const sdk = {
    Conversation: {
      async startSession(options: any) {
        const room = new realLib.__Room();
        room.state = realLib.__ConnectionState.Connected;
        room.engine = {
          client: { isDisconnected: false, sendLeave: async () => {} },
          close: async () => {},
          removeAllListeners() {},
          on() {
            return this;
          },
        };
        room.localParticipant.getTrackPublication = (source: string) => (source === "microphone" ? { track } : undefined);
        room.localParticipant.setMicrophoneEnabled = setMicrophoneEnabled;
        const pcm = realLib.__parseFormat("pcm_48000");
        const connection = new realLib.WebRTCConnection(room, `conv_${made.length + 1}`, pcm, pcm, {});
        connection.isConnected = true;
        const sent: any[] = [];
        connection.sendMessage = (message: any) => void sent.push(message);
        const conversation = new realLib.VoiceConversation(options, connection, connection.input, connection.output, null, async () => {});
        options.onConversationCreated?.(conversation);
        conversation.markConnected();
        made.push({ conversation, room, sent });
        return conversation;
      },
    },
  };
  return { sdk, made };
}

describe("mit der echten VoiceConversation des eingecheckten SDK", () => {
  test("Stumm: erst nach abgeschlossenem track.mute() bestätigt, Spur stumm", async () => {
    const track = micTrack();
    const real = realSdk(track, async () => void track.calls.push("enable"));
    const h = harness({ sdk: real.sdk });
    await h.call.start();
    expect(h.call.state.phase).toBe("verbunden");
    expect(h.call.setMuted(true)).toBe(true);
    expect(h.call.state.muted).toBe(false);
    await ticks();
    expect(track.calls).toEqual(["mute"]);
    expect(track.isMuted).toBe(true);
    expect(real.made[0].conversation.input.isMuted()).toBe(true);
    expect(h.call.state).toMatchObject({ phase: "verbunden", muted: true, muteTarget: null });
    expect(h.call.setMuted(false)).toBe(true);
    await ticks();
    expect(track.calls).toEqual(["mute", "unmute"]);
    expect(h.call.state).toMatchObject({ phase: "verbunden", muted: false, muteTarget: null });
    await h.call.hangUp();
  });

  test("[P1] track.mute() hält länger als eine Sekunde an: SDK-Flag stumm, Spur offen, Anzeige nie „stumm“; ohne Abschluss endet das Gespräch sicher", async () => {
    const hold = gate();
    const track = micTrack(() => hold.promise);
    const real = realSdk(track, async () => {});
    const h = harness({ sdk: real.sdk });
    await h.call.start();
    expect(h.call.setMuted(true)).toBe(true);
    await ticks();
    const { conversation, room } = real.made[0];
    // Die Lücke aus der Prüfung: das SDK meldet stumm, die Spur ist es nicht
    expect(conversation.input.isMuted()).toBe(true);
    expect(track.isMuted).toBe(false);
    expect(track.mediaStreamTrack.enabled).toBe(true);
    h.timers.fire(1_000);
    expect(h.call.state).toMatchObject({ phase: "verbunden", muted: false, muteTarget: true });
    expect(status(h)).toBe(TEXT.muting);
    expect(h.timers.fire(MUTE_TIMEOUT_MS)).toBe(1);
    for (let i = 0; i < 50 && h.call.busy; i++) await tick();
    expect(h.states.some((s) => s.muted)).toBe(false);
    expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.muteFailed, muted: false });
    expect(conversation.status).toBe("disconnected");
    expect(room.state).toBe("disconnected");
    expect(ends(h)).toEqual(["conv_1"]);
    hold.release();
    await ticks();
    expect(h.call.state).toMatchObject({ phase: "fehler", muted: false });
  });

  test("[P1] track.mute() hält an und wird erst später abgelehnt (Ersatz scheitert auch): nie „stumm“, Gespräch beendet und Raum getrennt", async () => {
    let fail!: (error: Error) => void;
    const track = micTrack(() => new Promise<void>((_, reject) => (fail = reject)));
    const real = realSdk(track, () => Promise.reject(new Error("NotReadableError")));
    const h = harness({ sdk: real.sdk });
    await h.call.start();
    expect(h.call.setMuted(true)).toBe(true);
    await ticks();
    h.timers.fire(1_000);
    expect(h.call.state).toMatchObject({ phase: "verbunden", muted: false, muteTarget: true });
    fail(new Error("mute failed"));
    for (let i = 0; i < 50 && h.call.busy; i++) await tick();
    expect(h.states.some((s) => s.phase === "verbunden" && s.muted)).toBe(false);
    expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.muteFailed });
    expect(real.made[0].conversation.status).toBe("disconnected");
    expect(real.made[0].room.state).toBe("disconnected");
    expect(ends(h)).toEqual(["conv_1"]);
  });

  test("Unterbrechen: genau eine user_activity, kein Zuhören ohne Ereignis; das Ereignis interruption des Servers bestätigt", async () => {
    const real = realSdk(micTrack(), async () => {});
    const h = harness({ sdk: real.sdk });
    await h.call.start();
    const { conversation, sent } = real.made[0];
    conversation.updateMode("speaking");
    expect(h.call.state.mode).toBe("spricht");
    expect(h.call.interrupt()).toBe(true);
    await ticks();
    expect(sent).toEqual([{ type: "user_activity" }]);
    expect(h.call.state).toMatchObject({ mode: "spricht", interrupting: true });
    // Ohne Ereignis des Servers bleibt es beim Sprechen
    h.timers.fire(INTERRUPT_MS);
    expect(h.call.state).toMatchObject({ mode: "spricht", interrupting: false, hint: TEXT.interruptUnconfirmed });
    // Erneut, diesmal mit Ereignis
    expect(h.call.interrupt()).toBe(true);
    await conversation.onMessage({ type: "interruption", interruption_event: { event_id: 4 } });
    expect(h.call.state).toMatchObject({ mode: "hoert", interrupting: false, hint: "" });
    await h.call.hangUp();
  });
});

describe("Wechsel zu einem anderen Sprachagenten", () => {
  test("verbunden: erst getrennt und Ende gemeldet, dann navigiert", async () => {
    const h = harness();
    await h.call.start();
    const urls: string[] = [];
    const moved = await page.switchVoiceAgent(h.call, "/sa/experte", (url: string) => {
      // Beim Navigieren ist das alte Gespräch schon abgeschlossen
      expect(h.sessions[0].ended).toBe(1);
      expect(ends(h)).toEqual(["conv_1"]);
      urls.push(url);
    });
    expect(moved).toBe(true);
    expect(urls).toEqual(["/sa/experte"]);
    expect(h.call.busy).toBe(false);
  });

  test("ohne Gespräch: sofort navigiert, nichts gemeldet", async () => {
    const h = harness();
    const urls: string[] = [];
    expect(await page.switchVoiceAgent(h.call, "/sa/experte", (u: string) => urls.push(u))).toBe(true);
    expect(urls).toEqual(["/sa/experte"]);
    expect(h.requests).toEqual([]);
  });

  test("während des Tokenabrufs: wartet auf das Token, beendet es, meldet das Ende, dann navigiert", async () => {
    const h = harness();
    const hold = gate();
    h.tokenHold = hold.promise;
    const starting = h.call.start();
    await tick();
    const urls: string[] = [];
    const switching = page.switchVoiceAgent(h.call, "/sa/experte", (u: string) => urls.push(u));
    await tick();
    expect(urls).toEqual([]);
    expect(h.call.busy).toBe(true);
    hold.release();
    await starting;
    expect(await switching).toBe(true);
    expect(urls).toEqual(["/sa/experte"]);
    // Kein SDK-Start mit dem späten Token, aber das Ende gemeldet
    expect(h.sessions).toHaveLength(0);
    expect(ends(h)).toEqual(["conv_1"]);
  });

  test("während des SDK-Aufbaus: wartet auf die späte Sitzung, trennt sie, meldet das Ende, dann navigiert", async () => {
    const h = harness();
    const hold = gate();
    h.connectHold = hold.promise;
    const starting = h.call.start();
    await ticks();
    const urls: string[] = [];
    const switching = page.switchVoiceAgent(h.call, "/sa/experte", (u: string) => urls.push(u));
    await ticks();
    // await hangUp() allein kehrt hier schon zurück; der Wechsel wartet weiter
    expect(urls).toEqual([]);
    expect(ends(h)).toEqual([]);
    hold.release();
    await starting;
    expect(await switching).toBe(true);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].ended).toBe(1);
    expect(h.sessions[0].connection.room.state).toBe("disconnected");
    expect(ends(h)).toEqual(["conv_1"]);
    expect(urls).toEqual(["/sa/experte"]);
  });

  test("Trennen scheitert: kein Wechsel, „Noch einmal auflegen“ bleibt", async () => {
    const h = harness();
    await h.call.start();
    h.sessions[0].endSession = async () => {
      throw new Error("kaputt");
    };
    const urls: string[] = [];
    expect(await page.switchVoiceAgent(h.call, "/sa/experte", (u: string) => urls.push(u))).toBe(false);
    expect(urls).toEqual([]);
    expect(h.call.busy).toBe(true);
    expect(h.call.state.retryEnd).toBe(true);
    expect(ends(h)).toEqual([]);
  });

  test("Ende ausstehend (202): der Wechsel fragt einmal nach und bleibt stehen, Sperre bleibt; nach der Bestätigung geht er", async () => {
    const locks = fakeLocks();
    const h = harness({ lock: page.createVoiceAgentLock(locks) });
    await h.call.start();
    h.endReply = pending202;
    await h.call.hangUp();
    expect(h.call.state).toMatchObject({ phase: "beendet", ausstehend: true });
    const urls: string[] = [];
    expect(await page.switchVoiceAgent(h.call, "/sa/experte", (u: string) => urls.push(u))).toBe(false);
    expect(urls).toEqual([]);
    expect(ends(h)).toEqual(["conv_1", "conv_1"]);
    expect(h.call.busy).toBe(true);
    expect(locks.held.size).toBe(1);
    h.endReply = () => Response.json({ ok: true, minuten: 2 });
    expect(await page.switchVoiceAgent(h.call, "/sa/experte", (u: string) => urls.push(u))).toBe(true);
    expect(urls).toEqual(["/sa/experte"]);
    await tick();
    expect(locks.held.size).toBe(0);
  });
});

describe("Ein Gespräch je Browser (Web Locks)", () => {
  test("zweiter Tab startet nicht, solange der erste spricht; nach dessen Ende schon", async () => {
    const locks = fakeLocks();
    const a = harness({ lock: page.createVoiceAgentLock(locks) });
    const b = harness({ lock: page.createVoiceAgentLock(locks), kennung: "experte" });
    await a.call.start();
    expect(locks.held.has(page.VOICE_AGENT_LOCK_NAME)).toBe(true);
    await b.call.start();
    expect(b.call.state.phase).toBe("fehler");
    expect(b.call.state.text).toBe(TEXT.otherTab);
    expect(b.requests).toEqual([]);
    expect(b.call.busy).toBe(false);
    expect(page.voiceAgentButtons(b.call.state, READY).talk).toBe(TEXT.again);
    await a.call.hangUp();
    await tick();
    expect(locks.held.size).toBe(0);
    await b.call.start();
    expect(b.call.state.phase).toBe("verbunden");
  });

  test("[P1] Ende ausstehend (202): Sperre bleibt bis zur Bestätigung; kein zweites Gespräch bei einem anderen Agenten, kein Neustart im selben Tab", async () => {
    const locks = fakeLocks();
    const a = harness({ lock: page.createVoiceAgentLock(locks) });
    const b = harness({ lock: page.createVoiceAgentLock(locks), kennung: "experte" });
    await a.call.start();
    a.endReply = pending202;
    await a.call.hangUp();
    expect(a.call.state).toMatchObject({ phase: "beendet", ausstehend: true, retryEnd: false });
    expect(a.call.busy).toBe(true);
    expect(locks.held.size).toBe(1);
    expect(page.voiceAgentButtons(a.call.state, READY)).toMatchObject({ talk: null, hangUp: null });
    expect(page.voiceAgentStatusText(a.call.state, READY)).toContain(TEXT.pendingCheck);
    // idle() kehrt zurück (nichts mehr in Arbeit), busy bleibt
    await a.call.idle();
    // Neustart im selben Tab: keine Anfrage, kein Token
    const before = a.requests.length;
    await a.call.start();
    expect(a.requests).toHaveLength(before);
    expect(a.sessions).toHaveLength(1);
    // Anderer Tab, anderer Agent: gesperrt, keine Anfrage, keine Verbindung
    await b.call.start();
    expect(b.call.state).toMatchObject({ phase: "fehler", text: TEXT.otherTab });
    expect(b.requests).toEqual([]);
    expect(b.sessions).toHaveLength(0);
    expect(a.sessions.length + b.sessions.length).toBe(1);
    // Nachfrage: weiter ausstehend, dann scheitert sie (Netz), dann bestätigt ElevenLabs
    expect(a.timers.fire(PENDING_MS)).toBe(1);
    await ticks();
    expect(ends(a)).toEqual(["conv_1", "conv_1"]);
    expect(a.call.state.ausstehend).toBe(true);
    expect(locks.held.size).toBe(1);
    a.endReply = () => Promise.reject(new Error("offline"));
    expect(a.timers.fire(PENDING_MS)).toBe(1);
    await ticks();
    expect(a.call.state).toMatchObject({ ausstehend: true, retryEnd: false });
    expect(a.timers.open(PENDING_MS)).toBe(1);
    expect(locks.held.size).toBe(1);
    a.endReply = () => Response.json({ ok: true, minuten: 3 });
    a.timers.fire(PENDING_MS);
    await ticks();
    expect(a.call.state).toMatchObject({ phase: "beendet", ausstehend: false, minuten: 3 });
    expect(a.call.busy).toBe(false);
    expect(locks.held.size).toBe(0);
    expect(a.timers.open(PENDING_MS)).toBe(0);
    await b.call.start();
    expect(b.call.state.phase).toBe("verbunden");
  });

  test("Ende ausstehend nach einem Verbindungsfehler: Fehlersatz, Sperre bleibt; Server kennt das Gespräch nicht mehr (404): frei", async () => {
    const locks = fakeLocks();
    const h = harness({
      lock: page.createVoiceAgentLock(locks),
      sdk: {
        Conversation: {
          startSession: async () => {
            throw new Error("could not establish pc connection");
          },
        },
      },
    });
    h.endReply = pending202;
    await h.call.start();
    expect(h.call.state).toMatchObject({ phase: "fehler", ausstehend: true });
    expect(h.call.state.text).toStartWith(TEXT.connectFailed);
    expect(locks.held.size).toBe(1);
    h.endReply = () => Response.json({ error: "Es läuft kein Gespräch.", reason: "kein_gespraech" }, { status: 404 });
    h.timers.fire(PENDING_MS);
    await ticks();
    expect(h.call.state).toMatchObject({ phase: "fehler", ausstehend: false, text: TEXT.connectFailed });
    expect(h.call.busy).toBe(false);
    expect(locks.held.size).toBe(0);
  });

  test("die Sperre fällt bei jedem Ende: Auflegen während des Tokenabrufs", async () => {
    const locks = fakeLocks();
    const a = harness({ lock: page.createVoiceAgentLock(locks) });
    const hold = gate();
    a.tokenHold = hold.promise;
    const starting = a.call.start();
    await tick();
    expect(locks.held.size).toBe(1);
    void a.call.hangUp();
    hold.release();
    await starting;
    await a.call.idle();
    await tick();
    expect(locks.held.size).toBe(0);
  });

  test("bleibt die Verbindung ungetrennt (Noch einmal auflegen), bleibt auch die Sperre", async () => {
    const locks = fakeLocks();
    const a = harness({ lock: page.createVoiceAgentLock(locks) });
    await a.call.start();
    a.sessions[0].endSession = async () => {
      throw new Error("kaputt");
    };
    await a.call.hangUp();
    await tick();
    expect(a.call.state.retryEnd).toBe(true);
    expect(locks.held.size).toBe(1);
    a.sessions[0].endSession = async () => void (await a.sessions[0].connection.room.disconnect());
    await a.call.hangUp();
    await tick();
    expect(a.call.busy).toBe(false);
    expect(locks.held.size).toBe(0);
  });

  test("[P1] ohne Web Locks: kein Gespräch, eigener Satz, keine Anfrage", async () => {
    await expect(page.createVoiceAgentLock(undefined)()).rejects.toMatchObject({ lockReason: "fehlt" });
    await expect(page.createVoiceAgentLock({})()).rejects.toMatchObject({ lockReason: "fehlt" });
    const h = harness({ lock: page.createVoiceAgentLock(undefined) });
    await h.call.start();
    expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.lockMissing });
    expect(h.requests).toEqual([]);
    expect(h.call.busy).toBe(false);
  });

  for (const broken of ["wirft", "lehnt ab", "erfüllt ohne Rückruf"] as const) {
    test(`[P1] Web Locks gestört (${broken}): kein Gespräch, eigener Satz, keine Anfrage`, async () => {
      const locks = {
        request: () => {
          if (broken === "wirft") throw new Error("SecurityError");
          return broken === "lehnt ab" ? Promise.reject(new Error("SecurityError")) : Promise.resolve(undefined);
        },
      };
      const h = harness({ lock: page.createVoiceAgentLock(locks) });
      await h.call.start();
      expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.lockFailed });
      expect(h.requests).toEqual([]);
    });
  }

  test("[P1] Web Locks antworten nicht: nach der Frist gestört; eine späte Erteilung wird sofort freigegeben", async () => {
    const t = timers();
    let late: ((lock: unknown) => unknown) | null = null;
    let lateHeld: unknown = null;
    const locks = {
      request: (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => {
        late = callback;
        return new Promise(() => {});
      },
    };
    const h = harness({ lock: page.createVoiceAgentLock(locks, undefined, t.setTimer) });
    const starting = h.call.start();
    await tick();
    expect(t.fire(page.VOICE_AGENT_LOCK_TIMEOUT_MS)).toBe(1);
    await starting;
    expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.lockFailed });
    expect(h.requests).toEqual([]);
    lateHeld = late!({ name: "spät" });
    expect(lateHeld).toBeUndefined();
  });

  test("[P1] gehaltene Sperre geht verloren (steal): Gespräch endet sicher mit Satz", async () => {
    const locks = fakeLocks();
    const h = harness({ lock: page.createVoiceAgentLock(locks) });
    await h.call.start();
    locks.steal(page.VOICE_AGENT_LOCK_NAME);
    await ticks();
    expect(h.call.state).toMatchObject({ phase: "fehler", text: TEXT.lockLost });
    expect(h.sessions[0].ended).toBe(1);
    expect(ends(h)).toEqual(["conv_1"]);
    expect(h.call.busy).toBe(false);
  });

  test("Auflegen, während die Sperre noch angefragt wird: keine Sperre bleibt liegen, kein Token", async () => {
    const hold = gate();
    let freed = 0;
    const lock = async () => {
      await hold.promise;
      return () => void freed++;
    };
    const h = harness({ lock });
    const starting = h.call.start();
    await tick();
    await h.call.hangUp();
    hold.release();
    await starting;
    expect(freed).toBe(1);
    expect(h.requests).toEqual([]);
    expect(h.call.busy).toBe(false);
  });
});
