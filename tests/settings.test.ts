import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, utimesSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getSettings,
  writeSettings,
  setSettingsPath,
  parseAuxSpec,
  updateSettings,
  withSettingsLock,
  SettingsFileInvalidError,
  engineBackups,
  engineAuto,
  settingsSchema,
  EFFORT_LEVELS,
  SELECTABLE_ENGINES,
  type Settings,
} from "../src/lib/settings";

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

describe("Motor je Agent (M14-28)", () => {
  test("alte Datei und alle wählbaren Motoren bleiben beim Lesen und Schreiben erhalten", async () => {
    for (const entry of [{ model: "opus", effort: "high" as const }, ...SELECTABLE_ENGINES.map(engine => ({ engine }))]) {
      const settings = { agents: { research: entry } };
      expect(settingsSchema.parse(settings)).toEqual(settings);
      await writeSettings(settings);
      expect(getSettings()).toEqual(settings);
    }
  });

  test("ungültiger Motor wird abgelehnt, die letzte gültige Datei bleibt wirksam", async () => {
    const valid: Settings = { agents: { research: { engine: "codex" } } };
    await writeSettings(valid);
    expect(getSettings()).toEqual(valid);
    for (const engine of ["falsch", "", null, 1, true]) {
      const invalid = { agents: { research: { engine } } };
      expect(settingsSchema.safeParse(invalid).success).toBe(false);
      await expect(writeSettings(invalid as Settings)).rejects.toThrow();
      put(JSON.stringify(invalid));
      expect(getSettings()).toEqual(valid);
    }
  });
});

describe("Claude-Notizen (M14-14)", () => {
  test("alte Dateien bleiben gültig; nur Wahrheitswerte erlaubt, ungültige Werte ändern den Stand nicht", async () => {
    for (const codex of [{}, { claudeNotes: true }, { claudeNotes: false }]) {
      const settings = { engine: { codex } };
      expect(settingsSchema.parse(settings)).toEqual(settings);
      put(JSON.stringify(settings));
      expect(getSettings()).toEqual(settings);
    }
    for (const claudeNotes of ["false", "true", 0, 1, null, {}, []]) {
      const invalid = { engine: { codex: { claudeNotes } } };
      expect(settingsSchema.safeParse(invalid).success).toBe(false);
      await expect(writeSettings(invalid as Settings)).rejects.toThrow();
      put(JSON.stringify(invalid));
      expect(getSettings().engine?.codex?.claudeNotes).toBe(false);
    }
  });
});

describe("Codex-Skills (M14-13)", () => {
  test("alte Dateien bleiben gültig, an/aus sind Wahrheitswerte; ungültige Werte ändern den Stand nicht", async () => {
    for (const codex of [{}, { skills: true }, { skills: false }]) {
      put(JSON.stringify({ engine: { codex } }));
      expect(getSettings().engine?.codex).toEqual(codex);
    }
    for (const skills of ["false", 0, null, {}, []]) {
      const invalid = { engine: { codex: { skills } } };
      expect(settingsSchema.safeParse(invalid).success).toBe(false);
      await expect(writeSettings(invalid as Settings)).rejects.toThrow();
      put(JSON.stringify(invalid));
      expect(getSettings().engine?.codex?.skills).toBe(false);
    }
  });
});

describe("Motor-Ersatzstufen und Automatik (M14-05)", () => {
  test("alte Datei bleibt unverändert, Standards zentral aufgelöst", () => {
    put(JSON.stringify({ engine: { default: "codex" } }));
    expect(getSettings()).toEqual({ engine: { default: "codex" } });
    expect(engineBackups()).toEqual([]);
    expect(engineAuto()).toEqual({ enabled: false, threshold: 95, returnBelow: 80 });
    expect(engineAuto({ engine: { auto: { enabled: true } } }).enabled).toBe(false);
    expect(engineAuto({ engine: { backups: [], auto: { enabled: true } } }).enabled).toBe(false);
  });

  test("vier Stufen, Claude-Modelle und jede Effort-Stufe sind gültig", () => {
    for (const effort of EFFORT_LEVELS) {
      const settings: Settings = { engine: {
        backups: [{ engine: "claude" }, { engine: "claude", model: "claude-opus-5-5[1m]", effort },
          { engine: "codex" }, { engine: "opencode" }], auto: { threshold: 90 },
      } };
      put(JSON.stringify(settings));
      expect(getSettings()).toEqual(settings);
      expect(engineBackups()).toEqual(settings.engine!.backups!);
      expect(engineAuto()).toEqual({ enabled: true, threshold: 90, returnBelow: 75 });
    }
    for (const threshold of [50, 99]) {
      expect(settingsSchema.safeParse({ engine: { auto: { threshold, returnBelow: threshold - 5 } } }).success).toBe(true);
    }
    expect(settingsSchema.safeParse({ engine: { auto: { returnBelow: 0 } } }).success).toBe(true);
    expect(settingsSchema.safeParse({ engine: { backups: [{ engine: "claude", model: "a".repeat(100) }] } }).success).toBe(true);
    expect(engineAuto({ engine: { backups: [{ engine: "codex" }], auto: { enabled: false, returnBelow: 70 } } }))
      .toEqual({ enabled: false, threshold: 95, returnBelow: 70 });
  });

  test("ungültige Datei und Schreibversuche lassen die letzte gültige Fassung stehen", async () => {
    const valid: Settings = { engine: { backups: [{ engine: "codex" }], auto: { threshold: 90 } } };
    const invalid = [
      { backups: ["a", "b", "c", "d", "e"].map(model => ({ engine: "claude", model })) },
      { backups: [{ engine: "codex", model: "gpt-test" }] },
      { backups: [{ engine: "opencode", effort: "high" }] },
      { backups: [{ engine: "claude", model: "opus", effort: "low" }, { engine: "claude", model: "opus", effort: "high" }] },
      { backups: [{ engine: "codex" }, { engine: "codex" }] },
      { backups: [{ engine: "api" }] },
      ...["-option", "a b", "", "a".repeat(101), "../credentials"].map(model => ({ backups: [{ engine: "claude", model }] })),
      { backups: [{ engine: "claude", effort: "ultra" }] },
      ...[49, 100, 90.5].map(threshold => ({ auto: { threshold } })),
      ...[-1, 70.5, 92].map(returnBelow => ({ auto: { returnBelow } })),
      { auto: { threshold: 90, returnBelow: 86 } },
      { auto: { enabled: "true" } },
    ];
    for (const engine of invalid) {
      put(JSON.stringify(valid));
      expect(getSettings()).toEqual(valid);
      const before = readFileSync(file, "utf8");
      await expect(writeSettings({ engine } as Settings)).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(before);
      put(JSON.stringify({ engine }));
      expect(getSettings()).toEqual(valid);
    }
    expect(errorSpy).toHaveBeenCalledTimes(invalid.length);
  });
});

describe("Codex-MCP-Einstellungen (M14-11)", () => {
  test("gültige Teilkonfigurationen werden ohne neue Standards gelesen und geschrieben", async () => {
    for (const mcp of [{}, { enabled: false }, { enabled: true, skip: [], public: [] },
      { skip: ["suche", "A_1-b", "x".repeat(64)], public: ["stimme"] }]) {
      const settings = { engine: { codex: { mcp } } };
      put(JSON.stringify(settings));
      expect(getSettings()).toEqual(settings);
      await writeSettings(settings);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(settings);
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("ungültige Namen, Typen und unbekannte Felder werden abgelehnt", async () => {
    const valid: Settings = { engine: { codex: { mcp: { enabled: false } } } };
    put(JSON.stringify(valid));
    expect(getSettings()).toEqual(valid);
    const invalid: unknown[] = [null, false, [], { enabled: "false" }, { skip: "suche" }, { public: [1] }, { enabled: true, typo: [] }];
    for (const field of ["skip", "public"]) {
      for (const name of ["", "a.b", "a b", "a\n", "a\rb", "ä", "x".repeat(65)]) invalid.push({ [field]: [name] });
    }
    for (const mcp of invalid) {
      const settings = { engine: { codex: { mcp } } };
      expect(settingsSchema.safeParse(settings).success).toBe(false);
      await expect(writeSettings(settings as Settings)).rejects.toThrow();
      put(JSON.stringify(settings));
      expect(getSettings()).toEqual(valid);
    }
    expect(errorSpy).toHaveBeenCalledTimes(invalid.length);
  });

  test("alte Datei ohne MCP bleibt gültig und unverändert", () => {
    const old = { engine: { default: "codex", codex: { model: "gpt-test", sandbox: "read-only" } } };
    put(JSON.stringify(old));
    expect(getSettings()).toEqual(old);
    expect(getSettings().engine?.codex?.mcp).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });
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

  test("engine.codex.sandbox: drei Stufen gültig, andere Werte abgelehnt (Issue #124)", () => {
    for (const sandbox of ["read-only", "workspace-write", "full"] as const) {
      put(JSON.stringify({ engine: { codex: { sandbox } } }));
      expect(getSettings()).toEqual({ engine: { codex: { sandbox } } });
    }
    put(JSON.stringify({ engine: {} }));
    expect(getSettings()).toEqual({ engine: {} });
    for (const sandbox of ["danger-full-access", "", "FULL", 1]) {
      put(JSON.stringify({ engine: { codex: { sandbox } } }));
      expect(getSettings()).toEqual({ engine: {} });
    }
    expect(errorSpy).toHaveBeenCalledTimes(4);
  });

  test("engine: Standard, Gesprächs-Ausnahmen und Codex-Modell/Effort (Issue #125)", () => {
    const full: Settings = {
      engine: {
        default: "codex",
        topics: { "topic:-1001:7": "claude", "group:-1001": "codex", "dm:42": "codex", "dm:web": "claude", "web:0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f": "claude" },
        codex: { model: "gpt-5.6-sol", effort: "max", sandbox: "workspace-write" },
      },
    };
    put(JSON.stringify(full));
    expect(getSettings()).toEqual(full);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("engine: ungültige Werte werden abgelehnt, die letzte gültige Fassung bleibt (Issue #125)", () => {
    const valid = { engine: { default: "codex" } };
    put(JSON.stringify(valid));
    expect(getSettings()).toEqual(valid);
    const invalid = [
      { engine: { default: "opencode2" } },
      { engine: { default: "gpt" } },
      { engine: { topics: { "topic:-1001:7": "gemini" } } },
      { engine: { topics: { "irgendwas": "codex" } } },
      { engine: { topics: { "topic:1:2:../x": "codex" } } },
      { engine: { topics: { "dm:webx": "codex" } } },
      { engine: { codex: { effort: "ultra" } } },
      { engine: { codex: { model: "" } } },
      { engine: { codex: { model: "-c evil" } } },
    ];
    for (const content of invalid) {
      put(JSON.stringify(content));
      expect(getSettings()).toEqual(valid);
    }
    expect(errorSpy).toHaveBeenCalledTimes(invalid.length);
    // Wie im Issue [a-z0-9-]{1,20}: Bindestrich vorn und beide Längengrenzen sind gültig
    for (const variant of ["-x", "-", "--auto", "a", "a".repeat(20)]) {
      put(JSON.stringify({ engine: { opencode: { variant } } }));
      expect(getSettings()).toEqual({ engine: { opencode: { variant } } });
    }
  });

  test("engine.opencode: Standard, Ausnahme, Modell, Variante und Rechte (Issue #129)", () => {
    const full: Settings = {
      engine: {
        default: "opencode",
        topics: { "topic:-1001:7": "opencode", "dm:42": "claude" },
        opencode: { model: "openrouter/anthropic/claude-opus-5.5", variant: "high", permission: "ask-deny" },
      },
    };
    put(JSON.stringify(full));
    expect(getSettings()).toEqual(full);
    for (const variant of ["x", "max", "thinking-8k", "a".repeat(20), "0"]) {
      put(JSON.stringify({ engine: { opencode: { variant } } }));
      expect(getSettings()).toEqual({ engine: { opencode: { variant } } });
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("engine.opencode: ungültige Modelle und Varianten werden abgelehnt (Issue #129)", () => {
    const valid = { engine: { opencode: { variant: "low" } } };
    put(JSON.stringify(valid));
    expect(getSettings()).toEqual(valid);
    const invalid = [
      { engine: { opencode: { variant: "" } } },
      { engine: { opencode: { variant: "High" } } },
      { engine: { opencode: { variant: "a".repeat(21) } } },
      { engine: { opencode: { variant: "a b" } } },
      { engine: { opencode: { variant: "a_b" } } },
      { engine: { opencode: { model: "" } } },
      { engine: { opencode: { model: "--model x" } } },
      { engine: { opencode: { model: "-x/y" } } },
      { engine: { opencode: { model: "a b/c" } } },
      { engine: { opencode: { permission: "full" } } },
    ];
    for (const content of invalid) {
      put(JSON.stringify(content));
      expect(getSettings()).toEqual(valid);
    }
    expect(errorSpy).toHaveBeenCalledTimes(invalid.length);
  });

  // Bis 15.11.2026 galt max nur für Codex (Issue #125); seit Fable 5.2 Max auch für Claude
  test("max gilt für Codex und für Claude-Agenten, ultra für keinen", () => {
    put(JSON.stringify({ engine: { codex: { effort: "max" } } }));
    expect(getSettings()).toEqual({ engine: { codex: { effort: "max" } } });
    put(JSON.stringify({ agents: { research: { effort: "max" } } }));
    expect(getSettings()).toEqual({ agents: { research: { effort: "max" } } });
    put(JSON.stringify({ agents: { research: { effort: "ultra" } } }));
    expect(getSettings()).toEqual({ agents: { research: { effort: "max" } } });
    expect(errorSpy).toHaveBeenCalledTimes(1);
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
    ["unbekannter Effort", JSON.stringify({ defaults: { effort: "ultra" } })],
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
    await expect(writeSettings({ defaults: { effort: "ultra" as never } })).rejects.toThrow();
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

describe("updateSettings (Issue #125)", () => {
  test("erhält bestehende Werte und liest frisch aus der Datei", async () => {
    put(JSON.stringify({ defaults: { model: "m" }, engine: { codex: { sandbox: "read-only" } } }));
    await updateSettings((s) => ({ ...s, engine: { ...s.engine, default: "codex" } }));
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      defaults: { model: "m" },
      engine: { default: "codex", codex: { sandbox: "read-only" } },
    });
  });

  test("parallele Änderungen überschreiben sich nicht", async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        updateSettings((s) => ({ ...s, engine: { ...s.engine, topics: { ...s.engine?.topics, [`dm:${i}`]: "codex" as const } } }))
      )
    );
    expect(Object.keys(getSettings().engine?.topics ?? {}).sort()).toEqual(["dm:0", "dm:1", "dm:2", "dm:3", "dm:4", "dm:5"]);
  });

  test("eine ungültige Datei wird nicht überschrieben", async () => {
    put("{ kaputt");
    await expect(updateSettings((s) => ({ ...s, engine: { default: "codex" } }))).rejects.toBeInstanceOf(SettingsFileInvalidError);
    expect(readFileSync(file, "utf-8")).toBe("{ kaputt");
  });

  test("teilt die Schreibkette mit withSettingsLock", async () => {
    const order: string[] = [];
    // release steht vor dem Start fest: Ein Aufruf vor dem Start der Sperre ließe
    // held sonst für immer offen, und die Kette hielte jeden späteren Zugriff im
    // ganzen Testprozess an (etwa tests/web-speech-api.test.ts)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const held = withSettingsLock(async () => {
      order.push("lock");
      started();
      await gate;
      order.push("lock-ende");
    });
    const update = updateSettings((s) => {
      order.push("update");
      return s;
    });
    try {
      await running;
      await Bun.sleep(5);
      expect(order).toEqual(["lock"]);
    } finally {
      release();
    }
    await Promise.all([held, update]);
    expect(order).toEqual(["lock", "lock-ende", "update"]);
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
