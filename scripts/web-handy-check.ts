#!/usr/bin/env bun
/**
 * Browser-Durchlauf „tybo als App auf dem Handy" (Issue #229) mit
 * Headless-Chrome über das DevTools-Protokoll. Kein Teil von `bun run check`
 * (braucht Chrome), wird von Hand gestartet:
 *
 *   bun run scripts/web-handy-check.ts
 *   bun run scripts/web-handy-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *
 * Eigener Web-Server im Speicher (Gesprächsspeicher, Upload-Ablage und
 * Claude-Attrappe in einem temporären Verzeichnis), keine .env, src/bot.ts
 * wird nicht geladen. Der Service Worker läuft echt (127.0.0.1 gilt als
 * sicherer Kontext).
 *
 * Geprüft:
 * - Teilen: ein echtes Formular (POST multipart an /teilen, wie das
 *   Teilen-Menü von Android) mit Text, Link, zwei Bildern und einer nicht
 *   erlaubten Datei. Der Service Worker fängt ab, der Server sieht den POST
 *   nie, die App übernimmt Entwurf und zwei Anhänge ins offene Gespräch und
 *   sendet nichts; Hinweis für die abgewiesene Datei; „Anderes Gespräch".
 * - Kamera-Menü (Touch): „Foto aufnehmen" öffnet das Feld mit capture, das
 *   Foto wird Anhang; am Rechner öffnet die Büroklammer direkt die Dateiwahl.
 * - Tastatur: verkleinerter visualViewport wie auf dem iPhone (Attrappe, die
 *   Headless-Chrome hat keine Bildschirmtastatur). Eingabe und letzte
 *   Nachricht bleiben sichtbar, hochgescrollt bleibt die Leseposition.
 * - Schublade: Zurück schließt sie, Wischen vom linken Rand öffnet sie.
 * - Querformat 844×390 ohne seitliches Scrollen, Eingabe sichtbar.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeChat } from "../src/web/fake-chat";
import { createWebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { UploadStore } from "../src/web/uploads";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = "browser-check-passwort";
const SHOTS = process.argv.includes("--screenshots");
const OUT = join(import.meta.dir, "..", "docs", "webui", "screenshots");
/** Höhe der simulierten Bildschirmtastatur (iPhone, Hochformat) */
const KEYBOARD = 336;

const dir = await mkdtemp(join(tmpdir(), "tybo-handy-browser-"));

// --- Web-Server mit zwei Gesprächen -----------------------------------------------
const store = new ConversationStore({ dir: join(dir, "web") });
await store.load();
const long = await store.createConversation("general");
await store.renameConversation(long.id, "Urlaubsplanung Nordsee");
for (let i = 1; i <= 8; i++) {
  await store.appendMessage(long.id, { role: "user", text: `Frage ${i}: Was brauchen wir noch für den Urlaub?` });
  await store.appendMessage(long.id, {
    role: "assistant",
    text: i === 4
      ? "Hier die Packliste als Tabelle:\n\n| Was | Wer | Erledigt |\n|---|---|---|\n| Regenjacken für alle vier Personen | Alex | nein |\n| Fahrräder aufs Dach | Mia | ja |\n\n```\nabfahrt --datum 2026-10-03 --uhrzeit 07:30 --route a1-a7-a23 --pause bremen\n```"
      : `Antwort ${i}: Denkt an Regenjacken, Sonnencreme und die Fahrradkarten.`,
  });
}
await store.appendMessage(long.id, { role: "assistant", text: "Letzte Nachricht: Abfahrt Samstag um 7:30." });
const other = await store.createConversation("research");
await store.renameConversation(other.id, "Bahnpreise");
await store.appendMessage(other.id, { role: "user", text: "Was kostet die Fahrt nach Husum?" });
await store.appendMessage(other.id, { role: "assistant", text: "Mit Sparpreis etwa 39 Euro." });

const serverPaths: string[] = [];
const server = await createWebServer(
  { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
  {
    sessionFile: join(dir, "sessions.json"),
    dataDir: join(dir, "web"),
    conversationStore: store,
    chat: createFakeChat({ delayMs: 400, stepMs: 200 }),
    uploads: new UploadStore({ dir: join(dir, "uploads") }),
    cliTokenFile: join(dir, "cli-token"),
    log: () => {},
  }
);
const base = server.url.replace(/\/$/, "");
// Jede Anfrage an den Server mitschreiben: POST /teilen darf nie ankommen
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    serverPaths.push(`${req.method} ${url.pathname}`);
    const headers = new Headers(req.headers);
    headers.set("host", new URL(base).host);
    if (headers.has("origin")) headers.set("origin", base);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const res = await fetch(base + url.pathname + url.search, { method: req.method, headers, body, redirect: "manual" });
    const out = new Headers(res.headers);
    // fetch entpackt schon; die Angaben zur Kodierung passen dann nicht mehr
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
  },
});
const front = `http://127.0.0.1:${proxy.port}`;

// --- Chrome ------------------------------------------------------------------------
const debugPort = 9990 + Math.floor(Math.random() * 9);
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
const chooserEvents: { backendNodeId: number; mode: string }[] = [];
ws.addEventListener("message", event => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails?.text ?? "Ausnahme");
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") problems.push(msg.params.entry.text);
  if (msg.method === "Page.fileChooserOpened") chooserEvents.push(msg.params);
});
function cdp(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, msg => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
  );
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
    await Bun.sleep(50);
  }
  return false;
}
async function goto(url: string) {
  await cdp("Page.navigate", { url });
  await Bun.sleep(150);
  await waitFor(`document.readyState === "complete"`);
}
async function reload() {
  await cdp("Page.reload", {});
  await Bun.sleep(150);
  await waitFor(`document.readyState === "complete" && document.getElementById("input")`);
  await Bun.sleep(300);
}
async function viewport(width: number, height = width < 600 ? 844 : 800) {
  const mobile = width < 1000;
  await cdp("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile,
    ...(mobile ? { screenOrientation: width > height ? { type: "landscapePrimary", angle: 90 } : { type: "portraitPrimary", angle: 0 } } : {}),
  });
}
/** Touch-Zeiger (pointer: coarse); app.js liest ihn beim Start, danach neu laden */
async function touch(enabled: boolean) {
  await cdp("Emulation.setTouchEmulationEnabled", enabled ? { enabled, maxTouchPoints: 5 } : { enabled });
}
async function scheme(value: "light" | "dark") {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
}
async function pressKey(key: string, code: string, keyCode: number) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}
const shown = (id: string) => `((e) => !!e && !e.hidden && e.getClientRects().length > 0)(document.getElementById("${id}"))`;
const count = (sel: string) => js<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const noHorizontalScroll = (width: number) => js<boolean>(`document.documentElement.scrollWidth <= ${width} && document.body.scrollWidth <= ${width}`);
const drawerOpen = `document.getElementById("sidebar").getAttribute("data-open") === "true"`;
const closeDrawer = async () => {
  if (await js<boolean>(drawerOpen)) {
    await js(`document.getElementById("scrim").click()`);
    await Bun.sleep(350);
  }
};
const openEntry = async (id: string) => {
  await waitFor(`document.querySelector('.conversation[data-id="${id}"]')`);
  await js(`document.querySelector('.conversation[data-id="${id}"]').click()`);
  await waitFor(`document.querySelectorAll("#chat-log .msg").length > 0`);
};
/** Anhänge über der Eingabe (Chips) */
const chips = () => count("#attachments > li");

async function shoot(name: string) {
  if (!SHOTS) return;
  await Bun.sleep(350);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`Bild ${name}.png`);
}
/** 1280/390, hell/dunkel; prepare stellt den Zustand her */
async function shootAll(name: string, prepare: (width: number) => Promise<void>, widths = [1280, 390]) {
  for (const width of widths) {
    for (const s of ["light", "dark"] as const) {
      await viewport(width);
      await scheme(s);
      await prepare(width);
      check(`${name} ${width} px ${s === "dark" ? "dunkel" : "hell"}: kein seitliches Scrollen`, await noHorizontalScroll(width));
      await shoot(`${name}-${width}${s === "dark" ? "-dunkel" : ""}`);
    }
  }
  await scheme("light");
}

/** Kleines PNG aus einem Canvas, als File im Seitenkontext */
const pngFile = (name: string, color: string) =>
  `new Promise(r => { const c = document.createElement("canvas"); c.width = 64; c.height = 48; const g = c.getContext("2d"); g.fillStyle = ${JSON.stringify(color)}; g.fillRect(0, 0, 64, 48); c.toBlob(b => r(new File([b], ${JSON.stringify(name)}, { type: "image/png" })), "image/png"); })`;

/** Wie das Teilen-Menü von Android: ein POST multipart an /teilen als Seitenwechsel */
async function share(fields: Record<string, string>, files: string[]) {
  await js(`(async () => {
    const form = document.createElement("form");
    form.method = "post";
    form.enctype = "multipart/form-data";
    form.action = "/teilen";
    for (const [name, value] of Object.entries(${JSON.stringify(fields)})) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }
    const input = document.createElement("input");
    input.type = "file";
    input.name = "dateien";
    input.multiple = true;
    const list = new DataTransfer();
    for (const file of await Promise.all([${files.join(",")}])) list.items.add(file);
    input.files = list.files;
    form.append(input);
    document.body.append(form);
    form.submit();
  })()`);
  await Bun.sleep(400);
  await waitFor(`document.readyState === "complete" && document.getElementById("input")`);
}

/** Attrappe für window.visualViewport: __tyboKeyboard(px, top) verkleinert den sichtbaren Bereich wie die iOS-Tastatur */
const VIEWPORT_FAKE = `(() => {
  const target = new EventTarget();
  let keyboard = 0;
  let top = 0;
  Object.defineProperties(target, {
    height: { get: () => window.innerHeight - keyboard },
    width: { get: () => window.innerWidth },
    offsetTop: { get: () => top },
    offsetLeft: { get: () => 0 },
    pageTop: { get: () => window.scrollY + top },
    pageLeft: { get: () => window.scrollX },
    scale: { get: () => 1 },
  });
  Object.defineProperty(window, "visualViewport", { get: () => target, configurable: true });
  window.__tyboKeyboard = (px, offset = 0) => {
    keyboard = px;
    top = offset;
    target.dispatchEvent(new Event("resize"));
    target.dispatchEvent(new Event("scroll"));
  };
})()`;

/** Graue Fläche an der Stelle der Tastatur, nur fürs Bild */
const keyboardOverlay = (px: number) => `(() => {
  let k = document.getElementById("fake-keyboard");
  if (!k) { k = document.createElement("div"); k.id = "fake-keyboard"; document.body.append(k); }
  k.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:${px}px;background:#8e939b;opacity:.92;z-index:2147483647;display:flex;align-items:center;justify-content:center;color:#fff;font:600 15px system-ui";
  k.textContent = "Bildschirmtastatur (simuliert)";
})()`;
const removeOverlay = `document.getElementById("fake-keyboard")?.remove()`;

try {
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: VIEWPORT_FAKE });
  await viewport(1280);
  await scheme("light");

  // --- Anmelden, Service Worker aktiv ---------------------------------------------------
  await goto(`${front}/login`);
  await waitFor(`document.getElementById("password")`);
  await js(`document.getElementById("password").value = ${JSON.stringify(PASSWORD)}`);
  await js(`document.getElementById("login-form").requestSubmit()`);
  check("Anmeldung führt zum Chat", await waitFor(`location.pathname === "/" && document.getElementById("input")`, 10000));
  await js(`navigator.serviceWorker.ready.then(() => true)`);
  await reload();
  check("Service Worker steuert die Seite", await waitFor(`navigator.serviceWorker.controller`, 8000));
  const manifest = await (await fetch(`${front}/manifest.webmanifest`)).json();
  check("Manifest: share_target POST multipart an /teilen",
    manifest.share_target?.action === "/teilen" && manifest.share_target.method === "POST" && manifest.share_target.enctype === "multipart/form-data");

  // --- Teilen -----------------------------------------------------------------------
  await openEntry(long.id);
  await js(`(() => { const i = document.getElementById("input"); i.value = "Mein Entwurf"; i.dispatchEvent(new Event("input")); })()`);
  const messagesBefore = (await store.getMessages(long.id)).length;
  serverPaths.length = 0;
  await share(
    { title: "Fährplan Nordstrand", text: "Abfahrten im Oktober", url: "https://example.org/faehre" },
    [pngFile("strand.png", "#3b82f6"), pngFile("duene.png", "#f59e0b"), `Promise.resolve(new File(["x"], "notiz.exe", { type: "application/x-msdownload" }))`]
  );
  check("Teilen: Server sieht den POST /teilen nie", !serverPaths.some(p => p.includes("/teilen") && p.startsWith("POST")), serverPaths.join(" | "));
  check("Teilen: Zeile „Geteilt“ über der Eingabe", await waitFor(`${shown("share-note")} && document.getElementById("share-text").textContent.includes("Geteilt")`),
    await js<string>(`document.getElementById("share-text").textContent`));
  check("Teilen: zwei Bilder als Anhänge", await waitFor(`document.querySelectorAll("#attachments > li").length === 2`), String(await chips()));
  const draft = await js<string>(`document.getElementById("input").value`);
  check("Teilen: Entwurf hängt an den vorhandenen an (Text und Link)",
    draft.startsWith("Mein Entwurf") && draft.includes("Abfahrten im Oktober") && draft.includes("https://example.org/faehre"), JSON.stringify(draft));
  check("Teilen: Hinweis für die nicht erlaubte Datei", await waitFor(`${shown("attach-note")} && document.getElementById("attach-note").textContent.includes("notiz.exe")`),
    await js<string>(`document.getElementById("attach-note").textContent`));
  check("Teilen: im offenen Gespräch", await js<boolean>(`location.hash !== "#/teilen"`) && (await js<string>(`document.getElementById("chat-title")?.textContent || document.title`)).includes("Urlaub"));
  await Bun.sleep(800);
  check("Teilen: nichts gesendet", (await store.getMessages(long.id)).length === messagesBefore);
  check("Teilen: Übergabe im Gerät gelöscht", await waitFor(`caches.open("tybo-teilen").then(c => c.keys()).then(k => k.length === 0)`));
  await shootAll("handy-teilen", async () => {
    await closeDrawer();
    await js(`document.getElementById("chat-log").scrollTop = 1e6`);
  });

  // „Anderes Gespräch“: Schublade auf, Wahl nimmt nur den geteilten Anteil mit
  await viewport(390);
  await closeDrawer();
  await js(`document.getElementById("share-move").click()`);
  check("Anderes Gespräch öffnet die Schublade", await waitFor(drawerOpen));
  await openEntry(other.id);
  check("Anderes Gespräch: Anhänge wandern mit", await waitFor(`document.querySelectorAll("#attachments > li").length === 2 && ${shown("share-note")}`));
  const moved = await js<string>(`document.getElementById("input").value`);
  check("Anderes Gespräch: nur der geteilte Text, eigener Entwurf bleibt zurück", moved.includes("Abfahrten im Oktober") && !moved.includes("Mein Entwurf"), JSON.stringify(moved));
  await openEntry(long.id);
  await closeDrawer();
  const left = await js<string>(`document.getElementById("input").value`);
  check("Altes Gespräch behält den eigenen Entwurf ohne geteilten Anteil", left.trim() === "Mein Entwurf" && (await chips()) === 0, JSON.stringify(left));
  // Aufräumen für die weiteren Schritte
  await js(`(() => { const i = document.getElementById("input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  await openEntry(other.id);
  await closeDrawer();
  await js(`(() => { document.querySelectorAll("#attachments button").forEach(b => b.click()); const i = document.getElementById("input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);

  // --- Kamera-Menü (Touch) --------------------------------------------------------------
  await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
  await touch(true);
  await viewport(390);
  await reload();
  await openEntry(other.id);
  await closeDrawer();
  await js(`document.getElementById("attach").click()`);
  check("Touch: Büroklammer öffnet das Menü", await waitFor(shown("attach-menu")));
  check("Touch: keine Dateiwahl ohne Menü", chooserEvents.length === 0);
  check("Menü: Foto aufnehmen und Datei wählen",
    (await js<string>(`document.getElementById("attach-menu").textContent`)).includes("Foto aufnehmen") &&
      (await js<string>(`document.getElementById("attach-menu").textContent`)).includes("Datei wählen"));
  for (const s of ["light", "dark"] as const) {
    await scheme(s);
    check(`Kamera-Menü 390 px ${s === "dark" ? "dunkel" : "hell"}: kein seitliches Scrollen`, await noHorizontalScroll(390));
    await shoot(`handy-kamera-menue-390${s === "dark" ? "-dunkel" : ""}`);
  }
  await scheme("light");
  await js(`document.getElementById("attach-camera").click()`);
  const cameraOpened = await (async () => {
    for (let i = 0; i < 60 && !chooserEvents.length; i++) await Bun.sleep(50);
    return chooserEvents.shift();
  })();
  const { node } = cameraOpened ? await cdp("DOM.describeNode", { backendNodeId: cameraOpened.backendNodeId }) : { node: null };
  const idAttr = (n: any) => (n?.attributes ?? []).reduce((acc: string, v: string, i: number, all: string[]) => (v === "id" ? all[i + 1] : acc), "");
  check("Foto aufnehmen öffnet das Feld mit capture=environment", idAttr(node) === "camera-input" && cameraOpened?.mode === "selectSingle", `${idAttr(node)} ${cameraOpened?.mode}`);
  check("Menü nach der Wahl zu", await waitFor(`!${shown("attach-menu")}`));
  if (cameraOpened) {
    const photo = join(dir, "foto.jpg");
    // Kleinstes gültiges JPEG-Gerüst reicht nicht für Vorschauen; ein PNG unter JPEG-Namen wäre falsch, also echtes PNG
    const png = Buffer.from(await js<string>(`${pngFile("foto.png", "#16a34a")}.then(f => f.arrayBuffer()).then(b => btoa(String.fromCharCode(...new Uint8Array(b))))`), "base64");
    await Bun.write(photo.replace(/\.jpg$/, ".png"), png);
    await cdp("DOM.setFileInputFiles", { backendNodeId: cameraOpened.backendNodeId, files: [photo.replace(/\.jpg$/, ".png")] });
    check("Aufgenommenes Foto wird Anhang", await waitFor(`document.querySelectorAll("#attachments > li").length === 1`));
    await js(`document.querySelectorAll("#attachments button").forEach(b => b.click())`);
  }
  // Am Rechner: Büroklammer öffnet direkt die Dateiwahl
  await touch(false);
  await viewport(1280);
  await reload();
  chooserEvents.length = 0;
  await js(`document.getElementById("attach").click()`);
  const fileOpened = await (async () => {
    for (let i = 0; i < 60 && !chooserEvents.length; i++) await Bun.sleep(50);
    return chooserEvents.shift();
  })();
  const fileNode = fileOpened ? (await cdp("DOM.describeNode", { backendNodeId: fileOpened.backendNodeId })).node : null;
  check("Rechner: Büroklammer öffnet direkt die Dateiwahl (mehrere Dateien), kein Menü",
    idAttr(fileNode) === "file-input" && fileOpened?.mode === "selectMultiple" && !(await js<boolean>(shown("attach-menu"))), `${idAttr(fileNode)} ${fileOpened?.mode}`);
  await cdp("Page.setInterceptFileChooserDialog", { enabled: false });

  // --- Schublade: Zurück und Wischen ------------------------------------------------------
  await touch(true);
  await viewport(390);
  await reload();
  await openEntry(long.id);
  await closeDrawer();
  const historyBefore = await js<number>(`history.length`);
  await js(`document.getElementById("menu").click()`);
  check("Menü öffnet die Schublade mit eigenem Verlaufseintrag", (await waitFor(drawerOpen)) && (await js<number>(`history.length`)) === historyBefore + 1);
  await shootAll("handy-schublade", async () => {
    if (!(await js<boolean>(drawerOpen))) await js(`document.getElementById("menu").click()`);
    await waitFor(drawerOpen);
  }, [390]);
  await js(`history.back()`);
  check("Zurück schließt die Schublade, Gespräch bleibt offen", (await waitFor(`!(${drawerOpen})`)) && (await count("#chat-log .msg")) > 0);
  const swipe = async (from: number, to: number, y = 420) => {
    await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
    for (let i = 1; i <= 6; i++) await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + ((to - from) * i) / 6, y: y + i }] });
    await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(400);
  };
  await swipe(6, 220);
  check("Wischen vom linken Rand öffnet die Schublade", await waitFor(drawerOpen, 2000));
  await swipe(300, 60);
  check("Wischen nach links schließt die Schublade", await waitFor(`!(${drawerOpen})`, 2000));
  await swipe(150, 360);
  check("Wischen aus der Mitte öffnet nichts", !(await js<boolean>(drawerOpen)));

  // --- Tastatur (verkleinerter visualViewport) ------------------------------------------
  await js(`document.getElementById("chat-log").scrollTop = 1e6`);
  await Bun.sleep(200);
  await js(`document.getElementById("input").focus()`);
  await js(`window.__tyboKeyboard(${KEYBOARD})`);
  await Bun.sleep(300);
  const visible = 844 - KEYBOARD;
  const geo = await js<any>(`(() => {
    const r = e => e.getBoundingClientRect();
    const composer = r(document.getElementById("composer"));
    const input = r(document.getElementById("input"));
    const msgs = document.querySelectorAll("#chat-log .msg");
    const last = r(msgs[msgs.length - 1]);
    const log = document.getElementById("chat-log");
    return { composerTop: composer.top, composerBottom: composer.bottom, inputTop: input.top, inputBottom: input.bottom,
      lastTop: last.top, lastBottom: last.bottom, appHeight: document.documentElement.style.getPropertyValue("--app-height"),
      atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 4 };
  })()`);
  check("Tastatur: Rahmen auf die sichtbare Höhe", geo.appHeight === `${visible}px`, geo.appHeight);
  check("Tastatur: Eingabe vollständig über der Tastatur", geo.inputTop >= 0 && geo.inputBottom <= visible && geo.composerBottom <= visible + 0.5, JSON.stringify(geo));
  check("Tastatur: letzte Nachricht sichtbar über der Eingabe", geo.atBottom && geo.lastBottom <= geo.composerTop + 1 && geo.lastBottom > 0, JSON.stringify(geo));
  for (const s of ["light", "dark"] as const) {
    await scheme(s);
    await js(keyboardOverlay(KEYBOARD));
    check(`Tastatur 390 px ${s === "dark" ? "dunkel" : "hell"}: kein seitliches Scrollen`, await noHorizontalScroll(390));
    await shoot(`handy-tastatur-390${s === "dark" ? "-dunkel" : ""}`);
    await js(removeOverlay);
  }
  await scheme("light");
  // iOS schiebt die Seite hoch: der Rahmen beginnt am sichtbaren Bereich
  await js(`window.__tyboKeyboard(${KEYBOARD}, 120)`);
  await Bun.sleep(200);
  check("Tastatur mit Verschiebung (offsetTop): Rahmen beginnt dort",
    (await js<string>(`document.documentElement.style.getPropertyValue("--app-top")`)) === "120px");
  await js(`window.__tyboKeyboard(0)`);
  await Bun.sleep(200);
  check("Tastatur zu: Rahmen wieder 100dvh", (await js<string>(`document.documentElement.style.getPropertyValue("--app-height")`)) === "");
  // Hochgescrollt gelesen: die Leseposition bleibt
  await js(`document.getElementById("chat-log").scrollTop = 200`);
  await Bun.sleep(200);
  const readTop = await js<number>(`document.getElementById("chat-log").scrollTop`);
  await js(`window.__tyboKeyboard(${KEYBOARD})`);
  await Bun.sleep(300);
  check("Tastatur: hochgescrollte Leseposition bleibt", Math.abs((await js<number>(`document.getElementById("chat-log").scrollTop`)) - readTop) <= 1);
  await js(`window.__tyboKeyboard(0)`);
  await js(`document.getElementById("input").blur()`);

  // --- Querformat 844×390 -----------------------------------------------------------------
  await cdp("Emulation.setSafeAreaInsetsOverride", { insets: { left: 47, right: 47, bottom: 21 } }).catch(() => {});
  for (const s of ["light", "dark"] as const) {
    await viewport(844, 390);
    await scheme(s);
    await closeDrawer();
    await js(`document.getElementById("chat-log").scrollTop = 1e6`);
    await Bun.sleep(200);
    const land = await js<any>(`(() => { const c = document.getElementById("composer").getBoundingClientRect(); return { bottom: c.bottom, top: c.top }; })()`);
    check(`Querformat ${s === "dark" ? "dunkel" : "hell"}: kein seitliches Scrollen, Eingabe sichtbar`,
      (await noHorizontalScroll(844)) && land.bottom <= 390.5 && land.top > 0, JSON.stringify(land));
    await shoot(`handy-querformat-844${s === "dark" ? "-dunkel" : ""}`);
  }
  await cdp("Emulation.setSafeAreaInsetsOverride", { insets: {} }).catch(() => {});
  await scheme("light");

  // --- Abschluss ------------------------------------------------------------------------
  check("nie ein POST /teilen am Server", !serverPaths.some(p => p === "POST /teilen"));
  const csp = problems.filter(p => /Content Security Policy|Refused/i.test(p));
  check("keine CSP-Verstöße", csp.length === 0, csp.join(" | "));
  const errors = problems.filter(p => !/Failed to load resource|Content Security Policy|Refused/i.test(p));
  check("keine Skriptfehler", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  ws.close();
  chrome.kill();
  await chrome.exited;
  proxy.stop(true);
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
