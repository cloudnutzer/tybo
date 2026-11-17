#!/usr/bin/env bun
/**
 * Browser-Durchlauf des Wizards für Sprachagenten (Issue #515) mit
 * Headless-Chrome über das DevTools-Protokoll. Kein Teil von `bun run check`
 * (braucht Chrome), wird von Hand gestartet, gegen ein laufendes web:dev mit
 * der Wizard-Attrappe (src/web/demo-voice-agent-wizard.ts):
 *
 *   WEB_ENABLED=true WEB_PORT=3199 WEB_PASSWORD=dev-passwort-123 bun run web:dev
 *   bun run scripts/web-sprachagent-wizard-check.ts
 *   bun run scripts/web-sprachagent-wizard-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *
 * Adresse und Passwort: --url (Standard http://127.0.0.1:3199) und
 * WEB_PASSWORD (Standard dev-passwort-123). Kein Anbieter, kein Job, kein
 * src/bot.ts: Vorschlag, Bauen, Stimmen und Hörprobe beantwortet die
 * Attrappe, gesteuert über Wörter im Satz („durchfallen“, „scheitern“,
 * „abbrechen“). Die Phasen nach dem Bauen laufen nach der Uhr des Servers
 * (WEB_DEV_WIZARD_STEP_MS, Standard 2000), auch bei geschlossener Seite.
 * Jeder Lauf nimmt eigene Kennungen, das Skript lässt sich gegen denselben
 * Server wiederholen.
 *
 * Geprüft: alle drei Vorlagen vom Satz bis „Bauen“ mit den passenden Feldern
 * und festen Regeln, Vorlagenwechsel ohne Verlust, Stimme mit Hörprobe der
 * gewählten Stimme, Datei hochladen, Autosave schon in Schritt 1 (Neuladen
 * vor dem ersten „Weiter“), halber Link bleibt gespeichert, Neuladen mitten
 * in Schritt 3 und Fortsetzen aus der Liste, Kennung ändern nach dem ersten Speichern,
 * Bauen im Hintergrund bei geschlossener Seite, bestandene und durchgefallene
 * Tests, „Sprechen“ nur mit Freischaltung und Web-Zugang, Ansehen ohne
 * Speichern nach dem Bauen, Fehlerzustände (Vorschlag gescheitert, Kennung
 * vergeben, Bauen abgelehnt, abgebrochen, Entwurf weg, Hörprobe nicht
 * möglich), Verwerfen mit Rückfrage und Tippflächen von mindestens 2,75 rem
 * bei 390 px.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { values } = parseArgs({ options: { screenshots: { type: "boolean" }, url: { type: "string" } }, strict: true });
const SHOTS = values.screenshots === true;
const FRONT = (values.url || "http://127.0.0.1:3199").replace(/\/$/, "");
const PASSWORD = process.env.WEB_PASSWORD || "dev-passwort-123";
const OUT = join(import.meta.dir, "..", "docs", "webui", "screenshots");
/** Eigene Kennungen je Lauf: Die Entwürfe der Attrappe bleiben bis zum Neustart des Servers */
const RUN = Date.now().toString(36).slice(-5);

try {
  const res = await fetch(`${FRONT}/login`, { redirect: "manual" });
  if (res.status >= 500) throw new Error(`Status ${res.status}`);
} catch (e) {
  console.error(`web:dev ist unter ${FRONT} nicht erreichbar (${e instanceof Error ? e.message : String(e)}). Start: WEB_ENABLED=true WEB_PORT=3199 WEB_PASSWORD=dev-passwort-123 bun run web:dev`);
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), "wizard-check-"));
const NOTES = join(dir, "notizen.md");
await writeFile(NOTES, "# Notizen\n\nRabatt nie ohne Gegenleistung.\n");

const debugPort = 9980 + Math.floor(Math.random() * 9);
const chrome = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "chrome")}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "--autoplay-policy=no-user-gesture-required", "about:blank"],
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
interface Sent {
  method: string;
  path: string;
  body: string;
}
const sent: Sent[] = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "Ausnahme");
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") problems.push(msg.params.entry.text);
  if (msg.method === "Fetch.requestPaused") onPaused(msg.params);
  if (msg.method === "Network.requestWillBeSent") {
    const r = msg.params.request;
    const url = new URL(r.url);
    if (url.pathname.startsWith("/api/voice-agents/wizard")) sent.push({ method: r.method, path: url.pathname, body: typeof r.postData === "string" ? r.postData : "" });
  }
});
function cdp(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result))));
}
/** Zurückgehaltene Anfrage (Fetch-Domäne): der erste PUT an held bleibt stehen, bis releasePuts(); alle anderen laufen */
let held: string | null = null;
const parked: string[] = [];
function onPaused(params: any) {
  const url = new URL(params.request.url);
  if (params.request.method === "PUT" && url.pathname === held && parked.length === 0) parked.push(params.requestId);
  else void cdp("Fetch.continueRequest", { requestId: params.requestId });
}
async function holdPuts(path: string) {
  held = path;
  await cdp("Fetch.enable", { patterns: [{ urlPattern: `*${path}*`, requestStage: "Request" }] });
}
async function releasePuts() {
  held = null;
  for (const requestId of parked.splice(0)) await cdp("Fetch.continueRequest", { requestId });
  await cdp("Fetch.disable");
}
const serverField = (kennung: string, field: string) =>
  js<string>(`fetch("/api/voice-agents/wizard/${kennung}", { credentials: "same-origin" }).then((r) => r.json()).then((b) => b.felder && b.felder[${JSON.stringify(field)}])`);
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
/** Ganze Seite, 1280 und 390 px, hell und dunkel */
async function shoot(name: string) {
  if (!SHOTS) return;
  for (const width of [1280, 390]) {
    for (const scheme of ["light", "dark"] as const) {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 1, mobile: width < 1000 });
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await Bun.sleep(150);
      const height = await js<number>(`Math.ceil(document.documentElement.scrollHeight)`);
      const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      const file = `${name}-${width}${scheme === "dark" ? "-dunkel" : ""}.png`;
      await Bun.write(join(OUT, file), Buffer.from(data, "base64"));
      console.log(`Bild ${file}`);
    }
  }
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await cdp("Emulation.clearDeviceMetricsOverride");
  await Bun.sleep(100);
}

// --- Helfer für die Seite ----------------------------------------------------------------
const q = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
const exists = (id: string) => js<boolean>(`!!${q(id)}`);
const shown = (id: string) => js<boolean>(`(e => !!e && !e.hidden && e.getClientRects().length > 0)(${q(id)})`);
const text = (id: string) => js<string>(`(e => e ? e.textContent : "")(${q(id)})`);
const value = (id: string) => js<string>(`(e => e ? e.value : "")(${q(id)})`);
const click = (id: string) => js(`${q(id)}.click()`);
const type = (id: string, v: string) => js(`(e => { e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); })(${q(id)})`);
const heading = () => text("vw-heading");
const onStep = (n: number, title: string) => waitFor(`(h => h && h.textContent === ${JSON.stringify(`Schritt ${n} von 5: ${title}`)})(${q("vw-heading")})`);
const wizardText = () => js<string>(`document.getElementById("va-wizard").innerText`);
const saved = () => waitFor(`${q("vw-save")} && ${q("vw-save")}.textContent === "Gespeichert."`, 6000);
const hash = () => js<string>(`location.hash`);
const next = () => click("vw-next");
const puts = () => sent.filter((r) => r.method === "PUT").length;
/** Wartet, bis die unfertigen Eingaben des Entwurfs beim Server so aussehen (JSON, "undefined" ohne) */
async function serverOpen(kennung: string, wanted: string, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const now = await js<string>(`fetch("/api/voice-agents/wizard/${kennung}", { credentials: "same-origin" }).then((r) => r.json()).then((b) => String(JSON.stringify(b.offen)))`);
    if (now === wanted) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** Höhen aller sichtbaren Bedienziele im Wizard bzw. in der Liste bei 390 px; zu kleine mit Namen */
async function smallTargets(scope: string): Promise<string[]> {
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await Bun.sleep(150);
  const small = await js<string[]>(`(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const root = document.querySelector(${JSON.stringify(scope)});
    const out = [];
    for (const e of root.querySelectorAll("button, a, select, input:not([type=radio]):not([type=checkbox]):not([type=file]), textarea, label.va-wizard-choice, label.va-wizard-check-label")) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.height < 2.75 * rem - 0.5) out.push((e.id || e.className || e.tagName) + " " + Math.round(r.height));
    }
    return out;
  })()`);
  const overflow = await js<number>(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  await cdp("Emulation.clearDeviceMetricsOverride");
  await Bun.sleep(100);
  return overflow > 0 ? [...small, `Seite ${overflow}px breiter als das Fenster`] : small;
}

/** Schritt 1 mit Satz und Vorschlag; setzt eine eigene Kennung für diesen Lauf */
async function startWizard(satz: string, kennung: string) {
  await goto(`${FRONT}/sprachagenten`);
  await waitFor(`(b => b && !b.hidden)(${q("va-new")})`);
  await click("va-new");
  await onStep(1, "Zweck");
  await type("vw-satz", satz);
  await click("vw-propose");
  await waitFor(`${q("vw-notice")} && /Vorschlag|Kein Vorschlag/.test(${q("vw-notice")}.textContent) && !${q("vw-propose")}.disabled`, 10000);
  await type("vw-kennung", kennung);
}

/** Phase des Entwurfs beim Server, an der Seite vorbei */
const phaseOf = (kennung: string) => js<string>(`fetch("/api/voice-agents/wizard/${kennung}/fortschritt", { credentials: "same-origin" }).then((r) => r.json()).then((b) => b.phase)`);
async function serverPhase(kennung: string, wanted: string[], timeoutMs = 30000): Promise<string> {
  const end = Date.now() + timeoutMs;
  let phase = "";
  while (Date.now() < end) {
    phase = await phaseOf(kennung);
    if (wanted.includes(phase)) return phase;
    await Bun.sleep(300);
  }
  return phase;
}

/** „Seite zu“: zurück in den Chat; von dort fragt das Skript den Server weiter, die Seite des Wizards ist geschlossen */
const AWAY = `${FRONT}/`;
const trainer = `trainer-${RUN}`;
const trainerNew = `verhandlung-${RUN}`;
const empfang = `empfang-${RUN}`;
const jarvis = `assistent-${RUN}`;
const manuell = `manuell-${RUN}`;

try {
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("DOM.enable");

  await goto(`${FRONT}/login`);
  await waitFor(q("password"));
  await js(`${q("password")}.value = ${JSON.stringify(PASSWORD)}`);
  await js(`${q("login-form")}.requestSubmit()`);
  check("Anmeldung", await waitFor(`location.pathname === "/"`, 10000));

  // --- 1. Bereich: Knopf „Neu“ ---------------------------------------------------------
  await goto(`${FRONT}/sprachagenten`);
  check("Bereich Sprachagenten: Knopf „Neu“ führt zu #/neu", (await waitFor(`(b => b && !b.hidden)(${q("va-new")})`)) && (await text("va-new")) === "Neu" && (await js<string>(`${q("va-new")}.getAttribute("href")`)) === "#/neu");

  // --- 2. Experte: vom Satz bis zum Bauen ------------------------------------------------
  await startWizard("Ein Trainer, mit dem ich Preisverhandlungen übe", trainer);
  check("Experte, Schritt 1: Vorschlag füllt Vorlage, Name und Zweck", (await js<boolean>(`${q("vw-vorlage-experte")}.checked`)) && (await value("vw-name")) === "Verhandlungstrainer" && (await value("vw-zweck")).includes("Preisverhandlungen"), await text("vw-notice"));
  check("Schritt 1: der Entwurf entsteht schon vor „Weiter“, sobald die Kennung gültig ist", (await waitFor(`location.hash === ${JSON.stringify(`#/entwurf/${trainer}`)}`, 6000)) && puts() >= 1 && (await saved()));
  await cdp("Page.reload");
  check("Neuladen vor dem ersten „Weiter“: Schritt 1 mit Satz, Name und Kennung", (await onStep(1, "Zweck")) && (await value("vw-satz")) === "Ein Trainer, mit dem ich Preisverhandlungen übe" && (await value("vw-name")) === "Verhandlungstrainer" && (await value("vw-kennung")) === trainer);
  await shoot("sprachagent-wizard-zweck");
  let small = await smallTargets("#va-wizard");
  check("390 px, Schritt 1: Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));
  await next();
  check("Weiter: Schritt 2, Adresse #/entwurf/<kennung>", (await onStep(2, "Stimme")) && (await hash()) === `#/entwurf/${trainer}` && puts() >= 1);
  check("Schritt 2: Standardstimme vorausgewählt, Stimmen des Kontos zur Wahl", (await waitFor(`${q("vw-stimme-standard")} && ${q("vw-stimme-standard")}.checked`)) && (await exists("vw-stimme-konto-0")) && (await exists("vw-stimme-konto-1")));
  check("Schritt 2: KI-Hinweis steht fest da", (await text("vw-fixed-2")).includes("Hallo, hier spricht eine KI"));
  await click("vw-stimme-konto-1");
  const probesBefore = sent.filter((r) => r.path.endsWith("/hoerprobe")).length;
  await click("vw-probe-konto-1");
  check("Hörprobe der gewählten Stimme: Abspieler mit Ton", (await waitFor(`${q("vw-probe-audio")} && ${q("vw-probe-audio")}.src.startsWith("blob:")`)) && (await text("vw-probe-state")) === "Hörprobe: Alex");
  const probe = sent.filter((r) => r.path.endsWith("/hoerprobe"))[probesBefore];
  check("Hörprobe fragt genau diese Stimme an, mit Sprache und ohne Text", !!probe && JSON.stringify(JSON.parse(probe.body)) === JSON.stringify({ voiceId: "demo-alex", sprache: "de" }), probe?.body);
  await shoot("sprachagent-wizard-stimme");
  small = await smallTargets("#va-wizard");
  check("390 px, Schritt 2: Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));
  await click("vw-probe-konto-2");
  check("Hörprobe nicht möglich: Satz des Servers, kein Abspieler", (await waitFor(`${q("vw-probe-state")}.textContent === "Die Hörprobe ließ sich nicht erzeugen."`)) && !(await exists("vw-probe-audio")));
  await shoot("sprachagent-wizard-hoerprobe-fehler");
  await next();
  check("Experte, Schritt 3: Thema, drei Kriterien, Rollen, Einwände, Dateien, Links", (await onStep(3, "Wissen und Verhalten")) && (await value("vw-thema")) === "Preisverhandlung im Einkauf" && (await value("vw-kriterium-3")) === "Vereinbart einen nächsten Schritt" && (await exists("vw-rolle-1")) && (await exists("vw-einwand-1")) && (await exists("vw-file-add")) && (await exists("vw-link-add")) && !(await exists("vw-frage-add")) && !(await exists("vw-denkauftrag")));
  check("Experte, Schritt 3: feste Regeln sichtbar (Notfall 112, nur recherchiertes Wissen), ohne Schalter", await waitFor(`(b => b && /112/.test(b.textContent) && /nur das recherchierte Wissen/.test(b.textContent) && !b.querySelector("input, button"))(${q("vw-fixed-3")})`));
  // Datei hochladen, während getippt wird
  await type("vw-thema", "Preisverhandlung im Einkauf, mit Rabattstaffeln");
  const { root } = await cdp("DOM.getDocument");
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#vw-file-input" });
  await cdp("DOM.setFileInputFiles", { nodeId, files: [NOTES] });
  check("Datei hochgeladen und gelistet, das Getippte bleibt", (await waitFor(`/notizen\\.md/.test(${q("vw-files")}.textContent)`)) && (await value("vw-thema")) === "Preisverhandlung im Einkauf, mit Rabattstaffeln");
  await click("vw-link-add");
  await type("vw-link-1", "https://example.org/verhandeln");
  check("gespeichert ohne Fehler", (await saved()) && !(await shown("vw-save-error")));
  // Ein halb getippter Link ist noch keine Vorgabe, bleibt aber gespeichert
  await click("vw-link-add");
  await type("vw-link-2", "https://");
  check("halber Link: als unfertige Eingabe beim Server, danach „Gespeichert.“", (await serverOpen(trainer, JSON.stringify({ links: ["https://example.org/verhandeln", "https://"] }))) && (await saved()));
  await shoot("sprachagent-wizard-wissen-experte");
  small = await smallTargets("#va-wizard");
  check("390 px, Schritt 3 (Experte): Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));

  // Vorlagenwechsel: Experte → Anrufannahme → Experte
  await click("vw-step-1");
  await onStep(1, "Zweck");
  await click("vw-vorlage-anrufannahme");
  await click("vw-step-3");
  check("Vorlagenwechsel zur Anrufannahme: Fragen und Abschlusssatz statt Kriterien", (await onStep(3, "Wissen und Verhalten")) && (await exists("vw-frage-add")) && (await exists("vw-abschluss")) && !(await exists("vw-kriterium-1")) && !(await exists("vw-thema")));
  check("Anrufannahme: „kein Gedächtnis“ steht sichtbar fest", await waitFor(`(b => b && /kein Gedächtnis/.test(b.textContent) && /hat kein Gedächtnis/.test(b.textContent))(${q("vw-fixed-3")})`));
  await click("vw-step-1");
  await onStep(1, "Zweck");
  await click("vw-vorlage-experte");
  await click("vw-step-3");
  check("zurück zum Experten: Kriterien, Thema und Datei sind noch da", (await onStep(3, "Wissen und Verhalten")) && (await value("vw-kriterium-1")) === "Fragt nach dem Bedarf" && (await value("vw-kriterium-3")) === "Vereinbart einen nächsten Schritt" && (await value("vw-thema")).includes("Rabattstaffeln") && (await text("vw-files")).includes("notizen.md"));
  check("gespeichert nach dem Wechsel, ohne Fehler", (await saved()) && !(await shown("vw-save-error")));

  // Derselbe Entwurf schnell wieder geöffnet, während ein PUT hängt: nur eine Speicherfolge
  const themaFirst = "Preisverhandlung im Einkauf, Fassung A";
  const themaSecond = "Preisverhandlung im Einkauf, mit Rabattstaffeln, Fassung B";
  await holdPuts(`/api/voice-agents/wizard/${trainer}`);
  await type("vw-thema", themaFirst);
  await Bun.sleep(900);
  const heldFirst = parked.length === 1;
  await js(`location.hash = "#"`);
  await waitFor(`!${q("vw-thema")}`);
  await js(`location.hash = ${JSON.stringify(`#/entwurf/${trainer}`)}`);
  await onStep(3, "Wissen und Verhalten");
  await type("vw-thema", themaSecond);
  await Bun.sleep(900);
  await releasePuts();
  // Alles abwarten, was noch unterwegs ist; erst dann zählt der Stand des Servers
  await Bun.sleep(1500);
  const serverThema = await serverField(trainer, "thema");
  check(
    "denselben Entwurf wieder geöffnet, während der PUT hing: neuere Eingabe beim Server, „Gespeichert.“ stimmt",
    heldFirst && serverThema === themaSecond && (await saved()) && (await value("vw-thema")) === themaSecond && !(await shown("vw-save-error")),
    `Server: ${serverThema}`,
  );

  // Schließen und Fortsetzen: Seite neu laden mitten in Schritt 3
  await goto(`${FRONT}/sprachagenten`);
  check("Liste: Entwurf mit Name, Vorlage und Phase", await waitFor(`(l => l && /Verhandlungstrainer/.test(l.textContent) && /Experte zum Üben · Entwurf, noch nicht gebaut/.test(l.textContent))(${q("va-draft-list")})`));
  await shoot("sprachagent-wizard-liste-entwurf");
  small = await smallTargets("main.voice-agents");
  check("390 px, Liste mit „Neu“ und Entwurf: Tippflächen mindestens 2,75 rem", small.length === 0, small.join(", "));
  await js(`document.querySelector('#va-draft-list a[href="#/entwurf/${trainer}"]').click()`);
  check("Fortsetzen öffnet Schritt 3 mit allen Eingaben", (await onStep(3, "Wissen und Verhalten")) && (await value("vw-thema")).includes("Rabattstaffeln") && (await value("vw-kriterium-2")) === "Nennt einen Nutzen in Zahlen" && (await value("vw-link-1")) === "https://example.org/verhandeln" && (await value("vw-link-2")) === "https://" && (await text("vw-files")).includes("notizen.md"));
  await goto(`${FRONT}/sprachagenten#/entwurf/${trainer}`);
  await cdp("Page.reload");
  check("Neuladen der Adresse: wieder Schritt 3, der halbe Link ist noch da", (await onStep(3, "Wissen und Verhalten")) && (await value("vw-kriterium-1")) === "Fragt nach dem Bedarf" && (await value("vw-link-2")) === "https://");
  await js(`document.querySelector('[aria-label="Links 2 entfernen"]').click()`);
  check("halber Link entfernt: nichts mehr offen", (await serverOpen(trainer, "undefined")) && (await saved()));

  // Kennung ändern nach dem ersten Speichern
  await click("vw-step-1");
  await onStep(1, "Zweck");
  await type("vw-kennung", "empfang");
  await next();
  check("Kennung vergeben: Satz des Servers am Feld, der Wizard bleibt in Schritt 1", (await waitFor(`(e => e && !e.hidden && /hat schon ein Sprachagent/.test(e.textContent))(${q("vw-kennung-error")})`)) && (await heading()) === "Schritt 1 von 5: Zweck" && (await hash()) === `#/entwurf/${trainer}`);
  await shoot("sprachagent-wizard-kennung-vergeben");
  await type("vw-kennung", trainerNew);
  await next();
  check("Kennung geändert: neue Adresse, weiter in Schritt 2", (await onStep(2, "Stimme")) && (await hash()) === `#/entwurf/${trainerNew}`);
  await click("vw-step-3");
  check("nach dem Umzug: Eingaben und Datei sind mitgekommen", (await onStep(3, "Wissen und Verhalten")) && (await value("vw-kriterium-1")) === "Fragt nach dem Bedarf" && (await text("vw-files")).includes("notizen.md"));
  check("der Entwurf unter der alten Kennung ist weg", (await js<number>(`fetch("/api/voice-agents/wizard/${trainer}", { credentials: "same-origin" }).then((r) => r.status)`)) === 404);

  // Schritt 4
  await next();
  check("Schritt 4: Browser, Telefon, geschätzte Kosten", (await onStep(4, "Zugang")) && (await exists("vw-web")) && (await exists("vw-telefon")) && /je Minute/.test(await text("vw-kosten")));
  await click("vw-web");
  await click("vw-telefon");
  check("Telefon: Kennung der Nummer mit Erklärsatz (keine Rufnummer), Anrufer, PIN-Schalter", (await waitFor(q("vw-nummer"))) && (await text("vw-nummer-help")).includes("keine Rufnummer") && (await exists("vw-anrufer-freigegeben")) && (await exists("vw-anrufer-alle")) && (await exists("vw-pin")));
  await next();
  check("Telefon ohne Kennung der Nummer: Weiter bleibt stehen, der Fehler steht am Feld", (await heading()) === "Schritt 4 von 5: Zugang" && (await waitFor(`(e => e && !e.hidden && /Kennung der Nummer/.test(e.textContent))(${q("vw-nummer-error")})`)));
  await type("vw-nummer", "nr_einkauf_1");
  await click("vw-anrufer-alle");
  await next();
  check("Experte mit allen Anrufern: verständlich abgelehnt", (await heading()) === "Schritt 4 von 5: Zugang" && /nur freigegebene Anrufer/.test(await wizardText()));
  await click("vw-anrufer-freigegeben");
  check("gespeichert mit Telefon, ohne Fehler", (await saved()) && !(await shown("vw-save-error")));
  await shoot("sprachagent-wizard-zugang");
  small = await smallTargets("#va-wizard");
  check("390 px, Schritt 4: Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));
  await next();

  // Schritt 5 vor dem Bauen
  check("Schritt 5: Zusammenfassung mit Stimme, Kriterien, Datei und Zugang", (await onStep(5, "Prüfen und Starten")) && (await waitFor(`(e => e && /Alex \\(Stimme Ihres Kontos beim Anbieter\\)/.test(e.textContent) && /notizen\\.md/.test(e.textContent) && /nr_einkauf_1/.test(e.textContent) && /Fragt nach dem Bedarf/.test(e.textContent))(${q("vw-summary")})`)));
  const summary = await text("vw-summary");
  check("Zusammenfassung in Klartext: kein JSON, keine Feldnamen", !/[{}\[\]]|persona\.|zugang\.|voiceId|"\w+":|gedaechtnis|kiHinweis/.test(summary), summary.slice(0, 80));
  await shoot("sprachagent-wizard-pruefen");
  small = await smallTargets("#va-wizard");
  check("390 px, Schritt 5: Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));

  // Bauen abgelehnt (422): Der Name fehlt beim Server, etwa aus einem anderen Fenster geleert
  await js(`(async () => {
    const path = "/api/voice-agents/wizard/${trainerNew}";
    const d = await (await fetch(path, { credentials: "same-origin" })).json();
    const felder = { ...d.felder };
    delete felder.name;
    delete felder.gedaechtnis;
    await fetch(path, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: d.revision, felder }) });
  })()`);
  await click("vw-build");
  check("Bauen abgelehnt (422): Satz des Servers und der Grund in Klartext, der Entwurf bleibt offen", (await waitFor(`(e => e && !e.hidden && /Name: Pflicht zum Bauen/.test(e.textContent))(${q("vw-build-error")})`)) && (await phaseOf(trainerNew)) === "wizard");
  await shoot("sprachagent-wizard-bauen-abgelehnt");
  await click("vw-step-1");
  await onStep(1, "Zweck");
  await type("vw-name", "Verhandlungstrainer");
  await click("vw-step-5");
  await onStep(5, "Prüfen und Starten");
  await waitFor(`(e => e && /Verhandlungstrainer/.test(e.textContent))(${q("vw-summary")})`);

  // Bauen, Seite schließen, Hintergrund
  await click("vw-build");
  check("Bauen gestartet: Stand in Klartext, Hinweis auf den Hintergrund", (await waitFor(`(e => e && /Job schreibt Rezept und Tests|wird gebaut/.test(e.textContent))(${q("vw-phase")})`)) && /im Hintergrund weiter/.test(await text("vw-progress")));
  // Das letzte Speichern gehört noch zum Bauen; ab hier darf kein PUT mehr kommen
  const putsAfterBuild = puts();
  await shoot("sprachagent-wizard-baut");
  const sawQuestion = await waitFor(`(e => e && /Im Direktchat wartet die Freigabe/.test(e.textContent))(${q("vw-question")})`, 12000);
  check("offene Rückfrage: sagt, was zu entscheiden ist, und verlinkt den Direktchat; keine Antwortknöpfe im Wizard", sawQuestion && (await js<string>(`${q("vw-chat")}.getAttribute("href")`)) === "/#/gespraech/dm" && (await js<number>(`${q("vw-question")}.querySelectorAll("button").length`)) === 0);
  await goto(AWAY);
  const finalPhase = await serverPhase(trainerNew, ["fertig"]);
  check("Hintergrund: Seite zu, die Attrappe läuft bis „fertig“", finalPhase === "fertig", finalPhase);
  await goto(`${FRONT}/sprachagenten`);
  check("Liste: beendeter Entwurf unter „Zuletzt beendet“, der Agent in der Liste", (await waitFor(`(l => l && /Verhandlungstrainer/.test(l.textContent) && /Fertig/.test(l.textContent))(${q("va-done-list")})`)) && (await waitFor(`!!document.querySelector('#va-list a[href="#${trainerNew}"]')`)));
  await js(`document.querySelector('#va-done-list a[href="#/entwurf/${trainerNew}"]').click()`);
  check("erneut geöffnet: Schritt 5 mit Ergebnis und Testergebnissen je Test", (await onStep(5, "Prüfen und Starten")) && (await waitFor(`(e => e && /Alle Tests bestanden/.test(e.textContent) && /Notfall: bestanden/.test(e.textContent) && /Bleibt in der Rolle: bestanden/.test(e.textContent))(${q("vw-tests")})`)) && (await text("vw-phase")) === "Fertig");
  check("bestanden, freigeschaltet, Web-Zugang: „Sprechen“ öffnet /sa/<kennung>", (await shown("vw-talk")) && (await js<string>(`${q("vw-talk")}.getAttribute("href")`)) === `/sa/${trainerNew}`);
  await shoot("sprachagent-wizard-fertig");
  small = await smallTargets("#va-wizard");
  check("390 px, Ergebnis: Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));
  // Ansehen nach dem Bauen
  await click("vw-step-3");
  check("nach dem Bauen: Schritt 3 nur zum Ansehen, mit Hinweis auf /sprachagent aendern", (await onStep(3, "Wissen und Verhalten")) && (await js<boolean>(`${q("vw-body")}.disabled && ${q("vw-kriterium-1")}.matches(":disabled")`)) && (await text("vw-readonly")).includes(`/sprachagent aendern ${trainerNew}`) && !(await exists("vw-discard")));
  await shoot("sprachagent-wizard-ansehen");
  await click("vw-step-1");
  await onStep(1, "Zweck");
  await click("vw-step-4");
  await onStep(4, "Zugang");
  await Bun.sleep(900);
  check("nach dem Bauen sendet der Wizard kein PUT mehr, auch nicht beim Blättern durch die Schritte", puts() === putsAfterBuild, `${puts() - putsAfterBuild} PUT nach dem Bauen`);

  // --- 3. Anrufannahme, Tests fallen durch -------------------------------------------------
  await startWizard("Anrufe annehmen, wenn niemand abhebt, die Tests sollen durchfallen", empfang);
  check("Anrufannahme, Schritt 1: Vorschlag wählt die Vorlage", (await js<boolean>(`${q("vw-vorlage-anrufannahme")}.checked`)) && (await value("vw-name")) === "Empfang Praxis");
  await next();
  await onStep(2, "Stimme");
  await waitFor(`${q("vw-stimme-standard")} && ${q("vw-stimme-standard")}.checked`);
  await next();
  check("Anrufannahme, Schritt 3: Fragen an den Anrufer und Abschlusssatz, keine Felder des Experten", (await onStep(3, "Wissen und Verhalten")) && (await value("vw-frage-1")) === "Name des Anrufers" && (await value("vw-frage-3")) === "Anliegen in einem Satz" && (await value("vw-abschluss")) === "Vielen Dank, wir melden uns." && !(await exists("vw-thema")) && !(await exists("vw-kriterium-1")) && !(await exists("vw-denkauftrag")));
  check("Anrufannahme, Schritt 3: feste Regeln sichtbar (Notfall 112, nichts Privates, kein Gedächtnis)", await waitFor(`(b => b && /112/.test(b.textContent) && /Privates/.test(b.textContent) && /kein Gedächtnis/.test(b.textContent))(${q("vw-fixed-3")})`));
  await click("vw-frage-add");
  await type("vw-frage-4", "Bis wann der Rückruf passt");
  await shoot("sprachagent-wizard-wissen-anrufannahme");
  small = await smallTargets("#va-wizard");
  check("390 px, Schritt 3 (Anrufannahme): Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));
  await next();
  await onStep(4, "Zugang");
  await click("vw-web");
  await next();
  check("Anrufannahme, Schritt 5: Fragen und Abschlusssatz unter eigenen Zeilen, nicht als Regeln", (await onStep(5, "Prüfen und Starten")) && (await waitFor(`(e => e && /Fragen an den Anrufer/.test(e.textContent) && /Bis wann der Rückruf passt/.test(e.textContent) && /Abschlusssatz/.test(e.textContent) && !/Frage den Anrufer nach/.test(e.textContent))(${q("vw-summary")})`)));
  await click("vw-build");
  await waitFor(`(e => e && e.textContent.length > 0)(${q("vw-phase")})`);
  await goto(AWAY);
  const failedPhase = await serverPhase(empfang, ["durchgefallen"]);
  check("Hintergrund: Seite zu, die Attrappe läuft bis „durchgefallen“ mit offener Entscheidung", failedPhase === "durchgefallen", failedPhase);
  await goto(`${FRONT}/sprachagenten`);
  check("Liste: der Entwurf bleibt offen und nennt die Entscheidung", await waitFor(`(l => l && /Empfang Praxis/.test(l.textContent) && /Tests durchgefallen, Entscheidung offen im Direktchat/.test(l.textContent))(${q("va-draft-list")})`));
  await js(`document.querySelector('#va-draft-list a[href="#/entwurf/${empfang}"]').click()`);
  check("durchgefallen: Grund je Test", (await onStep(5, "Prüfen und Starten")) && (await waitFor(`(e => e && /KI-Hinweis zuerst: durchgefallen/.test(e.textContent) && /erst nach der Begrüßung/.test(e.textContent) && /Notfall: bestanden/.test(e.textContent))(${q("vw-tests")})`)));
  check("durchgefallen: Hinweis auf die Entscheidung „trotzdem freischalten“ im Direktchat, kein „Sprechen“", /trotzdem freischalten/.test(await text("vw-question")) && (await js<string>(`${q("vw-chat")}.getAttribute("href")`)) === "/#/gespraech/dm" && !(await exists("vw-talk")));
  await shoot("sprachagent-wizard-durchgefallen");
  small = await smallTargets("#va-wizard");
  check("390 px, durchgefallen: Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));

  // --- 4. Jarvis ---------------------------------------------------------------------------
  await startWizard("Mein persönlicher Assistent für Termine", jarvis);
  check("Jarvis, Schritt 1: Vorschlag wählt die Vorlage", (await js<boolean>(`${q("vw-vorlage-jarvis")}.checked`)) && (await value("vw-name")) === "Jarvis Zuhause");
  await next();
  await onStep(2, "Stimme");
  await waitFor(`${q("vw-stimme-standard")} && ${q("vw-stimme-standard")}.checked`);
  await next();
  check("Jarvis, Schritt 3: nur Auftreten und der Schalter Denkauftrag", (await onStep(3, "Wissen und Verhalten")) && (await exists("vw-denkauftrag")) && (await value("vw-rolle-text")) === "Ruhiger persönlicher Assistent" && !(await exists("vw-thema")) && !(await exists("vw-kriterium-1")) && !(await exists("vw-frage-add")) && !(await exists("vw-file-add")));
  check("Jarvis, Schritt 3: feste Regeln sichtbar (Notfall 112, Prüfung des Anrufers)", await waitFor(`(b => b && /112/.test(b.textContent) && /Prüfung/.test(b.textContent))(${q("vw-fixed-3")})`));
  await click("vw-denkauftrag");
  await shoot("sprachagent-wizard-wissen-jarvis");
  small = await smallTargets("#va-wizard");
  check("390 px, Schritt 3 (Jarvis): Tippflächen mindestens 2,75 rem, nichts läuft über", small.length === 0, small.join(", "));
  await next();
  await onStep(4, "Zugang");
  await click("vw-telefon");
  await waitFor(q("vw-nummer"));
  await type("vw-nummer", "nr_privat");
  check("Jarvis mit Telefon: PIN fest an (volles Gedächtnis), Schalter gesperrt, Regel sichtbar", (await waitFor(`${q("vw-pin")}.disabled && ${q("vw-pin")}.checked`, 6000)) && /PIN ist Pflicht/.test(await text("vw-fixed-4")) && /Fest an/.test(await text("vw-pin-hint")));
  await next();
  check("Jarvis, Schritt 5: Denkauftrag an in der Zusammenfassung", (await onStep(5, "Prüfen und Starten")) && (await waitFor(`(e => e && /Denkauftrag/.test(e.textContent) && /an: Schwierige Fragen/.test(e.textContent))(${q("vw-summary")})`)));
  await click("vw-build");
  check("Jarvis: Bauen gestartet", (await waitFor(q("vw-progress"))) && (await serverPhase(jarvis, ["job", "freigabe", "anlegen", "fertig"], 5000)) !== "wizard");

  // --- 5. Vorschlag gescheitert, verspäteter Vorschlag, abgebrochen, Verwerfen --------------
  await goto(`${FRONT}/sprachagenten`);
  await waitFor(`(b => b && !b.hidden)(${q("va-new")})`);
  await click("va-new");
  await onStep(1, "Zweck");
  await type("vw-satz", "Der Vorschlag soll scheitern, danach abbrechen");
  await click("vw-propose");
  check("Vorschlag gescheitert: Hinweis des Servers, Vorlage Experte, Felder leer", (await waitFor(`/Kein Vorschlag/.test(${q("vw-notice")}.textContent)`, 10000)) && (await js<boolean>(`${q("vw-vorlage-experte")}.checked`)) && (await value("vw-name")) === "" && (await value("vw-zweck")) === "");
  await shoot("sprachagent-wizard-vorschlag-gescheitert");
  await next();
  check("ohne Pflichtfelder bleibt Weiter stehen und nennt sie am Feld", (await heading()) === "Schritt 1 von 5: Zweck" && (await waitFor(`(e => e && !e.hidden)(${q("vw-name-error")})`)) && (await shown("vw-zweck-error")) && (await shown("vw-kennung-error")));
  // Verspäteter Vorschlag: langsam anfordern, inzwischen selbst tippen
  await type("vw-satz", "Ein Trainer, bitte langsam antworten");
  await click("vw-propose");
  await type("vw-name", "Mein eigener Name");
  await type("vw-zweck", "Zum Üben schwieriger Gespräche.");
  check("verspäteter Vorschlag: eigene Eingaben bleiben, Hinweis „Vorschlag verworfen“", (await waitFor(`/Vorschlag verworfen, Ihre Eingaben bleiben/.test(${q("vw-notice")}.textContent)`, 12000)) && (await value("vw-name")) === "Mein eigener Name" && (await value("vw-zweck")) === "Zum Üben schwieriger Gespräche.");
  await type("vw-satz", "Der Vorschlag soll scheitern, danach abbrechen");
  await type("vw-kennung", manuell);
  await next();
  check("es geht trotzdem weiter: Schritt 2", await onStep(2, "Stimme"));
  await next();
  await onStep(3, "Wissen und Verhalten");
  check("der verspätete Vorschlag hat die leeren, unberührten Felder gefüllt (Kriterien)", (await value("vw-kriterium-1")) === "Fragt nach dem Bedarf");
  await type("vw-kriterium-2", "");
  await next();
  check("Experte ohne drei Kriterien: Weiter bleibt stehen und sagt es am Feld", (await heading()) === "Schritt 3 von 5: Wissen und Verhalten" && (await waitFor(`(e => e && !e.hidden && /genau drei Kriterien/.test(e.textContent))(${q("vw-kriterien-error")})`)));
  await type("vw-kriterium-2", "Fasst zusammen");
  await next();
  await onStep(4, "Zugang");
  await next();
  await onStep(5, "Prüfen und Starten");
  await click("vw-build");
  check("abgebrochen: Grund und Fehler in Klartext, kein „Sprechen“, keine Rückfrage", (await waitFor(`(e => e && /abgebrochen/.test(e.textContent) && /Mindestens 2 Tests/.test(e.textContent))(${q("vw-aborted")})`, 15000)) && !(await exists("vw-talk")) && !(await exists("vw-question")));
  await shoot("sprachagent-wizard-abgebrochen");

  // Entwurf weg (404)
  await goto(`${FRONT}/sprachagenten#/entwurf/gibt-es-nicht-${RUN}`);
  check("Entwurf weg (404): ein Satz statt eines leeren Wizards", (await waitFor(`(e => e && e.textContent === "Diesen Entwurf gibt es nicht (mehr).")(${q("vw-gone")})`)) && !(await exists("vw-next")));
  await shoot("sprachagent-wizard-entwurf-weg");

  // Verwerfen mit Rückfrage auf der Seite
  const weg = `weg-${RUN}`;
  await startWizard("Mein persönlicher Assistent zum Verwerfen", weg);
  await next();
  await onStep(2, "Stimme");
  await click("vw-discard");
  check("Verwerfen fragt auf der Seite nach, „Abbrechen“ hat den Fokus", (await waitFor(q("vw-discard-yes"))) && (await js<boolean>(`document.activeElement === ${q("vw-discard-no")}`)) && /Entwurf Jarvis Zuhause verwerfen\?/.test(await wizardText()));
  await shoot("sprachagent-wizard-verwerfen");
  await click("vw-discard-no");
  check("Abbrechen: der Entwurf bleibt", (await waitFor(q("vw-discard"))) && (await phaseOf(weg)) === "wizard");
  await click("vw-discard");
  await waitFor(q("vw-discard-yes"));
  await click("vw-discard-yes");
  check("Verwerfen: zurück zur Liste mit Meldung, der Entwurf ist weg", (await waitFor(`${q("va-status")}.textContent === "Der Entwurf Jarvis Zuhause ist verworfen."`)) && (await js<number>(`fetch("/api/voice-agents/wizard/${weg}", { credentials: "same-origin" }).then((r) => r.status)`)) === 404 && (await hash()) === "");

  // Der Bereich davor bleibt, wie er war: Detail eines Agenten
  await goto(`${FRONT}/sprachagenten#${trainerNew}`);
  check("Detail des gebauten Agenten öffnet wie bisher, ohne „Neu“ und ohne Entwürfe", (await waitFor(`${q("va-title")}.textContent === "Verhandlungstrainer"`)) && !(await shown("va-new")) && !(await shown("va-drafts")) && !(await shown("va-wizard")));

  const csp = problems.filter((p) => /Content Security Policy|Refused/i.test(p));
  check("keine CSP-Verstöße", csp.length === 0, csp.join(" | "));
  // Abgelehnte Anfragen (409, 422, 404, 502) meldet Chrome als Ladefehler; sie gehören zu den geprüften Fehlerzuständen
  const errors = problems.filter((p) => !/Failed to load resource|Content Security Policy|Refused/i.test(p));
  check("keine Skriptfehler", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  ws.close();
  chrome.kill();
  await chrome.exited;
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
