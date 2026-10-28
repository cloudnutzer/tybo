/**
 * Issue #288, Checkbox 3: Knöpfe an /routinen <name> und an den Fehler- und
 * Ausgeblieben-Meldungen aus Issue #287. Echtes Register mit eigener Datei,
 * launchd nur als Attrappe; kein echtes launchctl.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice, type ChoiceConversation } from "../src/lib/choices";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { createRoutineChoices, menuAlertSender, routineConversation, type RoutineChoices } from "../src/lib/routine-choices";
import { routineHistory } from "../src/lib/routines/catalog";
import { ROUTINES_PENDING_HINT } from "../src/lib/routines/format";
import type { AlertSendResult } from "../src/lib/routines/alerts";
import { createBotCommands } from "../src/web/bot-commands";
import { standardLaunchd, type FakeLaunchd } from "./routine-actions-fixture";

const HC = "ai.tybo.health-check";
const DM: ChoiceConversation = { type: "telegram", chatId: "123456" };

const base = mkdtempSync(join(tmpdir(), "routine-buttons-"));
let counter = 0;
let cleanup: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  setChoicesFileForTests(join(base, `choices-${++counter}.json`));
  cleanup = [];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const off of cleanup) off();
  logSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

function setup(launchd: FakeLaunchd = standardLaunchd()) {
  const sent: Choice[] = [];
  const notes: string[] = [];
  const rc: RoutineChoices = createRoutineChoices({
    routines: launchd.deps,
    sendChoice: async c => (sent.push(c), { sent: true }),
    notify: async (_c, text) => void notes.push(text),
    log: () => {},
  });
  cleanup.push(onChoiceDecided("routine", rc.handler));
  const services: Partial<CommandServices> = {
    routineHistory: name => routineHistory(launchd.deps, name),
    // Wie in src/bot.ts
    routineMenu: async (target, id) => {
      const conversation = routineConversation(target.chatId, target.topicId);
      return !!conversation && (await rc.offerMenu(conversation, id)).status === "sent";
    },
  };
  return { rc, sent, notes, services, launchd };
}

async function telegram(services: Partial<CommandServices>, text: string, chatId = "123456", topicId?: number): Promise<string[]> {
  const replies: string[] = [];
  await runTelegramCommand({
    chat: { reply: async t => void replies.push(t) },
    chatId,
    ...(topicId !== undefined ? { topicId } : {}),
    sessionKey: "dm",
    agent: "general",
    text,
    match: commandRegistry.match(text, "telegram")!,
    services: services as CommandServices,
    working: () => () => {},
    resetSession: async () => ({ status: "unavailable" }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return replies;
}

describe("/routinen <name>", () => {
  test("health-check: Verlauf, danach das Menü „Jetzt testen“ und „Pausieren“ im selben Gespräch", async () => {
    const s = setup();
    const replies = await telegram(s.services, "/routinen health-check", "-100200", 7);
    expect(replies[0]).toStartWith("health-check: täglich 03:30 · aktiv");
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ kind: "routine", ref: HC, action: "menu", conversation: { type: "telegram", chatId: "-100200", topicId: 7 } });
    expect(s.sent[0].options.map(o => o.label)).toEqual(["▶️ Jetzt testen", "⏸️ Pausieren"]);
  });

  test("pausierte Routine: Knopf „Fortsetzen“", async () => {
    const s = setup(standardLaunchd({ health: { disabled: true, loaded: false } }));
    await telegram(s.services, "/routinen health-check");
    expect(s.sent[0].options.map(o => o.label)).toEqual(["▶️ Fortsetzen"]);
  });

  test("telegram-relay und andere Dauerdienste: keine Knöpfe", async () => {
    const s = setup();
    const replies = await telegram(s.services, "/routinen telegram-relay");
    expect(replies[0]).toContain("Dauerdienst");
    await telegram(s.services, "/routinen web-proxy");
    expect(s.sent).toEqual([]);
    expect(await listChoices()).toEqual([]);
  });

  test("unbekannte Routine: kein Menü", async () => {
    const s = setup();
    expect((await telegram(s.services, "/routinen gibts-nicht"))[0]).toContain("Keine Routine gibts-nicht");
    expect(s.sent).toEqual([]);
  });

  test("ohne Dienst (ältere Aufrufer, Tests): nur der Verlauf", async () => {
    const s = setup();
    const { routineMenu: _off, ...rest } = s.services;
    expect(await telegram(rest, "/routinen health-check")).toHaveLength(1);
    expect(s.sent).toEqual([]);
  });

  test("ganzer Ablauf: Menü, Rückfrage, Abbrechen ändert nichts, neues Menü, Ja, pausieren", async () => {
    const s = setup();
    await telegram(s.services, "/routinen health-check");
    await decideChoice(s.sent[0].id, "pause", "telegram");
    await decideChoice(s.sent[1].id, "no", "telegram");
    expect(s.launchd.mutations()).toEqual([]);
    // Der alte Pausieren-Knopf ist entschieden: neues Menü
    await telegram(s.services, "/routinen health-check");
    await decideChoice(s.sent[2].id, "pause", "telegram");
    await decideChoice(s.sent[3].id, "yes", "telegram");
    expect(s.notes.at(-1)).toBe("⏸️ health-check ist pausiert. Nächster Lauf: keiner, bis du fortsetzt.");
    expect(s.launchd.services.get(HC)).toMatchObject({ disabled: true, loaded: false });
  });

  test("Browser und Terminal: Menü im Gespräch des Befehls (reines Web-Gespräch)", async () => {
    const s = setup();
    const unused = () => {
      throw new Error("nicht erwartet");
    };
    const commands = createBotCommands({
      registry: commandRegistry,
      services: s.services as CommandServices,
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
    const conversationId = "0b5e4c8a-1d2f-4a3b-9c8d-7e6f5a4b3c2d";
    for (const source of ["web", "terminal"] as const) {
      await commands.run({
        conversationId,
        agent: "general",
        text: "/routinen health-check",
        source,
        messageId: `m-${source}`,
        receivedAt: new Date().toISOString(),
        signal: new AbortController().signal,
        sink: {} as any,
        notice: async () => {},
        answer: async () => {},
        ask: async () => {},
        endAsk: () => {},
        commit: () => {},
      });
    }
    expect(s.sent.map(c => c.conversation)).toEqual([
      { type: "web", conversationId },
      { type: "web", conversationId },
    ]);
    // Zweimal gesendet, nur ein offenes Menü
    expect((await listChoices()).filter(c => c.state === "open")).toHaveLength(1);
  });

  test("Hinweis unter /routinen nennt die Knöpfe statt „folgen“", () => {
    expect(ROUTINES_PENDING_HINT).toBe("Pausieren, Fortsetzen und Testen: /routinen <name>.");
  });
});

describe("Fehler- und Ausgeblieben-Meldung mit Knöpfen", () => {
  const FAIL = "⚠️ Routine health-check fehlgeschlagen (Exit 1, 2 s)\nkaputt\nLog: ~/tybo/logs/x.log\nVerlauf: /routinen health-check";

  function sender(s: ReturnType<typeof setup>) {
    const plain: string[] = [];
    const send = menuAlertSender(
      async text => (plain.push(text), { sent: true, recorded: true } as AlertSendResult),
      (id, text) => s.rc.offerMenu(DM, id, text),
      () => {}
    );
    return { send, plain };
  }

  test("Fehlschlag: Meldungstext mit „Jetzt testen“ und „Pausieren“ im Direktchat, nichts zusätzlich ohne Knöpfe", async () => {
    const s = setup();
    const { send, plain } = sender(s);
    expect(await send(FAIL, { id: HC, kind: "failed" })).toEqual({ sent: true, recorded: true });
    expect(plain).toEqual([]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ text: FAIL, conversation: DM, ref: HC, action: "menu" });
    expect(s.sent[0].options.map(o => o.label)).toEqual(["▶️ Jetzt testen", "⏸️ Pausieren"]);
  });

  test("Ausgeblieben ebenso; Entwarnung ohne Knöpfe", async () => {
    const s = setup();
    const { send, plain } = sender(s);
    await send("⏰ Routine health-check ist nicht gelaufen", { id: HC, kind: "missed" });
    await send("✅ Routine health-check läuft wieder", { id: HC, kind: "recovered" });
    expect(s.sent).toHaveLength(1);
    expect(plain).toEqual(["✅ Routine health-check läuft wieder"]);
  });

  test("Wiederholungsversand: kein zusätzliches offenes Menü", async () => {
    const s = setup();
    const { send } = sender(s);
    await send(FAIL, { id: HC, kind: "failed" });
    await send(FAIL, { id: HC, kind: "failed" });
    expect((await listChoices()).filter(c => c.state === "open")).toHaveLength(1);
  });

  test("Dauerdienst oder ohne Angabe: wie bisher ohne Knöpfe", async () => {
    const s = setup();
    const { send, plain } = sender(s);
    await send("⚠️ Routine web-proxy fehlgeschlagen", { id: "ai.tybo.web-proxy", kind: "failed" });
    await send("ohne Angabe");
    expect(plain).toEqual(["⚠️ Routine web-proxy fehlgeschlagen", "ohne Angabe"]);
    expect(s.sent).toEqual([]);
  });

  test("Menü nicht zustellbar oder Register kaputt: Meldung kommt trotzdem ohne Knöpfe", async () => {
    const s = setup();
    const plain: string[] = [];
    const send = menuAlertSender(
      async text => (plain.push(text), { sent: true }),
      async () => {
        throw new Error("Register nicht lesbar");
      },
      () => {}
    );
    await send(FAIL, { id: HC, kind: "failed" });
    expect(plain).toEqual([FAIL]);
    expect(s.sent).toEqual([]);
  });

  test("„Jetzt testen“ an der Fehlermeldung startet ohne Rückfrage, „Pausieren“ fragt nach", async () => {
    const s = setup();
    const { send } = sender(s);
    await send(FAIL, { id: HC, kind: "failed" });
    await decideChoice(s.sent[0].id, "run", "telegram");
    expect(s.launchd.mutations()).toEqual([`kickstart gui/501/${HC}`]);
    // Lauf vorbei
    s.launchd.services.get(HC)!.pid = null;
    await send(FAIL, { id: HC, kind: "failed" });
    await decideChoice(s.sent[1].id, "pause", "telegram");
    expect(s.sent[2]).toMatchObject({ action: "pause" });
    expect(s.launchd.mutations()).toEqual([`kickstart gui/501/${HC}`]);
  });
});

describe("Log auf Fehlerwegen (nur Routinen-ID, Aktion und Kanal)", () => {
  const strict = /^\[routinen\] ai\.tybo\.health-check (run|pause|resume|menu) \((telegram|web|terminal)\)$/;

  test("/routinen <name>: Menü lässt sich nicht zeigen, Zeile genau mit ID, menu und Kanal", async () => {
    const s = setup();
    const services: Partial<CommandServices> = {
      ...s.services,
      routineMenu: async () => {
        throw new TypeError("Netz weg");
      },
    };
    const replies = await telegram(services, "/routinen health-check");
    expect(replies).toHaveLength(1);
    const lines = logSpy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("[routinen]"));
    expect(lines).toEqual(["[routinen] ai.tybo.health-check menu (telegram)"]);
    for (const line of lines) expect(line).toMatch(strict);
  });

  test("Quelltext: jede [routinen]-Zeile in Bot, Befehlen, Rückfragen und Aktionen ist die feste Form", () => {
    const dir = join(import.meta.dir, "..", "src");
    const files = ["bot.ts", "app/bot-choices.ts", "app/bot-start.ts", "lib/commands/builtin.ts", "lib/routine-choices.ts", "lib/routines/actions.ts", "web/routines.ts", "web/bot-routines.ts", "routine-run.ts"];
    const template = /^`\[routinen\] \$\{[a-z.]+\} \$\{[a-z]+\} \((web|\$\{[a-z]+\})\)`$/;
    let found = 0;
    for (const file of files) {
      const source = readFileSync(join(dir, file), "utf-8");
      // Kommentare zählen nicht; sonst nur die Vorlage aus routines/log.ts bzw. ihr Nachbau in web/routines.ts
      const code = source.split("\n").filter(l => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join("\n");
      for (const m of code.matchAll(/["'`]\[routinen\][^"'`]*["'`]/g)) {
        found++;
        expect(m[0]).toMatch(template);
      }
    }
    // Der Nachbau in web/routines.ts wird gefunden: der Test prüft wirklich etwas
    expect(found).toBeGreaterThan(0);
    for (const file of ["bot.ts", "app/bot-choices.ts", "app/bot-start.ts"]) {
      expect(readFileSync(join(dir, file), "utf-8")).not.toContain("Ergebnis nicht gemeldet");
    }
  });
});
