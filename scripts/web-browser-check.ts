#!/usr/bin/env bun
/**
 * Browser-Durchlauf der Chat-Seite (Issue #5) mit Headless-Chrome über das
 * DevTools-Protokoll. Kein Teil von `bun run check` (braucht Chrome), wird
 * von Hand gestartet:
 *
 *   bun run scripts/web-browser-check.ts
 *   bun run scripts/web-browser-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *   bun run scripts/web-browser-check.ts --nur erinnerungen,einstellungen   # nur diese Abschnitte (ONLY_SECTIONS)
 *
 * Startet einen eigenen Web-Server mit Attrappe auf einem freien Port in
 * einem temporären Verzeichnis. Importiert src/bot.ts nicht.
 *
 * Seit Issue #29 legt „Neues Gespräch" ein Telegram-Topic an, ohne
 * Forum-Gruppe seit Issue #227 ein reines Web-Gespräch; der eigene Server hat
 * keine Gruppe. Weitere Web-Gespräche legt das Skript direkt im
 * Gesprächsspeicher an (plainStore). Den Betrieb ganz ohne Telegram prüft
 * scripts/web-ohne-telegram-check.ts.
 *
 * Chrome spricht über einen kleinen TCP-Proxy auf [::1] mit demselben Port
 * (der Host-Header muss den Port des Servers tragen). Der Proxy kann alle
 * Verbindungen hart trennen, wie ein abgerissenes WLAN; Chromes
 * Offline-Emulation trennt eine schon offene SSE-Verbindung nicht.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { BRAND } from "../src/brand";
import { createFakeChat } from "../src/web/fake-chat";
import { DEFAULT_PUSH_SUBJECT, generateVapidKeys, toBase64Url } from "../src/web/push";
import { createDemoJobs, createDemoChoices, DEMO_JOB_IDS, DEMO_JOB_CHOICE, createDemoKeys, createDemoEngines, DEMO_DM_SESSION_KEY, DEMO_ENGINE_HINT, createDemoOpenRouterKey, createDemoReminders, createDemoRoutines, createDemoSettings, createDemoStatus, createDemoThreads, DEMO_CHOICES, DEMO_GROUP_ID, DEMO_REPLY, DEMO_SETTINGS, startDemoServer } from "../src/web/demo";
import type { OpenRouterKeyStatus } from "../src/web/openrouter-key";
import { createDemoPipelines } from "../src/web/demo";
import { createChoice, decideChoice, getChoiceChecked, listChoices, onChoiceChange, onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
import { jobChoiceStaleText } from "../src/lib/jobs/choices";
import { writeStatus } from "../src/lib/jobs/store";
import { abortExecutions } from "../src/lib/execution-context";
import { createChoiceToolApproval } from "../src/lib/tool-approval";
import { decideReview, processTurnIntents } from "../src/lib/intent-gate";
import { createReviewNotifier, createReviewResults } from "../src/lib/review-choices";
import { setPendingReviewsFileForTests, setReviewNotifier, takePendingReview } from "../src/lib/session-distill";
import { callBuiltinTool, registerBuiltinTool, setToolApprovalHandler } from "../src/lib/tools/registry";
import { createChoicePort } from "../src/web/choices";
import { createTelegramGoalStatus, runGoalAction } from "../src/lib/goal-actions";
import { createGoalChoices, GOAL_NO_BUTTONS_HINT } from "../src/lib/goal-choices";
import { createTopicChoices, TOPIC_MAP_TEXT } from "../src/lib/topic-choices";
import { getMappedAgent, onTopicMappingSet } from "../src/lib/topic-setup";
import { listAgents, setAgentCatalogPaths } from "../src/agents/catalog";
import {
  clearGoal,
  configureGoalStore,
  getGoal,
  initGoalEngine,
  isGoalLoopRunning,
  onGoalChange,
  setGoal,
  startGoalWork,
  updateGoal,
} from "../src/lib/goal-engine";
import { createBotGoals } from "../src/web/bot-goals";
import { createApprovalTurns, createBotChat } from "../src/web/bot-turn";
import { CLAUDE_MODELS } from "../src/web/models";
import { stripControlTags } from "../src/web/markdown";
import { createWebServer } from "../src/web/server";
import { accessIssuer } from "../src/web/access";
import { generateKeyPairSync, sign } from "node:crypto";
import { ConversationStore } from "../src/web/store";

/**
 * --nur <abschnitt,...> (Issue #323): nur Abschnitte, die ihren eigenen
 * Demo-Server starten; der übrige Durchlauf entfällt
 */
const ONLY_SECTIONS: Record<string, () => Promise<void>> = {
  einstellungen: () => settingsChecks(),
  status: () => modelsStatusChecks(),
  motor: () => engineChecks(),
  schluessel: () => keysChecks(),
  routinen: () => routinesChecks(),
  erinnerungen: () => remindersChecks(),
  faeden: () => threadsChecks(),
  rueckfragen: () => choiceChecks(),
  jobs: async () => { await jobViewChecks(); await jobResumeChoiceChecks(); await jobQuestionChecks(); await jobReturnChecks(); },
  pipelines: () => pipelineViewChecks(),
};
const onlyAt = process.argv.indexOf("--nur");
const only = onlyAt >= 0 ? (process.argv[onlyAt + 1] ?? "").split(",").filter(Boolean) : [];
if (onlyAt >= 0 && (!only.length || only.some(name => !(name in ONLY_SECTIONS)))) {
  console.error(`--nur braucht Abschnitte aus: ${Object.keys(ONLY_SECTIONS).join(", ")}`);
  process.exit(2);
}
/** Ende eines --nur-Durchlaufs: weiter zum Aufräumen, kein Fehler */
const ONLY_DONE = Symbol("nur");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = "browser-check-passwort";

const dir = await mkdtemp(join(tmpdir(), "tybo-web-browser-"));
// Ältere Web-Gespräche (vor Issue #29) entstehen nicht mehr über die API
const plainStore = new ConversationStore({ dir: join(dir, "web") });
await plainStore.load();
await plainStore.createConversation("general");
const server = await createWebServer(
  { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
  {
    sessionFile: join(dir, "sessions.json"),
    dataDir: join(dir, "web"),
    conversationStore: plainStore,
    chat: createFakeChat({ delayMs: 1500, stepMs: 300 }),
    log: () => {},
  }
);
const demo = await startDemoServer(
  { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
  {
    chat: createFakeChat({ delayMs: 1500, stepMs: 300 }),
    // Schreiben in Topics (Issue #19): Attrappe, nichts geht nach Telegram
    telegramChat: createFakeChat({ delayMs: 1500, stepMs: 300 }),
    log: () => {},
  }
);

// --- Trennbarer Proxy [::1]:port -> 127.0.0.1:port ----------------------------
const port = Number(new URL(server.url).port);
type Pair = { client: Socket; upstream: Socket };
const pairs = new Set<Pair>();
let proxyBlocked = false;
const proxy = createServer(client => {
  if (proxyBlocked) return void client.destroy();
  const upstream = createConnection({ host: "127.0.0.1", port });
  const pair = { client, upstream };
  pairs.add(pair);
  // pipe berücksichtigt volle Schreibpuffer. Rohe socket.write-Aufrufe können
  // nur einen Teil übernehmen und schnitten dann große Skripte wie app.js ab.
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => { upstream.destroy(); pairs.delete(pair); });
  upstream.on("close", () => client.end());
});
await new Promise<void>((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen({ host: "::1", port, ipv6Only: true }, resolve);
});
function cutConnections(block: boolean) {
  proxyBlocked = block;
  if (!block) return;
  for (const p of [...pairs]) {
    p.client.destroy();
    p.upstream.destroy();
  }
  pairs.clear();
}
const base = `http://[::1]:${port}`;

const debugPort = 9300 + Math.floor(Math.random() * 500);
const chrome = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "chrome")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    // Sprachaufnahme (Issue #109): Mikrofon-Attrappe von Chrome (Piepton), Freigabe ohne Dialog, Abspielen ohne Geste
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    "about:blank"],
  { stdout: "ignore", stderr: "ignore" }
);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function pageSocketUrl(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as any[];
      const page = targets.find(t => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome startet noch
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome nicht erreichbar");
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();
ws.addEventListener("message", event => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});
function cdp(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, msg => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
  );
}
async function js<T = any>(expression: string): Promise<T> {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`JS-Fehler: ${r.exceptionDetails.text} in ${expression}`);
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
    await Bun.sleep(50);
  }
  return false;
}
async function goto(url: string) {
  await cdp("Page.navigate", { url });
  await Bun.sleep(100);
  await waitFor(`document.readyState === "complete"`);
}
async function typeAndEnter(text: string) {
  await js(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}
const count = (sel: string) => js<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const turnDone = () => waitFor(`document.getElementById("activity").hidden`, 10000);
/** Ausdruck: Element ist wirklich zu sehen (nicht hidden, nicht display:none) */
const shown = (id: string) => `((e) => !!e && !e.hidden && e.getClientRects().length > 0)(document.getElementById("${id}"))`;
/** Ausdruck: Senden statt Stopp (bereit) oder Stopp statt Senden (Turn läuft) */
const idleButtons = `(${shown("send")} && !${shown("stop")})`;
const runningButtons = `(${shown("stop")} && !${shown("send")})`;

// --- Hell/Dunkel-Wahl (Issue #15) --------------------------------------------
const LIGHT_BG = "rgb(255, 255, 255)";
const DARK_BG = "rgb(31, 32, 35)";
const bodyBg = () => js<string>(`getComputedStyle(document.body).backgroundColor`);
const themeAttr = () => js<string | null>(`document.documentElement.getAttribute("data-theme")`);
const themeColors = () => js<string[]>(`[...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.content)`);
const computedScheme = () => js<string>(`getComputedStyle(document.documentElement).colorScheme`);
const checkedTheme = () => js<string[]>(`[...document.querySelectorAll("#theme-switch [role=radio]")].filter(b => b.getAttribute("aria-checked") === "true").map(b => b.id)`);
const storedTheme = () => js<string | null>(`localStorage.getItem("tybo-theme")`);
async function emulateScheme(value: "light" | "dark") {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
}
async function pressKey(key: string, code: string, keyCode: number, text?: string) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}

// --- Telegram in der Seitenleiste (Issue #18) --------------------------------
const LAST_KEY = "tybo-last-conversation";
const entryCount = (list: string) => count(`#${list} .conversation`);
const entryTitles = (list: string) => js<string[]>(`[...document.querySelectorAll("#${list} .conversation-title")].map(t => t.textContent)`);
const clickEntry = (id: string) => js(`document.querySelector('.conversation[data-id="${id}"]').click()`);
/** Seitenbreite ohne horizontales Scrollen, auch nicht in der offenen Schublade */
const noHorizontalScroll = (width: number) =>
  js<boolean>(`document.documentElement.scrollWidth <= ${width} && document.body.scrollWidth <= ${width} && (() => { const s = document.getElementById("sidebar"); return s.scrollWidth <= s.clientWidth; })()`);
/** Abstand der Oberkante einer Nachricht zur Oberkante des Verlaufs */
const offsetOf = (id: string) =>
  js<number>(`document.querySelector('.msg[data-id="${id}"]').getBoundingClientRect().top - document.getElementById("chat-log").getBoundingClientRect().top`);

/** Web-Gespräche vom Server (am Proxy vorbei) */
async function serverConversations(cookie: string): Promise<any[]> {
  return (await (await fetch(`${server.url}/api/conversations`, { headers: { cookie } })).json()).conversations;
}

/**
 * Issue #21 im Normalbetrieb (1280 px): Agent per Tastatur wählen, Titel
 * inline umbenennen (Escape bricht ab, Enter speichert), über das Menü der
 * Kopfzeile mit Rückfrage löschen; danach öffnet das jüngste andere Gespräch.
 * Am Ende das Menü am Eintrag in der Seitenleiste mit „Abbrechen", die
 * Auswahl nach dem Löschen bei geänderter Aktivitätsreihenfolge und das
 * Titelfeld mit echten Eingaben (80 Emoji, Einfügen mit viel Leerraum).
 */
async function manageChecks(cookie: string) {
  const before = await serverConversations(cookie);
  await js(`document.getElementById("new-chat").click()`);
  await waitFor(`document.activeElement?.dataset.agentOption === "general"`);
  check("Auswahl: alle Agenten mit Punkt, General zuerst",
    (await count("#agent-options .agent-option .agent-dot")) === 8 &&
    (await js<string>(`document.querySelector("#agent-options .agent-option").textContent`)) === "General");
  check("Auswahl: Liste in der Seitenleiste, kein Dialog",
    await js<boolean>(`document.getElementById("sidebar").contains(document.getElementById("agent-picker")) && !document.querySelector("dialog, [aria-modal]")`));
  await pressKey("ArrowDown", "ArrowDown", 40);
  check("Auswahl: Pfeil runter markiert Research",
    await waitFor(`document.activeElement?.dataset.agentOption === "research" && document.activeElement.getAttribute("aria-selected") === "true"`));
  await pressKey("Enter", "Enter", 13, "\r");
  // Ohne Forum-Gruppe seit Issue #227 (Nachtrag zu 0005): reines Web-Gespräch mit dem gewählten Agenten
  check("Enter mit Research: ohne Forum-Gruppe neues Web-Gespräch geöffnet",
    await waitFor(`document.getElementById("agent-name").textContent === "Research" && !${shown("agent-picker")}`));
  const afterCreate = await serverConversations(cookie);
  const created = afterCreate.find(c => !before.some(b => b.id === c.id))!;
  check("Server: genau ein neues Web-Gespräch mit Research", afterCreate.length === before.length + 1 && created?.agent === "research");
  await goto(`${base}/`);
  await waitFor(`document.querySelector('.conversation[data-id="${created.id}"]')`);
  await clickEntry(created.id);
  check("Web-Gespräch mit Research wieder geöffnet",
    await waitFor(`document.getElementById("agent-name").textContent === "Research" && !${shown("agent-picker")}`));
  check("Server: Gespräch mit Agent research", (await serverConversations(cookie)).some(c => c.id === created.id && c.agent === "research" && c.title === "Neues Gespräch"));
  check("Seitenleiste: Eintrag mit Research-Punkt oben",
    await js<boolean>(`(() => { const m = document.querySelector("#conversation-list .conversation .conversation-meta"); return m.dataset.agent === "research" && m.textContent === "Research"; })()`));

  // Umbenennen: Escape bricht ab
  await js(`document.getElementById("chat-title").click()`);
  check("Titel antippen: Eingabefeld mit Fokus und bisherigem Titel",
    await waitFor(`${shown("title-input")} && document.activeElement.id === "title-input" && document.activeElement.value === "Neues Gespräch" && !${shown("chat-title")}`));
  await js(`document.getElementById("title-input").value = "Wegwerf-Titel"`);
  await pressKey("Escape", "Escape", 27);
  check("Escape bricht ab: alter Titel, nichts gespeichert",
    (await waitFor(`!${shown("title-input")} && document.getElementById("chat-title").textContent === "Neues Gespräch"`)) &&
    (await serverConversations(cookie)).find(c => c.id === created.id)?.title === "Neues Gespräch");
  // Enter speichert normalisiert
  await js(`document.getElementById("chat-title").click()`);
  await waitFor(`document.activeElement.id === "title-input"`);
  await js(`document.getElementById("title-input").value = "  VPS   Vergleich \t Hetzner "`);
  await pressKey("Enter", "Enter", 13, "\r");
  check("Enter speichert: Kopfzeile und Seitenleiste zeigen den neuen Titel",
    await waitFor(`!${shown("title-input")} && document.getElementById("chat-title").textContent === "VPS Vergleich Hetzner" && document.querySelector("#conversation-list .conversation-title").textContent === "VPS Vergleich Hetzner"`));
  check("Server: Titel gespeichert", (await serverConversations(cookie)).find(c => c.id === created.id)?.title === "VPS Vergleich Hetzner");
  // Die erste Nachricht überschreibt den Titel nicht; während des Turns lehnt der Server das Löschen ab
  await typeAndEnter("Was kostet ein kleiner VPS?");
  await waitFor(`!document.getElementById("activity").hidden`);
  await js(`document.getElementById("conversation-menu").click()`);
  await js(`[...document.querySelectorAll("#conversation-actions button")].find(b => b.textContent === "Löschen").click()`);
  await waitFor(`document.querySelector("#conversation-actions .action-confirm")`);
  await js(`document.querySelector("#conversation-actions .action-confirm").click()`);
  check("Löschen während einer Antwort: abgelehnt mit Hinweis, Gespräch bleibt",
    (await waitFor(`[...document.querySelectorAll(".msg-error")].some(m => m.textContent.includes("nicht löschen"))`)) &&
    (await serverConversations(cookie)).some(c => c.id === created.id));
  await turnDone();
  await Bun.sleep(300);
  check("erste Nachricht überschreibt den gesetzten Titel nicht",
    (await js<string>(`document.getElementById("chat-title").textContent`)) === "VPS Vergleich Hetzner" &&
    (await serverConversations(cookie)).find(c => c.id === created.id)?.title === "VPS Vergleich Hetzner");

  // Löschen über das Menü der Kopfzeile
  await js(`document.getElementById("conversation-menu").click()`);
  check("Menü der Kopfzeile: Umbenennen und Löschen",
    (await waitFor(shown("conversation-actions"))) &&
    JSON.stringify(await js<string[]>(`[...document.querySelectorAll("#conversation-actions button")].map(b => b.textContent)`)) === JSON.stringify(["Umbenennen", "Löschen"]));
  await js(`[...document.querySelectorAll("#conversation-actions button")].find(b => b.textContent === "Löschen").click()`);
  check(`Rückfrage „Gespräch löschen?", Fokus auf Abbrechen`,
    await waitFor(`document.querySelector("#conversation-actions .actions-question")?.textContent === "Gespräch löschen?" && document.activeElement?.textContent === "Abbrechen"`));
  check("Server: vor der Bestätigung nichts gelöscht", (await serverConversations(cookie)).some(c => c.id === created.id));
  await js(`document.querySelector("#conversation-actions .action-confirm").click()`);
  check("nach dem Löschen: jüngstes anderes Gespräch offen, Menü zu",
    await waitFor(`document.getElementById("chat-title").textContent !== "VPS Vergleich Hetzner" && !${shown("conversation-actions")} && document.getElementById("agent-name").textContent === "General"`));
  const after = await serverConversations(cookie);
  check("Server: Gespräch gelöscht, Verlauf 404",
    !after.some(c => c.id === created.id) &&
    (await fetch(`${server.url}/api/conversations/${created.id}/messages`, { headers: { cookie } })).status === 404);
  check("Seitenleiste ohne gelöschten Eintrag, gemerkte Auswahl zeigt auf das offene",
    !(await js<boolean>(`!!document.querySelector('.conversation[data-id="${created.id}"]')`)) &&
    (await js<string>(`localStorage.getItem(${JSON.stringify(LAST_KEY)})`)) !== created.id);

  // Menü am Eintrag in der Seitenleiste: Rückfrage, dann Abbrechen
  const firstId = await js<string>(`document.querySelector("#conversation-list .conversation").dataset.id`);
  await js(`document.querySelector("#conversation-list .entry-menu").click()`);
  await js(`[...document.querySelectorAll("#conversation-list .entry-actions button")].find(b => b.textContent === "Löschen").click()`);
  check("Eintrag: Rückfrage erscheint unter dem Eintrag",
    await waitFor(`document.querySelector("#conversation-list .entry-actions .actions-question")?.textContent === "Gespräch löschen?"`));
  await pressKey("Enter", "Enter", 13, "\r");
  check("Eintrag: Enter auf Abbrechen löscht nicht",
    (await waitFor(`!document.querySelector("#conversation-list .entry-actions")`)) && (await serverConversations(cookie)).some(c => c.id === firstId));

  // Drei benannte Gespräche, lokal C/B/A; in A antworten lassen, dann C löschen:
  // offen sein muss A (auf dem Server zuletzt aktiv), nicht B (lokal das nächste)
  const ids: string[] = [];
  for (const title of ["Gespräch A", "Gespräch B", "Gespräch C"]) {
    const conversation = await plainStore.createConversation("general");
    await plainStore.renameConversation(conversation.id, title);
    ids.push(conversation.id);
    // Eigene Zeitpunkte, sonst ist die Reihenfolge in der Liste zufällig
    await Bun.sleep(5);
  }
  const [idA, , idC] = ids;
  await goto(`${base}/`);
  await waitFor(`document.querySelectorAll("#conversation-list .conversation").length >= 3`);
  check("drei Gespräche: lokal C, B, A oben",
    JSON.stringify((await entryTitles("conversation-list")).slice(0, 3)) === JSON.stringify(["Gespräch C", "Gespräch B", "Gespräch A"]));
  await clickEntry(idA);
  await waitFor(`document.getElementById("chat-title").textContent === "Gespräch A"`);
  await typeAndEnter("Kurze Frage in A");
  await waitFor(`!document.getElementById("activity").hidden`);
  await turnDone();
  await Bun.sleep(300);
  check("Server: A nach der Antwort zuletzt aktiv", (await serverConversations(cookie))[0]?.id === idA);
  await clickEntry(idC);
  await waitFor(`document.getElementById("chat-title").textContent === "Gespräch C"`);
  await js(`document.getElementById("conversation-menu").click()`);
  await js(`[...document.querySelectorAll("#conversation-actions button")].find(b => b.textContent === "Löschen").click()`);
  await waitFor(`document.querySelector("#conversation-actions .action-confirm")`);
  await js(`document.querySelector("#conversation-actions .action-confirm").click()`);
  const opened = (await waitFor(`!document.querySelector('.conversation[data-id="${idC}"]') && document.getElementById("chat-title").textContent === "Gespräch A"`))
    ? "Gespräch A" : await js<string>(`document.getElementById("chat-title").textContent`);
  check("C gelöscht: das zuletzt aktive A öffnet, nicht B", opened === "Gespräch A", opened);

  // Titelfeld mit echten Tastatur- und Einfügeeingaben (Input.insertText), ohne .value
  const emoji = "😀".repeat(80);
  await js(`document.getElementById("chat-title").click()`);
  await waitFor(`document.activeElement.id === "title-input"`);
  await cdp("Input.insertText", { text: emoji });
  check("Titelfeld nimmt 80 Emoji an", (await js<string>(`document.getElementById("title-input").value`)) === emoji);
  await pressKey("Enter", "Enter", 13, "\r");
  check("80 Emoji gespeichert: Kopfzeile und Server",
    (await waitFor(`!${shown("title-input")} && document.getElementById("chat-title").textContent === ${JSON.stringify(emoji)}`)) &&
    (await serverConversations(cookie)).find(c => c.id === idA)?.title === emoji);
  const pasted = "Anfang" + " ".repeat(100) + "\n\tEnde";
  await js(`document.getElementById("chat-title").click()`);
  await waitFor(`document.activeElement.id === "title-input"`);
  await cdp("Input.insertText", { text: pasted });
  await pressKey("Enter", "Enter", 13, "\r");
  check("eingefügter Titel mit viel Leerraum: vollständig, normalisiert gespeichert",
    (await waitFor(`!${shown("title-input")} && document.getElementById("chat-title").textContent === "Anfang Ende"`)) &&
    (await serverConversations(cookie)).find(c => c.id === idA)?.title === "Anfang Ende");
}

async function openDrawer() {
  await js(`document.getElementById("menu").click()`);
  await waitFor(`document.getElementById("sidebar").dataset.open === "true"`);
  await Bun.sleep(300);
}

/**
 * Seitenleiste und Telegram-Verlauf im Demo-Modus, je 1280 und 390 px.
 * Die Demo liefert Direktchat (120 Nachrichten), vier aktuelle (darunter Pipeline mit Meldungen, Issue #47) und zwei ältere
 * Topics (src/web/demo.ts). Erwartet die EventSource-Mitschrift window.__sources.
 */
async function telegramChecks() {
  // fetch mitzählen, damit sich „Filter ohne Serveranfrage" prüfen lässt
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const original = window.fetch;
    window.__fetches = 0;
    window.fetch = function (...args) { window.__fetches++; return original.apply(this, args); };
  })()` });
  const demoUrl = `${demo.server.url}/`;
  for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
    const label = `Telegram ${size.width} px`;
    await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1 });
    await goto(demoUrl);
    await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
    await goto(demoUrl);
    await waitFor(`document.querySelector(".msg-assistant table") && document.querySelectorAll("#topic-list .conversation").length > 0`);

    // Gruppen
    if (size.mobile) await openDrawer();
    check(`${label}: Gruppen Direktchat, Topics, Web-Gespräche sichtbar`,
      (await js<boolean>(`${shown("dm-group")} && ${shown("topic-group")} && ${shown("web-group")}`)) &&
      (await entryCount("dm-list")) === 1 && (await entryCount("conversation-list")) === 2);
    check(`${label}: aktuelle Topics oben, ältere eingeklappt`,
      JSON.stringify(await entryTitles("topic-list")) === JSON.stringify(["Recherche", "Pipeline", "Finanzen", "Strategie"]) &&
      (await js<string>(`document.getElementById("older-label").textContent`)) === "Ältere Topics (2)" &&
      (await js<string>(`document.getElementById("older-toggle").getAttribute("aria-expanded")`)) === "false" &&
      !(await js<boolean>(shown("older-list"))), (await entryTitles("topic-list")).join(", "));
    check(`${label}: Topic mit Agent und letzter Aktivität`,
      await js<boolean>(`(() => { const m = document.querySelector('.conversation[data-id="topic-443"] .conversation-meta');
        return m.dataset.agent === "research" && m.textContent.includes("Research") && /^vor [5-9] Min\.$/.test(m.querySelector(".conversation-time").textContent); })()`),
      await js<string>(`document.querySelector('.conversation[data-id="topic-443"] .conversation-meta').textContent`));
    if (size.mobile) check(`${label}: Schublade offen, kein horizontales Scrollen`, await noHorizontalScroll(size.width));

    // Einklappen per Tastatur
    await js(`document.getElementById("older-toggle").focus()`);
    await pressKey("Enter", "Enter", 13, "\r");
    check(`${label}: Enter klappt ältere Topics auf, aria-expanded true`,
      (await waitFor(shown("older-list"), 2000)) && (await js<string>(`document.getElementById("older-toggle").getAttribute("aria-expanded")`)) === "true" &&
      JSON.stringify(await entryTitles("older-list")) === JSON.stringify(["Archiv <alt> & Co", "General"]));
    check(`${label}: Titel mit Sonderzeichen als Text`, await js<boolean>(`!document.querySelector("#older-list b, #older-list alt")`));
    await pressKey(" ", "Space", 32, " ");
    check(`${label}: Leertaste klappt wieder ein`, await waitFor(`!${shown("older-list")}`, 2000));

    // Filter ohne Serveranfrage
    const fetchesBefore = await js<number>(`window.__fetches`);
    const filter = async (text: string) =>
      js(`(() => { const f = document.getElementById("conversation-filter"); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event("input")); })()`);
    await filter("fin");
    check(`${label}: Filter „fin" zeigt nur Finanzen`,
      JSON.stringify(await js<string[]>(`[...document.querySelectorAll(".conversation")].filter(b => b.getClientRects().length).map(b => b.querySelector(".conversation-title").textContent)`)) === JSON.stringify(["Finanzen"]));
    await filter("archiv");
    check(`${label}: Filter findet eingeklappte ältere Topics`, (await js<boolean>(shown("older-list"))) && JSON.stringify(await entryTitles("older-list")) === JSON.stringify(["Archiv <alt> & Co"]));
    await filter("xyz");
    check(`${label}: Filter ohne Treffer meldet das`, await js<boolean>(shown("filter-empty")));
    await filter("");
    check(`${label}: Filter ohne Serveranfrage`, (await js<number>(`window.__fetches`)) === fetchesBefore, `${fetchesBefore} vorher`);

    // Direktchat öffnen: 50 Nachrichten, Eingabe frei, eigener Ereignisstrom
    const sourcesBefore = await js<number>(`window.__sources.length`);
    await clickEntry("dm");
    check(`${label}: Direktchat geöffnet, 50 Nachrichten`,
      (await waitFor(`document.querySelectorAll(".msg").length === 50 && document.getElementById("chat-title").textContent === "Direktchat"`)) &&
      (await js<string>(`document.getElementById("agent-name").textContent`)) === "General");
    if (size.mobile) check(`${label}: Schublade nach der Wahl zu`, await waitFor(`document.getElementById("sidebar").dataset.open === "false"`));
    check(`${label}: Eingabe frei mit Platzhalter „Nachricht an Direktchat"`,
      await js<boolean>(`(() => { const i = document.getElementById("input"); return !i.disabled && i.placeholder === "Nachricht an Direktchat" && document.getElementById("send").disabled; })()`));
    // Der Sammelstrom der Seitenleiste (Issue #20) bleibt dabei offen
    check(`${label}: Ereignisstrom für den Direktchat offen, Web-Strom geschlossen`,
      await waitFor(`window.__sources.length === ${sourcesBefore + 1} && window.__sources.at(-1).url.endsWith("/api/conversations/dm/events") && window.__sources.at(-1).readyState !== 2 && window.__sources.slice(0, -1).filter(s => !s.url.endsWith("/api/telegram/events")).every(s => s.readyState === 2) && window.__sources.some(s => s.url.endsWith("/api/telegram/events") && s.readyState !== 2)`));
    check(`${label}: Antworten mit eigenem Sprecher`,
      await js<boolean>(`!!document.querySelector('.msg-assistant .msg-head[data-agent="research"]') && !!document.querySelector('.msg-assistant .msg-head[data-agent="general"]')`));
    check(`${label}: Verlauf beim Öffnen unten`,
      await js<boolean>(`(() => { const l = document.getElementById("chat-log"); return l.scrollHeight - l.scrollTop - l.clientHeight < 5; })()`));
    check(`${label}: kein horizontales Scrollen im Telegram-Verlauf`, await noHorizontalScroll(size.width));

    // Nachladen: dieselbe Nachricht bleibt an derselben Stelle
    await js(`document.getElementById("chat-log").scrollTop = 0`);
    await Bun.sleep(100);
    check(`${label}: „Ältere Nachrichten laden" oben sichtbar`, await js<boolean>(shown("load-older")));
    const anchor = await js<string>(`document.querySelector(".msg").dataset.id`);
    const before1 = await offsetOf(anchor);
    await js(`document.getElementById("load-older").click(); document.getElementById("load-older").click()`);
    await waitFor(`document.querySelectorAll(".msg").length === 100 && !document.getElementById("load-older").disabled`);
    await Bun.sleep(150);
    const after1 = await offsetOf(anchor);
    check(`${label}: Nachladen stellt 50 ältere voran, Position stabil`,
      (await count(".msg")) === 100 && Math.abs(after1 - before1) <= 2, `${anchor}: ${before1.toFixed(1)} -> ${after1.toFixed(1)} px`);
    await js(`document.getElementById("chat-log").scrollTop = 0`);
    await Bun.sleep(100);
    const anchor2 = await js<string>(`document.querySelector(".msg").dataset.id`);
    const before2 = await offsetOf(anchor2);
    await js(`document.getElementById("load-older").click()`);
    await waitFor(`document.querySelectorAll(".msg").length === 120`);
    await Bun.sleep(150);
    const after2 = await offsetOf(anchor2);
    const ids = await js<string[]>(`[...document.querySelectorAll(".msg")].map(m => m.dataset.id)`);
    check(`${label}: zweites Nachladen bis zum Anfang, Knopf weg, Position stabil`,
      ids.length === 120 && new Set(ids).size === 120 && ids[0] === "dm-0" && ids[119] === "dm-119" &&
      !(await js<boolean>(shown("load-older"))) && Math.abs(after2 - before2) <= 2,
      `${anchor2}: ${before2.toFixed(1)} -> ${after2.toFixed(1)} px`);

    // Neu laden: zuletzt geöffnetes Gespräch
    await goto(demoUrl);
    check(`${label}: nach Neuladen wieder der Direktchat`,
      await waitFor(`document.getElementById("chat-title").textContent === "Direktchat" && document.querySelectorAll(".msg").length === 50`));

    // In ein Topic schreiben (Issue #19): Nachricht sofort, Fortschritt, Antwort der Attrappe
    if (size.mobile) await openDrawer();
    await clickEntry("topic-443");
    await waitFor(`document.getElementById("chat-title").textContent === "Recherche" && document.getElementById("input").placeholder === "Nachricht an Recherche" && document.querySelectorAll(".msg").length === 4`);
    const topicBefore = await count(".msg");
    await js(`(() => { const i = document.getElementById("input"); i.value = "Frage aus dem Browser"; i.dispatchEvent(new Event("input")); })()`);
    await js(`document.getElementById("send").click()`);
    check(`${label}: Topic: eigene Nachricht sofort, Stopp statt Senden`,
      (await waitFor(`document.querySelectorAll(".msg").length === ${topicBefore + 1} && [...document.querySelectorAll(".msg-user .bubble")].at(-1).textContent === "Frage aus dem Browser"`)) &&
      (await waitFor(`${shown("stop")} && !${shown("send")}`, 2000)));
    check(`${label}: Topic: Antwort kommt live, Stopp wieder weg, keine Doppelungen`,
      (await waitFor(`document.querySelectorAll(".msg").length === ${topicBefore + 2} && document.getElementById("activity").hidden`, 8000)) &&
      (await js<boolean>(`(() => { const ids = [...document.querySelectorAll(".msg")].map(m => m.dataset.id); return new Set(ids).size === ids.length && /^web-/.test(ids.at(-1)); })()`)));

    // Zurück ins Web-Gespräch: Eingabe frei, Strom offen
    if (size.mobile) await openDrawer();
    const sourcesBack = await js<number>(`window.__sources.length`);
    await js(`document.querySelectorAll("#conversation-list .conversation")[0].click()`);
    check(`${label}: zurück im Web-Gespräch, Eingabe frei, Ereignisstrom offen`,
      (await waitFor(`document.querySelector(".msg-assistant table")`)) &&
      (await waitFor(`window.__sources.length === ${sourcesBack + 1} && window.__sources.at(-1).readyState !== 2`)) &&
      (await js<boolean>(`!document.getElementById("input").disabled && document.getElementById("input").placeholder === ${JSON.stringify(`Nachricht an ${BRAND.name}`)}`)));
    await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
  }
}

async function apiMessages(cookie: string): Promise<any[]> {
  const list = await (await fetch(`${base}/api/conversations`, { headers: { cookie } })).json();
  const id = list.conversations[0].id;
  return (await (await fetch(`${base}/api/conversations/${id}/messages`, { headers: { cookie } })).json()).messages;
}

/**
 * Nachrichten aus Telegram live (Issue #20), je 1280 und 390 px, mit eigener
 * Demo: Nachricht und Antwort erscheinen im offenen Topic ohne Neuladen, ein
 * anderes Topic bekommt Aktivität und Neu-Punkt, Öffnen entfernt ihn.
 */
async function liveChecks() {
  const liveDemo = await startDemoServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
  );
  const url = `${liveDemo.server.url}/`;
  const texts = () => js<string[]>(`[...document.querySelectorAll(".msg")].map(m => m.textContent)`);
  try {
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Live ${size.width} px`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1 });
      await goto(url);
      await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-12")`);
      await goto(url);
      await waitFor(`document.getElementById("chat-title").textContent === "Finanzen" && document.querySelectorAll(".msg").length > 0`);
      // Beide Ströme brauchen einen Moment zum Verbinden
      await Bun.sleep(400);
      const before = await count(".msg");
      liveDemo.receiveTelegram("topic-12", "user", `Frage aus Telegram ${size.width}`);
      liveDemo.receiveTelegram("topic-12", "assistant", `**Antwort** aus Telegram ${size.width}`, "finance");
      check(`${label}: Nachricht und Antwort erscheinen ohne Neuladen`,
        await waitFor(`document.querySelectorAll(".msg").length === ${before + 2}`, 3000),
        `${await count(".msg")} statt ${before + 2}`);
      check(`${label}: Antwort als gerendertes Markdown mit Agent`,
        await js<boolean>(`(() => { const m = [...document.querySelectorAll(".msg-assistant")].at(-1); return !!m && !!m.querySelector("strong") && m.textContent.includes("Finance"); })()`));

      liveDemo.receiveTelegram("topic-443", "user", `Nachricht in Recherche ${size.width}`);
      check(`${label}: anderes Topic bekommt den Neu-Punkt`,
        await waitFor(`document.querySelector('.conversation[data-id="topic-443"][data-unread="true"] .unread-dot')`, 3000));
      check(`${label}: offenes Topic ohne Punkt, Inhalt des anderen nicht im Verlauf`,
        (await count(`.conversation[data-id="topic-12"] .unread-dot`)) === 0 &&
        !(await texts()).some(t => t.includes("Nachricht in Recherche")));
      check(`${label}: Topic mit neuer Nachricht steht oben, Zeit „gerade eben"`,
        (await js<string>(`document.querySelector("#topic-list .conversation").dataset.id`)) === "topic-443" &&
        (await js<string>(`document.querySelector('.conversation[data-id="topic-443"] .conversation-time').textContent`)) === "gerade eben");
      check(`${label}: Punkt neutral in Textfarbe, nicht Akzentblau`,
        await js<boolean>(`getComputedStyle(document.querySelector(".unread-dot")).backgroundColor === getComputedStyle(document.body).color`),
        await js<string>(`getComputedStyle(document.querySelector(".unread-dot")).backgroundColor`));
      if (size.mobile) await openDrawer();
      await clickEntry("topic-443");
      check(`${label}: Öffnen entfernt den Punkt und zeigt die Nachricht genau einmal`,
        (await waitFor(`document.getElementById("chat-title").textContent === "Recherche" && [...document.querySelectorAll(".msg")].some(m => m.textContent.includes("Nachricht in Recherche ${size.width}"))`, 3000)) &&
        (await count(`.conversation[data-id="topic-443"] .unread-dot`)) === 0 &&
        (await texts()).filter(t => t.includes(`Nachricht in Recherche ${size.width}`)).length === 1);
      await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
    }
  } finally {
    await liveDemo.stop();
  }
}

/**
 * Meldungen und Dateien (Issue #47), je 1280 und 390 px, hell und (mit
 * --screenshots) dunkel: Topic „Pipeline" der Demo mit Meldung, Bild und
 * HTML-Report. Absender ohne Blase, Markdown, Dateikarte, Vorschau geladen,
 * Download als Anhang, HTML-Vorschau mit Sandbox; eine Meldung „aus einem anderen
 * Prozess" erscheint ohne Neuladen, ein anderes Topic bekommt den Neu-Punkt.
 */
async function noticeChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  for (const scheme of schemes) {
    await emulateScheme(scheme as "light" | "dark");
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Meldungen ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const noticeDemo = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
      );
      try {
        const url = `${noticeDemo.server.url}/`;
        await goto(url);
        await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-60")`);
        await goto(url);
        check(`${label}: drei Meldungen im Topic Pipeline`,
          await waitFor(`document.getElementById("chat-title").textContent === "Pipeline" && document.querySelectorAll(".msg-notice").length === 3`),
          `${await count(".msg-notice")}`);
        check(`${label}: Absender oben, keine Blase, kein Agentenkopf`,
          JSON.stringify(await js<string[]>(`[...document.querySelectorAll(".msg-notice .notice-source")].map(e => e.textContent)`)) === JSON.stringify(["Pipeline", "Datei", "Datei"]) &&
          (await count(".msg-notice .bubble, .msg-notice .msg-head")) === 0 &&
          (await js<boolean>(`[...document.querySelectorAll(".msg-notice .notice-time")].every(t => /^\\d{2}:\\d{2}$/.test(t.textContent))`)));
        check(`${label}: Text als Markdown, ohne Fläche`,
          await js<boolean>(`(() => { const b = document.querySelector(".msg-notice .notice-body"); const cs = getComputedStyle(b);
            return !!b.querySelector("strong") && !!b.querySelector("li") && cs.backgroundColor === "rgba(0, 0, 0, 0)" && cs.color === getComputedStyle(document.querySelector(".notice-source")).color; })()`));
        check(`${label}: zwei Dateikarten mit Name, Größe und Herunterladen`,
          (await count(".file-card")) === 2 &&
          (await js<boolean>(`[...document.querySelectorAll(".file-card")].every(c => c.querySelector(".file-name").textContent && /\\d/.test(c.querySelector(".file-size").textContent) && c.querySelector("a.file-download").textContent === "Herunterladen")`)));
        check(`${label}: Bildvorschau geladen, HTML ohne Vorschau`,
          (await waitFor(`(() => { const i = document.querySelector("img.file-preview"); return !!i && i.complete && i.naturalWidth > 0; })()`, 4000)) &&
          (await count("img.file-preview")) === 1);
        const headers = await js<string[]>(`Promise.all([...document.querySelectorAll("a.file-download")].map(a =>
          fetch(a.href + "?inline=1").then(r => r.headers.get("content-disposition").split(";")[0] + " " + r.headers.get("content-type"))))`);
        const htmlSandbox = await js<boolean>(`fetch([...document.querySelectorAll("a.file-download")][1].href + "?inline=1").then(r => {
          const policy = r.headers.get("content-security-policy") || "";
          return policy.startsWith("sandbox ") && !policy.includes("allow-same-origin");
        })`);
        check(`${label}: HTML-Report als isolierte Vorschau, Bild inline`,
          JSON.stringify(headers) === JSON.stringify(["inline image/png", "inline text/html; charset=utf-8"]) && htmlSandbox, headers.join(" | "));
        const plain = await js<string[]>(`Promise.all([...document.querySelectorAll("a.file-download")].map(a =>
          fetch(a.href).then(r => r.headers.get("content-disposition").split(";")[0])))`);
        check(`${label}: Herunterladen liefert immer einen Anhang`, plain.every(v => v === "attachment"), plain.join(", "));
        check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
        if (size.mobile) {
          const h = await js<number>(`document.querySelector("a.file-download").getBoundingClientRect().height`);
          check(`${label}: Herunterladen mit 44 px Tippfläche`, h >= 44, `${h} px`);
        }
        await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
        await shoot(`meldungen-${size.width}${suffix}`);

        // Meldung aus einem anderen Prozess: live, ohne Neuladen
        await Bun.sleep(400);
        noticeDemo.receiveNotice("topic-60", "watchdog", "**Watchdog:** alle Dienste laufen");
        check(`${label}: neue Meldung erscheint ohne Neuladen`,
          await waitFor(`document.querySelectorAll(".msg-notice").length === 4 && [...document.querySelectorAll(".notice-source")].at(-1).textContent === "Watchdog"`, 3000));
        noticeDemo.receiveNotice("topic-12", "briefing", "Morgen-Briefing ist da");
        check(`${label}: anderes Topic bekommt den Neu-Punkt, Inhalt nicht im offenen`,
          (await waitFor(`document.querySelector('.conversation[data-id="topic-12"][data-unread="true"] .unread-dot')`, 3000)) &&
          !(await js<boolean>(`document.getElementById("chat-log").textContent.includes("Morgen-Briefing")`)));
        await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
      } finally {
        await noticeDemo.stop();
      }
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

/**
 * Befehlsliste und Befehls-Rückmeldungen (Issue #77), je 1280 und 390 px,
 * hell und (mit --screenshots) dunkel, gegen die Befehls-Attrappe der Demo:
 * „/" öffnet die Liste über der Eingabe, „/bo" filtert auf /board, Enter
 * (Desktop) bzw. Antippen (Handy) übernimmt ohne zu senden, Escape schließt,
 * /new erscheint als Meldung „Befehl", /board als Fehlerkasten, normaler
 * Text geht wie bisher raus.
 */
async function commandChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const setInput = (value: string) =>
    js(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input")); })()`);
  const listShown = () => js<boolean>(shown("command-list"));
  const optionNames = () => js<string[]>(`[...document.querySelectorAll("#command-list .command-name")].map(e => e.textContent)`);
  const inputValue = () => js<string>(`document.getElementById("input").value`);
  const msgCount = () => count("#messages .msg");
  for (const scheme of schemes) {
    await emulateScheme(scheme as "light" | "dark");
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Befehle ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const commandDemo = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
      );
      try {
        const url = `${commandDemo.server.url}/`;
        await goto(url);
        // Beispiel-Unterhaltung (Web-Gespräch): Meldungen bleiben dort im Verlauf
        const webId = await js<string>(`fetch("/api/conversations").then(r => r.json()).then(d => d.conversations[0].id)`);
        await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, ${JSON.stringify(webId)})`);
        await goto(url);
        await waitFor(`!document.getElementById("input").disabled`);
        await js(`document.getElementById("input").focus()`);
        await cdp("Input.insertText", { text: "/" });
        check(`${label}: „/" öffnet die Liste mit allen Befehlen des Servers`,
          (await waitFor(`document.querySelectorAll("#command-list .command-option").length >= 10`)) && (await listShown()),
          (await optionNames()).join(" "));
        const layout = await js<{ above: boolean; minHeight: number; hasDesc: boolean }>(`(() => {
          const l = document.getElementById("command-list").getBoundingClientRect();
          const box = document.querySelector(".composer-box").getBoundingClientRect();
          const opts = [...document.querySelectorAll("#command-list .command-option")];
          return { above: l.bottom <= box.top + 1, minHeight: Math.min(...opts.map(o => o.getBoundingClientRect().height)),
            hasDesc: opts.every(o => o.querySelector(".command-desc")?.textContent) };
        })()`);
        check(`${label}: Liste über dem Feld, Kurzbeschreibung, Tippflächen mindestens 44 px`,
          layout.above && layout.hasDesc && layout.minHeight >= 44, JSON.stringify(layout));
        check(`${label}: Liste scrollt innen, Seite nicht seitlich`,
          (await js<boolean>(`(() => { const l = document.getElementById("command-list"); return l.clientHeight <= window.innerHeight * 0.45; })()`)) &&
          (await noHorizontalScroll(size.width)));
        await shoot(`befehle-liste-${size.width}${suffix}`);

        // Überlange Liste: die Markierung bleibt im sichtbaren Ausschnitt, auch beim Umlauf
        const selectedVisible = () => js<{ index: number; visible: boolean; overlong: boolean }>(`(() => {
          const l = document.getElementById("command-list");
          const opts = [...l.querySelectorAll(".command-option")];
          const index = opts.findIndex(o => o.getAttribute("aria-selected") === "true");
          const lr = l.getBoundingClientRect(), r = opts[index].getBoundingClientRect();
          return { index, visible: r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1, overlong: l.scrollHeight > l.clientHeight };
        })()`);
        const navBefore = await msgCount();
        const total = (await optionNames()).length;
        await pressKey("ArrowUp", "ArrowUp", 38);
        const up = await selectedVisible();
        check(`${label}: Pfeil nach oben vom ersten Eintrag wählt den letzten und zeigt ihn`,
          up.overlong && up.index === total - 1 && up.visible, JSON.stringify(up));
        await pressKey("ArrowDown", "ArrowDown", 40);
        const wrap = await selectedVisible();
        check(`${label}: Pfeil nach unten vom letzten springt sichtbar zum ersten`, wrap.index === 0 && wrap.visible, JSON.stringify(wrap));
        let downOk = true;
        for (let i = 1; i < total; i++) {
          await pressKey("ArrowDown", "ArrowDown", 40);
          const s = await selectedVisible();
          if (s.index !== i || !s.visible) { downOk = false; break; }
        }
        let upOk = true;
        for (let i = total - 2; i >= 0; i--) {
          await pressKey("ArrowUp", "ArrowUp", 38);
          const s = await selectedVisible();
          if (s.index !== i || !s.visible) { upOk = false; break; }
        }
        await Bun.sleep(200);
        check(`${label}: Pfeiltasten durch die ganze Liste in beide Richtungen, Markierung stets sichtbar, kein Senden`,
          downOk && upOk && (await listShown()) && (await inputValue()) === "/" && (await msgCount()) === navBefore,
          JSON.stringify({ downOk, upOk }));

        await cdp("Input.insertText", { text: "bo" });
        check(`${label}: „/bo" zeigt nur /board`,
          await waitFor(`JSON.stringify([...document.querySelectorAll("#command-list .command-name")].map(e => e.textContent)) === '["/board"]'`),
          (await optionNames()).join(" "));
        await shoot(`befehle-filter-${size.width}${suffix}`);
        const before = await msgCount();
        if (size.mobile) {
          // Antippen: Maus-Ereignisse auf den Eintrag, Fokus bleibt in der Eingabe
          const at = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector("#command-list .command-option").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
          await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
        } else {
          await pressKey("Enter", "Enter", 13, "\r");
        }
        await Bun.sleep(300);
        check(`${label}: ${size.mobile ? "Antippen" : "Enter"} übernimmt „/board " ins Feld, ohne zu senden`,
          (await inputValue()) === "/board " && !(await listShown()) && (await msgCount()) === before &&
          (await js<boolean>(`document.activeElement === document.getElementById("input")`)),
          JSON.stringify(await inputValue()));

        await setInput("/ne");
        await waitFor(shown("command-list"));
        await pressKey("Escape", "Escape", 27);
        check(`${label}: Escape schließt ohne Senden, Text bleibt`,
          !(await listShown()) && (await inputValue()) === "/ne" && (await msgCount()) === before);

        await setInput("/new");
        await pressKey("Escape", "Escape", 27);
        // Enter sendet auch bei 390 px (die Emulation hat keinen Touch-Zeiger)
        await pressKey("Enter", "Enter", 13, "\r");
        check(`${label}: /new erscheint als Meldung „Befehl" ohne Blase`,
          await waitFor(`(() => { const n = [...document.querySelectorAll("#messages .msg-notice")].at(-1);
            return !!n && n.querySelector(".notice-source").textContent === "Befehl" && !n.querySelector(".bubble") && n.textContent.includes("Neue Session gestartet"); })()`, 4000));

        // Der Befehl gilt kurz als laufend; erst senden, wenn der Knopf wieder bereit ist
        await waitFor(idleButtons, 4000);
        await setInput("/board Preise");
        await waitFor(`!document.getElementById("send").disabled`);
        if (size.mobile) await js(`document.getElementById("send").click()`);
        else await pressKey("Enter", "Enter", 13, "\r");
        check(`${label}: /board ohne Board-Sitzungen zeigt den Fehlerkasten`,
          await waitFor(`(() => { const e = [...document.querySelectorAll("#messages .msg-error")].at(-1);
            return !!e && e.textContent.includes("Board-Sitzungen sind hier nicht eingerichtet."); })()`, 4000),
          (await js<string[]>(`[...document.querySelectorAll("#messages .msg")].slice(-3).map(m => m.className + ": " + m.textContent.slice(0, 60))`)).join(" | "));
        // /voice (Issue #78): Liste zeigt den Befehl, Antwort als Blase, danach die Meldung „Befehl"
        await waitFor(idleButtons, 4000);
        await setInput("/vo");
        check(`${label}: „/vo" zeigt /voice mit Kurzbeschreibung`,
          await waitFor(`JSON.stringify([...document.querySelectorAll("#command-list .command-name")].map(e => e.textContent)) === '["/voice"]'`),
          (await optionNames()).join(" "));
        await pressKey("Escape", "Escape", 27);
        const bubblesBefore = await count("#messages .msg-assistant .bubble");
        await setInput("/voice Wie wird das Wetter?");
        await waitFor(`!document.getElementById("send").disabled`);
        if (size.mobile) await js(`document.getElementById("send").click()`);
        else await pressKey("Enter", "Enter", 13, "\r");
        check(`${label}: /voice zeigt die Antwort als Text und danach „Sprachnachricht in Telegram gesendet."`,
          await waitFor(`(() => { const msgs = [...document.querySelectorAll("#messages .msg")];
            const n = msgs.at(-1), a = msgs.at(-2);
            return !!n && n.classList.contains("msg-notice") && n.querySelector(".notice-source")?.textContent === "Befehl" &&
              n.textContent.includes("Sprachnachricht in Telegram gesendet.") &&
              !!a && !!a.querySelector(".bubble") && a.textContent.includes("Wie wird das Wetter?") &&
              document.querySelectorAll("#messages .msg-assistant .bubble").length === ${bubblesBefore + 1}; })()`, 4000),
          (await js<string[]>(`[...document.querySelectorAll("#messages .msg")].slice(-5).map(m => m.className + ": " + m.textContent.slice(0, 60))`)).join(" | "));
        await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
        await shoot(`befehle-rueckmeldung-${size.width}${suffix}`);

        const users = await count("#messages .msg-user");
        await waitFor(idleButtons, 4000);
        await setInput("Hallo ohne Befehl");
        await waitFor(`!document.getElementById("send").disabled`);
        if (size.mobile) await js(`document.getElementById("send").click()`);
        else await pressKey("Enter", "Enter", 13, "\r");
        check(`${label}: normaler Text geht wie bisher raus`,
          (await waitFor(`document.querySelectorAll("#messages .msg-user").length === ${users + 1}`, 4000)) && !(await listShown()));
        await turnDone();
        await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
      } finally {
        await commandDemo.stop();
      }
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

/**
 * Anhänge (Issue #73), je 1280 und 390 px, hell und (mit --screenshots)
 * dunkel, gegen die Demo mit eigener Upload-Ablage: Büroklammer links in der
 * Box, Dateiauswahl, Einfügen eines Bildes (ClipboardEvent), /b64 mit
 * Base64-Code, Ziehen mit ruhiger Markierung, Chips mit Vorschau (data:, die
 * CSP lässt sie zu), Senden lädt hoch und zeigt die Anhänge an der eigenen
 * Nachricht, auch nach dem Neuladen; ungültiger Code sendet nichts; in
 * älteren Web-Gesprächen keine Büroklammer. Die Sprachaufnahme (Issue #109)
 * prüft recordingChecks.
 */
async function attachmentChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  // Bild aus einer Leinwand: echte, dekodierbare PNG-Daten für Vorschau und Server-Prüfung
  const pngBlob = `((w, h, color) => new Promise(r => { const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"); x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = "rgba(255,255,255,0.85)";
    x.fillRect(w * 0.08, h * 0.1, w * 0.6, h * 0.12); x.fillRect(w * 0.08, h * 0.3, w * 0.8, h * 0.08); x.fillRect(w * 0.08, h * 0.45, w * 0.7, h * 0.08);
    c.toBlob(b => r(b), "image/png"); }))`;
  const chipCount = () => count("#attachments .attachment-chip");
  const inputValue = () => js<string>(`document.getElementById("input").value`);
  const note = () => js<string>(`(() => { const n = document.getElementById("attach-note"); return n.hidden ? "" : n.textContent; })()`);
  for (const scheme of schemes) {
    await emulateScheme(scheme as "light" | "dark");
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Anhänge ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const attachDemo = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat({ delayMs: 200, stepMs: 50 }), telegramChat: createFakeChat({ delayMs: 200, stepMs: 50 }), log: () => {} }
      );
      try {
        const url = `${attachDemo.server.url}/`;
        await goto(url);
        await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-443")`);
        await goto(url);
        await waitFor(`!document.getElementById("input").disabled && document.querySelectorAll("#messages .msg").length > 0`);

        const layout = await js<{ shown: boolean; left: boolean; inside: boolean; size: number }>(`(() => {
          const a = document.getElementById("attach"), t = document.getElementById("input"), box = document.querySelector(".composer-box");
          const ar = a.getBoundingClientRect(), tr = t.getBoundingClientRect(), br = box.getBoundingClientRect();
          return { shown: !a.hidden && ar.width > 0, left: ar.right <= tr.left + 1, inside: ar.left >= br.left && ar.bottom <= br.bottom,
            size: Math.round(Math.min(ar.width, ar.height)) };
        })()`);
        check(`${label}: Büroklammer links in der Eingabebox, Tippfläche ${size.mobile ? "44" : "36"} px`,
          layout.shown && layout.left && layout.inside && layout.size >= (size.mobile ? 44 : 36), JSON.stringify(layout));

        // Büroklammer: Dateiauswahl (der Dialog selbst lässt sich headless nicht bedienen, die Auswahl schon)
        await js(`(async () => {
          const png = await ${pngBlob}(640, 400, "#3b6fb6");
          const dt = new DataTransfer();
          dt.items.add(new File([png], "Bildschirmfoto 2026-09-25.png", { type: "image/png" }));
          dt.items.add(new File([["%PDF-1.4", "1 0 obj<<>>endobj", "trailer<<>>", "%%EOF"].join(String.fromCharCode(10))], "Angebot Heizung.pdf", { type: "application/pdf" }));
          const input = document.getElementById("file-input");
          input.files = dt.files;
          input.dispatchEvent(new Event("change"));
        })()`);
        check(`${label}: Dateiauswahl legt zwei Chips an, Bild mit Vorschau, PDF mit Symbol`,
          await waitFor(`document.querySelectorAll("#attachments .attachment-chip").length === 2 &&
            (() => { const i = document.querySelector("#attachments img.attachment-thumb"); return !!i && i.complete && i.naturalWidth > 0; })() &&
            !!document.querySelector("#attachments .attachment-symbol svg")`),
          String(await chipCount()));

        // Einfügen (Strg/Cmd+V mit einem Screenshot): ClipboardEvent mit Datei
        await js(`(async () => {
          const png = await ${pngBlob}(300, 200, "#2f8f6a");
          const dt = new DataTransfer();
          dt.items.add(new File([png], "image.png", { type: "image/png" }));
          const input = document.getElementById("input");
          input.focus();
          input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        })()`);
        check(`${label}: eingefügtes Bild wird dritter Chip, das Feld bleibt leer`,
          (await waitFor(`document.querySelectorAll("#attachments .attachment-chip").length === 3`)) && (await inputValue()) === "");

        // /b64: Code aus der Leinwand, mit Zeilenumbrüchen eingefügt
        await js(`document.getElementById("input").focus()`);
        await cdp("Input.insertText", { text: "/b64 " });
        await js(`(async () => {
          const png = await ${pngBlob}(200, 120, "#b0409f");
          const code = await new Promise(r => { const f = new FileReader(); f.onload = () => r(String(f.result).split(",")[1]); f.readAsDataURL(png); });
          const dt = new DataTransfer();
          dt.setData("text/plain", code.match(/.{1,76}/g).join(String.fromCharCode(10)));
          window.__b64 = code;
          document.getElementById("input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        })()`);
        check(`${label}: /b64 mit Code wird sofort Bild-Chip „bild.png", der Code verschwindet aus dem Feld`,
          (await waitFor(`document.querySelectorAll("#attachments .attachment-chip").length === 4`)) && (await inputValue()) === "" &&
          (await js<string>(`document.querySelectorAll("#attachments .attachment-name")[3].textContent`)) === "bild.png");

        // Ziehen: ruhige Markierung, Loslassen hängt an
        await js(`(async () => {
          const png = await ${pngBlob}(500, 300, "#9a7a14");
          window.__dragFiles = new DataTransfer();
          window.__dragFiles.items.add(new File([png], "Grundriss.png", { type: "image/png" }));
          document.querySelector("#messages .msg").dispatchEvent(new DragEvent("dragenter", { dataTransfer: window.__dragFiles, bubbles: true, cancelable: true }));
        })()`);
        const marked = await js<{ attr: string | null; outline: string }>(`(() => ({ attr: document.getElementById("main").getAttribute("data-drop"),
          outline: getComputedStyle(document.getElementById("chat-log")).outlineStyle }))()`);
        check(`${label}: Dateien über dem Chat markieren die Fläche gestrichelt`, marked.attr === "true" && marked.outline === "dashed", JSON.stringify(marked));
        await shoot(`anhaenge-ziehen-${size.width}${suffix}`);
        await js(`document.querySelector("#messages .msg").dispatchEvent(new DragEvent("drop", { dataTransfer: window.__dragFiles, bubbles: true, cancelable: true }))`);
        check(`${label}: Loslassen hängt an, Markierung weg`,
          (await waitFor(`document.querySelectorAll("#attachments .attachment-chip").length === 5`)) &&
          (await js<boolean>(`!document.getElementById("main").hasAttribute("data-drop")`)));
        check(`${label}: Chips über der Eingabe, Seite nicht seitlich scrollbar`,
          (await js<boolean>(`document.getElementById("attachments").getBoundingClientRect().bottom <= document.querySelector(".composer-box").getBoundingClientRect().top + 1`)) &&
          (await noHorizontalScroll(size.width)));
        await js(`document.getElementById("input").focus()`);
        await cdp("Input.insertText", { text: "Hier die Unterlagen zur Heizung" });
        await shoot(`anhaenge-chips-${size.width}${suffix}`);

        // Entfernen und sechster Anhang
        await js(`document.querySelectorAll("#attachments .attachment-remove")[4].click()`);
        check(`${label}: Entfernen nimmt den Chip weg`, (await chipCount()) === 4);

        // Senden: erst hochladen, dann die Nachricht mit den IDs
        const users = await count("#messages .msg-user");
        if (size.mobile) await js(`document.getElementById("send").click()`);
        else await pressKey("Enter", "Enter", 13, "\r");
        check(`${label}: Senden lädt hoch und zeigt die Anhänge an der eigenen Nachricht`,
          await waitFor(`document.querySelectorAll("#messages .msg-user").length === ${users + 1} &&
            document.querySelectorAll("#messages .msg-user")[${users}].querySelectorAll(".msg-attachments .file").length === 4`, 8000),
          String(await count("#messages .msg-user")));
        check(`${label}: Chips weg, Feld leer, keine Hinweise`,
          (await chipCount()) === 0 && (await inputValue()) === "" && (await note()) === "");
        const previews = await js<{ loaded: number; srcs: string[] }>(`(async () => {
          const msg = document.querySelectorAll("#messages .msg-user")[${users}];
          const imgs = [...msg.querySelectorAll(".file-preview")];
          await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = r; i.onerror = r; })));
          return { loaded: imgs.filter(i => i.naturalWidth > 0).length, srcs: imgs.map(i => i.getAttribute("src")) };
        })()`);
        check(`${label}: drei Bildvorschauen aus der Anhangsroute geladen, PDF als Karte`,
          previews.loaded === 3 && previews.srcs.every(src => /^\/api\/conversations\/topic-443\/attachments\/[0-9a-f-]{36}\?inline=1$/.test(src)),
          JSON.stringify(previews));
        await turnDone();
        await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
        await shoot(`anhaenge-verlauf-${size.width}${suffix}`);

        // Neuladen: die Nachricht steht mit ihren Anhängen im Verlauf
        await goto(url);
        check(`${label}: nach dem Neuladen stehen die Anhänge weiter an der Nachricht`,
          await waitFor(`[...document.querySelectorAll("#messages .msg-user")].some(m => m.querySelectorAll(".msg-attachments .file").length === 4 &&
            m.textContent.includes("Hier die Unterlagen zur Heizung"))`));

        // Ungültiger Code: Meldung, nichts gesendet, auch nicht als Text
        const before = await count("#messages .msg");
        await js(`(() => { const i = document.getElementById("input"); i.focus(); i.value = "/b64 das ist kaputt!"; i.dispatchEvent(new Event("input")); })()`);
        await js(`document.getElementById("composer").requestSubmit()`);
        await Bun.sleep(300);
        check(`${label}: ungültiger Code zeigt die Meldung und sendet nichts`,
          (await note()) === "Das ist kein gültiger Base64-Code. Nichts gesendet." && (await count("#messages .msg")) === before,
          JSON.stringify({ note: await note(), before, after: await count("#messages .msg"), value: await inputValue() }));
        await shoot(`anhaenge-ungueltig-${size.width}${suffix}`);

        // Reines Web-Gespräch: Büroklammer auch dort (Issue #112, Einzelheiten in webConversationAttachmentChecks)
        const webId = await js<string>(`fetch("/api/conversations").then(r => r.json()).then(d => d.conversations[0].id)`);
        await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, ${JSON.stringify(webId)})`);
        await goto(url);
        await waitFor(`!document.getElementById("input").disabled`);
        check(`${label}: reines Web-Gespräch mit Büroklammer`, await js<boolean>(shown("attach")));
        await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
      } finally {
        await attachDemo.stop();
      }
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

/**
 * Sprachaufnahme im Browser (Issue #109), je 1280 und 390 px, hell und (mit
 * --screenshots) dunkel, gegen die Demo mit Upload-Ablage. Chrome nimmt über
 * sein Attrappen-Mikrofon auf (Piepton, Freigabe ohne Dialog). Geprüft:
 * Mikrofon rechts vor Senden; ohne sicheren Kontext (isSecureContext wie an
 * der LAN-IP über http) kein Knopf; Aufnahme mit Punkt, Zeit, Verwerfen und
 * Stopp; Verwerfen gibt das Mikrofon frei; Stopp erzeugt einen WebM-Chip,
 * der über die CSP (media-src blob:) wirklich abspielt; Senden lädt über die
 * echte Route hoch und die Nachricht zeigt die Sprachdatei. Einmal zusätzlich
 * mit MP4 (WebM abgeschaltet, wie Safari), damit auch die MP4-Aufnahme die
 * Typprüfung des Servers besteht.
 */
async function recordingChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const note = () => js<string>(`(() => { const n = document.getElementById("attach-note"); return n.hidden ? "" : n.textContent; })()`);
  // Spuren aller Mikrofon-Streams mitschreiben, um ihre Freigabe zu prüfen
  const trackSpy = `(() => {
    if (window.__tracks) return;
    window.__tracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async c => { const s = await original(c); window.__tracks.push(...s.getTracks()); return s; };
  })()`;
  const tracksEnded = () => js<boolean>(`window.__tracks.length > 0 && window.__tracks.every(t => t.readyState === "ended")`);
  async function openTopic(url: string, options: { insecure?: boolean; mp4?: boolean } = {}) {
    const scripts: string[] = [];
    if (options.insecure) scripts.push(`Object.defineProperty(window, "isSecureContext", { value: false })`);
    if (options.mp4) scripts.push(`(() => { const t = MediaRecorder.isTypeSupported.bind(MediaRecorder); MediaRecorder.isTypeSupported = x => !/webm/.test(x) && t(x); })()`);
    const ids: string[] = [];
    for (const source of scripts) ids.push((await cdp("Page.addScriptToEvaluateOnNewDocument", { source })).identifier);
    await goto(url);
    await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-443")`);
    await goto(url);
    await waitFor(`!document.getElementById("input").disabled && document.querySelectorAll("#messages .msg").length > 0`);
    for (const identifier of ids) await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await js(trackSpy);
  }
  async function recordFor(ms: number) {
    await js(`document.getElementById("record").click()`);
    const started = await waitFor(shown("recorder"), 5000);
    await Bun.sleep(ms);
    return started;
  }

  for (const scheme of schemes) {
    await emulateScheme(scheme as "light" | "dark");
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Aufnahme ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const recDemo = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat({ delayMs: 200, stepMs: 50 }), telegramChat: createFakeChat({ delayMs: 200, stepMs: 50 }), log: () => {} }
      );
      try {
        const url = `${recDemo.server.url}/`;

        // Ohne sicheren Kontext (http an der LAN-IP): kein Mikrofon, Büroklammer bleibt
        await openTopic(url, { insecure: true });
        check(`${label}: ohne sicheren Kontext kein Mikrofon, Büroklammer da`,
          (await js<boolean>(`document.getElementById("record").hidden`)) && (await js<boolean>(shown("attach"))));

        await openTopic(url);
        const layout = await js<{ shown: boolean; right: boolean; beforeSend: boolean; size: number }>(`(() => {
          const r = document.getElementById("record").getBoundingClientRect(), t = document.getElementById("input").getBoundingClientRect(),
            s = document.getElementById("send").getBoundingClientRect();
          return { shown: !document.getElementById("record").hidden && r.width > 0, right: r.left >= t.right - 1, beforeSend: r.right <= s.left + 1,
            size: Math.round(Math.min(r.width, r.height)) };
        })()`);
        check(`${label}: Mikrofon rechts neben dem Feld vor Senden, Tippfläche ${size.mobile ? "44" : "36"} px`,
          layout.shown && layout.right && layout.beforeSend && layout.size >= (size.mobile ? 44 : 36), JSON.stringify(layout));
        await shoot(`aufnahme-knopf-${size.width}${suffix}`);

        // Verwerfen: kein Chip, Mikrofon frei
        check(`${label}: Antippen startet die Aufnahme (Zeile statt Feld)`, await recordFor(300));
        await js(`document.getElementById("recorder-discard").click()`);
        check(`${label}: Verwerfen ohne Chip, alle Spuren beendet, Feld wieder da`,
          (await waitFor(`!(${shown("recorder")}) && ${shown("input")}`)) && (await count("#attachments .attachment-chip")) === 0 && (await tracksEnded()));

        // Aufnahme läuft: Punkt, Zeit, Verwerfen, Stopp; Zeit zählt
        await recordFor(2300);
        const running = await js<{ time: string; dot: string; stop: boolean; discard: boolean; input: boolean; send: boolean; rows: number }>(`(() => ({
          time: document.getElementById("recorder-time").textContent,
          dot: getComputedStyle(document.querySelector(".recorder-dot")).backgroundColor,
          stop: ${shown("recorder-stop")}, discard: ${shown("recorder-discard")}, input: ${shown("input")}, send: ${shown("send")},
          rows: Math.round(document.querySelector(".composer-box").getBoundingClientRect().height) }))()`);
        check(`${label}: Aufnahme zeigt Punkt, laufende Zeit, Verwerfen und Stopp; Feld und Senden weg`,
          /^00:0[2-3]$/.test(running.time) && running.stop && running.discard && !running.input && !running.send, JSON.stringify(running));
        check(`${label}: Seite nicht seitlich scrollbar während der Aufnahme`, await noHorizontalScroll(size.width));
        await shoot(`aufnahme-laeuft-${size.width}${suffix}`);

        // Stopp: ein WebM-Chip mit Dauer, Abspielen spielt wirklich (CSP media-src blob:)
        await js(`document.getElementById("recorder-stop").click()`);
        check(`${label}: Stopp erzeugt genau einen Chip „aufnahme-….webm" mit Dauer, Mikrofon frei`,
          (await waitFor(`document.querySelectorAll("#attachments .attachment-chip").length === 1 &&
            /^aufnahme-\\d{8}-\\d{6}\\.webm$/.test(document.querySelector("#attachments .attachment-name").textContent) &&
            /^00:0[2-3] · /.test(document.querySelector("#attachments .attachment-meta").textContent)`)) && (await tracksEnded()),
          await js<string>(`document.getElementById("attachments").textContent`));
        await js(`document.querySelector("#attachments .attachment-play").click()`);
        const played = await waitFor(`(() => { const a = document.querySelector("#attachments audio"); return !!a && a.currentTime > 0.2 && !a.error; })()`, 5000);
        const audioInfo = await js<string>(`(() => { const a = document.querySelector("#attachments audio"); return JSON.stringify({ src: a.src.slice(0, 5), t: a.currentTime, err: a.error && a.error.code }); })()`);
        check(`${label}: Abspielen spielt die Aufnahme über die Objekt-URL`, played, audioInfo);
        check(`${label}: während der Wiedergabe steht „Pause" am Chip`,
          await js<boolean>(`document.querySelector("#attachments .attachment-play").getAttribute("aria-label") === "Pause"`));
        await js(`document.querySelector("#attachments .attachment-play").click()`);
        await js(`document.getElementById("input").focus()`);
        await cdp("Input.insertText", { text: "Kurze Sprachnotiz" });
        await shoot(`aufnahme-chip-${size.width}${suffix}`);

        // Senden: Upload über die echte Route, die Nachricht zeigt die Sprachdatei
        const users = await count("#messages .msg-user");
        await js(`document.getElementById("send").click()`);
        check(`${label}: Senden lädt die Aufnahme hoch, die Nachricht zeigt die Sprachdatei`,
          await waitFor(`document.querySelectorAll("#messages .msg-user").length === ${users + 1} &&
            /aufnahme-\\d{8}-\\d{6}\\.webm/.test(document.querySelectorAll("#messages .msg-user")[${users}].textContent)`, 8000),
          await note());
        check(`${label}: Chip weg, keine Meldung`, (await count("#attachments .attachment-chip")) === 0 && (await note()) === "");
        await turnDone();

        // Gesprächswechsel während der Aufnahme: verworfen, Mikrofon frei, nichts im neuen Gespräch
        await recordFor(500);
        const other = await js<string | null>(`(() => { const e = [...document.querySelectorAll(".conversation")].find(c => c.getAttribute("data-id") !== "topic-443"); return e ? e.getAttribute("data-id") : null; })()`);
        if (other) {
          if (size.mobile) await js(`document.getElementById("menu").click()`);
          await clickEntry(other);
          check(`${label}: Gesprächswechsel verwirft die Aufnahme, Mikrofon frei, kein Chip`,
            (await waitFor(`!(${shown("recorder")})`)) && (await tracksEnded()) && (await count("#attachments .attachment-chip")) === 0);
        } else {
          check(`${label}: zweites Gespräch für den Wechsel vorhanden`, false);
        }

        // Einmal MP4 wie Safari: Chrome schreibt MP4, der Server nimmt es als Sprachdatei an
        if (scheme === "light" && !size.mobile) {
          await openTopic(url, { mp4: true });
          await recordFor(1200);
          await js(`document.getElementById("recorder-stop").click()`);
          check(`MP4-Aufnahme: Chip „aufnahme-….m4a"`,
            await waitFor(`/^aufnahme-\\d{8}-\\d{6}\\.m4a$/.test((document.querySelector("#attachments .attachment-name") || {}).textContent || "")`));
          const mp4Users = await count("#messages .msg-user");
          await js(`document.getElementById("send").click()`);
          check(`MP4-Aufnahme: Upload angenommen (Typprüfung des Servers), Nachricht mit Sprachdatei`,
            await waitFor(`document.querySelectorAll("#messages .msg-user").length === ${mp4Users + 1}`, 8000) && (await note()) === "",
            await note());
          await turnDone();
        }
        await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
      } finally {
        await recDemo.stop();
      }
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

/**
 * Anhänge und Aufnahme in reinen Web-Gesprächen (Issue #112), je 1280 und
 * 390 px, hell und (mit --screenshots) dunkel, gegen die Demo mit
 * Upload-Ablage: Büroklammer und Mikrofon im Web-Gespräch, Bild über die
 * Dateiauswahl und eine Aufnahme als Chips, Senden über die echten Routen
 * dieses Gesprächs, Karten mit geladener Vorschau und Sprachdatei, die sich im
 * Verlauf abspielen lässt, nach dem Neuladen unverändert; ohne sicheren Kontext kein Mikrofon, Büroklammer bleibt.
 */
async function webConversationAttachmentChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const note = () => js<string>(`(() => { const n = document.getElementById("attach-note"); return n.hidden ? "" : n.textContent; })()`);
  async function openWeb(url: string, insecure = false) {
    const ids: string[] = [];
    if (insecure) ids.push((await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(window, "isSecureContext", { value: false })` })).identifier);
    await goto(url);
    const webId = await js<string>(`fetch("/api/conversations").then(r => r.json()).then(d => d.conversations[0].id)`);
    await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, ${JSON.stringify(webId)})`);
    await goto(url);
    await waitFor(`!document.getElementById("input").disabled && document.querySelectorAll("#messages .msg").length > 0`);
    for (const identifier of ids) await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    return webId;
  }

  for (const scheme of schemes) {
    await emulateScheme(scheme as "light" | "dark");
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Web-Gespräch ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const webDemo = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat({ delayMs: 200, stepMs: 50 }), telegramChat: createFakeChat({ delayMs: 200, stepMs: 50 }), log: () => {} }
      );
      try {
        const url = `${webDemo.server.url}/`;

        await openWeb(url, true);
        check(`${label}: ohne sicheren Kontext kein Mikrofon, Büroklammer da`,
          (await js<boolean>(`document.getElementById("record").hidden`)) && (await js<boolean>(shown("attach"))));

        const webId = await openWeb(url);
        check(`${label}: Büroklammer und Mikrofon im Web-Gespräch`, (await js<boolean>(shown("attach"))) && (await js<boolean>(shown("record"))));

        // Bild über die Dateiauswahl
        await js(`(async () => {
          const c = document.createElement("canvas"); c.width = 640; c.height = 400;
          const x = c.getContext("2d"); x.fillStyle = "#2f7d5b"; x.fillRect(0, 0, 640, 400); x.fillStyle = "rgba(255,255,255,0.85)";
          x.fillRect(50, 40, 380, 50); x.fillRect(50, 120, 510, 30); x.fillRect(50, 180, 450, 30);
          const png = await new Promise(r => c.toBlob(b => r(b), "image/png"));
          const dt = new DataTransfer();
          dt.items.add(new File([png], "Bildschirmfoto Web.png", { type: "image/png" }));
          const input = document.getElementById("file-input");
          input.files = dt.files;
          input.dispatchEvent(new Event("change"));
        })()`);
        check(`${label}: Bild wird Chip mit Vorschau`,
          await waitFor(`document.querySelectorAll("#attachments .attachment-chip").length === 1 &&
            (() => { const i = document.querySelector("#attachments img.attachment-thumb"); return !!i && i.complete && i.naturalWidth > 0; })()`),
          await note());

        // Aufnahme dazu
        await js(`document.getElementById("record").click()`);
        const started = await waitFor(shown("recorder"), 5000);
        await Bun.sleep(1500);
        await js(`document.getElementById("recorder-stop").click()`);
        check(`${label}: Aufnahme wird zweiter Chip „aufnahme-….webm"`,
          started && (await waitFor(`document.querySelectorAll("#attachments .attachment-chip").length === 2 &&
            /^aufnahme-\\d{8}-\\d{6}\\.webm$/.test(document.querySelectorAll("#attachments .attachment-name")[1].textContent)`)),
          await js<string>(`document.getElementById("attachments").textContent`));
        await js(`document.getElementById("input").focus()`);
        await cdp("Input.insertText", { text: "Screenshot und Sprachnotiz" });
        check(`${label}: Seite nicht seitlich scrollbar mit Chips`, await noHorizontalScroll(size.width));
        await shoot(`web-anhaenge-chips-${size.width}${suffix}`);

        // Senden: Upload und Nachricht an dieses Gespräch, Karten im Verlauf
        const users = await count("#messages .msg-user");
        await js(`document.getElementById("send").click()`);
        const sent = `document.querySelectorAll("#messages .msg-user").length === ${users + 1} &&
          document.querySelectorAll("#messages .msg-user")[${users}].querySelectorAll(".msg-attachments .file").length === 2`;
        check(`${label}: Nachricht zeigt Bild und Sprachdatei, keine Meldung`, (await waitFor(sent, 8000)) && (await note()) === "", await note());
        await turnDone();
        const previewOk = `(() => { const m = document.querySelectorAll("#messages .msg-user")[${users}];
          const i = m && m.querySelector(".msg-attachments img.file-preview");
          return !!i && i.complete && i.naturalWidth > 0 && new URL(i.src).pathname.startsWith("/api/conversations/${webId}/attachments/"); })()`;
        check(`${label}: Vorschau aus der Adresse des Web-Gesprächs geladen`, await waitFor(previewOk, 5000));
        await shoot(`web-anhaenge-verlauf-${size.width}${suffix}`);

        // Sprachdatei im Verlauf abspielen: über die Route dieses Gesprächs geladen, als Objekt-URL gespielt
        const voice = `document.querySelectorAll("#messages .msg-user")[${users}].querySelector(".msg-attachments audio")`;
        async function playsFromHistory(when: string) {
          const button = await waitFor(`!!document.querySelectorAll("#messages .msg-user")[${users}]?.querySelector(".msg-attachments .attachment-play")`, 5000);
          await js(`document.querySelectorAll("#messages .msg-user")[${users}].querySelector(".msg-attachments .attachment-play").click()`);
          const played = await waitFor(`(() => { const a = ${voice}; return !!a && a.src.startsWith("blob:") && a.readyState >= 2 && a.currentTime > 0.2 && !a.error; })()`, 8000);
          const info = await js<string>(`(() => { const a = ${voice}; return a ? JSON.stringify({ src: a.src.slice(0, 5), ready: a.readyState, t: a.currentTime, dauer: a.duration, err: a.error && a.error.code }) : "kein audio"; })()`);
          check(`${label}: Sprachdatei im Verlauf ${when} geladen und abspielbar`, button && played, info);
          await js(`(() => { const a = ${voice}; if (a) a.pause(); })()`);
        }
        await playsFromHistory("nach dem Senden");

        // Neu laden: der Verlauf behält beide Anhänge
        await goto(url);
        await waitFor(`!document.getElementById("input").disabled`);
        check(`${label}: nach dem Neuladen Bild und Sprachdatei im Verlauf`, (await waitFor(sent, 8000)) && (await waitFor(previewOk, 5000)));
        await playsFromHistory("nach dem Neuladen");
        await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
      } finally {
        await webDemo.stop();
      }
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

/**
 * Fußzeile unter Antworten (Issue #22), je 1280 und 390 px: Agent, Modell,
 * Dauer, Lage unter dem Inhalt, Tippfläche, Kopieren über die Clipboard-API
 * und über den Ersatzweg ohne sicheren Kontext (Clipboard-API entfernt, wie
 * über HTTP an der LAN-IP). Mit --screenshots zusätzlich hell und dunkel mit
 * sichtbarem „Kopiert".
 */
async function footerChecks() {
  const footDemo = await startDemoServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
  );
  const url = `${footDemo.server.url}/`;
  const expected = stripControlTags(DEMO_REPLY);
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const schemes = process.argv.includes("--screenshots") ? ["light", "dark"] : ["light"];
  const foot = (i: number) => `document.querySelectorAll(".msg-assistant .msg-foot")[${i}]`;
  const status = `${foot(0)}.querySelector(".copy-status").textContent`;
  try {
    for (const scheme of schemes) {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Fußzeile ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await goto(url);
        await waitFor(`document.querySelectorAll(".msg").length === 6 && ${foot(0)}`);
        check(`${label}: Zeile „General · claude-opus-5-5 · 42 s"`,
          (await js<string>(`${foot(0)}.querySelector(".msg-meta").textContent`)) === "General · claude-opus-5-5 · 42 s");
        check(`${label}: Fallback-Antwort zeigt das Fallback-Modell`,
          (await js<string>(`${foot(1)}.querySelector(".msg-meta").textContent`)) === "General · minimax/minimax-m2.7 · 3 min 7 s");
        check(`${label}: Fußzeile unter dem Inhalt, Kopf darüber`,
          await js<boolean>(`(() => { const m = document.querySelector(".msg-assistant"); const b = m.querySelector(".bubble").getBoundingClientRect();
            return m.querySelector(".msg-foot").getBoundingClientRect().top >= b.bottom - 1 && m.querySelector(".msg-head").getBoundingClientRect().bottom <= b.top + 1; })()`));
        // Zeitstempel (Issue #186): vorn in der Fußzeile, unter eigenen Nachrichten rechtsbündig
        const stamp = await js<{ text: string; datetime: string; title: string; spoken: string; order: string[]; valid: boolean; day: boolean }>(`(() => {
          const f = ${foot(0)}; const t = f.querySelector("time.msg-time"); const dt = t.getAttribute("datetime");
          return { text: t.querySelector("[aria-hidden=true]").textContent, datetime: dt, title: t.title,
            spoken: t.querySelector(".visually-hidden").textContent, order: [...f.children].map(c => c.className),
            valid: !Number.isNaN(Date.parse(dt)), day: new Date(dt).toDateString() === new Date().toDateString() }; })()`);
        check(`${label}: Antwort zeigt „HH:MM" vor „General · …", datetime gültig, volles Datum als title und Screenreader-Text`,
          /^\d\d:\d\d$/.test(stamp.text) && stamp.valid && stamp.day && stamp.order.join(" ") === "icon-button copy-button msg-time msg-meta copy-status"
            && / 20\d\d, \d\d:\d\d Uhr$/.test(stamp.title) && stamp.spoken === stamp.title && !stamp.title.includes("Invalid"), JSON.stringify(stamp));
        check(`${label}: Trenner „·" zwischen Uhrzeit und Metazeile, Zeit leise wie die Metazeile`,
          await js<boolean>(`(() => { const f = ${foot(0)}; const m = f.querySelector(".msg-meta"); const t = f.querySelector(".msg-time");
            return getComputedStyle(m, "::before").content.includes("·") && getComputedStyle(t).color === getComputedStyle(m).color
              && getComputedStyle(t).fontSize === getComputedStyle(m).fontSize; })()`));
        const user = await js<{ n: number; right: number; bubbleRight: number; below: boolean; text: string; color: string; muted: string; bubbleW: number; colW: number }>(`(() => {
          const m = [...document.querySelectorAll(".msg-user")].find(x => x.querySelector(".bubble")); const b = m.querySelector(".bubble").getBoundingClientRect();
          const t = m.querySelector("time.msg-user-time"); const r = t.getBoundingClientRect();
          return { n: document.querySelectorAll(".msg-user time.msg-user-time").length, right: r.right, bubbleRight: b.right, below: r.top >= b.bottom - 1,
            text: t.querySelector("[aria-hidden=true]").textContent, color: getComputedStyle(t).color,
            muted: getComputedStyle(document.querySelector(".msg-assistant .msg-foot")).color, bubbleW: b.width, colW: m.getBoundingClientRect().width }; })()`);
        check(`${label}: eigene Nachricht mit Uhrzeit rechtsbündig unter der Blase, leise`,
          user.n === (await count(".msg-user")) && Math.abs(user.right - user.bubbleRight) <= 1 && user.below && /^\d\d:\d\d$/.test(user.text) && user.color === user.muted,
          JSON.stringify(user));
        check(`${label}: Blase so breit wie ihr Text, nicht gestreckt`, user.bubbleW < user.colW * 0.86, `${user.bubbleW} von ${user.colW}`);
        // Langer Modellname: die Zeile bricht um, die Uhrzeit bleibt eine Zeile, nichts läuft über
        const wrap = await js<{ lines: number; timeH: number; lineH: number; scroll: boolean; beside: boolean; inside: boolean; original: string }>(`(() => {
          const f = ${foot(0)}; const m = f.querySelector(".msg-meta"); const original = m.textContent;
          m.textContent = "General · openrouter/anthropic/claude-opus-5-5-mit-einem-sehr-langen-modellnamen-20260926-preview · 16 min 42 s";
          const t = f.querySelector(".msg-time"); const lh = parseFloat(getComputedStyle(m).lineHeight) || 18;
          const mr = m.getBoundingClientRect(); const tr = t.getBoundingClientRect(); const b = f.parentElement.querySelector(".bubble").getBoundingClientRect();
          const out = { lines: Math.round(mr.height / lh), timeH: tr.height, lineH: lh,
            scroll: document.documentElement.scrollWidth <= ${size.width},
            beside: Math.abs(mr.top - tr.top) <= 2 && mr.left >= tr.right
              && Math.abs((tr.top + tr.height / 2) - (f.querySelector(".copy-button").getBoundingClientRect().top + f.querySelector(".copy-button").getBoundingClientRect().height / 2)) <= 2, inside: mr.right <= b.right + 1, original };
          m.textContent = original; return out; })()`);
        check(`${label}: langer Modellname bricht neben der Uhrzeit um, Uhrzeit einzeilig, kein horizontales Scrollen`,
          (size.mobile ? wrap.lines >= 2 : wrap.lines >= 1) && wrap.timeH <= wrap.lineH * 1.5 && wrap.scroll && wrap.beside && wrap.inside, JSON.stringify(wrap));
        if (schemes.length > 1 && size.mobile) {
          await js(`(() => { const f = ${foot(0)}; f.querySelector(".msg-meta").textContent = "General · openrouter/anthropic/claude-opus-5-5-mit-einem-sehr-langen-modellnamen-20260926-preview · 16 min 42 s";
            f.scrollIntoView({ block: "center" }); })()`);
          await Bun.sleep(300);
          const { data } = await cdp("Page.captureScreenshot", { format: "png" });
          const name = `zeitstempel-langer-name-${size.width}${scheme === "dark" ? "-dunkel" : ""}`;
          await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
          console.log(`Bild ${name}.png`);
          await js(`${foot(0)}.querySelector(".msg-meta").textContent = ${JSON.stringify("General · claude-opus-5-5 · 42 s")}`);
        }

        const box = await js<{ w: number; h: number; name: string }>(`(() => { const b = ${foot(0)}.querySelector(".copy-button"); const r = b.getBoundingClientRect();
          return { w: r.width, h: r.height, name: b.getAttribute("aria-label") }; })()`);
        check(`${label}: Kopieren-Knopf ${size.mobile ? "mindestens 44 × 44 px" : "40 × 40 px"}, Name „Antwort kopieren"`,
          box.w >= (size.mobile ? 44 : 40) && box.h >= (size.mobile ? 44 : 40) && box.name === "Antwort kopieren", `${box.w} × ${box.h}`);

        // Clipboard-API (127.0.0.1 ist ein sicherer Kontext); writeText wird mitgeschnitten
        await js(`(() => { window.__copied = []; navigator.clipboard.writeText = t => { window.__copied.push(t); return Promise.resolve(); }; })()`);
        await js(`${foot(0)}.querySelector(".copy-button").click()`);
        check(`${label}: Clipboard-API bekommt Markdown ohne Steuer-Tags, „Kopiert" erscheint`,
          (await waitFor(`${status} === "Kopiert"`, 2000)) && (await js<string[]>(`window.__copied`))[0] === expected && !expected.includes("[REMEMBER"));
        check(`${label}: „Kopiert" steht direkt hinter der Metazeile`,
          await js<boolean>(`(() => { const f = ${foot(0)}; const m = f.querySelector(".msg-meta").getBoundingClientRect(); const s = f.querySelector(".copy-status").getBoundingClientRect();
            return s.left - m.right >= 0 && s.left - m.right <= 16; })()`));
        if (schemes.length > 1) {
          await js(`(() => { const l = document.getElementById("chat-log"); const f = ${foot(0)};
            l.scrollTop = f.getBoundingClientRect().top - l.getBoundingClientRect().top + l.scrollTop - l.clientHeight / 2; })()`);
          await Bun.sleep(300);
          const { data } = await cdp("Page.captureScreenshot", { format: "png" });
          const name = `antwort-${size.width}${scheme === "dark" ? "-dunkel" : ""}`;
          await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
          console.log(`Bild ${name}.png`);
        }
        check(`${label}: „Kopiert" verschwindet nach 2 s`, await waitFor(`${status} === ""`, 3500));

        // Ohne sicheren Kontext: keine Clipboard-API, Ersatzweg über ein Textfeld
        await js(`(() => { Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
          const original = document.execCommand.bind(document); window.__exec = [];
          document.execCommand = c => { const t = document.querySelector(".copy-buffer");
            const r = original(c); window.__exec.push({ c, text: t ? t.value.slice(t.selectionStart, t.selectionEnd) : null, r }); return r; }; })()`);
        // Echter Mausklick: execCommand("copy") verlangt eine Nutzeraktion, ein click() per Skript reicht nicht
        const at = await js<{ x: number; y: number }>(`(() => { const b = ${foot(0)}.querySelector(".copy-button"); b.scrollIntoView({ block: "center" });
          const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
        }
        await waitFor(`${status} !== ""`, 2000);
        const exec = await js<{ c: string; text: string | null; r: boolean }[]>(`window.__exec`);
        const shownStatus = await js<string>(status);
        check(`${label}: Ersatzweg markiert genau den Kopiertext und ruft copy auf`,
          exec.length === 1 && exec[0]!.c === "copy" && exec[0]!.text === expected, JSON.stringify(exec.map(e => ({ ...e, text: e.text?.slice(0, 20) }))));
        check(`${label}: Ersatzweg kopiert, „Kopiert" erscheint`, exec[0]?.r === true && shownStatus === "Kopiert", shownStatus);
        check(`${label}: Textfeld wieder entfernt, Fokus auf dem Knopf`,
          (await count(".copy-buffer")) === 0 && (await js<boolean>(`document.activeElement === ${foot(0)}.querySelector(".copy-button")`)));
        check(`${label}: kein horizontales Scrollen`, await js<boolean>(`document.documentElement.scrollWidth <= ${size.width}`));
      }
    }
  } finally {
    await cdp("Emulation.setEmulatedMedia", { features: [] });
    await footDemo.stop();
  }
}

/**
 * Topics aus der Oberfläche verwalten (Issue #30), je 1280 und 390 px (mit
 * --screenshots auch dunkel): Anlegen mit Research öffnet das neue Topic oben
 * unter „Topics", die erste Nachricht setzt den Titel, Umbenennen, Schließen
 * (gedämpft mit Schloss, Eingabe gesperrt), Wieder öffnen, Löschen mit
 * Namensbestätigung. Dazu eine Demo ohne Recht „Nachrichten löschen".
 * Jede Runde mit frischer Demo; nichts geht nach Telegram.
 */
async function topicChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  const fresh = (rights?: { manageTopics: boolean; deleteMessages: boolean }) => startDemoServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), topicRights: rights, log: () => {} }
  );
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const menuButtons = () => js<string[]>(`[...document.querySelectorAll("#conversation-actions button")].map(b => b.textContent)`);
  const clickMenu = (label: string) => js(`[...document.querySelectorAll("#conversation-actions button")].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
  const title = () => js<string>(`document.getElementById("chat-title").textContent`);
  try {
    for (const scheme of schemes) {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Topics ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        const topicDemo = await fresh();
        try {
          const url = `${topicDemo.server.url}/`;
          await goto(url);
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
          await goto(url);
          await waitFor(`document.querySelectorAll("#topic-list .conversation").length > 0 && document.querySelectorAll(".msg").length > 0`);

          // Direktchat und General: weder Umbenennen noch Menü
          await clickEntry("dm");
          await waitFor(`document.getElementById("chat-title").textContent === "Direktchat"`);
          check(`${label}: Direktchat ohne Umbenennen und Menü`,
            (await js<boolean>(`document.getElementById("chat-title").disabled`)) && !(await js<boolean>(shown("conversation-menu"))) &&
            !(await js<boolean>(`!!document.querySelector('#dm-list .entry-menu')`)));
          await js(`document.getElementById("older-toggle").getAttribute("aria-expanded") === "false" && document.getElementById("older-toggle").click()`);
          await clickEntry("topic-1");
          await waitFor(`document.getElementById("chat-title").textContent === "General"`);
          check(`${label}: General ohne Umbenennen und Menü`,
            (await js<boolean>(`document.getElementById("chat-title").disabled`)) && !(await js<boolean>(shown("conversation-menu"))) &&
            !(await js<boolean>(`!!document.querySelector('.conversation[data-id="topic-1"] + .entry-menu')`)));
          check(`${label}: Beispiel „Archiv" geschlossen: gedämpft mit Schloss unter „Ältere Topics"`,
            await js<boolean>(`(() => { const e = document.querySelector('#older-list .conversation[data-id="topic-7"]');
              return !!e && e.dataset.closed === "true" && !!e.querySelector(".closed-mark svg") &&
                getComputedStyle(e.querySelector(".conversation-title")).color === getComputedStyle(e.querySelector(".conversation-meta")).color; })()`));

          // Anlegen mit Research
          if (size.mobile) await openDrawer();
          await js(`document.getElementById("new-chat").click()`);
          await waitFor(`document.activeElement?.dataset.agentOption === "general"`);
          await pressKey("ArrowDown", "ArrowDown", 40);
          await pressKey("Enter", "Enter", 13, "\r");
          check(`${label}: Anlegen öffnet topic-900 mit Research, oben unter Topics, markiert`,
            await waitFor(`document.getElementById("agent-name").textContent === "Research" && document.getElementById("chat-title").textContent === "Neues Gespräch" &&
              document.querySelector("#topic-list .conversation")?.dataset.id === "topic-900" && document.querySelector("#topic-list .conversation").getAttribute("aria-current") === "true"`));
          check(`${label}: kein Web-Gespräch dazu`, (await entryCount("conversation-list")) === 2);
          if (size.mobile) check(`${label}: Schublade nach dem Anlegen zu`, await waitFor(`document.getElementById("sidebar").dataset.open === "false"`));

          // Erste Nachricht setzt den Titel (wie im Bot aus der ersten Nutzernachricht)
          await typeAndEnter("Was kostet ein VPS bei Hetzner?");
          check(`${label}: erste Nachricht wird Titel in Kopfzeile und Seitenleiste`,
            await waitFor(`document.getElementById("chat-title").textContent === "Was kostet ein VPS bei Hetzner?" &&
              document.querySelector('.conversation[data-id="topic-900"] .conversation-title').textContent === "Was kostet ein VPS bei Hetzner?"`));
          await turnDone();
          await shoot(`topics-${size.width}-neu${suffix}`);

          // Umbenennen per Titel
          await js(`document.getElementById("chat-title").click()`);
          await waitFor(`document.activeElement.id === "title-input"`);
          await js(`document.getElementById("title-input").select()`);
          await cdp("Input.insertText", { text: "VPS Vergleich" });
          await pressKey("Enter", "Enter", 13, "\r");
          check(`${label}: Umbenennen ändert Kopfzeile, Seitenleiste und Server`,
            (await waitFor(`document.getElementById("chat-title").textContent === "VPS Vergleich" &&
              document.querySelector('.conversation[data-id="topic-900"] .conversation-title').textContent === "VPS Vergleich"`)) &&
            (await (await fetch(`${topicDemo.server.url}/api/conversations/topic-900`)).json()).conversation.title === "VPS Vergleich");

          // Schließen
          await js(`document.getElementById("conversation-menu").click()`);
          await waitFor(shown("conversation-actions"));
          check(`${label}: Menü: Umbenennen, Schließen, Agent ändern …, Löschen …`,
            await waitFor(`JSON.stringify([...document.querySelectorAll("#conversation-actions button")].map(b => b.textContent)) === ${JSON.stringify(JSON.stringify(["Umbenennen", "Schließen", "Agent ändern …", "Löschen …"]))}`),
            (await menuButtons()).join(", "));
          await clickMenu("Schließen");
          check(`${label}: Schließen: Eingabe gesperrt mit Hinweis, Eintrag unter „Ältere Topics" mit Schloss`,
            await waitFor(`document.getElementById("input").disabled && ${shown("closed-note")} && !${shown("conversation-actions")} &&
              document.querySelector('#older-list .conversation[data-id="topic-900"]')?.dataset.closed === "true"`));
          await shoot(`topics-${size.width}-geschlossen${suffix}`);
          if (size.mobile) {
            await openDrawer();
            await js(`document.querySelector('.conversation[data-id="topic-900"]').scrollIntoView({ block: "center" })`);
            await shoot(`topics-${size.width}-geschlossen-schublade${suffix}`);
            await js(`document.getElementById("sidebar-close").click()`);
            await Bun.sleep(300);
          }
          await js(`document.getElementById("conversation-menu").click()`);
          await waitFor(`[...document.querySelectorAll("#conversation-actions button")].some(b => b.textContent === "Wieder öffnen")`);
          await clickMenu("Wieder öffnen");
          check(`${label}: Wieder öffnen: Eingabe frei, Eintrag wieder oben`,
            await waitFor(`!document.getElementById("input").disabled && !${shown("closed-note")} &&
              document.querySelector('#topic-list .conversation[data-id="topic-900"]') && !document.querySelector('.conversation[data-id="topic-900"]').dataset.closed`));

          // Löschen mit Namensbestätigung
          await js(`document.getElementById("conversation-menu").click()`);
          await waitFor(`[...document.querySelectorAll("#conversation-actions button")].some(b => b.textContent === "Löschen …" && !b.disabled)`);
          await clickMenu("Löschen …");
          check(`${label}: Rückfrage mit Namen, Fokus im Feld, roter Knopf gesperrt`,
            await waitFor(`document.querySelector("#conversation-actions .actions-question")?.textContent === "Topic ‚VPS Vergleich' in Telegram endgültig löschen?" &&
              document.activeElement?.classList.contains("confirm-input") && document.querySelector("#conversation-actions .danger-button").disabled`));
          await cdp("Input.insertText", { text: "VPS vergleich" });
          check(`${label}: falsche Schreibweise: Knopf bleibt gesperrt`, await js<boolean>(`document.querySelector("#conversation-actions .danger-button").disabled`));
          await js(`document.activeElement.select()`);
          await cdp("Input.insertText", { text: "VPS Vergleich" });
          check(`${label}: exakter Name: Knopf aktiv und rot (Fehlerfarbe)`,
            await js<boolean>(`(() => { const b = document.querySelector("#conversation-actions .danger-button"); const probe = document.createElement("span");
              probe.style.color = "var(--error)"; document.body.appendChild(probe); const red = getComputedStyle(probe).color; probe.remove();
              return !b.disabled && getComputedStyle(b).backgroundColor === red; })()`));
          if (size.mobile) {
            const box = await js<{ w: number; right: number }>(`(() => { const r = document.getElementById("conversation-actions").getBoundingClientRect(); return { w: r.width, right: r.right }; })()`);
            check(`${label}: Rückfrage passt auf den Bildschirm`, box.right <= size.width && (await js<boolean>(`document.documentElement.scrollWidth <= ${size.width}`)), `${box.w} px, rechts ${box.right}`);
          }
          await shoot(`topics-${size.width}-loeschen${suffix}`);
          await js(`document.querySelector("#conversation-actions .danger-button").click()`);
          check(`${label}: gelöscht: aus der Liste, anderes Gespräch offen, kein neues angelegt`,
            (await waitFor(`!document.querySelector('.conversation[data-id="topic-900"]') && document.getElementById("chat-title").textContent !== "VPS Vergleich" && !${shown("conversation-actions")}`)) &&
            !(await (await fetch(`${topicDemo.server.url}/api/conversations`)).json()).telegram.topics.some((t: any) => t.id === "topic-900" || t.id === "topic-901"),
            await title());
        } finally {
          await topicDemo.stop();
        }

        // Ohne Recht „Nachrichten löschen"
        const noDelete = await fresh({ manageTopics: true, deleteMessages: false });
        try {
          await goto(`${noDelete.server.url}/`);
          await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-443")`);
          await goto(`${noDelete.server.url}/`);
          await waitFor(`document.getElementById("chat-title").textContent === "Recherche"`);
          await js(`document.getElementById("conversation-menu").click()`);
          check(`${label}: ohne Löschrecht: „Löschen …" gesperrt mit Erklärung`,
            await waitFor(`(() => { const b = [...document.querySelectorAll("#conversation-actions button")].find(b => b.textContent === "Löschen …");
              const h = document.querySelector("#conversation-actions .actions-hint");
              return !!b && b.disabled && !!h && h.textContent.includes("Gruppe → Administratoren → Bot") && b.getAttribute("aria-describedby") === h.id; })()`));
          await shoot(`topics-${size.width}-rechte${suffix}`);
          await pressKey("Escape", "Escape", 27);
        } finally {
          await noDelete.stop();
        }

        // Längster zulässiger Name ohne Leerzeichen: Rückfrage bricht innerhalb des Menüs um
        const longDemo = await fresh();
        try {
          const long = "Langername".repeat(12) + "Ende1234";
          await goto(`${longDemo.server.url}/`);
          await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-443")`);
          await goto(`${longDemo.server.url}/`);
          await waitFor(`document.getElementById("chat-title").textContent === "Recherche"`);
          const renamed = await js<number>(`fetch("/api/conversations/topic-443", { method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: ${JSON.stringify(long)} }) }).then(r => r.status)`);
          await goto(`${longDemo.server.url}/`);
          check(`${label}: langer Name (${long.length} Zeichen) gesetzt`,
            renamed === 200 && (await waitFor(`document.getElementById("chat-title").textContent === ${JSON.stringify(long)}`)));
          // Alle Elemente der Rückfrage in ihren Grenzen, das Menü im Fenster (bzw. in der Seitenleiste)
          const inBounds = (panel: string, frame: string) => js<{ ok: boolean; detail: string }>(`(() => {
            const p = document.querySelector(${JSON.stringify(panel)}); if (!p) return { ok: false, detail: "kein Menü" };
            const pr = p.getBoundingClientRect(); const fr = ${frame};
            const bad = [];
            if (pr.left < fr.left - 0.5 || pr.right > fr.right + 0.5) bad.push("Menü " + Math.round(pr.left) + "-" + Math.round(pr.right));
            for (const c of p.children) {
              const r = c.getBoundingClientRect();
              if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5) bad.push(c.className + " " + Math.round(r.left) + "-" + Math.round(r.right));
              if (c.scrollWidth > c.clientWidth + 1) bad.push(c.className + " läuft über");
            }
            if (document.documentElement.scrollWidth > innerWidth) bad.push("Seite breiter als Fenster");
            return { ok: bad.length === 0 && p.querySelector(".actions-question").textContent.includes(${JSON.stringify(long)}), detail: bad.join(", ") || Math.round(pr.width) + " px" };
          })()`);

          await js(`document.getElementById("conversation-menu").click()`);
          await waitFor(`[...document.querySelectorAll("#conversation-actions button")].some(b => b.textContent === "Löschen …" && !b.disabled)`);
          await clickMenu("Löschen …");
          await waitFor(`!!document.querySelector("#conversation-actions .confirm-input")`);
          const head = await inBounds("#conversation-actions", `({ left: 0, right: innerWidth })`);
          check(`${label}: Kopfzeile, Rückfrage mit langem Namen in den Grenzen`, head.ok, head.detail);
          await pressKey("Escape", "Escape", 27);
          await waitFor(`!${shown("conversation-actions")}`);

          if (size.mobile) await openDrawer();
          await js(`document.querySelector('.conversation[data-id="topic-443"] + .entry-menu').click()`);
          await waitFor(`[...document.querySelectorAll("#topic-list .entry-actions button")].some(b => b.textContent === "Löschen …" && !b.disabled)`);
          await js(`[...document.querySelectorAll("#topic-list .entry-actions button")].find(b => b.textContent === "Löschen …").click()`);
          await waitFor(`!!document.querySelector("#topic-list .entry-actions .confirm-input")`);
          const side = await inBounds("#topic-list .entry-actions", `(() => { const s = document.getElementById("sidebar").getBoundingClientRect(); return { left: s.left, right: Math.min(s.right, innerWidth) }; })()`);
          check(`${label}: Seitenleiste, Rückfrage mit langem Namen in den Grenzen`, side.ok, side.detail);
          await pressKey("Escape", "Escape", 27);
        } finally {
          await longDemo.stop();
        }
      }
    }
  } finally {
    await cdp("Emulation.setEmulatedMedia", { features: [] });
    await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`).catch(() => {});
  }
}

/**
 * Screenshots erst nach geladenem Verlauf: Login im Normalbetrieb (abgemeldet),
 * Chat im Demo-Modus, je 390 und 1280 px, hell und dunkel, dazu ein laufender Turn.
 */
/**
 * Einstellungen im Browser (Issue #38), je 1280 und 390 px, hell (mit
 * --screenshots auch dunkel): Einstieg über das Zahnrad in der Seitenleiste
 * (am Handy aus der Schublade, dann Vollbild), Reiter, Research aufklappen,
 * Modell auf „Standard" speichern, eigenes Modell, Anweisung hinzufügen,
 * Direktaufruf und Neuladen unter #/einstellungen/agenten, Zurück zum Chat,
 * „Agent ändern …" im Topic-Menü. Jede Runde mit frischer Demo; Einstellungen
 * und Anweisungen liegen dort nur im Speicher.
 */
async function settingsChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const visible = (sel: string) => js<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; })()`);
  const click = (sel: string) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const setSelect = (id: string, value: string) =>
    js(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change")); })()`);
  try {
    for (const scheme of schemes) {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Einstellungen ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        const settingsDemo = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
        );
        try {
          const url = `${settingsDemo.server.url}/`;
          await goto(url);
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
          await goto(url);
          await waitFor(`document.querySelectorAll(".msg").length > 0`);

          // Einstieg: Zahnrad im Seitenleisten-Fuß, über dem Darstellungs-Schalter
          if (size.mobile) await openDrawer();
          check(`${label}: „Einstellungen" im Fuß über dem Darstellungs-Schalter`,
            await js<boolean>(`(() => { const b = document.getElementById("open-settings"); const t = document.getElementById("theme-switch");
              return b.closest(".sidebar-foot") === t.closest(".sidebar-foot") && b.getBoundingClientRect().bottom <= t.getBoundingClientRect().top && !!b.querySelector("svg"); })()`));
          await click("#open-settings");
          await waitFor(`location.hash === "#/einstellungen/agenten" && document.querySelectorAll(".settings-agent-head").length > 0`);
          check(`${label}: Adresse #/einstellungen/agenten, Chat ausgeblendet, Einstellungen sichtbar`,
            (await js<string>(`location.hash`)) === "#/einstellungen/agenten" && (await visible("#settings")) &&
            !(await visible("#composer")) && !(await visible("#chat-log")) && (await js<string>(`document.getElementById("main").dataset.view`)) === "settings");
          if (size.mobile) {
            check(`${label}: Schublade zu, Einstellungen im Vollbild`,
              (await js<string>(`document.getElementById("sidebar").dataset.open`)) === "false" &&
              (await js<boolean>(`(() => { const r = document.getElementById("settings").getBoundingClientRect(); return r.left === 0 && Math.round(r.width) === ${size.width}; })()`)));
          }
          check(`${label}: Reiter Agenten gewählt, Modelle, Sprechen, Schlüssel, Status, Routinen, Erinnerungen und Benachrichtigungen frei (Issue #39, #63, #225, #248, #284, #323)`,
            JSON.stringify(await js<string[]>(`[...document.querySelectorAll("#settings-tabs [role=tab]")].map(t => t.textContent + ":" + t.getAttribute("aria-selected") + ":" + t.disabled)`)) ===
              JSON.stringify(["Agenten:true:false", "Modelle:false:false", "Sprechen:false:false", "Schlüssel:false:false", "Status:false:false", "Routinen:false:false", "Erinnerungen:false:false", "Benachrichtigungen:false:false"]));
          check(`${label}: acht Agenten mit Farbpunkt`,
            (await count(".settings-agent-head .agent-dot")) === 8 &&
              (await js<string>(`getComputedStyle(document.querySelector('.settings-agent-name[data-agent="research"] .agent-dot')).backgroundColor`)) !==
              (await js<string>(`getComputedStyle(document.querySelector('.settings-agent-name[data-agent="general"] .agent-dot')).backgroundColor`)));
          await shoot(`einstellungen-${size.width}${suffix}`);

          // Research aufklappen: Standard mit geerbtem Wert, gespeichertes Modell gewählt, Anweisung aus der Demo
          await click('[data-focus-key="agent:research"]');
          await waitFor(`!!document.getElementById("settings-model-research") && document.querySelectorAll(".settings-instructions li").length === 1`);
          check(`${label}: Research aufgeklappt, „Standard (claude-opus-5-5, Voreinstellung)", gewählt claude-sonnet-5`,
            (await js<string>(`document.getElementById("settings-model-research").options[0].textContent`)) === "Standard (claude-opus-5-5, Voreinstellung)" &&
              (await js<string>(`document.getElementById("settings-model-research").value`)) === "claude-sonnet-5");
          check(`${label}: Felder im Stil des Passwortfelds (Rahmen, Radius 0.75rem, 16 px)`,
            await js<boolean>(`(() => { const s = getComputedStyle(document.getElementById("settings-model-research"));
              return s.borderTopWidth === "1px" && s.borderTopLeftRadius === "12px" && s.fontSize === "16px"; })()`));
          check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          await shoot(`einstellungen-${size.width}-agent${suffix}`);

          // M14-28: Auswahl aus dem Schema, deaktivierte Felder behalten ihre Werte.
          check(`${label}: Agentenmotoren entsprechen der Serverauswahl plus Standard`, await js<boolean>(`fetch("/api/settings").then(r => r.json()).then(data =>
            JSON.stringify([...document.getElementById("settings-engine-research").options].map(o => o.value)) === JSON.stringify([" standard", ...data.engineOptions.engines.map(e => e.id)]))`));
          check(`${label}: OpenCode nicht installiert und trotzdem wählbar`, await js<boolean>(`(() => { const o = [...document.getElementById("settings-engine-research").options].find(o => o.value === "opencode");
            return o.textContent === "OpenCode (nicht installiert)" && !o.disabled; })()`));
          await setSelect("settings-engine-research", "codex");
          await click('[data-focus-key="save:research"]');
          await waitFor(`document.querySelector('[data-focus-key="save:research"]').disabled && document.querySelector('[data-focus-key="agent:research"] .settings-agent-meta').textContent.startsWith("Codex")`);
          check(`${label}: Codex gespeichert, Modell und Effort ausgegraut und Modell erhalten`, await js<boolean>(`fetch("/api/settings").then(r => r.json()).then(data =>
            data.settings.agents.research.engine === "codex" && data.settings.agents.research.model === "claude-sonnet-5" &&
            document.getElementById("settings-model-research").disabled && document.getElementById("settings-effort-research").disabled &&
            document.querySelector(".settings-agent-engine-note").textContent.includes("Modell und Effort kommen aus den Einstellungen des Motors") &&
            document.querySelector(".settings-agent-engine-note a").getAttribute("href") === "#/einstellungen/modelle")`));
          await js(`document.getElementById("settings-engine-research").closest(".settings-field").scrollIntoView({ block: "start" })`);
          check(`${label}: Agentenmotor ohne seitliches Scrollen`, await noHorizontalScroll(size.width));
          await shoot(`agenten-motor-codex-${size.width}${suffix}`);
          await click(".settings-agent-engine-note a");
          check(`${label}: Formularlink öffnet den sichtbaren Motorabschnitt`,
            await waitFor(`location.hash === "#/einstellungen/modelle" && !!document.getElementById("settings-g-title-engine")`) &&
            await js<boolean>(`(() => { const r = document.getElementById("settings-g-title-engine").getBoundingClientRect(); return r.top >= 0 && r.bottom < innerHeight; })()`));
          await click("#settings-tab-agenten");
          await waitFor(`!!document.getElementById("settings-engine-research")`);
          await setSelect("settings-engine-research", "opencode");
          check(`${label}: auch OpenCode graut Modell und Effort aus`, await js<boolean>(`document.getElementById("settings-model-research").disabled && document.getElementById("settings-effort-research").disabled`));
          await setSelect("settings-engine-research", "api");
          check(`${label}: API macht Felder bedienbar und erklärt Modellnamen und Verbrauch`, await js<boolean>(`!document.getElementById("settings-model-research").disabled && !document.getElementById("settings-effort-research").disabled &&
            document.querySelector(".settings-agent-engine-note").textContent === "Die Anthropic API nimmt nur volle Modellnamen (claude-…) und zahlt je Verbrauch."`));
          await js(`document.getElementById("settings-engine-research").closest(".settings-field").scrollIntoView({ block: "start" })`);
          await shoot(`agenten-motor-api-${size.width}${suffix}`);
          await setSelect("settings-engine-research", " standard");
          await click('[data-focus-key="save:research"]');
          await waitFor(`document.querySelector('[data-focus-key="save:research"]').disabled && !document.querySelector('[data-focus-key="agent:research"] .settings-agent-meta').textContent.startsWith("Codex")`);

          await setSelect("settings-model-research", " standard");
          await click('[data-focus-key="save:research"]');
          await waitFor(`document.querySelector(".settings-status") && document.querySelector(".settings-status").textContent === "Gespeichert."`);
          check(`${label}: Standard gespeichert, Zeile zeigt das geerbte Modell`,
            (await js<string>(`document.querySelector('[data-focus-key="agent:research"] .settings-agent-meta').textContent`)) === "claude-opus-5-5 · Effort high");

          await setSelect("settings-model-research", " eigenes");
          await waitFor(`!!document.getElementById("settings-custom-research")`);
          await js(`(() => { const i = document.getElementById("settings-custom-research"); i.value = "vendor/eigenes-modell"; i.dispatchEvent(new Event("input")); })()`);
          await click('[data-focus-key="save:research"]');
          await waitFor(`document.querySelector('[data-focus-key="agent:research"] .settings-agent-meta').textContent.startsWith("vendor/eigenes-modell")`);
          check(`${label}: eigenes Modell gespeichert`,
            (await js<string>(`document.getElementById("settings-custom-research").value`)) === "vendor/eigenes-modell");

          await js(`(() => { const t = document.getElementById("settings-inst-research"); t.value = "Nenne <b>Quellen</b>"; t.dispatchEvent(new Event("input")); })()`);
          await click('[data-focus-key="inst-add:research"]');
          await waitFor(`document.querySelectorAll(".settings-instructions li").length === 2`);
          check(`${label}: Anweisung hinzugefügt, als Text gezeigt`,
            (await js<string>(`document.querySelectorAll(".settings-instructions li")[1].textContent`)) === "Nenne <b>Quellen</b>" &&
              (await count(".settings-instructions b")) === 0);

          // Neuladen bleibt in den Einstellungen; Zurück führt ohne Verlaufsschritt zum Chat
          await cdp("Page.reload", {});
          await Bun.sleep(100);
          await waitFor(`document.readyState === "complete" && document.querySelectorAll(".settings-agent-head").length > 0`);
          check(`${label}: Neuladen unter #/einstellungen/agenten öffnet die Einstellungen`,
            (await visible("#settings")) && (await js<string>(`location.hash`)) === "#/einstellungen/agenten");
          await click("#settings-back");
          await waitFor(`!location.hash && document.getElementById("main").dataset.view === "chat"`);
          check(`${label}: Zurück zum Chat`, (await visible("#composer")) && !(await visible("#settings")),
            await js<string>(`location.href + " " + document.getElementById("main").dataset.view`));
          await goto(`${url}#/einstellungen`);
          await waitFor(`location.hash === "#/einstellungen/agenten"`);
          check(`${label}: #/einstellungen wird zu #/einstellungen/agenten`, await visible("#settings"));
          // Browser-Zurück aus der Seite heraus geöffnet
          await click("#settings-back");
          await waitFor(`!location.hash`);
          if (size.mobile) await openDrawer();
          await click("#open-settings");
          await waitFor(`location.hash === "#/einstellungen/agenten"`);
          await js(`history.back()`);
          await waitFor(`document.getElementById("main").dataset.view === "chat"`);
          check(`${label}: Browser-Zurück schließt die Einstellungen`, !(await visible("#settings")) && (await visible("#composer")));

          // „Agent ändern …" im Topic-Menü: Kopfzeile und Seitenleiste folgen
          if (size.mobile) await openDrawer();
          await clickEntry("topic-443");
          await waitFor(`document.getElementById("chat-title").textContent === "Recherche"`);
          await click("#conversation-menu");
          await waitFor(`[...document.querySelectorAll("#conversation-actions button")].some(b => b.textContent === "Agent ändern …")`);
          await js(`[...document.querySelectorAll("#conversation-actions button")].find(b => b.textContent === "Agent ändern …").click()`);
          await waitFor(`document.querySelectorAll("#conversation-actions [data-agent-choice]").length === 8`);
          check(`${label}: Agentenliste mit aktuellem Agenten markiert`,
            (await js<string>(`document.querySelector('#conversation-actions [aria-current="true"]').dataset.agentChoice`)) === "research");
          await shoot(`agent-aendern-${size.width}${suffix}`);
          await click('#conversation-actions [data-agent-choice="critic"]');
          await waitFor(`document.getElementById("agent-name").textContent === "Critic"`);
          check(`${label}: Kopfzeile und Seitenleiste zeigen den neuen Agenten`,
            (await js<string>(`document.getElementById("agent-name").dataset.agent`)) === "critic" &&
              (await js<string>(`document.querySelector('.conversation[data-id="topic-443"] .conversation-meta').dataset.agent`)) === "critic" &&
              (await js<boolean>(`document.getElementById("conversation-actions").hidden`)));
        } finally {
          await settingsDemo.stop();
        }
      }
    }
  } finally {
    await cdp("Emulation.setEmulatedMedia", { features: [] });
  }
}

/**
 * Agenten verwalten (Issue #51) je 1280 und 390 px, hell (mit --screenshots
 * auch dunkel): Prompt sehen und bearbeiten, Board-Schalter, Löschen mit
 * Topic-Vorschau und Kennung, Neuer Agent mit Feldfehler, Wiederherstellen,
 * danach die Auswahl für neue Gespräche. Jede Runde mit frischer Demo, der
 * Katalog liegt dort nur im Speicher (nie config/agents.json).
 */
async function agentsManageChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string, focus?: string) {
    if (!shots) return;
    if (focus) await js(`document.querySelector(${JSON.stringify(focus)}).scrollIntoView({ block: "start" })`);
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const key = (k: string) => `[data-focus-key=${JSON.stringify(k)}]`;
  const clickKey = (k: string) => js(`document.querySelector(${JSON.stringify(key(k))}).click()`);
  const typeKey = (k: string, value: string) =>
    js(`(() => { const i = document.querySelector(${JSON.stringify(key(k))}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input")); })()`);
  const text = (sel: string) => js<string>(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
  try {
    for (const scheme of schemes) {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Agenten verwalten ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        const agentsDemo = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
        );
        try {
          const url = `${agentsDemo.server.url}/`;
          await goto(url);
          await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-443")`);
          await goto(`${url}#/einstellungen/agenten`);
          await waitFor(`document.querySelectorAll(".settings-agent-head").length === 8 && !!document.querySelector('[data-focus-key="create-open"]')`);
          check(`${label}: „Neuer Agent" oben, acht Agenten`, (await count(".settings-agent-head")) === 8);

          // Prompt: Kennzeichnung, feste Höhe mit Scrollen, als Text
          await clickKey("agent:research");
          await waitFor(`!!document.querySelector('[data-focus-key="prompt-view:research"]')`);
          check(`${label}: Prompt sichtbar mit „Standard"`,
            (await text(".settings-badge")) === "Standard" && (await text(key("prompt-view:research"))).includes("Research-Agent"));
          check(`${label}: Prompt-Fläche in fester Höhe, scrollt in sich`,
            await js<boolean>(`(() => { const s = getComputedStyle(document.querySelector(".settings-prompt")); return s.overflowY === "auto" && s.maxHeight === "256px" && s.whiteSpace === "pre-wrap"; })()`));
          check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          await shoot(`agenten-prompt-${size.width}${suffix}`, '[data-focus-key="agent:research"]');

          await clickKey("prompt-edit:research");
          await waitFor(`!!document.querySelector('[data-focus-key="prompt-text:research"]')`);
          await typeKey("prompt-text:research", "Du recherchierst. <b>Nie</b> ohne Quelle.\n\nZweiter Absatz.");
          await clickKey("prompt-save:research");
          await waitFor(`document.querySelector(".settings-badge") && document.querySelector(".settings-badge").textContent === "Angepasst"`);
          check(`${label}: Prompt gespeichert, HTML bleibt Text`,
            (await text(key("prompt-view:research"))).startsWith("Du recherchierst. <b>Nie</b>") && (await count(".settings-prompt b")) === 0 &&
              !!(await js(`document.querySelector('[data-focus-key="prompt-reset:research"]')`)));
          await clickKey("prompt-reset:research");
          await waitFor(`!!document.querySelector('[data-focus-key="prompt-reset-no:research"]')`);
          check(`${label}: Zurücksetzen fragt erst nach`, (await text(".settings-agent-body .actions-question")).includes("auf den Standard zurücksetzen?"));
          await clickKey("prompt-reset-yes:research");
          await waitFor(`document.querySelector(".settings-badge").textContent === "Standard"`);
          check(`${label}: zurückgesetzt auf „Standard"`, (await text(key("prompt-view:research"))).includes("Research-Agent"));

          // Board-Schalter
          await clickKey("board:research:off");
          await waitFor(`document.querySelector('[data-focus-key="board:research:off"]').getAttribute("aria-checked") === "true"`);
          check(`${label}: Board-Schalter auf Aus`, true);
          await shoot(`agenten-board-${size.width}${suffix}`, '[data-focus-key="board:research:on"]');

          // Löschen: Topics genannt, erst mit Kennung
          await clickKey("delete:research");
          await waitFor(`!!document.querySelector('[data-focus-key="delete-input:research"]')`);
          check(`${label}: Rückfrage nennt das Topic „Recherche"`, (await text(".settings-affected")).includes("„Recherche“ (Topic 443)"));
          check(`${label}: Löschen gesperrt ohne Kennung`, await js<boolean>(`document.querySelector('[data-focus-key="delete-yes:research"]').disabled`));
          await typeKey("delete-input:research", "research");
          await shoot(`agenten-loeschen-${size.width}${suffix}`, ".settings-affected");
          await clickKey("delete-yes:research");
          await waitFor(`!document.querySelector('[data-focus-key="agent:research"]') && !!document.querySelector('[data-focus-key="restore:research"]')`);
          check(`${label}: gelöscht, unter „Gelöschte Agenten"`, (await text(".settings-agent-notice")).includes("gelöscht"));

          // Neuer Agent: erst mit Feldfehler, dann richtig
          await clickKey("create-open");
          await waitFor(`!!document.querySelector('[data-focus-key="create-name"]')`);
          await typeKey("create-name", "X");
          await typeKey("create-description", "Plant Projekte in Meilensteinen");
          await typeKey("create-prompt", "Du planst Projekte.");
          await clickKey("create-submit");
          await waitFor(`!!document.getElementById("settings-create-name-error")`);
          check(`${label}: Feldfehler an der Kennung`, (await text("#settings-create-name-error")).startsWith("Kennung"));
          check(`${label}: Formular ohne seitliches Scrollen`, await noHorizontalScroll(size.width));
          await shoot(`agenten-neu-${size.width}${suffix}`, "#settings-create-title");
          await typeKey("create-name", "projekt-planer");
          await clickKey("create-submit");
          await waitFor(`!!document.querySelector('[data-focus-key="agent:projekt-planer"]') && !!document.querySelector('[data-focus-key="prompt-view:projekt-planer"]')`);
          check(`${label}: neuer Agent in der Liste, „Eigener Agent"`,
            [...(await js<string[]>(`[...document.querySelectorAll(".settings-badge")].map(b => b.textContent)`))].includes("Eigener Agent"));

          // Wiederherstellen
          await clickKey("restore:research");
          await waitFor(`!!document.querySelector('[data-focus-key="agent:research"]')`);
          check(`${label}: Research wiederhergestellt`, !(await js(`document.querySelector('[data-focus-key="restore:research"]')`)));

          // Zurück zum Chat: Auswahl und Seitenleiste ohne Neuladen aktuell
          await js(`document.getElementById("settings-back").click()`);
          await waitFor(`document.getElementById("main").dataset.view === "chat"`);
          check(`${label}: Topic „Recherche" nutzt jetzt General`,
            (await js<string>(`document.querySelector('.conversation[data-id="topic-443"] .conversation-meta').dataset.agent`)) === "general");
          if (size.mobile) await openDrawer();
          await js(`document.getElementById("new-chat").click()`);
          await waitFor(`!!document.querySelector('[data-agent-option="projekt-planer"]')`);
          check(`${label}: „Neues Gespräch" bietet den neuen Agenten an`, (await count("[data-agent-option]")) === 9);
          await pressKey("Escape", "Escape", 27);
        } finally {
          await agentsDemo.stop();
        }
      }
    }
  } finally {
    await cdp("Emulation.setEmulatedMedia", { features: [] });
  }
}

/**
 * Reiter „Modelle" und „Status" (Issue #39), je 1280 und 390 px, hell (mit
 * --screenshots auch dunkel). Nur Demo-Attrappen: Einstellungen im Speicher,
 * eine lange OpenRouter-Liste ohne Netz, und ein Status, der nach „Jetzt neu
 * starten" nur im Speicher einen neuen Prozessstart vortäuscht. Es entsteht
 * nie ein echter Neustart-Marker.
 */
/**
 * Motor in der WebUI (Issue #126): Abschnitt „Motor" oben im Reiter Modelle
 * (Verfügbarkeit, Standard, Codex, abweichende Gespräche), Motor-Pille in der
 * Kopfzeile, Motor in der Antwort-Angabe, Live-Wechsel über das SSE-Ereignis
 * engine und die Motoren im Status. Seit Issue #129 auch OpenCode: Gruppe
 * „OpenCode" mit Modell-Liste der Attrappe, Variante und Rechten, Topic
 * „Finanzen" mit OpenCode-Pille. Alles gegen die Demo-Attrappen: nie ein
 * echtes claude, codex oder opencode. 390/1280 px, hell und dunkel.
 */
async function engineChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const pillText = `(() => { const p = document.getElementById("engine-name"); return p && !p.hidden && p.getClientRects().length ? p.innerText : ""; })()`;
  const patchSettings = (body: unknown) =>
    js<number>(`fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
  for (const scheme of schemes) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Motor ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const keyReading = await createDemoOpenRouterKey().read();
      let keyStatus: OpenRouterKeyStatus = keyReading;
      let demoEngineNow = Date.now();
      const engineSettings = createDemoSettings(structuredClone(DEMO_SETTINGS));
      const engineExample = { delayMs: 300, stepMs: 700, notice: DEMO_ENGINE_HINT, replyInfo: { engine: "codex" as const, model: "gpt-6-astra" } };
      const d = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat(engineExample), telegramChat: createFakeChat(engineExample),
          settings: engineSettings, engines: createDemoEngines(engineSettings, { now: () => demoEngineNow }),
          openrouterKey: { read: async () => structuredClone(keyStatus) }, log: () => {} }
      );
      try {
        const url = `${d.server.url}/`;
        // --- Einstellungen: Abschnitt „Motor" ---
        await goto(`${url}#/einstellungen/modelle`);
        await waitFor(`!!document.getElementById("settings-g-engine-default") && document.querySelectorAll(".settings-engine-overrides li").length === 2 && document.querySelectorAll("#settings-panel .settings-engines li").length === 4 && !!document.getElementById("settings-g-engine-opencodeModel")`);
        check(`${label}: Abschnitt „Motor" ganz oben im Reiter Modelle`,
          await js<boolean>(`(() => { const h = document.querySelector("#settings-panel h3"); const list = document.getElementById("settings-g-title-defaults");
            return h && h.textContent === "Motor" && !!list && (h.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) > 0; })()`));
        check(`${label}: Verfügbarkeit je Motor aus der Attrappe`,
          JSON.stringify(await js<string[]>(`[...document.querySelectorAll("#settings-panel .settings-engines .settings-key-state")].map(e => e.textContent)`)) ===
            JSON.stringify(["angemeldet, Version 2.1.281", "angemeldet, Version 0.155.1", "nicht installiert", "angemeldet"]));
        check(`${label}: Standard-Motor, Codex-Modell mit Platzhalter, Rechte „Voller Zugriff (Standard)"`,
          (await js<string>(`document.getElementById("settings-g-engine-default").options[0].textContent`)) === "Standard (Claude Code, Voreinstellung)" &&
            (await js<string>(`document.getElementById("settings-g-engine-codexModel").placeholder`)) === "Standard aus der Codex-Konfiguration" &&
            (await js<string>(`document.getElementById("settings-g-engine-codexSandbox").selectedOptions[0].textContent`)) === "Voller Zugriff (Standard)");
        check(`${label}: abweichendes Gespräch „Recherche" mit Pille „Codex" und leisem „Auf Standard"`,
          await js<boolean>(`(() => { const li = [...document.querySelectorAll(".settings-engine-overrides li")].find(l => l.querySelector(".settings-engine-title").textContent === "Recherche");
            const b = li.querySelector("button"); return li.querySelector(".settings-engine-title").textContent === "Recherche" &&
              li.querySelector(".engine-pill").textContent === "Codex" && b.textContent === "Auf Standard" && b.className === "quiet-button"; })()`));
        check(`${label}: abweichendes Gespräch „Finanzen" mit Pille „OpenCode"`,
          await js<boolean>(`(() => { const li = [...document.querySelectorAll(".settings-engine-overrides li")].find(l => l.querySelector(".settings-engine-title").textContent === "Finanzen");
            return !!li && li.querySelector(".engine-pill").textContent === "OpenCode"; })()`));
        // --- Gruppe „OpenCode" (Issue #129) ---
        check(`${label}: OpenCode im Standard-Motor wählbar`,
          JSON.stringify(await js<string[]>(`[...document.getElementById("settings-g-engine-default").options].slice(1).map(o => o.textContent)`)) ===
            JSON.stringify(["Claude Code", "Codex", "OpenCode", "Anthropic API"]));
        check(`${label}: OpenCode-Modell aus der Attrappe, OpenRouter zuerst, Standard bleibt gewählt`,
          JSON.stringify(await js<string[]>(`[...document.getElementById("settings-g-engine-opencodeModel").options].map(o => o.textContent)`)) ===
            JSON.stringify(["Standard aus der OpenCode-Konfiguration", "openrouter/anthropic/claude-opus-5.5", "openrouter/moonshotai/kimi-k2", "openrouter/openai/gpt-5.5", "openai/gpt-5.5", "Eigenes Modell …"]) &&
            (await js<number>(`document.getElementById("settings-g-engine-opencodeModel").selectedIndex`)) === 0);
        check(`${label}: OpenCode-Variante frei, Rechte „Automatisch freigeben (Standard)", Verfügbarkeit nicht installiert`,
          (await js<string>(`document.getElementById("settings-g-engine-opencodeVariant").placeholder`)) === "Standard von OpenCode" &&
            (await js<string>(`document.getElementById("settings-g-engine-opencodePermission").selectedOptions[0].textContent`)) === "Automatisch freigeben (Standard)" &&
            (await js<string>(`document.querySelector('.settings-engine-state[data-engine="opencode"]').textContent`)) === "OpenCode: OpenCode ist nicht installiert" &&
            (await noHorizontalScroll(size.width)));
        // M14-23: Stufen nach Kennung, neutraler Zustand und Umbruch auf dem Handy.
        check(`${label}: nummerierte Reihenfolge, korrektes General-Modell und feste letzte Zeile`, await js<boolean>(`(() => {
          const list = document.querySelector(".settings-motor-order");
          return list.tagName === "OL" && list.children.length === 6 && list.children[0].querySelector(".settings-motor-model").textContent === "claude-fable-5-2 · Modell des Agenten"
            && list.lastElementChild.textContent === "Ersatzmodelle mit eingeschränktem Werkzeugumfang";
        })()`));
        check(`${label}: gesperrt bis ist normaler Zustand, kein Rot und keine Bewegung`, await js<boolean>(`(() => {
          const entry = document.querySelector('.settings-motor-state[data-state="blocked"]');
          const style = getComputedStyle(entry); const section = document.querySelector('.settings-motor-order');
          return entry.textContent.startsWith("gesperrt bis ") && style.color === getComputedStyle(section).color
            && style.animationName === "none" && style.transitionDuration === "0s";
        })()`));
        check(`${label}: Zeilen ohne seitliches Scrollen, auf 390 px Zustand unter Name`, (await noHorizontalScroll(size.width)) && await js<boolean>(`(() => {
          const rows = [...document.querySelectorAll(".settings-motor-row")];
          return rows.every(row => { const name = row.children[0].getBoundingClientRect(); const state = row.children[1].getBoundingClientRect();
            return ${size.width} > 390 || state.top >= name.bottom; });
        })()`));
        check(`${label}: Knöpfe für Ersatzstufen mindestens 44 mal 44 Pixel`, await js<boolean>(`[...document.querySelectorAll(".settings-motor-actions button")].every(b => { const r = b.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && !!b.getAttribute("aria-label"); })`));
        // Enter aktiviert den fokussierten Knopf über den Browser, auch am Listenrand bleibt er fokussierbar.
        await js(`document.querySelector('[data-focus-key="engine-stage:codex:up"]').focus()`);
        await pressKey("Enter", "Enter", 13, "\r");
        check(`${label}: Verschieben mit Tastatur hält Fokus, Zustand und Ansage an Codex`, await js<boolean>(`(() => {
          const list = document.querySelector(".settings-motor-order"); const focus = document.activeElement;
          return list.children[1].dataset.stageId === "codex" && list.children[1].querySelector(".settings-motor-state").textContent === "antwortet"
            && focus.dataset.focusKey === "engine-stage:codex:up" && focus.getAttribute("aria-disabled") === "true" && !focus.disabled
            && document.querySelector(".settings-engine-live").textContent === "Codex steht jetzt an Position 2.";
        })()`));
        await pressKey("Tab", "Tab", 9);
        await pressKey("Enter", "Enter", 13, "\r");
        check(`${label}: Tab zum Runter-Knopf und Enter stellt Reihenfolge wieder her`, await js<boolean>(`document.querySelector(".settings-motor-order").children[2].dataset.stageId === "codex" && document.activeElement.dataset.focusKey === "engine-stage:codex:down"`));
        // Modellvorschau reagiert vor dem Speichern auf Motor und freie Eingabe.
        await js(`(() => { const field = document.getElementById("settings-g-engine-default"); field.value = "codex"; field.dispatchEvent(new Event("change")); })()`);
        check(`${label}: anderer Standard zeigt vor Speichern die Codex-Konfiguration`, await js<boolean>(`document.querySelector('[data-focus-key="engine-model:0"]').textContent === "Standard aus der Codex-Konfiguration"`));
        await js(`(() => { const field = document.getElementById("settings-g-engine-codexModel"); field.value = "vorschau-modell"; field.dispatchEvent(new Event("input")); })()`);
        check(`${label}: Modellvorschau folgt dem freien Feld sofort`, await js<boolean>(`document.querySelector('[data-focus-key="engine-model:0"]').textContent === "vorschau-modell"`));
        await js(`(() => { const field = document.getElementById("settings-g-engine-codexModel"); field.value = ""; field.dispatchEvent(new Event("input")); const motor = document.getElementById("settings-g-engine-default"); motor.value = " standard"; motor.dispatchEvent(new Event("change")); })()`);
        await js(`(() => { const original = window.fetch.bind(window); window.__engineChecks = 0; window.__openrouterChecks = 0;
          window.fetch = async (...args) => {
            if (args[0] === "/api/engines/check" && args[1]?.method === "POST") { window.__engineChecks++; await new Promise(r => setTimeout(r, 150)); }
            if (args[0] === "/api/engines/openrouter") window.__openrouterChecks++;
            return original(...args);
          };
          const button = document.querySelector('[data-focus-key="engine-check"]'); button.click(); button.click();
        })()`);
        check(`${label}: Jetzt messen während Anfrage deaktiviert`, await js<boolean>(`document.querySelector('[data-focus-key="engine-check"]').disabled`));
        await waitFor(`!document.querySelector('[data-focus-key="engine-check"]').disabled`);
        check(`${label}: Jetzt messen genau ein POST, Ergebnis sichtbar`, await js<boolean>(`window.__engineChecks === 1 && document.querySelectorAll(".settings-motor-measure-result").length > 0`));
        await js(`document.getElementById("settings-engine-usage-title").scrollIntoView({ block: "start" })`);
        await shoot(`einstellungen-motor-stand-${size.width}${suffix}`);
        // M14-24: reine Anzeige des Ersatzmodell-Schlüssels, alle Werte aus der Demo.
        await waitFor(`!!document.querySelector(".settings-openrouter-key") && window.__openrouterChecks === 1`);
        check(`${label}: OpenRouter mit Rest, Limit, Erneuerung, Alter und Hinweis auf eigene OpenCode-Anmeldung`, await js<boolean>(`(() => {
          const row = document.querySelector(".settings-openrouter-key");
          return row.querySelector("h4").textContent === "OpenRouter (Schlüssel der Ersatzmodelle)"
            && row.querySelector(".settings-motor-reading").textContent === "12,40 $ von 50,00 $ übrig · Limit erneuert sich monatlich · vor 3 Minuten"
            && row.lastElementChild.textContent === "OpenCode nutzt seine eigene Anmeldung. Das kann ein anderer Schlüssel sein als dieser."
            && (document.querySelector(".settings-motor-usage").compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) > 0;
        })()`));
        await js(`document.querySelector(".settings-openrouter-key").scrollIntoView({ block: "center" })`);
        check(`${label}: OpenRouter ohne seitliches Scrollen und mit tabellarischen Ziffern`, (await noHorizontalScroll(size.width)) &&
          await js<boolean>(`getComputedStyle(document.querySelector(".settings-openrouter-key .settings-motor-reading")).fontVariantNumeric === "tabular-nums"`));
        await shoot(`einstellungen-openrouter-${size.width}${suffix}`);
        keyStatus = { configured: true, error: "OpenRouter ist gerade nicht erreichbar" };
        await js(`document.querySelector('[data-focus-key="engine-check"]').click()`);
        await waitFor(`document.querySelector(".settings-openrouter-key .settings-motor-reading").textContent === "OpenRouter ist gerade nicht erreichbar"`);
        check(`${label}: OpenRouter-Fehler gedämpft, ohne Rot, Motorabschnitt weiter benutzbar`, await js<boolean>(`(() => {
          const row = document.querySelector(".settings-openrouter-key");
          return getComputedStyle(row.querySelector(".settings-motor-reading")).color === getComputedStyle(row.lastElementChild).color
            && !row.querySelector(".actions-error") && !document.querySelector('[data-focus-key="engine-check"]').disabled
            && !document.getElementById("settings-g-engine-default").disabled;
        })()`));
        keyStatus = { configured: true, limit: null, remaining: null, limitReset: null, usage: 37.6, usageMonthly: 3.2, fetchedAt: new Date().toISOString() };
        await js(`document.querySelector('[data-focus-key="engine-check"]').click()`);
        check(`${label}: ohne Limit nur Monatsverbrauch`, await waitFor(`document.querySelector(".settings-openrouter-key .settings-motor-reading").textContent.startsWith("kein Limit am Schlüssel, in diesem Monat 3,20 $ verbraucht")`));
        keyStatus = { configured: false };
        await js(`document.querySelector('[data-focus-key="engine-check"]').click()`);
        check(`${label}: ohne konfigurierten Schlüssel keine Zeile`, await waitFor(`!document.querySelector(".settings-openrouter-key")`));
        keyStatus = keyReading;
        await js(`document.querySelector('[data-focus-key="engine-check"]').click()`);
        await waitFor(`!!document.querySelector(".settings-openrouter-key")`);
        await js(`document.getElementById("settings-engine-auto-title").scrollIntoView({ block: "start" })`);
        await shoot(`einstellungen-motor-automatik-${size.width}${suffix}`);
        await js(`document.querySelector('[data-focus-key="engine-fallback"]').click()`);
        check(`${label}: Fallback-Knopf fokussiert den Abschnitt ohne Routerwechsel`, await js<boolean>(`location.hash === "#/einstellungen/modelle" && document.activeElement.id === "settings-g-title-fallback"`));

        await js(`window.scrollTo(0, 0); document.getElementById("settings-panel").scrollIntoView()`);
        await shoot(`einstellungen-motor-${size.width}${suffix}`);
        await js(`document.querySelector('[aria-labelledby="settings-g-engine-opencode"]').scrollIntoView({ block: "start" })`);
        await shoot(`einstellungen-opencode-${size.width}${suffix}`);

        await goto(`${url}#/einstellungen/agenten`);
        await waitFor(`!!document.querySelector('.settings-engine-link a') && !!document.querySelector('[data-focus-key="agent:research"]')`);
        check(`${label}: Agenten verweisen auf Modelle, ohne Motorabschnitt`, await js<boolean>(`document.querySelector(".settings-engine-link").textContent === "Standard-Motor und Ersatzstufen stehen unter Modelle." && document.querySelector(".settings-engine-link a").getAttribute("href") === "#/einstellungen/modelle" && !document.getElementById("settings-g-title-engine")`));
        check(`${label}: Agenten-Modell „gilt für Claude Code und Anthropic API" nach dem Aufklappen, kein seitliches Scrollen`,
          (await js(`document.querySelector('[data-focus-key="agent:research"]').click()`), await waitFor(`!!document.querySelector(".settings-engine-scope")`)) &&
            (await js<string>(`document.querySelector(".settings-engine-scope").textContent`)) === "gilt für Claude Code und Anthropic API" && (await noHorizontalScroll(size.width)));
        await js(`document.querySelector('[data-focus-key="agent:research"]').click()`);

        // --- Gespräch mit Codex-Pille und Antwort-Angabe ---
        await goto(url);
        await waitFor(`!!document.querySelector('.conversation[data-id="topic-443"]')`);
        await clickEntry("topic-443");
        await waitFor(`document.getElementById("agent-name").textContent === "Research" && document.querySelectorAll(".msg-assistant .msg-meta").length === 2`);
        check(`${label}: Kopfzeile mit Pille „Codex" neben dem Agent-Chip`, await waitFor(`${pillText} === "Codex"`) &&
          (await js<boolean>(`(() => { const a = document.getElementById("agent-name").getBoundingClientRect(); const p = document.getElementById("engine-name").getBoundingClientRect();
            return p.left >= a.right && Math.abs((p.top + p.bottom) / 2 - (a.top + a.bottom) / 2) <= 2; })()`)));
        check(`${label}: Antwort-Angaben nennen den Motor (Claude Code, Codex)`,
          JSON.stringify(await js<string[]>(`[...document.querySelectorAll(".msg-assistant .msg-meta")].map(m => m.textContent)`)) ===
            JSON.stringify(["Research · Claude Code · claude-opus-5-5 · 8 s", "Research · Codex · gpt-5.6-sol · 13 s"]));
        check(`${label}: Pille mit Haarlinie ohne Fläche, Kopfzeile ohne seitliches Scrollen`,
          (await js<boolean>(`(() => { const s = getComputedStyle(document.getElementById("engine-name")); return s.borderTopWidth === "1px" && s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderTopLeftRadius !== "0px"; })()`)) &&
            (await noHorizontalScroll(size.width)));
        await shoot(`gespraech-codex-${size.width}${suffix}`);

        // --- Gespräch mit OpenCode-Pille und Antwort-Angabe (Issue #129) ---
        await clickEntry("topic-12");
        await waitFor(`document.getElementById("agent-name").textContent === "Finance" && document.querySelectorAll(".msg-assistant .msg-meta").length === 1`);
        check(`${label}: Kopfzeile in Finanzen zeigt die bereite Ersatzstufe statt des fehlenden OpenCode`, await waitFor(`${pillText} === "Codex · springt ein"`) &&
          (await js<string>(`document.getElementById("engine-name").dataset.engine`)) === "codex");
        check(`${label}: Antwort-Angabe nennt OpenCode und das OpenRouter-Modell`,
          (await js<string>(`document.querySelector(".msg-assistant .msg-meta").textContent`)) === "Finance · OpenCode · openrouter/anthropic/claude-opus-5.5 · 8 s" &&
            (await noHorizontalScroll(size.width)));
        await shoot(`gespraech-opencode-${size.width}${suffix}`);
        await js(`document.getElementById("engine-name").click()`);
        await waitFor(`document.querySelector('[data-engine-choice="opencode"]')?.getAttribute("aria-checked") === "true"`);
        check(`${label}: gewählter, nicht bereiter Motor markiert und deaktiviert, Standard wählbar`, await js<boolean>(`document.querySelector('[data-engine-choice="opencode"]').getAttribute("aria-disabled") === "true" && document.querySelector('[data-engine-choice="standard"]').getAttribute("aria-disabled") === "false"`));
        await shoot(`motor-menue-nicht-bereit-${size.width}${suffix}`);
        await pressKey("Escape", "Escape", 27);

        // Direktchat: Fable gesperrt, Opus pausiert, Codex antwortet als Ersatz.
        await clickEntry("dm");
        await waitFor(`document.getElementById("agent-name").textContent === "General"`);
        check(`${label}: Direktchat mit „Codex · springt ein“`, await waitFor(`${pillText} === "Codex · springt ein"`));
        const headerFits = `(() => {
          const p = document.getElementById("engine-name"), r = p.getBoundingClientRect();
          const h = document.querySelector(".topbar").getBoundingClientRect();
          const t = document.querySelector(".chat-title").getBoundingClientRect();
          return r.left >= h.left && r.right <= h.right && r.top >= h.top && r.bottom <= h.bottom
            && p.scrollWidth <= p.clientWidth + 1 && t.width >= 64;
        })()`;
        check(`${label}: Pille passt vollständig, Titel hat mindestens 64 px`, await js<boolean>(headerFits));
        check(`${label}: title und Live-Zeile nennen Sperrgrund und Bot-Zeit`, await js<boolean>(`(() => {
          const p = document.getElementById("engine-name"); return p.title.includes("Woche, Fable: 96 %")
            && p.title.includes("Codex springt ein.") && !p.title.includes("/motor") && !p.hasAttribute("aria-label") && document.getElementById("engine-status").textContent === p.title;
        })()`));
        await waitFor(`[...document.querySelectorAll(".msg-notice")].some(n => n.textContent.includes("Motorwechsel:"))`);
        check(`${label}: Wechselmeldung als Dienst mit Uhrzeit und Haarlinie`, await js<boolean>(`(() => {
          const n = [...document.querySelectorAll(".msg-notice")].find(n => n.textContent.includes("Motorwechsel:"));
          return !!n && n.querySelector(".notice-source").textContent === "System" && !!n.querySelector(".notice-time")
            && getComputedStyle(n.querySelector(".notice-body")).borderLeftWidth === "1px" && !n.querySelector(".msg-head");
        })()`));
        await shoot(`motor-chat-ersatz-${size.width}${suffix}`);
        // Menü: echte Tastatur, gemeinsame Menüverwaltung und Gesprächsdaten.
        const menuOpen = `document.getElementById("engine-name").getAttribute("aria-expanded") === "true"`;
        await js(`document.getElementById("engine-name").focus()`);
        await pressKey("Enter", "Enter", 13, "\r");
        await waitFor(`document.querySelector('[data-engine-choice="standard"]')?.getAttribute("aria-checked") === "true"`);
        check(`${label}: Enter öffnet das Menü, aria-expanded und Anfangsfokus stimmen`, await js<boolean>(`${menuOpen} && document.activeElement.dataset.engineChoice === "standard" && document.getElementById("engine-name").getAttribute("aria-haspopup") === "menu"`));
        await pressKey("ArrowDown", "ArrowDown", 40);
        check(`${label}: Pfeil ab fokussiert Claude Code`, await js<boolean>(`document.activeElement.dataset.engineChoice === "claude"`));
        await pressKey("End", "End", 35);
        check(`${label}: Ende erreicht den Einstellungslink`, await js<boolean>(`document.activeElement.textContent === "Reihenfolge und Limits"`));
        await pressKey("Home", "Home", 36);
        await pressKey("ArrowUp", "ArrowUp", 38);
        check(`${label}: Pos1 und Pfeil auf gehen vom Anfang zum Ende`, await js<boolean>(`document.activeElement.textContent === "Reihenfolge und Limits"`));
        await pressKey("Escape", "Escape", 27);
        check(`${label}: Escape schließt, aria-expanded false und Fokus zurück auf Pille`, await js<boolean>(`!(${menuOpen}) && document.getElementById("engine-menu").hidden && document.activeElement.id === "engine-name"`));
        await pressKey("Enter", "Enter", 13, "\r");
        await js(`document.getElementById("input").click()`);
        check(`${label}: Klick daneben schließt mit Fokus auf Pille`, await js<boolean>(`!(${menuOpen}) && document.activeElement.id === "engine-name"`));
        await pressKey("Enter", "Enter", 13, "\r");
        await waitFor(`document.querySelector('[data-engine-choice="claude"] .engine-menu-state')?.textContent.startsWith("gesperrt bis ")`);
        check(`${label}: gesperrt wählbar, nicht bereit deaktiviert, API und Verbrauchshinweis vorhanden`, await js<boolean>(`(() => {
          const row = e => document.querySelector('[data-engine-choice="' + e + '"]');
          return row("claude").getAttribute("aria-disabled") === "false" && row("claude").textContent.includes("bis dahin springt die nächste Stufe ein")
            && row("opencode").getAttribute("aria-disabled") === "true" && row("api").textContent.includes("zahlt je Verbrauch");
        })()`));
        check(`${label}: Menü bleibt im Gesprächsbereich, Zeilen und Trefferfläche mindestens 44 px, ohne Bewegung`, await js<boolean>(`(() => {
          const menu = document.getElementById("engine-menu"), r = menu.getBoundingClientRect(), style = getComputedStyle(menu);
          const area = document.getElementById("main").getBoundingClientRect();
          const pill = document.getElementById("engine-name");
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
            && r.left >= area.left && r.right <= area.right
            && [...menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].every(e => e.getBoundingClientRect().height >= 44)
            && parseFloat(getComputedStyle(pill, "::after").height) >= 44 && style.boxShadow === "none" && style.animationName === "none" && style.transitionDuration === "0s";
        })()`));
        await shoot(`motor-menue-${size.width}${suffix}`);
        // Eine Änderung von einem anderen Kanal lädt Liste UND Ausnahmen, ohne Fokusverlust.
        await js(`document.querySelector('[data-engine-choice="claude"]').focus(); window.__engineMenuMarker = 1`);
        const manual = await engineSettings.readForWrite();
        manual.engine!.topics = { ...manual.engine!.topics, [DEMO_DM_SESSION_KEY]: "codex" };
        await engineSettings.write(manual);
        check(`${label}: engine aktualisiert Markierung und behält offenes Menü und Fokus`, await waitFor(`document.querySelector('[data-engine-choice="codex"]')?.getAttribute("aria-checked") === "true"`, 6000)
          && await js<boolean>(`${menuOpen} && document.activeElement.dataset.engineChoice === "claude" && window.__engineMenuMarker === 1`));
        delete manual.engine!.topics![DEMO_DM_SESSION_KEY];
        await engineSettings.write(manual);
        await waitFor(`document.querySelector('[data-engine-choice="standard"]')?.getAttribute("aria-checked") === "true"`, 6000);
        // Mitschnitt: exakt eine Textnachricht, kein Upload, kein eigener Session-Reset.
        await js(`(() => { const original = window.fetch.bind(window); window.__engineMenuRequests = []; window.__engineMenuBusyOnce = false;
          window.fetch = async (...args) => {
            const path = String(args[0]), init = args[1] || {};
            if (init.method === "POST") window.__engineMenuRequests.push({ path, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
            if (path.endsWith("/messages") && init.method === "POST") {
              if (window.__engineMenuBusyOnce) { window.__engineMenuBusyOnce = false; return Response.json({ error: "Antwort läuft" }, { status: 409 }); }
              await new Promise(r => setTimeout(r, 250));
            }
            return original(...args);
          };
          const input = document.getElementById("input"); input.value = "Mein ungesendeter Entwurf"; input.dispatchEvent(new Event("input"));
          const transfer = new DataTransfer(); transfer.items.add(new File(["%PDF-1.4"], "notiz.pdf", { type: "application/pdf" }));
          const file = document.getElementById("file-input"); file.files = transfer.files; file.dispatchEvent(new Event("change"));
        })()`);
        await js(`document.querySelector('[data-engine-choice="standard"]').click()`);
        check(`${label}: bereits gewählte Zeile schließt ohne Nachricht`, await js<boolean>(`!(${menuOpen}) && window.__engineMenuRequests.length === 0`));
        await js(`document.getElementById("engine-name").click()`);
        await waitFor(`document.querySelector('[data-engine-choice="standard"]')?.getAttribute("aria-checked") === "true"`);
        await js(`document.querySelector('[data-engine-choice="codex"]').click(); document.getElementById("engine-name").click()`);
        check(`${label}: laufendes Senden sperrt erneut geöffnetes Menü`, await js<boolean>(`[...document.querySelectorAll('#engine-menu [role="menuitemradio"]')].every(e => e.getAttribute("aria-disabled") === "true")`));
        await pressKey("Escape", "Escape", 27);
        await waitFor(`document.querySelectorAll(".msg-user").length > 0 && [...document.querySelectorAll(".msg-user")].some(e => e.textContent.includes("/motor codex"))`, 10000);
        await turnDone();
        check(`${label}: /motor codex nur als text, keine Reset-Route oder Anhänge, Entwurf und Datei erhalten`, await js<boolean>(`JSON.stringify(window.__engineMenuRequests) === JSON.stringify([{ path: "/api/conversations/dm/messages", body: { text: "/motor codex" } }])
          && document.getElementById("input").value === "Mein ungesendeter Entwurf" && document.querySelectorAll("#attachments li").length === 1`));
        await js(`window.__engineMenuBusyOnce = true; document.getElementById("engine-name").click()`);
        await waitFor(`document.querySelector('[data-engine-choice="standard"]')?.getAttribute("aria-checked") === "true"`);
        await js(`document.querySelector('[data-engine-choice="codex"]').click()`);
        check(`${label}: Wettlauf 409 zeigt Hinweis im wieder geöffneten Menü`, await waitFor(`${menuOpen} && document.getElementById("engine-menu").textContent.includes("Erst die laufende Antwort abwarten oder stoppen.")`));
        await pressKey("Escape", "Escape", 27);
        await js(`document.querySelector("#attachments .attachment-remove").click(); const input = document.getElementById("input"); input.value = ""; input.dispatchEvent(new Event("input"))`);
        // Der Link führt an den Anfang des Reiters Modelle, zum Abschnitt Motor.
        await js(`document.getElementById("engine-name").click(); document.querySelector("#engine-menu a").click()`);
        check(`${label}: Link öffnet Modelle beim Motorabschnitt`, await waitFor(`location.hash === "#/einstellungen/modelle" && document.querySelector("#settings-panel h3")?.textContent === "Motor"`));
        check(`${label}: Motorabschnitt nach Link tatsächlich sichtbar`, await js<boolean>(`(() => { const title = document.getElementById("settings-g-title-engine").getBoundingClientRect(); const area = document.querySelector("#settings .settings-scroll").getBoundingClientRect(); return title.top >= area.top && title.bottom <= area.bottom; })()`));
        await js(`document.getElementById("settings-back").click()`);
        await waitFor(`document.getElementById("main").dataset.view === "chat"`);

        // Jede Gruppe der Liste, einschließlich geschlossener Topics und älterer Web-Gespräche.
        const ids = await js<string[]>(`fetch("/api/conversations").then(r => r.json()).then(b => [...b.telegram.topics, ...b.conversations].map(c => c.id))`);
        for (const id of ids) {
          await clickEntry(id);
          check(`${label}: Pille sichtbar in ${id}`, !!(await js<string>(pillText)));
        }
        await clickEntry("dm");
        await js(`window.__engineMarker = 1`);
        await patchSettings({ engine: { auto: { enabled: false } } });
        check(`${label}: Ende der Schwellensperre erscheint ohne Neuladen oder Nachricht`,
          await waitFor(`${pillText} === "Claude Code"`, 6000) && await js<boolean>(`window.__engineMarker === 1`));
        await shoot(`motor-chat-standard-${size.width}${suffix}`);
        await patchSettings({ engine: { auto: { enabled: true } } });
        await waitFor(`${pillText} === "Codex · springt ein"`, 6000);
        await js(`(() => { const i = document.getElementById("input"); i.value = "Eine Probe mit Ersatzmotor"; i.dispatchEvent(new Event("input")); document.getElementById("send").click(); })()`);
        await waitFor(`document.querySelector("#progress .step-notice")?.textContent === ${JSON.stringify(DEMO_ENGINE_HINT)}`, 10000);
        await js(`document.getElementById("activity-toggle").click()`);
        check(`${label}: Wechselhinweis in der vorhandenen Fortschrittsliste`, await js<boolean>(`(() => {
          const n = document.querySelector("#progress .step-notice"); return !!n && n.getClientRects().length > 0
            && getComputedStyle(n).color === getComputedStyle(document.body).color;
        })()`));
        await shoot(`motor-chat-hinweis-${size.width}${suffix}`);
        await js(`document.getElementById("engine-name").click()`);
        check(`${label}: während einer Antwort Wahl gesperrt, Hinweis und Link erreichbar`, await js<boolean>(`[...document.querySelectorAll('#engine-menu [role="menuitemradio"]')].every(e => e.getAttribute("aria-disabled") === "true") && document.getElementById("engine-menu").textContent.includes("Erst die laufende Antwort abwarten oder stoppen.") && !!document.querySelector('#engine-menu a[role="menuitem"]')`));
        await pressKey("Escape", "Escape", 27);
        await turnDone();
        check(`${label}: Ersatzantwort nennt Motor und Modell`, await js<boolean>(`[...document.querySelectorAll(".msg-assistant .msg-meta")].at(-1).textContent.includes("General · Codex · gpt-6-astra")`));


        if (size.width === 1280 && scheme === "light") {
          // Live: Standard auf Codex (Einstellungsseite), SSE engine, Pille ohne Neuladen
          await js(`window.__engineMarker = 1`);
          check(`${label}: PATCH Standard Codex`, (await patchSettings({ engine: { default: "codex" } })) === 200);
          check(`${label}: Standard Codex erscheint im offenen Direktchat ohne Neuladen`,
            (await waitFor(`${pillText} === "Codex"`, 6000)) && (await js<number>(`window.__engineMarker`)) === 1);
          // „Auf Standard" für „Recherche" und Standard zurück: Ersatzstufe bleibt sichtbar.
          const key = await js<string>(`fetch("/api/engines").then(r => r.json()).then(b => b.overrides[0].key)`);
          const reset = await js<number>(`fetch("/api/engines/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: ${JSON.stringify(key)} }) }).then(r => r.status)`);
          check(`${label}: „Auf Standard" über die API`, reset === 200);
          await patchSettings({ engine: { default: null } });
          check(`${label}: Standard zurück auf Claude Code: Ersatzstufe ohne Neuladen`,
            (await waitFor(`${pillText} === "Codex · springt ein"`, 6000)) && (await js<number>(`window.__engineMarker`)) === 1);
          // Status: Motoren
          await goto(`${url}#/einstellungen/status`);
          await waitFor(`!!document.querySelector('#settings-panel [aria-labelledby="settings-g-title-engines"] li')`);
          check(`${label}: Status zeigt Versionen und OpenCode als nicht installiert`,
            JSON.stringify(await js<string[]>(`[...document.querySelectorAll('[aria-labelledby="settings-g-title-engines"] .settings-key-state')].map(e => e.textContent)`)) ===
              JSON.stringify(["angemeldet, Version 2.1.281", "angemeldet, Version 0.155.1", "nicht installiert", "angemeldet"]));
        }
        // Dieselben Demo-Sperren: nach 61 Minuten endet die Opus-Pause, Fable bleibt gesperrt.
        demoEngineNow += 61 * 60_000;
        await patchSettings({ engine: { auto: { threshold: 94 } } });
        await goto(url);
        await clickEntry("dm");
        const longText = size.width === 390 ? "Claude Code · springt ein" : "Claude Code (claude-opus-5-5) · springt ein";
        check(`${label}: lange Claude-Ersatzstufe passt, Modell im vollständigen Zustand`,
          await waitFor(`${pillText} === ${JSON.stringify(longText)}`, 6000) && await js<boolean>(headerFits)
          && await js<boolean>(`document.getElementById("engine-name").title.includes("Claude Code (claude-opus-5-5) springt ein.")`));
        await shoot(`motor-chat-langes-modell-${size.width}${suffix}`);
        await js(`document.getElementById("engine-name").click()`);
        await waitFor(`document.querySelector('[data-engine-choice="claude"] .engine-menu-state')?.textContent.startsWith("gesperrt bis ")`);
        check(`${label}: Opus-Ersatz in der Pille, Fable-Wahl im Menü weiterhin gesperrt`, await js<boolean>(`document.querySelector('[data-engine-choice="claude"]').getAttribute("aria-disabled") === "false" && document.getElementById("engine-name").title.includes("claude-opus-5-5")`));
        await shoot(`motor-menue-opus-ersatz-${size.width}${suffix}`);
        await pressKey("Escape", "Escape", 27);
        // Ohne Codex und Opus in der Reihenfolge sind beide verbleibenden Stufen nicht frei.
        await patchSettings({ engine: { backups: [{ engine: "opencode" }] } });
        check(`${label}: Kein Motor frei passt und trägt keine Motor-Kennung`,
          await waitFor(`${pillText} === "Kein Motor frei"`, 6000) && await js<boolean>(headerFits)
          && await js<boolean>(`document.getElementById("engine-name").dataset.engine === "" && document.getElementById("engine-name").title.includes("Ersatzmodelle mit eingeschränktem Werkzeugumfang")`));
        await shoot(`motor-chat-keiner-${size.width}${suffix}`);
        // M14-28: offenes Agentengespräch empfängt engine ohne Nachricht oder Neuladen.
        const live = await engineSettings.readForWrite();
        live.engine = { ...live.engine, default: "claude", topics: {}, backups: [] };
        live.agents = { ...live.agents, research: { model: "claude-sonnet-5" } };
        await engineSettings.write(live);
        await goto(url);
        if (size.mobile) await openDrawer();
        await clickEntry("topic-443");
        check(`${label}: Agentengespräch vollständig geladen vor der Live-Prüfung`,
          await waitFor(`document.getElementById("chat-title").textContent === "Recherche" && ${pillText} === "Claude Code" && document.querySelectorAll(".msg").length === 4`));
        await js(`window.__agentLive = { events: 0, messages: document.querySelectorAll(".msg").length };
          window.__agentSource = new EventSource("/api/telegram/events");
          window.__agentSource.addEventListener("engine", () => window.__agentLive.events++);`);
        await waitFor(`window.__agentSource.readyState === 1`);
        for (const [engine, expected] of [["codex", "Codex"], ["api", "Anthropic API"], [null, "Claude Code"]] as const) {
          const eventsBefore = await js<number>(`window.__agentLive.events`);
          check(`${label}: Agentenmotor ${engine ?? "Standard"} gespeichert`, (await patchSettings({ agents: { research: { engine } } })) === 200);
          check(`${label}: engine aktualisiert Agentenpille auf ${expected} ohne Nachricht oder Neuladen`,
            await waitFor(`${pillText} === ${JSON.stringify(expected)} && window.__agentLive.events > ${eventsBefore}`, 6000)
            && await js<boolean>(`document.querySelectorAll(".msg").length === window.__agentLive.messages && document.getElementById("engine-name").title === ${JSON.stringify(expected + " antwortet.")}`));
          if (engine === "codex") await shoot(`agenten-motor-live-${size.width}${suffix}`);
        }
        await js(`window.__agentSource.close()`);

      } finally {
        await d.stop();
      }
    }
  }
  // Klick auf „Auf Standard" im Browser, einmal (hell, 1280)
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  const d = await startDemoServer({ host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] }, { chat: createFakeChat(), telegramChat: createFakeChat(), log: () => {} });
  try {
    await goto(`${d.server.url}/#/einstellungen/modelle`);
    await waitFor(`document.querySelectorAll(".settings-engine-overrides li").length === 2`);
    await js(`document.querySelector(".settings-engine-overrides li button").click()`);
    check("Motor: Klick auf „Auf Standard\" entfernt genau eine Zeile und meldet es",
      await waitFor(`document.querySelectorAll(".settings-engine-overrides li").length === 1 && [...document.querySelectorAll("#settings-panel .settings-status")].some(e => e.textContent === "Auf Standard gestellt.")`));
    await js(`document.querySelector(".settings-engine-overrides li button").click()`);
    check("Motor: zweiter Klick leert die Liste",
      await waitFor(`document.querySelectorAll(".settings-engine-overrides li").length === 0`));
    check("Motor: danach „Keine. Es gilt der Motor des Agenten, sonst der Standard.\"",
      await js<boolean>(`[...document.querySelectorAll("#settings-panel .settings-empty")].some(e => e.textContent === "Keine. Es gilt der Motor des Agenten, sonst der Standard.")`));
    // Standard Codex über das Formular speichern
    await js(`(() => { const s = document.getElementById("settings-g-engine-default"); s.value = "codex"; s.dispatchEvent(new Event("change")); })()`);
    await js(`document.querySelector('[data-focus-key="save:section-engine"]').click()`);
    check("Motor: Standard „Codex\" über das Formular gespeichert",
      await waitFor(`[...document.querySelectorAll("#settings-panel .settings-status")].some(e => e.textContent === "Gespeichert.")`) &&
        (await js<string>(`fetch("/api/settings").then(r => r.json()).then(b => b.settings.engine && b.settings.engine.default)`)) === "codex");
    // OpenCode (Issue #129): Standard, Modell aus der Liste, Variante, Rechte über das Formular
    await waitFor(`!document.querySelector('[data-focus-key="save:section-engine"]').textContent.includes("…")`);
    await js(`(() => {
      const set = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event("change")); };
      set("settings-g-engine-default", "opencode");
      set("settings-g-engine-opencodeModel", "openrouter/anthropic/claude-opus-5.5");
      const v = document.getElementById("settings-g-engine-opencodeVariant"); v.value = "high"; v.dispatchEvent(new Event("input"));
      set("settings-g-engine-opencodePermission", "ask-deny");
      document.querySelector('[data-focus-key="save:section-engine"]').click();
    })()`);
    const savedEngine = () => js<string>(`fetch("/api/settings").then(r => r.json()).then(b => JSON.stringify(b.settings.engine))`);
    // „Auf Standard" entfernt nur Topic-Ausnahmen; die Standard-Wechsel entfernen jeweils die doppelte Ersatzstufe.
    const wantEngine = JSON.stringify({ ...DEMO_SETTINGS.engine, topics: undefined, default: "opencode",
      backups: DEMO_SETTINGS.engine!.backups!.filter(stage => stage.engine !== "codex" && stage.engine !== "opencode"),
      opencode: { model: "openrouter/anthropic/claude-opus-5.5", variant: "high", permission: "ask-deny" } });
    let engineSaved = false;
    for (let i = 0; i < 60 && !engineSaved; i++) {
      engineSaved = (await savedEngine()) === wantEngine;
      if (!engineSaved) await Bun.sleep(100);
    }
    check("Motor: OpenCode als Standard mit Modell, Variante und Rechten über das Formular gespeichert", engineSaved);
    // Ungültige Variante: Meldung im Browser, nichts gesendet
    await js(`(() => { const v = document.getElementById("settings-g-engine-opencodeVariant"); v.value = "High"; v.dispatchEvent(new Event("input")); document.querySelector('[data-focus-key="save:section-engine"]').click(); })()`);
    check("Motor: ungültige OpenCode-Variante zeigt eine Meldung, gespeichert bleibt high",
      (await waitFor(`[...document.querySelectorAll("#settings-panel .actions-error")].some(e => e.textContent.startsWith("Die Variante besteht aus 1 bis 20 Zeichen"))`)) &&
        (await js<string>(`fetch("/api/settings").then(r => r.json()).then(b => b.settings.engine.opencode.variant)`)) === "high");
  } finally {
    await d.stop();
  }
}

async function modelsStatusChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const click = (sel: string) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const setSelect = (id: string, value: string) =>
    js(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change")); })()`);
  const typeInto = (sel: string, value: string) =>
    js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input")); })()`);
  const statusText = `[...document.querySelectorAll("#settings-panel .settings-status")].map(e => e.textContent).join(" | ")`;
  const openrouter = Array.from({ length: 320 }, (_, i) => ({ id: `vendor${i % 9}/modell-${i}`, name: `Modell ${i}` }))
    .concat([{ id: "moonshotai/kimi-k3", name: "Kimi K3" }, { id: "minimax/minimax-m2.7", name: "MiniMax M2.7" }]);
  try {
    for (const scheme of schemes) {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Modelle/Status ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        const settings = createDemoSettings();
        const base = createDemoStatus();
        let longToolNames = false;
        // Nach der Anforderung meldet der Status nach kurzer Zeit einen neuen Prozessstart, nur im Speicher
        let restartedAt: number | null = null;
        const status = {
          ...base,
          engines: async () => {
            const engines = await base.engines!();
            if (longToolNames) {
              const tools = engines.find(e => e.engine === "codex")!.tools!;
              // Obergrenze je Liste und 64 Zeichen ohne Leerzeichen, über die echte Status-API.
              const names = Array.from({ length: 100 }, (_, i) => "w" + String(i).padStart(3, "0") + "x".repeat(60));
              tools.inventory.mcp = names.map(name => ({ name, origin: "tybo" as const }));
              tools.inventory.skills = names.map(name => ({ name, origin: "engine" as const }));
              for (const key of ["mcp", "skills", "hints"] as const) {
                tools.gaps[key] = names.map(name => ({ name, reason: "not_in_engine", text: "im Motor nicht eingerichtet" }));
              }
            }
            return engines;
          },
          startedAt: () => restartedAt ?? base.startedAt(),
          version: () => (restartedAt ? "0.0.1-demo" : base.version()),
          restartRequested: async () => !restartedAt && base.restartNotes.length > 0,
          requestRestart: async (note: string) => {
            await base.requestRestart(note);
            setTimeout(() => { restartedAt = Date.now(); }, 1500);
          },
        };
        const d = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          {
            chat: createFakeChat({ delayMs: 300, stepMs: 100 }),
            telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }),
            settings,
            status,
            models: { list: async () => ({ claude: { models: [...CLAUDE_MODELS], custom: true }, openrouter: { models: openrouter }, ollama: { models: ["qwen3:8b", "llama4:1b"] }, opencode: { models: ["openrouter/anthropic/claude-opus-5.5"] } }) },
            log: () => {},
          }
        );
        try {
          const url = `${d.server.url}/`;
          await goto(url);
          await waitFor(`!!document.getElementById("open-settings")`);
          await goto(`${url}#/einstellungen/agenten`);
          await waitFor(`document.querySelectorAll(".settings-agent-head").length > 0`);

          // --- Modelle ---
          await click("#settings-tab-modelle");
          await waitFor(`!!document.getElementById("settings-g-aux-judge-provider")`);
          check(`${label}: Reiter Modelle über die Adresse, fünf Abschnitte (Motor seit Issue #673)`,
            (await js<string>(`location.hash`)) === "#/einstellungen/modelle" &&
              JSON.stringify(await js<string[]>(`[...document.querySelectorAll("#settings-panel h3")].map(h => h.textContent)`)) ===
                JSON.stringify(["Motor", "Standard für alle Agenten", "Nebenmodelle", "Fallback", "Offene Fäden"]));
          check(`${label}: Standard nennt Wert und Quelle`,
            (await js<string>(`document.getElementById("settings-g-aux-judge-provider").options[0].textContent`)) === "Standard (claude:claude-opus-5, Voreinstellung)" &&
              (await js<string>(`document.getElementById("settings-g-fallback-openrouterModel").options[0].textContent`)) === "Standard (minimax/minimax-m2.7, Voreinstellung)");
          check(`${label}: Felder im Stil des Passwortfelds, kein seitliches Scrollen`,
            (await js<boolean>(`(() => { const s = getComputedStyle(document.getElementById("settings-g-fallback-openrouterModel"));
              return s.borderTopWidth === "1px" && s.borderTopLeftRadius === "12px" && s.fontSize === "16px"; })()`)) && (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-modelle-${size.width}${suffix}`);

          // Aux: Ollama mit qwen3:8b
          await setSelect("settings-g-aux-judge-provider", "ollama");
          await waitFor(`!!document.getElementById("settings-g-aux-judge")`);
          await setSelect("settings-g-aux-judge", "qwen3:8b");
          await click('[data-focus-key="save:section-aux"]');
          await waitFor(`${statusText}.includes("Gespeichert.")`);
          check(`${label}: Aux gespeichert als ollama:qwen3:8b`, settings.data().aux?.judge === "ollama:qwen3:8b", JSON.stringify(settings.data().aux));

          // Fallback: Filter ohne Serveranfrage, dann Kimi K3 und „Nur offline: Aus"
          // Ein engine-Ereignis nach dem Speichern darf parallel Gesprächs- und Motordaten nachladen.
          const modelRequests = `performance.getEntriesByType("resource").filter(e => new URL(e.name).pathname === "/api/models").length`;
          const requestsBefore = await js<number>(modelRequests);
          await typeInto('[data-focus-key="g-filter:fallback.openrouterModel"]', "kimi");
          check(`${label}: Filter zeigt nur Kimi K3, ohne Anfrage an den Server`,
            JSON.stringify(await js<string[]>(`[...document.getElementById("settings-g-fallback-openrouterModel").options].map(o => o.value)`)) ===
              JSON.stringify([" standard", "moonshotai/kimi-k3", " eigenes"]) &&
              (await js<number>(modelRequests)) === requestsBefore);
          await setSelect("settings-g-fallback-openrouterModel", "moonshotai/kimi-k3");
          await click('[data-focus-key="g-offline:false"]');
          await shoot(`einstellungen-modelle-fallback-${size.width}${suffix}`);
          await click('[data-focus-key="save:section-fallback"]');
          await waitFor(`document.querySelector('[data-focus-key="save:section-fallback"]').disabled`);
          check(`${label}: Fallback gespeichert (reine ID, offlineOnly false)`,
            JSON.stringify(settings.data().fallback) === JSON.stringify({ openrouterModel: "moonshotai/kimi-k3", offlineOnly: false }), JSON.stringify(settings.data().fallback));

          // Neuladen bleibt im Reiter und zeigt den gespeicherten Stand
          await cdp("Page.reload", {});
          await Bun.sleep(100);
          await waitFor(`document.readyState === "complete" && !!document.getElementById("settings-g-aux-judge")`);
          check(`${label}: Neuladen unter #/einstellungen/modelle zeigt den gespeicherten Stand`,
            (await js<string>(`document.getElementById("settings-g-aux-judge").value`)) === "qwen3:8b" &&
              (await js<string>(`document.querySelector('[data-focus-key="g-offline:false"]').getAttribute("aria-checked")`)) === "true");

          // --- Sprechen (Issue #248): Demo-Anbieter mit verfügbaren und nicht verfügbaren je Stufe ---
          await click("#settings-tab-sprechen");
          await waitFor(`!!document.getElementById("settings-g-speech-stt") && !!document.querySelector(".settings-voice-status")`);
          const optionState = (id: string) =>
            js<string[]>(`[...document.getElementById(${JSON.stringify(id)}).options].map(o => o.value + (o.disabled ? ":aus" : ""))`);
          check(`${label}: Reiter Sprechen über die Adresse, Abschnitte Hören und Sprechen und Sprechmodus auf diesem Gerät (Issue #250)`,
            (await js<string>(`location.hash`)) === "#/einstellungen/sprechen" &&
              JSON.stringify(await js<string[]>(`[...document.querySelectorAll("#settings-panel h3")].map(h => h.textContent)`)) === JSON.stringify(["Hören und Sprechen", "Sprechmodus auf diesem Gerät", "Eigene Stimme"]),
            await js<string>(`[...document.querySelectorAll("#settings-panel h3")].map(h => h.textContent).join(" | ")`));
          check(`${label}: nicht verfügbare Anbieter ausgegraut, mit Grund im Namen`,
            JSON.stringify(await optionState("settings-g-speech-stt")) === JSON.stringify([" standard", "auto", "parakeet:aus", "whisper-cpp", "elevenlabs:aus", "gemini"]) &&
              JSON.stringify(await optionState("settings-g-speech-tts")) === JSON.stringify([" standard", "auto", "browser", "qwen3-mlx:aus", "elevenlabs:aus", "gemini", "pocket", "piper:aus", "clone:aus"]) &&
              (await js<string>(`document.querySelector('#settings-g-speech-stt option[value="parakeet"]').textContent`)) === "Parakeet (nicht verfügbar: nicht installiert)",
            JSON.stringify(await optionState("settings-g-speech-stt")));
          check(`${label}: Status des Sprechmodus und Standard mit Quelle`,
            (await js<string>(`document.querySelector(".settings-voice-status").textContent`)) === "Sprechmodus bereit: Hören mit whisper.cpp, Sprechen mit Browser-Stimme." &&
              (await js<string>(`document.getElementById("settings-g-speech-stt").options[0].textContent`)) === "Standard (Automatisch, Voreinstellung)" &&
              (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-sprechen-${size.width}${suffix}`);

          // Modell für gesprochene Fragen (Issue #249): Feld mit der Modell-Liste, Standard „Wie das Gespräch"
          check(`${label}: Modell für gesprochene Fragen mit Liste und Effort`,
            (await js<string>(`document.getElementById("settings-g-speech-model").options[0].textContent`)) === "Wie das Gespräch" &&
              (await js<boolean>(`[...document.getElementById("settings-g-speech-model").options].some(o => o.value === ${JSON.stringify(CLAUDE_MODELS[0])})`)) &&
              (await js<string>(`document.getElementById("settings-g-speech-effort").options[0].textContent`)) === "Standard (medium)" &&
              (await noHorizontalScroll(size.width)));

          await setSelect("settings-g-speech-stt", "gemini");
          await setSelect("settings-g-speech-tts", "browser");
          await setSelect("settings-g-speech-language", "de");
          const speechHints = `[...document.querySelectorAll("#settings-panel .settings-section .actions-hint")].map(e => e.textContent).join(" | ")`;
          check(`${label}: Hinweise Cloud und Browser-Stimme`,
            (await js<string>(speechHints)).includes("Cloud: Audio geht an Gemini.") &&
              (await js<string>(speechHints)).includes("Telegram-Sprachantworten nutzen weiter die Server-Stimmen."),
            await js<string>(speechHints));
          await shoot(`einstellungen-sprechen-auswahl-${size.width}${suffix}`);
          // Lokale Stimme (Issue #252): eingerichtet, mit Namensnennung Kyutai; Piper ausgegraut mit Grund
          await setSelect("settings-g-speech-tts", "pocket");
          check(`${label}: lokale Stimme wählbar, lokal und mit Namensnennung`,
            (await js<string>(speechHints)).includes("Lokal.") &&
              (await js<string>(speechHints)).includes("Kyutai Pocket TTS") &&
              (await js<string>(speechHints)).includes("CC-BY-4.0") &&
              (await js<string>(`document.querySelector('#settings-g-speech-tts option[value="piper"]').textContent`)).startsWith("Piper (Thorsten) (nicht verfügbar:") &&
              (await noHorizontalScroll(size.width)),
            await js<string>(speechHints));
          await shoot(`einstellungen-sprechen-lokale-stimme-${size.width}${suffix}`);
          await setSelect("settings-g-speech-tts", "browser");
          await click('[data-focus-key="save:section-speech"]');
          await waitFor(`${statusText}.includes("Gespeichert.")`);
          check(`${label}: Hören und Sprechen gespeichert`,
            Bun.deepEquals(settings.data().speech, { stt: "gemini", tts: "browser", language: "de" }), JSON.stringify(settings.data().speech));
          check(`${label}: Status nach dem Speichern neu`,
            await waitFor(`document.querySelector(".settings-voice-status").textContent === "Sprechmodus bereit: Hören mit Gemini, Sprechen mit Browser-Stimme."`));

          await cdp("Page.reload", {});
          await Bun.sleep(100);
          await waitFor(`document.readyState === "complete" && !!document.getElementById("settings-g-speech-stt")`);
          check(`${label}: Neuladen unter #/einstellungen/sprechen zeigt den gespeicherten Stand`,
            (await js<string>(`document.getElementById("settings-g-speech-stt").value`)) === "gemini" &&
              (await js<string>(`document.getElementById("settings-g-speech-tts").value`)) === "browser" &&
              (await js<string>(`document.getElementById("settings-g-speech-language").value`)) === "de");

          // Gespeichert und neu gezeichnet: während des Speicherns sind die Felder gesperrt, danach ist
          // der Knopf ohne Änderung aus. Der Knopf allein reicht nicht, er ist auch während des Speicherns aus
          const speechSaved = () =>
            waitFor(`!document.getElementById("settings-g-speech-stt").disabled && document.querySelector('[data-focus-key="save:section-speech"]').disabled`);
          // „Standard" entfernt den eigenen Wert (PATCH mit null)
          await setSelect("settings-g-speech-stt", " standard");
          await click('[data-focus-key="save:section-speech"]');
          await speechSaved();
          check(`${label}: Zurücksetzen auf Standard entfernt speech.stt`,
            Bun.deepEquals(settings.data().speech, { tts: "browser", language: "de" }) &&
              (await js<string>(`document.getElementById("settings-g-speech-stt").value`)) === " standard",
            JSON.stringify(settings.data().speech));

          // Modell für gesprochene Fragen speichern und wieder entfernen (Issue #249)
          await setSelect("settings-g-speech-model", CLAUDE_MODELS[CLAUDE_MODELS.length - 1]);
          await setSelect("settings-g-speech-effort", "low");
          await click('[data-focus-key="save:section-speech"]');
          await speechSaved();
          check(`${label}: Modell und Effort für gesprochene Fragen gespeichert`,
            Bun.deepEquals(settings.data().speech, { tts: "browser", language: "de", model: CLAUDE_MODELS[CLAUDE_MODELS.length - 1], effort: "low" }),
            JSON.stringify(settings.data().speech));
          await setSelect("settings-g-speech-model", " standard");
          await setSelect("settings-g-speech-effort", " standard");
          await click('[data-focus-key="save:section-speech"]');
          await speechSaved();
          check(`${label}: „Wie das Gespräch" entfernt das Modell wieder`,
            Bun.deepEquals(settings.data().speech, { tts: "browser", language: "de" }), JSON.stringify(settings.data().speech));

          // --- Status ---
          await click("#settings-tab-status");
          await waitFor(`!!document.querySelector("#settings-panel .settings-facts")`);
          check(`${label}: Status mit Version, Supervisor und Schlüsseln nur als gesetzt/fehlt`,
            (await js<string>(`location.hash`)) === "#/einstellungen/status" &&
              (await js<boolean>(`[...document.querySelectorAll(".settings-keys:not(.settings-engines) li")].every(li => ["gesetzt", "fehlt"].includes(li.querySelector(".settings-key-state").textContent) && li.children.length === 2)`)) &&
              // Motoren (Issue #126) stehen in derselben Listenform, aber mit eigenem Zustand
              (await count(".settings-keys:not(.settings-engines) li")) > 10 && (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-status-${size.width}${suffix}`);
          // Werkzeuge (Issue #667): Demo-Werte, Tastatur, Aktualisieren und lange Namen.
          const engineSection = '[aria-labelledby="settings-g-title-engines"]';
          const codexDetails = '.settings-status-engines [data-engine="codex"] details';
          const codexSummary = codexDetails + ' > summary';
          const toolsFit = async () => (await noHorizontalScroll(size.width)) && await js<boolean>(`(() => {
            const section = document.querySelector(${JSON.stringify(engineSection)});
            return section.scrollWidth <= section.clientWidth && [...section.querySelectorAll("*")].every(e => {
              const r = e.getBoundingClientRect();
              return !r.width || (r.left >= 0 && r.right <= ${size.width});
            });
          })()`);
          const shootTools = async (name: string, open: boolean) => {
            if (!shots) return;
            // Die Höhe reicht für den ganzen Abschnitt, die geprüfte Breite bleibt gleich.
            const height = Math.max(size.height, await js<number>(`Math.ceil(document.querySelector(${JSON.stringify(engineSection)}).getBoundingClientRect().height) + 180`));
            try {
              await cdp("Emulation.setDeviceMetricsOverride", { ...size, height, deviceScaleFactor: 2 });
              await js(`document.querySelector(${JSON.stringify(engineSection)}).scrollIntoView({ block: "start" })`);
              check(`${label}: vollständiger Motoren-Abschnitt im Screenshot`, await js<boolean>(`(() => {
                const r = document.querySelector(${JSON.stringify(engineSection)}).getBoundingClientRect();
                return r.top >= 0 && r.bottom <= innerHeight && document.querySelector(${JSON.stringify(codexDetails)}).open === ${open};
              })()`));
              await shoot(name);
            } finally {
              await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
            }
          };
          await js(`document.querySelector(${JSON.stringify(engineSection)}).scrollIntoView({ block: "start" })`);
          check(`${label}: vier Motorzeilen mit Werkzeugen, Maßstab, Notizen-Lücken und Hinweis`, await js<boolean>(`(() => {
            const list = document.querySelector(".settings-status-engines");
            const text = engine => list.querySelector('[data-engine="' + engine + '"] .settings-engine-tools-summary').textContent;
            return list.children.length === 4 && list.querySelectorAll(".settings-engine-tools-label").length === 4 &&
              text("claude") === "2 MCP-Server, 1 Skill, Notizen · Maßstab" &&
              text("codex").includes("1 Hinweis") && text("opencode").includes("Fehlt: 1 MCP-Server, Notizen") &&
              text("api").includes("Fehlt: 1 MCP-Server, Notizen") &&
              [...list.querySelectorAll("details")].every(d => !d.open);
          })()`) && await toolsFit());
          check(`${label}: Werkzeugzeilen auch bei nicht bereitem Motor in Textfarbe, ohne Bewegung`, await js<boolean>(`(() => {
            const ink = getComputedStyle(document.querySelector(".settings-status-engines .settings-key-name")).color;
            return [...document.querySelectorAll(".settings-status-engines .settings-engine-tools-summary, .settings-status-engines details")].every(e => {
              const s = getComputedStyle(e); return s.color === ink && s.animationName === "none" && s.transitionDuration === "0s";
            });
          })()`));
          await shootTools(`einstellungen-status-werkzeuge-${size.width}${suffix}`, false);
          await js(`document.querySelector(${JSON.stringify(codexSummary)}).focus()`);
          await pressKey("Enter", "Enter", 13, "\r");
          check(`${label}: Einzelheiten per Enter geöffnet, Fokusring sichtbar`,
            await waitFor(`document.querySelector(${JSON.stringify(codexDetails)}).open`) &&
            await js<boolean>(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineWidth === "2px" && s.outlineStyle === "solid"; })()`));
          check(`${label}: Namen, Herkunft, Hinweis und feste Gründe genau aus der Antwort`, await js<boolean>(`(async () => {
            const tools = (await (await fetch("/api/status")).json()).engines.find(e => e.engine === "codex").tools;
            const details = document.querySelector(${JSON.stringify(codexDetails)});
            const names = [...details.querySelectorAll(".settings-engine-tool-name")].map(e => e.textContent);
            const texts = [...details.querySelectorAll(".settings-engine-tool-text")].map(e => e.textContent);
            return [...tools.inventory.mcp, ...tools.inventory.skills, ...tools.gaps.mcp, ...tools.gaps.hints, ...tools.gaps.skills].every(e => names.includes(e.name)) &&
              [...tools.gaps.mcp, ...tools.gaps.hints, ...tools.gaps.skills, ...tools.gaps.fixed].every(e => texts.includes(e.text)) &&
              texts.includes("von tybo") && texts.includes("Plugins von Claude Code: 2");
          })()`));
          check(`${label}: aufgeklappte Werkzeuge ohne seitliches Scrollen`, await js<boolean>(`document.querySelector(${JSON.stringify(codexDetails)}).open`) && await toolsFit());
          await shootTools(`einstellungen-status-werkzeuge-offen-${size.width}${suffix}`, true);
          await js(`document.querySelector(${JSON.stringify(codexSummary)}).focus()`);
          await pressKey(" ", "Space", 32, " ");
          check(`${label}: Einzelheiten per Leertaste geschlossen`, await waitFor(`!document.querySelector(${JSON.stringify(codexDetails)}).open`));
          await pressKey("Enter", "Enter", 13, "\r");
          await waitFor(`document.querySelector(${JSON.stringify(codexDetails)}).open`);
          await click('[data-focus-key="status-refresh"]');
          check(`${label}: nach Aktualisieren offen und Fokus auf Einzelheiten`, await waitFor(`!document.querySelector('[data-focus-key="status-refresh"]').disabled &&
            document.querySelector(${JSON.stringify(codexDetails)}).open && document.activeElement === document.querySelector(${JSON.stringify(codexSummary)})`));
          longToolNames = true;
          await click('[data-focus-key="status-refresh"]');
          check(`${label}: 100 Namen je Liste mit je 64 Zeichen ohne Leerzeichen bleiben innerhalb der Breite`,
            await waitFor(`document.querySelector(${JSON.stringify(codexDetails)}).querySelectorAll(".settings-engine-tool-name").length === 500`) &&
            await js<boolean>(`[...document.querySelector(${JSON.stringify(codexDetails)}).querySelectorAll(".settings-engine-tool-name")].every(e => e.textContent.length === 64)`) &&
            await toolsFit());
          longToolNames = false;
          await click('[data-focus-key="status-refresh"]');
          await waitFor(`!document.querySelector('[data-focus-key="status-refresh"]').disabled`);
          await click('[data-focus-key="status-restart"]');
          await waitFor(`!!document.querySelector('[data-focus-key="status-restart-no"]')`);
          check(`${label}: Rückfrage, Fokus auf Abbrechen, noch kein Neustart`,
            base.restartNotes.length === 0 && (await js<string>(`document.activeElement.dataset.focusKey`)) === "status-restart-no");
          await js(`document.querySelector('[data-focus-key="status-restart-no"]').scrollIntoView({ block: "center" })`);
          await shoot(`einstellungen-neustart-${size.width}${suffix}`);
          await click('[data-focus-key="status-restart-no"]');
          check(`${label}: Abbrechen fordert nichts an`, base.restartNotes.length === 0);
          await click('[data-focus-key="status-restart"]');
          await waitFor(`!!document.querySelector('[data-focus-key="status-restart-yes"]')`);
          await js(`(() => { const b = document.querySelector('[data-focus-key="status-restart-yes"]'); b.click(); b.click(); })()`);
          await waitFor(`${statusText}.includes("Neustart nach der laufenden Antwort")`);
          check(`${label}: genau eine Anforderung, Hinweis „Neustart nach der laufenden Antwort"`, base.restartNotes.length === 1);
          check(`${label}: die Seite erkennt den neuen Prozess von selbst`,
            await waitFor(`${statusText}.includes(${JSON.stringify(`${BRAND.name} ist neu gestartet`)})`, 12000), await js<string>(statusText));
          check(`${label}: danach frischer Stand`, (await js<string>(`document.querySelector(".settings-facts dd").textContent`)).startsWith("0.0.1-demo"));
          check(`${label}: Einzelheiten bleiben auch nach dem simulierten Neustart offen`, await js<boolean>(`document.querySelector(${JSON.stringify(codexDetails)}).open`));
        } finally {
          await d.stop();
        }
      }
    }
  } finally {
    await cdp("Emulation.setEmulatedMedia", { features: [] });
  }
}

/**
 * Status-Karte eines Ziels (Issue #76) je 1280 und 390 px, hell und (mit
 * --screenshots) dunkel: Topic „Strategie" der Demo mit laufendem Ziel.
 * Karte über der Eingabe, Pause wechselt zu Weiter und Stopp, Stopp entfernt
 * die Karte, am Handy 44 px Tippfläche, kein seitliches Scrollen.
 */
/**
 * Budget-Frage „Weiter?" neben der Ziel-Karte (Issue #118) je 1280 und 390 px,
 * hell und (mit --screenshots) dunkel: echte Goal-Engine, echtes
 * Rückfragen-Register, echter Ziel-Port (createBotGoals) und
 * createGoalChoices wie in src/bot.ts, Zustand in Temp-Dateien. Telegram ist
 * eine Attrappe: die Frage landet über receiveNotice (mit choiceId) im Topic
 * „Finanzen“ der Demo, Claude arbeitet nie. 1280 px: „Weiter (+5)“ in der
 * Karte; 390 px: „Weiter (+5)“ an der Frage im Verlauf. Danach steht die
 * Frage als „Erledigt: Weiter (+5) · im Browser“, die Karte arbeitet mit
 * Runde 10 von 15, das Budget ist genau einmal erhöht.
 */
async function goalBudgetChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const dir = await mkdtemp(join(tmpdir(), "tybo-goal-budget-"));
  configureGoalStore({ file: join(dir, "goals.json") });
  const topicId = 12;
  const key = `topic:${DEMO_GROUP_ID}:${topicId}`;
  const cardLabels = `[...document.querySelectorAll("#goal-card .goal-button")].map(b => b.textContent).join(",")`;
  const questionBox = `[...document.querySelectorAll(".choice")].at(-1)`;
  const questionLabels = `[...(${questionBox}?.querySelectorAll(".choice-button") ?? [])].map(b => b.textContent).join(",")`;
  const questionStatus = `(${questionBox}?.querySelector(".choice-status")?.textContent || "")`;
  const cardState = `(document.querySelector("#goal-card .goal-state")?.textContent || "")`;
  const cardMeta = `(document.querySelector("#goal-card .goal-meta")?.textContent || "")`;
  try {
    for (const scheme of schemes) {
      await emulateScheme(scheme as "light" | "dark");
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Budget-Frage ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        setChoicesFileForTests(join(dir, `choices-${size.width}-${scheme}.json`));
        let demo: Awaited<ReturnType<typeof startDemoServer>> | null = null;
        // Offener Arbeits-Turn nach „Weiter“; Abbruch und Aufräumen beenden ihn
        const turn: { release?: () => void } = {};
        const abort = () => {
          turn.release?.();
          return 0;
        };
        const goalChoices = createGoalChoices({
          getGoal,
          abort,
          sendChoice: async choice => ({ sent: !!demo?.receiveNotice(`topic-${topicId}`, "ziel", choice.text, undefined, choice.id) }),
          log: () => {},
        });
        const offDecided = onChoiceDecided("goal", goalChoices.handler);
        const offChange = onGoalChange(goalChoices.listener);
        initGoalEngine({
          callAgent: () => new Promise(resolve => (turn.release = () => resolve({ text: "", aborted: true }))),
          sendAsAgent: async () => {},
          sendStatus: createTelegramGoalStatus({ send: async () => {}, ask: goalChoices.ask, noButtonsHint: GOAL_NO_BUTTONS_HINT }),
          saveMessage: async () => true,
        });
        const goals = createBotGoals({
          userId: "4711",
          groupId: () => DEMO_GROUP_ID,
          agentForTopic: t => (t === topicId ? "finance" : undefined),
          get: getGoal,
          isRunning: isGoalLoopRunning,
          action: (k, action, goalId) => runGoalAction(k, action, { goalId, abort }),
          decideBudget: goalChoices.decideFromCard,
          onChange: onGoalChange,
          log: () => {},
        });
        const port = createChoicePort({
          register: { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange },
          userId: "4711",
          groupId: () => DEMO_GROUP_ID,
          log: () => {},
        });
        demo = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          {
            telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }),
            goals,
            choices: { ...port, decideInTelegram: (id, k) => decideChoice(id, k, "telegram") },
            log: () => {},
          }
        );
        try {
          // Ziel am Turn-Budget: die Schleife pausiert und stellt die Frage
          await setGoal({ sessionKey: key, chatId: DEMO_GROUP_ID, topicId, agentName: "finance", goal: "API-Kosten im September unter 30 Euro halten" });
          await updateGoal(key, { turnsUsed: 10, maxTurns: 10 });
          await startGoalWork(key);
          await goalChoices.settled();
          const url = `${demo.server.url}/`;
          await goto(url);
          await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-${topicId}")`);
          await goto(url);
          check(`${label}: Karte im Topic Finanzen, pausiert, Runde 10 von 10, Knöpfe Weiter (+5) und Stopp`,
            await waitFor(`document.getElementById("chat-title").textContent === "Finanzen" && !document.getElementById("goal-card").hidden && ${cardState} === "pausiert" && ${cardMeta} === "Runde 10 von 10 · Finance" && ${cardLabels} === "Weiter (+5),Stopp"`),
            await js<string>(`${cardState} + " | " + ${cardMeta} + " | " + ${cardLabels}`));
          check(`${label}: Budget-Frage im Verlauf mit Knöpfen Weiter (+5) und Beenden, Absender Ziel`,
            await waitFor(`${questionLabels} === "Weiter (+5),Beenden" && ${questionBox}.closest(".msg").textContent.includes("Turn-Budget erreicht (10/10)")`),
            await js<string>(questionLabels));
          check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          if (size.mobile) {
            const h = await js<number>(`Math.min(...[...${questionBox}.querySelectorAll(".choice-button"), ...document.querySelectorAll("#goal-card .goal-button")].map(b => b.getBoundingClientRect().height))`);
            check(`${label}: Knöpfe mit 44 px Tippfläche`, h >= 44, `${h} px`);
          }
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`ziel-budget-offen-${size.width}${suffix}`);

          if (size.mobile) await js(`${questionBox}.querySelector(".choice-button").click()`);
          else await js(`document.querySelector('#goal-card [data-action="more"]').click()`);
          const where = size.mobile ? "an der Frage" : "in der Karte";
          check(`${label}: Weiter ${where}: Frage „Erledigt: Weiter (+5) · im Browser“, Knöpfe weg`,
            await waitFor(`${questionStatus}.startsWith("Erledigt: Weiter (+5) · im Browser · ") && !${questionBox}.querySelector(".choice-button")`, 3000),
            await js<string>(questionStatus));
          check(`${label}: Karte arbeitet, Runde 10 von 15, Knöpfe Pause und Stopp`,
            await waitFor(`${cardState} === "arbeitet" && ${cardMeta} === "Runde 10 von 15 · Finance" && ${cardLabels} === "Pause,Stopp"`, 3000),
            await js<string>(`${cardState} + " | " + ${cardMeta} + " | " + ${cardLabels}`));
          const stored = await getGoal(key);
          check(`${label}: Budget genau einmal +5`, stored?.maxTurns === 15 && stored?.status === "active", `${stored?.maxTurns} ${stored?.status}`);
          check(`${label}: nach dem Klick kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`ziel-budget-weiter-${size.width}${suffix}`);
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
        } finally {
          await clearGoal(key);
          turn.release?.();
          for (let i = 0; i < 100 && isGoalLoopRunning(key); i++) await Bun.sleep(10);
          await goalChoices.settled();
          await demo.stop();
          offDecided();
          offChange();
          setChoicesFileForTests(null);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Topic-Zuordnung „Welcher Agent?" (Issue #119) je 1280 und 390 px, hell und
 * (mit --screenshots) dunkel: echtes Rückfragen-Register, echter
 * Agenten-Katalog und createTopicChoices wie in src/bot.ts; Katalog,
 * config/topics.json und Register als Kopien im Temp-Verzeichnis. Telegram
 * ist eine Attrappe: die Frage landet über receiveNotice (mit choiceId) im
 * neuen Topic „Neues Projekt" der Demo, die geschriebene Zuordnung meldet
 * changeTopic an die offenen Browser. Klick auf „Research Agent (Deep
 * Research)": Frage erledigt, Zuordnung genau einmal, Kopfzeilen-Chip
 * wechselt ohne Neuladen auf Research.
 */
async function topicMapChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const dir = await mkdtemp(join(tmpdir(), "tybo-topicmap-"));
  const topicId = 77;
  const box = `[...document.querySelectorAll(".choice")].at(-1)`;
  const labels = `[...(${box}?.querySelectorAll(".choice-button") ?? [])].map(b => b.textContent).join(",")`;
  const status = `(${box}?.querySelector(".choice-status")?.textContent || "")`;
  const chip = `document.getElementById("agent-name").textContent`;
  try {
    for (const scheme of schemes) {
      await emulateScheme(scheme as "light" | "dark");
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Topic-Zuordnung ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        const run = join(dir, `${size.width}-${scheme}`);
        const topicsFile = join(run, "topics.json");
        setChoicesFileForTests(join(run, "choices.json"));
        setAgentCatalogPaths({ file: join(run, "agents.json"), backupDir: join(run, "backups"), topicsFile });
        let demo: Awaited<ReturnType<typeof startDemoServer>> | null = null;
        const written: string[] = [];
        const topics = createTopicChoices({
          sendChoice: async choice => ({ sent: !!demo?.receiveNotice(`topic-${topicId}`, "topic", choice.text, undefined, choice.id) }),
          notify: async input => ({ sent: !!demo?.receiveNotice(`topic-${topicId}`, "topic", input.text ?? ""), recorded: true }),
          topicChanged: change => {
            void getMappedAgent(change.chatId, change.topicId, topicsFile).then(agent => demo?.changeTopic(change.topicId, { agent }));
          },
          topicsFile,
          log: () => {},
        });
        const offs = [
          onChoiceDecided("topicmap", topics.handler),
          onTopicMappingSet(topics.listener),
          onTopicMappingSet(change => written.push(change.agent)),
        ];
        const port = createChoicePort({
          register: { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange },
          userId: "4711",
          groupId: () => DEMO_GROUP_ID,
          log: () => {},
        });
        demo = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          {
            telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }),
            choices: { ...port, decideInTelegram: (id, k) => decideChoice(id, k, "telegram") },
            log: () => {},
          }
        );
        try {
          // Neues Topic ohne Zuordnung, eine Nachricht aus Telegram, dann die Frage wie in bot.ts
          demo.changeTopic(topicId, { title: "Neues Projekt", agent: "general" });
          demo.receiveTelegram(`topic-${topicId}`, "user", "Lass uns hier das Angebot für den Relaunch planen.");
          const asked = await topics.ask(DEMO_GROUP_ID, topicId);
          check(`${label}: Frage im Register und im Topic`, asked);
          const url = `${demo.server.url}/`;
          await goto(url);
          await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-${topicId}")`);
          await goto(url);
          const expected = listAgents().map(a => a.displayName).join(",");
          check(`${label}: Topic „Neues Projekt", Chip General, ein Knopf je Agent (${listAgents().length})`,
            await waitFor(`document.getElementById("chat-title").textContent === "Neues Projekt" && ${chip} === "General" && ${labels} === ${JSON.stringify(expected)} && ${box}.closest(".msg").textContent.includes(${JSON.stringify(TOPIC_MAP_TEXT.question(topicId).slice(0, 40))})`),
            await js<string>(`${chip} + " | " + ${labels}`));
          check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          if (size.mobile) {
            const h = await js<number>(`Math.min(...[...${box}.querySelectorAll(".choice-button")].map(b => b.getBoundingClientRect().height))`);
            check(`${label}: Knöpfe mit 44 px Tippfläche`, h >= 44, `${h} px`);
          }
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`topic-zuordnung-offen-${size.width}${suffix}`);

          const reloads = await js<number>(`performance.getEntriesByType("navigation").length`);
          await js(`${box}.querySelector('.choice-button[data-key="research"]').click()`);
          check(`${label}: Frage „Erledigt: Research Agent (Deep Research) · im Browser", Knöpfe weg`,
            await waitFor(`${status}.startsWith("Erledigt: Research Agent (Deep Research) · im Browser · ") && !${box}.querySelector(".choice-button")`, 3000),
            await js<string>(status));
          check(`${label}: Chip wechselt ohne Neuladen auf Research`,
            await waitFor(`${chip} === "Research" && document.getElementById("agent-name").getAttribute("data-agent") === "research"`, 3000) &&
              (await js<number>(`performance.getEntriesByType("navigation").length`)) === reloads,
            await js<string>(chip));
          const onDisk = await getMappedAgent(DEMO_GROUP_ID, topicId, topicsFile);
          check(`${label}: Zuordnung genau einmal geschrieben`, onDisk === "research" && written.join(",") === "research", `${onDisk} | ${written.join(",")}`);
          check(`${label}: nach dem Klick kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`topic-zuordnung-erledigt-${size.width}${suffix}`);
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
        } finally {
          await topics.settled();
          await demo.stop();
          for (const off of offs) off();
          setChoicesFileForTests(null);
          setAgentCatalogPaths();
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Reiter „Routinen" (Issue #284), je 1280 und 390 px, hell und (mit
 * --screenshots) dunkel: Liste mit langen Namen, eingeklappte Dauerdienste,
 * leere Liste und „nicht verfügbar". Verlauf per Klick (Issue #285): Läufe,
 * Ausgabe beim Fehler, leerer Verlauf und ein Ladefehler (watchdog). Daten
 * aus createDemoRoutines, nie launchctl oder pm2.
 */
async function routinesChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  for (const scheme of schemes) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Routinen ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      for (const variant of ["list", "empty", "unavailable"] as const) {
        const d = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), routines: createDemoRoutines(variant, { failRuns: ["ai.tybo.watchdog"] }), log: () => {} }
        );
        try {
          const url = `${d.server.url}/`;
          await goto(url);
          await waitFor(`!!document.getElementById("open-settings")`);
          await goto(`${url}#/einstellungen/routinen`);
          if (variant === "list") {
            await waitFor(`document.querySelectorAll(".settings-routines li").length >= 5`);
            check(`${label}: Reiter gewählt, fünf zeitgesteuerte Routinen, Dauerdienste eingeklappt`,
              (await js<string>(`document.querySelector(".settings-tab[aria-selected=true]").textContent`)) === "Routinen" &&
                (await js<number>(`document.querySelectorAll(".settings-routines li").length`)) === 5 &&
                (await js<string>(`document.querySelector('[data-focus-key="routines-daemons"]').getAttribute("aria-expanded")`)) === "false");
            check(`${label}: Zeitplan, Status, letzter und nächster Lauf in Worten, langer Name ohne seitliches Scrollen`,
              /werktags 07:00 · letzter Lauf: (heute|gestern) \d\d:\d\d, 4 s, Fehler \(Exit 1\) · nächster Lauf: (heute|morgen) \d\d:\d\d/.test(await js<string>(`document.querySelector('li[data-routine="ai.tybo.morning-briefing"]').textContent`)) &&
                (await js<string>(`document.querySelector('li[data-routine="ai.tybo.watchdog"]').textContent`)).includes("kein Verlauf (nicht eingebunden) · nächster Lauf: keiner (nicht geladen)") &&
                (await js<string>(`document.querySelector('li[data-routine="ai.tybo.smart-checkin"] .settings-routine-state').textContent`)) === "pausiert" &&
                (await js<boolean>(`[...document.querySelectorAll(".settings-routines li")].every(li => li.getBoundingClientRect().right <= innerWidth + 1)`)) &&
                (await noHorizontalScroll(size.width)));
            check(`${label}: keine absoluten Pfade in der Seite`, !(await js<boolean>(`document.documentElement.outerHTML.includes("/Users/")`)));
            await shoot(`einstellungen-routinen-${size.width}${suffix}`);
            // Verlauf (Issue #285): Klick auf eine Routine
            const open = (id: string) => js(`document.querySelector('[data-focus-key="routine-${id}"]').click()`);
            await open("ai.tybo.morning-briefing");
            await waitFor(`!!document.querySelector('li[data-routine="ai.tybo.morning-briefing"] .settings-routine-runs')`);
            check(`${label}: Klick öffnet den Verlauf, neuester Lauf mit Fehler zeigt Ausgabe und Log-Pfad mit ~`,
              (await js<string>(`document.querySelector('[data-focus-key="routine-ai.tybo.morning-briefing"]').getAttribute("aria-expanded")`)) === "true" &&
                (await js<number>(`document.querySelectorAll('li[data-routine="ai.tybo.morning-briefing"] .settings-routine-runs li').length`)) === 2 &&
                (await js<string>(`document.querySelector(".settings-routine-tail").textContent`)).includes("~/tybo/config/schedule.json") &&
                (await js<string>(`document.querySelector(".settings-routine-log").textContent`)) === "Log: ~/tybo/logs/morning-briefing.error.log" &&
                !(await js<boolean>(`document.documentElement.outerHTML.includes("/Users/")`)) &&
                (await noHorizontalScroll(size.width)));
            await js(`document.querySelector('li[data-routine="ai.tybo.morning-briefing"]').scrollIntoView({ block: "start" })`);
            await shoot(`einstellungen-routinen-verlauf-${size.width}${suffix}`);
            await open("ai.tybo.health-check");
            await waitFor(`!!document.querySelector('li[data-routine="ai.tybo.health-check"] .settings-routine-runs')`);
            check(`${label}: neuester Lauf ok: drei Läufe, keine Ausgabe, nur eine Routine offen`,
              (await js<number>(`document.querySelectorAll(".settings-routine-runs li").length`)) === 3 &&
                (await js<number>(`document.querySelectorAll(".settings-routine-tail").length`)) === 0 &&
                (await js<number>(`document.querySelectorAll(".settings-routine-history").length`)) === 1);
            // Knöpfe (Issue #288): aktiv „Jetzt testen" und „Pausieren", Pausieren erst nach dem Dialog
            const hc = `li[data-routine="ai.tybo.health-check"]`;
            const btn = (k: string) => `document.querySelector('${hc} [data-focus-key="routine-act-${k}"]')`;
            const hcState = () => js<string>(`document.querySelector('${hc} .settings-routine-state').textContent`);
            check(`${label}: aktive Routine zeigt „Jetzt testen" und „Pausieren"`,
              JSON.stringify(await js<string[]>(`[...document.querySelectorAll('${hc} .settings-routine-buttons button')].map(b => b.textContent)`)) === JSON.stringify(["▶️ Jetzt testen", "⏸️ Pausieren"]));
            await js(`${btn("pause")}.click()`);
            await waitFor(`!!${btn("no")}`);
            check(`${label}: Pausieren fragt nach, Fokus auf Abbrechen, Zustand unverändert`,
              (await js<string>(`document.querySelector('${hc} .settings-routine-confirm .actions-question').textContent`)) === "health-check wirklich pausieren?" &&
                (await js<string>(`${btn("yes")}.textContent`)) === "Ja, pausieren" &&
                (await js<string>(`document.activeElement.dataset.focusKey`)) === "routine-act-no" &&
                (await hcState()) === "aktiv" && (await noHorizontalScroll(size.width)));
            await js(`document.querySelector('${hc}').scrollIntoView({ block: "start" })`);
            await shoot(`einstellungen-routinen-pausieren-dialog-${size.width}${suffix}`);
            await js(`${btn("no")}.click()`);
            await waitFor(`!document.querySelector('${hc} .settings-routine-confirm')`);
            check(`${label}: Abbrechen ändert nichts`, (await hcState()) === "aktiv");
            await js(`${btn("pause")}.click()`);
            await waitFor(`!!${btn("yes")}`);
            await js(`${btn("yes")}.click()`);
            await waitFor(`document.querySelector('${hc} .settings-routine-state').textContent === "pausiert"`);
            check(`${label}: nach „Ja, pausieren" der neu gelesene Zustand und nur noch „Fortsetzen"`,
              (await js<string>(`document.querySelector('${hc} .settings-routine-history > .settings-status').textContent`)) === "⏸️ health-check ist pausiert. Nächster Lauf: keiner, bis du fortsetzt." &&
                (await js<string>(`document.querySelector('${hc}').textContent`)).includes("nächster Lauf: keiner (pausiert)") &&
                JSON.stringify(await js<string[]>(`[...document.querySelectorAll('${hc} .settings-routine-buttons button')].map(b => b.textContent)`)) === JSON.stringify(["▶️ Fortsetzen"]) &&
                (await noHorizontalScroll(size.width)));
            await shoot(`einstellungen-routinen-pausiert-${size.width}${suffix}`);
            await js(`${btn("resume")}.click()`);
            await waitFor(`!!${btn("yes")}`);
            check(`${label}: Fortsetzen fragt ebenfalls nach`, (await js<string>(`${btn("yes")}.textContent`)) === "Ja, fortsetzen");
            await js(`${btn("yes")}.click()`);
            await waitFor(`document.querySelector('${hc} .settings-routine-state').textContent === "aktiv"`);
            await js(`${btn("run")}.click()`);
            await waitFor(`(document.querySelector('${hc} .settings-routine-history > .settings-status') || {}).textContent?.includes("gestartet")`);
            check(`${label}: „Jetzt testen" ohne Rückfrage, Meldung „gestartet"`, (await hcState()) === "aktiv" && !(await js<boolean>(`!!document.querySelector('${hc} .settings-routine-confirm')`)));
            await open("ai.tybo.smart-checkin");
            await waitFor(`!!document.querySelector(".settings-routine-runs-empty")`);
            check(`${label}: leerer Verlauf als ruhiger Satz`,
              (await js<string>(`document.querySelector(".settings-routine-runs-empty").textContent`)) === "Noch kein Lauf festgehalten." &&
                JSON.stringify(await js<string[]>(`[...document.querySelectorAll('li[data-routine="ai.tybo.smart-checkin"] .settings-routine-buttons button')].map(b => b.textContent)`)) === JSON.stringify(["▶️ Fortsetzen"]));
            await open("ai.tybo.watchdog");
            await waitFor(`!!document.querySelector('li[data-routine="ai.tybo.watchdog"] .actions-error')`);
            check(`${label}: Ladefehler des Verlaufs als Meldung an der Routine`,
              (await js<string>(`document.querySelector('li[data-routine="ai.tybo.watchdog"] .actions-error').textContent`)) === "Verlauf konnte nicht gelesen werden." &&
                (await noHorizontalScroll(size.width)));
            await shoot(`einstellungen-routinen-verlauf-fehler-${size.width}${suffix}`);
            await open("ai.tybo.watchdog");
            await waitFor(`document.querySelectorAll(".settings-routine-history").length === 0`);
            await js(`document.querySelector('[data-focus-key="routines-daemons"]').click()`);
            await waitFor(`document.querySelectorAll(".settings-routines li").length === 7`);
            check(`${label}: Dauerdienste aufgeklappt (läuft, läuft nicht)`,
              (await js<string>(`document.querySelector('li[data-routine="ai.tybo.telegram-relay"] .settings-routine-state').textContent`)) === "läuft" &&
                (await js<string>(`document.querySelector('li[data-routine="ai.tybo.cloudflare-tunnel"] .settings-routine-state').textContent`)) === "läuft nicht" &&
                (await js<number>(`document.querySelectorAll('#settings-routines-daemons [data-focus-key^="routine-act-"]').length`)) === 0 &&
                (await noHorizontalScroll(size.width)));
            await js(`document.getElementById("settings-routines-daemons").scrollIntoView({ block: "center" })`);
            await shoot(`einstellungen-routinen-dauerdienste-${size.width}${suffix}`);
          } else {
            const text = variant === "empty" ? "Keine Routinen gefunden." : "Routinen: auf diesem System nicht verfügbar (weder launchd noch systemd noch PM2).";
            await waitFor(`[...document.querySelectorAll("#settings-panel .settings-empty")].some(p => p.textContent === ${JSON.stringify(text)})`);
            check(`${label}: ${variant === "empty" ? "leer" : "nicht verfügbar"} als ruhiger Hinweis`,
              (await js<number>(`document.querySelectorAll("#settings-panel .actions-error").length`)) === 0 && (await noHorizontalScroll(size.width)));
            await shoot(`einstellungen-routinen-${variant === "empty" ? "leer" : "nicht-verfuegbar"}-${size.width}${suffix}`);
          }
        } finally {
          await d.stop();
        }
      }
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

/**
 * Reiter „Erinnerungen" (Issue #323), je 1280 und 390 px, hell und (mit
 * --screenshots) dunkel, gegen createDemoReminders (nur im Speicher): Liste
 * mit Ort, Wiederholung und Zustand, eine laufende ohne Absage, Rückfrage
 * vor dem Absagen (Abbrechen ändert nichts), nach „Ja, absagen" die
 * Bestätigung und die kürzere Liste, Leerzustand.
 */
async function remindersChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const initial = [
    { text: "Paket bei der Post abholen", inHours: -1, place: "Direktchat" },
    { text: "Wird gerade verschickt", inHours: -0.5, place: "Direktchat", status: "running" as const },
    { text: "Zahnarzt anrufen und den Termin am Donnerstag auf die nächste Woche verschieben, wenn möglich vormittags", inHours: 3, place: "Topic Gesundheit" },
    { text: "Tabletten nehmen", inHours: 20, recurrenceText: "täglich 08:00", place: "Topic Gesundheit" },
  ];
  for (const scheme of schemes) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Erinnerungen ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      for (const variant of ["list", "empty"] as const) {
        const reminders = createDemoReminders({ initial: variant === "list" ? initial : [] });
        const d = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), reminders, log: () => {} }
        );
        try {
          const url = `${d.server.url}/`;
          await goto(url);
          await waitFor(`!!document.getElementById("open-settings")`);
          await goto(`${url}#/einstellungen/erinnerungen`);
          if (variant === "empty") {
            await waitFor(`!!document.querySelector(".settings-reminders-empty")`);
            check(`${label}: leer als ruhiger Hinweis, kein Fehler`,
              (await js<string>(`document.querySelector(".settings-reminders-empty").textContent`)) === "Keine offenen Erinnerungen." &&
                (await js<number>(`document.querySelectorAll("#settings-panel .actions-error").length`)) === 0 &&
                (await noHorizontalScroll(size.width)));
            await shoot(`einstellungen-erinnerungen-leer-${size.width}${suffix}`);
            continue;
          }
          await waitFor(`document.querySelectorAll(".settings-reminders li").length === 4`);
          const row = (n: number) => `document.querySelectorAll(".settings-reminders li")[${n}]`;
          check(`${label}: Reiter gewählt, vier Erinnerungen nach Fälligkeit, Ort, Wiederholung, Zustand`,
            (await js<string>(`document.querySelector(".settings-tab[aria-selected=true]").textContent`)) === "Erinnerungen" &&
              (await js<string>(`${row(0)}.textContent`)).includes("Paket bei der Post abholen") &&
              (await js<string>(`${row(0)}.textContent`)).includes("Direktchat · überfällig · Kennung d3e00001") &&
              (await js<string>(`${row(1)}.textContent`)).includes("wird gerade zugestellt") &&
              (await js<string>(`${row(3)}.textContent`)).includes("Topic Gesundheit · täglich 08:00"));
          check(`${label}: laufende ohne Absage, die übrigen mit „Absagen", langer Text ohne seitliches Scrollen`,
            (await js<boolean>(`${row(1)}.querySelector("button").disabled`)) &&
              (await js<boolean>(`![0, 2, 3].some(i => document.querySelectorAll(".settings-reminders li")[i].querySelector("button").disabled)`)) &&
              (await js<boolean>(`[...document.querySelectorAll(".settings-reminders li")].every(li => li.getBoundingClientRect().right <= innerWidth + 1)`)) &&
              (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-erinnerungen-${size.width}${suffix}`);
          // Absagen der Serie: erst die Rückfrage
          const series = "d3e00004-0000-4000-8000-000000000000";
          await js(`document.querySelector('[data-focus-key="reminder-${series}"]').click()`);
          await waitFor(`!!document.querySelector('[data-focus-key="reminder-cancel-no"]')`);
          check(`${label}: Absagen fragt nach (Serie mit Hinweis), Fokus auf Abbrechen, nichts abgesagt`,
            (await js<string>(`document.querySelector(".settings-reminder-confirm .actions-question").textContent`)) === "„Tabletten nehmen“ wirklich absagen?" &&
              (await js<string>(`document.querySelector(".settings-reminder-confirm .actions-hint").textContent`)) === "Die ganze Serie endet, es kommen keine weiteren Termine." &&
              (await js<string>(`document.activeElement.dataset.focusKey`)) === "reminder-cancel-no" &&
              reminders.cancelled() === 0 && (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-erinnerungen-absagen-dialog-${size.width}${suffix}`);
          await js(`document.querySelector('[data-focus-key="reminder-cancel-no"]').click()`);
          await waitFor(`!document.querySelector(".settings-reminder-confirm")`);
          check(`${label}: Abbrechen ändert nichts`, reminders.cancelled() === 0 && (await js<number>(`document.querySelectorAll(".settings-reminders li").length`)) === 4);
          await js(`document.querySelector('[data-focus-key="reminder-${series}"]').click()`);
          await waitFor(`!!document.querySelector('[data-focus-key="reminder-cancel-yes"]')`);
          await js(`document.querySelector('[data-focus-key="reminder-cancel-yes"]').click()`);
          await waitFor(`document.querySelectorAll(".settings-reminders li").length === 3`);
          check(`${label}: nach „Ja, absagen" Bestätigung, Liste neu gelesen ohne die Serie`,
            (await js<string>(`document.querySelector(".settings-reminders-message").textContent`)) === "Serie abgesagt: Tabletten nehmen (täglich 08:00). Es kommen keine weiteren Termine." &&
              (await js<string>(`document.querySelector(".settings-reminders-message").getAttribute("role")`)) === "status" &&
              !(await js<string>(`document.querySelector(".settings-reminders").textContent`)).includes("Tabletten") &&
              reminders.cancelled() === 1 && (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-erinnerungen-abgesagt-${size.width}${suffix}`);
        } finally {
          await d.stop();
        }
      }
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

/**
 * Offene Fäden (Issue #293), je 1280 und 390 px, hell und (mit
 * --screenshots) dunkel, gegen createDemoThreads (Fäden nur im Speicher):
 * Eintrag mit Anzahl in der Seitenleiste, Ansicht #/faeden mit Kontext und
 * langem Text ohne seitliches Scrollen, „Zum Gespräch" springt ins Topic,
 * Direktaufruf und Zurück, „Erledigt" schließt genau einmal, „Auch
 * geschlossene zeigen", leere Liste, Einstellungen (Nebenmodell und
 * Abschnitt) mit aus → Eintrag weg und an → wieder da, ohne Neuladen. Bei
 * 1280 px hell zusätzlich die verzögerte Erkennung: ein Faden, der erst
 * Sekunden nach der Antwort entsteht, erscheint in der Anzahl.
 */
async function threadsChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const countText = () => js<string>(`(() => { const c = document.getElementById("threads-count"); return c && !c.hidden ? c.textContent : ""; })()`);
  const items = () => js<number>(`document.querySelectorAll("#threads-body > .thread-list > .thread-item").length`);
  const item = (nr: number) => `[...document.querySelectorAll("#threads-body .thread-item")].find(li => li.querySelector(".thread-nr").textContent === "${nr}.")`;
  const LONG = "Langer Faden mit einem sehr langen Wort Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichenherstellungsbetriebsleitung";
  for (const scheme of schemes) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Fäden ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const settings = createDemoSettings();
      const threads = createDemoThreads({ settings });
      threads.add({ conversation: { type: "general", id: "topic-1", place: "General" }, topic: LONG, context: `Kontext: ${LONG}`, question: `${LONG}?`, ageHours: 0.2 });
      const d = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), settings, threads, log: () => {} }
      );
      try {
        const url = `${d.server.url}/`;
        await goto(url);
        await waitFor(`!!document.getElementById("open-threads") && !document.getElementById("open-threads").hidden`);
        if (size.mobile) await openDrawer();
        check(`${label}: Eintrag „Offene Fäden" mit Anzahl 4 in der Seitenleiste`,
          (await js<boolean>(shown("open-threads"))) && (await countText()) === "4" &&
            (await js<string>(`document.getElementById("open-threads").textContent.replace(/\\s+/g, " ").trim()`)) === "Offene Fäden 4");
        await shoot(`faeden-seitenleiste-${size.width}${suffix}`);
        await js(`document.getElementById("open-threads").click()`);
        await waitFor(`document.getElementById("main").dataset.view === "threads" && document.querySelectorAll("#threads-body .thread-item").length === 4`);
        check(`${label}: Klick öffnet #/faeden mit vier Fäden, neueste oben, Fokus auf dem Titel`,
          (await js<string>(`location.hash`)) === "#/faeden" && (await items()) === 4 &&
            (await js<string>(`document.querySelector("#threads-body .thread-item .thread-nr").textContent`)) === "4." &&
            (await js<string>(`document.activeElement.id`)) === "threads-title" &&
            (await js<string>(`document.getElementById("open-threads").getAttribute("aria-current")`)) === "page");
        check(`${label}: Thema, Kontext, Frage, Ort, Alter, Frist und Erinnerung`,
          (await js<string>(`${item(2)}.querySelector(".thread-topic").textContent`)) === "2. Vertrag mit dem Stromanbieter" &&
            (await js<string>(`${item(2)}.querySelector(".thread-context").textContent`)).startsWith("Das Angebot läuft aus") &&
            (await js<string>(`${item(2)}.querySelector(".thread-question").textContent`)).startsWith("Frage: Nehmen wir Variante A") &&
            /^Finanzen · seit 3 Tagen · Frist 02\.11\.2026 · zweite Erinnerung am \d\d\.\d\d\.\d{4}$/.test(await js<string>(`${item(2)}.querySelector(".thread-meta").textContent`)) &&
            /^Direktchat · seit 1 Tag · Erinnerung am/.test(await js<string>(`${item(3)}.querySelector(".thread-meta").textContent`)) &&
            JSON.stringify(await js<string[]>(`[...${item(1)}.querySelectorAll(".thread-actions button")].map(b => b.textContent)`)) === JSON.stringify(["Zum Gespräch", "Erledigt", "Nicht mehr wichtig"]));
        check(`${label}: langer Text ohne seitliches Scrollen`,
          (await noHorizontalScroll(size.width)) &&
            (await js<boolean>(`[...document.querySelectorAll("#threads-body .thread-item")].every(li => li.getBoundingClientRect().right <= innerWidth + 1 && li.scrollWidth <= li.clientWidth + 1)`)));
        await shoot(`faeden-${size.width}${suffix}`);

        // Zum Gespräch: Ansicht zu, Topic „Strategie" offen
        await js(`${item(1)}.querySelector('[data-thread-action="open"]').click()`);
        await waitFor(`document.getElementById("main").dataset.view === "chat" && document.getElementById("chat-title").textContent === "Strategie"`);
        check(`${label}: „Zum Gespräch" springt ins Topic Strategie, Adresse leer, Ansicht zu`,
          (await js<string>(`document.getElementById("chat-title").textContent`)) === "Strategie" && (await js<string>(`location.hash`)) === "" &&
            (await js<boolean>(`document.getElementById("threads-view").hidden`)));
        // Direktaufruf über die Adresse und Zurück-Pfeil
        await js(`location.hash = "#/faeden"`);
        await waitFor(`document.getElementById("main").dataset.view === "threads"`);
        await js(`document.getElementById("threads-back").click()`);
        await waitFor(`document.getElementById("main").dataset.view === "chat"`);
        check(`${label}: Direktaufruf #/faeden öffnet die Ansicht, Zurück-Pfeil führt zum Chat und leert die Adresse`,
          (await js<string>(`location.hash`)) === "" && (await js<boolean>(`document.getElementById("threads-view").hidden`)));
        // Neuladen mit #/faeden
        await goto(`${url}#/faeden`);
        await waitFor(`document.getElementById("main").dataset.view === "threads" && document.querySelectorAll("#threads-body .thread-item").length === 4`);
        check(`${label}: Neuladen mit #/faeden landet in der Ansicht`, (await items()) === 4);

        // Erledigt
        await js(`${item(2)}.querySelector('[data-thread-action="done"]').click()`);
        await waitFor(`document.querySelectorAll("#threads-body .thread-item").length === 3`);
        check(`${label}: „Erledigt" schließt genau einmal, Faden weg, Anzahl 3, Meldung`,
          threads.closed() === 1 && (await countText()) === "3" &&
            (await js<string>(`document.getElementById("threads-status").textContent`)) === "Faden 2 geschlossen." &&
            !(await js<boolean>(`!!${item(2)}`)));
        await js(`document.getElementById("threads-show-closed").click()`);
        await waitFor(`!!document.querySelector("#threads-body .thread-closed .thread-item")`);
        check(`${label}: „Auch geschlossene zeigen": geschlossener Faden mit Grund, ohne Schließen-Knöpfe`,
          (await js<string>(`document.getElementById("threads-show-closed").getAttribute("aria-pressed")`)) === "true" &&
            /^Finanzen · geschlossen am \d\d\.\d\d\.\d{4} · erledigt$/.test(await js<string>(`document.querySelector("#threads-body .thread-closed .thread-meta").textContent`)) &&
            JSON.stringify(await js<string[]>(`[...document.querySelectorAll("#threads-body .thread-closed .thread-actions button")].map(b => b.textContent)`)) === JSON.stringify(["Zum Gespräch"]) &&
            (await noHorizontalScroll(size.width)));
        await js(`document.querySelector("#threads-body .thread-closed").scrollIntoView({ block: "start" })`);
        await shoot(`faeden-geschlossen-${size.width}${suffix}`);
        await js(`document.getElementById("threads-show-closed").click()`);

        // Alle schließen: leere Liste
        for (const nr of [4, 3, 1]) {
          await js(`${item(nr)}.querySelector('[data-thread-action="drop"]').click()`);
          await waitFor(`!${item(nr)}`);
        }
        check(`${label}: leer „Keine offenen Fäden.", keine Anzahl, Eintrag bleibt`,
          (await js<string>(`document.querySelector("#threads-body .settings-empty").textContent`)) === "Keine offenen Fäden." &&
            (await countText()) === "" && threads.closed() === 4);
        await shoot(`faeden-leer-${size.width}${suffix}`);

        // Einstellungen: Nebenmodell und Abschnitt; aus → Eintrag weg, an → wieder da
        await js(`location.hash = "#/einstellungen/modelle"`);
        await waitFor(`!!document.querySelector('[data-focus-key="g-threads-enabled:false"]')`);
        check(`${label}: Nebenmodell „Offene Fäden" mit Erklärung und Abschnitt „Offene Fäden"`,
          (await js<string>(`document.getElementById("settings-g-aux-threads-title").textContent`)) === "Offene Fäden" &&
            (await js<string>(`document.getElementById("settings-g-aux-threads-title").nextElementSibling.textContent`)) === "Erkennt Fragen am Ende einer Antwort und prüft, ob sie beantwortet sind." &&
            (await js<string>(`document.getElementById("settings-g-title-threads").textContent`)) === "Offene Fäden");
        await js(`document.querySelector('[data-focus-key="g-threads-enabled:false"]').click()`);
        await js(`(() => { const s = document.getElementById("settings-g-threads-days"); s.value = "5"; s.dispatchEvent(new Event("change")); })()`);
        await js(`(() => { const s = document.getElementById("settings-g-threads-quiet"); s.value = "own"; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`!!document.getElementById("settings-g-threads-quiet-from")`);
        check(`${label}: eigene Ruhezeit beginnt mit 21:00 bis 08:00`,
          (await js<string>(`document.getElementById("settings-g-threads-quiet-from").value`)) === "21" && (await js<string>(`document.getElementById("settings-g-threads-quiet-to").value`)) === "8");
        await js(`(() => { const s = document.getElementById("settings-g-threads-quiet-to"); s.value = "21"; s.dispatchEvent(new Event("change")); })()`);
        await js(`document.querySelector('[data-focus-key="save:section-threads"]').click()`);
        await waitFor(`[...document.querySelectorAll("#settings-panel .actions-error")].some(p => p.textContent.includes("verschieden"))`);
        check(`${label}: gleiche Stunde für Beginn und Ende wird nicht gespeichert`, settings.data().threads === undefined);
        await js(`(() => { const s = document.getElementById("settings-g-threads-quiet-to"); s.value = "7"; s.dispatchEvent(new Event("change")); })()`);
        await js(`document.getElementById("settings-g-title-threads").scrollIntoView({ block: "start" })`);
        await shoot(`einstellungen-faeden-${size.width}${suffix}`);
        await js(`document.querySelector('[data-focus-key="save:section-threads"]').click()`);
        await waitFor(`!!document.getElementById("open-threads").hidden`);
        check(`${label}: „Aus" gespeichert: in der Datei, Eintrag in der Seitenleiste weg, ohne Neuladen`,
          JSON.stringify(settings.data().threads) === JSON.stringify({ enabled: false, remindDays: 5, quietHours: { from: 21, to: 7 } }) &&
            (await js<boolean>(`document.getElementById("open-threads").hidden`)) && (await noHorizontalScroll(size.width)));
        await js(`location.hash = "#/faeden"`);
        await waitFor(`document.getElementById("main").dataset.view === "threads" && !!document.querySelector("#threads-body .settings-empty")`);
        check(`${label}: Ansicht sagt „ausgeschaltet"`,
          (await js<string>(`document.querySelector("#threads-body .settings-empty").textContent`)).startsWith("Offene Fäden sind ausgeschaltet."));
        await js(`location.hash = "#/einstellungen/modelle"`);
        await waitFor(`!!document.querySelector('[data-focus-key="g-threads-enabled:true"]')`);
        await js(`document.querySelector('[data-focus-key="g-threads-enabled:true"]').click()`);
        await js(`document.querySelector('[data-focus-key="save:section-threads"]').click()`);
        await waitFor(`!document.getElementById("open-threads").hidden`);
        check(`${label}: wieder „An": Eintrag zurück, ohne Neuladen`, !(await js<boolean>(`document.getElementById("open-threads").hidden`)) && settings.data().threads?.enabled === true);

        // Verzögerte Erkennung: Faden entsteht erst Sekunden nach der Antwort
        if (scheme === "light" && !size.mobile) {
          await js(`location.hash = "#/gespraech/dm"`);
          await waitFor(`document.getElementById("main").dataset.view === "chat" && document.getElementById("chat-title").textContent === "Direktchat"`);
          await Bun.sleep(300);
          await typeAndEnter("Kurze Frage für die Fäden");
          await turnDone();
          setTimeout(() => threads.add({ conversation: { type: "dm", id: "dm", place: "Direktchat" }, topic: "Später erkannt", context: "Erst nach der Antwort angelegt.", question: "Passt das so?" }), 4000);
          const seen = await waitFor(`document.getElementById("threads-count").textContent === "1" && !document.getElementById("threads-count").hidden`, 20000);
          check(`${label}: Faden, der 4 s nach der Antwort entsteht, erscheint ohne Neuladen in der Anzahl`, seen);
        }
      } finally {
        await d.stop();
      }
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}

/**
 * Reiter „Schlüssel" (Issue #63), je 1280 und 390 px, hell (mit
 * --screenshots auch dunkel). Nur Demo-Attrappen: createDemoKeys hält die
 * .env im Speicher, createDemoStatus den Neustart. Es entsteht nie ein
 * echter Neustart-Marker, keine .env wird gelesen oder geschrieben.
 */
async function keysChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const click = (sel: string) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const key = (k: string) => `[data-focus-key="${k}"]`;
  const rowText = (name: string) => js<string>(`document.querySelector('li[data-key="${name}"]').textContent`);
  /** Kommt der Wert irgendwo in der Seite vor: HTML, Attribute oder value eines Felds */
  const inPage = (value: string) =>
    js<boolean>(`document.documentElement.outerHTML.includes(${JSON.stringify(value)}) || [...document.querySelectorAll("input, textarea")].some(i => i.value.includes(${JSON.stringify(value)}))`);
  const NEW_VALUE = "demo-browsercheck-gemini-Wq5z";
  try {
    for (const scheme of schemes) {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Schlüssel ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        const keys = createDemoKeys();
        const status = createDemoStatus();
        const d = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), keys, status, log: () => {} }
        );
        try {
          const url = `${d.server.url}/`;
          await goto(url);
          await waitFor(`!!document.getElementById("open-settings")`);
          await goto(`${url}#/einstellungen/schluessel`);
          await waitFor(`document.querySelectorAll("li[data-key]").length > 10`);
          // Acht Reiter (Issue #225, #248, #284, #323): breit in einer Zeile, am Handy drei Zeilen, keiner ragt über den Rand
          check(`${label}: acht Reiter (${size.mobile ? "drei Zeilen" : "eine Zeile"}), Schlüssel gewählt`,
            JSON.stringify(await js<string[]>(`[...document.querySelectorAll(".settings-tab")].map(t => t.textContent)`)) === JSON.stringify(["Agenten", "Modelle", "Sprechen", "Schlüssel", "Status", "Routinen", "Erinnerungen", "Benachrichtigungen"]) &&
              (await js<number>(`new Set([...document.querySelectorAll(".settings-tab")].map(t => Math.round(t.getBoundingClientRect().top))).size`)) === (size.mobile ? 3 : 1) &&
              (await js<boolean>(`[...document.querySelectorAll(".settings-tab")].every(t => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= innerWidth)`)) &&
              (await js<string>(`document.querySelector(".settings-tab[aria-selected=true]").textContent`)) === "Schlüssel");
          check(`${label}: Gruppen, gesetzt ••••c3d4, gesperrte ohne Knöpfe, kein seitliches Scrollen`,
            (await js<string>(`document.querySelector("#settings-panel h3").textContent`)) === "LLM-Anbieter" &&
              (await rowText("OPENROUTER_API_KEY")).includes("gesetzt ••••c3d4") &&
              (await js<number>(`document.querySelectorAll('li[data-key="TELEGRAM_BOT_TOKEN"] button').length`)) === 0 &&
              (await rowText("TELEGRAM_BOT_TOKEN")).includes("Nur direkt in der .env") &&
              !(await inPage("demo-platzhalter")) && (await noHorizontalScroll(size.width)));
          check(`${label}: Zustand bündig rechts in jeder Zeile`,
            await js<boolean>(`(() => { const r = [...document.querySelectorAll("li[data-key] .settings-key-state")].map(e => Math.round(e.getBoundingClientRect().right)); return r.length > 10 && r.every(x => x === r[0]); })()`));
          await shoot(`einstellungen-schluessel-${size.width}${suffix}`);

          // Setzen: Passwortfeld leer, verdeckt
          await click(key("key-edit:GEMINI_API_KEY"));
          await waitFor(`!!document.querySelector('${key("key-input:GEMINI_API_KEY")}')`);
          check(`${label}: Passwortfeld leer, verdeckt, fokussiert, new-password`,
            (await js<boolean>(`(() => { const i = document.querySelector('${key("key-input:GEMINI_API_KEY")}');
              return i.type === "password" && i.value === "" && !i.hasAttribute("value") && i.autocomplete === "new-password" && document.activeElement === i; })()`)));
          await js(`document.querySelector('${key("key-input:GEMINI_API_KEY")}').value = ${JSON.stringify(NEW_VALUE)}`);
          await js(`document.querySelector('li[data-key="GEMINI_API_KEY"]').scrollIntoView({ block: "center" })`);
          await shoot(`einstellungen-schluessel-setzen-${size.width}${suffix}`);
          check(`${label}: vor dem Speichern nur im Feld (nicht im HTML)`,
            !(await js<boolean>(`document.documentElement.outerHTML.includes(${JSON.stringify(NEW_VALUE)})`)));
          await click(key("key-save:GEMINI_API_KEY"));
          await waitFor(`!document.querySelector('${key("key-input:GEMINI_API_KEY")}')`);
          check(`${label}: gespeichert, Wert nirgends mehr in der Seite`,
            keys.values.get("GEMINI_API_KEY") === NEW_VALUE && !(await inPage(NEW_VALUE)) &&
              (await rowText("GEMINI_API_KEY")).includes("gesetzt ••••" + NEW_VALUE.slice(-4)));
          check(`${label}: Hinweis mit „Jetzt neu starten", noch kein Neustart`,
            !!(await js<boolean>(`!!document.querySelector('${key("key-restart")}')`)) && status.restartNotes.length === 0);
          await js(`document.querySelector('${key("key-restart")}').scrollIntoView({ block: "center" })`);
          await shoot(`einstellungen-schluessel-gespeichert-${size.width}${suffix}`);

          // Entfernen mit Rückfrage
          await click(key("key-remove:OPENROUTER_API_KEY"));
          await waitFor(`!!document.querySelector('${key("key-remove-no:OPENROUTER_API_KEY")}')`);
          check(`${label}: Rückfrage, Fokus auf Abbrechen, nichts gelöscht`,
            keys.values.has("OPENROUTER_API_KEY") && (await js<string>(`document.activeElement.dataset.focusKey`)) === "key-remove-no:OPENROUTER_API_KEY");
          await shoot(`einstellungen-schluessel-entfernen-${size.width}${suffix}`);
          await click(key("key-remove-yes:OPENROUTER_API_KEY"));
          await waitFor(`document.querySelector('li[data-key="OPENROUTER_API_KEY"]').textContent.includes("fehlt")`);
          check(`${label}: entfernt`, !keys.values.has("OPENROUTER_API_KEY"));

          // Neustart nur im Speicher der Demo
          await click(key("key-restart"));
          await waitFor(`!document.querySelector('${key("key-restart")}')`);
          check(`${label}: Neustart angefordert, genau einmal (Attrappe)`, status.restartNotes.length === 1);
        } finally {
          await d.stop();
        }

        // Schreibgeschützt
        const ro = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), keys: createDemoKeys({ editAllowed: false }), log: () => {} }
        );
        try {
          const url = `${ro.server.url}/`;
          await goto(url);
          await waitFor(`!!document.getElementById("open-settings")`);
          await goto(`${url}#/einstellungen/schluessel`);
          await waitFor(`document.querySelectorAll("li[data-key]").length > 10`);
          check(`${label}: ohne Opt-in keine Schreibknöpfe, Hinweis auf WEB_ALLOW_KEY_EDIT`,
            (await js<number>(`document.querySelectorAll("li[data-key] button").length`)) === 0 &&
              (await js<string>(`document.querySelector(".settings-keys-readonly").textContent`)).includes("WEB_ALLOW_KEY_EDIT=true") &&
              (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-schluessel-schreibgeschuetzt-${size.width}${suffix}`);
        } finally {
          await ro.stop();
        }

        // Über den Tunnel (Issue #99): lesen ja, ändern nur im Heimnetz
        const remote = await startTunnelKeysServer();
        try {
          const url = `${remote.url}/`;
          await goto(url);
          await waitFor(`!!document.getElementById("open-settings")`);
          await goto(`${url}#/einstellungen/schluessel`);
          await waitFor(`document.querySelectorAll("li[data-key]").length > 10`);
          const note = await js<string>(`document.querySelector(".settings-keys-readonly").textContent`);
          check(`${label}: über den Tunnel keine Schreibknöpfe, Hinweis „nur im Heimnetz", Werte lesbar`,
            (await js<number>(`document.querySelectorAll("li[data-key] button").length`)) === 0 &&
              note.includes("nur im Heimnetz") && !note.includes("WEB_ALLOW_KEY_EDIT") &&
              (await rowText("OPENROUTER_API_KEY")).includes("gesetzt ••••c3d4") &&
              (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-schluessel-tunnel-${size.width}${suffix}`);
        } finally {
          await remote.stop();
        }
      }
    }
  } finally {
    await cdp("Emulation.setEmulatedMedia", { features: [] });
  }
}

/**
 * WebUI wie hinter dem Cloudflare Tunnel (Issue #99): Chrome spricht mit
 * einem kleinen Proxy auf 127.0.0.1, der jede Anfrage so weiterreicht, wie
 * cloudflared es täte (Host app.tybo.ai, Origin https://app.tybo.ai,
 * CF-Connecting-IP, gültiger Access-Nachweis mit einem Test-Schlüssel) und
 * das Session-Cookie eines vorab angemeldeten Besuchers anhängt. Schlüssel
 * aus createDemoKeys (Opt-in an), der Schlüsselabruf ist eine Attrappe.
 */
async function startTunnelKeysServer() {
  const PUBLIC = "https://app.tybo.ai";
  const team = "browsercheck";
  const aud = "b".repeat(64);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "browsercheck" };
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const s = Math.floor(Date.now() / 1000);
  const data = `${part({ alg: "RS256", kid: "browsercheck" })}.${part({ aud: [aud], iss: accessIssuer(team), exp: s + 3600, nbf: s, iat: s })}`;
  const jwt = `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
  const tmp = await mkdtemp(join(tmpdir(), "tybo-web-tunnel-"));
  const store = new ConversationStore({ dir: join(tmp, "web") });
  await store.load();
  await store.createConversation("general");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], publicOrigin: PUBLIC, access: { team, aud } },
    {
      sessionFile: join(tmp, "sessions.json"),
      conversationStore: store,
      chat: createFakeChat({ delayMs: 300, stepMs: 100 }),
      keys: createDemoKeys(),
      accessCerts: async () => ({ keys: [jwk] }),
      log: () => {},
    }
  );
  const tunnelHeaders = (h: Headers) => {
    h.set("host", "app.tybo.ai");
    if (h.has("origin")) h.set("origin", PUBLIC);
    h.set("cf-connecting-ip", "203.0.113.7");
    h.set("cf-access-jwt-assertion", jwt);
    return h;
  };
  const login = await fetch(`${server.url}/api/login`, {
    method: "POST",
    headers: tunnelHeaders(new Headers({ "content-type": "application/json", origin: PUBLIC })),
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const target = new URL(req.url);
      const headers = tunnelHeaders(new Headers(req.headers));
      headers.set("cookie", cookie);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return fetch(`${server.url}${target.pathname}${target.search}`, { method: req.method, headers, body, redirect: "manual" });
    },
  });
  return {
    url: `http://127.0.0.1:${proxy.port}`,
    async stop() {
      proxy.stop(true);
      await server.stop();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Hinweis „Neue Version“ (Issue #111), je 1280 und 390 px, hell und (mit
 * --screenshots) dunkel. Simulierter Neustart: der Demo-Server stoppt und
 * startet auf demselben Port neu, erst mit derselben Oberflächen-Version
 * (kein Hinweis), dann mit einer anderen (genau ein Hinweis, im Chat und in
 * den Einstellungen). „Neu laden“ lädt die Seite, der Entwurf steht wieder da.
 * Nur Demo-Attrappen, kein Bot.
 */
async function updateChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  const NEWER = "fedcba9876543210";
  const DRAFT = "Entwurf vor dem Update";
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const start = (port: number, uiVersion?: string) =>
    startDemoServer(
      { host: "127.0.0.1", port, password: PASSWORD, allowedHosts: [] },
      { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), uiVersion, log: () => {} }
    );
  /** Sichtbare Hinweise mit Inhalt */
  const notesShown = () => js<string[]>(`[...document.querySelectorAll(".update-note")].filter(n => n.children.length && n.getClientRects().length).map(n => n.id)`);
  /** Beide Live-Verbindungen wieder offen (nach dem Neustart) */
  const streamsOpen = () => waitFor(`window.__sources && window.__sources.length >= 2 && window.__sources.filter(s => s.readyState === 1).length >= 2 && document.getElementById("connection").hidden`, 15000);
  // window.__sources zählt die EventSources (Skript vom Anfang des Durchlaufs)
  for (const scheme of schemes) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Neue Version ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      let current = await start(0);
      const port = Number(new URL(current.server.url).port);
      try {
        const url = `${current.server.url}/`;
        await goto(url);
        // Direktchat: seine ID bleibt über den Neustart (das Web-Gespräch der Demo entsteht jedes Mal neu)
        await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "dm"); sessionStorage.clear()`);
        await goto(url);
        await waitFor(`document.querySelectorAll(".msg").length > 0`);
        const loaded = await js<string>(`document.getElementById("ui-version").content`);
        check(`${label}: Seite trägt die Version im Meta-Tag`, /^[0-9a-f]{16}$/.test(loaded), loaded);
        check(`${label}: zu Beginn kein Hinweis`, (await notesShown()).length === 0);
        await streamsOpen();
        await js(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(DRAFT)}; i.dispatchEvent(new Event("input")); })()`);

        // Neustart ohne Änderung: Wiederverbinden, kein Hinweis
        await current.stop();
        current = await start(port);
        await Bun.sleep(300);
        check(`${label}: Neustart ohne Änderung, Verbindungen wieder offen`, await streamsOpen(),
          await js<string>(`window.__sources.map(s => s.readyState).join() + " / " + document.getElementById("connection").textContent`));
        await Bun.sleep(800);
        check(`${label}: Neustart ohne Änderung zeigt keinen Hinweis`, (await notesShown()).length === 0);

        // Neustart mit neuer Oberfläche: genau ein Hinweis im Chat
        await current.stop();
        current = await start(port, NEWER);
        check(`${label}: nach dem Update genau ein Hinweis oben im Chat`,
          (await waitFor(`document.querySelector("#update-note .update-button")`, 15000)) &&
            JSON.stringify(await notesShown()) === JSON.stringify(["update-note"]));
        check(`${label}: Text und Knopf`,
          (await js<string>(`document.querySelector("#update-note .update-text").textContent`)) === `Neue Version von ${BRAND.name} verfügbar` &&
            (await js<string>(`[...document.querySelectorAll("#update-note button")].map(b => b.textContent).join()`)) === "Neu laden");
        check(`${label}: Hinweis unter der Kopfzeile, über dem Verlauf, volle Breite`,
          await js<boolean>(`(() => { const n = document.getElementById("update-note").getBoundingClientRect(); const h = document.querySelector(".main > .topbar").getBoundingClientRect(); const l = document.getElementById("chat-log").getBoundingClientRect();
            return n.top >= h.bottom - 1 && n.bottom <= l.top + 1 && Math.abs(n.width - h.width) < 1; })()`));
        check(`${label}: kein horizontales Scrollen`, await noHorizontalScroll(size.width));
        check(`${label}: status-Region für Screenreader`, (await js<string>(`document.getElementById("update-note").getAttribute("role")`)) === "status");
        await shoot(`neue-version-chat-${size.width}${suffix}`);

        // Einstellungen: derselbe Hinweis unter deren Kopfzeile, der des Chats ist verdeckt
        if (size.mobile) await openDrawer();
        await js(`document.getElementById("open-settings").click()`);
        await waitFor(`document.getElementById("main").dataset.view === "settings" && document.querySelectorAll(".settings-agent-head").length > 0`);
        check(`${label}: Hinweis in den Einstellungen, nur dort sichtbar`, JSON.stringify(await notesShown()) === JSON.stringify(["settings-update-note"]));
        check(`${label}: in den Einstellungen unter der Kopfzeile`,
          await js<boolean>(`(() => { const n = document.getElementById("settings-update-note").getBoundingClientRect(); const h = document.querySelector("#settings > .topbar").getBoundingClientRect(); return n.top >= h.bottom - 1 && n.height > 0; })()`));
        await shoot(`neue-version-einstellungen-${size.width}${suffix}`);
        await js(`document.getElementById("settings-back").click()`);
        await waitFor(`document.getElementById("main").dataset.view === "chat"`);

        // Neu laden: der Entwurf steht wieder da, der Hinweis ist weg
        await js(`document.querySelector("#update-note .update-button").click()`);
        await Bun.sleep(300);
        await waitFor(`document.readyState === "complete" && document.getElementById("ui-version").content === ${JSON.stringify(NEWER)}`);
        check(`${label}: nach „Neu laden“ steht der Entwurf wieder da`,
          await waitFor(`document.getElementById("input").value === ${JSON.stringify(DRAFT)}`));
        check(`${label}: nach dem Neuladen kein Hinweis, Sicherung aufgeräumt`,
          (await notesShown()).length === 0 && (await js<boolean>(`sessionStorage.getItem("tybo-reload-drafts") === null`)));
      } finally {
        await current.stop();
      }
    }
  }
}

async function goalChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const labels = `[...document.querySelectorAll("#goal-card .goal-button")].map(b => b.textContent).join(",")`;
  for (const scheme of schemes) {
    await emulateScheme(scheme as "light" | "dark");
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Ziel ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const goalDemo = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
      );
      try {
        const url = `${goalDemo.server.url}/`;
        await goto(url);
        await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-31")`);
        await goto(url);
        check(`${label}: Karte im Topic Strategie sichtbar`,
          await waitFor(`document.getElementById("chat-title").textContent === "Strategie" && !document.getElementById("goal-card").hidden`));
        check(`${label}: Ziel, Zustand, Runde 3 von 10, letzter Stand`,
          await js<boolean>(`(() => { const c = document.getElementById("goal-card");
            return c.querySelector(".goal-text").textContent.startsWith("Preismodell") && c.querySelector(".goal-state").textContent === "arbeitet"
              && c.querySelector(".goal-meta").textContent === "Runde 3 von 10 · Strategy" && c.querySelector(".goal-note").textContent.startsWith("Letzter Stand:"); })()`));
        check(`${label}: Knöpfe Pause und Stopp`, (await js<string>(labels)) === "Pause,Stopp", await js<string>(labels));
        check(`${label}: Karte über der Eingabe, ohne Schatten`,
          await js<boolean>(`(() => { const c = document.getElementById("goal-card").getBoundingClientRect(); const f = document.getElementById("composer").getBoundingClientRect();
            return c.bottom <= f.top + 1 && getComputedStyle(document.getElementById("goal-card")).boxShadow === "none"; })()`));
        check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
        if (size.mobile) {
          const h = await js<number>(`document.querySelector("#goal-card .goal-button").getBoundingClientRect().height`);
          check(`${label}: Knöpfe mit 44 px Tippfläche`, h >= 44, `${h} px`);
        }
        await shoot(`ziel-${size.width}${suffix}`);
        await js(`document.querySelector('#goal-card [data-action="pause"]').click()`);
        check(`${label}: Pause wechselt zu pausiert mit Weiter und Stopp`,
          await waitFor(`document.querySelector("#goal-card .goal-state").textContent === "pausiert" && ${labels} === "Weiter,Stopp"`, 3000));
        await shoot(`ziel-pausiert-${size.width}${suffix}`);
        await js(`document.querySelector('#goal-card [data-action="stop"]').click()`);
        check(`${label}: Stopp entfernt die Karte`, await waitFor(`document.getElementById("goal-card").hidden`, 3000));
        await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
      } finally {
        await goalDemo.stop();
      }
    }
  }
}

/**
 * Rückfrage-Knöpfe (Issue #115) je 1280 und 390 px, hell und (mit
 * --screenshots) dunkel: Topic „Strategie" der Demo mit einer erledigten und
 * einer offenen Werkzeug-Freigabe (Register nur im Speicher). 1280 px: Klick
 * im Browser; 390 px: Entscheidung in Telegram (simuliert), kommt ohne
 * Neuladen. Danach die Erledigt-Zeile, am Handy 44 px Tippfläche, kein
 * seitliches Scrollen.
 */
/** Job-Frage im echten Browser; Register und Status echt, Fortsetzung ohne Motor als Attrappe. */

/** Jobs-Ansicht, vier Größen/Farben; WEB_JOBS_URL liefert Fotos aus laufendem web:dev. */
async function jobViewChecks() {
  const shots = process.argv.includes("--screenshots");
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const selected = (id: string) => `document.querySelector('[data-job-id="${id}"]')`;
  const action = (id: string, name: string) => `${selected(id)}.querySelector('[data-job-action="${id}:${name}"]')`;
  const ready = `document.getElementById("main").dataset.view === "jobs" && document.querySelectorAll("#jobs-body .job-item").length === 3`;
  for (const scheme of shots ? ["light", "dark"] : ["light"]) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    for (const size of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const label = `Jobs ${size.width} px ${scheme}`;
      const choices = createDemoChoices();
      const jobs = createDemoJobs(choices);
      const d = await startDemoServer({ host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] }, { choices, jobs, log: () => {} });
      const url = process.env.WEB_JOBS_URL || d.server.url;
      const shoot = async (name: string) => {
        if (!shots) return;
        await Bun.sleep(150);
        const { data } = await cdp("Page.captureScreenshot", { format: "png" });
        const file = `jobs-${name}-${size.width}${scheme === "dark" ? "-dunkel" : ""}.png`;
        await Bun.write(join(out, file), Buffer.from(data, "base64"));
        console.log(`Bild ${file}`);
      };
      try {
        await goto(url + "/");
        await waitFor(`document.getElementById("jobs-count")?.textContent === "1"`);
        if (size.mobile) await openDrawer();
        check(`${label}: Eintrag mit hervorgehobener Wartezahl`, await js<boolean>(`document.getElementById("jobs-count").dataset.waiting === "true" && ${shown("open-jobs")}`));
        await shoot("seitenleiste");
        await js(`document.getElementById("open-jobs").click()`);
        await waitFor(ready);
        check(`${label}: Liste, Reihenfolge, Fokus und Adresse`, await js<boolean>(`location.hash === "#/jobs" && document.activeElement.id === "jobs-title" && document.querySelector("#jobs-body .job-item").dataset.phase === "waiting" && document.getElementById("open-jobs").getAttribute("aria-current") === "page"`));
        check(`${label}: alle Status, Arbeitszeit, Lauf und Gespräch`, await js<boolean>(`["wartet auf dich", "läuft", "abgebrochen", "Arbeitszeit", "Lauf 1", "Strategie"].every(t => document.getElementById("jobs-body").textContent.includes(t))`));
        check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
        await shoot("liste");
        await js(`${selected(DEMO_JOB_IDS.waiting)}.querySelector("summary").click()`);
        await waitFor(`${selected(DEMO_JOB_IDS.waiting)}.querySelector("details").open`);
        check(`${label}: Frage und dieselben zwei Optionen`, await js<boolean>(`${selected(DEMO_JOB_IDS.waiting)}.querySelectorAll(".choice-button").length === 2 && ${selected(DEMO_JOB_IDS.waiting)}.textContent.includes("Soll ich auch kostenpflichtige Angebote vergleichen?")`));
        await shoot("frage");
        await js(`${action(DEMO_JOB_IDS.waiting, "log")}.click()`);
        await waitFor(`!!document.querySelector(".job-log")`);
        check(`${label}: Log maskiert, Lauf sichtbar`, await js<boolean>(`document.querySelector(".job-log").textContent.includes("[verborgen]") && document.querySelector(".job-file").textContent.includes("Lauf 1")`));
        await shoot("log");
        check(`${label}: Frage und Log ohne Überbreite`, await noHorizontalScroll(size.width));
        await js(`${action(DEMO_JOB_IDS.aborted, "report")}.click()`);
        await waitFor(`!!document.querySelector(".job-file .content h2")`);
        await js(`document.querySelector(".job-file").scrollIntoView({ block: "center" })`);
        check(`${label}: Bericht als Markdown`, await js<boolean>(`document.querySelector(".job-file .content h2").textContent === "Zwischenstand"`));
        await shoot("bericht");

        // Zustandswechsel auf einer frischen Attrappe, externe Fotovorlage bleibt unverändert.
        await goto(d.server.url + "/#/jobs");
        await waitFor(ready);
        await js(`${action(DEMO_JOB_IDS.running, "stop")}.click()`);
        check(`${label}: Bestätigung mit Fokus auf Abbrechen`, await js<boolean>(`document.activeElement.getAttribute("data-job-action") === "${DEMO_JOB_IDS.running}:cancel" && ${selected(DEMO_JOB_IDS.running)}.textContent.includes("nicht fortgesetzt")`));
        await js(`${action(DEMO_JOB_IDS.running, "cancel")}.click()`);
        check(`${label}: Abbrechen lässt Job laufen`, (await jobs.list(async () => "")).find(j => j.id === DEMO_JOB_IDS.running)?.phase === "running");
        await js(`${action(DEMO_JOB_IDS.running, "stop")}.click(); ${action(DEMO_JOB_IDS.running, "confirm")}.click()`);
        await waitFor(`${selected(DEMO_JOB_IDS.running)}.textContent.includes("gestoppt")`);
        check(`${label}: Stoppen aktualisiert Liste`, (await jobs.list(async () => "")).find(j => j.id === DEMO_JOB_IDS.running)?.status === "gestoppt");
        await js(`${action(DEMO_JOB_IDS.aborted, "resume")}.click()`);
        await waitFor(`${selected(DEMO_JOB_IDS.aborted)}.textContent.includes("Lauf 2")`);
        check(`${label}: Fortsetzen, neuer Lauf ohne alten Bericht`, await js<boolean>(`!${action(DEMO_JOB_IDS.aborted, "report")} && ${selected(DEMO_JOB_IDS.aborted)}.dataset.phase === "running"`));
        await js(`${selected(DEMO_JOB_IDS.waiting)}.querySelector("summary").click(); ${selected(DEMO_JOB_IDS.waiting)}.querySelector('[data-key="a1"]').click()`);
        await waitFor(`${selected(DEMO_JOB_IDS.waiting)}.dataset.phase === "running"`);
        check(`${label}: Antwort gilt auch in Telegram und Pille zählt laufende`, (await choices.decideInTelegram(DEMO_JOB_CHOICE, "a2")).status === "already" && await js<boolean>(`document.getElementById("jobs-count").textContent === "2" && document.getElementById("jobs-count").dataset.waiting === "false"`));
        if (size.width === 1280 && scheme === "light") {
          await jobs.act(DEMO_JOB_IDS.waiting, "stop", "browser-poll-00000001", 2);
          await waitFor(`${selected(DEMO_JOB_IDS.waiting)}.dataset.phase === "ended"`, 13_000);
          check(`${label}: fremder Zustandswechsel wird ohne Neuladen abgeholt`, await js<boolean>(`${selected(DEMO_JOB_IDS.waiting)}.textContent.includes("gestoppt")`));
        }
        await js(`${action(DEMO_JOB_IDS.aborted, "open")}.click()`);
        await waitFor(`document.getElementById("main").dataset.view === "chat" && document.getElementById("chat-title").textContent === "Strategie"`);
        check(`${label}: Zum Gespräch öffnet Strategie`, await js<boolean>(`document.getElementById("jobs-view").hidden && location.hash === ""`));
        await goto(d.server.url + "/#/jobs"); await waitFor(ready);
        await js(`document.getElementById("jobs-back").click()`);
        await waitFor(`document.getElementById("main").dataset.view === "chat"`);
        check(`${label}: Direktlink und Zurück`, await js<boolean>(`location.hash === "" && document.getElementById("jobs-view").hidden`));
      } finally { await d.stop(); }
    }
  }
}

async function jobResumeChoiceChecks() {
  const shots = process.argv.includes("--screenshots");
  const jobId = "20261118-120000-000623";
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  for (const scheme of shots ? ["light", "dark"] as const : ["light"] as const) {
    await emulateScheme(scheme);
    for (const width of [1280, 390]) {
      const label = `Job-Fortsetzen ${width} px ${scheme}`;
      const root = await mkdtemp(join(dir, "job-choice-"));
      const file = join(root, "choices.json");
      setChoicesFileForTests(file);
      let starts = 0;
      const off = onChoiceDecided("job", () => { starts++; });
      const port = createChoicePort({
        register: { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange },
        groupId: () => DEMO_GROUP_ID, log: () => {}, staleText: c => jobChoiceStaleText(root, c),
      });
      const jobDemo = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat(), log: () => {}, choices: { ...port, decideInTelegram: (id, key) => decideChoice(id, key, "telegram") } },
      );
      try {
        const choice = await createChoice({ kind: "job", ref: jobId, action: "resume-1",
          conversation: { type: "telegram", chatId: DEMO_GROUP_ID, topicId: 31 },
          text: `Job ${jobId} fortsetzen? Kleiner Testauftrag\nLauf 2 bekommt erneut bis zu 1 Std.`,
          options: [{ key: "resume", label: "Fortsetzen" }],
        });
        jobDemo.receiveNotice("topic-31", "job", choice.text, undefined, choice.id);
        await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, mobile: width === 390, deviceScaleFactor: 2 });
        await goto(`${jobDemo.server.url}/#/gespraech/topic-31`);
        const box = `document.querySelector('.choice[data-choice="${choice.id}"]')`;
        const status = `${box}?.querySelector('.choice-status')?.textContent`;
        check(`${label}: Knopf sichtbar`, await waitFor(`${box}?.querySelector('button')?.textContent === 'Fortsetzen'`));
        check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(width));
        if (width === 390) check(`${label}: mindestens 44 px Tippfläche`, await js<boolean>(`${box}.querySelector('button').getBoundingClientRect().height >= 44`));
        const shoot = async (state: string) => {
          if (!shots) return;
          await js(`document.getElementById('chat-log').scrollTop = document.getElementById('chat-log').scrollHeight`);
          const { data } = await cdp("Page.captureScreenshot", { format: "png" });
          await Bun.write(join(out, `job-fortsetzen-${state}-${width}-${scheme}.png`), Buffer.from(data, "base64"));
        };
        await shoot("offen");
        if (width === 390) {
          // Wie CLI in einem anderen Prozess: abgelaufen, ohne Ereignis an diesen Browser.
          const stored = JSON.parse(await readFile(file, "utf8"));
          stored.choices[choice.id].state = "expired";
          await writeFile(file, JSON.stringify(stored));
          await writeStatus(root, { version: 1, id: jobId, title: "Test", createdAt: new Date().toISOString(),
            phase: "starting", run: 2, maxHours: 1, fullAccess: false, target: {} });
          await js(`${box}.querySelector('button').click()`);
          check(`${label}: alter Knopf sagt läuft schon`, await waitFor(`${status} === 'Job ${jobId} läuft schon.'`));
          check(`${label}: kein zweiter Start`, starts === 0);
        } else {
          await js(`${box}.querySelector('button').click()`);
          check(`${label}: Entscheidung sichtbar`, await waitFor(`(${status} || '').startsWith('Erledigt: Fortsetzen')`));
          check(`${label}: genau eine Entscheidung`, starts === 1);
        }
        check(`${label}: Knopf nach Klick entfernt`, await js<boolean>(`!${box}.querySelector('button')`));
        await shoot("erledigt");
      } finally {
        off();
        await jobDemo.stop();
        setChoicesFileForTests(null);
      }
    }
  }
}

/** #624: echter Wächter und Antwort-Handler, nur Motor und Versand sind lokale Attrappen. */
async function jobQuestionChecks() {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { fakeDeps, fakeChild } = await import("../tests/jobs-fixture");
  const { claudeProjectDir } = await import("../src/lib/engines/claude-notes");
  const { runWatcher } = await import("../src/lib/jobs/runner");
  const { jobFile, readStatus } = await import("../src/lib/jobs/store");
  const { jobChoiceHandler, expireJobChoices } = await import("../src/lib/jobs/choices");
  const { recoverWaitingQuestion } = await import("../src/lib/jobs/question-choices");
  const shots = process.argv.includes("--screenshots");
  const jobId = "20261118-150000-000624";
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  for (const scheme of shots ? ["light", "dark"] as const : ["light"] as const) {
    await emulateScheme(scheme);
    for (const width of [1280, 390]) {
      const label = `Job-Rückfrage ${width} px ${scheme}`;
      const root = await mkdtemp(join(dir, "job-question-"));
      setChoicesFileForTests(join(root, "data", "choices.json"));
      const port = createChoicePort({ register: { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange },
        groupId: () => DEMO_GROUP_ID, log: () => {} });
      const jobDemo = await startDemoServer({ host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat(), log: () => {}, choices: { ...port, decideInTelegram: (id, key) => decideChoice(id, key, "telegram") } });
      const deps = fakeDeps(root);
      deps.claudeEnv = () => ({ HOME: root });
      deps.expireResumeChoices = expireJobChoices;
      deps.recoverWaiting = s => recoverWaitingQuestion(s, deps, { userId: "4711", groupId: DEMO_GROUP_ID, telegram: false });
      deps.notify = async input => {
        jobDemo.receiveNotice("topic-31", "job", input.text ?? "", undefined, input.choiceId);
        return { sent: false, recorded: true };
      };
      let watching: Promise<number> = Promise.resolve(0);
      let starts = 0;
      deps.spawnWatcher = (id, run) => { starts++; watching = runWatcher(id, deps, run); return { pid: process.pid }; };
      deps.spawnClaude = spec => {
        deps.spawned.push(spec);
        return fakeChild(deps.procs.spawn(60024), Promise.resolve({ code: 0, signal: null }), () => {
          if (spec.cmd.includes("--resume")) {
            writeFileSync(jobFile(root, jobId, "report"), "ANTWORT_OK: Gewählte Antwort B.");
          } else {
            writeFileSync(jobFile(root, jobId, "question"), JSON.stringify({ frage: "Soll ich A oder B verwenden?",
              antworten: ["A", "B"], kontext: "Für den Bericht brauche ich diese Entscheidung." }));
          }
        });
      };
      const off = onChoiceDecided("job", jobChoiceHandler(deps));
      try {
        await writeStatus(root, { version: 1, id: jobId, title: "A oder B im Bericht", sessionId, createdAt: new Date().toISOString(),
          phase: "starting", run: 1, maxHours: 1, fullAccess: false, target: { chatId: DEMO_GROUP_ID, topicId: 31 } });
        await writeFile(jobFile(root, jobId, "brief"), "Frag mich, ob A oder B, und schreib die Antwort in den Bericht.");
        mkdirSync(claudeProjectDir(root, root), { recursive: true });
        writeFileSync(join(claudeProjectDir(root, root), `${sessionId}.jsonl`), "{}\n");
        await runWatcher(jobId, deps);
        const waiting = (await readStatus(root, jobId))!;
        check(`${label}: Job wartet mit einer Frage`, waiting.phase === "waiting" && waiting.questionCount === 1 && (await listChoices()).length === 1);
        const choiceId = waiting.waiting!.choiceId!;
        const box = `document.querySelector('.choice[data-choice="${choiceId}"]')`;
        await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, mobile: width === 390, deviceScaleFactor: 2 });
        await goto(`${jobDemo.server.url}/#/gespraech/topic-31`);
        check(`${label}: Frage und Knöpfe A/B sichtbar`, await waitFor(`${box}?.querySelectorAll('button').length === 2 && document.getElementById('messages').textContent.includes('Soll ich A oder B verwenden?')`));
        check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(width));
        if (width === 390) check(`${label}: mindestens 44 px Tippfläche`, await js<boolean>(`[...${box}.querySelectorAll('button')].every(b => b.getBoundingClientRect().height >= 44)`));
        const shoot = async (state: string) => {
          if (!shots) return;
          await js(`document.getElementById('chat-log').scrollTop = document.getElementById('chat-log').scrollHeight`);
          const { data } = await cdp("Page.captureScreenshot", { format: "png" });
          await Bun.write(join(out, `job-rueckfrage-${state}-${width}-${scheme}.png`), Buffer.from(data, "base64"));
        };
        await shoot("offen");
        await js(`${box}.querySelectorAll('button')[1].click()`);
        check(`${label}: Antwort B erledigt und Bericht sichtbar`, await waitFor(`(${box}?.querySelector('.choice-status')?.textContent || '').startsWith('Erledigt: B') && document.getElementById('messages').textContent.includes('ANTWORT_OK: Gewählte Antwort B.')`));
        await watching;
        check(`${label}: genau ein Start mit --resume und Antwortdaten`, starts === 1 && deps.spawned[1]?.cmd.includes("--resume") && deps.spawned[1]?.prompt.includes('Antwort des Nutzers: "B"'));
        check(`${label}: gleiche Session und erfolgreicher Bericht`, (await readStatus(root, jobId))?.outcome === "success" && (await readStatus(root, jobId))?.sessionId === sessionId);
        check(`${label}: Knöpfe entfernt`, await js<boolean>(`!${box}.querySelector('button')`));
        await shoot("bericht");
        await goto(`${jobDemo.server.url}/#/gespraech/topic-31`);
        check(`${label}: nach Neuladen weiter erledigt, Bericht bleibt`, await waitFor(`(${box}?.querySelector('.choice-status')?.textContent || '').startsWith('Erledigt: B') && document.getElementById('messages').textContent.includes('ANTWORT_OK: Gewählte Antwort B.')`));
      } finally {
        off();
        await watching;
        await jobDemo.stop();
        setChoicesFileForTests(null);
      }
    }
  }
}

/** Echter Rückgabeweg bis zum Browser, gleiche Motor-Attrappen wie im Terminal-Nachweis. */
async function jobReturnChecks() {
  const { startJobReturnProof, PROOF_REPORT, PROOF_REPLY } = await import("./job-return-proof");
  const shots = process.argv.includes("--screenshots");
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const cookies = (await cdp("Network.getCookies")).cookies;
  try {
    for (const scheme of shots ? ["light", "dark"] as const : ["light"] as const) {
      await emulateScheme(scheme);
      for (const width of [1280, 390]) {
        const proof = await startJobReturnProof(PASSWORD);
        const label = `Job-Rückgabe ${width} px ${scheme}`;
        try {
          await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, mobile: width === 390, deviceScaleFactor: 2 });
          const url = `${proof.server.url}/#/gespraech/${proof.conversationId}`;
          await goto(url);
          check(`${label}: isolierte Anmeldung`, await waitFor(`document.getElementById('login-form')`));
          await js(`document.getElementById('password').value = ${JSON.stringify(PASSWORD)}; document.getElementById('login-form').requestSubmit()`);
          check(`${label}: richtiges Gespräch offen`, await waitFor(`document.querySelector('.conversation[aria-current=true]')?.dataset.id === ${JSON.stringify(proof.conversationId)}`));
          check(`${label}: Live-Verbindung bereit`, await waitFor(`document.getElementById('connection').hidden && document.getElementById('messages')`));
          await proof.run();
          check(`${label}: Bericht und Antwort kommen ohne Neuladen`, await waitFor(`document.querySelector('.msg-notice')?.textContent.includes(${JSON.stringify(PROOF_REPORT)}) && document.querySelector('.msg-assistant .bubble')?.textContent.includes(${JSON.stringify(PROOF_REPLY)})`));
          const ordered = `(() => { const rows = [...document.querySelectorAll('#messages .msg')]; return rows.length === 2 && rows[0].classList.contains('msg-notice') && rows[1].classList.contains('msg-assistant'); })()`;
          check(`${label}: genau Bericht, dann Antwort; keine Nutzerblase`, await js<boolean>(ordered) && await count('.msg-user') === 0);
          check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(width));
          if (shots) {
            const { data } = await cdp("Page.captureScreenshot", { format: "png" });
            await Bun.write(join(out, `job-zurueck-${width}-${scheme}.png`), Buffer.from(data, "base64"));
          }
          await goto(url);
          check(`${label}: nach Neuladen weiterhin genau Bericht und Antwort`, await waitFor(ordered));
        } finally { await proof.stop(); }
      }
    }
  } finally {
    await cdp("Network.clearBrowserCookies");
    await cdp("Network.setCookies", { cookies: cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain,
      path: c.path, secure: c.secure, httpOnly: c.httpOnly, ...(c.expires > 0 ? { expires: c.expires } : {}) })) });
  }
}

async function choiceChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const box = (id: string) => `document.querySelector('.choice[data-choice="${id}"]')`;
  const labels = `[...${box(DEMO_CHOICES.open)}.querySelectorAll(".choice-button")].map(b => b.textContent).join(",")`;
  const status = (id: string) => `(${box(id)}?.querySelector(".choice-status")?.textContent || "")`;
  for (const scheme of schemes) {
    await emulateScheme(scheme as "light" | "dark");
    const suffix = scheme === "dark" ? "-dunkel" : "";
    for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      const label = `Rückfrage ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const choiceDemo = await startDemoServer(
        { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
        { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
      );
      try {
        const url = `${choiceDemo.server.url}/`;
        await goto(url);
        await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-31")`);
        await goto(url);
        check(`${label}: offene Rückfrage mit Knöpfen Erlauben und Ablehnen`,
          await waitFor(`document.getElementById("chat-title").textContent === "Strategie" && ${box(DEMO_CHOICES.open)} && ${labels} === "Erlauben,Ablehnen"`),
          await js<string>(`${box(DEMO_CHOICES.open)} ? ${labels} : "keine"`));
        check(`${label}: erledigte Rückfrage als Zeile „Erledigt: Erlauben · in Telegram · hh:mm“`,
          await js<boolean>(`/^Erledigt: Erlauben · in Telegram · \\d{2}:\\d{2}$/.test(${status(DEMO_CHOICES.done)}) && !${box(DEMO_CHOICES.done)}.querySelector("button")`),
          await js<string>(status(DEMO_CHOICES.done)));
        check(`${label}: erster Knopf in der Handlungsfarbe, zweiter leise, kein Schatten`,
          await js<boolean>(`(() => { const [a, b] = ${box(DEMO_CHOICES.open)}.querySelectorAll(".choice-button");
            const probe = document.createElement("span"); probe.style.color = "var(--accent)"; document.body.appendChild(probe);
            const accent = getComputedStyle(probe).color; probe.remove();
            const sa = getComputedStyle(a), sb = getComputedStyle(b);
            return sa.backgroundColor === accent && sb.backgroundColor !== accent && sa.boxShadow === "none" && sb.boxShadow === "none"; })()`));
        check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
        if (size.mobile) {
          const h = await js<number>(`Math.min(...[...${box(DEMO_CHOICES.open)}.querySelectorAll(".choice-button")].map(b => b.getBoundingClientRect().height))`);
          check(`${label}: Knöpfe mit 44 px Tippfläche`, h >= 44, `${h} px`);
        }
        await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
        await shoot(`rueckfrage-offen-${size.width}${suffix}`);
        if (size.mobile) {
          // Entscheidung in Telegram: kommt per SSE, ohne Neuladen
          await js(`window.__choiceMarker = true`);
          await choiceDemo.choices.decideInTelegram(DEMO_CHOICES.open, "no");
          check(`${label}: Klick in Telegram erscheint ohne Neuladen als erledigt`,
            await waitFor(`${status(DEMO_CHOICES.open)}.startsWith("Erledigt: Ablehnen · in Telegram · ") && window.__choiceMarker === true`, 3000),
            await js<string>(status(DEMO_CHOICES.open)));
        } else {
          await js(`${box(DEMO_CHOICES.open)}.querySelectorAll(".choice-button")[1].click()`);
          check(`${label}: Klick im Browser ersetzt die Knöpfe durch „Erledigt: Ablehnen · im Browser“`,
            await waitFor(`${status(DEMO_CHOICES.open)}.startsWith("Erledigt: Ablehnen · im Browser · ") && !${box(DEMO_CHOICES.open)}.querySelector(".choice-button")`, 3000),
            await js<string>(status(DEMO_CHOICES.open)));
        }
        check(`${label}: nach der Entscheidung kein seitliches Scrollen`, await noHorizontalScroll(size.width));
        await shoot(`rueckfrage-erledigt-${size.width}${suffix}`);
        await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
      } finally {
        await choiceDemo.stop();
      }
    }
  }
}

/**
 * Werkzeug-Freigabe als Rückfrage (Issue #116) je 1280 und 390 px, hell und
 * (mit --screenshots) dunkel: ein echter wartender Werkzeug-Turn im
 * Web-Gespräch über den gemeinsamen Freigabe-Handler (src/lib/tool-approval.ts),
 * das Rückfragen-Register mit eigener Datei im Temp-Verzeichnis und den
 * echten Web-Chat (createBotChat) mit Attrappe statt Claude. 1280 px: Klick
 * im Browser; 390 px: Klick in Telegram (simuliert über das Register). Danach
 * die Erledigt-Zeile und die Antwort des Turns.
 */
async function toolApprovalChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  let toolRuns = 0;
  registerBuiltinTool({
    name: "notiz_schreiben",
    description: "Schreibt eine Notiz in den Notizordner",
    inputSchema: { type: "object", properties: {} },
    requiresApproval: true,
    isAvailable: () => true,
    handler: async () => {
      toolRuns++;
      return "geschrieben";
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "tybo-freigabe-"));
  const openBox = `document.querySelector(".choice .choice-button")?.closest(".choice")`;
  const lastBox = `[...document.querySelectorAll(".choice")].at(-1)`;
  const lastStatus = `(${lastBox}?.querySelector(".choice-status")?.textContent || "")`;
  try {
    for (const scheme of schemes) {
      await emulateScheme(scheme as "light" | "dark");
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Freigabe ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        setChoicesFileForTests(join(dir, `choices-${size.width}-${scheme}.json`));
        const copies: { id: string; text: string }[] = [];
        const approvals = createApprovalTurns();
        const approval = createChoiceToolApproval({
          sendChoice: async choice => {
            copies.push({ id: choice.id, text: choice.text });
            return { sent: true };
          },
          presenter: key => approvals.presenter(key),
          log: () => {},
        });
        setToolApprovalHandler(approval.handler);
        const chat = createBotChat({
          runStreamingTurn: async () => {
            const r = await callBuiltinTool("notiz_schreiben", { pfad: "notizen/einkauf.md", text: "Milch, Brot, Kaffee" });
            return r.isError ? "Die Notiz wurde nicht geschrieben, die Freigabe fehlte." : "Erledigt: Notiz `notizen/einkauf.md` geschrieben.";
          },
          saveMessage: async () => true,
          processIntents: async () => {},
          abortEngineCalls: key => abortExecutions(key),
          isShuttingDown: () => false,
          scheduleRestartCheck: () => {},
          approvals,
          log: () => {},
        });
        const port = createChoicePort({
          register: { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange },
          groupId: () => DEMO_GROUP_ID,
          log: () => {},
        });
        const approvalDemo = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          { chat, choices: { ...port, decideInTelegram: (id, key) => decideChoice(id, key, "telegram") }, log: () => {} }
        );
        try {
          const url = `${approvalDemo.server.url}/`;
          await goto(url);
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
          await goto(url);
          await waitFor(`!document.getElementById("input").disabled && document.querySelectorAll(".msg").length > 0`);
          const runsBefore = toolRuns;
          await typeAndEnter("Schreib mir die Einkaufsliste als Notiz");
          check(`${label}: Freigabe mit Knöpfen Erlauben und Ablehnen im Web-Gespräch`,
            await waitFor(`${openBox} && [...${openBox}.querySelectorAll(".choice-button")].map(b => b.textContent).join(",") === "Erlauben,Ablehnen"`, 5000));
          check(`${label}: Statuszeile „Wartet auf deine Antwort“, Senden und Stopp sichtbar`,
            await waitFor(`document.getElementById("activity-text").textContent === "Wartet auf deine Antwort" && ${shown("send")} && ${shown("stop")}`, 3000));
          check(`${label}: Werkzeug läuft noch nicht`, toolRuns === runsBefore);
          check(`${label}: Kopie im Direktchat mit Hinweis auf das Web-Gespräch`,
            copies.length === 1 && /^\(Web-Gespräch „[^“]+“\)\nFreigabe nötig: Werkzeug notiz_schreiben/.test(copies[0].text), copies[0]?.text.split("\n")[0]);
          check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          if (size.mobile) {
            const h = await js<number>(`Math.min(...[...${openBox}.querySelectorAll(".choice-button")].map(b => b.getBoundingClientRect().height))`);
            check(`${label}: Knöpfe mit 44 px Tippfläche`, h >= 44, `${h} px`);
          }
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`freigabe-offen-${size.width}${suffix}`);
          if (size.mobile) {
            await decideChoice(copies[0].id, "allow", "telegram");
            check(`${label}: Klick in Telegram erscheint als „Erledigt: Erlauben · in Telegram“`,
              await waitFor(`${lastStatus}.startsWith("Erledigt: Erlauben · in Telegram · ")`, 3000), await js<string>(lastStatus));
          } else {
            await js(`${openBox}.querySelector(".choice-button").click()`);
            check(`${label}: Klick im Browser: „Erledigt: Erlauben · im Browser“, Knöpfe weg`,
              await waitFor(`${lastStatus}.startsWith("Erledigt: Erlauben · im Browser · ") && !document.querySelector(".choice .choice-button")`, 3000),
              await js<string>(lastStatus));
          }
          check(`${label}: Turn fertig, Antwort da, Werkzeug genau einmal`,
            (await turnDone()) && (await waitFor(`[...document.querySelectorAll(".msg")].at(-1).textContent.includes("Notiz")`, 3000)) && toolRuns === runsBefore + 1,
            `${toolRuns - runsBefore} Ausführungen`);
          check(`${label}: nach der Entscheidung kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`freigabe-erledigt-${size.width}${suffix}`);
        } finally {
          await approvalDemo.stop();
          approval.dispose();
          setToolApprovalHandler(null);
          setChoicesFileForTests(null);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Merk-Vorschlag im Web-Gespräch (Issue #117) je 1280 und 390 px, hell und
 * (mit --screenshots) dunkel: ein Turn mit fremden Inhalten (WebFetch) über
 * den echten Web-Chat (createBotChat, Attrappe statt Claude) und das echte
 * Tor (processTurnIntents); der Vorschlag kommt über das Register
 * (createReviewNotifier) nach der Antwort ins Web-Gespräch, die Kopie für den
 * Direktchat wird nur mitgeschrieben. 1280 px: „Übernehmen“ im Browser;
 * 390 px: „Übernehmen“ in Telegram (über das Register). Danach Erledigt-Zeile
 * und Ergebnis-Meldung, die Einträge genau einmal im Gedächtnis (Attrappe).
 */
async function reviewChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  const schemes = shots ? ["light", "dark"] : ["light"];
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const dir = await mkdtemp(join(tmpdir(), "tybo-review-"));
  const reviewBox = `[...document.querySelectorAll(".choice")].at(-1)`;
  const reviewStatus = `(${reviewBox}?.querySelector(".choice-status")?.textContent || "")`;
  const lastText = `([...document.querySelectorAll(".msg")].at(-1)?.textContent || "")`;
  try {
    for (const scheme of schemes) {
      await emulateScheme(scheme as "light" | "dark");
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        const label = `Merk-Vorschlag ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        setChoicesFileForTests(join(dir, `choices-${size.width}-${scheme}.json`));
        setPendingReviewsFileForTests(join(dir, `pending-${size.width}-${scheme}.json`));
        const applied: string[] = [];
        const copies: { id: string; text: string }[] = [];
        let demo: Awaited<ReturnType<typeof startDemoServer>> | null = null;
        const postWeb = async (conversationId: string, post: { text: string; kind?: "notice"; source?: string; choiceId?: string }) =>
          demo ? demo.server.postToConversation(conversationId, post) : false;
        const results = createReviewResults({
          decideReview: (action, reviewId) =>
            decideReview(action, reviewId, {
              takePendingReview,
              processIntents: async text => {
                applied.push(text);
                return { goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: [text], factsRemoved: [] };
              },
            }),
          createRoutine: async () => ({ text: "" }),
          sendAndRecord: async () => ({ sent: true, recorded: true }) as any,
          sendTelegram: async () => {},
          saveMessage: async () => {},
          postWeb,
          dmChatId: () => "4711",
          log: () => {},
        });
        const offDecided = onChoiceDecided("review", results.handler);
        setReviewNotifier(createReviewNotifier({
          sendChoice: async choice => {
            copies.push({ id: choice.id, text: choice.text });
            return { sent: true };
          },
          postWeb,
          log: () => {},
        }));
        const chat = createBotChat({
          runStreamingTurn: async o => {
            o.onTools?.({ uses: [{ name: "WebFetch" }], cwd: dir });
            return "Laut der Seite trinkst du deinen Kaffee schwarz, ohne Zucker. [REMEMBER: Alex trinkt Kaffee schwarz, ohne Zucker]";
          },
          saveMessage: async () => true,
          processIntents: (text, turn) => processTurnIntents(text, turn.tools, turn, { projectRoot: dir, dmChatId: () => "4711", log: () => {} }),
          abortEngineCalls: key => abortExecutions(key),
          isShuttingDown: () => false,
          scheduleRestartCheck: () => {},
          log: () => {},
        });
        const port = createChoicePort({
          register: { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange },
          userId: "4711",
          groupId: () => DEMO_GROUP_ID,
          log: () => {},
        });
        demo = await startDemoServer(
          { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
          { chat, choices: { ...port, decideInTelegram: (id, key) => decideChoice(id, key, "telegram") }, log: () => {} }
        );
        try {
          const url = `${demo.server.url}/`;
          await goto(url);
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
          await goto(url);
          await waitFor(`!document.getElementById("input").disabled && document.querySelectorAll(".msg").length > 0`);
          await typeAndEnter("Lies die Seite und merk dir, wie ich Kaffee trinke");
          check(`${label}: Turn fertig, Antwort da`, await turnDone());
          check(`${label}: Vorschlag unter der Antwort, Absender „Vorschlag“, Knöpfe Übernehmen und Verwerfen`,
            await waitFor(`${reviewBox} && ${reviewBox}.closest(".msg") === [...document.querySelectorAll(".msg")].at(-1) && [...${reviewBox}.querySelectorAll(".choice-button")].map(b => b.textContent).join(",") === "Übernehmen,Verwerfen" && ${lastText}.includes("Vorschlag") && ${lastText}.includes("Fakt merken: Alex trinkt Kaffee schwarz")`, 5000),
            await js<string>(lastText));
          check(`${label}: nichts gespeichert, bevor entschieden ist`, applied.length === 0);
          check(`${label}: Kopie im Direktchat mit Hinweis auf das Web-Gespräch`,
            copies.length === 1 && copies[0].text.includes("(Web-Gespräch)"), copies[0]?.text.split("\n")[0]);
          check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          if (size.mobile) {
            const h = await js<number>(`Math.min(...[...${reviewBox}.querySelectorAll(".choice-button")].map(b => b.getBoundingClientRect().height))`);
            check(`${label}: Knöpfe mit 44 px Tippfläche`, h >= 44, `${h} px`);
          }
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`merkvorschlag-offen-${size.width}${suffix}`);
          if (size.mobile) {
            await decideChoice(copies[0].id, "ok", "telegram");
            check(`${label}: Übernehmen in Telegram erscheint als „Erledigt: Übernehmen · in Telegram“`,
              await waitFor(`[...document.querySelectorAll(".choice-status")].some(e => e.textContent.startsWith("Erledigt: Übernehmen · in Telegram · "))`, 3000));
          } else {
            await js(`${reviewBox}.querySelector(".choice-button").click()`);
            check(`${label}: Klick im Browser: „Erledigt: Übernehmen · im Browser“, Knöpfe weg`,
              await waitFor(`[...document.querySelectorAll(".choice-status")].some(e => e.textContent.startsWith("Erledigt: Übernehmen · im Browser · ")) && !document.querySelector(".choice .choice-button")`, 3000));
          }
          check(`${label}: Ergebnis „Übernommen“ als Meldung im Web-Gespräch`,
            await waitFor(`${lastText}.includes("Übernommen: 1 Fakt(en), 0 Ziel(e).")`, 3000), await js<string>(lastText));
          check(`${label}: Einträge genau einmal geschrieben`, applied.length === 1 && applied[0].includes("Kaffee schwarz"), `${applied.length}x`);
          check(`${label}: nach der Entscheidung kein seitliches Scrollen`, await noHorizontalScroll(size.width));
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`merkvorschlag-uebernommen-${size.width}${suffix}`);
        } finally {
          await demo.stop();
          offDecided();
          setReviewNotifier(null);
          setChoicesFileForTests(null);
          setPendingReviewsFileForTests(null);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function screenshots() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp("Emulation.setEmitTouchEventsForMouse", { enabled: false });
  async function shoot(name: string) {
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const sizes = [
    { width: 390, height: 844, mobile: true },
    { width: 1280, height: 800, mobile: false },
  ];
  // Frische Demo je Aufnahme-Reihe, damit keine Nachrichten aus den Prüfungen auftauchen;
  // langsame Attrappe, damit der laufende Turn im Bild bleibt
  const freshDemo = () =>
    startDemoServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      { chat: createFakeChat({ delayMs: 300, stepMs: 4000 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 4000 }), log: () => {} }
    );
  const shotDemo = await freshDemo();
  try {
    for (const scheme of ["light", "dark"]) {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of sizes) {
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await goto(`${base}/login`);
        await waitFor(`document.getElementById("password")`);
        await shoot(`login-${size.width}${suffix}`);
        await goto(`${shotDemo.server.url}/`);
        await waitFor(`document.querySelectorAll(".msg").length === 6 && document.getElementById("activity").hidden`);
        await shoot(`chat-${size.width}${suffix}`);
        // Tabelle und Codeblock der Beispielantwort
        await js(`(() => { const l = document.getElementById("chat-log"); const t = document.querySelector(".msg-assistant table");
          l.scrollTop = t.getBoundingClientRect().top - l.getBoundingClientRect().top + l.scrollTop - 90; })()`);
        await shoot(`chat-${size.width}-tabelle${suffix}`);
        if (size.mobile) {
          // Schublade mit der Gesprächsliste (Handy)
          await js(`document.getElementById("menu").click()`);
          await Bun.sleep(400);
          await shoot(`chat-${size.width}-schublade${suffix}`);
          await js(`document.getElementById("scrim").click()`);
          await Bun.sleep(400);
        }
        // Telegram-Topic mit Verlauf (Issue #18)
        await js(`document.querySelector('.conversation[data-id="topic-443"]').click()`);
        await waitFor(`document.getElementById("chat-title").textContent === "Recherche" && document.querySelectorAll(".msg").length === 4`);
        await shoot(`telegram-${size.width}${suffix}`);
        // Im Topic schreiben (Issue #19): laufender Turn mit Fortschritt
        await js(`(() => { const i = document.getElementById("input"); i.value = "Wie weit ist das Deck?"; i.dispatchEvent(new Event("input")); })()`);
        await js(`document.getElementById("send").click()`);
        await waitFor(`document.querySelectorAll(".msg").length === 5 && !document.getElementById("activity").hidden && document.querySelectorAll("#progress li").length > 0`);
        await shoot(`telegram-${size.width}-schreiben${suffix}`);
        await js(`document.getElementById("stop").click()`);
        await waitFor(`document.getElementById("activity").hidden`);
        // Direktchat oben: Knopf „Ältere Nachrichten laden"
        await js(`document.querySelector('.conversation[data-id="dm"]').click()`);
        await waitFor(`document.querySelectorAll(".msg").length === 50`);
        await js(`document.getElementById("chat-log").scrollTop = 0`);
        await shoot(`telegram-${size.width}-nachladen${suffix}`);
        if (size.mobile) {
          // Schublade mit Direktchat, Topics (ältere aufgeklappt) und Web-Gesprächen
          await js(`document.getElementById("menu").click()`);
          await js(`document.getElementById("older-toggle").click()`);
          await Bun.sleep(400);
          await shoot(`telegram-${size.width}-schublade${suffix}`);
          await js(`document.getElementById("older-toggle").click()`);
          await js(`document.getElementById("scrim").click()`);
          await Bun.sleep(400);
        }
        // Nächste Aufnahme wieder mit dem jüngsten Web-Gespräch
        await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
      }
    }
    // Nachrichten aus Telegram live (Issue #20): offenes Topic und Neu-Punkt
    for (const scheme of ["light", "dark"]) {
      await emulateScheme(scheme as "light" | "dark");
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of sizes) {
        const liveDemo = await freshDemo();
        try {
          await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
          await goto(`${liveDemo.server.url}/`);
          await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, "topic-443")`);
          await goto(`${liveDemo.server.url}/`);
          await waitFor(`document.getElementById("chat-title").textContent === "Recherche" && document.querySelectorAll(".msg").length === 4`);
          await Bun.sleep(400);
          liveDemo.receiveTelegram("topic-443", "user", "Und was kostet Netcup im Vergleich?");
          liveDemo.receiveTelegram("topic-443", "assistant", "Bei **Netcup** gibt es 2 vCPU und 4 GB ab etwa 5 Euro.", "research");
          liveDemo.receiveTelegram("topic-31", "user", "Newsletter doch monatlich starten?");
          await waitFor(`document.querySelectorAll(".msg").length === 6 && document.querySelector(".unread-dot")`);
          await js(`document.getElementById("chat-log").scrollTop = document.getElementById("chat-log").scrollHeight`);
          await shoot(`live-${size.width}${suffix}`);
          if (size.mobile) {
            await js(`document.getElementById("menu").click()`);
            await Bun.sleep(400);
            await shoot(`live-${size.width}-schublade${suffix}`);
          }
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
        } finally {
          await liveDemo.stop();
        }
      }
    }
    // Web-Gespräche verwalten (Issue #21): Agentenauswahl, Umbenennen, Rückfrage beim Löschen
    for (const scheme of ["light", "dark"]) {
      await emulateScheme(scheme as "light" | "dark");
      const suffix = scheme === "dark" ? "-dunkel" : "";
      for (const size of sizes) {
        const manageDemo = await freshDemo();
        try {
          await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
          await goto(`${manageDemo.server.url}/`);
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
          await goto(`${manageDemo.server.url}/`);
          await waitFor(`document.querySelectorAll(".msg").length === 6 && document.getElementById("activity").hidden`);
          if (size.mobile) {
            await js(`document.getElementById("menu").click()`);
            await Bun.sleep(400);
          }
          await js(`document.getElementById("new-chat").click()`);
          await waitFor(shown("agent-picker"));
          await pressKey("ArrowDown", "ArrowDown", 40);
          await shoot(`verwalten-${size.width}-auswahl${suffix}`);
          await js(`document.getElementById("new-chat").click()`);
          if (size.mobile) {
            await js(`document.getElementById("scrim").click()`);
            await Bun.sleep(400);
          }
          await js(`document.getElementById("chat-title").click()`);
          await waitFor(`document.activeElement?.id === "title-input"`);
          await js(`document.getElementById("title-input").value = "Hosting-Kosten 2026"`);
          await shoot(`verwalten-${size.width}-umbenennen${suffix}`);
          await pressKey("Escape", "Escape", 27);
          if (size.mobile) {
            // Am Handy: Menü am Eintrag in der Schublade
            await js(`document.getElementById("menu").click()`);
            await Bun.sleep(400);
            await js(`document.querySelectorAll("#conversation-list .entry-menu")[1].click()`);
            await js(`[...document.querySelectorAll("#conversation-list .entry-actions button")].find(b => b.textContent === "Löschen").click()`);
          } else {
            await js(`document.getElementById("conversation-menu").click()`);
            await js(`[...document.querySelectorAll("#conversation-actions button")].find(b => b.textContent === "Löschen").click()`);
          }
          await waitFor(`document.querySelector(".actions-question")`);
          await shoot(`verwalten-${size.width}-loeschen${suffix}`);
          await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
        } finally {
          await manageDemo.stop();
        }
      }
    }
    // Eigene Wahl gegen die Geräteeinstellung: System hell mit „Dunkel",
    // System dunkel mit „Hell"; am Handy mit offener Schublade (Schalter sichtbar)
    for (const [scheme, choice, name] of [["light", "dark", "wahl-dunkel"], ["dark", "light", "wahl-hell"]] as const) {
      await emulateScheme(scheme);
      for (const size of sizes) {
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await goto(`${shotDemo.server.url}/`);
        await js(`localStorage.setItem("tybo-theme", ${JSON.stringify(choice)})`);
        await goto(`${shotDemo.server.url}/`);
        await waitFor(`document.querySelectorAll(".msg").length === 6 && document.getElementById("activity").hidden`);
        if (size.mobile) {
          await js(`document.getElementById("menu").click()`);
          await Bun.sleep(400);
          await shoot(`chat-${size.width}-schublade-${name}`);
          await js(`document.getElementById("scrim").click()`);
        } else {
          await shoot(`chat-${size.width}-${name}`);
        }
      }
    }
    await js(`localStorage.removeItem("tybo-theme")`);
  } finally {
    await shotDemo.stop();
  }
  // Laufender Turn mit Fortschritt und Hinweis, hell
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  for (const size of sizes) {
    const runDemo = await freshDemo();
    try {
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      await goto(`${runDemo.server.url}/`);
      await waitFor(`document.getElementById("activity").hidden && document.querySelectorAll(".msg").length === 6`);
      await js(`(() => { const i = document.getElementById("input"); i.value = "Wie wird das Wetter morgen?"; i.dispatchEvent(new Event("input")); document.getElementById("send").click(); })()`);
      await waitFor(`document.querySelector("#progress .step-notice")`, 10000);
      await shoot(`chat-${size.width}-laeuft`);
      // Statuszeile aufgeklappt: einzelne Schritte
      await js(`document.getElementById("activity-toggle").click()`);
      await shoot(`chat-${size.width}-schritte`);
      await js(`document.getElementById("stop").click()`);
      await turnDone();
    } finally {
      await runDemo.stop();
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });
}


/**
 * Attrappe von Cloudflare Access vor einer echten WebUI (Issue #224) auf
 * 127.0.0.1:port: Ohne Cookie CF_Authorization leitet sie jede Anfrage auf
 * /cdn-cgi/access/login um. Das Formular dort setzt das Cookie (ein mit einem
 * Test-Schlüssel signierter Access-Nachweis) und leitet zurück. Mit Cookie
 * reicht sie die Anfrage wie cloudflared weiter (Host und Origin der
 * öffentlichen Adresse, CF-Connecting-IP, cf-access-jwt-assertion) an einen
 * WebUI-Server mit Passwort und Access-Prüfung. Secure fällt aus Set-Cookie
 * heraus, weil der Browser hier http spricht.
 */
async function startAccessGate(port: number) {
  const PUBLIC = "https://app.tybo.ai";
  const team = "browsercheck";
  const aud = "c".repeat(64);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "browsercheck" };
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const s = Math.floor(Date.now() / 1000);
  const data = `${part({ alg: "RS256", kid: "browsercheck" })}.${part({ aud: [aud], iss: accessIssuer(team), exp: s + 3600, nbf: s, iat: s })}`;
  const jwt = `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
  const tmp = await mkdtemp(join(tmpdir(), "tybo-web-access-"));
  const store = new ConversationStore({ dir: join(tmp, "web") });
  await store.load();
  await store.createConversation("general");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], publicOrigin: PUBLIC, access: { team, aud } },
    {
      sessionFile: join(tmp, "sessions.json"),
      conversationStore: store,
      chat: createFakeChat({ delayMs: 300, stepMs: 100 }),
      accessCerts: async () => ({ keys: [jwk] }),
      log: () => {},
    }
  );
  const counts = { granted: 0, tunneled: 0, denied: 0 };
  const cookieValue = (req: Request, name: string) => {
    for (const piece of (req.headers.get("cookie") ?? "").split(";")) {
      const i = piece.indexOf("=");
      if (i > 0 && piece.slice(0, i).trim() === name) return piece.slice(i + 1).trim();
    }
    return null;
  };
  const gate = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const back = url.searchParams.get("redirect_url") ?? "/";
      const safeBack = back.startsWith("/") && !back.startsWith("//") ? back : "/";
      if (url.pathname === "/cdn-cgi/access/login") {
        return new Response(
          `<!doctype html><title>Access</title><form id="access-login" method="get" action="/cdn-cgi/access/callback">` +
            `<input type="hidden" name="redirect_url" value="${safeBack.replace(/[&"<>]/g, "")}"><button>Code bestätigen</button></form>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      if (url.pathname === "/cdn-cgi/access/callback") {
        counts.granted++;
        return new Response(null, {
          status: 302,
          headers: { Location: safeBack, "Set-Cookie": `CF_Authorization=${jwt}; Path=/; HttpOnly; SameSite=Lax` },
        });
      }
      if (cookieValue(req, "CF_Authorization") !== jwt) {
        return new Response(null, {
          status: 302,
          headers: { Location: `/cdn-cgi/access/login?redirect_url=${encodeURIComponent(url.pathname + url.search)}` },
        });
      }
      const headers = new Headers(req.headers);
      headers.set("host", "app.tybo.ai");
      if (headers.has("origin")) headers.set("origin", PUBLIC);
      headers.set("cf-connecting-ip", "203.0.113.7");
      headers.set("cf-access-jwt-assertion", jwt);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      const res = await fetch(`${server.url}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
      counts.tunneled++;
      if (res.status === 403) counts.denied++;
      const out = new Headers(res.headers);
      const cookie = out.get("set-cookie");
      if (cookie) out.set("set-cookie", cookie.replace(/;\s*Secure/i, ""));
      const location = out.get("location");
      if (location?.startsWith(PUBLIC)) out.set("location", location.slice(PUBLIC.length) || "/");
      return new Response(res.body, { status: res.status, headers: out });
    },
  });
  return {
    granted: () => counts.granted,
    tunneled: () => counts.tunneled,
    denied: () => counts.denied,
    async stop() {
      gate.stop(true);
      await server.stop();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Installierbare Web-App (Issue #224) über http://127.0.0.1 (sicherer
 * Kontext wie localhost): Manifest ohne Fehler, Chrome meldet die Seite als
 * installierbar, der Service Worker ist aktiv und hat nur die Offline-Dateien
 * im Cache. Danach „tybo nicht erreichbar": Server aus (Netzfehler) und eine
 * Attrappe auf demselben Port, die mit 502/503/504/520 bis 530 antwortet
 * (Cloudflare-Tunnel weg), zeigen offline.html mit Gestaltung und gespeicherter
 * Hell/Dunkel-Wahl; „Erneut versuchen" holt die WebUI zurück, sobald der Server
 * wieder läuft. Abgelaufenes Access (startAccessGate): die Weiterleitung kommt
 * unverändert an, nach der Anmeldung bei Access führt der Weg durch das
 * WebUI-Login zurück in den Chat, alles unter dem aktiven Worker. Screenshots (mit --screenshots)
 * von Login, Chat und Offline-Seite je 390/1280, hell und dunkel.
 */
async function installChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const start = (port: number) =>
    startDemoServer(
      { host: "127.0.0.1", port, password: PASSWORD, allowedHosts: [] },
      { chat: createFakeChat({ delayMs: 300, stepMs: 100 }), telegramChat: createFakeChat({ delayMs: 300, stepMs: 100 }), log: () => {} }
    );
  /** Attrappe auf demselben Port: Navigationen bekommen einen Status wie von Cloudflare */
  const stub = (port: number, respond: (path: string) => Response) =>
    Bun.serve({ hostname: "127.0.0.1", port, fetch: req => respond(new URL(req.url).pathname) });
  const offlineShown = () => waitFor(`document.querySelector("body.offline") && document.getElementById("retry")`, 8000);
  const sizes = [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }];

  let current = await start(0);
  const port = Number(new URL(current.server.url).port);
  const origin = `http://127.0.0.1:${port}`;
  try {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
    await goto(`${origin}/`);
    await waitFor(`document.querySelectorAll(".msg").length > 0`);
    check("Web-App: sicherer Kontext über 127.0.0.1", await js<boolean>(`window.isSecureContext`));
    let active = false;
    for (let i = 0; i < 100 && !active; i++) {
      active = await js<boolean>(`navigator.serviceWorker.getRegistration().then(r => !!(r && r.active && r.active.state === "activated" && r.scope === location.origin + "/"))`);
      if (!active) await Bun.sleep(100);
    }
    check("Web-App: Service Worker aktiv, Scope /", active);
    const script = await js<string>(`navigator.serviceWorker.getRegistration().then(r => r.active.scriptURL)`);
    check("Web-App: Worker ist /sw.js", script === `${origin}/sw.js`, script);
    const manifest = await cdp("Page.getAppManifest");
    check("Web-App: Manifest ohne Fehler", manifest.url === `${origin}/manifest.webmanifest` && (manifest.errors ?? []).length === 0,
      JSON.stringify(manifest.errors ?? []));
    const parsed = JSON.parse(manifest.data || "{}");
    check("Web-App: Manifest-Name aus BRAND, standalone", parsed.name === BRAND.name && parsed.short_name === BRAND.name && parsed.display === "standalone");
    let installErrors: any[] = ["nicht geprüft"];
    for (let i = 0; i < 20; i++) {
      installErrors = (await cdp("Page.getInstallabilityErrors")).installabilityErrors ?? [];
      if (!installErrors.length) break;
      await Bun.sleep(250);
    }
    check("Web-App: Chrome meldet die Seite als installierbar", installErrors.length === 0, JSON.stringify(installErrors));
    const cached = await js<{ names: string[]; urls: string[] }>(`caches.keys().then(async names => ({ names, urls: (await Promise.all(names.map(n => caches.open(n).then(c => c.keys())))).flat().map(r => new URL(r.url).pathname).sort() }))`);
    const version = await js<string>(`document.getElementById("ui-version").content`);
    check("Web-App: ein Cache mit der Oberflächen-Version, nur Offline-Dateien",
      JSON.stringify(cached.names) === JSON.stringify([`${BRAND.cli}-offline-${version}`])
        && JSON.stringify(cached.urls) === JSON.stringify(["/favicon.svg", "/offline.html", "/offline.js", "/style.css", "/theme.js"]),
      JSON.stringify(cached));

    // --- Chat-Screenshots (installierbare Seite) -----------------------------
    for (const scheme of ["light", "dark"] as const) {
      await emulateScheme(scheme);
      for (const size of sizes) {
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await goto(`${origin}/`);
        await waitFor(`document.querySelectorAll(".msg").length > 0`);
        await shoot(`web-app-chat-${size.width}${scheme === "dark" ? "-dunkel" : ""}`);
      }
    }

    // --- Server aus: Netzfehler ---------------------------------------------
    await current.stop();
    for (const scheme of ["light", "dark"] as const) {
      await emulateScheme(scheme);
      for (const size of sizes) {
        const label = `Offline ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await goto(`${origin}/`);
        const shown = await offlineShown();
        check(`${label}: Netzfehler zeigt „nicht erreichbar"`, shown && (await js<string>(`document.querySelector("h1").textContent`)) === `${BRAND.name} nicht erreichbar`);
        check(`${label}: Gestaltung aus dem Cache`, (await bodyBg()) === (scheme === "dark" ? DARK_BG : LIGHT_BG)
          && (await js<string>(`getComputedStyle(document.getElementById("retry")).borderRadius`)) !== "0px", await bodyBg());
        check(`${label}: kein waagrechtes Scrollen`, await js<boolean>(`document.documentElement.scrollWidth <= ${size.width}`));
        await shoot(`web-app-offline-${size.width}${scheme === "dark" ? "-dunkel" : ""}`);
      }
    }
    // Gespeicherte Wahl gilt auch offline (theme.js aus dem Cache)
    await emulateScheme("light");
    await js(`localStorage.setItem("tybo-theme", "dark")`);
    await goto(`${origin}/`);
    await offlineShown();
    check("Offline: gespeicherte Wahl Dunkel bei hellem System", (await bodyBg()) === DARK_BG && (await themeAttr()) === "dark");
    await js(`localStorage.removeItem("tybo-theme")`);

    // --- Tunnel weg: Status wie von Cloudflare -------------------------------
    const statuses = [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530];
    const wrong: number[] = [];
    for (const status of statuses) {
      const fake = stub(port, () => new Response(`error code: ${status === 530 ? 1033 : status}`, { status }));
      try {
        await goto(`${origin}/`);
        if (!(await offlineShown())) wrong.push(status);
      } finally {
        fake.stop(true);
      }
    }
    check(`Offline: Status ${statuses[0]} bis ${statuses.at(-1)} zeigen die Offline-Seite`, wrong.length === 0, wrong.join(", "));
    const other = stub(port, () => new Response("Interner Fehler", { status: 500 }));
    try {
      await goto(`${origin}/`);
      await Bun.sleep(300);
      check("Offline: 500 geht unverändert durch", !(await js<boolean>(`!!document.querySelector("body.offline")`)) && (await js<string>(`document.body.textContent`)).includes("Interner Fehler"));
    } finally {
      other.stop(true);
    }

    // --- Access abgelaufen: Anmeldung bei Access, dann WebUI-Login -------------
    const access = await startAccessGate(port);
    try {
      await goto(`${origin}/`);
      const landed = await waitFor(`location.pathname === "/cdn-cgi/access/login" && document.getElementById("access-login")`);
      check("Access: Weiterleitung kommt unverändert beim Browser an", landed, await js<string>(`location.href`));
      check("Access: die Anmeldeseite läuft unter dem aktiven Worker",
        await js<boolean>(`!!navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL === location.origin + "/sw.js"`));
      await js(`document.getElementById("access-login").requestSubmit()`);
      const toLogin = await waitFor(`location.pathname === "/login" && document.getElementById("login-form")`, 10000);
      check("Access: nach der Anmeldung zurück zur WebUI, dort das WebUI-Login", toLogin && access.granted() === 1, await js<string>(`location.href`));
      check("Access: WebUI-Login unter dem aktiven Worker, nicht die Offline-Seite",
        !!(await js<boolean>(`!!navigator.serviceWorker.controller && !document.querySelector("body.offline")`)));
      await js(`document.getElementById("password").value = ${JSON.stringify(PASSWORD)}`);
      await js(`document.getElementById("login-form").requestSubmit()`);
      const chat = await waitFor(`location.pathname === "/" && document.getElementById("chat-log") && document.getElementById("input") && !document.querySelector("body.offline")`, 10000);
      check("Access: nach dem WebUI-Login ist der Chat da", chat, await js<string>(`location.href`));
      check("Access: Chat mit Access-Nachweis über den Tunnel geladen", access.tunneled() > 0 && access.denied() === 0,
        JSON.stringify({ tunneled: access.tunneled(), denied: access.denied() }));
      check("Access: Chat läuft weiter unter dem aktiven Worker", await js<boolean>(`!!navigator.serviceWorker.controller`));
    } finally {
      await access.stop();
    }

    // --- Erneut versuchen / erneute Anmeldung: Server wieder da --------------
    await goto(`${origin}/`);
    await offlineShown();
    current = await start(port);
    await Bun.sleep(200);
    await js(`document.getElementById("retry").click()`);
    const back = await waitFor(`location.pathname === "/" && document.getElementById("chat-log") && document.querySelectorAll(".msg").length > 0`, 10000);
    check("Offline: „Erneut versuchen\" holt die WebUI zurück", back);
  } finally {
    await current.stop().catch(() => {});
    await cdp("Emulation.setEmulatedMedia", { features: [] });
  }

  // --- Login-Screenshots (Server mit Passwort, [::1]) ----------------------
  if (shots) {
    // Angemeldet leitet /login auf / um: Cookies kurz beiseite, danach zurück
    const { cookies } = await cdp("Network.getAllCookies");
    await cdp("Network.clearBrowserCookies");
    for (const scheme of ["light", "dark"] as const) {
      await emulateScheme(scheme);
      for (const size of sizes) {
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await goto(`${base}/login`);
        await waitFor(`document.getElementById("login-form")`);
        await shoot(`web-app-login-${size.width}${scheme === "dark" ? "-dunkel" : ""}`);
      }
    }
    await cdp("Network.setCookies", { cookies });
    await cdp("Emulation.setEmulatedMedia", { features: [] });
  }
}

/**
 * Benachrichtigungen (Issue #225) über http://127.0.0.1 (sicherer Kontext)
 * gegen eine Demo mit Push-Schlüsseln und einer fetch-Attrappe statt der
 * Push-Dienste. Notification, PushManager und das Abo des Browsers sind
 * Attrappen (pushMock), gesetzt vor jedem Laden und danach wieder entfernt.
 * Geprüft: Laden fragt keine Berechtigung, „An" fragt genau einmal und
 * abonniert mit dem öffentlichen Schlüssel des Servers, „Test senden" geht
 * mit vapid-Kopfzeile und aes128gcm an den Endpunkt, Umbenennen, andere
 * Geräte entfernen, „Aus" meldet beim Browser und beim Server ab, ein
 * anderswo entferntes Gerät wird beim nächsten Laden nicht wieder aktiv.
 * Erklärungen statt Schalter: Server ohne Schlüssel, kein sicherer Kontext,
 * iPhone im Browser, Browser ohne Push, Berechtigung blockiert. Screenshots
 * (mit --screenshots) aller Zustände je 390/1280, hell und dunkel.
 */
async function pushChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const sent: { url: string; headers: Record<string, string>; bytes: number }[] = [];
  let pushStatus = 201;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as Uint8Array | undefined;
    sent.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), bytes: body?.length ?? 0 });
    return new Response(null, { status: pushStatus });
  }) as typeof fetch;
  const vapid = await generateVapidKeys();
  const pushDemo = await startDemoServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { chat: createFakeChat(), telegramChat: createFakeChat(), log: () => {}, push: { keys: vapid, subject: DEFAULT_PUSH_SUBJECT, fetch: fakeFetch } }
  );
  const origin = pushDemo.server.url.replace(/\/$/, "");
  const tab = "#/einstellungen/benachrichtigungen";
  /** Abo-Schlüssel wie aus einem echten Browser: P-256-Punkt und 16 Bytes */
  async function browserKeys() {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    return { p256dh: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
  }
  const own = { endpoint: "https://fcm.googleapis.com/fcm/send/browser-check-dieses-geraet", ...(await browserKeys()) };
  type Mock = { secure?: boolean; ios?: boolean; noPush?: boolean; permission?: "default" | "granted" | "denied" };
  async function pushMock(mock: Mock): Promise<string> {
    const cfg = JSON.stringify({ ...mock, endpoint: own.endpoint, p256dh: own.p256dh, auth: own.auth });
    const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const cfg = ${cfg};
      window.__push = { requested: 0, subscribed: [], unsubscribed: 0 };
      if (cfg.secure === false) Object.defineProperty(window, "isSecureContext", { get: () => false });
      if (cfg.ios) Object.defineProperty(Navigator.prototype, "userAgent", { get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
      if (cfg.noPush) delete window.PushManager;
      let permission = cfg.permission || "default";
      function FakeNotification() {}
      Object.defineProperty(FakeNotification, "permission", { get: () => permission });
      FakeNotification.requestPermission = async () => { window.__push.requested++; permission = "granted"; return permission; };
      window.Notification = FakeNotification;
      const KEY = "browser-check-push-abo";
      const sub = () => ({
        endpoint: cfg.endpoint,
        toJSON: () => ({ endpoint: cfg.endpoint, expirationTime: null, keys: { p256dh: cfg.p256dh, auth: cfg.auth } }),
        unsubscribe: async () => { window.__push.unsubscribed++; sessionStorage.removeItem(KEY); return true; },
      });
      const pushManager = {
        getSubscription: async () => (sessionStorage.getItem(KEY) ? sub() : null),
        subscribe: async options => { window.__push.subscribed.push(Array.from(new Uint8Array(options.applicationServerKey))); sessionStorage.setItem(KEY, "1"); return sub(); },
      };
      const registration = { scope: location.origin + "/", pushManager };
      if (navigator.serviceWorker && !cfg.noPush) {
        navigator.serviceWorker.getRegistration = async () => registration;
        Object.defineProperty(navigator.serviceWorker, "ready", { get: () => Promise.resolve(registration) });
      }
    })()` });
    return identifier;
  }
  const unmock = (identifier: string) => cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  const pushState = () => js<string | null>(`document.querySelector("#settings [data-push-state]")?.dataset.pushState ?? null`);
  const panelText = () => js<string>(`document.getElementById("settings").innerText`);
  async function openPush(base: string) {
    // Erst weg von der Seite: sonst wäre es nur ein Wechsel des Ankers, ohne die Attrappe neu zu laden
    await goto("about:blank");
    await goto(`${base}/${tab}`);
    return waitFor(`document.querySelector("#settings [data-push-state]")`);
  }
  const serverPush = () => js<any>(`fetch("/api/push").then(r => r.json())`);
  const sizes = [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }];
  /** prepare: nach dem Laden, vor dem Bild (etwa die Rückfrage beim Entfernen öffnen) */
  async function shootAll(name: string, base: string, ready: string, prepare?: () => Promise<unknown>) {
    for (const scheme of ["light", "dark"] as const) {
      await emulateScheme(scheme);
      for (const size of sizes) {
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await openPush(base);
        await waitFor(ready);
        if (prepare) await prepare();
        check(`Benachrichtigungen ${name} ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}: kein waagrechtes Scrollen`,
          await js<boolean>(`document.documentElement.scrollWidth <= ${size.width}`));
        await shoot(`einstellungen-benachrichtigungen-${name}-${size.width}${scheme === "dark" ? "-dunkel" : ""}`);
      }
    }
    await emulateScheme("light");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 });
  }
  const clickText = (text: string, scope = "#settings") =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (b) b.click(); return !!b; })()`);

  try {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 });
    await emulateScheme("light");

    // --- Server ohne Push-Schlüssel (Standard-Demo) -----------------------------
    let id = await pushMock({});
    check("Push: Reiter erreichbar unter #/einstellungen/benachrichtigungen", await openPush(demo.server.url.replace(/\/$/, "")));
    check("Push: Reiter „Benachrichtigungen“ ausgewählt",
      await js<boolean>(`[...document.querySelectorAll(".settings-tab")].some(t => t.textContent === "Benachrichtigungen" && t.getAttribute("aria-selected") === "true")`));
    check("Push ohne Schlüssel: Erklärung des Servers, kein Schalter, keine Geräteliste",
      (await pushState()) === "server-off" && !(await js<boolean>(`!!document.querySelector("#settings [role=radiogroup][aria-labelledby=push-switch-label]")`))
        && !(await panelText()).includes("Andere Geräte"), await panelText());
    await shootAll("nicht-eingerichtet", demo.server.url.replace(/\/$/, ""), `document.querySelector("#settings [data-push-state]")`);
    await unmock(id);

    // --- Erklärungen statt Schalter ---------------------------------------------
    const explained: [string, Mock, string, string][] = [
      ["insecure", { secure: false }, "unsicher", "https://"],
      ["ios-install", { ios: true }, "iphone", "Zum Home-Bildschirm"],
      ["unsupported", { noPush: true }, "nicht-moeglich", "keine Benachrichtigungen empfangen"],
      ["denied", { permission: "denied" }, "blockiert", "Danach diese Seite neu laden"],
    ];
    for (const [state, mock, name, text] of explained) {
      id = await pushMock(mock);
      await openPush(origin);
      check(`Push ${state}: Erklärung statt Schalter`,
        (await pushState()) === state && (await panelText()).includes(text) && !(await js<boolean>(`!!document.querySelector("[aria-labelledby=push-switch-label]")`)),
        `${await pushState()}: ${await panelText()}`);
      check(`Push ${state}: Laden fragt keine Berechtigung`, (await js<number>(`window.__push.requested`)) === 0);
      await shootAll(name, origin, `document.querySelector("#settings [data-push-state]")`);
      await unmock(id);
    }

    // --- Aus, Einschalten, Test, Umbenennen, andere Geräte, Ausschalten ---------
    id = await pushMock({});
    await openPush(origin);
    check("Push aus: Schalter An / Aus, Zustand „Aus“ in Klartext",
      (await pushState()) === "off" && (await panelText()).includes("Aus: Dieses Gerät bekommt keine Benachrichtigungen."));
    check("Push aus: Laden fragt keine Berechtigung", (await js<number>(`window.__push.requested`)) === 0);
    await shootAll("aus", origin, `document.querySelector("#settings [data-push-state=off]")`);

    await openPush(origin);
    await clickText("An");
    check("Push an: nach dem Tipp an", await waitFor(`document.querySelector("#settings [data-push-state=on]")`));
    check("Push an: Berechtigung genau einmal gefragt", (await js<number>(`window.__push.requested`)) === 1);
    const subscribedKey = await js<number[][]>(`window.__push.subscribed`);
    check("Push an: abonniert mit dem öffentlichen Schlüssel des Servers",
      subscribedKey.length === 1 && toBase64Url(new Uint8Array(subscribedKey[0])) === vapid.publicKey);
    const afterOn = await serverPush();
    const deviceId = await js<string | null>(`localStorage.getItem("tybo-push-device")`);
    check("Push an: Server kennt das Gerät, Browser merkt sich seine Kennung",
      afterOn.devices.length === 1 && afterOn.devices[0].id === deviceId && afterOn.devices[0].name === "Mac · Chrome", JSON.stringify(afterOn.devices));
    check("Push an: Antwort ohne Endpunkt und privaten Schlüssel",
      !JSON.stringify(afterOn).includes(own.endpoint) && !JSON.stringify(afterOn).includes(vapid.privateKey));

    await clickText("Test senden");
    check("Test senden: Meldung „Test gesendet“", await waitFor(`document.getElementById("settings").innerText.includes("Test gesendet.")`));
    const request = sent.at(-1);
    check("Test senden: an den Endpunkt mit vapid t=…, k=…, aes128gcm und TTL",
      !!request && request.url === own.endpoint && request.headers.authorization?.startsWith("vapid t=") && request.headers.authorization.endsWith(`, k=${vapid.publicKey}`)
        && request.headers["content-encoding"] === "aes128gcm" && /^\d+$/.test(request.headers.ttl ?? "") && request.bytes > 86,
      JSON.stringify({ ...request, headers: { ...request?.headers, authorization: request?.headers.authorization?.slice(0, 12) } }));
    check("Test senden: zuletzt erreicht steht da", await waitFor(`document.querySelector("#settings [data-device=this]")?.innerText.includes("zuletzt erreicht")`)
      || (await openPush(origin) && await waitFor(`document.querySelector("#settings [data-device=this]")?.innerText.includes("zuletzt erreicht")`)));

    // Umbenennen
    await openPush(origin);
    await waitFor(`document.querySelector("#settings [data-device=this]")`);
    await clickText("Umbenennen");
    await waitFor(`document.getElementById("push-device-name")`);
    await js(`(() => { const i = document.getElementById("push-device-name"); i.value = "Büro-Rechner"; i.dispatchEvent(new Event("input")); })()`);
    await clickText("Speichern");
    check("Umbenennen: neuer Name sichtbar und beim Server",
      (await waitFor(`document.querySelector("#settings [data-device=this]")?.innerText.includes("Büro-Rechner")`)) && (await serverPush()).devices[0].name === "Büro-Rechner");

    // Zwei weitere Geräte (wie von einem Handy angemeldet)
    for (const [suffix, ua] of [["handy", "iPhone"], ["tablet", "Android"]] as const) {
      const other = { endpoint: `https://fcm.googleapis.com/fcm/send/browser-check-${suffix}`, ...(await browserKeys()) };
      const status = await js<number>(`fetch("/api/push/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: ${JSON.stringify({ endpoint: other.endpoint, keys: { p256dh: other.p256dh, auth: other.auth } })} }) }).then(r => r.status)`);
      check(`anderes Gerät (${ua}) angemeldet`, status === 201, String(status));
    }
    // Was sich meldet (Issue #226): vier Schalter, Standard ohne Telegram-Angabe: Meldungen und Inhalt aus
    await openPush(origin);
    const settingChecked = () => js<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll("#settings [data-push-setting]")].map(r => [r.dataset.pushSetting, r.querySelector("[role=radio][aria-checked=true]")?.textContent]))`);
    check("Was sich meldet: vier Schalter mit Standard (Antworten, Rückfragen an; Meldungen, Inhalt aus)",
      (await waitFor(`document.querySelectorAll("#settings [data-push-setting]").length === 4`))
        && JSON.stringify(await settingChecked()) === JSON.stringify({ replies: "An", choices: "An", notices: "Aus", preview: "Aus" }),
      JSON.stringify(await settingChecked()));
    await js(`[...document.querySelectorAll("#settings [data-push-setting=notices] [role=radio]")].find(b => b.textContent === "An").click()`);
    check("Was sich meldet: Meldungen an, sofort beim Server gespeichert",
      (await waitFor(`document.querySelector("#settings [data-push-setting=notices] [role=radio][aria-checked=true]")?.textContent === "An"`))
        && (await serverPush()).devices.find((d: any) => d.id === deviceId)?.settings?.notices === true);
    await js(`[...document.querySelectorAll("#settings [data-push-setting=notices] [role=radio]")].find(b => b.textContent === "Aus").click()`);
    await waitFor(`document.querySelector("#settings [data-push-setting=notices] [role=radio][aria-checked=true]")?.textContent === "Aus"`);
    await shootAll("kategorien", origin, `document.querySelectorAll("#settings [data-push-setting]").length === 4`,
      () => js(`document.querySelector("#settings .settings-push-categories").scrollIntoView({ block: "start" })`));

    await openPush(origin);
    check("Andere Geräte: zwei Einträge mit Entfernen, dieses Gerät nicht darunter",
      await waitFor(`document.querySelectorAll("#settings [data-device]:not([data-device=this])").length === 2`));
    await shootAll("an", origin, `document.querySelectorAll("#settings [data-device]").length === 3`);

    await openPush(origin);
    await waitFor(`document.querySelectorAll("#settings [data-device]:not([data-device=this])").length === 2`);
    await js(`[...document.querySelectorAll("#settings [data-device]:not([data-device=this]) button")].find(b => b.textContent === "Entfernen").click()`);
    check("Entfernen fragt nach, Fokus auf Abbrechen",
      (await waitFor(`document.querySelector("#settings .settings-device-actions")`)) && (await js<string>(`document.activeElement.textContent`)) === "Abbrechen");
    const askRemove = async () => {
      await js(`[...document.querySelectorAll("#settings [data-device]:not([data-device=this]) button")].find(b => b.textContent === "Entfernen").click()`);
      return waitFor(`document.querySelector("#settings .settings-device-actions")`);
    };
    await shootAll("entfernen", origin, `document.querySelectorAll("#settings [data-device]").length === 3`, askRemove);
    await openPush(origin);
    await waitFor(`document.querySelectorAll("#settings [data-device]").length === 3`);
    await js(`[...document.querySelectorAll("#settings [data-device]:not([data-device=this]) button")].find(b => b.textContent === "Entfernen").click()`);
    await waitFor(`document.querySelector("#settings .settings-device-confirm")`);
    await js(`document.querySelector("#settings .settings-device-confirm").click()`);
    check("Entfernen: ein anderes Gerät weniger, auch beim Server",
      (await waitFor(`document.querySelectorAll("#settings [data-device]:not([data-device=this])").length === 1`)) && (await serverPush()).devices.length === 2);

    // Ausschalten
    const unsubscribedBefore = await js<number>(`window.__push.unsubscribed`);
    await clickText("Aus");
    check("Aus: Zustand aus, beim Browser abgemeldet, Server kennt das Gerät nicht mehr",
      (await waitFor(`document.querySelector("#settings [data-push-state=off]")`)) && (await js<number>(`window.__push.unsubscribed`)) === unsubscribedBefore + 1
        && !(await serverPush()).devices.some((d: any) => d.id === deviceId) && (await js<string | null>(`localStorage.getItem("tybo-push-device")`)) === null);

    // Anderswo entfernt: beim nächsten Laden nicht still wieder aktiv
    await clickText("An");
    await waitFor(`document.querySelector("#settings [data-push-state=on]")`);
    const again = await js<string>(`localStorage.getItem("tybo-push-device")`);
    await js(`fetch("/api/push/subscriptions/${again}", { method: "DELETE" })`);
    await openPush(origin);
    check("anderswo entfernt: beim Laden aus, Hinweis, beim Browser abgemeldet, nicht neu angelegt",
      (await waitFor(`document.querySelector("#settings [data-push-state=off]")`)) && (await panelText()).includes("Dieses Gerät wurde entfernt")
        && (await js<number>(`window.__push.unsubscribed`)) >= 1 && !(await serverPush()).devices.some((d: any) => d.id === again));

    // Test mit 410 vom Push-Dienst: Gerät weg, Schalter aus
    await clickText("An");
    await waitFor(`document.querySelector("#settings [data-push-state=on]")`);
    pushStatus = 410;
    await clickText("Test senden");
    check("Test mit 410: Hinweis, Schalter aus, Gerät beim Server gelöscht",
      (await waitFor(`document.querySelector("#settings [data-push-state=off]")`)) && (await panelText()).includes("neu einschalten")
        && (await serverPush()).devices.length === 1);
    pushStatus = 201;
    await js(`localStorage.removeItem("tybo-push-device"); sessionStorage.clear()`);
    await unmock(id);
  } finally {
    await emulateScheme("light");
    await pushDemo.stop();
  }
}

/**
 * Direktlink #/gespraech/<id> (Issue #226), je 1280 und 390 px, hell und
 * dunkel: bekanntes Topic öffnet genau dieses, unbekanntes Gespräch öffnet den
 * Direktchat mit Hinweis im Verbindungsbalken (Screenshots mit --screenshots).
 * Dazu die Anmeldung: ohne Sitzung führt der Link über /login und landet
 * danach im verlinkten Gespräch.
 */
async function linkChecks() {
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const shots = process.argv.includes("--screenshots");
  async function shoot(name: string) {
    if (!shots) return;
    await Bun.sleep(300);
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`Bild ${name}.png`);
  }
  const origin = demo.server.url.replace(/\/$/, "");
  const unknown = "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b";
  const hint = "Dieses Gespräch gibt es nicht mehr. Hier ist der Direktchat.";
  const current = () => js<string | null>(`document.querySelector(".conversation[aria-current=true]")?.dataset.id ?? null`);
  const connection = () => js<string>(`(() => { const c = document.getElementById("connection"); return c.hidden ? "" : c.textContent; })()`);
  try {
    await goto("about:blank");
    await goto(`${origin}/#/gespraech/topic-12`);
    check("Direktlink: Topic „Finanzen“ offen, Adresse danach leer",
      (await waitFor(`document.querySelector(".conversation[aria-current=true]")?.dataset.id === "topic-12"`)) && (await js<string>(`location.hash`)) === "",
      String(await current()));
    await js(`location.hash = "#/gespraech/topic-31"`);
    check("Direktlink per Adresswechsel: Topic „Strategie“ offen", await waitFor(`document.querySelector(".conversation[aria-current=true]")?.dataset.id === "topic-31"`));
    for (const scheme of ["light", "dark"] as const) {
      await emulateScheme(scheme);
      for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await goto("about:blank");
        await goto(`${origin}/#/gespraech/${unknown}`);
        const label = `Direktlink unbekannt ${size.width} px ${scheme === "dark" ? "dunkel" : "hell"}`;
        check(`${label}: Direktchat offen, Hinweis im Verbindungsbalken`,
          (await waitFor(`document.querySelector(".conversation[aria-current=true]")?.dataset.id === "dm"`))
            && (await waitFor(`document.getElementById("connection").textContent === ${JSON.stringify(hint)} && !document.getElementById("connection").hidden`)),
          `${await current()}: ${await connection()}`);
        check(`${label}: kein waagrechtes Scrollen`, await js<boolean>(`document.documentElement.scrollWidth <= ${size.width}`));
        await shoot(`direktlink-unbekannt-${size.width}${scheme === "dark" ? "-dunkel" : ""}`);
      }
    }
  } finally {
    await emulateScheme("light");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 });
  }

  // Anmeldung dazwischen: der Link übersteht /login
  const target = (await plainStore.listConversations())[0]?.id;
  check("Direktlink mit Anmeldung: Web-Gespräch vorhanden", !!target);
  if (!target) return;
  await cdp("Network.clearBrowserCookies");
  await goto("about:blank");
  await goto(`${base}/#/gespraech/${target}`);
  check("Direktlink ohne Sitzung: Umleitung auf /login, Adresse bleibt",
    await waitFor(`location.pathname === "/login" && location.hash === ${JSON.stringify(`#/gespraech/${target}`)}`), await js<string>(`location.href`));
  await js(`document.getElementById("password").value = ${JSON.stringify(PASSWORD)}`);
  await js(`document.getElementById("login-form").requestSubmit()`);
  check("Direktlink nach der Anmeldung: genau dieses Gespräch offen",
    await waitFor(`location.pathname === "/" && document.querySelector(".conversation[aria-current=true]")?.dataset.id === ${JSON.stringify(target)}`),
    String(await current()));
}

try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  if (only.length) {
    for (const name of only) await ONLY_SECTIONS[name]();
    throw ONLY_DONE;
  }

  // --- Anmeldung -------------------------------------------------------------
  await goto(`${base}/`);
  check("ohne Anmeldung Umleitung auf /login", await waitFor(`location.pathname === "/login"`));
  // Name aus src/brand.ts, auch ohne Anmeldung (Issue #100)
  check(`Login: Titel und Wortmarke ${BRAND.name}`, await waitFor(
    `document.title === ${JSON.stringify(`${BRAND.name} Anmeldung`)} && document.querySelector(".wordmark").textContent === ${JSON.stringify(BRAND.name)} && window.TYBO_BRAND?.name === ${JSON.stringify(BRAND.name)}`));
  // tyb[o]t: früherer Befehl, zerlegt geschrieben, damit die Suche nach Resten des Namens leer bleibt (Issue #142)
  check("Login: kein alter Name im Dokument", !/gob[o]t|tyb[o]t|\{\{brand/i.test(await js<string>(`document.documentElement.outerHTML`)));
  await js(`document.getElementById("password").value = ${JSON.stringify(PASSWORD)}`);
  await js(`document.getElementById("login-form").requestSubmit()`);
  check("nach Login Chat-Seite", await waitFor(`location.pathname === "/" && document.getElementById("chat-log")`));
  check("Kopfzeile: Agent General", await waitFor(`document.getElementById("agent-name").textContent === "General"`));
  check(`Chat: Titel, Wortmarke und Platzhalter mit ${BRAND.name}`, await waitFor(
    `document.title === ${JSON.stringify(BRAND.name)} && document.querySelector(".sidebar .wordmark, .wordmark").textContent === ${JSON.stringify(BRAND.name)} && document.getElementById("input").placeholder === ${JSON.stringify(`Nachricht an ${BRAND.name}`)}`));
  check("Chat: kein {{brand...}}-Platzhalter übrig", !(await js<string>(`document.documentElement.outerHTML`)).includes("{{brand"));
  check("Senden gesperrt bei leerem Feld", await js<boolean>(`document.getElementById("send").disabled`));
  const cookies = (await cdp("Network.getCookies", { urls: [base] })).cookies as any[];
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const scriptLengths = await js<{ bytes: number; expected: number }[]>(`Promise.all(["/app.js", "/settings.js"].map(async path => {
    const response = await fetch(path, { cache: "reload" });
    return { bytes: (await response.arrayBuffer()).byteLength, expected: Number(response.headers.get("content-length")) };
  }))`);
  check("Testproxy überträgt große Browser-Skripte vollständig", scriptLengths.every(file => file.bytes > 0 && file.bytes === file.expected), JSON.stringify(scriptLengths));

  // --- Senden, Fortschritt, Antwort -----------------------------------------
  const hostile = `<img src=x onerror="window.__xss=1">Hallo <b>fett</b>`;
  await typeAndEnter(hostile);
  check("Enter sendet, Nutzertext wörtlich angezeigt",
    await waitFor(`[...document.querySelectorAll(".msg-user .bubble")].some(b => b.textContent === ${JSON.stringify(hostile)})`));
  check("kein HTML aus Nutzertext ausgeführt", await js<boolean>(`!window.__xss && !document.querySelector(".msg-user img, .msg-user b")`));
  check("Feld nach dem Senden leer", await js<boolean>(`document.getElementById("input").value === ""`));
  check("während des Turns: Stopp sichtbar, Senden ausgeblendet und gesperrt",
    await waitFor(`!document.getElementById("activity").hidden && ${runningButtons} && document.getElementById("send").disabled`));
  check("Fortschritt: Datei lesen", await waitFor(`document.querySelector("#progress .step-tool")?.textContent === "Datei lesen"`));
  check("Fortschritt: Snippet kursiv", await waitFor(`document.querySelector("#progress .step-snippet em")`));
  check("Hinweis als eigene Zeile", await waitFor(`document.querySelector("#progress .step-notice")?.textContent.includes("Attrappe")`));
  check("Antwort formatiert (Überschrift, Liste, Code)",
    await waitFor(`document.querySelector(".msg-assistant h2") && document.querySelector(".msg-assistant li") && document.querySelector(".msg-assistant pre code")`));
  check("[REMEMBER: test] nicht sichtbar", !(await js<string>(`document.body.innerText`)).includes("REMEMBER"));
  check("nach der Antwort: Stopp weg, Senden sichtbar", (await turnDone()) && (await waitFor(idleButtons)));
  await js(`(() => { const i = document.getElementById("input"); i.value = "x"; i.dispatchEvent(new Event("input")); })()`);
  check("Senden danach wieder möglich", await js<boolean>(`!document.getElementById("send").disabled`));
  check("Verlauf unten", await js<boolean>(`(() => { const l = document.getElementById("chat-log"); return l.scrollHeight - l.scrollTop - l.clientHeight < 5; })()`));

  // --- Shift+Enter und Feldhöhe ----------------------------------------------
  const before = await count(".msg");
  await js(`(() => { const i = document.getElementById("input"); i.focus(); i.value = "Zeile 1"; i.setSelectionRange(7, 7); i.dispatchEvent(new Event("input")); })()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  await Bun.sleep(200);
  check("Shift+Enter: neue Zeile, nichts gesendet",
    (await js<string>(`document.getElementById("input").value`)).includes("\n") && (await count(".msg")) === before);
  const h1 = await js<number>(`document.getElementById("input").offsetHeight`);
  await js(`(() => { const i = document.getElementById("input"); i.value = Array.from({length: 4}, (_, n) => "Zeile " + n).join("\\n"); i.dispatchEvent(new Event("input")); })()`);
  const h4 = await js<number>(`document.getElementById("input").offsetHeight`);
  await js(`(() => { const i = document.getElementById("input"); i.value = Array.from({length: 30}, (_, n) => "Zeile " + n).join("\\n"); i.dispatchEvent(new Event("input")); })()`);
  const h30 = await js<number>(`document.getElementById("input").offsetHeight`);
  const lineHeight = await js<number>(`parseFloat(getComputedStyle(document.getElementById("input")).lineHeight)`);
  check("Feld wächst mit und endet bei etwa 8 Zeilen", h4 > h1 && h30 > h4 && h30 <= lineHeight * 8 + 40 && h30 >= lineHeight * 7,
    `1 Zeile ${h1}px, 4 Zeilen ${h4}px, 30 Zeilen ${h30}px`);
  await js(`(() => { const i = document.getElementById("input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);

  // --- Enter während IME-Eingabe ---------------------------------------------
  const beforeIme = await count(".msg");
  await js(`(() => { const i = document.getElementById("input"); i.value = "かな"; i.dispatchEvent(new Event("input"));
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })); })()`);
  await Bun.sleep(200);
  check("Enter während IME-Eingabe sendet nicht", (await count(".msg")) === beforeIme);
  await js(`(() => { const i = document.getElementById("input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);

  // --- Stopp -----------------------------------------------------------------
  await typeAndEnter("Bitte abbrechen");
  check("Stopp-Knopf erscheint, Senden weg", await waitFor(`!document.getElementById("activity").hidden && ${runningButtons}`));
  await js(`document.getElementById("stop").click()`);
  check("Stopp ergibt Abgebrochen. als ruhige Notiz", await waitFor(`[...document.querySelectorAll(".msg-note")].at(-1)?.textContent === "Abgebrochen."`));
  check("nach Stopp wieder bereit: Senden statt Stopp", (await turnDone()) && (await waitFor(idleButtons)));

  // --- Verbindung während eines Turns trennen --------------------------------
  const assistantsBefore = await count(".msg-assistant");
  await typeAndEnter("Test Wiederverbinden");
  await waitFor(`!document.getElementById("activity").hidden`);
  cutConnections(true);
  check("Hinweis auf unterbrochene Verbindung", await waitFor(`!document.getElementById("connection").hidden`, 5000));
  // Turn läuft auf dem Server zu Ende, während der Browser getrennt ist
  // (direkt am Server nachgefragt, nicht über den gesperrten Proxy)
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${server.url}/api/conversations`, { headers: { cookie } })).json();
    const id = r.conversations[0].id;
    const m = await (await fetch(`${server.url}/api/conversations/${id}/messages`, { headers: { cookie } })).json();
    if (!m.running) break;
    await Bun.sleep(100);
  }
  check("offline: Antwort noch nicht da", (await count(".msg-assistant")) === assistantsBefore);
  cutConnections(false);
  check("nach Wiederverbinden: Antwort nachgeladen", await waitFor(`document.querySelectorAll(".msg-assistant").length === ${assistantsBefore + 1}`, 15000));
  await Bun.sleep(500);
  check("Antwort genau einmal sichtbar", (await count(".msg-assistant")) === assistantsBefore + 1);
  check("Verbindungshinweis weg, Stopp weg", await waitFor(`document.getElementById("connection").hidden && document.getElementById("activity").hidden && ${idleButtons}`));
  const ids = await js<string[]>(`[...document.querySelectorAll(".msg")].map(m => m.dataset.id)`);
  check("keine doppelten Nachrichten-IDs", new Set(ids).size === ids.length);
  check("Anzeige entspricht dem Server", ids.length === (await apiMessages(cookie)).length, `${ids.length} Nachrichten`);

  // --- Neu laden während eines Turns -----------------------------------------
  const assistantsBeforeReload = await count(".msg-assistant");
  await typeAndEnter("Test Neuladen");
  await waitFor(`!document.getElementById("activity").hidden`);
  await cdp("Page.reload");
  await Bun.sleep(300);
  check("nach Neuladen: Turn läuft noch, Stopp sichtbar", await waitFor(`document.getElementById("chat-log") && !document.getElementById("activity").hidden && ${runningButtons}`));
  check("nach Neuladen: Antwort kommt genau einmal",
    await waitFor(`document.querySelectorAll(".msg-assistant").length === ${assistantsBeforeReload + 1} && document.getElementById("activity").hidden`, 10000));
  await Bun.sleep(300);
  check("keine Doppelung nach Neuladen", (await count(".msg-assistant")) === assistantsBeforeReload + 1);

  // --- Neues Gespräch (seit Issue #21 mit Agentenauswahl) --------------------
  await js(`document.getElementById("new-chat").click()`);
  check("Neues Gespräch: Agentenauswahl offen, General markiert und fokussiert",
    await waitFor(`${shown("agent-picker")} && document.activeElement?.dataset.agentOption === "general" && document.activeElement.getAttribute("aria-selected") === "true"`));
  check("Neues Gespräch: vor der Wahl nichts angelegt",
    (await (await fetch(`${base}/api/conversations`, { headers: { cookie } })).json()).conversations.length === 1);
  await pressKey("Enter", "Enter", 13, "\r");
  // Seit Issue #29 legt Enter ein Telegram-Topic an; ohne Forum-Gruppe seit Issue #227 ein Web-Gespräch
  check("Neues Gespräch ohne Forum-Gruppe: leeres Web-Gespräch mit General geöffnet",
    await waitFor(`document.getElementById("agent-name").textContent === "General" && document.querySelectorAll(".msg").length === 0 && !${shown("agent-picker")}`));
  const list = await (await fetch(`${base}/api/conversations`, { headers: { cookie } })).json();
  check("Neues Gespräch: Web-Gespräch auf dem Server angelegt", list.conversations.length === 2);
  // Älteres leeres Web-Gespräch, zuletzt geöffnet: bleibt nach dem Neuladen offen
  const empty = await plainStore.createConversation("general");
  await js(`localStorage.setItem(${JSON.stringify(LAST_KEY)}, ${JSON.stringify(empty.id)})`);
  await goto(`${base}/`);
  check("nach Neuladen bleibt das gemerkte (leere) Gespräch offen", await waitFor(`document.getElementById("agent-name").textContent === "General"`) && (await count(".msg")) === 0);

  // --- Web-Gespräch mit Research anlegen, umbenennen, löschen (Issue #21) -----
  await manageChecks(cookie);

  // --- Abmelden (vorher „Dunkel" gewählt, System hell) ------------------------
  await emulateScheme("light");
  await js(`document.getElementById("theme-dark").click()`);
  check("Wahl Dunkel vor dem Abmelden gespeichert", (await storedTheme()) === "dark");
  await js(`document.getElementById("logout").click()`);
  check("Abmelden führt zur Anmeldung", await waitFor(`location.pathname === "/login"`));
  check("alte Session ungültig", (await fetch(`${base}/api/me`, { headers: { cookie } })).status === 401);
  await waitFor(`document.readyState === "complete" && document.getElementById("password")`);
  check("Login-Seite (abgemeldet) folgt der gespeicherten Wahl Dunkel",
    (await themeAttr()) === "dark" && (await bodyBg()) === DARK_BG && !(await js<boolean>(`!!document.getElementById("theme-switch")`)),
    await bodyBg());
  check("Login-Seite: theme-color fest dunkel", JSON.stringify(await themeColors()) === JSON.stringify(["#1f2023", "#1f2023"]));
  await js(`localStorage.removeItem("tybo-theme")`);
  await goto(`${base}/login`);
  check("Login-Seite ohne Wahl wieder nach System (hell)", (await themeAttr()) === null && (await bodyBg()) === LIGHT_BG);
  await cdp("Emulation.setEmulatedMedia", { features: [] });

  // --- 390 px, Demo-Unterhaltung ---------------------------------------------
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await goto(`${demo.server.url}/`);
  check("Demo ohne Anmeldung, Verlauf geladen", await waitFor(`document.querySelector(".msg-assistant table")`));
  check("390 px: kein horizontales Scrollen der Seite",
    await js<boolean>(`document.documentElement.scrollWidth <= 390 && document.body.scrollWidth <= 390`),
    `scrollWidth ${await js<number>(`document.documentElement.scrollWidth`)}`);
  check("390 px: Tabelle scrollt in sich",
    await js<boolean>(`(() => { const t = document.querySelector(".msg-assistant table"); return t.scrollWidth > t.clientWidth && t.clientWidth <= 390; })()`));
  check("390 px: Codeblock scrollt in sich",
    await js<boolean>(`(() => { const p = document.querySelector(".msg-assistant pre"); return p.scrollWidth > p.clientWidth && p.clientWidth <= 390; })()`));
  check("390 px: Eingabe am unteren Rand",
    await js<boolean>(`(() => { const r = document.getElementById("composer").getBoundingClientRect(); return Math.abs(r.bottom - innerHeight) < 2; })()`));
  check("390 px: Verlauf beim Öffnen unten",
    await js<boolean>(`(() => { const l = document.getElementById("chat-log"); return l.scrollHeight - l.scrollTop - l.clientHeight < 5; })()`));

  // --- 390 px: anderes Gespräch aus der Schublade öffnen ----------------------
  // EventSource mitschreiben, damit sich das Schließen des alten Stroms prüfen lässt
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const Original = window.EventSource;
    window.__sources = [];
    window.EventSource = function (url, init) { const s = new Original(url, init); window.__sources.push(s); return s; };
    window.EventSource.prototype = Original.prototype;
  })()` });
  await goto(`${demo.server.url}/`);
  await waitFor(`document.querySelector(".msg-assistant table") && document.querySelectorAll("#conversation-list .conversation").length === 2`);
  const firstStream = await js<string>(`window.__sources.at(-1)?.url || ""`);
  await js(`document.getElementById("menu").click()`);
  check("390 px: Schublade geht auf", await waitFor(`document.getElementById("sidebar").dataset.open === "true" && ${shown("scrim")}`));
  await js(`document.querySelectorAll("#conversation-list .conversation")[1].click()`);
  check("Gesprächswechsel: Schublade schließt",
    await waitFor(`document.getElementById("sidebar").dataset.open === "false" && !${shown("scrim")}`));
  check("Gesprächswechsel: Verlauf des gewählten Gesprächs",
    await waitFor(`document.querySelectorAll(".msg").length === 2 && document.querySelector(".msg-user .bubble").textContent.includes("VPS")`));
  check("Gesprächswechsel: Agent Research in Kopfzeile und Antwort",
    await js<boolean>(`document.getElementById("agent-name").textContent === "Research" && document.querySelector(".msg-assistant .msg-head").dataset.agent === "research"`));
  check("Gesprächswechsel: Eintrag als aktuell markiert",
    await js<boolean>(`document.querySelectorAll("#conversation-list .conversation")[1].getAttribute("aria-current") === "true"`));
  check("Gesprächswechsel: alter Ereignisstrom geschlossen, neuer offen",
    await waitFor(`window.__sources.length >= 2 && window.__sources.find(s => s.url === ${JSON.stringify(firstStream)}).readyState === 2 && window.__sources.at(-1).url !== ${JSON.stringify(firstStream)} && window.__sources.at(-1).readyState !== 2`),
    firstStream);
  check("Gesprächswechsel: Senden sichtbar, kein Stopp", await waitFor(idleButtons));

  // --- Seitenleiste mit Direktchat und Topics, Telegram-Verlauf (Issue #18) ---
  await telegramChecks();
  await liveChecks();
  await noticeChecks();
  await commandChecks();
  await attachmentChecks();
  await recordingChecks();
  await webConversationAttachmentChecks();
  await goalChecks();
  await goalBudgetChecks();
  await topicMapChecks();
  await choiceChecks();
  await jobViewChecks();
  await pipelineViewChecks();
  await jobResumeChoiceChecks();
  await jobQuestionChecks();
  await jobReturnChecks();
  await toolApprovalChecks();
  await reviewChecks();
  await footerChecks();
  await topicChecks();
  await settingsChecks();
  await agentsManageChecks();
  await modelsStatusChecks();
  await engineChecks();
  await keysChecks();
  await routinesChecks();
  await remindersChecks();
  await threadsChecks();
  await updateChecks();
  await installChecks();
  await pushChecks();
  await linkChecks();

  // --- Touch: Enter macht eine neue Zeile ------------------------------------
  // Das zuletzt geöffnete Gespräch vergessen: die Prüfung erwartet das jüngste Web-Gespräch
  await js(`localStorage.removeItem(${JSON.stringify(LAST_KEY)})`);
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  await goto(`${demo.server.url}/`);
  await waitFor(`document.querySelector(".msg-assistant table")`);
  const coarse = await js<boolean>(`matchMedia("(pointer: coarse)").matches`);
  const beforeTouch = await count(".msg");
  await js(`(() => { const i = document.getElementById("input"); i.focus(); i.value = "Handy"; i.setSelectionRange(5, 5); i.dispatchEvent(new Event("input")); })()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await Bun.sleep(200);
  if (coarse) {
    check("Touch: Enter sendet nicht, fügt Zeile ein",
      (await count(".msg")) === beforeTouch && (await js<string>(`document.getElementById("input").value`)).includes("\n"));
    await js(`document.getElementById("send").click()`);
    check("Touch: Knopf sendet", await waitFor(`document.querySelectorAll(".msg").length === ${beforeTouch + 1}`));
  } else {
    check("Touch-Emulation greift (pointer: coarse)", false, "Chrome meldet kein pointer: coarse");
  }

  // --- Dunkelmodus -----------------------------------------------------------
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  const darkBg = await js<string>(`getComputedStyle(document.body).backgroundColor`);
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  const lightBg = await js<string>(`getComputedStyle(document.body).backgroundColor`);
  check("Dunkelmodus über prefers-color-scheme", darkBg !== lightBg, `hell ${lightBg}, dunkel ${darkBg}`);

  // --- Schalter System / Hell / Dunkel (Issue #15), Demo-Origin ---------------
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp("Emulation.setEmitTouchEventsForMouse", { enabled: false });
  // Hält fest, welches data-theme <html> trägt, sobald <body> entsteht: vor dem
  // ersten Zeichnen muss die Wahl schon gesetzt sein (kein Aufblitzen)
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__themeAtBody = "unbekannt";
    new MutationObserver((_, obs) => {
      if (!document.body) return;
      window.__themeAtBody = document.documentElement.getAttribute("data-theme");
      obs.disconnect();
    }).observe(document, { childList: true, subtree: true });
  })()` });
  const demoUrl = `${demo.server.url}/`;
  for (const size of [{ width: 1280, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
    const label = `${size.width} px`;
    await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1 });
    await emulateScheme("light");
    await goto(demoUrl);
    await js(`localStorage.removeItem("tybo-theme")`);
    await goto(demoUrl);
    await waitFor(`document.getElementById("theme-switch") && document.querySelector(".msg")`);
    check(`${label}: Standard System, hell, kein data-theme`,
      (await themeAttr()) === null && (await bodyBg()) === LIGHT_BG && JSON.stringify(await checkedTheme()) === '["theme-system"]');
    check(`${label}: theme-color bei System mit beiden Media-Varianten`, JSON.stringify(await themeColors()) === JSON.stringify(["#ffffff", "#1f2023"]));
    check(`${label}: berechnetes color-scheme bei System`, (await computedScheme()) === "light dark", await computedScheme());
    check(`${label}: Schalter ist benannte Radiogruppe mit genau einem Tab-Stopp`,
      await js<boolean>(`(() => { const g = document.getElementById("theme-switch"); return g.getAttribute("role") === "radiogroup" && g.getAttribute("aria-label") === "Darstellung" && g.querySelectorAll('[tabindex="0"]').length === 1 && g.querySelectorAll("[role=radio]").length === 3; })()`));
    if (size.mobile) {
      await js(`document.getElementById("menu").click()`);
      await waitFor(`document.getElementById("sidebar").dataset.open === "true"`);
      await Bun.sleep(300);
      const heights = await js<number[]>(`[...document.querySelectorAll("#theme-switch [role=radio]")].map(b => b.getBoundingClientRect().height)`);
      check(`${label}: Schalter-Knöpfe mindestens 44 px hoch`, heights.every(h => h >= 44), heights.join(", "));
    } else {
      const heights = await js<number[]>(`[...document.querySelectorAll("#theme-switch [role=radio]")].map(b => b.getBoundingClientRect().height)`);
      check(`${label}: Schalter liegt in der Seitenleiste über Abmelden`,
        await js<boolean>(`document.getElementById("theme-switch").getBoundingClientRect().bottom <= document.getElementById("logout").getBoundingClientRect().top`),
        `Höhe ${heights.join(", ")} px`);
    }

    // System hell, Wahl „Dunkel"
    await js(`document.getElementById("theme-dark").click()`);
    check(`${label}: Wahl Dunkel bei hellem System wirkt sofort`,
      (await bodyBg()) === DARK_BG && (await themeAttr()) === "dark" && JSON.stringify(await checkedTheme()) === '["theme-dark"]', await bodyBg());
    check(`${label}: Wahl Dunkel gespeichert, theme-color fest, color-scheme dark`,
      (await storedTheme()) === "dark" && JSON.stringify(await themeColors()) === JSON.stringify(["#1f2023", "#1f2023"]) && (await computedScheme()) === "dark");
    await cdp("Page.reload");
    await Bun.sleep(200);
    await waitFor(`document.readyState === "complete" && document.getElementById("theme-switch")`);
    check(`${label}: nach Neuladen bleibt es dunkel`,
      (await bodyBg()) === DARK_BG && JSON.stringify(await checkedTheme()) === '["theme-dark"]' && JSON.stringify(await themeColors()) === JSON.stringify(["#1f2023", "#1f2023"]));
    check(`${label}: data-theme steht schon, bevor <body> entsteht`, (await js<string | null>(`window.__themeAtBody`)) === "dark", String(await js(`window.__themeAtBody`)));

    // Zurück zu System: folgt wieder der Emulation
    await js(`document.getElementById("theme-system").click()`);
    check(`${label}: System folgt wieder der Emulation (hell)`, (await bodyBg()) === LIGHT_BG && (await themeAttr()) === null);
    check(`${label}: System stellt theme-color und color-scheme wieder her`,
      JSON.stringify(await themeColors()) === JSON.stringify(["#ffffff", "#1f2023"]) && (await computedScheme()) === "light dark");
    await emulateScheme("dark");
    check(`${label}: System folgt wieder der Emulation (dunkel)`, (await bodyBg()) === DARK_BG);

    // System dunkel, Wahl „Hell"
    await js(`document.getElementById("theme-light").click()`);
    check(`${label}: Wahl Hell bei dunklem System wirkt sofort`,
      (await bodyBg()) === LIGHT_BG && (await themeAttr()) === "light" && (await computedScheme()) === "light" && (await storedTheme()) === "light");
    await cdp("Page.reload");
    await Bun.sleep(200);
    await waitFor(`document.readyState === "complete" && document.getElementById("theme-switch")`);
    check(`${label}: nach Neuladen bleibt es hell`,
      (await bodyBg()) === LIGHT_BG && JSON.stringify(await checkedTheme()) === '["theme-light"]' && (await js<string | null>(`window.__themeAtBody`)) === "light");

    // Tastatur: Pfeiltasten wechseln Fokus und Wahl, Leertaste wählt
    if (size.mobile) {
      await js(`document.getElementById("menu").click()`);
      await waitFor(`document.getElementById("sidebar").dataset.open === "true"`);
      await Bun.sleep(300);
    }
    await js(`document.getElementById("theme-light").focus()`);
    await pressKey("ArrowRight", "ArrowRight", 39);
    check(`${label}: Pfeil rechts wählt und fokussiert Dunkel`,
      JSON.stringify(await checkedTheme()) === '["theme-dark"]' && (await js<string>(`document.activeElement.id`)) === "theme-dark" && (await bodyBg()) === DARK_BG);
    await pressKey("ArrowRight", "ArrowRight", 39);
    check(`${label}: Pfeil rechts am Ende springt zu System`,
      JSON.stringify(await checkedTheme()) === '["theme-system"]' && (await js<string>(`document.activeElement.id`)) === "theme-system");
    await pressKey("ArrowLeft", "ArrowLeft", 37);
    check(`${label}: Pfeil links am Anfang springt zu Dunkel`, JSON.stringify(await checkedTheme()) === '["theme-dark"]');
    await js(`document.getElementById("theme-light").focus()`);
    await pressKey(" ", "Space", 32, " ");
    check(`${label}: Leertaste wählt Hell`, JSON.stringify(await checkedTheme()) === '["theme-light"]' && (await bodyBg()) === LIGHT_BG);
    await js(`localStorage.removeItem("tybo-theme")`);
  }
  await cdp("Emulation.setEmulatedMedia", { features: [] });

  if (process.argv.includes("--screenshots")) await screenshots();
} catch (e) {
  if (e !== ONLY_DONE) {
    failures++;
    console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
  }
} finally {
  ws.close();
  cutConnections(true);
  await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  chrome.kill();
  await chrome.exited;
  await server.stop();
  await demo.stop();
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);

/** Pipeline-Ansicht mit vier Zuständen; WEB_PIPELINES_URL liefert Fotos aus web:dev. */
async function pipelineViewChecks() {
  const shots = process.argv.includes("--screenshots");
  const out = join(import.meta.dir, "..", "docs", "webui", "screenshots");
  const row = (id: string) => `document.querySelector('[data-pipeline-id="demo-${id}"]')`;
  const focus = (key: string) => `document.querySelector('[data-pipeline-focus="${key}"]')`;
  const ready = `document.getElementById("main").dataset.view === "pipelines" && document.querySelectorAll(".pipeline-item").length === 4`;
  for (const scheme of shots ? ["light", "dark"] : ["light"]) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    for (const size of [{ width: 1280, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
      const label = `Pipelines ${size.width} px ${scheme}`;
      const pipelines = createDemoPipelines();
      const d = await startDemoServer({ host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] }, { pipelines, log: () => {} });
      const url = process.env.WEB_PIPELINES_URL || d.server.url;
      const shoot = async (name: string) => {
        if (!shots) return;
        await Bun.sleep(100);
        const { data } = await cdp("Page.captureScreenshot", { format: "png" });
        const file = `pipelines-${name}-${size.width}${scheme === "dark" ? "-dunkel" : ""}.png`;
        await Bun.write(join(out, file), Buffer.from(data, "base64"));
        console.log(`Bild ${file}`);
      };
      try {
        await goto(url + "/");
        check(`${label}: Zähler geladen`, await waitFor(`document.getElementById("pipelines-count")?.textContent === "1"`));
        if (size.mobile) await openDrawer();
        const isStale = await js<boolean>(`document.getElementById("pipelines-count").dataset.waiting === "false"`);
        check(`${label}: Eintrag sichtbar`, await js<boolean>(shown("open-pipelines")));
        if (!isStale) await shoot("seitenleiste");
        await js(`document.getElementById("open-pipelines").click()`);
        check(`${label}: Ansicht geöffnet`, await waitFor(ready));
        check(`${label}: Reihenfolge und Fokus`, await js<boolean>(`JSON.stringify([...document.querySelectorAll(".pipeline-item")].map(n => n.dataset.state)) === JSON.stringify(["waiting", "halted", "running", "resting"]) && document.activeElement.id === "pipelines-title" && location.hash === "#/pipelines"`));
        check(`${label}: Ruhe eingeklappt und Stoppzeile`, await js<boolean>(`!document.querySelector(".pipeline-resting").open && document.querySelector(".pipeline-stopped").textContent.includes("Pipelines gestoppt: Die Wächter sind aus")`));
        check(`${label}: keine Start-, Stopp- oder Antwortknöpfe`, await js<boolean>(`[...document.querySelectorAll("#pipelines-body button")].every(b => b.textContent === "Zum Gespräch")`));
        check(`${label}: kein seitliches Scrollen`, await noHorizontalScroll(size.width));
        if (isStale) {
          check(`${label}: alter Stand klar bezeichnet`, await js<boolean>(`document.getElementById("pipelines-status").textContent.includes("der Statusdienst läuft nicht")`));
          await shoot("veraltet");
          continue;
        }
        await shoot("liste");
        await js(`${focus("demo-waiting:question")}.click()`);
        check(`${label}: Frage aufgeklappt`, await waitFor(`${row("waiting")}.querySelector(".pipeline-question").open`));
        check(`${label}: voller Text, Datum und Gespräch`, await js<boolean>(`${row("waiting")}.textContent.includes("alphabetisch") && ${row("waiting")}.textContent.includes("bisherige Verlauf") && !!${focus("demo-waiting:open")}`));
        check(`${label}: Frage ohne Überbreite`, await noHorizontalScroll(size.width));
        if (size.mobile) check(`${label}: Tippflächen mindestens 44 px`, await js<boolean>(`[...document.querySelectorAll("#pipelines-body button, #pipelines-body summary")].filter(e => e.getClientRects().length).every(e => e.getBoundingClientRect().height >= 44)`));
        await shoot("frage");
        await js(`${focus("demo-waiting:question")}.click(); ${focus("resting")}.click()`);
        check(`${label}: Ruhe zeigt letzten Zustand, kein Gespräch bei fehlendem Ziel`, await js<boolean>(`document.querySelector(".pipeline-resting").open && ${row("resting")}.textContent.includes("zuletzt: wartet auf dich") && !${focus("demo-resting:open")}`));
        // Zusätzlich die ganze Liste in einem hohen Fenster derselben Breite.
        const height = await js<number>(`document.querySelector("#pipelines-view .settings-scroll").scrollHeight + 100`);
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, height, deviceScaleFactor: 2 });
        await js(`document.querySelector("#pipelines-view .settings-scroll").scrollTop = 0`);
        await shoot("uebersicht");
        await cdp("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 2 });
        await js(`${focus("demo-waiting:open")}.click()`);
        check(`${label}: Zum Gespräch öffnet das richtige Topic`, await waitFor(`document.getElementById("main").dataset.view === "chat" && document.getElementById("chat-title").textContent === "Pipeline"`));
        await goto(url + "/#/pipelines"); await waitFor(ready);
        await js(`document.getElementById("pipelines-back").click()`);
        check(`${label}: Direktlink und Zurück`, await waitFor(`document.getElementById("main").dataset.view === "chat" && location.hash === ""`));

        if (size.width === 1280 && scheme === "light") {
          await goto(d.server.url + "/#/pipelines"); await waitFor(ready);
          await js(`${focus("demo-waiting:question")}.click(); ${focus("demo-waiting:question")}.focus()`);
          const snapshot = (await pipelines.read())!;
          snapshot.pipelines[2].step = { kind: "review", round: 2 };
          pipelines.setSnapshot(snapshot);
          check(`${label}: neuer Stand ohne Neuladen`, await waitFor(`${row("running")}.textContent.includes("Prüfer prüft")`, 13_000));
          check(`${label}: Frage und Fokus überstehen Abgleich`, await js<boolean>(`${row("waiting")}.querySelector(".pipeline-question").open && document.activeElement.getAttribute("data-pipeline-focus") === "demo-waiting:question"`));
          snapshot.generatedAt = new Date(Date.now() - 5 * 60_000 + 2000).toISOString(); pipelines.setSnapshot(snapshot);
          await js(`document.dispatchEvent(new Event("visibilitychange"))`);
          check(`${label}: frischer Stand vor der Altersgrenze`, await waitFor(`document.getElementById("pipelines-status").dataset.stale === "false"`));
          check(`${label}: wird zwischen Abrufen von selbst veraltet`, await waitFor(`document.getElementById("pipelines-status").dataset.stale === "true"`, 5000));
          check(`${label}: Zähler bleibt ohne Hervorhebung`, await js<boolean>(`!document.getElementById("open-pipelines").hidden && document.getElementById("pipelines-count").textContent === "1" && document.getElementById("pipelines-count").dataset.waiting === "false"`));
          if (!process.env.WEB_PIPELINES_URL) await shoot("veraltet");
          pipelines.setSnapshot(null); await js(`document.dispatchEvent(new Event("visibilitychange"))`);
          check(`${label}: fehlende Datei blendet Eintrag aus`, await waitFor(`document.getElementById("open-pipelines").hidden && document.getElementById("pipelines-body").textContent.includes("Keine Pipelines")`));
        }
      } finally { await d.stop(); }
    }
  }
}
