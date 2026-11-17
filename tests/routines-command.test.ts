/**
 * Issue #284, Checkbox 4: /routinen in Telegram, Browser und Terminal mit
 * den drei Fällen Liste, leer und nicht verfügbar, dazu /help.
 */

import { describe, expect, test } from "bun:test";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { listRoutines } from "../src/lib/routines/catalog";
import { exitText, formatRoutineList, ROUTINES_PENDING_HINT, ROUTINES_TEXT } from "../src/lib/routines/format";
import type { RoutineList } from "../src/lib/routines/types";
import { createBotCommands } from "../src/web/bot-commands";
import { daemonPlist, fakeRoutinesDeps, FIXTURE_NOW, launchctlListOutput, printDisabledOutput, scheduledPlist } from "./routines-fixture";

const AT = { now: FIXTURE_NOW, timeZone: "Europe/Berlin" };

async function sampleList(): Promise<RoutineList> {
  return listRoutines(
    fakeRoutinesDeps({
      plists: {
        "ai.tybo.health-check.plist": scheduledPlist("ai.tybo.health-check"),
        "ai.tybo.watchdog.plist": scheduledPlist("ai.tybo.watchdog", { StartCalendarInterval: undefined, StartInterval: 600 }),
        "ai.tybo.telegram-relay.plist": daemonPlist("ai.tybo.telegram-relay"),
        "com.example.backup.plist": scheduledPlist("com.example.backup", {
          StartCalendarInterval: [1, 2, 3, 4, 5].map(Weekday => ({ Weekday, Hour: 8, Minute: 0 })),
        }),
      },
      config: JSON.stringify({ labels: ["com.example.backup"] }),
      launchctlList: launchctlListOutput([
        ["-", "0", "ai.tybo.health-check"],
        ["-", "1", "ai.tybo.watchdog"],
        ["777", "0", "ai.tybo.telegram-relay"],
      ]),
      printDisabled: printDisabledOutput({ "com.example.backup": true }),
    })
  );
}

async function telegram(services: Partial<CommandServices>): Promise<string[]> {
  const sent: string[] = [];
  await runTelegramCommand({
    chat: { reply: async text => void sent.push(text) },
    chatId: "-1001",
    topicId: 3,
    sessionKey: "topic:-1001:3",
    agent: "general",
    text: "/routinen",
    match: commandRegistry.match("/routinen", "telegram")!,
    services: services as CommandServices,
    working: () => () => {},
    resetSession: async () => ({ status: "unavailable" }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return sent;
}

async function webOrTerminal(source: "web" | "terminal", services: Partial<CommandServices>): Promise<string[]> {
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
    text: "/routinen",
    source,
    messageId: "m1",
    receivedAt: new Date().toISOString(),
    signal: new AbortController().signal,
    sink: {} as any,
    notice: async text => void notices.push(text),
    answer: async () => {},
    ask: async () => {},
    endAsk: () => {},
    commit: () => {},
  });
  return notices;
}

describe("/routinen im Register", () => {
  test("alle drei Kanäle, mit und ohne Namen; /routine bleibt eigener Befehl", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/routinen", channel)?.command.name).toBe("routinen");
      expect(commandRegistry.match("/routinen health-check", channel)?.command.name).toBe("routinen");
      expect(commandRegistry.match("/routine", channel)?.command.name).toBe("routine");
      expect(commandRegistry.match("/routine abc", channel)?.command.name).toBe("routine");
    }
  });

  test("/help nennt /routinen in der Gruppe Sessions & Routinen", () => {
    const group = HELP_TEXT.slice(HELP_TEXT.indexOf("**Sessions & Routinen:**"), HELP_TEXT.indexOf("**Agenten:**"));
    expect(group).toContain("\n/routinen - zeitgesteuerte Dienste");
    // Issue #289: mit Name Verlauf und Knöpfe
    expect(group).toMatch(/\n\/routinen <name> - [^\n]*20 Laeufe[^\n]*Knoepfen: Jetzt testen, Pausieren, Fortsetzen\n/);
  });
});

describe("Text der Übersicht", () => {
  test("Liste: erst zeitgesteuert, dann Dauerdienste; ohne Wrapper letzter Exit und „kein Verlauf\"", async () => {
    const text = formatRoutineList(await sampleList(), AT);
    expect(text).toBe(
      [
        "Routinen (launchd, 4):",
        [
          ROUTINES_TEXT.scheduled,
          "- com.example.backup: werktags 08:00 · pausiert · letzter Exit: unbekannt · kein Verlauf (nicht eingebunden) · nächster Lauf: keiner (pausiert)",
          "- health-check: täglich 03:30 · aktiv · letzter Exit: ok · kein Verlauf (nicht eingebunden) · nächster Lauf: morgen 03:30",
          "- watchdog: alle 10 Minuten · aktiv · letzter Exit: Fehler (Exit 1) · kein Verlauf (nicht eingebunden) · nächster Lauf: unbekannt",
        ].join("\n"),
        [ROUTINES_TEXT.daemons, "- telegram-relay: läuft · letzter Exit: ok"].join("\n"),
        ROUTINES_PENDING_HINT,
      ].join("\n\n")
    );
  });

  test("leer", () => {
    expect(formatRoutineList({ available: true, source: "launchd", routines: [], notes: [] })).toBe(`${ROUTINES_TEXT.none}\n\n${ROUTINES_PENDING_HINT}`);
  });

  test("nicht verfügbar: Linux ohne pm2", async () => {
    const text = formatRoutineList(await listRoutines(fakeRoutinesDeps({ platform: "linux", pm2Path: null })));
    expect(text).toBe("Routinen: auf diesem System nicht verfügbar (weder launchd noch systemd noch PM2).");
    expect(text).toContain("auf diesem System nicht verfügbar");
  });

  test("Hinweise stehen unter der Liste", () => {
    const text = formatRoutineList({ available: true, source: "launchd", routines: [], notes: ["launchctl list ist gescheitert."] });
    expect(text).toContain("Hinweis: launchctl list ist gescheitert.");
  });

  test("Exit-Code in Worten", () => {
    expect(exitText(0)).toBe("ok");
    expect(exitText(2)).toBe("Fehler (Exit 2)");
    expect(exitText(null)).toBe("unbekannt");
  });
});

describe("/routinen in allen Kanälen", () => {
  test("Telegram: Liste, leer, nicht verfügbar", async () => {
    const list = await sampleList();
    expect(await telegram({ routinesList: async () => list })).toEqual([formatRoutineList(list)]);
    const empty: RoutineList = { available: true, source: "launchd", routines: [], notes: [] };
    expect((await telegram({ routinesList: async () => empty }))[0]).toStartWith(ROUTINES_TEXT.none);
    const off: RoutineList = { available: false, source: null, routines: [], notes: [] };
    expect(await telegram({ routinesList: async () => off })).toEqual([ROUTINES_TEXT.unavailable]);
  });

  test("Telegram: lange Liste in Stücken bis 4096 Zeichen, keine Routine fehlt", async () => {
    const plists: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 80; i++) plists[`ai.tybo.r${i}.plist`] = scheduledPlist(`ai.tybo.routine-mit-sehr-langem-namen-${String(i).padStart(2, "0")}`);
    const list = await listRoutines(fakeRoutinesDeps({ plists }));
    const sent = await telegram({ routinesList: async () => list });
    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent) expect(part.length).toBeLessThanOrEqual(4096);
    const all = sent.join("\n");
    for (let i = 0; i < 80; i++) expect(all).toContain(`routine-mit-sehr-langem-namen-${String(i).padStart(2, "0")}:`);
  });

  for (const source of ["web", "terminal"] as const) {
    test(`${source}: Liste, leer, nicht verfügbar`, async () => {
      const list = await sampleList();
      expect(await webOrTerminal(source, { routinesList: async () => list })).toEqual([formatRoutineList(list)]);
      const empty: RoutineList = { available: true, source: "pm2", routines: [], notes: [] };
      expect((await webOrTerminal(source, { routinesList: async () => empty }))[0]).toStartWith(ROUTINES_TEXT.none);
      const off: RoutineList = { available: false, source: null, routines: [], notes: [] };
      expect(await webOrTerminal(source, { routinesList: async () => off })).toEqual([ROUTINES_TEXT.unavailable]);
    });
  }
});
