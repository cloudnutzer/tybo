import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, utimesSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getSettings, writeSettings, setSettingsPath, parseAuxSpec, type Settings } from "../src/lib/settings";

// Jede Probe arbeitet in einem eigenen temporären Ordner, nie in config/.

let dir: string;
let file: string;
let errorSpy: ReturnType<typeof spyOn>;

/** Schreibt die Datei und stellt eine eindeutige mtime sicher (gleiche Größe darf nicht untergehen). */
let tick = 1_000;
function put(content: string) {
  writeFileSync(file, content);
  tick += 10;
  utimesSync(file, tick, tick);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bot-settings-"));
  file = join(dir, "settings.json");
  setSettingsPath(file);
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  setSettingsPath();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("Laden", () => {
  test("fehlende Datei ergibt leere Einstellungen ohne Log", () => {
    expect(getSettings()).toEqual({});
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("{} und Teilkonfigurationen sind gültig", () => {
    put("{}");
    expect(getSettings()).toEqual({});
    put(JSON.stringify({ agents: { research: { effort: "low" } } }));
    expect(getSettings()).toEqual({ agents: { research: { effort: "low" } } });
    put(JSON.stringify({ fallback: { offlineOnly: false } }));
    expect(getSettings()).toEqual({ fallback: { offlineOnly: false } });
  });

  test("volle Datei wird gelesen", () => {
    const full: Settings = {
      defaults: { model: "claude-opus-5", effort: "high" },
      agents: { finance: { model: "claude-sonnet-5", effort: "medium" }, general: {} },
      aux: { judge: "claude:claude-opus-5", distill: "ollama:qwen3:8b", review: "openrouter:minimax/minimax-m2.7" },
      fallback: { openrouterModel: "x/y", ollamaModel: "qwen3:8b", offlineOnly: true },
    };
    put(JSON.stringify(full));
    expect(getSettings()).toEqual(full);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("liest bei unveränderter Datei nicht neu", () => {
    put(JSON.stringify({ defaults: { model: "a" } }));
    const first = getSettings();
    expect(getSettings()).toBe(first);
  });
});

describe("ungültige Datei", () => {
  const invalid: [string, string][] = [
    ["kein JSON", "{ nicht json"],
    ["leerer Modellname", JSON.stringify({ defaults: { model: "  " } })],
    ["leerer Agenten-Modellname", JSON.stringify({ agents: { research: { model: "" } } })],
    ["unbekannter Effort", JSON.stringify({ defaults: { effort: "max" } })],
    // Unbekannte Kennungen und Aliasse sind seit Issue #49 gültig und werden ignoriert (tests/agent-settings.test.ts)
    ["ungültige Agenten-Kennung", JSON.stringify({ agents: { "Hacker!": { model: "a" } } })],
    ["Aux ohne Doppelpunkt", JSON.stringify({ aux: { judge: "claude-opus-5" } })],
    ["Aux mit unbekannter Art", JSON.stringify({ aux: { judge: "gpt:modell" } })],
    ["Aux ohne Modell", JSON.stringify({ aux: { review: "ollama:" } })],
    ["offlineOnly als Text", JSON.stringify({ fallback: { offlineOnly: "true" } })],
    ["Array statt Objekt", "[]"],
  ];

  for (const [name, content] of invalid) {
    test(`beim Start (${name}): leere Einstellungen und eine Log-Zeile`, () => {
      put(content);
      expect(getSettings()).toEqual({});
      expect(getSettings()).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain("ungueltig");
    });
  }

  test("gültig, ungültig, gültig: dazwischen bleibt die letzte gültige Fassung", () => {
    put(JSON.stringify({ defaults: { model: "erst" } }));
    expect(getSettings().defaults?.model).toBe("erst");
    put(JSON.stringify({ defaults: { model: "" } }));
    expect(getSettings().defaults?.model).toBe("erst");
    put("{ kaputt");
    expect(getSettings().defaults?.model).toBe("erst");
    expect(errorSpy).toHaveBeenCalledTimes(2);
    put(JSON.stringify({ defaults: { model: "dann" } }));
    expect(getSettings().defaults?.model).toBe("dann");
  });
});

describe("Neuladen ohne Neustart", () => {
  test("geänderte mtime lädt neu, auch bei gleicher Größe", () => {
    put(JSON.stringify({ defaults: { model: "aaaa" } }));
    expect(getSettings().defaults?.model).toBe("aaaa");
    put(JSON.stringify({ defaults: { model: "bbbb" } }));
    expect(getSettings().defaults?.model).toBe("bbbb");
  });

  test("Löschen ergibt leere Einstellungen, Wiederanlegen gilt sofort", () => {
    put(JSON.stringify({ defaults: { model: "a" } }));
    expect(getSettings().defaults?.model).toBe("a");
    rmSync(file);
    expect(getSettings()).toEqual({});
    put(JSON.stringify({ defaults: { model: "b" } }));
    expect(getSettings().defaults?.model).toBe("b");
  });

  test("nach Löschen gilt eine ungültige neue Datei als leer, nicht als alte Fassung", () => {
    put(JSON.stringify({ defaults: { model: "a" } }));
    getSettings();
    rmSync(file);
    getSettings();
    put("{ kaputt");
    expect(getSettings()).toEqual({});
  });
});

describe("Schreiben", () => {
  test("schreibt atomar mit Rechten 0600 und wird sofort gelesen", async () => {
    await writeSettings({ agents: { research: { model: "m1" } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ agents: { research: { model: "m1" } } });
    expect(getSettings().agents?.research?.model).toBe("m1");
    await writeSettings({ agents: { research: { model: "m2" } } });
    expect(getSettings().agents?.research?.model).toBe("m2");
    // keine liegengebliebenen Temp-Dateien
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  test("ersetzt eine vorhandene Datei mit weiten Rechten durch 0600", async () => {
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    await writeSettings({ defaults: { effort: "low" } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("prüft vor dem Schreiben: ungültiger Inhalt wirft, Datei bleibt unverändert", async () => {
    await writeSettings({ defaults: { model: "gut" } });
    const before = readFileSync(file, "utf-8");
    await expect(writeSettings({ defaults: { model: "" } })).rejects.toThrow();
    await expect(writeSettings({ aux: { judge: "ohne-art" } })).rejects.toThrow();
    await expect(writeSettings({ defaults: { effort: "max" as never } })).rejects.toThrow();
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(getSettings().defaults?.model).toBe("gut");
  });

  test("Schreibfehler lässt die bisherige Datei stehen", async () => {
    await writeSettings({ defaults: { model: "alt" } });
    const before = readFileSync(file, "utf-8");
    chmodSync(dir, 0o500); // Ordner schreibgeschützt: Temp-Datei kann nicht angelegt werden
    try {
      await expect(writeSettings({ defaults: { model: "neu" } })).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(getSettings().defaults?.model).toBe("alt");
  });
});

describe("parseAuxSpec", () => {
  test("trennt am ersten Doppelpunkt", () => {
    expect(parseAuxSpec("ollama:qwen3:8b")).toEqual({ kind: "ollama", model: "qwen3:8b" });
    expect(parseAuxSpec(" Claude:claude-opus-5 ")).toEqual({ kind: "claude", model: "claude-opus-5" });
    expect(parseAuxSpec("openrouter:minimax/minimax-m2.7")).toEqual({
      kind: "openrouter",
      model: "minimax/minimax-m2.7",
    });
  });

  test("lehnt ungültige Formate ab", () => {
    for (const bad of ["", "claude", ":modell", "claude:", "claude:  ", "gpt:4"]) {
      expect(parseAuxSpec(bad)).toBeNull();
    }
  });
});
