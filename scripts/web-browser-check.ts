#!/usr/bin/env bun
/**
 * Browser-Durchlauf der Chat-Seite (Issue #5) mit Headless-Chrome über das
 * DevTools-Protokoll. Kein Teil von `bun run check` (braucht Chrome), wird
 * von Hand gestartet:
 *
 *   bun run scripts/web-browser-check.ts
 *   bun run scripts/web-browser-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *
 * Startet einen eigenen Web-Server mit Attrappe auf einem freien Port in
 * einem temporären Verzeichnis. Importiert src/bot.ts nicht.
 *
 * Seit Issue #29 legt „Neues Gespräch" ein Telegram-Topic an; der eigene
 * Server hat keine Topic-Verwaltung und lehnt das mit einer Meldung ab.
 * Ältere Web-Gespräche für die Prüfungen legt das Skript direkt im
 * Gesprächsspeicher an (plainStore).
 *
 * Chrome spricht über einen kleinen TCP-Proxy auf [::1] mit demselben Port
 * (der Host-Header muss den Port des Servers tragen). Der Proxy kann alle
 * Verbindungen hart trennen, wie ein abgerissenes WLAN; Chromes
 * Offline-Emulation trennt eine schon offene SSE-Verbindung nicht.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import { createFakeChat } from "../src/web/fake-chat";
import { createDemoKeys, createDemoSettings, createDemoStatus, DEMO_CHOICES, DEMO_GROUP_ID, DEMO_REPLY, startDemoServer } from "../src/web/demo";
import { decideChoice, getChoiceChecked, listChoices, onChoiceChange, onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
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
type Pair = { client: any; upstream: any | null; buffered: Uint8Array[] };
const pairs = new Set<Pair>();
let proxyBlocked = false;
const proxy = Bun.listen<Pair>({
  hostname: "::1",
  port,
  socket: {
    open(client) {
      if (proxyBlocked) return void client.end();
      const pair: Pair = { client, upstream: null, buffered: [] };
      client.data = pair;
      pairs.add(pair);
      void Bun.connect<Pair>({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(up) {
            up.data = pair;
            pair.upstream = up;
            for (const b of pair.buffered) up.write(b);
            pair.buffered = [];
          },
          data(up, chunk) { up.data.client.write(chunk); },
          close(up) { up.data.client.end(); pairs.delete(up.data); },
          error(up) { up.data.client.end(); },
        },
      }).catch(() => client.end());
    },
    data(client, chunk) {
      const pair = client.data;
      if (pair.upstream) pair.upstream.write(chunk);
      else pair.buffered.push(new Uint8Array(chunk));
    },
    close(client) { client.data?.upstream?.end(); if (client.data) pairs.delete(client.data); },
    error(client) { client.data?.upstream?.end(); },
  },
});
function cutConnections(block: boolean) {
  proxyBlocked = block;
  if (!block) return;
  for (const p of [...pairs]) {
    p.client.end();
    p.upstream?.end();
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
  // Seit Issue #29 wäre das ein Telegram-Topic; dieser Server hat keine Topic-Verwaltung.
  // Seit Issue #30 zeigt die Oberfläche die Meldung des Servers
  check("Enter mit Research: ohne Topic-Verwaltung Meldung des Servers, kein Web-Gespräch",
    (await waitFor(`[...document.querySelectorAll(".msg-error")].some(m => m.textContent.includes("Topics verwalten ist nicht eingerichtet"))`)) &&
    (await serverConversations(cookie)).length === before.length);
  // Älteres Web-Gespräch mit Research, direkt im Speicher angelegt
  const created = await plainStore.createConversation("research");
  await goto(`${base}/`);
  await waitFor(`document.querySelector('.conversation[data-id="${created.id}"]')`);
  await clickEntry(created.id);
  check("älteres Web-Gespräch mit Research geöffnet",
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
      (await waitFor(`document.querySelectorAll(".msg").length === ${topicBefore + 1} && [...document.querySelectorAll(".msg-user")].at(-1).textContent === "Frage aus dem Browser"`)) &&
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
 * Download als Anhang, HTML nie inline; eine Meldung „aus einem anderen
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
        check(`${label}: HTML-Report auch mit ?inline=1 nur als Anhang, Bild inline`,
          JSON.stringify(headers) === JSON.stringify(["inline image/png", "attachment application/octet-stream"]), headers.join(" | "));
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
        const box = await js<{ w: number; h: number; name: string }>(`(() => { const b = ${foot(0)}.querySelector(".copy-button"); const r = b.getBoundingClientRect();
          return { w: r.width, h: r.height, name: b.getAttribute("aria-label") }; })()`);
        check(`${label}: Kopieren-Knopf ${size.mobile ? "mindestens 44 × 44 px" : "40 × 40 px"}, Name „Antwort kopieren"`,
          box.w >= (size.mobile ? 44 : 40) && box.h >= (size.mobile ? 44 : 40) && box.name === "Antwort kopieren", `${box.w} × ${box.h}`);

        // Clipboard-API (127.0.0.1 ist ein sicherer Kontext); writeText wird mitgeschnitten
        await js(`(() => { window.__copied = []; navigator.clipboard.writeText = t => { window.__copied.push(t); return Promise.resolve(); }; })()`);
        await js(`${foot(0)}.querySelector(".copy-button").click()`);
        check(`${label}: Clipboard-API bekommt Markdown ohne Steuer-Tags, „Kopiert" erscheint`,
          (await waitFor(`${status} === "Kopiert"`, 2000)) && (await js<string[]>(`window.__copied`))[0] === expected && !expected.includes("[REMEMBER"));
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
          check(`${label}: Reiter Agenten gewählt, Modelle, Schlüssel und Status frei (Issue #39, #63)`,
            JSON.stringify(await js<string[]>(`[...document.querySelectorAll("#settings-tabs [role=tab]")].map(t => t.textContent + ":" + t.getAttribute("aria-selected") + ":" + t.disabled)`)) ===
              JSON.stringify(["Agenten:true:false", "Modelle:false:false", "Schlüssel:false:false", "Status:false:false"]));
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
        // Nach der Anforderung meldet der Status nach kurzer Zeit einen neuen Prozessstart, nur im Speicher
        let restartedAt: number | null = null;
        const status = {
          ...base,
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
            models: { list: async () => ({ claude: { models: [...CLAUDE_MODELS], custom: true }, openrouter: { models: openrouter }, ollama: { models: ["qwen3:8b", "llama4:1b"] } }) },
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
          check(`${label}: Reiter Modelle über die Adresse, drei Abschnitte`,
            (await js<string>(`location.hash`)) === "#/einstellungen/modelle" &&
              JSON.stringify(await js<string[]>(`[...document.querySelectorAll("#settings-panel h3")].map(h => h.textContent)`)) ===
                JSON.stringify(["Standard für alle Agenten", "Nebenmodelle", "Fallback"]));
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
          const requestsBefore = await js<number>(`performance.getEntriesByType("resource").length`);
          await typeInto('[data-focus-key="g-filter:fallback.openrouterModel"]', "kimi");
          check(`${label}: Filter zeigt nur Kimi K3, ohne Anfrage an den Server`,
            JSON.stringify(await js<string[]>(`[...document.getElementById("settings-g-fallback-openrouterModel").options].map(o => o.value)`)) ===
              JSON.stringify([" standard", "moonshotai/kimi-k3", " eigenes"]) &&
              (await js<number>(`performance.getEntriesByType("resource").length`)) === requestsBefore);
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

          // --- Status ---
          await click("#settings-tab-status");
          await waitFor(`!!document.querySelector("#settings-panel .settings-facts")`);
          check(`${label}: Status mit Version, Supervisor und Schlüsseln nur als gesetzt/fehlt`,
            (await js<string>(`location.hash`)) === "#/einstellungen/status" &&
              (await js<boolean>(`[...document.querySelectorAll(".settings-keys li")].every(li => ["gesetzt", "fehlt"].includes(li.querySelector(".settings-key-state").textContent) && li.children.length === 2)`)) &&
              (await count(".settings-keys li")) > 10 && (await noHorizontalScroll(size.width)));
          await shoot(`einstellungen-status-${size.width}${suffix}`);
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
          check(`${label}: vier Reiter nebeneinander, Schlüssel gewählt`,
            JSON.stringify(await js<string[]>(`[...document.querySelectorAll(".settings-tab")].map(t => t.textContent)`)) === JSON.stringify(["Agenten", "Modelle", "Schlüssel", "Status"]) &&
              (await js<boolean>(`(() => { const t = [...document.querySelectorAll(".settings-tab")].map(t => t.getBoundingClientRect().top); return t.every(x => Math.abs(x - t[0]) < 1); })()`)) &&
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
          abortClaudeCalls: key => abortExecutions(key),
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
          abortClaudeCalls: key => abortExecutions(key),
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

try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");

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
  // Seit Issue #29 legt Enter ein Telegram-Topic an; ohne Topic-Verwaltung: Meldung statt Web-Gespräch
  check("Neues Gespräch ohne Topic-Verwaltung: Meldung, Verlauf bleibt",
    (await waitFor(`[...document.querySelectorAll(".msg-error")].some(m => m.textContent.includes("Topics verwalten ist nicht eingerichtet"))`)) &&
    (await count(".msg-user")) > 0);
  const list = await (await fetch(`${base}/api/conversations`, { headers: { cookie } })).json();
  check("Neues Gespräch: kein Web-Gespräch auf dem Server angelegt", list.conversations.length === 1);
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
  await toolApprovalChecks();
  await reviewChecks();
  await footerChecks();
  await topicChecks();
  await settingsChecks();
  await agentsManageChecks();
  await modelsStatusChecks();
  await keysChecks();
  await updateChecks();

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
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  ws.close();
  proxy.stop(true);
  chrome.kill();
  await chrome.exited;
  await server.stop();
  await demo.stop();
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
