/** Verdrahtung ohne echte CLI und ohne Zugriff auf die Skill-Ordner des Nutzers. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRuntime, createCodexEngine, setCodexRuntimeForTests, setCodexSkillSync, type CodexRuntime } from "../src/lib/engines/codex";
import { PROJECT_ROOT } from "../src/lib/env";
import { setSettingsPath } from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { ev, installCodexFake, type CodexFake } from "./codex-fixture";

let dir: string, settings: string, fake: CodexFake;
let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "tybo-skill-engine-"));
  settings = join(dir, "settings.json");
  setSettingsPath(settings);
  setMcpReaderForTests(() => new Set());
  fake = installCodexFake();
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fake.restore(); setSettingsPath(); setMcpReaderForTests(null); log.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});
function install(syncSkills: CodexRuntime["syncSkills"]) {
  fake.restore();
  fake = installCodexFake({ install: rt => setCodexRuntimeForTests(rt && { ...rt, syncSkills }) });
}
async function run(resumeSessionId?: string) {
  fake.next({ events: [ev.started("s"), ev.message("m", "Antwort"), ev.completed()] });
  return createCodexEngine().run({ cwd: dir, prompt: "hallo", streaming: true, timeoutMs: 1000, resumeSessionId });
}

test("neue Session synchronisiert vor dem Start nur PROJECT_ROOT, Fortsetzung nicht; Einstellung jedes Mal frisch", async () => {
  const inputs: unknown[] = [];
  install(input => { expect(fake.spawns).toHaveLength(inputs.length); inputs.push(input); });
  await run();
  expect(inputs).toEqual([expect.objectContaining({ root: PROJECT_ROOT, enabled: true })]);
  fs.writeFileSync(settings, JSON.stringify({ engine: { codex: { skills: false } } }));
  await run();
  expect(inputs[1]).toMatchObject({ root: PROJECT_ROOT, enabled: false });
  fs.unlinkSync(settings);
  await run();
  expect(inputs[2]).toMatchObject({ root: PROJECT_ROOT, enabled: true });
  await run("s");
  expect(inputs).toHaveLength(3);
  expect(fake.spawns).toHaveLength(4);
});

test("Fehler des Abgleichs kostet keine Antwort und zeigt keinen Quellpfad", async () => {
  install(() => { throw new Error("/privater/quellpfad"); });
  expect(await run()).toMatchObject({ isError: false, text: "Antwort" });
  expect(log.mock.calls.filter(c => String(c[0]).includes("Skill-Abgleich")))
    .toEqual([["[Codex] Skill-Abgleich fehlgeschlagen; Antwort läuft weiter."]]);
  expect(log.mock.calls.flat().join()).not.toContain("/privater/quellpfad");
});

test("Standard-Attrappe setzt auch nach App-Verdrahtung keinen echten Abgleich ein und liest keine Skill-Ordner", async () => {
  const defaultSync = codexRuntime().syncSkills;
  let synced = 0;
  setCodexSkillSync(() => { synced++; });
  expect(await run()).toMatchObject({ isError: false, text: "Antwort" });
  expect(synced).toBe(1);
  fake.restore(); fake = installCodexFake();
  expect(codexRuntime().syncSkills).toBe(defaultSync);
  const readDirs = spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("kein Dateizugriff"); });
  try {
    expect(await run()).toMatchObject({ isError: false, text: "Antwort" });
    expect(synced).toBe(1);
    expect(readDirs).not.toHaveBeenCalled();
  } finally { readDirs.mockRestore(); }
  expect(fs.readdirSync(dir)).toEqual([]);
});
