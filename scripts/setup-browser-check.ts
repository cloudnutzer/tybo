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
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  check("richtiger Code (klein, mit Bindestrich): Assistent öffnet", await waitFor(`location.pathname === "/" && document.querySelectorAll(".setup-step").length === 9`));
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
  check("Test-Schritt: Assistent mit 10 Schritten", await waitFor(`document.querySelectorAll(".setup-step").length === 10`));
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
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
