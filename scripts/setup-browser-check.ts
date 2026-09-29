#!/usr/bin/env bun
/**
 * Browser-Durchlauf des Einrichtungsmodus (Issue #66) mit Headless-Chrome
 * über das DevTools-Protokoll, Ergänzung zu scripts/web-browser-check.ts. Kein
 * Teil von `bun run check` (braucht Chrome), wird von Hand gestartet:
 *
 *   bun run scripts/setup-browser-check.ts
 *   bun run scripts/setup-browser-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *
 * Startet einen eigenen Einrichtungs-Server in einem temporären Projekt, mit
 * Attrappen für Anbieter (Telegram, Datenbank) und Befehle (git, claude
 * --version, launchctl list). Kein Netz, kein launchctl load, kein Bot, kein
 * Claude-Aufruf. Importiert src/bot.ts nicht.
 *
 * Danach (Issue #161) ein zweiter Server mit dem Test-Schritt aus
 * tests/setup-flow-fixture.ts: Standardwert, „Auswahl laden“, „Einrichten“
 * mit Plan, Fortschritt, Ergebnis und Abbrechen.
 *
 * Issue #163: Die Management-API von Supabase ist die Attrappe aus
 * tests/supabase-api-fixture.ts; der Datenbank-Schritt zeigt den Standard
 * „Supabase in der Cloud“ und lädt die (einzige) Organisation.
 *
 * Issue #167: Schritt „Semantische Suche“ mit den Attrappen aus
 * tests/search-fixture.ts (Supabase, Gemini, Ollama) und
 * tests/local-supabase-fixture.ts (Supabase auf diesem Rechner):
 * Anbieterwechsel und sichtbare Felder, Gemini-Schlüssel bis zum Nachweis,
 * Ollama-Download abgelehnt und bestätigt.
 *
 * Issue #168: Rückfrage „Neuberechnung beim Anbieterwechsel“ (SEARCH_REINDEX)
 * mit geladener Auswahl: kein Wechsel, Anbieterwechsel, Modellwechsel,
 * Ablehnen, Zustimmen (Lauf reserviert, Neuberechnung im Hintergrund als
 * Attrappe, es startet nichts) und Fehler beim Laden der Schätzung.
 *
 * Issue #207: Linux mit systemd, Kontext und Befehle (systemctl --user,
 * loginctl, which, PM2) aus tests/systemd-fixture.ts. Auswahl „Art des
 * Autostarts“ unter „Fertig“: Vorschlag systemd, erst mit Häkchen bedienbar,
 * PM2 gewählt bis zum Abschluss; dazu ein Rechner, dessen Benutzer-Manager
 * nicht antwortet (kein Vorschlag, Hinweis, „Fertig“ ohne Wahl abgelehnt).
 * „Fertig“ schließt hier nur den Server: eingerichtet wird nichts, es startet
 * kein Dienst.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import { createSetupContext, type CommandRunner } from "../src/setup/context";
import type { Providers } from "../src/setup/providers";
import { createSetupServer, formatSetupCode, generateSetupCode } from "../src/setup/web-server";
import type { SetupServer } from "../src/setup/web-server";
import { checkStep, SETUP_STEPS } from "../src/setup/steps";
import { writeEnv } from "../src/setup/steps/common";
import { ABORTED_MESSAGE, FLOW, FLOW_ID, makeFlowStep } from "../tests/setup-flow-fixture";
import { fakeSupabaseApi, SB } from "../tests/supabase-api-fixture";
import { EDGE_FUNCTIONS, functionsEnvPath } from "../src/setup/semantic-search";
import { GEMINI, localRuntime, OPENAI, searchFake, type FakeProjectState, type SearchFake } from "../tests/search-fixture";
import { REINDEX_FIELD, REINDEX_NO, REINDEX_NONE, REINDEX_YES } from "../src/setup/semantic-search";
import { fakeLocal, LOCAL, SAFE_CONTAINERS } from "../tests/local-supabase-fixture";
import { cleanup as cleanupFixture, FULL_ENV } from "../tests/setup-fixture";
import { PROFILE } from "../tests/setup-web-fixture";
import { linuxCtx, started, type World } from "../tests/systemd-fixture";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.argv.includes("--screenshots");
const OUT = join(import.meta.dir, "..", "docs", "webui", "screenshots");

// Gültig aussehende Platzhalter, keine echten Zugangsdaten
const TOKEN = "123456789:AAFakeTokenForBrowserCheck_abcdefghijk";
const USER_ID = "424242";

const dir = await mkdtemp(join(tmpdir(), "tybo-setup-browser-"));
await mkdir(join(dir, "config"), { recursive: true });
await mkdir(join(dir, "launchd"), { recursive: true });
await writeFile(join(dir, ".env"), "# leer, wie nach dem ersten Klonen\n", { mode: 0o600 });

const run: CommandRunner = async cmd => {
  const line = cmd.join(" ");
  if (line === "git --version") return { code: 0, stdout: "git version 2.50.0", stderr: "" };
  if (line === "launchctl list") return { code: 0, stdout: "", stderr: "" };
  return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
};
const ok = (message: string) => async () => ({ ok: true, message });
const providers: Providers = {
  telegramGetMe: async () => ({ ok: true, message: "Verbunden mit @beispiel_bot", username: "beispiel_bot" }),
  telegramSendTest: ok("Testnachricht verschickt. Sie sollte jetzt in Telegram zu sehen sein."),
  telegramCheckGroup: ok("Forum-Gruppe gefunden, der Bot ist Admin."),
  supabaseQuery: ok("Supabase erreichbar, Tabelle messages lesbar."),
  convexQuery: ok("Convex erreichbar, Anmeldung angenommen."),
  claudeVersion: ok("Claude CLI 2.1.300"),
  claudeProbe: async () => {
    throw new Error("Im Einrichtungsmodus darf kein Modell aufgerufen werden");
  },
  openrouterKey: ok("OpenRouter nimmt den Schlüssel an."),
  ollamaTags: async () => ({ ok: true, message: "Ollama läuft (1 Modelle).", models: ["qwen3:8b"] }),
};
const ctx = createSetupContext({
  root: dir,
  home: join(dir, "home"),
  platform: "darwin",
  launchAgentsDir: join(dir, "home", "Library", "LaunchAgents"),
  pm2DumpPath: join(dir, "home", ".pm2", "dump.pm2"),
  run,
  providers,
  // Kein Netz: Supabase-Management-API als Attrappe
  fetch: fakeSupabaseApi().fetch,
});
const code = generateSetupCode();
const server = await createSetupServer({
  ctx,
  code,
  port: 0,
  supervisor: async () => null,
  startCommand: "cd ~/tybo && bun run start",
  log: () => {},
});
const base = server.url;
let flowServer: SetupServer | null = null;
const searchServers: SetupServer[] = [];
const linuxServers: SetupServer[] = [];

const debugPort = 9800 + Math.floor(Math.random() * 150);
const chrome = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "chrome")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
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
  // CSP-Verstöße und Skriptfehler sammeln
  if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails?.text ?? "Ausnahme");
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") problems.push(msg.params.entry.text);
});
function cdp(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, msg => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result))),
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
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 600 });
}
async function scheme(value: "light" | "dark") {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
}
async function shoot(name: string) {
  if (!SHOTS) return;
  await Bun.sleep(150);
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
}
/** Jede Größe und jedes Farbschema einmal: 1280/390, hell/dunkel */
async function shootAll(name: string, prepare: () => Promise<void> = async () => {}) {
  if (!SHOTS) return;
  for (const width of [1280, 390]) {
    for (const s of ["light", "dark"] as const) {
      await viewport(width);
      await scheme(s);
      await prepare();
      await shoot(`${name}-${width}${s === "dark" ? "-dunkel" : ""}`);
    }
  }
  await viewport(1280);
  await scheme("light");
}
const typeInto = (id: string, value: string) =>
  js(`(() => { const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input")); })()`);
const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const noHorizontalScroll = (width: number) => js<boolean>(`document.documentElement.scrollWidth <= ${width} && document.body.scrollWidth <= ${width}`);
async function openStep(id: string) {
  await click(`.setup-step[data-step="${id}"]`);
  await waitFor(`document.querySelector('.setup-step[data-step="${id}"]').getAttribute("aria-current") === "step"`);
}
const choose = (id: string, value: string) =>
  js(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change")); })()`);
/** Sind genau diese Felder im offenen Schritt sichtbar (in dieser Reihenfolge)? */
async function fieldsAre(expected: string[]): Promise<boolean> {
  const want = JSON.stringify(expected);
  return waitFor(`JSON.stringify([...document.querySelectorAll("[data-field]")].filter(w => !w.hidden).map(w => w.dataset.field)) === ${JSON.stringify(want)}`);
}

/**
 * Einrichtungs-Server für den Suchschritt (Issue #167): eigenes Projekt mit
 * Kopie von supabase/, Attrappen statt Netz. project: Zustand der Datenbank
 * (Issue #168: Anbieterkennung, Umfang); launches: Starts im Hintergrund
 * (Attrappe, es startet nichts)
 */
async function searchServer(envText: string, local?: ReturnType<typeof fakeLocal>, project: Partial<FakeProjectState> = {}) {
  const root = await mkdtemp(join(tmpdir(), "tybo-setup-suche-"));
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, ".env"), envText, { mode: 0o600 });
  await writeFile(join(root, "config", "profile.md"), "# Profil\n");
  const repo = join(import.meta.dir, "..");
  await cp(join(repo, "supabase", "functions"), join(root, "supabase", "functions"), { recursive: true });
  await cp(join(repo, "supabase", "config.toml"), join(root, "supabase", "config.toml"));
  const fake: SearchFake = searchFake({ project: { serviceKeys: [local ? LOCAL.secret : SB.secret], deployed: local ? new Set(EDGE_FUNCTIONS) : new Set(), ...project }, ollama: { models: [] } });
  const launches: string[][] = [];
  if (local) {
    local.containers = [...SAFE_CONTAINERS, "supabase_edge_runtime_tybo\t"];
    const runtime = localRuntime(functionsEnvPath(root));
    fake.project.runtimeKey = runtime.key;
    fake.project.runtimeEnv = runtime.env;
    await runtime.start();
    local.answers["supabase start"] = async () => {
      await runtime.start();
      return { stdout: "Started" };
    };
  }
  const c = createSetupContext({
    root,
    home: join(root, "home"),
    platform: "darwin",
    launchAgentsDir: join(root, "home", "Library", "LaunchAgents"),
    pm2DumpPath: join(root, "home", ".pm2", "dump.pm2"),
    run: local ? (local.run as CommandRunner) : run,
    providers,
    fetch: fake.fetch,
    startBackground: async cmd => {
      launches.push(cmd);
      return true;
    },
    ...(local ? { localSupabase: local.deps } : {}),
  });
  const searchCode = generateSetupCode();
  const s = await createSetupServer({ ctx: c, code: searchCode, port: 0, supervisor: async () => null, startCommand: "cd ~/tybo && bun run start", log: () => {} });
  searchServers.push(s);
  await goto(`${s.url}/`);
  await waitFor(`document.getElementById("code-form")`);
  await typeInto("code", formatSetupCode(searchCode));
  await click("#code-button");
  await waitFor(`document.querySelectorAll(".setup-step").length === ${SETUP_STEPS.length}`);
  await openStep("suche");
  return { fake, root, launches };
}

/** Auswahl der Rückfrage laden; die geladenen Optionen (Wert und Text) */
async function loadReindex(): Promise<Array<{ value: string; label: string }>> {
  await click(`button[data-action="load-${REINDEX_FIELD}"]`);
  await waitFor(`!document.getElementById("field-${REINDEX_FIELD}").disabled`);
  return js(`[...document.getElementById("field-${REINDEX_FIELD}").options].filter(o => o.value).map(o => ({ value: o.value, label: o.textContent }))`);
}

/** Rückfrage samt Hilfe ins Bild holen (für Screenshots) */
const showReindex = () => js(`document.querySelector('[data-field="${REINDEX_FIELD}"]')?.scrollIntoView({ block: "center" })`);

/** Ergebnis des Ablaufs ins Bild holen (für Screenshots) */
const showResult = () => js(`document.querySelector(".setup-result")?.scrollIntoView({ block: "center" })`);

/** Einrichten, Plan bestätigen, auf das Ergebnis warten; Text des Ergebnisses */
async function runSearch(): Promise<string> {
  await click('button[data-action="run"]');
  await waitFor(`document.querySelector('button[data-action="run-confirm"]')`);
  await click('button[data-action="run-confirm"]');
  await waitFor(`document.querySelector(".setup-result-ok, .setup-result .actions-error")`, 15000);
  return js<string>(`(document.querySelector(".setup-result-ok, .setup-result .actions-error")?.textContent) ?? ""`);
}

try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await viewport(1280);
  await scheme("light");

  // --- Code-Seite -----------------------------------------------------------
  await goto(`${base}/`);
  check("ohne Code: / führt zur Code-Seite", await waitFor(`location.pathname === "/code" && document.getElementById("code-form")`));
  // Name aus src/brand.ts schon vor der Anmeldung (Issue #100)
  check(`Code-Seite: Titel, Wortmarke und Hinweis mit ${BRAND.name}`, await waitFor(
    `document.title === ${JSON.stringify(`${BRAND.name} Einrichtung`)} && document.querySelector(".wordmark").textContent === ${JSON.stringify(BRAND.name)} && document.querySelector(".login-lead").textContent.includes(${JSON.stringify(`in dem ${BRAND.name} gestartet wurde`)}) && window.TYBO_BRAND?.name === ${JSON.stringify(BRAND.name)}`));
  // tyb[o]t: früherer Befehl, zerlegt geschrieben, damit die Suche nach Resten des Namens leer bleibt (Issue #142)
  check("Code-Seite: kein alter Name im Dokument", !/gob[o]t|tyb[o]t|\{\{brand/i.test(await js<string>(`document.documentElement.outerHTML`)));
  await shootAll("einrichtung-code");
  await typeInto("code", "AAAA-AAAA");
  await click("#code-button");
  check("falscher Code: Meldung", await waitFor(`document.getElementById("code-error").textContent === "Falscher Code."`));
  await typeInto("code", formatSetupCode(code).toLowerCase());
  await click("#code-button");
  check("richtiger Code (klein, mit Bindestrich): Assistent öffnet", await waitFor(`location.pathname === "/" && document.querySelectorAll(".setup-step").length === ${SETUP_STEPS.length}`));
  check(`Assistent: Titel und Wortmarke ${BRAND.name}`, await js<boolean>(`document.title === ${JSON.stringify(`${BRAND.name} Einrichtung`)} && document.querySelector(".wordmark").textContent === ${JSON.stringify(BRAND.name)}`));
  const cookie = await cdp("Network.getCookies", { urls: [base] }).catch(() => null);
  if (cookie) {
    const c = cookie.cookies.find((x: any) => x.name === "tybo_setup");
    check("Sitzungs-Cookie: HttpOnly, SameSite=Strict, nur Sitzung", !!c && c.httpOnly && c.sameSite === "Strict" && c.session);
  }

  // --- Telegram ---------------------------------------------------------------
  check("erster offener Schritt ist Telegram", await waitFor(`document.querySelector('.setup-step[aria-current="step"]')?.dataset.step === "telegram"`));
  check("Token-Feld verdeckt und leer", await js<boolean>(`(() => { const i = document.getElementById("field-TELEGRAM_BOT_TOKEN"); return i.type === "password" && i.value === ""; })()`));
  await shootAll("einrichtung-telegram");
  await typeInto("field-TELEGRAM_BOT_TOKEN", TOKEN);
  await typeInto("field-TELEGRAM_USER_ID", USER_ID);
  await click('button[data-action="test"]');
  check("Testen zeigt das Ergebnis", await waitFor(`document.querySelector(".setup-result-ok")?.textContent.includes("Verbunden mit @beispiel_bot")`));
  await shootAll("einrichtung-telegram-test");
  await click('button[data-action="apply"]');
  check("Speichern: Schritt erledigt, Felder wieder leer", await waitFor(
    `document.querySelector('.setup-step[data-step="telegram"]').dataset.state === "erledigt" && document.getElementById("field-TELEGRAM_BOT_TOKEN").value === ""`,
  ));
  check("Token nirgends im Dokument", !(await js<string>(`document.documentElement.outerHTML`)).includes(TOKEN));

  // --- Datenbank: Standard Supabase in der Cloud (Issue #163) -------------------
  await openStep("datenbank");
  check("Datenbank: Standard Cloud, Token-Feld sichtbar, Knopf Einrichten", await waitFor(
    `document.getElementById("field-DB_BACKEND").value === "supabase-cloud" && !document.querySelector('[data-field="SUPABASE_SETUP_TOKEN"]').hidden && document.querySelector('button[data-action="run"]')?.textContent === "Einrichten"`,
  ));
  await typeInto("field-SUPABASE_SETUP_TOKEN", SB.token);
  await click('button[data-action="load-SUPABASE_ORG"]');
  check("einzige Organisation vorausgewählt", await waitFor(`document.getElementById("field-SUPABASE_ORG").value === "org-alpha"`));
  await shootAll("einrichtung-datenbank-cloud");
  check("Zugangstoken nirgends im Dokument", !(await js<string>(`document.documentElement.outerHTML`)).includes(SB.token));

  // --- Datenbank: Auswahl blendet Felder um ------------------------------------
  await js(`(() => { const s = document.getElementById("field-DB_BACKEND"); s.value = "convex"; s.dispatchEvent(new Event("change")); })()`);
  check("Convex gewählt: Convex-Felder sichtbar", await waitFor(`!document.querySelector('[data-field="CONVEX_URL"]').hidden && document.querySelector('[data-field="SUPABASE_URL"]').hidden`));
  await typeInto("field-CONVEX_URL", "https://happy-otter-123.convex.cloud");
  await typeInto("field-CONVEX_AUTH_TOKEN", "convex-platzhalter-token-1234");
  await shootAll("einrichtung-datenbank");
  await click('button[data-action="apply"]');
  check("Datenbank gespeichert", await waitFor(`document.querySelector('.setup-step[data-step="datenbank"]').dataset.state === "erledigt"`));

  // --- Profil ------------------------------------------------------------------
  await openStep("profil");
  await typeInto("field-USER_NAME", "Beispiel");
  await typeInto("field-USER_TIMEZONE", "Europe/Berlin");
  await click('button[data-action="apply"]');
  check("Profil gespeichert", await waitFor(`document.querySelector('.setup-step[data-step="profil"]').dataset.state === "erledigt"`));

  // --- Handy: keine waagrechte Scrollleiste -------------------------------------
  await viewport(390);
  await openStep("telegram");
  check("390 px: kein waagrechtes Scrollen der Seite", await noHorizontalScroll(390));
  await viewport(1280);

  // --- Gesamtprüfung und Fertig -------------------------------------------------
  await openStep("pruefung");
  check("Fertig ist frei", await waitFor(`document.querySelector('button[data-action="finish"]') && !document.querySelector('button[data-action="finish"]').disabled`));
  await click('button[data-action="test"]');
  check("Alles prüfen ohne Modellaufruf", await waitFor(`document.getElementById("setup-panel").textContent.includes("prüft die Einrichtung im Browser nicht (kein Modellaufruf)")`));
  await shootAll("einrichtung-pruefung");
  await click('button[data-action="finish"]');
  check("Fertig: Abschluss mit Startbefehl", await waitFor(`document.querySelector(".setup-command")?.textContent === "cd ~/tybo && bun run start"`));
  check("Schritte gesperrt", await js<boolean>(`[...document.querySelectorAll(".setup-step")].every(b => b.disabled)`));
  await shootAll("einrichtung-fertig");
  check("Server meldet Abschluss", server.isFinished());

  await goto(`${base}/`);
  check("nach Fertig: / führt zur Code-Seite", await waitFor(`location.pathname === "/code"`));
  await typeInto("code", formatSetupCode(code));
  await click("#code-button");
  check("nach Fertig: Code gilt nicht mehr", await waitFor(`document.getElementById("code-error").textContent.includes("abgeschlossen")`));

  // --- Abläufe mit dem Test-Schritt (Issue #161) --------------------------------
  let release: () => void = () => {};
  const flowStep = makeFlowStep({
    async run(values, c, report, signal) {
      report({ at: 1, total: 3, label: "Lege das Projekt an" });
      report({ at: 2, total: 3, label: "Warte, bis das Projekt bereit ist", waitedMs: 0 });
      report({ at: 2, total: 3, label: "Warte, bis das Projekt bereit ist", waitedMs: 15_000 });
      await new Promise<void>(r => {
        release = r;
        signal.addEventListener("abort", () => r(), { once: true });
      });
      if (signal.aborted) return { ok: false, message: ABORTED_MESSAGE, changed: [] };
      report({ at: 3, total: 3, label: "Schreibe die Zugangsdaten" });
      const written = await writeEnv(c, [["FLOW_TOKEN", values.FLOW_TOKEN], ["FLOW_ORG", values.FLOW_ORG], ["FLOW_NAME", values.FLOW_NAME || "tybo"]]);
      return written.ok ? { ok: true, message: "Projekt angelegt und eingetragen.", changed: written.changed } : written;
    },
  });
  const flowCode = generateSetupCode();
  flowServer = await createSetupServer({
    ctx,
    code: flowCode,
    port: 0,
    supervisor: async () => null,
    startCommand: "cd ~/tybo && bun run start",
    log: () => {},
    steps: [...SETUP_STEPS.filter(x => x.id !== "pruefung"), flowStep, checkStep],
  });
  await goto(`${flowServer.url}/`);
  await waitFor(`document.getElementById("code-form")`);
  await typeInto("code", formatSetupCode(flowCode));
  await click("#code-button");
  // Alle Schritte ohne Gesamtprüfung, dazu Test-Schritt und Gesamtprüfung
  const flowSteps = SETUP_STEPS.length + 1;
  check(`Test-Schritt: Assistent mit ${flowSteps} Schritten`, await waitFor(`document.querySelectorAll(".setup-step").length === ${flowSteps}`));
  await openStep(FLOW_ID);
  check("Standard vorausgefüllt, Auswahl erst nach Laden, Knopf Einrichten", await waitFor(
    `document.getElementById("field-FLOW_NAME").value === "tybo" && document.getElementById("field-FLOW_ORG").disabled && document.querySelector('button[data-action="run"]')?.textContent === "Einrichten" && !document.querySelector('button[data-action="apply"]')`,
  ));
  await typeInto("field-FLOW_TOKEN", FLOW.token);
  await click('button[data-action="load-FLOW_ORG"]');
  check("Auswahl geladen", await waitFor(`!document.getElementById("field-FLOW_ORG").disabled && document.getElementById("field-FLOW_ORG").options.length === 3`));
  await js(`(() => { const s = document.getElementById("field-FLOW_ORG"); s.value = ${JSON.stringify(FLOW.org)}; s.dispatchEvent(new Event("change")); })()`);
  await typeInto("field-FLOW_PASSWORD", FLOW.password);
  await shootAll("einrichtung-ablauf-felder");
  await click('button[data-action="run"]');
  check("Plan vor der Bestätigung", await waitFor(`document.querySelector(".setup-plan")?.children.length === 3`));
  await shootAll("einrichtung-ablauf-plan");
  await click('button[data-action="run-confirm"]');
  check("Fortschritt erscheint", await waitFor(`document.querySelectorAll(".setup-run-events li").length === 3`, 6000));
  check("Abbrechen-Knopf da, Schritte gesperrt", await js<boolean>(`!!document.querySelector('button[data-action="run-cancel"]')`));
  await shootAll("einrichtung-ablauf-laeuft");
  await viewport(390);
  check("390 px: kein waagrechtes Scrollen im Ablauf", await noHorizontalScroll(390));
  await viewport(1280);
  release();
  check("Ergebnis nach dem Ablauf", await waitFor(`document.querySelector(".setup-result-ok")?.textContent === "Projekt angelegt und eingetragen."`, 8000));
  check("Schritt erledigt", await waitFor(`document.querySelector('.setup-step[data-step="${FLOW_ID}"]').dataset.state === "erledigt"`));
  await shootAll("einrichtung-ablauf-fertig");
  const html = await js<string>(`document.documentElement.outerHTML`);
  check("Token und Einmal-Passwort nirgends im Dokument", !html.includes(FLOW.token) && !html.includes(FLOW.password));

  // Zweiter Lauf, abgebrochen
  await typeInto("field-FLOW_TOKEN", FLOW.token);
  await click('button[data-action="load-FLOW_ORG"]');
  await waitFor(`!document.getElementById("field-FLOW_ORG").disabled`);
  await js(`(() => { const s = document.getElementById("field-FLOW_ORG"); s.value = ${JSON.stringify(FLOW.org)}; s.dispatchEvent(new Event("change")); })()`);
  await click('button[data-action="run"]');
  await waitFor(`document.querySelector('button[data-action="run-confirm"]')`);
  await click('button[data-action="run-confirm"]');
  await waitFor(`document.querySelector('button[data-action="run-cancel"]')`);
  await click('button[data-action="run-cancel"]');
  check("Abbrechen: Meldung des Ablaufs", await waitFor(`document.querySelector(".setup-result .actions-error")?.textContent === ${JSON.stringify(ABORTED_MESSAGE)}`, 8000));
  await shootAll("einrichtung-ablauf-abgebrochen");

  // --- Semantische Suche: Anbieterwahl (Issue #167) -----------------------------
  const BASE_ENV = `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_USER_ID=${USER_ID}\nUSER_NAME=Beispiel\nUSER_TIMEZONE=Europe/Berlin\n`;
  const cloud = await searchServer(`${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n`);
  check("Suche (Cloud): Standard OpenAI, Felder Schlüssel und Token", await waitFor(`document.getElementById("field-EMBEDDING_PROVIDER")?.value === "openai"`) && await fieldsAre(["EMBEDDING_PROVIDER", "SEARCH_OPENAI_KEY", "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]));
  check("Suche: drei Anbieter mit je einem Satz", await js<boolean>(`[...document.getElementById("field-EMBEDDING_PROVIDER").options].filter(o => o.value).map(o => o.value).join() === "openai,gemini,ollama"`));
  await shootAll("einrichtung-suche-openai");
  await choose("field-EMBEDDING_PROVIDER", "ollama");
  check("Suche (Cloud): Ollama blendet Adresse und Rückfrage ein, Token aus", await fieldsAre(["EMBEDDING_PROVIDER", "OLLAMA_URL", "SEARCH_OLLAMA_PULL"]));
  await click('button[data-action="run"]');
  check("Suche (Cloud): Plan erklärt, warum Ollama dort nicht geht", await waitFor(`document.querySelector(".setup-plan")?.textContent.includes("erreichen es nicht")`));
  await click('button[data-action="run-back"]');
  await choose("field-EMBEDDING_PROVIDER", "gemini");
  check("Suche (Cloud): Gemini blendet Gemini-Schlüssel und Token ein", await fieldsAre(["EMBEDDING_PROVIDER", "SEARCH_GEMINI_KEY", "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]));
  check("Gemini-Schlüssel: verdecktes Feld, leer, nicht vom Browser gemerkt", await js<boolean>(`(() => { const i = document.getElementById("field-SEARCH_GEMINI_KEY"); return i.type === "password" && i.value === "" && i.autocomplete === "new-password"; })()`));
  await typeInto("field-SEARCH_GEMINI_KEY", GEMINI.good);
  await typeInto("field-SUPABASE_SETUP_TOKEN", SB.token);
  await shootAll("einrichtung-suche-gemini");
  const geminiResult = await runSearch();
  check("Gemini: Einrichtung bis zum Nachweis", geminiResult.includes("Semantische Suche: aktiv (Google Gemini (gemini-embedding-2))"), geminiResult);
  check("Gemini: Geheimnisse bei Supabase samt Anbieter", cloud.fake.secrets[SB.ref]?.EMBEDDING_PROVIDER === "gemini" && cloud.fake.secrets[SB.ref]?.GEMINI_API_KEY === GEMINI.good);
  check("Gemini: Schlüssel nie in der Adresse", cloud.fake.sent.every(s => !s.url.includes(GEMINI.good)));
  check("Gemini: Schritt erledigt", await waitFor(`document.querySelector('.setup-step[data-step="suche"]').dataset.state === "erledigt"`));
  const afterGemini = await js<string>(`document.documentElement.outerHTML`);
  check("Gemini-Schlüssel und Token nirgends im Dokument", !afterGemini.includes(GEMINI.good) && !afterGemini.includes(SB.token));
  await shootAll("einrichtung-suche-gemini-fertig", showResult);

  const local = fakeLocal();
  const onMac = await searchServer(`${BASE_ENV}SUPABASE_URL=${LOCAL.apiUrl}\nSUPABASE_SERVICE_ROLE_KEY=${LOCAL.secret}\n`, local);
  check("Suche (lokal): Standard OpenAI, kein Token-Feld", await fieldsAre(["EMBEDDING_PROVIDER", "SEARCH_OPENAI_KEY", REINDEX_FIELD]));
  await choose("field-EMBEDDING_PROVIDER", "ollama");
  check("Suche (lokal): Ollama mit Adresse (Vorschlag) und Ja/Nein-Rückfrage", await fieldsAre(["EMBEDDING_PROVIDER", "OLLAMA_URL", "SEARCH_OLLAMA_PULL", REINDEX_FIELD]) && await js<boolean>(`document.getElementById("field-OLLAMA_URL").value === "http://localhost:11434" && [...document.getElementById("field-SEARCH_OLLAMA_PULL").options].map(o => o.value).join() === ",true,false"`));
  await choose("field-SEARCH_OLLAMA_PULL", "false");
  await shootAll("einrichtung-suche-ollama");
  const declined = await runSearch();
  check("Ollama, Download abgelehnt: Abbruch mit Befehl, kein Download", declined.includes("ollama pull bge-m3") && onMac.fake.ollama.pulls.length === 0, declined);
  check("Ollama, abgelehnt: nichts eingetragen", !(await Bun.file(functionsEnvPath(onMac.root)).exists()));
  await shootAll("einrichtung-suche-ollama-abgelehnt", showResult);
  await choose("field-EMBEDDING_PROVIDER", "ollama");
  await choose("field-SEARCH_OLLAMA_PULL", "true");
  const accepted = await runSearch();
  check("Ollama, Download bestätigt: ollama pull, dann Nachweis", accepted.includes("Semantische Suche: aktiv (Ollama (bge-m3))") && onMac.fake.ollama.pulls.join() === "bge-m3", accepted);
  check("Ollama: Functions mit Docker-Adresse, Supabase neu gestartet", (await Bun.file(functionsEnvPath(onMac.root)).text()).includes("OLLAMA_URL=http://host.docker.internal:11434") && local.trail().includes("supabase start"));
  await shootAll("einrichtung-suche-ollama-fertig", showResult);
  await viewport(390);
  check("Suche, 390 px: kein waagrechtes Scrollen", await noHorizontalScroll(390));
  await viewport(1280);

  // --- Semantische Suche: Rückfrage beim Anbieterwechsel (Issue #168) -------------
  const OPENAI_DB = { registry: { provider: "openai", model: "text-embedding-3-small" }, counts: { messages: { rows: 1200, chars: 480_000 }, memory: { rows: 40, chars: 4_000 }, knowledge: { rows: 10, chars: 16_000 } } } as const;
  const CLOUD_ENV = `${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n`;
  const noStart = (fake: SearchFake) => fake.sent.every(c => !c.url.endsWith("/rpc/embedding_reindex_start"));
  const changes = (fake: SearchFake) => fake.sent.filter(c => c.method === "POST" && /\/v1\/projects\/[a-z]+\/(functions\/deploy|secrets)/.test(c.url)).length;

  // Kein Wechsel: die Datenbank hält OpenAI fest, gewählt ist OpenAI
  const same = await searchServer(CLOUD_ENV, undefined, { ...OPENAI_DB });
  await typeInto("field-SEARCH_OPENAI_KEY", OPENAI.good);
  await typeInto("field-SUPABASE_SETUP_TOKEN", SB.token);
  check("Rückfrage: vor dem Laden gesperrt, Knopf Auswahl laden", await js<boolean>(`document.getElementById("field-${REINDEX_FIELD}").disabled && !!document.querySelector('button[data-action="load-${REINDEX_FIELD}"]')`));
  const sameChoices = await loadReindex();
  check("Kein Wechsel: nur „Weiter“, passt zur Datenbank", sameChoices.length === 1 && sameChoices[0].value === REINDEX_NONE && sameChoices[0].label.includes("passt zur Datenbank"), JSON.stringify(sameChoices));
  check("Kein Wechsel: keine Schätzung abgefragt", same.fake.sent.every(c => !c.url.endsWith("/rpc/embedding_reindex_estimate")));
  await choose(`field-${REINDEX_FIELD}`, REINDEX_NONE);
  await shootAll("einrichtung-suche-wechsel-keiner", showReindex);

  // Anbieterwechsel OpenAI → Gemini: Auswahl mit Umfang, Dauer und Kosten
  const change = await searchServer(CLOUD_ENV, undefined, { ...OPENAI_DB });
  await choose("field-EMBEDDING_PROVIDER", "gemini");
  // Erst die neue Sichtbarkeit abwarten: sonst verwirft die Seite eine Auswahl, die davor geladen wurde
  await fieldsAre(["EMBEDDING_PROVIDER", "SEARCH_GEMINI_KEY", "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]);
  await typeInto("field-SEARCH_GEMINI_KEY", GEMINI.good);
  await typeInto("field-SUPABASE_SETUP_TOKEN", SB.token);
  const changeChoices = await loadReindex();
  const yes = changeChoices.find(c => c.value === REINDEX_YES)?.label ?? "";
  check("Anbieterwechsel: erst Abbrechen, dann Alles neu berechnen", changeChoices.map(c => c.value).join() === `${REINDEX_NO},${REINDEX_YES}`, JSON.stringify(changeChoices));
  check("Anbieterwechsel: Abbrechen nennt, was bleibt", changeChoices[0]?.label.includes("es bleibt bei OpenAI (text-embedding-3-small)"));
  check("Anbieterwechsel: Umfang, Dauer und Kosten", yes.includes("Alles neu berechnen mit Google Gemini (gemini-embedding-2) statt OpenAI (text-embedding-3-small)") && yes.includes("ca. 1.250 Einträge") && yes.includes("Dauer etwa") && yes.includes("Kosten"), yes);
  check("Anbieterwechsel: noch nichts geändert", noStart(change.fake) && changes(change.fake) === 0);
  await choose(`field-${REINDEX_FIELD}`, REINDEX_YES);
  await shootAll("einrichtung-suche-wechsel-anbieter", showReindex);

  // Ablehnen: nichts geändert
  await choose(`field-${REINDEX_FIELD}`, REINDEX_NO);
  const declinedSwitch = await runSearch();
  check("Ablehnen: Abbruch, nichts geändert", declinedSwitch.includes("Abgebrochen, wie gewählt") && declinedSwitch.includes("Nichts wurde geändert"), declinedSwitch);
  check("Ablehnen: keine Functions, keine Geheimnisse, kein Beginn, kein Hintergrund", changes(change.fake) === 0 && noStart(change.fake) && change.launches.length === 0 && !change.fake.project.reindex);
  check("Ablehnen: .env unverändert", (await Bun.file(join(change.root, ".env")).text()) === CLOUD_ENV);
  await shootAll("einrichtung-suche-wechsel-abgelehnt", showResult);

  // Zustimmen: Lauf reserviert, eingerichtet, Neuberechnung im Hintergrund (Attrappe)
  await choose("field-EMBEDDING_PROVIDER", "gemini");
  await fieldsAre(["EMBEDDING_PROVIDER", "SEARCH_GEMINI_KEY", "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]);
  await typeInto("field-SEARCH_GEMINI_KEY", GEMINI.good);
  await typeInto("field-SUPABASE_SETUP_TOKEN", SB.token);
  await loadReindex();
  await choose(`field-${REINDEX_FIELD}`, REINDEX_YES);
  const acceptedSwitch = await runSearch();
  check("Zustimmen: Neuberechnung begonnen, Hinweis auf Textsuche, Meldung und Neustart (ungekürzt)", acceptedSwitch.includes("Neuberechnung auf Google Gemini (gemini-embedding-2) begonnen (ca. 1.250 Einträge") && acceptedSwitch.includes("nur Text") && acceptedSwitch.includes("Meldung in Telegram") && acceptedSwitch.includes("Neustart anfordern") && !acceptedSwitch.includes("…"), acceptedSwitch);
  const startAt = change.fake.sent.findIndex(c => c.url.endsWith("/rpc/embedding_reindex_start"));
  const firstChange = change.fake.sent.findIndex(c => c.method === "POST" && /\/v1\/projects\/[a-z]+\/(functions\/deploy|secrets)/.test(c.url));
  check("Zustimmen: Lauf reserviert vor den Änderungen", startAt > -1 && firstChange > startAt && !!change.fake.project.reindex?.leased);
  check("Zustimmen: Hintergrundlauf mit demselben Inhaber", change.launches.length === 1 && change.launches[0].at(-1) === `--inhaber=${change.fake.project.reindex?.holder}`);
  check("Zustimmen: Kennung bleibt bis zum Ende beim alten Anbieter", JSON.stringify(change.fake.project.registry) === JSON.stringify(OPENAI_DB.registry));
  const afterSwitch = await js<string>(`document.documentElement.outerHTML`);
  check("Zustimmen: Gemini-Schlüssel und Token nirgends im Dokument", !afterSwitch.includes(GEMINI.good) && !afterSwitch.includes(SB.token));
  await shootAll("einrichtung-suche-wechsel-zugestimmt", showResult);

  // Modellwechsel beim gleichen Anbieter (EMBEDDING_MODEL in der .env)
  const model = await searchServer(`${CLOUD_ENV}EMBEDDING_PROVIDER=openai\nEMBEDDING_MODEL=text-embedding-3-large\n`, undefined, { ...OPENAI_DB });
  await typeInto("field-SEARCH_OPENAI_KEY", OPENAI.good);
  await typeInto("field-SUPABASE_SETUP_TOKEN", SB.token);
  const modelChoices = await loadReindex();
  check("Modellwechsel: angeboten mit neuem und altem Modell", (modelChoices.find(c => c.value === REINDEX_YES)?.label ?? "").includes("OpenAI (text-embedding-3-large) statt OpenAI (text-embedding-3-small)"), JSON.stringify(modelChoices));
  check("Modellwechsel: noch nichts geändert", noStart(model.fake) && changes(model.fake) === 0);
  await choose(`field-${REINDEX_FIELD}`, REINDEX_YES);
  await shootAll("einrichtung-suche-wechsel-modell", showReindex);

  // Fehler beim Laden der Schätzung (Migration 20260928 fehlt): nur Abbrechen mit Grund
  const broken = await searchServer(CLOUD_ENV, undefined, { ...OPENAI_DB, reindexMissing: true });
  await choose("field-EMBEDDING_PROVIDER", "gemini");
  await fieldsAre(["EMBEDDING_PROVIDER", "SEARCH_GEMINI_KEY", "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]);
  await typeInto("field-SEARCH_GEMINI_KEY", GEMINI.good);
  await typeInto("field-SUPABASE_SETUP_TOKEN", SB.token);
  const brokenChoices = await loadReindex();
  check("Schätzung nicht ladbar: nur Abbrechen, mit Grund", brokenChoices.length === 1 && brokenChoices[0].value === REINDEX_NO && brokenChoices[0].label.includes("20260928_embedding_reindex.sql"), JSON.stringify(brokenChoices));
  await choose(`field-${REINDEX_FIELD}`, REINDEX_NO);
  await shootAll("einrichtung-suche-wechsel-schaetzung-fehler", showReindex);
  const brokenRun = await runSearch();
  check("Schätzung nicht ladbar: Einrichten ändert nichts", brokenRun.includes("Nichts wurde geändert") && changes(broken.fake) === 0 && noStart(broken.fake), brokenRun);
  await viewport(390);
  check("Rückfrage, 390 px: kein waagrechtes Scrollen", await noHorizontalScroll(390));
  await viewport(1280);

  // --- Linux mit systemd: Art des Autostarts (Issue #207) ------------------------
  /** Einrichtungs-Server auf einem Linux-Rechner als Attrappe, angemeldet, Schritt „Fertig“ offen */
  async function linuxServer(world: Partial<World>) {
    const c = await linuxCtx(world, { env: FULL_ENV, profile: PROFILE });
    const linuxCode = generateSetupCode();
    const s = await createSetupServer({ ctx: c, code: linuxCode, port: 0, supervisor: async () => null, startCommand: "cd ~/tybo && bun run start", log: () => {} });
    linuxServers.push(s);
    await goto(`${s.url}/`);
    await waitFor(`document.getElementById("code-form")`);
    await typeInto("code", formatSetupCode(linuxCode));
    await click("#code-button");
    await waitFor(`document.querySelectorAll(".setup-step").length === ${SETUP_STEPS.length}`);
    await openStep("pruefung");
    await waitFor(`document.getElementById("setup-autostart")`);
    return { server: s, ctx: c };
  }
  const managerOptions = () => js<string>(`[...document.getElementById("setup-manager").options].map(o => o.value + "=" + o.textContent).join("|")`);
  const showManager = () => js(`document.getElementById("setup-manager")?.scrollIntoView({ block: "center" })`);
  const tickAutostart = () => js(`(() => { const c = document.getElementById("setup-autostart"); if (!c.checked) c.click(); })()`);

  const pi = await linuxServer({ pm2: "absent" });
  check("systemd: Auswahl „Art des Autostarts“ mit Vorschlag systemd und PM2", await waitFor(`document.getElementById("setup-manager")`) &&
    (await managerOptions()) === "systemd=systemd-Benutzerdienst (Vorschlag)|pm2=PM2" &&
    await js<boolean>(`document.getElementById("setup-manager").value === "systemd" && document.querySelector('label[for="setup-manager"]').textContent === "Art des Autostarts"`), await managerOptions());
  check("systemd: Auswahl ohne Häkchen gesperrt", await js<boolean>(`document.getElementById("setup-manager").disabled && !document.getElementById("setup-autostart").checked`));
  await shootAll("einrichtung-autostart-systemd-gesperrt", showManager);
  await tickAutostart();
  check("systemd: mit Häkchen bedienbar", await waitFor(`!document.getElementById("setup-manager").disabled`));
  await shootAll("einrichtung-autostart-systemd", showManager);
  await viewport(390);
  check("systemd, 390 px: kein waagrechtes Scrollen", await noHorizontalScroll(390));
  await viewport(1280);
  await choose("setup-manager", "pm2");
  await shootAll("einrichtung-autostart-pm2", showManager);
  await click('button[data-action="finish"]');
  check("PM2 gewählt: Abschluss nennt PM2", await waitFor(`document.querySelector(".settings-intro")?.textContent.includes("den Autostart (PM2) ein")`));
  const piPlan = await pi.server.finished;
  check("PM2 gewählt: Plan autostart mit PM2 bis nach dem Schließen", piPlan.kind === "autostart" && piPlan.manager === "pm2", JSON.stringify(piPlan));
  check("PM2 gewählt: im Browser nichts eingerichtet oder gestartet", started(pi.ctx.run).length === 0, started(pi.ctx.run).join(" | "));
  await shootAll("einrichtung-autostart-pm2-fertig");

  const noManager = await linuxServer({ reachable: false, pm2: "absent" });
  check("Benutzer-Manager antwortet nicht: kein Vorschlag, „Bitte wählen“, nur PM2", await waitFor(`document.getElementById("setup-manager")`) && (await managerOptions()) === "=Bitte wählen|pm2=PM2" && await js<boolean>(`document.getElementById("setup-manager").value === ""`), await managerOptions());
  check("Benutzer-Manager antwortet nicht: Hinweis auf sudo/su", await js<boolean>(`[...document.querySelectorAll(".setup-note")].some(n => n.textContent.includes("nicht über sudo oder su"))`));
  await tickAutostart();
  await click('button[data-action="finish"]');
  check("ohne Wahl: „Fertig“ abgelehnt mit Grund", await waitFor(`document.querySelector(".setup-result .actions-error")?.textContent.includes("nicht über sudo")`));
  check("ohne Wahl: nicht abgeschlossen, nichts gestartet", !noManager.server.isFinished() && started(noManager.ctx.run).length === 0);
  await shootAll("einrichtung-autostart-ohne-systemd", showManager);

  const csp = problems.filter(p => /Content Security Policy|Refused/i.test(p));
  check("keine CSP-Verstöße", csp.length === 0, csp.join(" | "));
  const errors = problems.filter(p => !/Failed to load resource/.test(p));
  check("keine Skriptfehler", errors.filter(p => !/Content Security Policy|Refused/i.test(p)).length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  ws.close();
  chrome.kill();
  await chrome.exited;
  await server.stop();
  await flowServer?.stop();
  for (const s of searchServers) await s.stop();
  for (const s of linuxServers) await s.stop();
  await rm(dir, { recursive: true, force: true });
  await cleanupFixture();
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
