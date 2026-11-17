#!/usr/bin/env bun
/**
 * Browser-Durchlauf der Gesprächsseite eines Sprachagenten (Issue #494,
 * Aufgabe 2b) mit Headless-Chrome über das DevTools-Protokoll. Kein Teil von
 * `bun run check` (braucht Chrome), wird von Hand gestartet:
 *
 *   bun run scripts/web-sprachagent-check.ts
 *   bun run scripts/web-sprachagent-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *
 * Eigener Web-Server auf freiem Port, Rezept, Freischaltung, Abgleich und
 * Ablage in einem temporären Ordner, keine .env, src/bot.ts wird nicht
 * geladen. Die Umsetzung der Routen ist echt (createVoiceAgentSessions), der
 * Anbieter eine Fetch-Attrappe, die Gesprächs-Tokens ausgibt. Kein Aufruf
 * beim Anbieter, auch nicht aus dem Browser: Die Seite bekommt eine
 * SDK-Attrappe (window.ElevenLabsClient vor den Skripten der Seite), die das
 * Mikrofon von Chromes Attrappe öffnet. Die Tokens der Attrappe sind wie beim
 * Anbieter JWTs mit Ablauf (exp, 15 Minuten); der Server übernimmt diesen
 * Ablauf und lehnt Tokens ohne exp ab (502 token_ablauf). Geprüft: Start mit
 * dem ausgegebenen Token über WebRTC, Ablauf des Servers gleich exp, Token
 * ohne exp erreicht den Browser nicht, Auflegen mit /session/end erst nach getrenntem Raum,
 * Verbindungsfehler meldet das Ende, Verlassen ohne bestätigtes Trennen meldet
 * keins. Dazu ohne Attrappe: das selbst gehostete SDK und sein Worklet laden
 * unter der CSP der Gesprächsseite, ohne Anfrage an einen fremden Host.
 *
 * Seit Issue #495 dazu der Bereich /sprachagenten mit dem echten Manager von
 * /sprachagent (Sprachschicht als Attrappe): Liste, Rezept in Klartext,
 * Versionen, Testlauf, Link kopieren, Löschen mit Abbruch und mit
 * Bestätigung, und auf der Gesprächsseite Stumm, Unterbrechen und der Wechsel
 * zu einem anderen Sprachagenten, der erst auflegt. Seit der Prüfung von
 * PR #549: mehrere Testläufe nach Neuladen, Stumm erst nach abgeschlossenem
 * Umschalten der Mikrofonspur, Unterbrechen erst mit Bestätigung des SDK (ohne sie ein Hinweis),
 * Mindesthöhe 2,75 rem der Gesprächsknöpfe bei 390 px.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { recipeHash } from "../src/lib/voice-agents/base";
import { loadRecipe } from "../src/lib/voice-agents/recipe";
import { updateState } from "../src/lib/voice-agents/state";
import { writeUnlock } from "../src/lib/voice-agents/unlock";
import { verifyWebCall } from "../src/lib/voice-agents/web-calls";
import { readWebSessions } from "../src/lib/voice-agents/web-sessions";
import { createVoiceAgentManager } from "../src/lib/voice-agents/manage";
import { recordVersion } from "../src/lib/voice-agents/state";
import { createVoiceAgentAdmin } from "../src/web/bot-voice-agent-admin";
import { createVoiceAgentSessions } from "../src/web/bot-voice-agent-session";
import { createWebServer } from "../src/web/server";
import { VOICE_AGENT_SESSION_TEXT } from "../src/web/voice-agent-page";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = "browser-check-passwort";
const BRIDGE_TOKEN = "brueckentoken-attrappe-0815-lang-genug";
const { values } = parseArgs({ options: { screenshots: { type: "boolean" } }, strict: true });
const SHOTS = values.screenshots === true;
const OUT = join(import.meta.dir, "..", "docs", "webui", "screenshots");
const VENDOR = resolve(import.meta.dir, "..", "src", "web", "public", "vendor", "elevenlabs");
const PROCESSOR = /registerProcessor\("(rawAudioProcessor@[0-9a-f]+)"/.exec(readFileSync(join(VENDOR, "rawAudioProcessor.js"), "utf8"))![1];

// --- Rezept wie nach Abgleich und Freischaltung ---------------------------------------
const dir = await mkdtemp(join(tmpdir(), "sprachagent-check-"));
const paths = { configDir: join(dir, "config", "voice-agents"), dataDir: join(dir, "data", "voice-agents") };
mkdirSync(paths.configDir, { recursive: true });
const recipeJson = {
  schema: 1,
  kennung: "jarvis",
  name: "Jarvis",
  vorlage: "jarvis",
  zweck: "Hilft im Alltag.",
  persona: { rolle: "Ruhiger Assistent", anrede: "du", sprachen: ["de"], ersterSatz: "Was liegt an?" },
  stimme: { art: "bibliothek", voiceId: "stimme-1", modell: "eleven_flash_v2_5", tempo: 1.1 },
  gehirn: { art: "bruecke", modell: "claude-opus-5-5" },
  gedaechtnis: "voll",
  zugang: { web: { link: true }, maxMinuten: 12, budget: { minutenMonat: 300, anrufeJeNummerTag: 0 } },
  nachlauf: { zusammenfassung: true, faden: false, kalendervorschlag: false, anruferMerken: false, training: false, ziel: "direktchat" },
  tests: [
    { name: "Erster", szenario: "Jemand fragt nach", kriterien: ["antwortet"], maxZuege: 4 },
    { name: "Zweiter", szenario: "Jemand drängelt", kriterien: ["bleibt ruhig"], maxZuege: 6 },
  ],
};
writeFileSync(join(paths.configDir, "jarvis.json"), JSON.stringify(recipeJson, null, 2) + "\n");
const recipe = (await loadRecipe("jarvis", paths))!;
const hash = recipeHash(recipe);
await updateState("jarvis", { kennung: "jarvis", anbieter: "elevenlabs", agentId: "agent_jarvis", letzterHash: hash } as any, paths);
const unlocked = await writeUnlock("jarvis", { hash, version: 1, wissenHash: null, grund: "tests" }, paths);
if (unlocked.status !== "freigeschaltet") throw new Error(`nicht freigeschaltet: ${unlocked.status}`);
await recordVersion("jarvis", { ...recipeJson, zweck: "Hilft im Alltag, erste Fassung." }, paths);
await recordVersion("jarvis", recipeJson, paths);
// Zweiter Agent mit Web-Zugang (Wechsel, Issue #495) und ein dritter nur zum Löschen
const empfangJson = { ...recipeJson, kennung: "empfang", name: "Empfang", zweck: "Nimmt Bestellungen auf.", gehirn: { art: "anbieter", modell: "claude-sonnet-5-5" } };
writeFileSync(join(paths.configDir, "empfang.json"), JSON.stringify(empfangJson, null, 2) + "\n");
const empfang = (await loadRecipe("empfang", paths))!;
await updateState("empfang", { kennung: "empfang", anbieter: "elevenlabs", agentId: "agent_empfang", letzterHash: recipeHash(empfang) } as any, paths);
if ((await writeUnlock("empfang", { hash: recipeHash(empfang), version: 1, wissenHash: null, grund: "tests" }, paths)).status !== "freigeschaltet") throw new Error("empfang nicht freigeschaltet");
writeFileSync(join(paths.configDir, "notiz.json"), JSON.stringify({ ...recipeJson, kennung: "notiz", name: "Notiz", zugang: { ...recipeJson.zugang, web: { link: false } } }, null, 2) + "\n");
await updateState("notiz", { kennung: "notiz", anbieter: "elevenlabs", agentId: "agent_notiz" } as any, paths);

// --- Anbieter als Attrappe -------------------------------------------------------------
const providerCalls: string[] = [];
let tokenCounter = 0;
const issuedTokens: string[] = [];
const issuedExp: number[] = [];
/** Nächstes Token ohne exp (Abschnitt 3): Der Server muss es ablehnen */
let nextWithoutExp = false;
/**
 * Gesprächs-Token wie beim Anbieter (JWT, LiveKit): Der Server liest daraus
 * den echten Ablauf (exp) und lehnt Tokens ohne exp oder mit mehr als 60
 * Minuten ab (502 token_ablauf). Die Attrappe gibt 15 Minuten, die Signatur
 * prüft niemand.
 */
function testToken(n: number, withExp: boolean): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  issuedExp.push(withExp ? exp : 0);
  const payload = withExp ? { exp, sub: `browser-check-${n}` } : { sub: `browser-check-${n}` };
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signatur-attrappe-${n}`;
}
const serverLog: string[] = [];
const sessions = createVoiceAgentSessions({
  paths,
  env: { ELEVENLABS_API_KEY: "sk-attrappe-nie-echt", VOICE_BRIDGE_TOKEN: BRIDGE_TOKEN },
  fetch: async (url) => {
    providerCalls.push(url);
    // Statusabfrage: Die Attrappe bestätigt jedes Gespräch als beendet (30 Sekunden)
    const status = /\/v1\/convai\/conversations\/([^/?]+)$/.exec(url);
    if (status) return Response.json({ conversation_id: decodeURIComponent(status[1]), status: "done", metadata: { call_duration_secs: 30 } });
    tokenCounter++;
    const token = testToken(tokenCounter, !nextWithoutExp);
    nextWithoutExp = false;
    issuedTokens.push(token);
    return Response.json({ token, conversation_id: `conv_${tokenCounter}` });
  },
  log: (line) => void serverLog.push(line),
  sleep: async () => {},
});
// Verwaltung (Issue #495): echter Manager, Sprachschicht als Attrappe ohne Anbieter
const layerCalls: string[] = [];
const notes: string[] = [];
let frontForLinks = "";
const manager = createVoiceAgentManager({
  layer: () =>
    ({
      async runTests() {
        layerCalls.push("runTests");
        return { status: "gestartet", runId: "lauf-1" };
      },
      async testResult() {
        layerCalls.push("testResult");
        await Bun.sleep(1500);
        return { status: "fertig", gesamt: "bestanden", tests: [{ testId: "t1", name: "Erster", status: "bestanden" }, { testId: "t2", name: "Zweiter", status: "bestanden" }] };
      },
      async remove(state: any) {
        layerCalls.push(`remove ${state.kennung}`);
        const next = await updateState(state.kennung, { agentId: undefined, tests: {}, letzterHash: undefined }, paths);
        return { status: "ok", state: next };
      },
    }) as any,
  paths,
  sendChoice: async () => ({ sent: false }),
  notify: async (_conversation, text) => void notes.push(text),
  webBase: () => frontForLinks,
  log: (line) => void serverLog.push(line),
});
const admin = createVoiceAgentAdmin({ manager, paths, sessions, testResults: () => ({ type: "telegram", chatId: "web" }), log: (line) => void serverLog.push(line) });
const server = await createWebServer(
  { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
  { sessionFile: join(dir, "sessions.json"), dataDir: join(dir, "web"), cliTokenFile: join(dir, "cli-token"), voiceAgentSessions: sessions, voiceAgentAdmin: admin, log: (line) => void serverLog.push(line) }
);
const front = server.url.replace(/\/$/, "");
frontForLinks = front;
const running = async () => (await readWebSessions("jarvis", paths)).sitzungen.filter((s) => s.ende === null && Date.now() < s.bis);
const allSessions = async () => (await readWebSessions("jarvis", paths)).sitzungen;
const released = (id: string) => verifyWebCall({ kennung: "jarvis", conversationId: id }, { ...paths, token: BRIDGE_TOKEN }).then((ok) => !ok);

// --- Chrome ----------------------------------------------------------------------------
const debugPort = 9970 + Math.floor(Math.random() * 9);
const chrome = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "chrome")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "about:blank"],
  { stdout: "ignore", stderr: "ignore" }
);

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`${pass ? "OK  " : "FEHL"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function pageSocketUrl(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as any[];
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome startet noch
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome nicht erreichbar");
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();
const problems: string[] = [];
const requests: string[] = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "Ausnahme");
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") problems.push(msg.params.entry.text);
  if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
});
function cdp(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result))));
}
async function js<T = any>(expression: string): Promise<T> {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`JS-Fehler: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} in ${expression.slice(0, 120)}`);
  return r.result.value;
}
async function waitFor(expression: string, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await js<boolean>(`!!(${expression})`)) return true;
    } catch {
      // Seite lädt gerade
    }
    await Bun.sleep(40);
  }
  return false;
}
async function goto(url: string) {
  await cdp("Page.navigate", { url });
  await Bun.sleep(150);
  await waitFor(`document.readyState === "complete"`);
}
async function shoot(name: string) {
  if (!SHOTS) return;
  for (const width of [1280, 390]) {
    for (const scheme of ["light", "dark"] as const) {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 1, mobile: width < 1000 });
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await Bun.sleep(120);
      const { data } = await cdp("Page.captureScreenshot", { format: "png" });
      const file = `${name}-${width}${scheme === "dark" ? "-dunkel" : ""}.png`;
      await Bun.write(join(OUT, file), Buffer.from(data, "base64"));
      console.log(`Bild ${file}`);
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await cdp("Emulation.clearDeviceMetricsOverride");
}
const status = () => js<string>(`document.getElementById("agent-status").textContent`);
const visible = (id: string) => js<boolean>(`(b => !!b && !b.hidden && b.getClientRects().length > 0)(document.getElementById(${JSON.stringify(id)}))`);
const label = (id: string) => js<string>(`document.getElementById(${JSON.stringify(id)}).textContent`);
const click = (id: string) => js(`document.getElementById(${JSON.stringify(id)}).click()`);

/**
 * SDK-Attrappe nur mit ?attrappe=ok bzw. ?attrappe=fehler: Sie steht vor den
 * Skripten der Seite im Fenster, die Seite lädt dann kein SDK. Sie öffnet wie
 * das SDK das Mikrofon und meldet Zuhören bzw. Sprechen.
 */
const SDK_HOOK = `(() => {
  const mode = new URLSearchParams(location.search).get("attrappe");
  if (!mode) return;
  const sdk = (window.__sdk = { started: [], ended: 0, stream: null, options: null });
  window.ElevenLabsClient = { Conversation: { async startSession(o) {
    sdk.started.push({ token: o.conversationToken, connectionType: o.connectionType, workletPaths: o.workletPaths, agentId: o.agentId || null });
    if (o.onStatusChange) o.onStatusChange({ status: "connecting" });
    await new Promise((r) => setTimeout(r, 300));
    if (mode === "fehler") throw new Error("could not establish pc connection");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    sdk.stream = stream;
    sdk.options = o;
    if (o.onModeChange) o.onModeChange({ mode: "listening" });
    // LiveKit-Raum wie im SDK: endSession ruft room.disconnect() ohne await auf
    const room = { state: "connected", disconnect() { return new Promise((r) => setTimeout(() => { room.state = "disconnected"; r(); }, 200)); } };
    sdk.room = room;
    sdk.muted = [];
    sdk.activity = 0;
    // Mikrofonspur wie bei LiveKit: input.setMuted schaltet sie erst nach einer Weile um
    const track = { isMuted: false, mediaStreamTrack: { enabled: true, readyState: "live" } };
    room.localParticipant = { getTrackPublication: (source) => (source === "microphone" ? { track } : undefined) };
    const input = { setMuted(m) { sdk.muted.push(!!m); return new Promise((r) => setTimeout(() => { track.isMuted = !!m; track.mediaStreamTrack.enabled = !m; r(); }, 300)); }, isMuted: () => track.isMuted };
    return { connection: { room }, input, async endSession() { sdk.ended++; stream.getTracks().forEach((t) => t.stop()); room.disconnect(); if (o.onDisconnect) o.onDisconnect({ reason: "user" }); },
      setMicMuted(m) { input.setMuted(m); }, sendUserActivity() { sdk.activity++; } };
  } } };
})();`;

try {
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: SDK_HOOK });

  await goto(`${front}/login`);
  await waitFor(`document.getElementById("password")`);
  await js(`document.getElementById("password").value = ${JSON.stringify(PASSWORD)}`);
  await js(`document.getElementById("login-form").requestSubmit()`);
  check("Anmeldung", await waitFor(`location.pathname === "/"`, 10000));

  // --- 1. Start und Auflegen -----------------------------------------------------------
  await goto(`${front}/sa/jarvis?attrappe=ok`);
  check("Seite bereit: Name, „Bereit.“, Knopf „Sprechen“", (await waitFor(`document.getElementById("agent-name").textContent === "Jarvis"`)) && (await status()) === "Bereit." && (await visible("agent-talk")) && (await label("agent-talk")) === "Sprechen" && !(await visible("agent-hangup")));
  await shoot("sprachagent-bereit");
  await click("agent-talk");
  check("Tipp: „Verbinde …“ mit Knopf „Auflegen“", (await waitFor(`document.getElementById("agent-status").textContent === "Verbinde …"`)) && (await visible("agent-hangup")) && !(await visible("agent-talk")));
  check("verbunden: „Verbunden. Hört zu.“", await waitFor(`document.getElementById("agent-status").textContent === "Verbunden. Hört zu."`));
  const started = await js<any[]>(`window.__sdk.started`);
  check("SDK mit genau dem ausgegebenen Token über WebRTC, Worklet selbst gehostet, keine Agent-ID", started.length === 1 && issuedTokens.length >= 1 && started[0].token === issuedTokens[0] && started[0].connectionType === "webrtc" && started[0].workletPaths?.rawAudioProcessor === "/vendor/elevenlabs/rawAudioProcessor.js" && started[0].agentId === null, JSON.stringify(started));
  check("Mikrofon offen", await js<boolean>(`window.__sdk.stream.getAudioTracks().some((t) => t.readyState === "live")`));
  check("Server: Gespräch conv_1 läuft, Web-Freigabe der Brücke steht", (await running()).map((s) => s.gespraech).join() === "conv_1" && !(await released("conv_1")));
  const first = (await running())[0];
  check("Server: Tokenablauf ist exp aus dem Token (15 Minuten)", !!first && first.tokenBis === issuedExp[0] * 1000, first ? `tokenBis ${new Date(first.tokenBis).toISOString()}, exp ${new Date(issuedExp[0] * 1000).toISOString()}` : "keine Sitzung");
  await js(`window.__sdk.options.onModeChange({ mode: "speaking" })`);
  check("onModeChange: „Verbunden. Spricht.“", await waitFor(`document.getElementById("agent-status").textContent === "Verbunden. Spricht."`));
  await shoot("sprachagent-verbunden");
  await click("agent-hangup");
  check("Auflegen: „Gespräch beendet, 1 Minute gebucht.“, Knopf „Noch einmal sprechen“", (await waitFor(`document.getElementById("agent-status").textContent === "Gespräch beendet, 1 Minute gebucht."`)) && (await waitFor(`document.getElementById("agent-talk").textContent === "Noch einmal sprechen"`)) && !(await visible("agent-hangup")));
  check("Auflegen: Raum getrennt, bevor das Ende gemeldet wurde", (await js<string>(`window.__sdk.room.state`)) === "disconnected");
  check("Auflegen: endSession einmal, Mikrofon zu", (await js<number>(`window.__sdk.ended`)) === 1 && (await js<boolean>(`window.__sdk.stream.getAudioTracks().every((t) => t.readyState === "ended")`)));
  check("Server: kein laufendes Gespräch, Freigabe gelöscht", (await running()).length === 0 && (await released("conv_1")));
  check("Minuten auf der Seite aktualisiert", await waitFor(`document.getElementById("agent-minutes").textContent.startsWith("Minuten im Browser diesen Monat: 1 von 300")`));
  await shoot("sprachagent-beendet");

  // --- 2. Verbindungsfehler ------------------------------------------------------------
  await goto(`${front}/sa/jarvis?attrappe=fehler`);
  await waitFor(`document.getElementById("agent-status").textContent === "Bereit."`);
  await click("agent-talk");
  check("Verbindungsfehler: eigener Satz, Knopf „Noch einmal sprechen“", (await waitFor(`document.getElementById("agent-status").textContent.startsWith("Die Verbindung zum Sprachagenten ist gescheitert")`)) && (await waitFor(`document.getElementById("agent-talk").textContent === "Noch einmal sprechen"`)) && !(await visible("agent-hangup")));
  check("Verbindungsfehler: SDK bekam das zweite Token", issuedTokens.length >= 2 && (await js<any[]>(`window.__sdk.started`))[0]?.token === issuedTokens[1]);
  check("Verbindungsfehler: Ende gemeldet, kein laufendes Gespräch, Freigabe gelöscht", (await running()).length === 0 && (await released("conv_2")));
  await shoot("sprachagent-fehler");

  // --- 3. Token ohne exp: der Server gibt es nicht weiter ------------------------------
  await goto(`${front}/sa/jarvis?attrappe=ok`);
  await waitFor(`document.getElementById("agent-status").textContent === "Bereit."`);
  nextWithoutExp = true;
  await click("agent-talk");
  check("Token ohne exp: Satz des Servers (502 token_ablauf), Knopf „Noch einmal sprechen“", (await waitFor(`document.getElementById("agent-status").textContent === ${JSON.stringify(VOICE_AGENT_SESSION_TEXT.tokenExpiry)}`)) && (await waitFor(`document.getElementById("agent-talk").textContent === "Noch einmal sprechen"`)) && !(await visible("agent-hangup")));
  check("Token ohne exp: SDK nicht gestartet", (await js<any[]>(`window.__sdk.started`)).length === 0);
  check("Token ohne exp: keine Sitzung für conv_3, keine Freigabe", (await allSessions()).every((s) => s.gespraech !== "conv_3") && (await running()).length === 0 && (await released("conv_3")));
  check("Token ohne exp: Server-Log nennt die Ablehnung", serverLog.some((l) => l.includes("Token ohne lesbaren oder mit zu langem Ablauf")));
  await shoot("sprachagent-token-ablauf");

  // --- 4. Verlassen der Seite: Ende nur nach bestätigtem Trennen ------------------------
  // Beim Verlassen trennt die Seite und wartet auf den Raum. Stirbt das Dokument
  // vorher (hier: Navigation, der Raum der Attrappe braucht 200 ms), meldet sie
  // nichts, und Platz und Freigabe bleiben konservativ bis zum Ablauf stehen.
  await goto(`${front}/sa/jarvis?attrappe=ok`);
  await waitFor(`document.getElementById("agent-status").textContent === "Bereit."`);
  await click("agent-talk");
  await waitFor(`document.getElementById("agent-status").textContent === "Verbunden. Hört zu."`);
  check("viertes Gespräch läuft", (await running()).length === 1);
  await goto(`${front}/`);
  await Bun.sleep(1000);
  check("Seite verlassen (pagehide) ohne bestätigtes Trennen: kein Ende gemeldet, Platz und Freigabe bleiben reserviert", (await running()).map((s) => s.gespraech).join() === "conv_4" && !(await released("conv_4")));

  // --- 5. Echtes SDK unter der CSP der Gesprächsseite -----------------------------------
  requests.length = 0;
  await goto(`${front}/sa/jarvis`);
  await waitFor(`document.getElementById("agent-status").textContent === "Bereit."`);
  const real = await js<any>(`(async () => {
    const sdk = await createVoiceAgentSdkLoader(window, document)();
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(VOICE_AGENT_SDK.workletPaths.rawAudioProcessor);
    const node = new AudioWorkletNode(ctx, ${JSON.stringify(PROCESSOR)});
    await ctx.close();
    return { startSession: typeof sdk.Conversation.startSession, node: !!node };
  })()`);
  check("echtes SDK geladen (ElevenLabsClient.Conversation.startSession)", real.startSession === "function", JSON.stringify(real));
  check(`Worklet ${PROCESSOR} unter der CSP geladen`, real.node === true);
  const foreign = requests.filter((u) => !u.startsWith(front) && !u.startsWith("data:") && !u.startsWith("blob:"));
  check("keine Anfrage an einen fremden Host (kein jsDelivr, kein Anbieter)", foreign.length === 0, foreign.join(" "));
  check("Anbieter nur über die Attrappe des Servers aufgerufen", providerCalls.filter((u) => u.includes("/conversation/token")).length === 4);

  // --- 6. Bereich „Sprachagenten“ (Issue #495) ------------------------------------------
  const text = (sel: string) => js<string>(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
  const clickText = (sel: string, label: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.hidden && x.getClientRects().length > 0); if (b) b.click(); return !!b; })()`);
  await goto(`${front}/`);
  check("Seitenleiste: Eintrag „Sprachagenten“ sichtbar", await waitFor(`(e => e && !e.hidden && e.getAttribute("href") === "/sprachagenten")(document.getElementById("open-voice-agents"))`));
  await goto(`${front}/sprachagenten`);
  check("Liste: Jarvis, Empfang, Notiz", await waitFor(`[...document.querySelectorAll(".voice-agents-name")].map((e) => e.textContent).join() === "Empfang,Jarvis,Notiz" || [...document.querySelectorAll(".voice-agents-name")].map((e) => e.textContent).sort().join() === "Empfang,Jarvis,Notiz"`));
  check("Liste: Meta-Zeile nennt Zugang und Testlauf", (await text(".voice-agents-item .settings-device-meta")).includes("Browser") && (await text(".voice-agents-item .settings-device-meta")).includes("Noch kein Testlauf."));
  check("Liste: kein Knopf „Neu“, kein Textfeld", (await js<number>(`document.querySelectorAll("input, textarea").length`)) === 0 && !(await clickText("button", "Neu")));
  await shoot("sprachagenten-liste");
  await js(`location.hash = "#jarvis"`);
  check("Detail: Titel Jarvis, Rezept in Klartext", (await waitFor(`document.getElementById("va-title").textContent === "Jarvis" && document.querySelector(".voice-agent-recipe")`)) && (await js<string>(`document.getElementById("va-detail").textContent`)).includes("Hilft im Alltag.") && !(await js<string>(`document.getElementById("va-detail").textContent`)).includes('"persona"'));
  check("Detail: Versionen 2 (aktuell) und 1", (await js<string>(`[...document.querySelectorAll(".voice-agent-version")].map((b) => b.textContent).join()`)) === "Version 2 (aktuell),Version 1");
  check("Detail: Minuten im Browser aus der Gesprächsroute", (await js<string>(`document.getElementById("va-detail").textContent`)).includes("Im Browser diesen Monat:"));
  check("Detail: Knöpfe Sprechen, Testen, Link kopieren, Löschen", (await js<string>(`[...document.querySelectorAll(".voice-agent-detail-actions > *")].map((b) => b.textContent).join()`)) === "Sprechen,Testen,Link kopieren,Löschen");
  await shoot("sprachagenten-detail");
  await clickText(".voice-agent-version", "Version 1");
  check("Version 1 lesbar, ältere Fassung im Klartext", await waitFor(`document.getElementById("va-detail").textContent.includes("erste Fassung")`));
  await clickText("button", "Aktuelle Fassung zeigen");
  await waitFor(`!document.getElementById("va-detail").textContent.includes("erste Fassung")`);
  await clickText("button", "Testen");
  check("Testen: Lauf gestartet, Satz auf der Seite", await waitFor(`document.getElementById("va-detail").textContent.includes("Testlauf gestartet") || document.getElementById("va-detail").textContent.includes("Testlauf läuft seit")`));
  check("Testen: Ergebnis erscheint ohne Neuladen", await waitFor(`document.getElementById("va-detail").textContent.includes("Test bestanden, bestanden 2 von 2")`, 12000));
  check("Testen: Ergebnis in den Direktchat gemeldet", notes.some((n) => n.includes("Testlauf Jarvis")));
  await clickText("button", "Testen");
  const finished = `!document.getElementById("va-detail").textContent.includes("Testlauf läuft") && !document.getElementById("va-detail").textContent.includes("Testlauf gestartet") && document.querySelectorAll(".voice-agent-earlier li").length === 1`;
  check("Testen ein zweites Mal: Ergebnis ohne Neuladen, der erste Lauf unter „Davor“", (await waitFor(`document.getElementById("va-detail").textContent.includes("Testlauf")`)) && (await waitFor(finished, 12000)));
  await goto(`${front}/sprachagenten#jarvis`);
  check("Neu geladen: „Letzte Testläufe“ mit dem letzten Lauf und einem davor", (await waitFor(`document.getElementById("va-title").textContent === "Jarvis" && ${finished}`)) && (await text(".voice-agent-detail .group-label")) === "Letzte Testläufe" && (await text(".voice-agent-detail .voice-agent-line")).startsWith("Test bestanden, bestanden 2 von 2") && (await text(".voice-agent-earlier li")).startsWith("Test bestanden, bestanden 2 von 2"));
  await cdp("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: front }).catch(() => {});
  await clickText("button", "Link kopieren");
  check("Link kopieren: Rückmeldung mit Link oder „Link kopiert.“", await waitFor(`(t => t === "Link kopiert." || t.includes("/sa/jarvis"))(document.querySelector(".voice-agent-feedback").textContent)`));
  await clickText("button", "Löschen");
  check("Löschen: Rückfrage statt Knöpfe, Fokus auf Abbrechen", (await waitFor(`(c => c && !c.hidden)(document.querySelector(".voice-agent-confirm"))`)) && (await js<string>(`document.activeElement.textContent`)) === "Abbrechen");
  await shoot("sprachagenten-loeschen");
  await clickText(".voice-agent-confirm button", "Abbrechen");
  check("Löschen abgebrochen: Rezept bleibt, Anbieter nicht gefragt", existsSync(join(paths.configDir, "jarvis.json")) && !layerCalls.some((c) => c.startsWith("remove")));
  await js(`location.hash = "#notiz"`);
  await waitFor(`document.getElementById("va-title").textContent === "Notiz"`);
  check("Ohne Web-Zugang: kein „Sprechen“, kein „Link kopieren“", (await js<string>(`[...document.querySelectorAll(".voice-agent-detail-actions > *")].map((b) => b.textContent).join()`)) === "Testen,Löschen");
  await clickText("button", "Löschen");
  await clickText(".voice-agent-confirm button", "Löschen");
  check("Löschen bestätigt: Liste ohne Notiz, Rezept im Archiv", (await waitFor(`document.getElementById("va-status").textContent.startsWith("Notiz ist gelöscht")`)) && !existsSync(join(paths.configDir, "notiz.json")) && layerCalls.includes("remove notiz"));

  // --- 7. Gesprächsseite: Stumm, Unterbrechen, Wechsel ---------------------------------
  const empfangRunning = async () => (await readWebSessions("empfang", paths)).sitzungen.filter((x) => x.ende === null && Date.now() < x.bis);
  await goto(`${front}/sa/empfang?attrappe=ok`);
  await waitFor(`document.getElementById("agent-status").textContent === "Bereit."`);
  check("Wechsel-Auswahl mit beiden Agenten", (await waitFor(`(b => b && !b.hidden)(document.getElementById("agent-switch"))`)) && (await js<string>(`[...document.querySelectorAll("#agent-switch-select option")].map((o) => o.value).sort().join()`)) === "empfang,jarvis");
  await click("agent-talk");
  check("verbunden mit Empfang, Knopf „Stumm“", (await waitFor(`document.getElementById("agent-status").textContent === "Verbunden. Hört zu."`)) && (await visible("agent-mute")) && !(await visible("agent-interrupt")));
  await click("agent-mute");
  check("Stumm: erst „Schalte …“ mit gesperrtem Knopf, kein Satz „stumm“ vor dem Abschluss", (await js<string>(`document.getElementById("agent-status").textContent`)) === "Verbunden. Schalte dein Mikrofon stumm …" && (await js<boolean>(`document.getElementById("agent-mute").disabled`)));
  check("Stumm: nach dem Abschluss Satz, aria-pressed, SDK input.setMuted(true)", (await waitFor(`document.getElementById("agent-status").textContent === "Verbunden. Dein Mikrofon ist stumm."`)) && (await js<string>(`document.getElementById("agent-mute").getAttribute("aria-pressed")`)) === "true" && (await js<boolean[]>(`window.__sdk.muted`)).join() === "true" && !(await js<boolean>(`document.getElementById("agent-mute").disabled`)));
  await js(`window.__sdk.options.onModeChange({ mode: "speaking" })`);
  check("spricht: Knopf „Unterbrechen“", await waitFor(`(b => !b.hidden)(document.getElementById("agent-interrupt"))`));
  // Mindesthöhe der Gesprächssteuerung am Handy
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await Bun.sleep(120);
  const heights = await js<Record<string, number>>(`Object.fromEntries(["agent-hangup", "agent-mute", "agent-interrupt", "agent-switch-select"].map((id) => [id, document.getElementById(id).getBoundingClientRect().height]))`);
  const rem = await js<number>(`parseFloat(getComputedStyle(document.documentElement).fontSize)`);
  check("390 px: Auflegen, Stumm, Unterbrechen und Auswahl mindestens 2,75 rem hoch", Object.values(heights).every((h) => h >= 2.75 * rem - 0.5), JSON.stringify(heights));
  await cdp("Emulation.clearDeviceMetricsOverride");
  await shoot("sprachagent-steuerung");
  await click("agent-interrupt");
  check("Unterbrechen: sendUserActivity, „Unterbreche …“, Knopf gesperrt, noch nicht „Hört zu“", (await js<number>(`window.__sdk.activity`)) === 1 && (await status()) === "Verbunden. Unterbreche …" && (await js<boolean>(`document.getElementById("agent-interrupt").disabled`)));
  check("Unterbrechen ohne Bestätigung: nach der Frist weiter „Spricht“ mit Hinweis", await waitFor(`document.getElementById("agent-status").textContent.startsWith("Verbunden. Spricht. Der Agent hat das Unterbrechen nicht bestätigt")`, 6000));
  await click("agent-interrupt");
  await js(`window.__sdk.options.onInterruption({ event_id: 2 })`);
  check("Unterbrechen bestätigt (onInterruption): wieder stumm, Knopf weg", (await js<number>(`window.__sdk.activity`)) === 2 && (await waitFor(`document.getElementById("agent-status").textContent === "Verbunden. Dein Mikrofon ist stumm."`)) && !(await visible("agent-interrupt")));
  await click("agent-mute");
  check("Stumm aus: input.setMuted(false), nach dem Abschluss „Hört zu“", (await waitFor(`document.getElementById("agent-status").textContent === "Verbunden. Hört zu."`)) && (await js<boolean[]>(`window.__sdk.muted`)).join() === "true,false");
  check("Server: Gespräch mit Empfang läuft", (await empfangRunning()).length === 1);
  await js(`(s => { s.value = "jarvis"; s.dispatchEvent(new Event("change")); })(document.getElementById("agent-switch-select"))`);
  check("Wechsel: erst aufgelegt, dann /sa/jarvis", await waitFor(`location.pathname === "/sa/jarvis"`, 10000));
  check("Wechsel: Gespräch mit Empfang beendet und gemeldet", (await empfangRunning()).length === 0);

  const csp = problems.filter((p) => /Content Security Policy|Refused/i.test(p));
  check("keine CSP-Verstöße", csp.length === 0, csp.join(" | "));
  const errors = problems.filter((p) => !/Failed to load resource|Content Security Policy|Refused/i.test(p));
  check("keine Skriptfehler", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  ws.close();
  chrome.kill();
  await chrome.exited;
  await server.stop({ graceMs: 200 });
  await rm(dir, { recursive: true, force: true });
}

const agentLog = serverLog.filter((l) => l.includes("Web-Gespräch"));
if (agentLog.length) console.log(`\nServer-Log (Web-Gespräch):\n  ${agentLog.join("\n  ")}`);
console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
