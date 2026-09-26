/**
 * Issue #36, Checkbox 2: Agenten-Anweisungen über /api/agents/<name>/instructions
 * mit der echten src/lib/agent-overrides.ts auf einer temporären Datei.
 * Nie config/agent-overrides.json.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAgentOverride,
  clearAgentOverrides,
  formatOverridesSection,
  getAgentOverrides,
  removeLastAgentOverride,
  setAgentOverridesPath,
} from "../src/lib/agent-overrides";
import { botInstructions } from "../src/web/bot-settings";
import { instructionsDigest, normalizeInstruction, type InstructionsPort } from "../src/web/instructions";
import type { WebServer } from "../src/web/server";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "tybo-instructions-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
let file: string;
let counter = 0;

beforeEach(() => {
  file = join(root, `overrides-${++counter}`, "agent-overrides.json");
  setAgentOverridesPath(file);
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  setAgentOverridesPath();
});

async function saved(): Promise<Record<string, string[]> | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

async function server(instructions: InstructionsPort | null = botInstructions) {
  return topicServer(root, servers, null, { instructions: instructions ?? undefined });
}

const PATH = "/api/agents/research/instructions";

describe("Anweisungen", () => {
  test("hinzufügen, anzeigen, letzte entfernen, alle entfernen; Hinweis auf die nächste frische Session", async () => {
    const ctx = await server();
    let res = await ctx.api(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agent: "research", instructions: [], digest: instructionsDigest([]), revision: { boot: expect.any(Number), seq: expect.any(Number) } });

    res = await ctx.api(PATH, "POST", { text: "  antworte kürzer  " });
    expect(res.status).toBe(201);
    let body = await res.json();
    expect(body).toMatchObject({ agent: "research", count: 1, instructions: ["antworte kürzer"] });
    expect(body.note).toContain("nächsten frischen Session");
    await ctx.api(PATH, "POST", { text: "Quellen immer verlinken" });
    await ctx.api(PATH, "POST", { text: "Zeile eins\nZeile zwei" });
    expect(await saved()).toEqual({ research: ["antworte kürzer", "Quellen immer verlinken", "Zeile eins\nZeile zwei"] });
    // Wirkung wie /agent: dieselbe Datei, derselbe Prompt-Abschnitt
    expect(getAgentOverrides("research")).toHaveLength(3);
    expect(formatOverridesSection("research")).toContain("- Quellen immer verlinken");

    res = await ctx.api(`${PATH}/last`, "DELETE");
    body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ removed: "Zeile eins\nZeile zwei", instructions: ["antworte kürzer", "Quellen immer verlinken"] });
    expect(body.note).toContain("nächsten frischen Session");

    res = await ctx.api(PATH, "DELETE");
    body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ removed: 2, instructions: [] });
    expect(await saved()).toEqual({});

    // Nichts mehr da: letzte entfernen ergibt null, alle entfernen 0
    expect((await (await ctx.api(`${PATH}/last`, "DELETE")).json()).removed).toBeNull();
    expect((await (await ctx.api(PATH, "DELETE")).json()).removed).toBe(0);
  });

  test("Länge nach dem Trimmen: 1 und 1000 Zeichen ok, 0 und 1001 400", async () => {
    const ctx = await server();
    expect((await ctx.api(PATH, "POST", { text: " x " })).status).toBe(201);
    const max = "ä".repeat(999) + "😀";
    expect((await ctx.api(PATH, "POST", { text: `  ${max}\n` })).status).toBe(201);
    for (const text of ["", "   ", "a".repeat(1001), "ö".repeat(1000) + "!"]) {
      const res = await ctx.api(PATH, "POST", { text });
      expect({ len: text.length, status: res.status }).toEqual({ len: text.length, status: 400 });
    }
    expect(await saved()).toEqual({ research: ["x", max] });
  });

  test("ungültige Anfragen 400, nichts gespeichert", async () => {
    const ctx = await server();
    for (const body of ["{kaputt", "[1]", '"x"', "{}", JSON.stringify({ text: 5 }), JSON.stringify({ text: null }), JSON.stringify({ text: "a\u0000b" }), JSON.stringify({ text: "a\u001bb" })]) {
      const res = await ctx.api(PATH, "POST", body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(await saved()).toBeNull();
  });

  test("unbekannte Agenten und Aliasse 404, falsche Methoden 405", async () => {
    const ctx = await server();
    for (const name of ["nobody", "cfo", "Research", "%72esearch"]) {
      const res = await ctx.api(`/api/agents/${name}/instructions`, "POST", { text: "a" });
      expect({ name, status: res.status }).toEqual({ name, status: 404 });
    }
    expect((await ctx.api(PATH, "PUT", { text: "a" })).status).toBe(405);
    expect((await ctx.api(`${PATH}/last`)).status).toBe(405);
    const post = await ctx.api(`${PATH}/last`, "POST", { text: "a" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("DELETE");
    expect(await saved()).toBeNull();
  });

  test("Log ohne den Text der Anweisung", async () => {
    const ctx = await server();
    await ctx.api(PATH, "POST", { text: "geheimer-anweisungstext" });
    expect(ctx.logs).toContain("Anweisungen für research: hinzugefügt");
    expect(ctx.logs.join("\n")).not.toContain("geheimer-anweisungstext");
  });

  test("Schreibfehler ergibt 500 ohne Details", async () => {
    const ctx = await server({
      ...botInstructions,
      add: async () => {
        throw new Error(`EACCES ${file}`);
      },
    });
    const res = await ctx.api(PATH, "POST", { text: "a" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Anweisungen konnten nicht gespeichert werden" });
    expect(ctx.logs.join("\n")).not.toContain(file);
  });
});

describe("Version und Löschen nur der angezeigten Liste (Plan-Session 2 zu PR #43)", () => {
  type Rev = { boot: number; seq: number };

  test("revision steigt genau dann, wenn sich die Liste ändert, auch per /agent aus Telegram", async () => {
    const ctx = await server();
    const a = (await (await ctx.api(PATH)).json()).revision as Rev;
    expect((await (await ctx.api(PATH)).json()).revision).toEqual(a);
    const post = await (await ctx.api(PATH, "POST", { text: "Eins" })).json();
    expect(post.revision.seq).toBeGreaterThan(a.seq);
    expect((await (await ctx.api(PATH)).json()).revision).toEqual(post.revision);
    // Telegram schreibt an der WebUI vorbei in dieselbe Datei
    await addAgentOverride("research", "Zwei");
    const b = await (await ctx.api(PATH)).json();
    expect(b.instructions).toEqual(["Eins", "Zwei"]);
    expect(b.revision.seq).toBeGreaterThan(post.revision.seq);
    // Eine Änderung bei einem anderen Agenten lässt die Nummer von research stehen
    await ctx.api("/api/agents/critic/instructions", "POST", { text: "x" });
    expect((await (await ctx.api(PATH)).json()).revision).toEqual(b.revision);
  });

  test("DELETE mit dem Prüfwert der angezeigten Liste: passt sie, wird entfernt; sonst 409 mit aktueller Liste, nichts entfernt", async () => {
    const ctx = await server();
    await ctx.api(PATH, "POST", { text: "Eins" });
    await ctx.api(PATH, "POST", { text: "Zwei" });
    const shown = await (await ctx.api(PATH)).json();
    await addAgentOverride("research", "Drei");
    for (const path of [`${PATH}/last`, PATH]) {
      const res = await ctx.api(path, "DELETE", { expected: shown.digest });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("inzwischen geändert");
      expect(body.instructions).toEqual(["Eins", "Zwei", "Drei"]);
      expect(body.revision.seq).toBeGreaterThan(shown.revision.seq);
    }
    expect(await saved()).toEqual({ research: ["Eins", "Zwei", "Drei"] });
    // Mit der aktuellen Liste klappt es
    let res = await ctx.api(`${PATH}/last`, "DELETE", { expected: instructionsDigest(["Eins", "Zwei", "Drei"]) });
    expect(res.status).toBe(200);
    const afterLast = await res.json();
    expect(afterLast.removed).toBe("Drei");
    res = await ctx.api(PATH, "DELETE", { expected: afterLast.digest });
    expect(res.status).toBe(200);
    expect(await saved()).toEqual({});
  });

  test("DELETE ohne Body bleibt ohne Bedingung (wie /agent), ungültiges expected ergibt 400", async () => {
    const ctx = await server();
    await ctx.api(PATH, "POST", { text: "Eins" });
    for (const body of ["{kaputt", "[1]", JSON.stringify({ expected: "Eins" }), JSON.stringify({ expected: [1] }), JSON.stringify({ expected: ["Eins"] })]) {
      const res = await ctx.api(`${PATH}/last`, "DELETE", body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(await saved()).toEqual({ research: ["Eins"] });
    expect((await (await ctx.api(`${PATH}/last`, "DELETE")).json()).removed).toBe("Eins");
  });

  test("lange Listen: beide DELETE mit Bedingung bleiben unter dem Body-Limit (Codex-Befund Runde 8 zu PR #43)", async () => {
    const ctx = await server();
    // 66 zulässige Anweisungen à 1000 Zeichen: als Liste im Body wären das über 64 KiB
    for (let n = 0; n < 66; n++) await addAgentOverride("research", String(n).padStart(3, "0") + "x".repeat(997));
    let shown = await (await ctx.api(PATH)).json();
    expect(shown.instructions).toHaveLength(66);
    expect(JSON.stringify({ expected: shown.instructions }).length).toBeGreaterThan(65_536);
    let res = await ctx.api(`${PATH}/last`, "DELETE", { expected: shown.digest });
    expect(res.status).toBe(200);
    shown = await res.json();
    expect(shown.instructions).toHaveLength(65);
    // Konfliktschutz bleibt: nach /agent aus Telegram gilt der alte Prüfwert nicht mehr
    await addAgentOverride("research", "Telegram");
    res = await ctx.api(PATH, "DELETE", { expected: shown.digest });
    expect(res.status).toBe(409);
    expect((await saved())!.research).toHaveLength(66);
    res = await ctx.api(PATH, "DELETE", { expected: (await res.json()).digest });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(66);
    expect(await saved()).toEqual({});
  });

  test("die Bedingung gilt in der Schreibkette: ein vorher eingereihtes /agent aus Telegram gewinnt", async () => {
    const ctx = await server();
    await ctx.api(PATH, "POST", { text: "Eins" });
    const telegram = addAgentOverride("research", "Zwei");
    const res = await ctx.api(`${PATH}/last`, "DELETE", { expected: instructionsDigest(["Eins"]) });
    await telegram;
    expect(res.status).toBe(409);
    expect(await saved()).toEqual({ research: ["Eins", "Zwei"] });
  });
});

describe("Schutz der Routen", () => {
  test("ohne Anmeldung 401, fremder Origin 403, ohne Port 503", async () => {
    const ctx = await server();
    expect((await fetch(`${ctx.origin}${PATH}`)).status).toBe(401);
    const noCookie = await fetch(`${ctx.origin}${PATH}`, { method: "POST", headers: { origin: ctx.origin }, body: JSON.stringify({ text: "a" }) });
    expect(noCookie.status).toBe(401);
    for (const [path, method] of [[PATH, "POST"], [PATH, "DELETE"], [`${PATH}/last`, "DELETE"]] as const) {
      const res = await ctx.api(path, method, { text: "a" }, { origin: "http://evil.example" });
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 403 });
    }
    expect(await saved()).toBeNull();
    const bare = await server(null);
    expect((await bare.api(PATH)).status).toBe(503);
  });
});

describe("Schreibkette in agent-overrides.ts", () => {
  test("gleichzeitige Änderungen aus Telegram und WebUI verlieren nichts", async () => {
    const ctx = await server();
    const web = Array.from({ length: 10 }, (_, i) => ctx.api(PATH, "POST", { text: `web ${i}` }));
    const telegram = Array.from({ length: 10 }, (_, i) => addAgentOverride("research", `telegram ${i}`));
    const results = await Promise.all(web);
    await Promise.all(telegram);
    expect(results.map(r => r.status)).toEqual(Array(10).fill(201));
    const list = (await saved())!.research;
    expect(list).toHaveLength(20);
    expect(new Set(list).size).toBe(20);
  });

  test("Entfernen und Hinzufügen in Reihe", async () => {
    await Promise.all([addAgentOverride("critic", "a"), addAgentOverride("critic", "b"), removeLastAgentOverride("critic"), addAgentOverride("critic", "c")]);
    expect((await saved())!.critic).toEqual(["a", "c"]);
  });

  test("Schreibbeginn (/agent, Issue #74): erst in der Kette an der Reihe; wirft er, bleibt die Datei unberührt", async () => {
    const order: string[] = [];
    const first = addAgentOverride("critic", "a", () => order.push("a"));
    const stopped = () => {
      order.push("gestoppt");
      throw new DOMException("Befehl gestoppt", "AbortError");
    };
    const results = await Promise.allSettled([
      first,
      addAgentOverride("critic", "b", stopped),
      removeLastAgentOverride("critic", undefined, stopped),
      clearAgentOverrides("critic", undefined, stopped),
    ]);
    expect(order).toEqual(["a", "gestoppt", "gestoppt", "gestoppt"]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected", "rejected", "rejected"]);
    expect((await saved())!.critic).toEqual(["a"]);
  });
});

describe("normalizeInstruction", () => {
  test("Tabs und Zeilenumbrüche erlaubt, andere Steuerzeichen nicht", () => {
    expect(normalizeInstruction("a\tb\nc")).toBe("a\tb\nc");
    expect(normalizeInstruction("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeInstruction("a\u0007b")).toBeNull();
    expect(normalizeInstruction("a\u007fb")).toBeNull();
  });
});
