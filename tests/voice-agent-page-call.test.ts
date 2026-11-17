/**
 * Issue #494, Aufgabe 2b: Gesprächsseite /sa/<kennung> mit Verbindung und
 * Auflegen. sprachagent.js läuft ohne Browser gegen den echten Web-Server
 * (Login, Origin), die echte Ablage im Temp-Ordner, den Anbieter als
 * Fetch-Attrappe und das SDK als Attrappe. Geprüft: Start mit genau dem
 * ausgegebenen WebRTC-Token, Verbindungsfehler meldet das Ende, Auflegen ruft
 * endSession und /session/end, Auflegen während des Verbindens, Abbruch durch
 * den Agenten, Wiederholung nach gescheitertem Löschen der Freigabe, Verlassen
 * der Seite, auch mitten im Start (Tokenabruf, SDK-Laden, Verbindungsaufbau)
 * und Auflegen während des SDK-Ladens, jeweils mit Freigabe, Minutenbuchung
 * und Neustart. Dazu: verzögertes oder gescheitertes Trennen, verspätete
 * Endemeldungen und zwei unabhängige Clients, ohne vorzeitige Rückbuchung.
 * Mit dem eingecheckten SDK: Ende erst nach dem getrennten LiveKit-Raum.
 *
 * Der Anbieter (Statusabfrage GET /v1/convai/conversations/<id>) folgt den
 * Räumen der SDK-Attrappen: in-progress, solange der Raum des Gesprächs
 * verbunden ist, danach done mit der Dauer; ohne Raum unbekannt (404). So
 * prüfen die Tests, dass Platz, Freigabe und Minuten nur nach ElevenLabs
 * freigegeben werden, nie nach einer Meldung der Seite. Dazu die beiden
 * Proben der Prüfrunde 5 (Aufbau scheitert vor onConversationCreated; Aufbau
 * kehrt nach der alten Ablaufgrenze zurück) und zwei Clients über die
 * Ablaufgrenze mit ausstehender Trennung.
 * Der echte Browser: scripts/web-sprachagent-check.ts.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_MINUTES_PER_CALL } from "../src/lib/voice-agents/recipe";
import { verifyWebCall, WEB_CALL_MAX_TTL_MS } from "../src/lib/voice-agents/web-calls";
import { readWebSessions, WEB_SESSION_SLACK_MS, WEB_SESSION_TOKEN_MS } from "../src/lib/voice-agents/web-sessions";
import { VOICE_AGENT_SESSION_TEXT } from "../src/web/voice-agent-page";
import type { WebServer } from "../src/web/server";
import type { ServerCtx } from "./topic-fixture";
import { BRIDGE_TOKEN, bridge, readyAgent, removeSessionWorlds, sessionServer, sessionWorld, START, tokenName, type SessionWorld } from "./voice-agent-session-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const SOURCE = await readFile(join(publicDir, "sprachagent.js"), "utf8");
// Auch direkt gebaute oder montierte Seiten gehören zum jeweiligen Test.
// Ihre echten Zeitgeber dürfen nach dessen Ende keine HTTP-Anfrage auslösen.
const pageTimers = new Set<ReturnType<typeof setTimeout>>();
function pageSetTimeout(fn: () => void, ms: number) {
  const timer = setTimeout(() => {
    pageTimers.delete(timer);
    fn();
  }, ms);
  pageTimers.add(timer);
  return timer;
}
function pageClearTimeout(timer: ReturnType<typeof setTimeout>) {
  clearTimeout(timer);
  pageTimers.delete(timer);
}
function clearPageTimers() {
  for (const timer of pageTimers) clearTimeout(timer);
  pageTimers.clear();
}
const page = new Function(
  "setTimeout", "clearTimeout",
  `${SOURCE}\nreturn { createVoiceAgentCall, createVoiceAgentSdkLoader, voiceAgentButtons, voiceAgentStatusText, VOICE_AGENT_SDK, VOICE_AGENT_TEXT };`
)(pageSetTimeout, pageClearTimeout) as any;

const root = await mkdtemp(join(tmpdir(), "voice-agent-page-call-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  removeSessionWorlds();
});
const servers: WebServer[] = [];
afterEach(async () => {
  clearPageTimers();
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

/**
 * Räume beim Anbieter je Welt: Gesprächs-ID, Raum (Attrappe oder echter Room
 * des SDK), Beginn und, sobald getrennt gesehen, Ende. Die SDK-Attrappen
 * tragen ihre Räume in die Welt des zuletzt gebauten Harness ein.
 */
interface ProviderRoom {
  room: { state: string };
  openedAt: number;
  closedAt?: number;
}
const providerRooms = new WeakMap<SessionWorld, Map<string, ProviderRoom>>();
let currentWorld: SessionWorld | null = null;

/** Raum zum Token gesprächstoken-<n> beim Anbieter eintragen (Gespräch conv_<n>) */
function openProviderRoom(token: string, room: { state: string }): void {
  if (!currentWorld) throw new Error("kein Harness");
  providerRooms.get(currentWorld)!.set(`conv_${String(token).split("-").pop()}`, { room, openedAt: currentWorld.clock.now });
}

/** Status beim Anbieter aus den Räumen: verbunden in-progress, getrennt done, ohne Raum unbekannt */
function roomProvider(w: SessionWorld): void {
  providerRooms.set(w, new Map());
  currentWorld = w;
  w.conversation = (id) => {
    const entry = providerRooms.get(w)!.get(id);
    if (!entry) return "unbekannt";
    if (entry.room.state !== "disconnected") return { status: "in-progress" };
    entry.closedAt ??= w.clock.now;
    return { status: "done", dauerSek: Math.round((entry.closedAt - entry.openedAt) / 1000) };
  };
}

/** Wie viele Räume beim Anbieter gerade verbunden sind */
const providerOpen = (w: SessionWorld) => [...providerRooms.get(w)!.values()].filter((e) => e.room.state !== "disconnected").length;

/**
 * LiveKit-Raum wie im SDK: disconnect() läuft unter einer Sperre, ein zweiter
 * Aufruf wartet auf den ersten, getrennt kehrt er sofort zurück. holds: je
 * Trennen der Reihe nach ein Versprechen, auf das der Transport wartet.
 */
interface FakeRoom {
  state: "connected" | "disconnected";
  disconnectCalls: number;
  holds: Promise<void>[];
  pending: Promise<void> | null;
  disconnect(): Promise<void>;
}

function fakeRoom(): FakeRoom {
  const room: FakeRoom = {
    state: "connected",
    disconnectCalls: 0,
    holds: [],
    pending: null,
    disconnect() {
      room.disconnectCalls++;
      if (room.state === "disconnected") return Promise.resolve();
      if (!room.pending) {
        const hold = room.holds.shift();
        room.pending = (async () => {
          if (hold) await hold;
          room.state = "disconnected";
        })().finally(() => {
          room.pending = null;
        });
      }
      return room.pending;
    },
  };
  return room;
}

interface FakeSession {
  options: any;
  ended: number;
  endCalls: number;
  endHolds: Promise<void>[];
  connection: { room: FakeRoom };
  endSession(): Promise<void>;
}

/** Versprechen, das der Test von außen erfüllt */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/**
 * SDK-Attrappe: startSession verbindet sofort oder scheitert. holds: je Aufruf
 * der Reihe nach ein Versprechen, auf das startSession vor dem Verbinden wartet.
 */
function fakeSdk(behavior: "ok" | "fail" = "ok") {
  const started: any[] = [];
  const sessions: FakeSession[] = [];
  const holds: Promise<void>[] = [];
  const sdk = {
    Conversation: {
      async startSession(options: any) {
        started.push(options);
        options.onStatusChange?.({ status: "connecting" });
        const hold = holds.shift();
        if (hold) await hold;
        if (behavior === "fail") throw new Error("could not establish pc connection");
        const room = fakeRoom();
        openProviderRoom(options.conversationToken, room);
        const session: FakeSession = {
          options,
          ended: 0,
          endCalls: 0,
          endHolds: [],
          connection: { room },
          async endSession() {
            session.endCalls++;
            const hold = session.endHolds.shift();
            if (hold) await hold;
            session.ended++;
            // Wie das SDK: room.disconnect() ohne await, dann onDisconnect
            void session.connection?.room?.disconnect().catch(() => {});
            options.onDisconnect?.({ reason: "user" });
          },
        };
        sessions.push(session);
        options.onModeChange?.({ mode: "listening" });
        return session;
      },
    },
  };
  return { sdk, started, sessions, holds };
}

interface Harness {
  w: SessionWorld;
  ctx: ServerCtx;
  call: any;
  states: any[];
  requests: { url: string; body: string; keepalive: boolean }[];
  sdk: ReturnType<typeof fakeSdk>;
  sdkLoads: number;
  /** Erfüllt der Test, erst dann liefert der nächste loadSdk-Aufruf das SDK */
  sdkHold: Promise<void> | null;
  logins: number;
  endReplies: ((response: Response) => Promise<Response>)[];
  /** Zeitgeber der Seite (Aufbau-Frist, Zeitgrenze beim Trennen); fire() löst sie aus */
  timers: { fn: () => void; ms: number; cancelled: boolean }[];
  /** Mikrofonanfragen der Seite; micHold hält die nächste an */
  mics: { stopped: number }[];
  micHold: Promise<void> | null;
}

/** Löst alle noch offenen Zeitgeber aus, deren Dauer mindestens ms ist */
function fireTimers(h: Harness, ms = 0): number {
  let fired = 0;
  for (const t of h.timers) {
    if (!t.cancelled && t.ms >= ms) {
      t.cancelled = true;
      fired++;
      t.fn();
    }
  }
  return fired;
}

async function harness(kennung: string, behavior: "ok" | "fail" = "ok", change: (raw: any) => void = bridge, shared?: Harness): Promise<Harness> {
  const w = shared?.w ?? sessionWorld();
  if (!shared) {
    roomProvider(w);
    await readyAgent(w, kennung, change);
  }
  const ctx = shared?.ctx ?? await sessionServer(root, servers, w);
  const h = {
    w,
    ctx,
    states: [] as any[],
    requests: [] as Harness["requests"],
    sdk: fakeSdk(behavior),
    sdkLoads: 0,
    sdkHold: null,
    logins: 0,
    endReplies: [],
    timers: [],
    mics: [],
    micHold: null,
  } as Harness;
  h.call = page.createVoiceAgentCall({
    kennung,
    // Wie der Browser: gleiche Herkunft, Sitzungs-Cookie
    fetch: async (url: string, init: any) => {
      h.requests.push({ url, body: String(init.body ?? ""), keepalive: init.keepalive === true });
      const response = await fetch(`${ctx.origin}${url}`, { ...init, headers: { ...init.headers, cookie: ctx.cookie, origin: ctx.origin } });
      const reply = url.endsWith("/session/end") ? h.endReplies.shift() : null;
      return reply ? reply(response) : response;
    },
    loadSdk: async () => {
      h.sdkLoads++;
      const hold = h.sdkHold;
      h.sdkHold = null;
      if (hold) await hold;
      return h.sdk.sdk;
    },
    requestMicrophone: async () => {
      const hold = h.micHold;
      h.micHold = null;
      if (hold) await hold;
      const mic = { stopped: 0 };
      h.mics.push(mic);
      return { getTracks: () => [{ stop: () => mic.stopped++ }] };
    },
    // Zeitgeber (Zeitgrenze beim Trennen) löst nur der Test aus
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      h.timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onChange: (state: any) => h.states.push({ ...state }),
    toLogin: () => h.logins++,
  });
  return h;
}

const verify = (w: SessionWorld, kennung: string, conversationId: string) =>
  verifyWebCall({ kennung, conversationId }, { ...w.paths, token: BRIDGE_TOKEN, now: () => w.clock.now });
const webCallFiles = (w: SessionWorld, kennung: string) => {
  const dir = join(w.paths.dataDir, kennung, "web-calls");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const info = (h: Harness, kennung: string) => h.ctx.api(`/api/voice-agents/${kennung}`).then((r) => r.json());
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await check()); i++) await Bun.sleep(5);
}
const endRequests = (h: Harness) => h.requests.filter((r) => r.url.endsWith("/session/end"));

/** Gespräch auf dem Server beendet: Platz frei, Freigabe gelöscht, minutes gebucht (Standard eine) */
async function expectEnded(h: Harness, conversationId: string, minutes = 1): Promise<void> {
  await until(async () => (await info(h, "jarvis")).laufend === null);
  expect((await info(h, "jarvis")).laufend).toBeNull();
  expect(await verify(h.w, "jarvis", conversationId)).toBe(false);
  expect(webCallFiles(h.w, "jarvis")).toEqual([]);
  const stored = await readWebSessions("jarvis", h.w.paths);
  expect(stored.sitzungen.map((s) => [s.gespraech, s.ende !== null, s.minuten])).toEqual([[conversationId, true, minutes]]);
}

/**
 * Nie verbundenes Gespräch (kein Raum beim Anbieter): Die Seite hat das Ende
 * gemeldet, der Server wartet trotzdem auf ElevenLabs. Bis zum Tokenablauf
 * bleiben Platz, Freigabe und volle Minuten; danach gilt es als nie zustande
 * gekommen (null Minuten), und der Platz ist frei.
 */
async function expectHeldUntilTokenExpiry(h: Harness, conversationId: string): Promise<void> {
  expect((await info(h, "jarvis")).laufend).not.toBeNull();
  expect(await verify(h.w, "jarvis", conversationId)).toBe(true);
  expect((await info(h, "jarvis")).minuten.verbraucht).toBe(12);
  expect((await h.ctx.api("/api/voice-agents/jarvis/session", "POST", {})).status).toBe(409);
  const issued = h.w.issued.get(conversationId)!;
  h.w.clock.now = issued + WEB_SESSION_TOKEN_MS + WEB_SESSION_SLACK_MS;
  await expectEnded(h, conversationId, 0);
}

/** Zeitgeber der Nachfrage, solange ElevenLabs das Ende nicht bestätigt hat (länger als die Zeitgrenze beim Trennen) */
const PENDING_CHECK_MS = 20_000;

/**
 * Die Seite hielt Versuch und Sperre, solange das Ende ausstand (Issue #495):
 * Erst ihre nächste Nachfrage beim Server gibt beides frei, ein Neustart
 * vorher bleibt ohne Wirkung.
 */
async function settlePending(h: Harness): Promise<void> {
  if (!h.call.state.ausstehend) return;
  expect(h.call.busy).toBe(true);
  const requests = h.requests.length;
  await h.call.start();
  expect(h.requests).toHaveLength(requests);
  expect(fireTimers(h, PENDING_CHECK_MS)).toBe(1);
  await until(() => !h.call.busy);
  expect(h.call.busy).toBe(false);
  expect(h.call.state.ausstehend).toBe(false);
}

/** Neustart nach dem Abbruch: neues Token, genau eine offene Sitzung, Freigabe für das neue Gespräch */
async function expectRestart(h: Harness, sessionsBefore: number): Promise<void> {
  await settlePending(h);
  await h.call.start();
  expect(h.call.state.phase).toBe("verbunden");
  expect(tokenName(h.sdk.started.at(-1).conversationToken)).toBe("gespraechstoken-2");
  expect(h.sdk.sessions).toHaveLength(sessionsBefore + 1);
  expect(h.sdk.sessions.filter((s) => s.ended === 0)).toHaveLength(1);
  expect(await verify(h.w, "jarvis", "conv_2")).toBe(true);
}

describe("Gesprächsseite: Start", () => {
  test("Sprechen holt das Token und verbindet über WebRTC mit genau diesem Token und selbst gehosteten Worklets", async () => {
    const h = await harness("jarvis");
    await h.call.start();
    expect(h.states.map((s) => s.phase)).toEqual(["verbinde", "verbunden"]);
    // Mikrofon vor dem Token; danach meldet die Seite nichts mehr bis zum Auflegen
    expect(h.mics).toEqual([{ stopped: 1 }]);
    expect(h.requests.map((r) => [r.url, r.body])).toEqual([["/api/voice-agents/jarvis/session", "{}"]]);
    expect(h.sdk.started).toHaveLength(1);
    const options = h.sdk.started[0];
    expect(tokenName(options.conversationToken)).toBe("gespraechstoken-1");
    expect(options.connectionType).toBe("webrtc");
    expect(options.workletPaths).toEqual({ rawAudioProcessor: "/vendor/elevenlabs/rawAudioProcessor.js" });
    // Kein Schlüssel, keine Agent-ID, keine signierte Adresse im Browser
    expect(options.agentId).toBeUndefined();
    expect(options.signedUrl).toBeUndefined();
    // Server: Gespräch läuft mit dieser ID, Web-Freigabe der Brücke steht
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
    expect((await info(h, "jarvis")).laufend).not.toBeNull();
    expect(page.voiceAgentStatusText(h.call.state, { bereit: true })).toBe(page.VOICE_AGENT_TEXT.listening);
    expect(page.voiceAgentButtons(h.call.state, { bereit: true })).toMatchObject({ talk: null, hangUp: "Auflegen" });
  });

  test("onModeChange schaltet zwischen Zuhören und Sprechen", async () => {
    const h = await harness("jarvis");
    await h.call.start();
    const { options } = h.sdk.sessions[0];
    options.onModeChange({ mode: "speaking" });
    expect(page.voiceAgentStatusText(h.call.state, { bereit: true })).toBe(page.VOICE_AGENT_TEXT.speaking);
    options.onModeChange({ mode: "listening" });
    expect(page.voiceAgentStatusText(h.call.state, { bereit: true })).toBe(page.VOICE_AGENT_TEXT.listening);
  });

  test("Server lehnt ab (gesperrt): Satz des Servers, kein SDK, kein Ende zu melden", async () => {
    const h = await harness("jarvis");
    await rm(join(h.w.paths.dataDir, "jarvis", "freischaltung.json"));
    await h.call.start();
    expect(h.call.state.phase).toBe("fehler");
    expect(h.call.state.text).toContain("nicht freigeschaltet");
    expect(h.sdkLoads).toBe(0);
    expect(h.requests).toHaveLength(1);
  });

  test("läuft schon ein Gespräch (409): Hinweis statt eines Knopfs zum fremden Auflegen", async () => {
    const h = await harness("experte", "ok", () => {});
    expect((await h.ctx.api("/api/voice-agents/experte/session", "POST", {})).status).toBe(200);
    await h.call.start();
    expect(h.call.state.phase).toBe("laeuft");
    expect(page.voiceAgentButtons(h.call.state, { bereit: true })).toMatchObject({ talk: null, hangUp: null });
    await h.call.hangUp();
    expect(endRequests(h)).toEqual([]);
    expect(h.call.state.phase).toBe("laeuft");
    expect((await info(h, "experte")).laufend).not.toBeNull();
  });
});

describe("Gesprächsseite: Verbindungsfehler", () => {
  test("SDK verbindet nicht: Fehler mit eigenem Satz, Ende gemeldet; frei erst, wenn ElevenLabs es belegt (Token abgelaufen, nie verbunden)", async () => {
    const h = await harness("jarvis", "fail");
    await h.call.start();
    expect(tokenName(h.sdk.started[0].conversationToken)).toBe("gespraechstoken-1");
    expect(h.call.state).toMatchObject({ phase: "fehler", retryEnd: false, ausstehend: true });
    expect(h.call.state.text).toStartWith(page.VOICE_AGENT_TEXT.connectFailed);
    expect(h.call.state.text).toContain(VOICE_AGENT_SESSION_TEXT.endPending);
    expect(h.requests.map((r) => [r.url, r.body])).toEqual([
      ["/api/voice-agents/jarvis/session", "{}"],
      ["/api/voice-agents/jarvis/session/end", JSON.stringify({ conversationId: "conv_1" })],
    ]);
    // Solange ElevenLabs das Ende nicht bestätigt, kein neues Gespräch (Issue #495)
    expect(page.voiceAgentButtons(h.call.state, { bereit: true })).toMatchObject({ talk: null, hangUp: null });
    // Die Seite weiß nicht, ob das Token doch noch verbindet: Neustart erst nach Tokenablauf
    await expectHeldUntilTokenExpiry(h, "conv_1");
    await settlePending(h);
    expect(page.voiceAgentButtons(h.call.state, { bereit: true })).toMatchObject({ talk: page.VOICE_AGENT_TEXT.again, hangUp: null });
    // Noch einmal: wieder ein Token, wieder ein Versuch
    h.sdk = fakeSdk("ok");
    await h.call.start();
    expect(h.call.state.phase).toBe("verbunden");
    expect(tokenName(h.sdk.started[0].conversationToken)).toBe("gespraechstoken-2");
  });

  test("SDK nicht ladbar: wie ein Verbindungsfehler, Ende gemeldet", async () => {
    const h = await harness("jarvis");
    const call = page.createVoiceAgentCall({
      kennung: "jarvis",
      fetch: (url: string, init: any) => fetch(`${h.ctx.origin}${url}`, { ...init, headers: { ...init.headers, cookie: h.ctx.cookie, origin: h.ctx.origin } }),
      loadSdk: () => Promise.reject(new Error("SDK nicht ladbar")),
      onChange: () => {},
      toLogin: () => {},
    });
    await call.start();
    expect(call.state).toMatchObject({ phase: "fehler", ausstehend: true });
    expect(call.state.text).toStartWith(page.VOICE_AGENT_TEXT.connectFailed);
    await expectHeldUntilTokenExpiry(h, "conv_1");
  });

  test("nach dem Aufräumen: ausstehendes Ende fragt nicht im nächsten Test nach", async () => {
    const h = await harness("jarvis");
    const requests: string[] = [];
    const call = page.createVoiceAgentCall({
      kennung: "jarvis",
      fetch: (url: string, init: any) => {
        requests.push(url);
        return fetch(`${h.ctx.origin}${url}`, { ...init, headers: { ...init.headers, cookie: h.ctx.cookie, origin: h.ctx.origin } });
      },
      loadSdk: () => Promise.reject(new Error("SDK nicht ladbar")),
      pendingCheckMs: 20,
      onChange: () => {},
      toLogin: () => {},
    });
    await call.start();
    expect(call.state.ausstehend).toBe(true);
    const before = [...requests];
    expect(before).toHaveLength(2);
    clearPageTimers();
    await Bun.sleep(50);
    expect(requests).toEqual(before);
  });

  test("Server nicht erreichbar: Fehler, kein SDK", async () => {
    const h = await harness("jarvis");
    const call = page.createVoiceAgentCall({
      kennung: "jarvis",
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
      loadSdk: async () => h.sdk.sdk,
      onChange: () => {},
      toLogin: () => {},
    });
    await call.start();
    expect(call.state).toMatchObject({ phase: "fehler", text: page.VOICE_AGENT_TEXT.offline });
    expect(h.sdk.started).toEqual([]);
  });
});

describe("Gesprächsseite: Auflegen", () => {
  test("Auflegen ruft endSession und meldet das Ende mit der Gesprächs-ID; Minuten gebucht, Freigabe gelöscht", async () => {
    const h = await harness("jarvis");
    await h.call.start();
    h.w.clock.now += 2 * 60_000 + 5_000;
    await h.call.hangUp();
    expect(h.sdk.sessions[0].ended).toBe(1);
    expect(h.requests.at(-1)).toEqual({ url: "/api/voice-agents/jarvis/session/end", body: JSON.stringify({ conversationId: "conv_1" }), keepalive: false });
    // onDisconnect aus endSession meldet nicht ein zweites Mal
    expect(h.requests.filter((r) => r.url.endsWith("/session/end"))).toHaveLength(1);
    expect(h.call.state).toMatchObject({ phase: "beendet", minuten: 3 });
    expect(page.voiceAgentStatusText(h.call.state, { bereit: true })).toBe("Gespräch beendet, 3 Minuten gebucht.");
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(false);
    expect((await info(h, "jarvis")).minuten.verbraucht).toBe(3);
  });

  test("Agent legt auf (onDisconnect): Ende gemeldet, Platz frei", async () => {
    const h = await harness("jarvis");
    await h.call.start();
    h.sdk.sessions[0].options.onDisconnect({ reason: "agent" });
    for (let i = 0; i < 100 && h.call.state.phase !== "beendet"; i++) await Bun.sleep(5);
    expect(h.call.state.phase).toBe("beendet");
    expect((await info(h, "jarvis")).laufend).toBeNull();
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(false);
  });

  test("Auflegen während des Verbindens: nach dem Token kein SDK-Start, Ende gemeldet", async () => {
    const h = await harness("jarvis");
    let release!: () => void;
    h.w.replies.push({ warte: new Promise<void>((r) => (release = r)) });
    const pending = h.call.start();
    for (let i = 0; i < 200 && h.w.calls.length === 0; i++) await Bun.sleep(2);
    await h.call.hangUp();
    expect(page.voiceAgentStatusText(h.call.state, { bereit: true })).toBe(page.VOICE_AGENT_TEXT.cancelling);
    release();
    await pending;
    expect(h.sdk.started).toEqual([]);
    expect(h.call.state).toMatchObject({ phase: "beendet", ausstehend: true });
    expect(page.voiceAgentStatusText(h.call.state, { bereit: true })).toContain(VOICE_AGENT_SESSION_TEXT.endPending);
    await expectHeldUntilTokenExpiry(h, "conv_1");
  });

  test("Auflegen während des SDK-Ladens: kein SDK-Start, Ende gemeldet, frei nach Tokenablauf ohne Minuten, dann Neustart", async () => {
    const h = await harness("jarvis");
    const sdkReady = gate();
    h.sdkHold = sdkReady.promise;
    const pending = h.call.start();
    await until(() => h.sdkLoads === 1);
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
    await h.call.hangUp();
    expect(h.call.state.phase).toBe("beendet");
    sdkReady.release();
    await pending;
    expect(h.sdk.started).toEqual([]);
    expect(h.call.state).toMatchObject({ phase: "beendet", minuten: null, retryEnd: false, ausstehend: true });
    expect(endRequests(h)).toEqual([{ url: "/api/voice-agents/jarvis/session/end", body: JSON.stringify({ conversationId: "conv_1" }), keepalive: false }]);
    await expectHeldUntilTokenExpiry(h, "conv_1");
    await expectRestart(h, 0);
  });

  test("Löschen der Freigabe scheitert: „Noch einmal auflegen“, die Wiederholung gelingt", async () => {
    const h = await harness("jarvis");
    await h.call.start();
    const [file] = webCallFiles(h.w, "jarvis");
    const entry = join(h.w.paths.dataDir, "jarvis", "web-calls", file);
    renameSync(entry, `${entry}.weg`);
    mkdirSync(entry);
    await h.call.hangUp();
    expect(h.call.state).toMatchObject({ phase: "fehler", retryEnd: true });
    expect(h.call.state.text).toContain("Freigabe");
    expect(page.voiceAgentButtons(h.call.state, { bereit: true })).toMatchObject({ talk: null, hangUp: page.VOICE_AGENT_TEXT.hangUpAgain });
    // Sprechen ist gesperrt, solange das Ende nicht gemeldet ist
    await h.call.start();
    expect(h.requests.filter((r) => r.url.endsWith("/session"))).toHaveLength(1);
    rmdirSync(entry);
    renameSync(`${entry}.weg`, entry);
    await h.call.hangUp();
    expect(h.call.state).toMatchObject({ phase: "beendet", retryEnd: false });
    expect(h.sdk.sessions[0].ended).toBe(1);
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(false);
    expect(webCallFiles(h.w, "jarvis")).toEqual([]);
  });

  test("Seite verlassen (pagehide): Verbindung getrennt, Ende mit keepalive gemeldet", async () => {
    const h = await harness("jarvis");
    await h.call.start();
    await h.call.leave();
    expect(h.sdk.sessions[0].ended).toBe(1);
    expect(h.requests.at(-1)).toEqual({ url: "/api/voice-agents/jarvis/session/end", body: JSON.stringify({ conversationId: "conv_1" }), keepalive: true });
    for (let i = 0; i < 100 && (await info(h, "jarvis")).laufend !== null; i++) await Bun.sleep(5);
    expect((await info(h, "jarvis")).laufend).toBeNull();
    // Ohne Gespräch tut Verlassen nichts
    const count = h.requests.length;
    h.call.leave();
    expect(h.requests).toHaveLength(count);
  });
});

describe("Gesprächsseite: Verlassen während des Starts", () => {
  test("während des Tokenabrufs: das spät gelieferte Token wird sofort beendet, kein SDK, Neustart möglich", async () => {
    const h = await harness("jarvis");
    const provider = gate();
    h.w.replies.push({ warte: provider.promise });
    const pending = h.call.start();
    await until(() => h.w.calls.length === 1);
    h.call.leave();
    // Noch keine Gesprächs-ID: Verlassen meldet nichts, der Start gibt auf
    expect(endRequests(h)).toEqual([]);
    expect(h.call.state.phase).toBe("beende");
    provider.release();
    await pending;
    expect(h.sdkLoads).toBe(0);
    expect(h.sdk.started).toEqual([]);
    expect(h.call.state.phase).toBe("beendet");
    expect(endRequests(h)).toEqual([{ url: "/api/voice-agents/jarvis/session/end", body: JSON.stringify({ conversationId: "conv_1" }), keepalive: true }]);
    await expectHeldUntilTokenExpiry(h, "conv_1");
    await expectRestart(h, 0);
  });

  test("während des SDK-Ladens: Ende sofort gemeldet, danach kein SDK-Start, Neustart möglich", async () => {
    const h = await harness("jarvis");
    const sdkReady = gate();
    h.sdkHold = sdkReady.promise;
    const pending = h.call.start();
    await until(() => h.sdkLoads === 1);
    await h.call.leave();
    expect(endRequests(h)).toEqual([{ url: "/api/voice-agents/jarvis/session/end", body: JSON.stringify({ conversationId: "conv_1" }), keepalive: true }]);
    expect(h.call.state.phase).toBe("beendet");
    sdkReady.release();
    await pending;
    expect(h.sdk.started).toEqual([]);
    expect(h.call.state.phase).toBe("beendet");
    expect(endRequests(h)).toHaveLength(1);
    await expectHeldUntilTokenExpiry(h, "conv_1");
    await expectRestart(h, 0);
  });

  test("während des Verbindungsaufbaus: Platz bleibt bis zum Schließen der verspäteten Sitzung belegt", async () => {
    const h = await harness("jarvis");
    const connected = gate();
    h.sdk.holds.push(connected.promise);
    const pending = h.call.start();
    await until(() => h.sdk.started.length === 1);
    h.call.leave();
    expect(endRequests(h)).toEqual([]);
    expect(h.call.state.phase).toBe("beende");
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
    expect((await info(h, "jarvis")).minuten.verbraucht).toBe(12);
    // Kein Neustart, solange die alte Sitzung noch unterwegs ist
    await h.call.start();
    expect(h.sdk.started).toHaveLength(1);
    expect((await h.ctx.api("/api/voice-agents/jarvis/session", "POST", {})).status).toBe(409);
    // Jetzt kommt die alte Sitzung: erst trennen, dann Platz und Minuten freigeben
    connected.release();
    await pending;
    const late = h.sdk.sessions[0];
    expect(late.ended).toBe(1);
    await expectEnded(h, "conv_1");
    await expectRestart(h, 1);
    const current = h.sdk.sessions[1];
    late.options.onDisconnect({ reason: "agent" });
    late.options.onModeChange({ mode: "speaking" });
    expect(current.ended).toBe(0);
    expect(h.call.state).toMatchObject({ phase: "verbunden", mode: "hoert" });
    expect(endRequests(h)).toHaveLength(1);
    expect(await verify(h.w, "jarvis", "conv_2")).toBe(true);
    expect((await info(h, "jarvis")).laufend).not.toBeNull();
    // Das neue Gespräch lässt sich normal beenden
    await h.call.hangUp();
    expect(current.ended).toBe(1);
    expect(h.call.state).toMatchObject({ phase: "beendet", minuten: 1 });
    expect(await verify(h.w, "jarvis", "conv_2")).toBe(false);
  });
});

describe("Regression #494: ein Besitzer vom Start bis zum bestätigten Ende", () => {
  test("verzögertes endSession, Auflegen, Verlassen und Neustart: keine frühe Freigabe und kein Ende des Folgegesprächs", async () => {
    const h = await harness("jarvis");
    await h.call.start();
    const first = h.sdk.sessions[0];
    const closed = gate();
    first.endHolds.push(closed.promise);
    const ending = h.call.hangUp();
    await until(() => first.endCalls === 1);
    const leaving = h.call.leave();
    const repeated = h.call.hangUp();
    try {
      await h.call.start();
      expect(first.ended).toBe(0);
      expect(endRequests(h)).toEqual([]);
      expect(h.w.calls).toHaveLength(1);
      expect(h.call.state.phase).toBe("beende");
      expect(page.voiceAgentButtons(h.call.state, { bereit: true })).toMatchObject({ talk: null, hangUp: null });
      expect((await h.ctx.api("/api/voice-agents/jarvis/session", "POST", {})).status).toBe(409);
      expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
      expect((await info(h, "jarvis")).minuten.verbraucht).toBe(12);
      // Der Anbieter meldet ganze Sekunden: 121 Sekunden sind drei angefangene Minuten
      h.w.clock.now += 2 * 60_000 + 1_000;
    } finally {
      closed.release();
      await Promise.all([ending, leaving, repeated]);
    }
    expect(first.endCalls).toBe(1);
    expect(first.ended).toBe(1);
    expect(endRequests(h)).toEqual([{ url: "/api/voice-agents/jarvis/session/end", body: JSON.stringify({ conversationId: "conv_1" }), keepalive: true }]);
    expect(h.call.state).toMatchObject({ phase: "beendet", minuten: 3 });
    await expectRestart(h, 1);
    // Beliebig späte Rückrufe aus Gespräch 1 gehören weiter nur zu Gespräch 1.
    first.options.onDisconnect({ reason: "agent" });
    first.options.onModeChange({ mode: "speaking" });
    expect(h.call.state).toMatchObject({ phase: "verbunden", mode: "hoert" });
    expect(h.sdk.sessions[1].ended).toBe(0);
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(false);
    expect(await verify(h.w, "jarvis", "conv_2")).toBe(true);
    expect((await readWebSessions("jarvis", h.w.paths)).sitzungen.map((s) => [s.gespraech, s.ende !== null, s.minuten])).toEqual([
      ["conv_1", true, 3], ["conv_2", false, 12],
    ]);
    await h.call.hangUp();
    expect(JSON.parse(endRequests(h).at(-1)!.body).conversationId).toBe("conv_2");
  });

  for (const delay of ["Antwort", "JSON", "Fehler"] as const) {
    test(`verspätete Ende-${delay}: Rückkehr wartet auf denselben Abschluss, Wiederholung trifft nur das eigene Gespräch`, async () => {
      const h = await harness("jarvis");
      await h.call.start();
      const replied = gate();
      h.endReplies.push(async (response) => {
        if (delay === "JSON") {
          const body = await response.text();
          return new Response(new ReadableStream({
            async start(controller) {
              await replied.promise;
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }));
        }
        await replied.promise;
        return delay === "Fehler" ? Response.json({ error: "Antwort verloren" }, { status: 503 }) : response;
      });
      const ending = h.call.hangUp();
      await expectEnded(h, "conv_1");
      const leaving = h.call.leave();
      try {
        await h.call.start();
        expect(h.sdk.sessions[0].ended).toBe(1);
        expect(h.w.calls).toHaveLength(1);
        expect(endRequests(h)).toHaveLength(1);
        expect(h.call.state.phase).toBe("beende");
      } finally {
        replied.release();
        await Promise.all([ending, leaving]);
      }
      if (delay === "Fehler") {
        expect(h.call.state.retryEnd).toBe(true);
        // Der Server hat das Ende bereits verbucht: 404 bei der Wiederholung
        // ist Erfolg, ohne noch einmal endSession aufzurufen.
        await h.call.hangUp();
        expect(h.sdk.sessions[0].endCalls).toBe(1);
      }
      await expectRestart(h, 1);
      h.sdk.sessions[0].options.onDisconnect({ reason: "agent" });
      expect(h.call.state.phase).toBe("verbunden");
      expect(await verify(h.w, "jarvis", "conv_2")).toBe(true);
      expect((await info(h, "jarvis")).minuten.verbraucht).toBe(13);
      await h.call.hangUp();
      expect(h.call.state.phase).toBe("beendet");
    });
  }

  for (const kind of ["bruecke", "anbieter"] as const) {
    for (const source of ["409", "Zustandsroute"] as const) {
      test(`zwei Clients, ${kind}, ${source}: zweiter Tab beendet keine fremde Verbindung und bucht keine Minuten zurück`, async () => {
        const first = await harness("jarvis", "ok", kind === "bruecke" ? bridge : () => {});
        const second = await harness("jarvis", "ok", () => {}, first);
        await first.call.start();
        if (source === "409") await second.call.start();
        else {
          const data = await info(second, "jarvis");
          expect(data.laufend).not.toBeNull();
          expect(JSON.stringify(data)).not.toContain("conv_1");
          second.call.markRunning();
        }
        await second.call.hangUp();
        await second.call.start();
        expect(first.sdk.sessions[0].ended).toBe(0);
        expect(second.sdk.started).toEqual([]);
        expect(endRequests(second)).toEqual([]);
        expect(page.voiceAgentButtons(second.call.state, { bereit: true })).toMatchObject({ talk: null, hangUp: null });
        // Auch die API bietet kein blindes Ende mehr, selbst für alte Clients.
        expect((await second.ctx.api("/api/voice-agents/jarvis/session/end", "POST", {})).status).toBe(400);
        expect((await second.ctx.api("/api/voice-agents/jarvis/session/end", "POST", { conversationId: "conv_fremd" })).status).toBe(404);
        expect((await second.ctx.api("/api/voice-agents/jarvis/session", "POST", {})).status).toBe(409);
        expect((await info(first, "jarvis")).minuten.verbraucht).toBe(12);
        expect(await verify(first.w, "jarvis", "conv_1")).toBe(kind === "bruecke");
        expect((await readWebSessions("jarvis", first.w.paths)).sitzungen[0].ende).toBeNull();
        // Nur der Besitzer trennt. Danach kann ein neu geladener zweiter Tab starten.
        await first.call.hangUp();
        const reloaded = await harness("jarvis", "ok", () => {}, first);
        await reloaded.call.start();
        expect(reloaded.call.state.phase).toBe("verbunden");
        expect(tokenName(reloaded.sdk.started[0].conversationToken)).toBe("gespraechstoken-2");
        expect([...first.sdk.sessions, ...second.sdk.sessions, ...reloaded.sdk.sessions].filter((s) => s.ended === 0)).toHaveLength(1);
        expect((await info(first, "jarvis")).minuten.verbraucht).toBe(13);
        expect(await verify(first.w, "jarvis", "conv_1")).toBe(false);
        expect(await verify(first.w, "jarvis", "conv_2")).toBe(kind === "bruecke");
        await reloaded.call.hangUp();
      });
    }
  }

  for (const failure of ["synchron", "asynchron", "nach onDisconnect"] as const) {
    test(`endSession scheitert ${failure}: kein gemeldetes Ende, volle Reservierung, Trennen wiederholbar`, async () => {
      const h = await harness("jarvis");
      await h.call.start();
      const session = h.sdk.sessions[0];
      const close = session.endSession;
      session.endSession = () => {
        if (failure === "synchron") throw new Error("Trennen gescheitert");
        if (failure === "nach onDisconnect") session.options.onDisconnect({ reason: "error" });
        return Promise.reject(new Error("Trennen gescheitert"));
      };
      await h.call.hangUp();
      await h.call.start();
      expect(session.ended).toBe(0);
      expect(endRequests(h)).toEqual([]);
      expect(h.call.state).toMatchObject({ phase: "fehler", retryEnd: true });
      expect(h.w.calls).toHaveLength(1);
      expect((await h.ctx.api("/api/voice-agents/jarvis/session", "POST", {})).status).toBe(409);
      expect((await info(h, "jarvis")).minuten.verbraucht).toBe(12);
      expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
      session.endSession = close;
      h.w.clock.now += 2 * 60_000;
      await h.call.hangUp();
      expect(session.ended).toBe(1);
      expect(h.call.state).toMatchObject({ phase: "beendet", minuten: 2, retryEnd: false });
      expect(await verify(h.w, "jarvis", "conv_1")).toBe(false);
      await expectRestart(h, 1);
      expect((await info(h, "jarvis")).minuten.verbraucht).toBe(14);
    });
  }

  test("onDisconnect vor Rückgabe von startSession: kein verbunden mehr, späte Sitzung erst schließen, dann buchen", async () => {
    const h = await harness("jarvis");
    const connect = h.sdk.sdk.Conversation.startSession;
    h.sdk.sdk.Conversation.startSession = async (options: any) => {
      const session = await connect(options);
      options.onDisconnect({ reason: "agent" });
      return session;
    };
    await h.call.start();
    expect(h.sdk.sessions[0].ended).toBe(1);
    expect(h.states.some((s) => s.phase === "verbunden")).toBe(false);
    await expectEnded(h, "conv_1");
    h.sdk.sdk.Conversation.startSession = connect;
    await expectRestart(h, 1);
  });

  for (const response of ["Zustand", "Anmeldung"] as const) {
    test(`verspätete Antwort (${response}) nach dem Ende überschreibt keinen späteren Seitenzustand`, async () => {
      const h = await harness("jarvis");
      const delayed = gate();
      const captured = gate();
      let infoRequests = 0;
      let mounted = false;
      const elements = Object.fromEntries(["agent-name", "agent-status", "agent-minutes", "agent-talk", "agent-hangup"].map((id) => {
        const listeners: Record<string, () => Promise<void>> = {};
        return [id, { textContent: "", hidden: false, listeners, addEventListener: (name: string, listener: () => Promise<void>) => { listeners[name] = listener; } }];
      }));
      const doc = {
        title: "Sprachagent · tybo", body: { dataset: {} },
        getElementById: (id: string) => mounted ? elements[id] : null,
      };
      const win = {
        location: { pathname: "/sa/jarvis", href: "/sa/jarvis" },
        ElevenLabsClient: h.sdk.sdk, addEventListener: () => {},
        navigator: {
          mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
          // Ohne Web Locks startet die Seite kein Gespräch (Issue #495)
          locks: { request: (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => Promise.resolve(callback({})) },
        },
      };
      const doFetch = async (url: string, init: any) => {
        const res = await fetch(`${h.ctx.origin}${url}`, { ...init, headers: { ...init.headers, cookie: h.ctx.cookie, origin: h.ctx.origin } });
        if (url === "/api/voice-agents/jarvis" && ++infoRequests === 2) {
          const body = await res.text();
          captured.release();
          await delayed.promise;
          return response === "Anmeldung" ? new Response(null, { status: 401 }) : new Response(body);
        }
        return res;
      };
      const mount = new Function("window", "document", "fetch", "setTimeout", "clearTimeout", `${SOURCE}\nreturn startVoiceAgentPage;`)(win, doc, doFetch, pageSetTimeout, pageClearTimeout);
      mounted = true;
      await mount();
      await elements["agent-talk"].listeners.click();
      await elements["agent-hangup"].listeners.click();
      await captured.promise;
      try {
        await elements["agent-talk"].listeners.click();
        await elements["agent-hangup"].listeners.click();
        await until(() => elements["agent-minutes"].textContent.includes("2 von 300"));
        expect(elements["agent-minutes"].textContent).toContain("2 von 300");
      } finally {
        delayed.release();
      }
      // Fortsetzungen des alten GET dürfen weder Minuten noch Anmeldung ändern.
      await Bun.sleep(10);
      expect(elements["agent-minutes"].textContent).toContain("2 von 300");
      expect(win.location.href).toBe("/sa/jarvis");
      expect((await info(h, "jarvis")).minuten.verbraucht).toBe(2);
      expect(h.sdk.sessions.every((s) => s.ended === 1)).toBe(true);
    });
  }
});

describe("Gesprächsseite: SDK laden", () => {
  test("lädt /vendor/elevenlabs/lib.iife.js einmal per Script-Element; nach einem Fehler neu", async () => {
    const appended: any[] = [];
    const win: any = {};
    const doc = {
      createElement: () => ({}) as any,
      head: { appendChild: (el: any) => appended.push(el) },
    };
    const load = page.createVoiceAgentSdkLoader(win, doc);
    const first = load();
    const second = load();
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe("/vendor/elevenlabs/lib.iife.js");
    appended[0].onerror();
    await expect(first).rejects.toThrow("SDK nicht ladbar");
    await expect(second).rejects.toThrow("SDK nicht ladbar");
    const third = load();
    expect(appended).toHaveLength(2);
    win.ElevenLabsClient = { Conversation: {} };
    appended[1].onload();
    expect(await third).toBe(win.ElevenLabsClient);
    // Steht es schon im Fenster, wird nichts geladen
    expect(await load()).toBe(win.ElevenLabsClient);
    expect(appended).toHaveLength(2);
  });
});

/**
 * Das eingecheckte SDK (lib.iife.js) unverändert geladen; der Test reicht nur
 * den LiveKit-Raum und zwei Helfer zusätzlich heraus, die das Paket nicht
 * exportiert. VoiceConversation, WebRTCConnection und Room sind echt, nur der
 * Transport (engine.close) wartet auf den Test: So endet endSession() wie im
 * Browser, bevor der Raum getrennt ist.
 */
const VENDOR = await readFile(join(publicDir, "vendor", "elevenlabs", "lib.iife.js"), "utf8");
const VENDOR_END = "\treturn exports;\n})({});";
const realLib = (() => {
  if (!VENDOR.includes(VENDOR_END)) throw new Error("lib.iife.js: Ende der IIFE nicht gefunden");
  const source = VENDOR.replace(VENDOR_END, "\texports.__Room = Room; exports.__ConnectionState = ConnectionState; exports.__parseFormat = parseFormat;\n" + VENDOR_END);
  return new Function(`${source}\nreturn ElevenLabsClient;`)() as any;
})();

interface RealCall {
  conversation: any;
  room: any;
  /** Erfüllt der Test, erst dann ist der Transport zu und der Raum getrennt */
  transport: ReturnType<typeof gate>;
  closes: number;
}

/** SDK-Ersatz mit echten SDK-Objekten: startSession baut, was das SDK nach room.connect hat */
function realSdk() {
  const calls: RealCall[] = [];
  const started: any[] = [];
  const holds: Promise<void>[] = [];
  const sdk = {
    Conversation: {
      async startSession(options: any) {
        started.push(options);
        const hold = holds.shift();
        if (hold) await hold;
        const room = new realLib.__Room();
        const call = { room, transport: gate(), closes: 0 } as RealCall;
        room.state = realLib.__ConnectionState.Connected;
        openProviderRoom(options.conversationToken, room);
        room.engine = {
          client: { isDisconnected: false, sendLeave: async () => {} },
          close: async () => {
            call.closes++;
            await call.transport.promise;
          },
          removeAllListeners() {},
          on() {
            return this;
          },
        };
        const pcm = realLib.__parseFormat("pcm_48000");
        const connection = new realLib.WebRTCConnection(room, `conv_${calls.length + 1}`, pcm, pcm, {});
        connection.isConnected = true;
        const conversation = new realLib.VoiceConversation(options, connection, connection.input, connection.output, null, async () => {});
        options.onConversationCreated?.(conversation);
        conversation.markConnected();
        call.conversation = conversation;
        calls.push(call);
        return conversation;
      },
    },
  };
  return { sdk, calls, started, holds, sessions: [] as FakeSession[] };
}

const openRooms = (...sdks: ReturnType<typeof realSdk>[]) => sdks.flatMap((s) => s.calls).filter((c) => c.room.state !== "disconnected").length;

describe("Regression #494: Ende erst nach dem getrennten LiveKit-Raum (eingechecktes SDK)", () => {
  for (const how of ["Auflegen", "Agent legt auf", "Verlassen"] as const) {
    test(`${how}: endSession und onDisconnect des SDK kommen vor dem Transport; Platz, Freigabe und Minuten erst danach`, async () => {
      const h = await harness("jarvis");
      const real = realSdk();
      h.sdk = real as any;
      await h.call.start();
      expect(h.call.state.phase).toBe("verbunden");
      const [first] = real.calls;
      const disconnects: any[] = [];
      const onDisconnect = first.conversation.options.onDisconnect;
      first.conversation.options.onDisconnect = (details: any) => {
        disconnects.push(details);
        onDisconnect(details);
      };
      const ending = how === "Auflegen" ? h.call.hangUp() : how === "Verlassen" ? h.call.leave() : (first.conversation.connection.disconnect({ reason: "agent" }), null);
      // Das SDK hält das Gespräch für beendet, der Raum ist aber noch verbunden
      await until(() => first.conversation.status === "disconnected" && disconnects.length === 1 && first.closes === 1);
      expect(first.conversation.status).toBe("disconnected");
      expect(disconnects).toHaveLength(1);
      expect(first.room.state).toBe("connected");
      await Bun.sleep(20);
      expect(endRequests(h)).toEqual([]);
      expect(h.call.state.phase).toBe("beende");
      expect((await info(h, "jarvis")).laufend).not.toBeNull();
      expect((await info(h, "jarvis")).minuten.verbraucht).toBe(12);
      expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
      // Ein zweiter Client bekommt keinen Platz, solange der Raum offen ist
      expect((await h.ctx.api("/api/voice-agents/jarvis/session", "POST", {})).status).toBe(409);
      expect(real.started).toHaveLength(1);
      // Transport zu: erst jetzt Ende, Freigabe weg, eine Minute gebucht
      first.transport.release();
      if (ending) await ending;
      await until(() => h.call.state.phase === "beendet");
      expect(first.room.state).toBe("disconnected");
      expect(endRequests(h)).toEqual([{ url: "/api/voice-agents/jarvis/session/end", body: JSON.stringify({ conversationId: "conv_1" }), keepalive: how === "Verlassen" }]);
      await expectEnded(h, "conv_1");
      // Neustart mit neuem Raum, der alte bleibt zu
      await h.call.start();
      expect(h.call.state.phase).toBe("verbunden");
      expect(tokenName(real.started.at(-1).conversationToken)).toBe("gespraechstoken-2");
      expect(openRooms(real)).toBe(1);
      expect(await verify(h.w, "jarvis", "conv_2")).toBe(true);
    });
  }

  test("Trennen nie bestätigt: nach der Zeitgrenze „Noch einmal auflegen“, Platz, Freigabe und volle Minuten bleiben; die Wiederholung wartet erneut", async () => {
    const h = await harness("jarvis");
    const real = realSdk();
    h.sdk = real as any;
    await h.call.start();
    const [first] = real.calls;
    const ending = h.call.hangUp();
    await until(() => first.conversation.status === "disconnected" && first.closes === 1);
    // Zeitgrenze des Trennens läuft ab, der Raum ist noch verbunden
    await until(() => h.timers.some((t) => !t.cancelled));
    expect(fireTimers(h)).toBeGreaterThan(0);
    await ending;
    expect(h.call.state).toMatchObject({ phase: "fehler", text: page.VOICE_AGENT_TEXT.disconnectFailed, retryEnd: true });
    expect(page.voiceAgentButtons(h.call.state, { bereit: true })).toMatchObject({ talk: null, hangUp: page.VOICE_AGENT_TEXT.hangUpAgain });
    expect(endRequests(h)).toEqual([]);
    expect((await info(h, "jarvis")).laufend).not.toBeNull();
    expect((await info(h, "jarvis")).minuten.verbraucht).toBe(12);
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
    // Sprechen bleibt gesperrt
    await h.call.start();
    expect(real.started).toHaveLength(1);
    // Noch einmal auflegen: wartet wieder auf den Raum, meldet erst danach
    const again = h.call.hangUp();
    await Bun.sleep(20);
    expect(endRequests(h)).toEqual([]);
    first.transport.release();
    await again;
    expect(first.room.state).toBe("disconnected");
    expect(h.call.state).toMatchObject({ phase: "beendet", retryEnd: false });
    await expectEnded(h, "conv_1");
  });

  test("Sitzung ohne LiveKit-Raum gilt nie als getrennt: kein Ende gemeldet", async () => {
    const h = await harness("jarvis");
    await h.call.start();
    const [session] = h.sdk.sessions;
    (session as any).connection = {};
    await h.call.hangUp();
    expect(session.ended).toBe(1);
    expect(h.call.state).toMatchObject({ phase: "fehler", text: page.VOICE_AGENT_TEXT.disconnectFailed, retryEnd: true });
    expect(endRequests(h)).toEqual([]);
    expect((await info(h, "jarvis")).laufend).not.toBeNull();
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
  });
});

describe("Regression #494: Sperre, Freigabe und Minuten nach ElevenLabs (Prüfrunde 5)", () => {
  const short = (raw: any) => {
    bridge(raw);
    raw.zugang.maxMinuten = 1;
  };
  /** Alte Ablaufgrenze vor Eskalation 4: Aufbau-Frist (4) plus maxMinuten (1) plus Zuschlag (1) */
  const OLD_LIMIT = START + 6 * 60_000;

  test("Startantwort ohne Aufbau-Frist; Freigabe und Reservierung decken Tokenablauf plus maxMinuten plus Zuschlag", async () => {
    const h = await harness("jarvis", "ok", short);
    const res = await h.ctx.api("/api/voice-agents/jarvis/session", "POST", {});
    const body = await res.json();
    expect(body.aufbauMs).toBeUndefined();
    expect(body.expiresInSec).toBe(WEB_SESSION_TOKEN_MS / 1000);
    const [session] = (await readWebSessions("jarvis", h.w.paths)).sitzungen;
    expect(session).toMatchObject({ tokenBis: START + WEB_SESSION_TOKEN_MS, bis: START + WEB_SESSION_TOKEN_MS + 60_000 + WEB_SESSION_SLACK_MS });
    h.w.clock.now = session.bis - 1;
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
    h.w.clock.now = session.bis;
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(false);
    // Die längste harte Grenze passt unter die Höchstdauer der Freigabe
    expect(60 * 60_000 + MAX_MINUTES_PER_CALL * 60_000 + WEB_SESSION_SLACK_MS).toBeLessThanOrEqual(WEB_CALL_MAX_TTL_MS);
    // Die Meldung „verbunden“ gibt es nicht mehr
    expect((await h.ctx.api("/api/voice-agents/jarvis/session/connected", "POST", { conversationId: "conv_1" })).status).toBe(404);
  });

  test("[P1] SDK-Aufbau scheitert vor onConversationCreated, Raum bleibt verbunden: Ende gemeldet, aber Platz, Freigabe und volle Minuten bleiben; kein zweiter Raum, auch nicht beim Neustart", async () => {
    const a = await harness("jarvis", "ok", short);
    const roomA = fakeRoom();
    // Wie im SDK: Raum verbunden, sendRequiredMessage scheitert, room.disconnect scheitert auch
    roomA.disconnect = () => {
      roomA.disconnectCalls++;
      return Promise.reject(new Error("disconnect failed"));
    };
    a.sdk.sdk.Conversation.startSession = async (options: any) => {
      a.sdk.started.push(options);
      openProviderRoom(options.conversationToken, roomA);
      await roomA.disconnect().catch(() => {});
      throw new Error("sendRequiredMessage failed");
    };
    await a.call.start();
    expect(roomA.state).toBe("connected");
    expect(a.call.state).toMatchObject({ phase: "fehler", retryEnd: false, ausstehend: true });
    expect(a.call.state.text).toContain(VOICE_AGENT_SESSION_TEXT.endPending);
    // Die Seite meldet das Ende (sie kennt keine Sitzung), der Server glaubt ihr nicht
    expect(endRequests(a)).toHaveLength(1);
    expect(await verify(a.w, "jarvis", "conv_1")).toBe(true);
    expect((await info(a, "jarvis")).laufend).not.toBeNull();
    expect((await readWebSessions("jarvis", a.w.paths)).sitzungen.map((s) => [s.gespraech, s.ende, s.minuten])).toEqual([["conv_1", null, 1]]);
    // Neustart im selben Tab: Versuch und Sperre bleiben, solange das Ende aussteht (Issue #495)
    a.sdk = fakeSdk("ok");
    expect(a.call.busy).toBe(true);
    const before = a.requests.length;
    await a.call.start();
    expect(a.requests).toHaveLength(before);
    expect(a.call.state).toMatchObject({ phase: "fehler", ausstehend: true });
    expect(page.voiceAgentButtons(a.call.state, { bereit: true }).talk).toBeNull();
    // Die Nachfrage der Seite ändert daran nichts, solange der Raum laut Anbieter verbunden ist
    expect(fireTimers(a, PENDING_CHECK_MS)).toBe(1);
    await until(() => endRequests(a).length === 2 && a.call.state.ausstehend && a.timers.some((t) => !t.cancelled && t.ms === PENDING_CHECK_MS));
    expect(endRequests(a)).toHaveLength(2);
    expect(a.call.busy).toBe(true);
    expect(a.call.state.ausstehend).toBe(true);
    // Ein zweiter Client: 409, kein zweites Token, kein zweiter Raum
    const b = await harness("jarvis", "ok", short, a);
    await b.call.start();
    expect(b.call.state.phase).toBe("laeuft");
    // Auch nach der alten Ablaufgrenze und nach Tokenablauf: der Raum ist laut Anbieter verbunden
    for (const at of [OLD_LIMIT, START + WEB_SESSION_TOKEN_MS + WEB_SESSION_SLACK_MS]) {
      a.w.clock.now = at;
      expect((await a.ctx.api("/api/voice-agents/jarvis/session", "POST", {})).status).toBe(409);
      expect(await verify(a.w, "jarvis", "conv_1")).toBe(true);
    }
    expect(a.w.calls).toHaveLength(1);
    expect(a.sdk.started).toEqual([]);
    expect(b.sdk.started).toEqual([]);
    expect(providerOpen(a.w)).toBe(1);
    // ElevenLabs beendet das Gespräch (nach maxMinuten): erst jetzt frei, gebucht wird die Dauer
    a.w.clock.now = START + 60_000;
    roomA.state = "disconnected";
    a.w.clock.now = START + WEB_SESSION_TOKEN_MS + WEB_SESSION_SLACK_MS;
    const c = await harness("jarvis", "ok", short, a);
    await c.call.start();
    expect(c.call.state.phase).toBe("verbunden");
    expect(providerOpen(a.w)).toBe(1);
    expect(await verify(a.w, "jarvis", "conv_1")).toBe(false);
    expect(await verify(a.w, "jarvis", "conv_2")).toBe(true);
    expect((await readWebSessions("jarvis", a.w.paths)).sitzungen.map((s) => [s.gespraech, s.ende !== null, s.minuten])).toEqual([
      ["conv_1", true, 1],
      ["conv_2", false, 1],
    ]);
  });

  test("[P1] dasselbe mit maxMinuten 12: kein Rückbuchen auf eine Minute, solange der Raum verbunden ist; danach 12", async () => {
    const h = await harness("jarvis");
    const room = fakeRoom();
    room.disconnect = () => Promise.reject(new Error("disconnect failed"));
    h.sdk.sdk.Conversation.startSession = async (options: any) => {
      openProviderRoom(options.conversationToken, room);
      throw new Error("sendRequiredMessage failed");
    };
    await h.call.start();
    expect(endRequests(h)).toHaveLength(1);
    expect((await info(h, "jarvis")).minuten.verbraucht).toBe(12);
    expect(await verify(h.w, "jarvis", "conv_1")).toBe(true);
    // Zwölf Minuten später endet es beim Anbieter (max_duration_seconds)
    h.w.clock.now += 12 * 60_000;
    room.state = "disconnected";
    await expectEnded(h, "conv_1", 12);
  });

  test("[P2] Aufbau kehrt erst nach der alten Ablaufgrenze zurück (maxMinuten 1): zweiter Client bleibt gesperrt, bis ElevenLabs das Ende meldet; nie zwei Räume, Freigabe nie mitten im Gespräch weg", async () => {
    const a = await harness("jarvis", "ok", short);
    const realA = realSdk();
    a.sdk = realA as any;
    const late = gate();
    realA.holds.push(late.promise);
    const pendingA = a.call.start();
    await until(() => realA.started.length === 1);
    // Kein Aufbau-Zeitgeber mehr: Die Seite kann startSession ohnehin nicht abbrechen
    expect(a.timers).toEqual([]);
    // Minute 4 und 6: B will sprechen; das Token von A kann noch verbinden
    const realB = realSdk();
    for (const at of [START + 4 * 60_000, OLD_LIMIT]) {
      a.w.clock.now = at;
      // Jedes Mal ein frisch geladener Tab von B
      const tab = await harness("jarvis", "ok", short, a);
      tab.sdk = realB as any;
      await tab.call.start();
      expect(tab.call.state.phase).toBe("laeuft");
      expect(realB.started).toEqual([]);
      expect(await verify(a.w, "jarvis", "conv_1")).toBe(true);
    }
    // Minute 6,5: Der Aufbau von A kehrt zurück, A spricht
    a.w.clock.now = START + 6.5 * 60_000;
    late.release();
    await pendingA;
    expect(a.call.state.phase).toBe("verbunden");
    expect(openRooms(realA, realB)).toBe(1);
    expect(await verify(a.w, "jarvis", "conv_1")).toBe(true);
    // Minute 7: B weiter gesperrt, das Gespräch von A läuft laut Anbieter
    a.w.clock.now = START + 7 * 60_000;
    const c = await harness("jarvis", "ok", short, a);
    const realC = realSdk();
    c.sdk = realC as any;
    await c.call.start();
    expect(c.call.state.phase).toBe("laeuft");
    expect(realC.started).toEqual([]);
    expect(openRooms(realA, realB, realC)).toBe(1);
    // Minute 7,5: ElevenLabs beendet nach maxMinuten (eine Minute ab 6,5); A trennt und meldet
    a.w.clock.now = START + 7.5 * 60_000;
    const ending = a.call.hangUp();
    realA.calls[0].transport.release();
    await ending;
    expect(a.call.state).toMatchObject({ phase: "beendet", minuten: 1, ausstehend: false });
    // Jetzt erst ein neuer Client
    const d = await harness("jarvis", "ok", short, a);
    const realD = realSdk();
    d.sdk = realD as any;
    await d.call.start();
    expect(d.call.state.phase).toBe("verbunden");
    expect(openRooms(realA, realB, realC, realD)).toBe(1);
    expect(await verify(a.w, "jarvis", "conv_1")).toBe(false);
    expect(await verify(a.w, "jarvis", "conv_2")).toBe(true);
  });

  test("zwei Clients über die Ablaufgrenze mit ausstehender Trennung: B erst, wenn der Raum von A laut ElevenLabs zu ist", async () => {
    const a = await harness("jarvis", "ok", short);
    const realA = realSdk();
    a.sdk = realA as any;
    await a.call.start();
    expect(a.call.state.phase).toBe("verbunden");
    const [first] = realA.calls;
    // A legt auf, der Transport hängt: Raum bleibt verbunden
    const ending = a.call.hangUp();
    await until(() => first.closes === 1);
    const b = await harness("jarvis", "ok", short, a);
    const realB = realSdk();
    b.sdk = realB as any;
    for (const at of [OLD_LIMIT, START + 10 * 60_000]) {
      a.w.clock.now = at;
      const res = await b.ctx.api("/api/voice-agents/jarvis/session", "POST", {});
      expect(res.status).toBe(409);
      expect(await verify(a.w, "jarvis", "conv_1")).toBe(true);
      expect(endRequests(a)).toEqual([]);
    }
    // Die Seite gibt das Warten auf (Zeitgrenze): kein Ende gemeldet, B weiter gesperrt
    expect(fireTimers(a)).toBeGreaterThan(0);
    await ending;
    expect(a.call.state).toMatchObject({ phase: "fehler", retryEnd: true });
    await b.call.start();
    expect(b.call.state.phase).toBe("laeuft");
    expect(realB.started).toEqual([]);
    // Selbst eine Endemeldung trotz offenem Raum (alter Client) gibt nichts frei
    const early = await a.ctx.api("/api/voice-agents/jarvis/session/end", "POST", { conversationId: "conv_1" });
    expect(early.status).toBe(202);
    expect(await verify(a.w, "jarvis", "conv_1")).toBe(true);
    expect((await info(a, "jarvis")).minuten.verbraucht).toBe(1);
    // Transport zu: A legt noch einmal auf, ElevenLabs bestätigt, B darf
    first.transport.release();
    a.w.clock.now = START + 11 * 60_000;
    await a.call.hangUp();
    expect(a.call.state).toMatchObject({ phase: "beendet", retryEnd: false });
    expect(first.room.state).toBe("disconnected");
    const c = await harness("jarvis", "ok", short, a);
    const realC = realSdk();
    c.sdk = realC as any;
    await c.call.start();
    expect(c.call.state.phase).toBe("verbunden");
    expect(openRooms(realA, realB, realC)).toBe(1);
  });

  test("Mikrofon vor dem Token: Warten auf die Erlaubnis belegt keinen Platz; Auflegen und Ablehnen ohne Reservierung", async () => {
    const h = await harness("jarvis", "ok", short);
    const allowed = gate();
    h.micHold = allowed.promise;
    const pending = h.call.start();
    await Bun.sleep(10);
    expect(h.requests).toEqual([]);
    expect((await info(h, "jarvis")).laufend).toBeNull();
    await h.call.hangUp();
    expect(h.call.state.phase).toBe("beendet");
    allowed.release();
    await pending;
    expect(h.requests).toEqual([]);
    expect(h.mics).toEqual([{ stopped: 1 }]);
    // Abgelehnt: Fehler, keine Anfrage beim Server
    const denied = page.createVoiceAgentCall({
      kennung: "jarvis",
      fetch: async () => {
        throw new Error("darf nicht aufgerufen werden");
      },
      loadSdk: async () => h.sdk.sdk,
      requestMicrophone: () => Promise.reject(new Error("NotAllowedError")),
      onChange: () => {},
      toLogin: () => {},
    });
    await denied.start();
    expect(denied.state).toMatchObject({ phase: "fehler", text: page.VOICE_AGENT_TEXT.micFailed });
    expect((await info(h, "jarvis")).laufend).toBeNull();
  });
});
