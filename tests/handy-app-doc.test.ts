/**
 * Anleitung „tybo als App auf dem Handy" (Issue #229): die Datei gibt es,
 * README.md, docs/einrichtung.md, docs/webui/README.md und
 * docs/webui/fernzugang.md verlinken sie, ihre relativen Links führen zu
 * vorhandenen Dateien, und sie nennt die Grenzen.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const GUIDE = "docs/handy-app.md";
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Relative Markdown-Links einer Datei, ohne Anker */
function relativeLinks(path: string): string[] {
  return [...read(path).matchAll(/\]\(([^)\s]+)\)/g)]
    .map(m => m[1])
    .filter(href => !/^[a-z]+:/i.test(href) && !href.startsWith("#"))
    .map(href => href.split("#")[0]);
}

describe("docs/handy-app.md", () => {
  test("existiert mit Titel und Abschnitten für iPhone, Android, Benachrichtigungen, Kanäle und Grenzen", () => {
    const text = read(GUIDE);
    expect(text.startsWith("# tybo als App auf dem Handy\n")).toBe(true);
    for (const heading of ["## Voraussetzung: eine HTTPS-Adresse", "## iPhone und iPad", "## Android", "### Aus anderen Apps an tybo teilen (nur Android)", "## Benachrichtigungen", "## Nur Web-App, nur Telegram oder beides", "## Grenzen"]) {
      expect({ heading, found: text.includes(`\n${heading}\n`) }).toEqual({ heading, found: true });
    }
  });

  test("nennt Voraussetzungen und Grenzen", () => {
    const text = read(GUIDE);
    for (const needle of [
      "WEB_PUBLIC_ORIGIN",
      "Session duration",
      "iOS 16.4",
      "Zum Home-Bildschirm",
      "App installieren",
      "Kein Teilen-Ziel auf dem iPhone",
      "Keine Offline-Nutzung",
      "http://<IP>:3100",
      "Anmeldung läuft ab",
      "Benachrichtigungen brauchen den Rechner",
      "Anderes Gespräch",
      "Foto aufnehmen",
    ]) {
      expect({ needle, found: text.includes(needle) }).toEqual({ needle, found: true });
    }
    // Keine feste Adresse (Issue #231): drei Wege über tybo setup zugang, keine app.tybo.ai
    for (const needle of ["tybo setup zugang", "Tailscale", "Cloudflare Tunnel mit eigener Domain", "Nur auf diesem Rechner"]) {
      expect({ needle, found: text.includes(needle) }).toEqual({ needle, found: true });
    }
    expect(text).not.toContain("app.tybo.ai");
    expect(text).not.toContain("—");
  });

  test("README, Einrichtung, WebUI-README und Fernzugang verlinken die Anleitung", () => {
    const linking: [string, string][] = [
      ["README.md", "docs/handy-app.md"],
      ["docs/einrichtung.md", "handy-app.md"],
      ["docs/webui/README.md", "../handy-app.md"],
      ["docs/webui/fernzugang.md", "../handy-app.md"],
    ];
    for (const [file, href] of linking) {
      expect({ file, linked: relativeLinks(file).includes(href) }).toEqual({ file, linked: true });
      expect(resolve(ROOT, dirname(file), href)).toBe(join(ROOT, GUIDE));
    }
    expect(read("README.md")).toContain("\n## tybo on your phone\n");
  });

  test("alle relativen Links der Anleitung führen zu vorhandenen Dateien", () => {
    const links = relativeLinks(GUIDE);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      expect({ href, exists: existsSync(resolve(ROOT, dirname(GUIDE), href)) }).toEqual({ href, exists: true });
    }
  });
});
