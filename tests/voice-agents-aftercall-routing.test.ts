/**
 * Issue #496, Aufgabe 1: Weiche nach agent_id und Ablage je Gespräch.
 * Rezept-Agenten gehen nie an den Anrufdienst, fremde wie bisher, doppelte
 * Zustellung (nacheinander, gleichzeitig, nach Neustart) legt nichts doppelt an.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationFile, readConversation } from "../src/lib/voice-agents/aftercall";
import { readState, updateState } from "../src/lib/voice-agents/state";
import { expertRecipe, harness, jarvisRecipe, PRACTICE, tempPaths, writeRecipe, writeState } from "./voice-agents-aftercall-fixture";

let root: string;
let paths: ReturnType<typeof tempPaths>["paths"];

beforeEach(() => {
  ({ root, paths } = tempPaths());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Weiche", () => {
  test("Rezept-Agent: Ablage beim Rezept, nie an den Anrufdienst", async () => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    const h = harness(paths);
    expect(await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer", startedAt: Date.parse("2026-11-08T09:30:00Z") })).toBe("accepted");
    await h.aftercall.idle();
    expect(h.phoneCalls).toEqual([]);
    const record = await readConversation("trainer", "conv_1", paths);
    expect(record?.protokoll).toEqual(PRACTICE);
    expect(record?.agentId).toBe("agent_trainer");
    expect(record?.zeit).toBe(Date.parse("2026-11-08T09:30:00Z"));
  });

  test("unbekannter Agent und fehlende agent_id: wie bisher an den Anrufdienst", async () => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    const h = harness(paths);
    expect(await h.aftercall.receiveTranscript("conv_fremd", PRACTICE, { agentId: "agent_anderer" })).toBe("accepted");
    expect(await h.aftercall.receiveTranscript("conv_ohne", PRACTICE)).toBe("accepted");
    expect(h.phoneCalls.map((c) => c.id)).toEqual(["conv_fremd", "conv_ohne"]);
    expect(h.phoneCalls[0]!.lines).toEqual(PRACTICE);
    expect(existsSync(join(paths.dataDir, "trainer", "gespraeche"))).toBe(false);
  });

  test("ohne Ablageordner geht alles an den Anrufdienst", async () => {
    rmSync(paths.dataDir, { recursive: true });
    const h = harness(paths);
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_x" });
    expect(h.phoneCalls).toHaveLength(1);
  });

  test("fehlende agent_id, aber Gesprächs-ID aus einem Web-Gespräch des Rezepts", async () => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    writeFileSync(
      join(paths.dataDir, "trainer", "web-sitzungen.json"),
      JSON.stringify({ format: 1, sitzungen: [{ id: "r1", gespraech: "conv_web", start: 1, ende: null, minuten: 12, bis: 2, tokenBis: 2 }], versuche: [] }),
    );
    const h = harness(paths);
    expect(await h.aftercall.receiveTranscript("conv_web", PRACTICE)).toBe("accepted");
    await h.aftercall.idle();
    expect(h.phoneCalls).toEqual([]);
    expect(await readConversation("trainer", "conv_web", paths)).not.toBeNull();
  });

  test("ersetzter und entfernter Agent: frühere Kennungen bleiben dem Rezept zugeordnet", async () => {
    writeRecipe(paths, expertRecipe());
    await updateState("trainer", { agentId: "agent_alt" }, paths);
    await updateState("trainer", { agentId: "agent_neu" }, paths);
    await updateState("trainer", { agentId: undefined }, paths);
    expect((await readState("trainer", paths))?.bekannteAgentIds).toEqual(["agent_alt", "agent_neu"]);
    const h = harness(paths);
    await h.aftercall.receiveTranscript("conv_spaet", PRACTICE, { agentId: "agent_alt" });
    await h.aftercall.idle();
    expect(h.phoneCalls).toEqual([]);
    expect(await readConversation("trainer", "conv_spaet", paths)).not.toBeNull();
  });

  test("Zustand von vor #496 mit ersetztem Agenten: Nachlauf beim Anbieter entfernt ihn, verspätetes Protokoll bleibt beim Rezept", async () => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_neu", ersetzterAgentId: "agent_alt" });
    // So räumt elevenlabs.ts nach dem Löschen beim Anbieter auf
    await updateState("trainer", { ersetzterAgentId: undefined }, paths);
    const state = await readState("trainer", paths);
    expect(state?.ersetzterAgentId).toBeUndefined();
    expect(state?.bekannteAgentIds).toEqual(["agent_neu", "agent_alt"]);
    const h = harness(paths);
    expect(await h.aftercall.receiveTranscript("conv_alt", PRACTICE, { agentId: "agent_alt" })).toBe("accepted");
    await h.aftercall.idle();
    expect(h.phoneCalls).toEqual([]);
    expect((await readConversation("trainer", "conv_alt", paths))?.agentId).toBe("agent_alt");
  });

  test("schon angenommenes Gespräch bleibt beim Rezept, auch mit anderer oder ohne agent_id", async () => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    const h = harness(paths);
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" });
    await h.aftercall.idle();
    writeState(paths, "trainer", {});
    expect(await h.aftercall.receiveTranscript("conv_1", PRACTICE)).toBe("known");
    expect(h.phoneCalls).toEqual([]);
  });

  test("beschädigter Zustand irgendeines Rezepts: Fehler statt Direktchat", async () => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    writeState(paths, "kaputt", "{ nicht json");
    const h = harness(paths);
    await expect(h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_unbekannt" })).rejects.toThrow(/Zuordnung des Gesprächs unklar/);
    expect(h.phoneCalls).toEqual([]);
    // Ohne agent_id spielt der Zustand keine Rolle: Zuordnung nur über Ablage und Web-Gespräche
    expect(await h.aftercall.receiveTranscript("conv_2", PRACTICE)).toBe("accepted");
    expect(h.phoneCalls.map((c) => c.id)).toEqual(["conv_2"]);
  });

  test("beschädigte Web-Gespräche: Fehler statt Direktchat", async () => {
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    writeFileSync(join(paths.dataDir, "trainer", "web-sitzungen.json"), "null");
    const h = harness(paths);
    await expect(h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_fremd" })).rejects.toThrow(/unklar/);
    expect(h.phoneCalls).toEqual([]);
  });

  test("Agent des Anrufdienstes geht auch bei unlesbarer Ablage an den Anrufdienst (/anruf)", async () => {
    writeState(paths, "kaputt", "{ nicht json");
    const h = harness(paths, { phoneAgentId: "agent_anruf" });
    expect(await h.aftercall.receiveTranscript("conv_anruf", PRACTICE, { agentId: "agent_anruf" })).toBe("accepted");
    expect(h.phoneCalls.map((c) => c.id)).toEqual(["conv_anruf"]);
  });

  test("beschädigtes Rezept: Gespräch wird abgelegt und wartet, nie Direktchat", async () => {
    writeFileSync(join(paths.configDir, "trainer.json"), "{ kaputt");
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    const h = harness(paths);
    expect(await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" })).toBe("accepted");
    await h.aftercall.idle();
    expect(h.phoneCalls).toEqual([]);
    expect(h.prompts).toEqual([]);
    const record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("offen");
    expect(record?.versuche).toBe(0);
    // Berichtigt: der nächste Versuch wertet aus
    writeRecipe(paths, expertRecipe());
    await h.advance(60 * 60_000);
    expect((await readConversation("trainer", "conv_1", paths))?.status).toBe("fertig");
    expect(h.prompts).toHaveLength(1);
  });

  test("bekanntes Rezept ohne Training: nur abgelegt, kein Modell, keine Meldung, kein Anrufnachlauf", async () => {
    writeRecipe(paths, jarvisRecipe());
    writeState(paths, "helfer", { agentId: "agent_helfer" });
    writeRecipe(paths, expertRecipe("trainer-aus", { nachlauf: { zusammenfassung: false, faden: false, kalendervorschlag: false, anruferMerken: false, training: false, ziel: "direktchat" } }));
    writeState(paths, "trainer-aus", { agentId: "agent_aus" });
    const h = harness(paths);
    await h.aftercall.receiveTranscript("conv_h", PRACTICE, { agentId: "agent_helfer" });
    await h.aftercall.receiveTranscript("conv_a", PRACTICE, { agentId: "agent_aus" });
    await h.aftercall.idle();
    expect(h.phoneCalls).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.notes).toEqual([]);
    for (const [kennung, id] of [["helfer", "conv_h"], ["trainer-aus", "conv_a"]] as const) {
      const record = await readConversation(kennung, id, paths);
      expect(record?.status).toBe("fertig");
      expect(record?.nachlauf).toBe("abgelegt");
    }
  });

  test("Rezept gelöscht, Zustand noch da: abgelegt ohne Nachlauf", async () => {
    writeState(paths, "weg", { bekannteAgentIds: ["agent_weg"] });
    const h = harness(paths);
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_weg" });
    await h.aftercall.idle();
    expect(h.phoneCalls).toEqual([]);
    expect((await readConversation("weg", "conv_1", paths))?.nachlauf).toBe("ohne-rezept");
  });

  test("Rezept-Gespräch mit ungültiger Gesprächs-ID: Fehler, nicht an den Anrufdienst", async () => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    const h = harness(paths);
    await expect(h.aftercall.receiveTranscript("../x", PRACTICE, { agentId: "agent_trainer" })).rejects.toThrow(/Ungültige Gesprächs-ID/);
    expect(h.phoneCalls).toEqual([]);
    expect(() => conversationFile("trainer", "a/b", paths)).toThrow();
  });

  test("symbolischer Link als Gesprächsordner: Fehler", async () => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_trainer" });
    mkdirSync(join(root, "woanders"));
    symlinkSync(join(root, "woanders"), join(paths.dataDir, "trainer", "gespraeche"));
    const h = harness(paths);
    await expect(h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" })).rejects.toThrow();
    expect(readdirSync(join(root, "woanders"))).toEqual([]);
    expect(h.phoneCalls).toEqual([]);
  });
});

describe("Doppelte Zustellung", () => {
  beforeEach(() => {
    writeRecipe(paths, expertRecipe());
    writeState(paths, "trainer", { agentId: "agent_trainer" });
  });

  test("nacheinander: einmal angenommen, dann bekannt, eine Auswertung, eine Meldung", async () => {
    const h = harness(paths);
    expect(await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" })).toBe("accepted");
    await h.aftercall.idle();
    expect(await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" })).toBe("known");
    await h.aftercall.idle();
    expect(h.prompts).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
    expect(readdirSync(join(paths.dataDir, "trainer", "gespraeche"))).toEqual(["conv_1.json"]);
  });

  test("gleichzeitig: genau eine Annahme", async () => {
    const h = harness(paths);
    const outcomes = await Promise.all([1, 2, 3].map(() => h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" })));
    await h.aftercall.idle();
    expect(outcomes.filter((o) => o === "accepted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "known")).toHaveLength(2);
    expect(h.prompts).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
    const lines = readFileSync(join(paths.dataDir, "trainer", "training.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("nach Neustart: bekannt, nichts doppelt", async () => {
    const first = harness(paths);
    await first.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" });
    await first.aftercall.idle();
    first.aftercall.stop();
    const second = harness(paths, {}, first);
    expect(await second.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" })).toBe("known");
    await second.aftercall.resume();
    await second.advance(0);
    expect(second.prompts).toEqual([]);
    expect(second.notes).toEqual([]);
  });
});
