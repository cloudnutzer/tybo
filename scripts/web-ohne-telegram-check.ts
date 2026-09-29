#!/usr/bin/env bun
/**
 * Browser-Durchlauf „WebUI ohne Telegram" (Issue #227) mit Headless-Chrome
 * über das DevTools-Protokoll. Kein Teil von `bun run check` (braucht
 * Chrome), wird von Hand gestartet:
 *
 *   bun run scripts/web-ohne-telegram-check.ts
 *   bun run scripts/web-ohne-telegram-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *
 * Isolierte Attrappe statt `bun run web:dev` (das nutzt unabhängig vom Token
 * Telegram-Attrappen und liest keine notify-Meldungen ein): ein gemeinsamer
 * Nachrichtenspeicher im Speicher mit Hook wie saveDisplayOnlyMessage, darauf
 * die echte Outbox ohne Bot-Token (sendAndRecord), der echte
 * `bun run notify`-Ablauf (runNotify aus scripts/notify.ts, mit und ohne
 * TYBO_CONVERSATION_ID), der Direktchat unter der Chat-ID "web"
 * (createTelegramSource/createTelegramChat/createTelegramLiveFeed wie in
 * bot.ts ohne Telegram), die Übernahme in Web-Gespräche (webNotices), das
 * echte Rückfragen-Register mit Goal-Engine und der echte Web-Server. Claude
 * ist eine Attrappe. Keine .env wird gelesen oder geschrieben, src/bot.ts
 * wird nicht geladen, alles liegt in einem temporären Verzeichnis.
 *
 * Geprüft: Direktchat ohne Topics und ohne Spiegeln, neues Gespräch mit
 * Agentenwahl (Web-Gespräch statt Topic), Meldung von notify im Direktchat
 * und im Web-Gespräch, Goal-„Weiter?"-Frage mit Knöpfen, im Browser
 * entschieden. Nie ein Aufruf an api.telegram.org.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNotify } from "./notify";
import { isWebChatId } from "../src/lib/channels";
import { onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
import type { SavedMessageEvent } from "../src/lib/convex";
import { createTelegramGoalStatus, GOAL_NOTICE_SOURCE } from "../src/lib/goal-actions";
import { createGoalChoices, GOAL_NO_BUTTONS_HINT } from "../src/lib/goal-choices";
import { clearGoal, configureGoalStore, getGoal, initGoalEngine, isGoalLoopRunning, onGoalChange, setGoal, startGoalWork, updateGoal } from "../src/lib/goal-engine";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import type { HistoryRow, Message } from "../src/lib/supabase";
import { createTelegramChoices } from "../src/lib/telegram-choices";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createTelegramChat } from "../src/web/bot-turn";
import { createChoicePort } from "../src/web/choices";
import { register } from "../tests/choices-fixture";
import { createFakeChat } from "../src/web/fake-chat";
import { createWebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { WebNoticeRow } from "../src/web/web-notices";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = "browser-check-passwort";
const SHOTS = process.argv.includes("--screenshots");
const OUT = join(import.meta.dir, "..", "docs", "webui", "screenshots");
const REPLY = "Gern. Ohne Telegram läuft alles hier im Browser.";

const dir = await mkdtemp(join(tmpdir(), "tybo-ohne-telegram-browser-"));
configureGoalStore({ file: join(dir, "goals.json") });
setChoicesFileForTests(join(dir, "choices.json"));

// --- Gemeinsamer Nachrichtenspeicher (wie Supabase messages) ---------------
const rows: (WebNoticeRow & HistoryRow)[] = [];
const hooks = new Set<(event: SavedMessageEvent) => void | Promise<void>>();
let rowNo = 0;
async function saveRow(m: { chat_id: string; role: string; content: string; metadata?: Record<string, unknown> }): Promise<boolean> {
  const metadata = { ...(m.metadata ?? {}), ...(m.metadata?.display_only ? { msgId: crypto.randomUUID() } : {}) };
  const created_at = new Date(Date.now() + ++rowNo).toISOString();
  rows.push({ id: String(rowNo), chat_id: m.chat_id, created_at, role: m.role, content: m.content, metadata } as any);
  for (const hook of [...hooks]) await hook({ chatId: m.chat_id, role: m.role as "assistant", content: m.content, metadata, createdAt: created_at });
  return true;
}
function onMessageSaved(listener: (event: SavedMessageEvent) => void | Promise<void>) {
  hooks.add(listener);
  return () => void hooks.delete(listener);
}

// --- Outbox ohne Telegram (kein Bot-Token, keine Nutzer-ID) -----------------
const telegramCalls: string[] = [];
const outboxDeps: OutboxDeps = {
  botToken: "",
  userId: "",
  // Übrig gebliebene Gruppe aus einer alten Einrichtung: ohne Token zählt sie nicht
  groupId: "-1001234567890",
  outboxDir: join(dir, "outbox"),
  fetch: async url => {
    telegramCalls.push(String(url));
    return new Response("{}", { status: 500 });
  },
  record: (m: Message) => saveRow(m as any),
  log: () => {},
  newId: () => crypto.randomUUID(),
};
const notifyLines: string[] = [];
const notify = (argv: string[], env: Record<string, string | undefined> = {}) =>
  runNotify(argv, () => outboxDeps, { out: l => void notifyLines.push(l), err: l => void notifyLines.push(l) }, env);

// --- Direktchat unter "web" ohne Spiegeln -----------------------------------
const mirrored: unknown[] = [];
const telegramChat = createTelegramChat({
  userId: "web",
  groupId: () => null,
  agentForTopic: () => undefined,
  runStreamingTurn: async () => {
    await Bun.sleep(600);
    return REPLY;
  },
  saveMessage: m => saveRow(m as any),
  processIntents: async () => {},
  abortEngineCalls: () => 0,
  isShuttingDown: () => false,
  scheduleRestartCheck: () => {},
  sendPlain: async (...args) => void mirrored.push(args),
  sendAsAgent: async (...args) => void mirrored.push(args),
  log: () => {},
});
const source = createTelegramSource({
  userId: "web",
  groupId: () => null,
  topicNames: async () => ({}),
  topicMapping: () => ({}),
  history: async chatId => rows.filter(r => r.chat_id === chatId),
  activity: async () => [],
  log: () => {},
});
const live = createTelegramLiveFeed({ userId: "web", groupId: () => null, onMessageSaved, log: () => {} });

// --- Rückfragen und Goal-Engine ohne Telegram --------------------------------
const choices = createChoicePort({ register, userId: "web", groupId: () => null, log: () => {} });
const telegramChoices = createTelegramChoices({
  api: {} as any,
  owner: "",
  telegram: () => false,
  send: input => sendAndRecord(input, outboxDeps),
  log: () => {},
});
const goalChoices = createGoalChoices({ getGoal, abort: () => 0, sendChoice: c => telegramChoices.sendChoice(c), log: () => {} });
const offDecided = onChoiceDecided("goal", goalChoices.handler);
const offGoal = onGoalChange(goalChoices.listener);
let pendingTurn: ((r: { text: string; aborted: boolean }) => void) | null = null;
let goalTurns = 0;
initGoalEngine({
  callAgent: () => {
    goalTurns++;
    return new Promise(resolve => {
      pendingTurn = resolve;
    });
  },
  sendAsAgent: async () => {},
  // Wie in bot.ts: Web-Chat-IDs gehen nie an Telegram, Statusmeldungen hält record für die WebUI fest
  sendStatus: createTelegramGoalStatus({
    send: async (...args) => void (isWebChatId(args[0]) || mirrored.push(args)),
    ask: (target, text) => goalChoices.ask(target, text),
    noButtonsHint: GOAL_NO_BUTTONS_HINT,
    record: (target, message) =>
      saveRow({ chat_id: target.chatId, role: "assistant", content: message.text, metadata: { display_only: true, source: GOAL_NOTICE_SOURCE } }),
  }),
});

// --- Web-Server ---------------------------------------------------------------
const store = new ConversationStore({ dir: join(dir, "web") });
await store.load();
const server = await createWebServer(
  { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
  {
    sessionFile: join(dir, "sessions.json"),
    dataDir: join(dir, "web"),
    conversationStore: store,
    chat: createFakeChat({ delayMs: 600, stepMs: 200 }),
    telegram: source,
    telegramChat,
    telegramLive: live,
    choices,
    webNotices: { page: async ids => rows.filter(r => ids.includes(r.chat_id)), onMessageSaved },
    cliTokenFile: join(dir, "cli-token"),
    log: () => {},
  }
);
const base = server.url.replace(/\/$/, "");

// --- Chrome ---------------------------------------------------------------------
const debugPort = 9950 + Math.floor(Math.random() * 40);
const chrome = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "chrome")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank"],
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
const problems: string[] = [];
ws.addEventListener("message", event => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails?.text ?? "Ausnahme");
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") problems.push(msg.params.entry.text);
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
async function viewport(width: number) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 1, mobile: width < 600 });
}
async function scheme(value: "light" | "dark") {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
}
async function pressKey(key: string, code: string, keyCode: number, text?: string) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}
async function typeAndEnter(text: string) {
  await js(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
  await pressKey("Enter", "Enter", 13, "\r");
}
const shown = (id: string) => `((e) => !!e && !e.hidden && e.getClientRects().length > 0)(document.getElementById("${id}"))`;
const count = (sel: string) => js<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const noHorizontalScroll = (width: number) => js<boolean>(`document.documentElement.scrollWidth <= ${width} && document.body.scrollWidth <= ${width}`);
const openEntry = async (id: string) => {
  await waitFor(`document.querySelector('.conversation[data-id="${id}"]')`);
  await js(`document.querySelector('.conversation[data-id="${id}"]').click()`);
};
/** Schublade der Seitenleiste auf dem Handy zu, damit der Verlauf zu sehen ist */
const drawerOpen = `document.getElementById("sidebar").getAttribute("data-open") === "true"`;
const closeDrawer = () => js(`${drawerOpen} && document.getElementById("menu").click()`);

async function shoot(name: string) {
  if (!SHOTS) return;
  await Bun.sleep(300);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`Bild ${name}.png`);
}
/** Jede Größe und jedes Farbschema einmal: 1280/390, hell/dunkel; prepare stellt den Zustand her */
async function shootAll(name: string, prepare: (width: number) => Promise<void>) {
  for (const width of [1280, 390]) {
    for (const s of ["light", "dark"] as const) {
      await viewport(width);
      await scheme(s);
      await prepare(width);
      check(`${name} ${width} px ${s === "dark" ? "dunkel" : "hell"}: kein seitliches Scrollen`, await noHorizontalScroll(width));
      await shoot(`${name}-${width}${s === "dark" ? "-dunkel" : ""}`);
    }
  }
  await viewport(1280);
  await scheme("light");
}

async function apiCookie(): Promise<string> {
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { origin: base }, body: JSON.stringify({ password: PASSWORD }) });
  return login.headers.get("set-cookie")!.split(";")[0];
}

try {
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await viewport(1280);
  await scheme("light");
  const cookie = await apiCookie();

  // --- Anmelden ------------------------------------------------------------------
  await goto(`${base}/login`);
  await waitFor(`document.getElementById("password")`);
  await js(`document.getElementById("password").value = ${JSON.stringify(PASSWORD)}`);
  await js(`document.getElementById("login-form").requestSubmit()`);
  check("Anmeldung führt zum Chat", await waitFor(`location.pathname === "/" && document.getElementById("input")`, 10000));

  // --- Direktchat ohne Telegram ----------------------------------------------------
  const list = await (await fetch(`${base}/api/conversations`, { headers: { cookie } })).json();
  check("Server: Direktchat dm, keine Topics, keine Gruppe",
    list.telegram?.dm?.id === "dm" && list.telegram.topics.length === 0 && list.telegram.chatId === undefined, JSON.stringify(list.telegram));
  check("Seitenleiste: Direktchat da, keine Topics", (await waitFor(`document.querySelector('.conversation[data-id="dm"]')`)) && (await count('.conversation[data-id^="topic-"]')) === 0);
  await openEntry("dm");
  check("Direktchat offen mit General", await waitFor(`document.getElementById("agent-name").textContent === "General"`));
  await typeAndEnter("Hallo, geht das ohne Telegram?");
  check("Antwort im Direktchat", await waitFor(`[...document.querySelectorAll(".msg-assistant")].some(m => m.textContent.includes(${JSON.stringify(REPLY)}))`, 10000));
  await waitFor(`document.getElementById("activity").hidden`, 10000);
  check("Direktchat: gespeichert unter der Chat-ID web", rows.filter(r => r.chat_id === "web").map(r => r.role).join(",") === "user,assistant");
  check("Direktchat: nichts nach Telegram gespiegelt", mirrored.length === 0);

  // --- Meldung von bun run notify in den Direktchat --------------------------------
  const dmCode = await notify(["--source", "briefing", "--text", "Guten Morgen. Heute stehen **drei Termine** an."]);
  check("notify ohne Ziel: Exit 0, Hinweis auf die WebUI", dmCode === 0 && notifyLines.some(l => l.includes("WebUI")), notifyLines.join(" | "));
  check("notify ohne Ziel: Meldung im Direktchat (live)",
    await waitFor(`[...document.querySelectorAll(".msg-notice")].some(m => m.textContent.includes("drei Termine") && m.querySelector(".notice-source")?.textContent.includes("Briefing"))`));
  await shootAll("ohne-telegram-direktchat", async () => {
    await closeDrawer();
    await js(`document.getElementById("chat-log").scrollTop = 1e6`);
  });

  // --- Neues Gespräch mit Agentenwahl -----------------------------------------------
  const before = (await (await fetch(`${base}/api/conversations`, { headers: { cookie } })).json()).conversations.length;
  const openPicker = async (width: number) => {
    if (width < 600) {
      await js(`${drawerOpen} || document.getElementById("menu").click()`);
      await Bun.sleep(300);
    }
    if (!(await js<boolean>(shown("agent-picker")))) await js(`document.getElementById("new-chat").click()`);
    await waitFor(`${shown("agent-picker")} && document.activeElement?.dataset.agentOption`);
  };
  await shootAll("ohne-telegram-neues-gespraech", async width => {
    await pressKey("Escape", "Escape", 27);
    await closeDrawer();
    await Bun.sleep(200);
    await openPicker(width);
  });
  await viewport(1280);
  await pressKey("Escape", "Escape", 27);
  await openPicker(1280);
  check("Neues Gespräch: Agentenauswahl offen, alle Agenten", (await count("#agent-options .agent-option")) === 8);
  await pressKey("ArrowDown", "ArrowDown", 40);
  check("Pfeil runter markiert Research", await waitFor(`document.activeElement?.dataset.agentOption === "research"`));
  await pressKey("Enter", "Enter", 13, "\r");
  check("Enter: Web-Gespräch mit Research offen, keine Fehlermeldung",
    (await waitFor(`document.getElementById("agent-name").textContent === "Research" && !${shown("agent-picker")}`)) && (await count(".msg-error")) === 0);
  const conversations = (await (await fetch(`${base}/api/conversations`, { headers: { cookie } })).json()).conversations as any[];
  const created = conversations.find(c => c.agent === "research");
  check("Server: ein Web-Gespräch mehr, Agent research", conversations.length === before + 1 && !!created, JSON.stringify(conversations));
  await typeAndEnter("Recherchiere bitte die Bahnpreise.");
  check("Antwort im Web-Gespräch", await waitFor(`document.querySelectorAll(".msg-assistant").length >= 1 && document.getElementById("activity").hidden`, 10000));

  // --- Meldung von bun run notify mit TYBO_CONVERSATION_ID ---------------------------
  notifyLines.length = 0;
  const convCode = await notify(["--source", "job", "--text", "Job „Bahnpreise“ fertig: günstigster Tag ist Dienstag."], { TYBO_CONVERSATION_ID: created.id });
  check("notify mit TYBO_CONVERSATION_ID: Exit 0", convCode === 0, notifyLines.join(" | "));
  check("notify: festgehalten unter web:<uuid>", rows.some(r => r.chat_id === `web:${created.id}` && r.content.includes("Dienstag")));
  check("notify: Meldung im offenen Web-Gespräch (live), Absender Job",
    await waitFor(`[...document.querySelectorAll(".msg-notice")].some(m => m.textContent.includes("Dienstag") && m.querySelector(".notice-source")?.textContent.includes("Job"))`));
  const stored = await store.getMessages(created.id);
  check("notify: genau einmal im Gesprächsspeicher", stored.filter(m => m.text.includes("Dienstag")).length === 1);
  check("notify: nicht im Direktchat", !rows.some(r => r.chat_id === "web" && r.content.includes("Dienstag")));
  await shootAll("ohne-telegram-meldung", async () => {
    await closeDrawer();
    await js(`document.getElementById("chat-log").scrollTop = 1e6`);
  });

  // --- Goal-„Weiter?“ als Rückfrage im Direktchat ------------------------------------
  const key = "dm:web";
  await setGoal({ sessionKey: key, chatId: "web", agentName: "general", goal: "Umzugs-Checkliste fertig machen" });
  await updateGoal(key, { turnsUsed: 3, maxTurns: 3 });
  await startGoalWork(key);
  await goalChoices.settled();
  await goto(`${base}/`);
  await openEntry("dm");
  const box = `[...document.querySelectorAll(".choice")].at(-1)`;
  check("Rückfrage im Direktchat mit Knöpfen",
    await waitFor(`${box} && ${box}.querySelectorAll(".choice-button").length === 2 && ${box}.closest(".msg-notice")?.textContent.includes("Weitermachen?")`));
  check("Rückfrage: nichts an Telegram, keine Statusmeldung ohne Knöpfe", telegramCalls.length === 0 && mirrored.length === 0);
  await shootAll("ohne-telegram-rueckfrage", async () => {
    await closeDrawer();
    await js(`${box}.scrollIntoView({ block: "center" })`);
  });
  await viewport(1280);
  await js(`${box}.querySelector(".choice-button").click()`);
  check("Weiter im Browser: Rückfrage erledigt",
    await waitFor(`(${box}.querySelector(".choice-status")?.textContent || "").startsWith("Erledigt: Weiter") && !${box}.querySelector(".choice-button")`));
  check("Weiter: Ziel läuft mit 5 Turns mehr", await waitFor(`true`) && (await (async () => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      const g = await getGoal(key);
      if (g?.maxTurns === 8 && goalTurns >= 1) return true;
      await Bun.sleep(20);
    }
    return false;
  })()));
  await shootAll("ohne-telegram-rueckfrage-erledigt", async () => {
    await closeDrawer();
    await js(`${box}.scrollIntoView({ block: "center" })`);
  });

  // --- Abschluss ---------------------------------------------------------------------
  check("nie ein Aufruf an api.telegram.org", telegramCalls.length === 0, telegramCalls.join(" | "));
  check("nie nach Telegram gespiegelt", mirrored.length === 0);
  const csp = problems.filter(p => /Content Security Policy|Refused/i.test(p));
  check("keine CSP-Verstöße", csp.length === 0, csp.join(" | "));
  const errors = problems.filter(p => !/Failed to load resource|Content Security Policy|Refused/i.test(p));
  check("keine Skriptfehler", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await clearGoal("dm:web").catch(() => {});
  (pendingTurn as ((r: { text: string; aborted: boolean }) => void) | null)?.({ text: "", aborted: true });
  for (let i = 0; i < 100 && isGoalLoopRunning("dm:web"); i++) await Bun.sleep(20);
  offDecided();
  offGoal();
  ws.close();
  chrome.kill();
  await chrome.exited;
  await server.stop();
  setChoicesFileForTests(null);
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
