/**
 * Issue #61: Befehlsparser von tybo (src/terminal/commands.ts). Seit Issue #74
 * bleiben nur Terminal-Befehle lokal; alle anderen mit Schrägstrich gehen
 * als Nachricht an den Server, der sie wie in Telegram ausführt oder als
 * Text an Claude gibt.
 */
import { describe, expect, test } from "bun:test";
import type { ConversationSummary } from "../src/terminal/api";
import { completeInput, parseInput, resolveSwitchTarget, splitAgentAndTitle } from "../src/terminal/commands";
import { activityText } from "../src/terminal/view";

const AGENTS = ["general", "research", "finance", "critic"];

describe("parseInput", () => {
  test("normale Nachricht bleibt unverändert", () => {
    expect(parseInput("Hallo /help")).toEqual({ kind: "message", text: "Hallo /help" });
  });

  test("// schickt eine Nachricht mit einem Schrägstrich", () => {
    expect(parseInput("//etc/hosts ansehen")).toEqual({ kind: "message", text: "/etc/hosts ansehen" });
    expect(parseInput("//wechsel")).toEqual({ kind: "message", text: "/wechsel" });
  });

  test("lokale Befehle ohne Argumente", () => {
    expect(parseInput("/tasten")).toEqual({ kind: "command", command: { type: "keys" } });
    expect(parseInput("/gespraeche")).toEqual({ kind: "command", command: { type: "list" } });
    expect(parseInput("/gespräche")).toEqual({ kind: "command", command: { type: "list" } });
    expect(parseInput("/quit")).toEqual({ kind: "command", command: { type: "quit" } });
  });

  test("Groß- und Kleinschreibung, Leerraum und @botname zählen nicht", () => {
    expect(parseInput("  /QUIT  ")).toEqual({ kind: "command", command: { type: "quit" } });
    expect(parseInput("/gespraeche@tybo_bot")).toEqual({ kind: "command", command: { type: "list" } });
  });

  test("Argumente, wo keine hingehören, sind ein Fehler", () => {
    const r = parseInput("/quit jetzt");
    expect(r.kind).toBe("invalid");
    expect(r.kind === "invalid" && r.error).toContain("/quit erwartet nichts");
  });

  test("/wechsel braucht ein Ziel", () => {
    expect(parseInput("/wechsel 3")).toEqual({ kind: "command", command: { type: "switch", target: "3" } });
    expect(parseInput("/wechsel Mein Projekt")).toEqual({ kind: "command", command: { type: "switch", target: "Mein Projekt" } });
    expect(parseInput("/wechsel").kind).toBe("invalid");
  });

  test("/neu mit und ohne Argumente", () => {
    expect(parseInput("/neu")).toEqual({ kind: "command", command: { type: "create", args: "" } });
    expect(parseInput("/neu research Marktanalyse Q4")).toEqual({ kind: "command", command: { type: "create", args: "research Marktanalyse Q4" } });
  });

  test("/zuordnen ändert den Agenten des Topics (früher /agent <Name>)", () => {
    expect(parseInput("/zuordnen Research")).toEqual({ kind: "command", command: { type: "assign", agent: "research" } });
    expect(parseInput("/zuordnen").kind).toBe("invalid");
    expect(parseInput("/zuordnen research bitte").kind).toBe("invalid");
  });

  test("Befehle des Bots gehen als Nachricht an den Server (Issue #74)", () => {
    for (const text of ["/new", "/topics", "/agent", "/agent research", "/agent research: antworte kürzer", "/help", "/hilfe", "/learn https://x.org", "/critic Idee"]) {
      expect(parseInput(text)).toEqual({ kind: "message", text });
    }
  });

  test("/stop und /abbruch gehen auch während einer Antwort (urgent)", () => {
    expect(parseInput("/stop")).toEqual({ kind: "message", text: "/stop", urgent: true });
    expect(parseInput("  /Abbruch")).toEqual({ kind: "message", text: "  /Abbruch", urgent: true });
    expect(parseInput("/stop jetzt")).toEqual({ kind: "message", text: "/stop jetzt" });
  });

  test("/goal pause und /goal stop samt Aliasen gehen auch während einer Antwort (urgent, Issue #76)", () => {
    for (const text of ["/goal pause", "/goal stop", "/goal cancel", "/goal done", "/goal abbrechen", " /Goal Pause", "/goal@tybo_bot stop"]) {
      expect(parseInput(text)).toEqual({ kind: "message", text, urgent: true });
    }
    for (const text of ["/goal", "/goal weiter", "/goal status", "/goal pause jetzt", "/goal stoppen"]) {
      expect(parseInput(text)).toEqual({ kind: "message", text });
    }
  });

  test("unbekannte Befehle, /k3 und /goal gehen ebenfalls an den Server (dort als Text an Claude)", () => {
    for (const text of ["/foo", "/k3 x", "/goal Umsatz verdoppeln", "/board Thema", "/Users/alex/datei.txt", "/"]) {
      expect(parseInput(text)).toEqual({ kind: "message", text });
    }
  });
});

describe("splitAgentAndTitle (/neu)", () => {
  test("ohne Argumente: Standard-Agent, kein Titel", () => {
    expect(splitAgentAndTitle("", AGENTS, "general")).toEqual({ agent: "general" });
  });

  test("nur Agent", () => {
    expect(splitAgentAndTitle("Research", AGENTS, "general")).toEqual({ agent: "research" });
  });

  test("Agent und mehrteiliger Titel", () => {
    expect(splitAgentAndTitle("finance  Steuer 2026  planen", AGENTS, "general")).toEqual({ agent: "finance", title: "Steuer 2026  planen" });
  });

  test("erstes Wort kein Agent: alles ist Titel, Standard-Agent", () => {
    expect(splitAgentAndTitle("Urlaub Nordsee", AGENTS, "general")).toEqual({ agent: "general", title: "Urlaub Nordsee" });
  });

  test("Titel, der mit einem Agentennamen beginnt: Agent davor", () => {
    expect(splitAgentAndTitle("general Research-Plan", AGENTS, "general")).toEqual({ agent: "general", title: "Research-Plan" });
  });
});

const LIST: ConversationSummary[] = [
  { id: "dm", title: "Direktchat", agent: "general", kind: "dm" },
  { id: "topic-443", title: "Recherche", agent: "research", kind: "topic" },
  { id: "topic-12", title: "Finanzen", agent: "finance", kind: "topic" },
  { id: "topic-13", title: "finanzen", agent: "general", kind: "topic" },
  { id: "topic-1", title: "General", agent: "general", kind: "topic" },
];

describe("resolveSwitchTarget (/wechsel)", () => {
  const shown = LIST.map(c => c.id);

  test("Nummer aus der gezeigten Liste", () => {
    const r = resolveSwitchTarget(LIST, shown, "2");
    expect(r.ok && r.conversation.id).toBe("topic-443");
  });

  test("Nummer zeigt nach neuer Aktivität auf dasselbe Gespräch", () => {
    // Neue Aktivität sortiert die Liste des Servers um; die gezeigte Liste bleibt
    const resorted = [LIST[2], LIST[0], LIST[1], LIST[3], LIST[4]];
    const r = resolveSwitchTarget(resorted, shown, "2");
    expect(r.ok && r.conversation.id).toBe("topic-443");
  });

  test("Nummer ohne gezeigte Liste gilt nicht (keine Topic-ID)", () => {
    const r = resolveSwitchTarget(LIST, null, "12");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("Erst /gespraeche");
  });

  test("Nummer außerhalb der Liste", () => {
    const r = resolveSwitchTarget(LIST, shown, "9");
    expect(!r.ok && r.error).toBe("Keine Nummer 9 in der letzten Liste (1 bis 5).");
  });

  test("Gespräch aus der Liste inzwischen gelöscht", () => {
    const r = resolveSwitchTarget(LIST.filter(c => c.id !== "topic-443"), shown, "2");
    expect(!r.ok && r.error).toContain("gibt es nicht mehr");
  });

  test("ID, dm und Direktchat", () => {
    expect(resolveSwitchTarget(LIST, null, "topic-12").ok).toBe(true);
    const dm = resolveSwitchTarget(LIST, null, "Direktchat");
    expect(dm.ok && dm.conversation.id).toBe("dm");
  });

  test("Name, Groß- und Kleinschreibung egal", () => {
    const r = resolveSwitchTarget(LIST, null, "recherche");
    expect(r.ok && r.conversation.id).toBe("topic-443");
  });

  test("doppelte Namen: Fehler mit Nummern, kein Raten", () => {
    const r = resolveSwitchTarget(LIST, shown, "Finanzen");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("Mehrere Gespräche heißen „Finanzen\": Nr. 3 (topic-12), Nr. 4 (topic-13). Mit Nummer oder ID wählen.");
  });

  test("unbekanntes Gespräch", () => {
    const r = resolveSwitchTarget(LIST, shown, "Gibtsnicht");
    expect(!r.ok && r.error).toBe("Kein Gespräch „Gibtsnicht\". /gespraeche zeigt alle.");
  });
});

describe("completeInput (Tab)", () => {
  const sources = { conversations: ["Direktchat", "Recherche", "Finanzen", "Finanzplanung 2027", "General"], agents: ["general", "research", "finance"] };

  test("Befehl eindeutig: ergänzt mit Leerzeichen", () => {
    expect(completeInput("/wec", sources)).toEqual({ text: "/wechsel ", options: [] });
    expect(completeInput("/q", sources)).toEqual({ text: "/quit ", options: [] });
  });

  test("Befehl mehrdeutig: gemeinsamer Anfang und Auswahl", () => {
    expect(completeInput("/ne", sources)).toEqual({ text: "/neu ", options: [] });
    expect(completeInput("/", sources)?.options).toHaveLength(6);
  });

  test("Befehle des Bots aus GET /api/commands werden mit ergänzt (Issue #74)", () => {
    const withBot = { ...sources, commands: ["help", "hilfe", "new", "reset", "stop", "agent"] };
    expect(completeInput("/ne", withBot)).toEqual({ text: "/ne", options: ["neu", "new"] });
    expect(completeInput("/hi", withBot)).toEqual({ text: "/hilfe ", options: [] });
    // 6 lokale und 6 des Bots
    expect(completeInput("/", withBot)?.options).toHaveLength(12);
  });

  test("Gesprächsname bei /wechsel, Groß- und Kleinschreibung egal, auch mit Leerzeichen", () => {
    expect(completeInput("/wechsel rech", sources)).toEqual({ text: "/wechsel Recherche", options: [] });
    expect(completeInput("/wechsel fin", sources)).toEqual({ text: "/wechsel Finanz", options: ["Finanzen", "Finanzplanung 2027"] });
    expect(completeInput("/wechsel Finanzp", sources)).toEqual({ text: "/wechsel Finanzplanung 2027", options: [] });
  });

  test("Agent bei /agent, /zuordnen und /neu", () => {
    expect(completeInput("/agent re", sources)).toEqual({ text: "/agent research", options: [] });
    expect(completeInput("/zuordnen fi", sources)).toEqual({ text: "/zuordnen finance", options: [] });
    expect(completeInput("/neu fi", sources)).toEqual({ text: "/neu finance ", options: [] });
    expect(completeInput("/agent research: kür", sources)).toBeNull();
    expect(completeInput("/neu finance Tit", sources)).toBeNull();
  });

  test("nichts zu ergänzen: null", () => {
    expect(completeInput("Hallo", sources)).toBeNull();
    expect(completeInput("/xyz", sources)).toBeNull();
    expect(completeInput("/wechsel Gibts", sources)).toBeNull();
    expect(completeInput("/wec\nzweite Zeile", sources)).toBeNull();
    expect(completeInput("/stop jetzt", sources)).toBeNull();
  });
});

describe("activityText", () => {
  const now = new Date(2026, 8, 24, 18, 0).getTime();
  test("heute, gestern, dieses Jahr, anderes Jahr, keine Aktivität", () => {
    expect(activityText(new Date(2026, 8, 24, 9, 5).toISOString(), now)).toBe("heute 09:05");
    expect(activityText(new Date(2026, 8, 23, 23, 59).toISOString(), now)).toBe("gestern 23:59");
    expect(activityText(new Date(2026, 2, 3, 7, 0).toISOString(), now)).toBe("03.03. 07:00");
    expect(activityText(new Date(2025, 11, 31, 12, 0).toISOString(), now)).toBe("31.12.2025 12:00");
    expect(activityText(null, now)).toBe("noch nichts");
    expect(activityText("kaputt", now)).toBe("noch nichts");
  });
});

describe("parseChoiceNumber (Issue #120)", () => {
  test("bloße Zahl und /<zahl>, Leerraum egal; sonst null", async () => {
    const { parseChoiceNumber } = await import("../src/terminal/commands");
    expect(parseChoiceNumber("1")).toBe(1);
    expect(parseChoiceNumber(" /2 ")).toBe(2);
    expect(parseChoiceNumber("12")).toBe(12);
    for (const text of ["", "/", "//1", "1a", "1 2", "/wechsel 1", "ja", "-1", "1.5"]) expect(parseChoiceNumber(text)).toBeNull();
  });

  test("resolveSwitchTarget bleibt unverändert: Zahl nur mit gezeigter Liste", () => {
    expect(resolveSwitchTarget(LIST, null, "1")).toEqual({ ok: false, error: "Nummern gelten für die /gespraeche-Liste. Erst /gespraeche, dann /wechsel <Nr.>." });
    expect(resolveSwitchTarget(LIST, LIST.map(c => c.id), "1")).toEqual({ ok: true, conversation: LIST[0] });
  });
});

describe("Terminal-Hilfe (Issue #120)", () => {
  test("/tasten erklärt die nummerierte Auswahl", async () => {
    const { COMMAND_HELP } = await import("../src/terminal/commands");
    expect(COMMAND_HELP).toContain("[1] Erlauben  [2] Ablehnen");
    expect(COMMAND_HELP).toContain("1 oder /1 wählt");
    expect(COMMAND_HELP).not.toContain("—");
  });
});
