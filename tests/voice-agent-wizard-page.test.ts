/**
 * Issue #515, Checkbox 4 und 5: Einbindung der Wizard-Oberfläche in den
 * Bereich /sprachagenten, ohne Browser. Seite und Skripte, Auslieferung hinter
 * dem Login, kein HTML aus dem Server, keine Antwort auf Rückfragen, nur
 * vorhandene Farben. Den Zustand prüft voice-agent-wizard-state.test.ts, den
 * Durchlauf im Browser scripts/web-sprachagent-wizard-check.ts.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { removeDraftDirs } from "./voice-agents-drafts-fixture";
import { removeWizardRoots, stopWizardServers, wizardHarness } from "./voice-agent-wizard-fixture";

const ROOT = resolve(import.meta.dir, "..");
const PUBLIC = join(ROOT, "src", "web", "public");
const read = (file: string) => readFile(join(PUBLIC, file), "utf8");
const HTML = await read("sprachagenten.html");
const WIZARD = await read("sprachagent-wizard.js");
const STATE = await read("sprachagent-wizard-state.js");
const PAGE = await read("sprachagenten.js");
const CSS = await read("style.css");

afterEach(async () => {
  await stopWizardServers();
});
afterAll(() => {
  removeWizardRoots();
  removeDraftDirs();
});

describe("Seite /sprachagenten mit Wizard", () => {
  test("Skripte in der Reihenfolge Zustand, Oberfläche, Seite; Knopf „Neu“, Entwürfe und Fläche des Wizards zunächst verborgen", () => {
    const scripts = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(["/theme.js", "/brand.js", "/sprachagent-wizard-state.js", "/sprachagent-wizard.js", "/sprachagenten.js"]);
    expect(HTML).toMatch(/<a id="va-new" class="primary-button voice-agents-new" href="#\/neu" hidden>Neu<\/a>/);
    expect(HTML).toMatch(/id="va-drafts"[^>]*hidden/);
    expect(HTML).toMatch(/id="va-wizard"[^>]*hidden/);
    expect(HTML).not.toMatch(/<script(?![^>]*src=)|style="/);
  });

  test("ohne Skript des Wizards bleibt der Bereich wie zuvor: Die Seite fragt, ob es ihn gibt", () => {
    expect(PAGE).toContain('typeof startVoiceAgentWizard === "function"');
    expect(PAGE).toContain("vaWizardRoute(window.location.hash)");
  });

  test("gebaut nur mit textContent, kein HTML aus dem Server, keine eigenen Stile", () => {
    for (const source of [WIZARD, STATE]) {
      expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\.|setAttribute\("style"/);
    }
  });

  test("der Wizard beantwortet keine Rückfrage: Er ruft nur seine eigenen Routen und verlinkt den Direktchat", () => {
    const paths = [...WIZARD.matchAll(/["`](\/api\/[^"`$?]*)/g), ...STATE.matchAll(/["`](\/api\/[^"`$?]*)/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(3);
    for (const path of paths) expect(path.startsWith("/api/voice-agents/wizard")).toBe(true);
    expect(WIZARD).toContain('const VA_WIZARD_CHAT = "/#/gespraech/dm";');
    // Ohne Kommentare: keine Beschriftung und kein Aufruf, der eine Rückfrage beantwortet
    const code = WIZARD.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/\/api\/choices|Trotzdem freischalten|Erneut versuchen|Gesperrt lassen/);
  });

  test("Tippflächen und Farben: 2.75rem am Handy, nur vorhandene Variablen, keine Bewegung", () => {
    const start = CSS.indexOf("/* Wizard für Sprachagenten (Issue #515)");
    const end = CSS.indexOf("/* Gesprächsseite: Stumm und Unterbrechen");
    expect(start).toBeGreaterThan(0);
    // Ohne Kommentare: „#515“ darin ist keine Farbe
    const block = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).toContain(".va-wizard .primary-button { min-height: 2.75rem; }");
    expect(block).toContain(".va-wizard-choice {");
    expect(block).toMatch(/\.va-wizard-step \{[^}]*min-height: 2\.75rem/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|transition|animation|@keyframes/);
    const variables = new Set([...block.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]));
    for (const v of variables) expect(CSS).toMatch(new RegExp(`^\\s*${v}:`, "m"));
  });
});

describe("Auslieferung", () => {
  test("Skripte des Wizards erst nach dem Login, Seite unter derselben CSP wie bisher", async () => {
    const w = await wizardHarness();
    for (const file of ["/sprachagent-wizard.js", "/sprachagent-wizard-state.js"]) {
      const anonymous = await fetch(`${w.ctx.origin}${file}`, { redirect: "manual" });
      expect(anonymous.status).toBe(302);
      const res = await fetch(`${w.ctx.origin}${file}`, { headers: { cookie: w.ctx.cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
    }
    const page = await fetch(`${w.ctx.origin}/sprachagenten`, { headers: { cookie: w.ctx.cookie } });
    const html = await page.text();
    expect(html).toContain("/sprachagent-wizard.js");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).not.toContain("elevenlabs");
  });
});
