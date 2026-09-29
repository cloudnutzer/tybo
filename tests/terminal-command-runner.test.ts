/**
 * Issue #61: lokale Slash-Befehle von tybo gegen den Test-Server (manage:
 * Topics, Anweisungen, Session-Reset und ein älteres Web-Gespräch als
 * Attrappen). Jeder Befehl samt Fehlerfall; alles läuft über die API der
 * WebUI. /new, /stop, /agent und /topics führt seit Issue #74 der Server aus
 * (tests/web-commands.test.ts, tests/terminal-app-commands.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiClient, type ConversationSummary } from "../src/terminal/api";
import { CommandRunner } from "../src/terminal/command-runner";
import { parseInput, type Command } from "../src/terminal/commands";
import { createStyle } from "../src/terminal/render";
import { startTyboServer, type TerminalTestServer } from "./terminal-fixture";

let servers: TerminalTestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

function cmd(text: string): Command {
  const parsed = parseInput(text);
  if (parsed.kind !== "command") throw new Error(`kein Befehl: ${text}`);
  return parsed.command;
}

async function setup(startId = "topic-443", client?: (s: TerminalTestServer) => ApiClient, options: { withoutTelegram?: boolean } = {}) {
  const s = await startTyboServer({ manage: true, ...options });
  servers.push(s);
  const list = await s.client().listConversations();
  let current: ConversationSummary = list.find(c => c.id === (startId === "web" ? s.webConversationId : startId))!;
  const out = { infos: [] as string[], errors: [] as string[], switched: [] as { id: string; note?: string }[], quits: 0 };
  const runner = new CommandRunner({
    client: client ? client(s) : s.client(),
    style: createStyle(false),
    current: () => current,
    switchTo: async (c, note) => {
      out.switched.push({ id: c.id, ...(note ? { note } : {}) });
      current = c;
    },
    updateCurrent: c => {
      current = c;
    },
    info: t => out.infos.push(t),
    error: t => out.errors.push(t),
    quit: () => out.quits++,
  });
  return {
    s,
    runner,
    out,
    run: (text: string) => runner.run(cmd(text)),
    get current() {
      return current;
    },
  };
}

async function topicCount(s: TerminalTestServer): Promise<number> {
  return (await s.client().listConversations()).filter(c => c.kind === "topic").length;
}

describe("/tasten und /quit", () => {
  test("/tasten listet die lokalen Befehle und verweist auf die des Bots", async () => {
    const t = await setup();
    expect(await t.run("/tasten")).toBe(true);
    const help = t.out.infos.join("\n");
    for (const name of ["/tasten", "/help", "/gespraeche", "/wechsel", "/neu", "/zuordnen", "/quit", "/new", "/stop", "/agent", "/topics"]) expect(help).toContain(name);
    expect(help).not.toContain("/goal");
    expect(help).not.toContain("/board");
  });

  test("/tasten nennt die Befehle des Bots aus GET /api/commands, sobald geladen", async () => {
    const s = await startTyboServer({ manage: true, commands: true });
    servers.push(s);
    const list = await s.client().listConversations();
    const infos: string[] = [];
    const runner = new CommandRunner({
      client: s.client(),
      style: createStyle(false),
      current: () => list[0],
      switchTo: async () => {},
      updateCurrent: () => {},
      info: t => infos.push(t),
      error: () => {},
      quit: () => {},
    });
    await runner.preload();
    expect(runner.commandNames).toContain("new");
    expect(runner.commandNames).toContain("reset");
    // Issue #78: /voice auch im Terminal
    expect(runner.commandNames).toContain("voice");
    await runner.run(cmd("/tasten"));
    expect(infos[0]).toContain("Befehle des Bots (wie in Telegram):");
    expect(infos[0]).toMatch(/\/critic <idee> +Stress-Test/);
  });

  test("/quit beendet", async () => {
    const t = await setup();
    await t.run("/quit");
    expect(t.out.quits).toBe(1);
  });
});

describe("/gespraeche und /wechsel", () => {
  test("Liste mit Nummer, Name, Agent, letzter Aktivität; offenes Gespräch markiert", async () => {
    const t = await setup();
    await t.run("/gespraeche");
    const text = t.out.infos[0];
    const lines = text.split("\n");
    expect(lines[0]).toBe("Gespräche");
    const recherche = lines.find(l => l.includes("Recherche"))!;
    expect(recherche).toMatch(/^› +\d+ +Recherche +Research +heute \d\d:\d\d$/);
    expect(lines.find(l => l.includes("Direktchat"))).toMatch(/^ +1 +Direktchat +General/);
    expect(lines.find(l => l.includes("Archiv"))).toContain("geschlossen");
    expect(lines.find(l => /^ +\d+ +General +General/.test(l))).toContain("noch nichts");
    expect(text).toContain("Altes Web-Gespräch");
  });

  test("/wechsel <Nr.> nach /gespraeche, auch nach neuer Aktivität dasselbe Gespräch", async () => {
    const t = await setup();
    await t.run("/gespraeche");
    const line = t.out.infos[0].split("\n").find(l => l.includes("Finanzen"))!;
    const n = /^\s*›?\s*(\d+)/.exec(line)![1];
    // Neue Aktivität in einem anderen Topic sortiert die Liste des Servers um
    t.s.receiveFromTelegram("topic-31", "user", "Neu hier");
    expect(await t.run(`/wechsel ${n}`)).toBe(true);
    expect(t.out.switched).toEqual([{ id: "topic-12" }]);
  });

  test("/wechsel <Name>, Groß- und Kleinschreibung egal", async () => {
    const t = await setup();
    expect(await t.run("/wechsel strategie")).toBe(true);
    expect(t.out.switched).toEqual([{ id: "topic-31" }]);
  });

  test("/wechsel: Nummer ohne Liste, unbekanntes Gespräch, doppelte Namen", async () => {
    const t = await setup();
    expect(await t.run("/wechsel 3")).toBe(false);
    expect(t.out.errors.pop()).toContain("Erst /gespraeche");
    expect(await t.run("/wechsel Gibtsnicht")).toBe(false);
    expect(t.out.errors.pop()).toBe("Kein Gespräch „Gibtsnicht\". /gespraeche zeigt alle.");
    t.s.telegram.upsertTopic(13, { title: "Finanzen", agent: "general" });
    await t.run("/gespraeche");
    expect(await t.run("/wechsel Finanzen")).toBe(false);
    expect(t.out.errors.pop()).toMatch(/^Mehrere Gespräche heißen „Finanzen": Nr\. \d+ \(topic-1[23]\), Nr\. \d+ \(topic-1[23]\)/);
    expect(t.out.switched).toEqual([]);
  });

  test("/wechsel ins offene Gespräch: nur Hinweis", async () => {
    const t = await setup();
    expect(await t.run("/wechsel Recherche")).toBe(true);
    expect(t.out.switched).toEqual([]);
    expect(t.out.infos.pop()).toBe("Du bist schon in Recherche.");
  });
});

describe("Issue #228: /neu ohne Forum-Gruppe (ohne Telegram)", () => {
  test("/neu research Mein Titel: Web-Gespräch mit Agent und Titel, Meldung ohne Telegram-Satz", async () => {
    const t = await setup("dm", undefined, { withoutTelegram: true });
    expect(t.current.id).toBe("dm");
    expect(await t.run("/neu research Mein Titel")).toBe(true);
    expect(t.out.errors).toEqual([]);
    const switched = t.out.switched[0];
    expect(switched.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(switched.note).toBe("Neues Gespräch mit Research.");
    expect(switched.note).not.toContain("Telegram");
    expect(t.current).toMatchObject({ id: switched.id, kind: "web", title: "Mein Titel", agent: "research" });
    const created = (await t.s.client().listConversations()).find(c => c.id === switched.id)!;
    expect(created).toMatchObject({ kind: "web", title: "Mein Titel", agent: "research" });
    // Keine Topics angelegt
    expect(await topicCount(t.s)).toBe(0);
  });

  test("/neu ohne Argumente: Web-Gespräch mit General", async () => {
    const t = await setup("dm", undefined, { withoutTelegram: true });
    expect(await t.run("/neu")).toBe(true);
    expect(t.current.kind).toBe("web");
    expect(t.current.agent).toBe("general");
    expect(t.out.switched[0].note).toBe("Neues Gespräch mit General.");
  });

  test("mit Forum-Gruppe bleibt es beim Topic und dem Telegram-Satz", async () => {
    const t = await setup();
    expect(await t.run("/neu research Plan")).toBe(true);
    expect(t.current.kind).toBe("topic");
    expect(t.out.switched[0].note).toBe("Neues Gespräch mit Research, auch als Topic in Telegram.");
  });
});

describe("/neu", () => {
  test("ohne Argumente: Topic mit General, Wechsel hinein", async () => {
    const t = await setup();
    const before = await topicCount(t.s);
    expect(await t.run("/neu")).toBe(true);
    expect(await topicCount(t.s)).toBe(before + 1);
    const id = t.out.switched[0].id;
    expect(id).toMatch(/^topic-\d+$/);
    const created = (await t.s.client().listConversations()).find(c => c.id === id)!;
    expect(created.agent).toBe("general");
    expect(t.out.switched[0].note).toContain("General");
  });

  test("Agent und mehrteiliger Titel", async () => {
    const t = await setup();
    expect(await t.run("/neu Research Markt Q4 2026")).toBe(true);
    const created = (await t.s.client().listConversations()).find(c => c.id === t.out.switched[0].id)!;
    expect(created).toMatchObject({ title: "Markt Q4 2026", agent: "research" });
    expect(t.current.title).toBe("Markt Q4 2026");
  });

  test("nur Titel: Standard-Agent", async () => {
    const t = await setup();
    await t.run("/neu Urlaub Nordsee");
    const created = (await t.s.client().listConversations()).find(c => c.id === t.out.switched[0].id)!;
    expect(created).toMatchObject({ title: "Urlaub Nordsee", agent: "general" });
  });

  test("zu langer Titel: nichts angelegt", async () => {
    const t = await setup();
    const before = await topicCount(t.s);
    expect(await t.run(`/neu finance ${"x".repeat(129)}`)).toBe(false);
    expect(t.out.errors.pop()).toContain("Nichts angelegt");
    expect(await topicCount(t.s)).toBe(before);
  });

  test("Titel scheitert nach dem Anlegen: Topic gemeldet, nicht erneut angelegt", async () => {
    let creates = 0;
    const t = await setup("topic-443", s => {
      const client = s.client();
      const create = client.createConversation.bind(client);
      client.createConversation = async agent => {
        creates++;
        return create(agent);
      };
      client.updateTopic = async () => {
        throw new Error("Telegram hat die Aktion abgelehnt");
      };
      return client;
    });
    expect(await t.run("/neu research Plan")).toBe(false);
    expect(creates).toBe(1);
    const error = t.out.errors.pop()!;
    expect(error).toContain("ist angelegt, aber: Titel nicht gesetzt: Telegram hat die Aktion abgelehnt");
    expect(error).toContain("Nicht noch einmal anlegen");
    // Trotzdem hinein gewechselt, damit das Topic nicht verloren geht
    expect(t.out.switched).toHaveLength(1);
  });
});

describe("/zuordnen (früher /agent <Name>)", () => {
  test("ändert den Agenten des Topics", async () => {
    const t = await setup();
    expect(await t.run("/zuordnen Finance")).toBe(true);
    expect(t.current.agent).toBe("finance");
    const topic = (await t.s.client().listConversations()).find(c => c.id === "topic-443")!;
    expect(topic.agent).toBe("finance");
    expect(t.out.infos.pop()).toContain("ist jetzt Finance");
  });

  test("unbekannter Agent: Fehler mit Liste, nichts geändert", async () => {
    const t = await setup();
    expect(await t.run("/zuordnen gibtsnicht")).toBe(false);
    expect(t.out.errors.pop()).toMatch(/^Unbekannter Agent „gibtsnicht"\. Verfügbar: general, research/);
    expect((await t.s.client().listConversations()).find(c => c.id === "topic-443")!.agent).toBe("research");
  });

  test("Direktchat und General: nicht änderbar wie im Browser", async () => {
    for (const id of ["dm", "topic-1"]) {
      const t = await setup(id);
      expect(await t.run("/zuordnen research")).toBe(false);
      expect(t.out.errors.pop()).toContain("antwortet immer General");
    }
  });

  test("älteres Web-Gespräch: fester Agent", async () => {
    const t = await setup("web");
    expect(await t.run("/zuordnen finance")).toBe(false);
    expect(t.out.errors.pop()).toContain("festen Agenten");
  });

  test("Server nicht erreichbar: klare Meldung", async () => {
    const t = await setup("topic-443", s => new ApiClient({ base: "http://127.0.0.1:9", getToken: async () => "x", timeoutMs: 500 }));
    expect(await t.run("/gespraeche")).toBe(false);
    expect(t.out.errors.pop()).toBe("Keine Verbindung zum Bot.");
  });
});
