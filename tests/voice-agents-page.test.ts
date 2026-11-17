/**
 * Issue #495, Aufgabe 4: reine Funktionen des Bereichs „Sprachagenten“
 * (sprachagenten.js) ohne Browser, dazu die Auswahl „Anderer Sprachagent“ der
 * Gesprächsseite in sprachagent.html. Den Durchlauf im Browser macht
 * scripts/web-sprachagent-check.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PUBLIC = resolve(import.meta.dir, "..", "src", "web", "public");
const SOURCE = await readFile(join(PUBLIC, "sprachagenten.js"), "utf8");
const page = new Function(
  `${SOURCE}\nreturn { voiceAgentsHashKennung, voiceAgentsMeta, voiceAgentsTestSummary, voiceAgentsTestLines, voiceAgentsMinutesLines, voiceAgentsPassed, VOICE_AGENTS_TEXT };`
)() as any;

const agent = (over: Record<string, unknown> = {}) => ({
  kennung: "jarvis",
  name: "Jarvis",
  vorlage: "jarvis",
  web: true,
  telefon: false,
  angelegt: true,
  letzterTest: null,
  laufenderTest: null,
  minutenMonat: 300,
  ...over,
});

describe("sprachagenten.js", () => {
  test("Kennung aus dem Hash, Unsinn ergibt null", () => {
    expect(page.voiceAgentsHashKennung("#jarvis")).toBe("jarvis");
    expect(page.voiceAgentsHashKennung("#mein-agent-2")).toBe("mein-agent-2");
    for (const bad of ["", "#", "#Jarvis", "#a/b", "#../x", "jarvis", "#a--b"]) expect(page.voiceAgentsHashKennung(bad)).toBeNull();
  });

  test("Meta-Zeile: Vorlage, Zugang, Anbieter, Testlauf", () => {
    expect(page.voiceAgentsMeta(agent())).toBe("Persönlicher Assistent · Browser · Noch kein Testlauf.");
    expect(page.voiceAgentsMeta(agent({ web: false, telefon: true, angelegt: false, vorlage: "anrufannahme" }), false)).toBe(
      "Anrufannahme · Telefon · beim Anbieter nicht angelegt"
    );
    expect(page.voiceAgentsMeta(agent({ web: false }), false)).toBe("Persönlicher Assistent · ohne Zugang");
  });

  test("Testlauf: laufend, verwaist, bestanden, Fehler ohne Zählung", () => {
    const run = {
      gestartetAm: "2026-11-08T10:00:00Z",
      beendetAm: "2026-11-08T10:02:00Z",
      ergebnis: "durchgefallen",
      tests: [
        { name: "Begrüßung", status: "bestanden" },
        { name: "Drängeln", status: "durchgefallen", kriterium: "bleibt ruhig" },
      ],
    };
    expect(page.voiceAgentsTestSummary(agent({ letzterTest: run }))).toMatch(/^Test durchgefallen, bestanden 1 von 2 \(8\.11\. \d\d:02\)$/);
    expect(page.voiceAgentsTestLines(run)).toEqual(["Begrüßung: bestanden", "Drängeln: durchgefallen, verfehlt: bleibt ruhig"]);
    expect(page.voiceAgentsTestSummary(agent({ letzterTest: { ...run, ergebnis: "fehler", tests: [] } }))).toMatch(/^Test Abfrage gescheitert \(/);
    expect(page.voiceAgentsTestSummary(agent({ laufenderTest: { gestartetAm: "2026-11-08T10:00:00Z", verfolgt: true } }))).toMatch(/^Testlauf läuft seit /);
    expect(page.voiceAgentsTestSummary(agent({ laufenderTest: { gestartetAm: "2026-11-08T10:00:00Z", verfolgt: false } }))).toBe(page.VOICE_AGENTS_TEXT.testOrphan);
  });

  test("Minuten: Budget, Browser-Minuten nur mit Web-Zugang, Telefon ausdrücklich nicht gezählt", () => {
    expect(page.voiceAgentsMinutesLines({ ...agent(), minutenWeb: { limit: 300, verbraucht: 14 } })).toEqual([
      "Budget: 300 Minuten im Monat.",
      "Im Browser diesen Monat: 14 von 300 Minuten, offene Gespräche zählen schon mit.",
    ]);
    expect(page.voiceAgentsMinutesLines({ ...agent(), minutenWeb: null })[1]).toBe(page.VOICE_AGENTS_TEXT.webUnknown);
    expect(page.voiceAgentsMinutesLines({ ...agent({ web: false, telefon: true }), minutenWeb: null })).toEqual([
      "Budget: 300 Minuten im Monat.",
      page.VOICE_AGENTS_TEXT.phoneNote,
    ]);
  });

  test("kein HTML aus dem Server; „Neu“ und Felder gehören dem Wizard (sprachagent-wizard.js, Issue #515)", () => {
    expect(SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(SOURCE).not.toMatch(/"Neu"|textarea|<input/);
  });
});

describe("sprachagent.html", () => {
  test("Stumm, Unterbrechen und Wechsel stehen bereit, verborgen bis gebraucht", async () => {
    const html = await readFile(join(PUBLIC, "sprachagent.html"), "utf8");
    expect(html).toMatch(/id="agent-mute"[^>]*hidden/);
    expect(html).toMatch(/id="agent-interrupt"[^>]*hidden/);
    expect(html).toMatch(/id="agent-switch"[^>]*hidden/);
    expect(html).toContain('href="/sprachagenten"');
  });
});
