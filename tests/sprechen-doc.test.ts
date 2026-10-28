/**
 * Doku „Sprechmodus ohne Abo“ (Issue #252): docs/sprechen.md nennt
 * Wartezeiten mit Quelle (Praxistest, Datum, Gerät), sagt ausdrücklich, dass
 * es kein Advanced Voice Mode ist, nennt Datenschutz je Stufe und die
 * Lizenzen; handy-app.md, einrichtung.md und troubleshooting.md verweisen
 * darauf, und die relativen Links führen zu vorhandenen Dateien.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const DOC = read("docs/sprechen.md");

describe("docs/sprechen.md", () => {
  test("Abschnitt Sprechmodus ohne Abo mit Bedienung, Wartezeit, Datenschutz und Lizenzen", () => {
    for (const heading of ["## Sprechmodus ohne Abo", "### Was du brauchst", "### Wie es sich anfühlt", "### Wie lange es dauert", "### Datenschutz je Stufe", "### Lizenzen und Namensnennung"]) {
      expect({ heading, found: DOC.includes(`\n${heading}\n`) }).toEqual({ heading, found: true });
    }
  });

  test("Wartezeiten mit Quelle: Praxistest, Datum, Gerät, je Stufe", () => {
    expect(DOC).toContain("Praxistest 30.09.2026, Mac mit Apple M4 und 24 GB");
    expect(DOC).toContain("ca. 0,3 Sekunden für 10 bis 18 Sekunden Sprache");
    expect(DOC).toContain("RTF 0,10");
    expect(DOC).toContain("Messung 01.10.2026");
    // Modell-Messwert und Wartezeit im Browser getrennt (kein Streaming)
    expect(DOC).toContain("kein Streaming");
    expect(DOC).toContain("gilt hier also nicht");
    expect(DOC).toContain("Kaltstart");
    expect(DOC).toContain("Raspberry Pi");
  });

  test("ausdrücklich kein Advanced Voice Mode, kein Unterbrechen per Stimme über Lautsprecher", () => {
    expect(DOC).toContain("**Das ist kein Advanced Voice Mode.**");
    expect(DOC).toContain("Über Lautsprecher kann man tybo\nnicht per Stimme unterbrechen");
  });

  test("Lizenzen und Namensnennungen", () => {
    expect(DOC).toContain("**Parakeet TDT 0.6B v3** von NVIDIA, Lizenz CC-BY-4.0");
    expect(DOC).toContain("**Kyutai Pocket TTS**");
    expect(DOC).toContain("expresso");
    expect(DOC).toContain("GPL-3.0");
    expect(DOC).toContain("Thorsten-Voice unter CC0");
  });

  test("Verweise aus handy-app.md, einrichtung.md und troubleshooting.md; relative Links führen zu Dateien", () => {
    for (const from of ["docs/handy-app.md", "docs/einrichtung.md", "docs/troubleshooting.md"]) expect(read(from)).toContain("(sprechen.md)");
    const links = [...DOC.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]).filter(h => !/^[a-z]+:/i.test(h) && !h.startsWith("#"));
    for (const href of links) expect({ href, exists: existsSync(resolve(join(ROOT, dirname("docs/sprechen.md")), href.split("#")[0])) }).toEqual({ href, exists: true });
  });

  test("keine Gedankenstriche", () => {
    expect(DOC).not.toContain("—");
  });
});

describe("docs/sprechen.md, Telefonhörer (Issue #260)", () => {
  const CALL = DOC.slice(DOC.indexOf("\n## Telefonhörer\n"));

  test("Abgrenzung in einer Tabelle: Sprechmodus, Telefonhörer, Telefon über ElevenLabs", () => {
    expect(DOC).toContain("| | Sprechmodus | Telefonhörer | Telefon über einen ElevenLabs-Agenten |");
  });

  test("Abschnitte: was man braucht, Erwartung, Grenzen, Kosten, Datenschutz, Verlauf, Fehlerbilder", () => {
    for (const heading of ["### Was du brauchst", "### Ehrliche Erwartung", "### Grenzen gegenüber ElevenLabs", "### Kosten je Weg", "### Datenschutz im Telefonhörer", "### Das Gespräch im Verlauf", "### Wenn es nicht geht"]) {
      expect({ heading, found: CALL.includes(`\n${heading}\n`) }).toEqual({ heading, found: true });
    }
  });

  test("Wartezeiten mit Quelle (Messung, Datum, Gerät), Planung und gebauter Stand getrennt; kein Advanced Voice Mode", () => {
    expect(CALL).toContain("**Das ist kein Advanced Voice Mode.**");
    expect(CALL).toContain("**Planung (30.09.2026):**");
    expect(CALL).toContain("**Gebaut (02.10.2026):**");
    expect(CALL).toContain("Mac mit Apple M4 und\n  24 GB");
    for (const t of ["**Weg A: Anthropic Messages API direkt**", "**Weg B: Claude Code im Abo**", "**Weg C: OpenRouter und Ollama**", "**Geschätzte Gesamtzeit: Ende der Äußerung bis erster Ton**"]) expect(CALL).toContain(t);
    expect(CALL).toContain("| `claude-sonnet-5-5`, effort medium | 1,40 (1,23 bis 1,74) |");
    expect(CALL).toContain("| API direkt, Sonnet 5.5 | 2,6 s (2,3 bis 3,1) | flüssig, gleichmäßig |");
    expect(CALL).toContain("nicht über das gebaute sherpa-onnx");
  });

  test("Grenzen gegenüber ElevenLabs: Pause statt Sinn, Lautsprecher, eine deutsche Stimme als Standard, Abo, Rechnen", () => {
    expect(CALL).toContain("an der Pause, nicht am Sinn");
    expect(CALL).toContain("Sprechpause auf „lang“");
    expect(CALL).toContain("mit Kopfhörer gut");
    expect(CALL).toContain("standardmäßig mit „juergen“");
    expect(CALL).toContain("Piper (Thorsten) und die Browser-Stimme");
    expect(CALL).toContain("erst nach 3 bis 5 Sekunden");
    expect(CALL).toContain("mit dem Rechenwerkzeug, nicht im Kopf");
  });

  test("Kosten mit Quelle der Preise, Fehlerbilder, keine Convex-Grenze mehr (Issue #324)", () => {
    expect(CALL).toContain("platform.claude.com/docs/en/about-claude/pricing, abgerufen\n30.09.2026");
    expect(CALL).toContain("elevenlabs.io/pricing/agents, abgerufen 30.09.2026");
    expect(CALL).toContain("**Kein Knopf „Telefonhörer“:**");
    expect(CALL).toContain("**Mikrofon verweigert:**");
    expect(CALL).toContain("hinter einem eigenen Proxy");
    expect(CALL).not.toContain("**Mit Convex**");
  });

  test("handy-app.md, fernzugang.md, einrichtung.md und troubleshooting.md haben ihren Abschnitt", () => {
    expect(read("docs/handy-app.md")).toContain("\n### Mit tybo sprechen\n");
    expect(read("docs/webui/fernzugang.md")).toContain("**Telefonhörer (WebSocket):**");
    expect(read("docs/einrichtung.md")).toContain("\n#### Weg Telefonhörer\n");
    expect(read("docs/troubleshooting.md")).toContain("\n### Telefonhörer\n");
    for (const from of ["docs/handy-app.md", "docs/webui/fernzugang.md", "docs/einrichtung.md", "docs/troubleshooting.md"]) expect(read(from)).not.toContain("—\n### Telefonhörer");
  });
});
