/**
 * Issue #285, Checkbox 4: letzter und nächster Lauf im Katalog, /routinen
 * mit Verlauf und /routinen <name> in allen Kanälen. Quelle sind die
 * Attrappen aus tests/routines-fixture.ts (Protokolle im Speicher), nie
 * launchctl.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { MASK } from "../src/lib/jobs/mask";
import { defaultRoutinesDeps, listRoutines, routineHistory, TAIL_HIDDEN } from "../src/lib/routines/catalog";
import { durationText, formatRoutineHistory, formatRoutineList, ROUTINES_PENDING_HINT, ROUTINES_TEXT, runText, tildePath, whenText } from "../src/lib/routines/format";
import { isWrapped } from "../src/lib/routines/sources/launchd";
import { createBotCommands } from "../src/web/bot-commands";
import { daemonPlist, fakeRoutinesDeps, FIXTURE_NOW, HOME, launchctlListOutput, printDisabledOutput, ROOT, runFile, scheduledPlist, wrappedPlist } from "./routines-fixture";

const TZ = "Europe/Berlin";
const AT = { now: FIXTURE_NOW, timeZone: TZ };
/** Berliner Wanduhrzeit am 15.10.2026 (Sommerzeit) plus days Tage */
const berlin = (days: number, h: number, m: number, s = 0) => new Date(Date.UTC(2026, 9, 15 + days, h - 2, m, s)).toISOString();

const HEALTH = "ai.tybo.health-check";
const WATCH = "ai.tybo.watchdog";

function deps(extra: Parameters<typeof fakeRoutinesDeps>[0] = {}) {
  return fakeRoutinesDeps({
    plists: {
      "ai.tybo.health-check.plist": wrappedPlist(HEALTH, { StartCalendarInterval: { Hour: 6, Minute: 30 } }),
      "ai.tybo.watchdog.plist": wrappedPlist(WATCH, { StartCalendarInterval: undefined, StartInterval: 600 }),
      "ai.tybo.morning-briefing.plist": wrappedPlist("ai.tybo.morning-briefing"),
      "ai.tybo.software-update.plist": scheduledPlist("ai.tybo.software-update"),
      "ai.tybo.telegram-relay.plist": daemonPlist("ai.tybo.telegram-relay"),
    },
    launchctlList: launchctlListOutput([
      ["-", "0", HEALTH],
      ["-", "0", WATCH],
      ["-", "0", "ai.tybo.morning-briefing"],
      ["-", "1", "ai.tybo.software-update"],
      ["77", "0", "ai.tybo.telegram-relay"],
    ]),
    runFiles: {
      [HEALTH]: runFile(HEALTH, [
        { startedAt: berlin(-1, 6, 30), durationMs: 3_000, exitCode: 1, tail: ["alt"] },
        { startedAt: berlin(0, 6, 30), durationMs: 12_000, exitCode: 0, tail: ["ok"] },
      ]),
      // Letzter Beginn 09:45, alle 10 Minuten: 09:55 ist vor jetzt (10:00), also fällig
      [WATCH]: runFile(WATCH, [{ startedAt: berlin(0, 9, 45), durationMs: 500, exitCode: 0 }]),
    },
    ...extra,
  });
}

describe("Katalog: wrapped, lastRun, nextRun", () => {
  test("eingebundene Routine: letzter Lauf aus dem Protokoll, nächster Lauf aus dem Zeitplan", async () => {
    const list = await listRoutines(deps());
    const health = list.routines.find(r => r.id === HEALTH)!;
    expect(health.wrapped).toBe(true);
    expect(health.lastRun).toMatchObject({ startedAt: berlin(0, 6, 30), exitCode: 0, durationMs: 12_000 });
    expect(health.nextRun).toBe(berlin(1, 6, 30));
    const watch = list.routines.find(r => r.id === WATCH)!;
    expect(watch.nextRun).toBe(berlin(0, 9, 55));
    const briefing = list.routines.find(r => r.id === "ai.tybo.morning-briefing")!;
    expect(briefing).toMatchObject({ wrapped: true, lastRun: null });
    const update = list.routines.find(r => r.id === "ai.tybo.software-update")!;
    expect(update).toMatchObject({ wrapped: false, lastRun: null, lastExit: 1 });
    expect(list.routines.find(r => r.id === "ai.tybo.telegram-relay")).toMatchObject({ wrapped: false, nextRun: null });
  });

  test("pausiert oder nicht geladen: kein nächster Lauf", async () => {
    const paused = await listRoutines(deps({ printDisabled: printDisabledOutput({ [HEALTH]: true }) }));
    expect(paused.routines.find(r => r.id === HEALTH)).toMatchObject({ state: "paused", nextRun: null });
    const notLoaded = await listRoutines(deps({ launchctlList: launchctlListOutput([]) }));
    expect(notLoaded.routines.find(r => r.id === HEALTH)).toMatchObject({ state: "not-loaded", nextRun: null });
  });

  test("isWrapped nur mit dem eigenen Label als --id", () => {
    const args = (id: string) => ["/bin/bun", "--no-env-file", "src/routine-run.ts", "--id", id, "--", "/bin/bun", "run", "src/x.ts"];
    expect(isWrapped(args(HEALTH), HEALTH)).toBe(true);
    expect(isWrapped(["/bin/bun", "/abs/tybo/src/routine-run.ts", "--id", HEALTH, "--", "x"], HEALTH)).toBe(true);
    expect(isWrapped(args("ai.tybo.anderes"), HEALTH)).toBe(false);
    expect(isWrapped(["/bin/bun", "run", "src/health-check.ts"], HEALTH)).toBe(false);
    expect(isWrapped(undefined, HEALTH)).toBe(false);
  });

  test("kaputtes Protokoll heißt kein Lauf, nie ein Absturz", async () => {
    const list = await listRoutines(deps({ runFiles: { [HEALTH]: "{kein json" } }));
    expect(list.routines.find(r => r.id === HEALTH)).toMatchObject({ wrapped: true, lastRun: null });
  });
});

describe("Texte", () => {
  test("Zeit, Dauer und Ergebnis", () => {
    expect(whenText(Date.parse(berlin(0, 6, 30)), AT)).toBe("heute 06:30");
    expect(whenText(Date.parse(berlin(-1, 6, 30)), AT)).toBe("gestern 06:30");
    expect(whenText(Date.parse(berlin(1, 6, 30)), AT)).toBe("morgen 06:30");
    expect(whenText(Date.parse(berlin(4, 8, 0)), AT)).toBe("Mo 19.10. 08:00");
    expect(whenText(Date.parse("2025-12-31T10:00:00Z"), AT)).toBe("Mi 31.12.2025 11:00");
    expect(durationText(400)).toBe("unter 1 s");
    expect(durationText(12_400)).toBe("12 s");
    expect(durationText(125_000)).toBe("2 min 5 s");
    expect(durationText(120_000)).toBe("2 min");
    expect(durationText(3_780_000)).toBe("1 h 3 min");
    expect(runText({ startedAt: berlin(0, 6, 30), endedAt: berlin(0, 6, 30), durationMs: 12_000, exitCode: 0, tail: [] }, AT)).toBe("heute 06:30, 12 s, ok");
    expect(runText({ startedAt: berlin(-1, 6, 30), endedAt: berlin(-1, 6, 30), durationMs: 3_000, exitCode: 1, tail: [] }, AT)).toBe("gestern 06:30, 3 s, Fehler (Exit 1)");
    expect(runText({ startedAt: berlin(0, 6, 30), endedAt: berlin(0, 6, 30), durationMs: 3_000, exitCode: 143, signal: "SIGTERM", tail: [] }, AT)).toBe("heute 06:30, 3 s, abgebrochen (SIGTERM)");
    expect(tildePath(`${HOME}/tybo/logs/x.log und ${HOME}x/y`, HOME)).toBe(`~/tybo/logs/x.log und ${HOME}x/y`);
  });

  test("/routinen: letzter und nächster Lauf, ohne Wrapper „kein Verlauf (nicht eingebunden)\"", async () => {
    const text = formatRoutineList(await listRoutines(deps()), AT);
    const lines = text.split("\n");
    expect(lines).toContain("- health-check: täglich 06:30 · aktiv · letzter Lauf: heute 06:30, 12 s, ok · nächster Lauf: morgen 06:30");
    expect(lines).toContain("- morning-briefing: täglich 03:30 · aktiv · letzter Lauf: noch keiner · nächster Lauf: morgen 03:30");
    expect(lines).toContain("- software-update: täglich 03:30 · aktiv · letzter Exit: Fehler (Exit 1) · kein Verlauf (nicht eingebunden) · nächster Lauf: morgen 03:30");
    expect(lines).toContain("- watchdog: alle 10 Minuten · aktiv · letzter Lauf: heute 09:45, unter 1 s, ok · nächster Lauf: fällig seit heute 09:55");
    expect(lines).toContain("- telegram-relay: läuft · letzter Exit: ok");
    expect(text).not.toContain("Verlauf der Läufe");
    expect(ROUTINES_PENDING_HINT).not.toContain("Verlauf");
  });

  test("gestern mit Fehler", async () => {
    const list = await listRoutines(
      deps({ runFiles: { [HEALTH]: runFile(HEALTH, [{ startedAt: berlin(-1, 6, 30), durationMs: 3_000, exitCode: 1 }]) } })
    );
    expect(formatRoutineList(list, AT)).toContain("- health-check: täglich 06:30 · aktiv · letzter Lauf: gestern 06:30, 3 s, Fehler (Exit 1) · nächster Lauf: morgen 06:30");
  });
});

describe("/routinen <name>", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    startedAt: berlin(i - 19, 6, 30),
    durationMs: 1_000 * (i + 1),
    exitCode: i === 19 ? 2 : 0,
    tail: i === 19 ? [`Fehler in ${HOME}/tybo/src/x.ts`, "token=GEHEIM-123456"] : ["ok"],
  }));

  test("die letzten 20 Läufe, neueste oben; beim neuesten Fehler Ausgabe und Log-Pfad mit ~; Geheimnisse maskiert", async () => {
    const d = { ...deps({ runFiles: { [HEALTH]: runFile(HEALTH, many) } }), secrets: () => ["GEHEIM-123456"] };
    const history = await routineHistory(d, "health-check");
    expect(history!.runs).toHaveLength(20);
    expect(history!.runs[0].startedAt).toBe(berlin(0, 6, 30));
    expect(history!.runs[19].startedAt).toBe(berlin(-19, 6, 30));
    const text = formatRoutineHistory(history, "health-check", AT);
    expect(text).toStartWith("health-check: täglich 06:30 · aktiv\nNächster Lauf: morgen 06:30\n\nLetzte Läufe (20, neueste oben):\n- heute 06:30, 20 s, Fehler (Exit 2)\n- gestern 06:30, 19 s, ok\n");
    expect(text).toContain("Letzte Zeilen der Ausgabe:\nFehler in ~/tybo/src/x.ts\ntoken=" + MASK);
    expect(text).toContain(`Log: ~/tybo/logs/${HEALTH}.error.log`);
    expect(text).not.toContain("GEHEIM-123456");
    expect(text).not.toContain(HOME);
    expect(text.split("\n").filter(l => l.startsWith("- "))).toHaveLength(20);
  });

  test(".env nicht lesbar: der Verlauf zeigt keine Ausgabe, nur den Hinweis", async () => {
    const d = {
      ...deps({ runFiles: { [HEALTH]: runFile(HEALTH, many) } }),
      secrets: () => {
        throw new Error("EACCES: .env");
      },
    };
    const history = await routineHistory(d, "health-check");
    expect(history!.runs).toHaveLength(20);
    for (const run of history!.runs) expect(run.tail).toEqual([TAIL_HIDDEN]);
    const text = formatRoutineHistory(history, "health-check", AT);
    expect(text).toContain(`Letzte Zeilen der Ausgabe:\n${TAIL_HIDDEN}`);
    expect(text).not.toContain("GEHEIM-123456");
    expect(text).not.toContain("Fehler in");
  });

  test("echte Masken: .env fehlt heißt leer, .env unlesbar wirft (projectSecretsOrThrow)", async () => {
    const root = await mkdtemp(join(tmpdir(), "routines-secrets-"));
    try {
      expect(() => defaultRoutinesDeps(root, {}).secrets!()).not.toThrow();
      await mkdir(join(root, ".env"));
      expect(() => defaultRoutinesDeps(root, {}).secrets!()).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("neuester Lauf ok: keine Ausgabe; ohne Lauf „Noch kein Lauf\"; ohne Wrapper „nicht eingebunden\"", async () => {
    const ok = formatRoutineHistory(await routineHistory(deps(), HEALTH), HEALTH, AT);
    expect(ok).toContain("- heute 06:30, 12 s, ok\n- gestern 06:30, 3 s, Fehler (Exit 1)");
    expect(ok).not.toContain("Letzte Zeilen");
    const none = formatRoutineHistory(await routineHistory(deps(), "morning-briefing"), "morning-briefing", AT);
    expect(none).toBe("morning-briefing: täglich 03:30 · aktiv\nNächster Lauf: morgen 03:30\n\nNoch kein Lauf festgehalten.");
    const plain = formatRoutineHistory(await routineHistory(deps(), "software-update"), "software-update", AT);
    expect(plain).toBe("software-update: täglich 03:30 · aktiv\nNächster Lauf: morgen 03:30\nLetzter Exit: Fehler (Exit 1)\n\nVerlauf: kein Verlauf (nicht eingebunden).");
  });

  test("unbekannter Name; Suche nach Label nur mit by id", async () => {
    expect(await routineHistory(deps(), "gibt-es-nicht")).toBeNull();
    expect(formatRoutineHistory(null, " gibt-es-nicht ", AT)).toBe("Keine Routine gibt-es-nicht. /routinen zeigt alle.");
    expect(ROUTINES_TEXT.unknownRoutine("x")).toBe("Keine Routine x. /routinen zeigt alle.");
    expect(await routineHistory(deps(), "health-check", "id")).toBeNull();
    expect((await routineHistory(deps(), HEALTH, "id"))?.routine.id).toBe(HEALTH);
  });

  async function telegram(text: string, services: Partial<CommandServices>): Promise<string[]> {
    const sent: string[] = [];
    await runTelegramCommand({
      chat: { reply: async t => void sent.push(t) },
      chatId: "-1001",
      topicId: 3,
      sessionKey: "topic:-1001:3",
      agent: "general",
      text,
      match: commandRegistry.match(text, "telegram")!,
      services: services as CommandServices,
      working: () => () => {},
      resetSession: async () => ({ status: "unavailable" }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    return sent;
  }

  async function webOrTerminal(source: "web" | "terminal", text: string, services: Partial<CommandServices>): Promise<string[]> {
    const unused = () => {
      throw new Error("nicht erwartet");
    };
    const commands = createBotCommands({
      registry: commandRegistry,
      services: services as CommandServices,
      groupId: () => null,
      agentForTopic: () => undefined,
      sendPlain: unused,
      sendAndRecord: unused,
      saveMessage: async () => true,
      resetConversation: unused,
      runStreamingTurn: unused,
      processIntents: unused,
      sendAsAgent: unused,
      log: () => {},
    });
    const notices: string[] = [];
    await commands.run({
      conversationId: "abc123",
      agent: "general",
      text,
      source,
      messageId: "m1",
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
      sink: {} as any,
      notice: async t => void notices.push(t),
      answer: async () => {},
      ask: async () => {},
      endAsk: () => {},
      commit: () => {},
    });
    return notices;
  }

  test("in Telegram, Browser und Terminal; Name an routineHistory durchgereicht", async () => {
    const d = deps();
    const asked: string[] = [];
    const services: Partial<CommandServices> = {
      routineHistory: async name => {
        asked.push(name);
        return routineHistory(d, name);
      },
      routinesList: async () => {
        throw new Error("ohne Namen nicht erwartet");
      },
    };
    const expected = formatRoutineHistory(await routineHistory(d, "health-check"), "health-check");
    expect(await telegram("/routinen health-check", services)).toEqual([expected]);
    expect(await webOrTerminal("web", "/routinen health-check", services)).toEqual([expected]);
    expect(await webOrTerminal("terminal", "/routinen health-check", services)).toEqual([expected]);
    expect(asked).toEqual(["health-check", "health-check", "health-check"]);
    expect(await telegram("/routinen nix", services)).toEqual(["Keine Routine nix. /routinen zeigt alle."]);
  });

  test("Protokoll liegt im Projektordner unter data/routines/<label>.json", async () => {
    const d = deps();
    const reads: string[] = [];
    const read = d.readFile;
    d.readFile = path => {
      reads.push(path);
      return read(path);
    };
    await listRoutines(d);
    expect(reads).toContain(`${ROOT}/data/routines/${HEALTH}.json`);
  });
});
