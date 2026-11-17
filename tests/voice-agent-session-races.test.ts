/**
 * Issue #494, Übergänge beim Start und Auflegen eines Web-Gesprächs: Der Abruf
 * beim Anbieter läuft ohne Sperre. Ablauf der Reservierung und Änderungen an
 * Rezept, Wissen, Freischaltung oder Abgleich dürfen danach weder ein Token
 * noch eine Web-Freigabe ergeben. Ein blindes Ende ohne Gesprächs-ID bleibt ohne
 * Wirkung, auch während des Tokenabrufs. Scheitert beim Auflegen das Löschen der
 * Freigabe, bleibt das Gespräch laufend und ein zweites Auflegen löscht sie.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipeHash } from "../src/lib/voice-agents/base";
import { loadRecipe } from "../src/lib/voice-agents/recipe";
import { updateState } from "../src/lib/voice-agents/state";
import { writeUnlock } from "../src/lib/voice-agents/unlock";
import { verifyWebCall } from "../src/lib/voice-agents/web-calls";
import { readWebSessions, usedMinutes } from "../src/lib/voice-agents/web-sessions";
import type { WebServer } from "../src/web/server";
import type { ServerCtx } from "./topic-fixture";
import { writeRecipe } from "./voice-agents-manage-fixture";
import { BRIDGE_TOKEN, bridge, readyAgent, removeSessionWorlds, sessionServer, sessionWorld, START, type SessionWorld } from "./voice-agent-session-fixture";

const root = await mkdtemp(join(tmpdir(), "voice-agent-races-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  removeSessionWorlds();
});
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const start = (ctx: ServerCtx, kennung: string) => ctx.api(`/api/voice-agents/${kennung}/session`, "POST", {});
const end = (ctx: ServerCtx, kennung: string, body: unknown = {}) => ctx.api(`/api/voice-agents/${kennung}/session/end`, "POST", body);
const webCallFiles = (w: SessionWorld, kennung: string) => {
  const dir = join(w.paths.dataDir, kennung, "web-calls");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const verify = (w: SessionWorld, kennung: string, conversationId: string) =>
  verifyWebCall({ kennung, conversationId }, { ...w.paths, token: BRIDGE_TOKEN, now: () => w.clock.now });

/** Anbieter hält die nächste Antwort fest, bis release() kommt; called: der Abruf hat begonnen */
function holdProvider(w: SessionWorld): { release: () => void; called: () => Promise<void> } {
  let release!: () => void;
  w.replies.unshift({ warte: new Promise<void>((r) => (release = r)) });
  const before = w.calls.length;
  return {
    release: () => release(),
    called: async () => {
      for (let i = 0; i < 500 && w.calls.length === before; i++) await Bun.sleep(2);
      if (w.calls.length === before) throw new Error("Anbieter nicht aufgerufen");
    },
  };
}

/** Kein Token, keine Freigabe, keine offene Reservierung */
async function expectNothingIssued(w: SessionWorld, kennung: string, res: Response, status: number, reason: string) {
  const text = await res.text();
  expect(res.status).toBe(status);
  expect(JSON.parse(text)).toMatchObject({ reason });
  expect(text).not.toContain("gespraechstoken");
  expect(text).not.toContain("conv_");
  expect(webCallFiles(w, kennung)).toEqual([]);
  expect(await verify(w, kennung, "conv_1")).toBe(false);
  const stored = await readWebSessions(kennung, w.paths);
  expect(stored.sitzungen.filter((s) => s.ende === null)).toEqual([]);
  expect(stored.sitzungen.some((s) => s.gespraech !== null)).toBe(false);
}

describe("Reservierung während des Abrufs beim Anbieter", () => {
  test("abgelaufener Start liefert später weder Token noch Freigabe; ein neuer Start dazwischen behält seins; Minuten getrennt gebucht", async () => {
    const w = sessionWorld();
    await readyAgent(w, "jarvis", bridge);
    const ctx = await sessionServer(root, servers, w);
    const held = holdProvider(w);
    const first = start(ctx, "jarvis");
    await held.called();

    // Der erste Platz läuft ab, ohne eine vorzeitige Minutenrückbuchung.
    // Ein blindes Auflegen ohne ID ist kein erlaubter Übergang mehr.
    const firstSlot = (await readWebSessions("jarvis", w.paths)).sitzungen[0];
    w.clock.now = firstSlot.bis;

    // Neuer Start, während der erste noch auf den Anbieter wartet
    const second = await start(ctx, "jarvis");
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.conversationId).toBe("conv_1");

    // Jetzt antwortet der Anbieter auf den ersten Abruf
    held.release();
    const late = await first;
    const lateText = await late.text();
    expect(late.status).toBe(409);
    expect(JSON.parse(lateText)).toMatchObject({ reason: "abgebrochen" });
    expect(lateText).not.toContain("gespraechstoken");
    expect(lateText).not.toContain("conv_2");

    // Freigabe nur für das zweite Gespräch, nicht für das Token des ersten
    expect(await verify(w, "jarvis", "conv_1")).toBe(true);
    expect(await verify(w, "jarvis", "conv_2")).toBe(false);
    expect(webCallFiles(w, "jarvis")).toHaveLength(1);

    // Ablage: der erste abgelaufen, ohne Gesprächs-ID; beide konservativ gebucht
    const stored = await readWebSessions("jarvis", w.paths);
    expect(stored.sitzungen.map((s) => ({ gespraech: s.gespraech, beendet: s.ende !== null, minuten: s.minuten }))).toEqual([
      { gespraech: null, beendet: false, minuten: 12 },
      { gespraech: "conv_1", beendet: false, minuten: 12 },
    ]);
    expect(usedMinutes(stored, w.clock.now)).toBe(24);
    expect(stored.versuche).toHaveLength(1);

    // Der zweite lässt sich normal auflegen, danach ist nichts mehr frei gegeben
    w.hangUp("conv_1");
    expect((await end(ctx, "jarvis", { conversationId: "conv_1" })).status).toBe(200);
    expect(await verify(w, "jarvis", "conv_1")).toBe(false);
    expect(webCallFiles(w, "jarvis")).toEqual([]);
  });

  test("Regression #494: ohne Gesprächs-ID lässt sich auch ein noch wartender Start nicht fremd beenden", async () => {
    const w = sessionWorld();
    await readyAgent(w, "jarvis", bridge);
    const ctx = await sessionServer(root, servers, w);
    const held = holdProvider(w);
    const pending = start(ctx, "jarvis");
    await held.called();
    try {
      expect((await end(ctx, "jarvis")).status).toBe(400);
      expect((await start(ctx, "jarvis")).status).toBe(409);
      expect(usedMinutes(await readWebSessions("jarvis", w.paths), START)).toBe(12);
    } finally {
      held.release();
      await pending;
    }
    expect(await verify(w, "jarvis", "conv_1")).toBe(true);
    w.hangUp("conv_1");
    expect((await end(ctx, "jarvis", { conversationId: "conv_1" })).status).toBe(200);
  });
});

describe("Regression #494: Ende verlangt eine bestimmte Gesprächs-ID", () => {
  for (const kind of ["bruecke", "anbieter"]) {
    test(`${kind}: fehlende oder ungültige ID lässt Sperre, Freigabe und volle Minuten unverändert`, async () => {
      const w = sessionWorld();
      await readyAgent(w, "jarvis", kind === "bruecke" ? bridge : () => {});
      const port = w.port();
      expect((await port.start("jarvis")).status).toBe(200);
      const stored = await readWebSessions("jarvis", w.paths);
      for (const body of ["", " ", "{}", "null", "[]", '{"conversationId":null}', '{"conversationId":""}', '{"conversationId":12}', "kein JSON"]) {
        expect((await port.end("jarvis", body)).status).toBe(400);
        expect(await readWebSessions("jarvis", w.paths)).toEqual(stored);
      }
      expect((await port.start("jarvis")).status).toBe(409);
      expect(await verify(w, "jarvis", "conv_1")).toBe(kind === "bruecke");
      expect(usedMinutes(stored, START)).toBe(12);
    });
  }
});

describe("Stand ändert sich während des Abrufs: kein Token, keine Freigabe", () => {
  const cases: { name: string; status: number; reason: string; change: (w: SessionWorld) => Promise<void> }[] = [
    {
      name: "Rezept geändert",
      status: 403,
      reason: "gesperrt",
      change: async (w) => {
        writeRecipe(w, "jarvis", (raw) => {
          bridge(raw);
          raw.zweck = "Etwas anderes";
        });
      },
    },
    {
      name: "Web-Zugang abgeschaltet",
      status: 403,
      reason: "kein_web",
      change: async (w) => {
        writeRecipe(w, "jarvis", (raw) => {
          bridge(raw);
          raw.zugang.web = { link: false };
        });
      },
    },
    {
      name: "Freischaltung entzogen",
      status: 403,
      reason: "gesperrt",
      change: async (w) => {
        await rm(join(w.paths.dataDir, "jarvis", "freischaltung.json"));
      },
    },
    {
      name: "Abgleich nicht mehr aktuell",
      status: 409,
      reason: "nicht_abgeglichen",
      change: async (w) => {
        await updateState("jarvis", { letzterHash: "0".repeat(64) }, w.paths);
      },
    },
    {
      name: "anderer Agent beim Anbieter",
      status: 409,
      reason: "geaendert",
      change: async (w) => {
        await updateState("jarvis", { agentId: "agent_neu" }, w.paths);
      },
    },
  ];
  for (const c of cases) {
    test(`${c.name}: ${c.status} ${c.reason}, Reservierung zurückgenommen`, async () => {
      const w = sessionWorld();
      await readyAgent(w, "jarvis", bridge);
      const ctx = await sessionServer(root, servers, w);
      const held = holdProvider(w);
      const pending = start(ctx, "jarvis");
      await held.called();
      await c.change(w);
      held.release();
      await expectNothingIssued(w, "jarvis", await pending, c.status, c.reason);
      expect((await readWebSessions("jarvis", w.paths)).sitzungen).toEqual([]);
    });
  }
});

describe("Wissensdatei ändert sich während des Abrufs", () => {
  const DATEI = "data/voice-agents/kenner/wissen-a.md";
  async function knowledgeAgent(w: SessionWorld): Promise<string> {
    writeRecipe(w, "kenner", (raw) => {
      bridge(raw);
      raw.gedaechtnis = "thema";
      raw.wissen = { datei: DATEI };
    });
    mkdirSync(join(w.paths.dataDir, "kenner"), { recursive: true });
    writeFileSync(join(w.paths.dataDir, "kenner", "wissen-a.md"), "Erstes Wissen\n");
    const recipe = (await loadRecipe("kenner", w.paths))!;
    const hash = recipeHash(recipe);
    await updateState("kenner", { kennung: "kenner", anbieter: "elevenlabs", agentId: "agent_kenner", letzterHash: hash } as any, w.paths);
    const wissenHash = createHash("sha256").update("Erstes Wissen\n").digest("hex");
    const unlocked = await writeUnlock("kenner", { hash, version: 1, wissenHash, grund: "tests" }, w.paths);
    if (unlocked.status !== "freigeschaltet") throw new Error(unlocked.status);
    return hash;
  }

  test("Ausgangslage: mit diesem Wissen gibt es ein Token", async () => {
    const w = sessionWorld();
    await knowledgeAgent(w);
    const ctx = await sessionServer(root, servers, w);
    expect((await start(ctx, "kenner")).status).toBe(200);
  });

  test("Wissen geändert: gesperrt, kein Token, keine Freigabe", async () => {
    const w = sessionWorld();
    await knowledgeAgent(w);
    const ctx = await sessionServer(root, servers, w);
    const held = holdProvider(w);
    const pending = start(ctx, "kenner");
    await held.called();
    writeFileSync(join(w.paths.dataDir, "kenner", "wissen-a.md"), "Anderes Wissen\n");
    held.release();
    await expectNothingIssued(w, "kenner", await pending, 403, "gesperrt");
  });

  test("Wissen geändert und sofort wieder freigeschaltet: anderer Stand als beim Abruf, 409 geaendert", async () => {
    const w = sessionWorld();
    const hash = await knowledgeAgent(w);
    const ctx = await sessionServer(root, servers, w);
    const held = holdProvider(w);
    const pending = start(ctx, "kenner");
    await held.called();
    writeFileSync(join(w.paths.dataDir, "kenner", "wissen-a.md"), "Anderes Wissen\n");
    const wissenHash = createHash("sha256").update("Anderes Wissen\n").digest("hex");
    expect((await writeUnlock("kenner", { hash, version: 1, wissenHash, grund: "trotzdem" }, w.paths)).status).toBe("freigeschaltet");
    held.release();
    await expectNothingIssued(w, "kenner", await pending, 409, "geaendert");
  });
});

describe("Auflegen: Löschen der Freigabe scheitert", () => {
  test("503 statt Erfolg, Gespräch läuft weiter, ein zweites Auflegen löscht die Freigabe und bucht", async () => {
    const w = sessionWorld();
    await readyAgent(w, "jarvis", bridge);
    const ctx = await sessionServer(root, servers, w);
    const started = await start(ctx, "jarvis");
    expect(started.status).toBe(200);
    const { conversationId } = await started.json();
    expect(await verify(w, "jarvis", conversationId)).toBe(true);

    // Freigabe beiseite, an ihrer Stelle ein Ordner: unlink scheitert (kein ENOENT)
    const [file] = webCallFiles(w, "jarvis");
    const entry = join(w.paths.dataDir, "jarvis", "web-calls", file);
    renameSync(entry, `${entry}.weg`);
    mkdirSync(entry);
    w.clock.now += 3 * 60_000;
    w.hangUp(conversationId);
    const failed = await end(ctx, "jarvis", { conversationId });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ reason: "widerruf" });
    expect(w.logs.some((l) => l.includes("Freigabe nicht gelöscht"))).toBe(true);

    // Nichts als beendet gespeichert: Gespräch läuft, zweiter Start weiter gesperrt
    let stored = await readWebSessions("jarvis", w.paths);
    expect(stored.sitzungen).toHaveLength(1);
    expect(stored.sitzungen[0].ende).toBeNull();
    expect((await start(ctx, "jarvis")).status).toBe(409);
    const info = await (await ctx.api("/api/voice-agents/jarvis")).json();
    expect(info.laufend).not.toBeNull();

    // Ursache weg, Freigabe zurück an ihren Platz: das zweite Auflegen gelingt
    rmdirSync(entry);
    renameSync(`${entry}.weg`, entry);
    expect(await verify(w, "jarvis", conversationId)).toBe(true);
    w.clock.now += 60_000;
    const retried = await end(ctx, "jarvis", { conversationId });
    expect(retried.status).toBe(200);
    // Gebucht wird die Dauer laut Anbieter (3 Minuten), nicht die Zeit bis zur Meldung
    expect(await retried.json()).toEqual({ ok: true, minuten: 3 });
    expect(await verify(w, "jarvis", conversationId)).toBe(false);
    expect(webCallFiles(w, "jarvis")).toEqual([]);
    stored = await readWebSessions("jarvis", w.paths);
    expect(stored.sitzungen[0].ende).toBe(w.clock.now);
    expect(usedMinutes(stored, w.clock.now)).toBe(3);
    // Ein drittes Auflegen findet nichts mehr
    expect((await end(ctx, "jarvis", { conversationId })).status).toBe(404);
  });

  test("Freigabe schon weg (gelöscht oder abgelaufen weggeräumt): Auflegen gelingt", async () => {
    const w = sessionWorld();
    await readyAgent(w, "jarvis", bridge);
    const ctx = await sessionServer(root, servers, w);
    const { conversationId } = await (await start(ctx, "jarvis")).json();
    for (const f of webCallFiles(w, "jarvis")) await rm(join(w.paths.dataDir, "jarvis", "web-calls", f));
    w.hangUp(conversationId);
    expect((await end(ctx, "jarvis", { conversationId })).status).toBe(200);
  });
});
