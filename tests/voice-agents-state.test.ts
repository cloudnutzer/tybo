/**
 * Issue #489: Laufzeitzustand und Versionen der Sprachagenten, im temporären Ordner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceAgentError } from "../src/lib/voice-agents/base";
import { listVersions, readState, readVersion, recordVersion, updateState } from "../src/lib/voice-agents/state";

let root: string;
let paths: { dataDir: string };
const agentDir = () => join(paths.dataDir, "beispiel");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tybo-sprachagent-"));
  paths = { dataDir: join(root, "voice-agents") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("state.json", () => {
  test("ohne Datei null, danach Felder und Zeitpunkte", async () => {
    expect(await readState("beispiel", paths)).toBeNull();
    const first = new Date("2026-10-30T10:00:00Z");
    const later = new Date("2026-10-30T11:00:00Z");
    await updateState("beispiel", { anbieter: "elevenlabs", agentId: "agent-1" }, { ...paths, now: first });
    const state = await updateState("beispiel", { letzterHash: "abc", abgeglichenAm: later.toISOString() }, { ...paths, now: later });
    expect(state).toEqual({
      anbieter: "elevenlabs",
      agentId: "agent-1",
      // Issue #496: jede Agent-Kennung bleibt bekannt, damit verspätete Protokolle ihr Rezept finden
      bekannteAgentIds: ["agent-1"],
      letzterHash: "abc",
      abgeglichenAm: later.toISOString(),
      erstelltAm: first.toISOString(),
      geaendertAm: later.toISOString(),
    });
    expect(await readState("beispiel", paths)).toEqual(state);
    expect(JSON.parse(readFileSync(join(agentDir(), "state.json"), "utf8"))).toEqual(state);
  });

  test("Felder späterer Issues bleiben erhalten", async () => {
    await updateState("beispiel", { tests: { Notfall: "t1" } }, paths);
    await updateState("beispiel", { agentId: "a" }, paths);
    expect((await readState("beispiel", paths))?.tests).toEqual({ Notfall: "t1" });
  });

  test("Schreiben hinterlässt keine Zwischendateien", async () => {
    await updateState("beispiel", { agentId: "a" }, paths);
    expect(readdirSync(agentDir())).toEqual(["state.json"]);
  });

  test("beschädigte Datei: klarer Fehler, wird nicht überschrieben", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(join(agentDir(), "state.json"), "{ kaputt");
    await expect(readState("beispiel", paths)).rejects.toBeInstanceOf(VoiceAgentError);
    await expect(updateState("beispiel", { agentId: "a" }, paths)).rejects.toThrow("beschädigt");
    expect(readFileSync(join(agentDir(), "state.json"), "utf8")).toBe("{ kaputt");
    writeFileSync(join(agentDir(), "state.json"), JSON.stringify({ anbieter: 1 }));
    await expect(readState("beispiel", paths)).rejects.toThrow("beschädigt");
  });

  test("JSON null ist etwas anderes als eine fehlende Datei: Lesen und Aktualisieren lehnen ab", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(join(agentDir(), "state.json"), "null");
    await expect(readState("beispiel", paths)).rejects.toThrow("beschädigt");
    await expect(updateState("beispiel", { agentId: "a" }, paths)).rejects.toThrow("beschädigt");
    expect(readFileSync(join(agentDir(), "state.json"), "utf8")).toBe("null");
  });

  test("Kennung darf den Ordner nicht verlassen", async () => {
    for (const bad of ["../x", "a/b", "..", "Gross", "entwuerfe"]) {
      await expect(readState(bad, paths)).rejects.toThrow("Ungültige Kennung");
      await expect(updateState(bad, {}, paths)).rejects.toThrow("Ungültige Kennung");
      await expect(recordVersion(bad, {}, paths)).rejects.toThrow("Ungültige Kennung");
    }
    expect(existsSync(join(root, "x"))).toBe(false);
  });
});

describe("Versionen", () => {
  test("Erstversion", async () => {
    expect(await listVersions("beispiel", paths)).toEqual([]);
    expect(await recordVersion("beispiel", { a: 1 }, paths)).toEqual({ version: 1, neu: true });
    expect(await readVersion("beispiel", 1, paths)).toEqual({ a: 1 });
    expect(await readVersion("beispiel", 2, paths)).toBeNull();
  });

  test("unverändert keine neue Version, auch mit anderer Schlüsselreihenfolge", async () => {
    await recordVersion("beispiel", { a: 1, b: { c: 2, d: 3 } }, paths);
    expect(await recordVersion("beispiel", { b: { d: 3, c: 2 }, a: 1 }, paths)).toEqual({ version: 1, neu: false });
    expect(await listVersions("beispiel", paths)).toEqual([1]);
  });

  test("echte Änderung gibt die nächste Version, frühere bleiben", async () => {
    await recordVersion("beispiel", { a: 1 }, paths);
    expect(await recordVersion("beispiel", { a: 2 }, paths)).toEqual({ version: 2, neu: true });
    expect(await recordVersion("beispiel", { a: 1 }, paths)).toEqual({ version: 3, neu: true });
    expect(await readVersion("beispiel", 1, paths)).toEqual({ a: 1 });
    expect(await readVersion("beispiel", 2, paths)).toEqual({ a: 2 });
  });

  test("Vergleich mit der letzten Version, nicht mit dem Abgleich beim Anbieter", async () => {
    await recordVersion("beispiel", { a: 1 }, paths);
    await updateState("beispiel", { letzterHash: "anderer-stand" }, paths);
    expect(await recordVersion("beispiel", { a: 1 }, paths)).toEqual({ version: 1, neu: false });
  });

  test("nach einem Neustart zählt die Platte", async () => {
    await recordVersion("beispiel", { a: 1 }, paths);
    // Frische Modul-Instanz in einem eigenen Prozess, nichts im Speicher
    const script = `import { recordVersion } from ${JSON.stringify(join(import.meta.dir, "../src/lib/voice-agents/state"))};
      const paths = { dataDir: ${JSON.stringify(paths.dataDir)} };
      console.log(JSON.stringify([await recordVersion("beispiel", { a: 1 }, paths), await recordVersion("beispiel", { a: 2 }, paths)]));`;
    const run = Bun.spawnSync([process.execPath, "--eval", script]);
    expect(JSON.parse(run.stdout.toString())).toEqual([{ version: 1, neu: false }, { version: 2, neu: true }]);
  });

  test("Nummern sind auch bei gleichzeitigem Speichern eindeutig", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, a) => recordVersion("beispiel", { a }, paths)));
    expect(results.map((r) => r.version).sort((x, y) => x - y)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    for (const { version } of results) expect(await readVersion("beispiel", version, paths)).toBeTruthy();
    expect(readdirSync(join(agentDir(), "versionen")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("gleicher Inhalt zugleich ergibt eine Version", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => recordVersion("beispiel", { a: 1 }, paths)));
    expect(results.every((r) => r.version === 1)).toBe(true);
    expect(await listVersions("beispiel", paths)).toEqual([1]);
  });

  test("Lücken und fremde Dateien stören nicht", async () => {
    mkdirSync(join(agentDir(), "versionen"), { recursive: true });
    writeFileSync(join(agentDir(), "versionen", "7.json"), JSON.stringify({ a: 1 }));
    writeFileSync(join(agentDir(), "versionen", "notiz.txt"), "x");
    writeFileSync(join(agentDir(), "versionen", "9.json.abc.tmp"), "x");
    expect(await recordVersion("beispiel", { a: 2 }, paths)).toEqual({ version: 8, neu: true });
  });

  test("beschädigte letzte Version: klarer Fehler statt stiller neuer Version", async () => {
    mkdirSync(join(agentDir(), "versionen"), { recursive: true });
    writeFileSync(join(agentDir(), "versionen", "1.json"), "{ kaputt");
    await expect(recordVersion("beispiel", { a: 1 }, paths)).rejects.toThrow("beschädigt");
    expect(await listVersions("beispiel", paths)).toEqual([1]);
  });

  test("JSON null oder eine Liste als Version: beschädigt, keine neue Version", async () => {
    mkdirSync(join(agentDir(), "versionen"), { recursive: true });
    for (const content of ["null", "[]", "3"]) {
      writeFileSync(join(agentDir(), "versionen", "1.json"), content);
      await expect(readVersion("beispiel", 1, paths)).rejects.toThrow("beschädigt");
      await expect(recordVersion("beispiel", { a: 1 }, paths)).rejects.toThrow("beschädigt");
    }
    expect(await listVersions("beispiel", paths)).toEqual([1]);
  });
});

describe("symbolische Links", () => {
  let outside: string;
  const secret = JSON.stringify({ erstelltAm: "fremd", geaendertAm: "fremd", geheim: true });

  /** Name und Inhalt jeder Datei im fremden Ordner */
  function outsideFiles(): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (lstatSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
        else files[`${prefix}${name}`] = readFileSync(path, "utf8");
      }
    };
    walk(outside, "");
    return files;
  }

  /** Jeder Zugriff muss scheitern, ohne fremde Daten zu liefern oder dort etwas zu ändern. */
  async function expectAllRejected() {
    const before = outsideFiles();
    await expect(readState("beispiel", paths)).rejects.toThrow("symbolischer Link");
    await expect(updateState("beispiel", { agentId: "a" }, paths)).rejects.toThrow("symbolischer Link");
    await expect(recordVersion("beispiel", { a: 2 }, paths)).rejects.toThrow("symbolischer Link");
    expect(outsideFiles()).toEqual(before);
  }

  beforeEach(() => {
    outside = join(root, "fremd");
    mkdirSync(join(outside, "versionen"), { recursive: true });
    writeFileSync(join(outside, "state.json"), secret);
    writeFileSync(join(outside, "versionen", "1.json"), secret);
  });

  test("Agentenordner ist ein Link", async () => {
    mkdirSync(paths.dataDir, { recursive: true });
    symlinkSync(outside, agentDir());
    await expectAllRejected();
    await expect(listVersions("beispiel", paths)).rejects.toThrow("symbolischer Link");
    await expect(readVersion("beispiel", 1, paths)).rejects.toThrow("symbolischer Link");
  });

  test("Agentenordner ist ein Link ins Leere: dort entsteht nichts", async () => {
    mkdirSync(paths.dataDir, { recursive: true });
    const nowhere = join(root, "gibt-es-nicht");
    symlinkSync(nowhere, agentDir());
    await expectAllRejected();
    expect(existsSync(nowhere)).toBe(false);
  });

  test("Ablageordner ist ein Link", async () => {
    mkdirSync(join(outside, "beispiel"));
    writeFileSync(join(outside, "beispiel", "state.json"), secret);
    symlinkSync(outside, paths.dataDir);
    await expectAllRejected();
  });

  test("versionen ist ein Link", async () => {
    mkdirSync(agentDir(), { recursive: true });
    symlinkSync(join(outside, "versionen"), join(agentDir(), "versionen"));
    const before = outsideFiles();
    await expect(recordVersion("beispiel", { a: 2 }, paths)).rejects.toThrow("symbolischer Link");
    await expect(listVersions("beispiel", paths)).rejects.toThrow("symbolischer Link");
    await expect(readVersion("beispiel", 1, paths)).rejects.toThrow("symbolischer Link");
    expect(outsideFiles()).toEqual(before);
  });

  test("state.json ist ein Link: nichts gelesen, Link und Ziel bleiben", async () => {
    mkdirSync(agentDir(), { recursive: true });
    symlinkSync(join(outside, "state.json"), join(agentDir(), "state.json"));
    await expect(readState("beispiel", paths)).rejects.toThrow("symbolischer Link");
    await expect(updateState("beispiel", { agentId: "a" }, paths)).rejects.toThrow("symbolischer Link");
    expect(lstatSync(join(agentDir(), "state.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "state.json"), "utf8")).toBe(secret);
  });

  test("Versionsdatei ist ein Link: nichts gelesen, keine neue Nummer darüber", async () => {
    mkdirSync(join(agentDir(), "versionen"), { recursive: true });
    symlinkSync(join(outside, "versionen", "1.json"), join(agentDir(), "versionen", "1.json"));
    await expect(readVersion("beispiel", 1, paths)).rejects.toThrow("symbolischer Link");
    await expect(recordVersion("beispiel", JSON.parse(secret), paths)).rejects.toThrow("symbolischer Link");
    expect(await listVersions("beispiel", paths)).toEqual([1]);
    expect(readFileSync(join(outside, "versionen", "1.json"), "utf8")).toBe(secret);
  });
});
