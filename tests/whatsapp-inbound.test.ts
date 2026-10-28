/**
 * Issue #345, Checkbox 1: Verteilung im WhatsApp-Eingang. Nur eine
 * Direktnachricht des Besitzers (auch /dm aus einer Gruppe) erreicht den
 * Chat-Kern; Gäste und Gruppen, auch der Besitzer in einer Gruppe, gehen an
 * den Gäste-Assistenten und berühren weder Gedächtnis noch Verlauf des
 * Besitzers. Gruppen-Weiterleitung, /group und Versand bleiben wie bisher.
 */
import { describe, expect, test } from "bun:test";
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY } from "../src/lib/chat-turn";
import { createWhatsAppInbound, WHATSAPP_TEXT, type WhatsAppGroupMatch } from "../src/channels/whatsapp/inbound";
import { handleGroupCommand, isDmMessage, shouldBotRespond } from "../src/lib/whatsapp-groups";

const OWNER = "+4915100000001";
const GUEST = "+4915100000002";
const THIRD = "+4915100000003";

const FAMILY: WhatsAppGroupMatch["group"] = { name: "Familie", members: { [OWNER]: "Alex", [GUEST]: "Mia", [THIRD]: "Sam" } };

function harness(opts: { ownerReply?: string | Error; guestReply?: string | Error; shuttingDown?: boolean; ownerInGroup?: boolean } = {}) {
  const ownerCalls: [string, string][] = [];
  const guestCalls: [string, string][] = [];
  const guestSaved: [string, string, string][] = [];
  const sentOne: [string, string][] = [];
  const sent: [string, string][] = [];
  const queued: string[] = [];
  // Ohne ownerInGroup ist der Besitzer für die Gruppensuche kein Mitglied (Direktnachrichten)
  const groupOf = (number: string): WhatsAppGroupMatch | null =>
    number in FAMILY.members && (number !== OWNER || opts.ownerInGroup) ? { groupId: "fam", group: FAMILY, senderName: FAMILY.members[number] } : null;

  const handle = createWhatsAppInbound({
    sender: {
      sendOne: async (to, text) => {
        sentOne.push([to, text]);
        return true;
      },
      send: async (to, text) => void sent.push([to, text]),
    },
    isOwner: number => number === OWNER,
    ownerTurn: async (number, text) => {
      ownerCalls.push([number, text]);
      if (opts.ownerReply instanceof Error) throw opts.ownerReply;
      return opts.ownerReply ?? "Antwort mit Gedächtnis [REMEMBER: Testfakt]";
    },
    guest: {
      answer: async (scope, text) => {
        guestCalls.push([scope, text]);
        if (opts.guestReply instanceof Error) throw opts.guestReply;
        return opts.guestReply ?? "Gast-Antwort";
      },
      save: (scope, role, content) => void guestSaved.push([scope, role, content]),
    },
    groups: {
      find: groupOf,
      botQuestion: shouldBotRespond,
      directPart: isDmMessage,
      command: (number, body) => `befehl ${number} ${body}`,
    },
    queue: (key, fn) => {
      queued.push(key);
      return fn();
    },
    botName: "tybo",
    isShuttingDown: () => opts.shuttingDown ?? false,
    log: () => {},
  });
  return { handle, ownerCalls, guestCalls, guestSaved, sentOne, sent, queued };
}

describe("Direktnachrichten", () => {
  test("Besitzer: Chat-Kern, Antwort ohne Steuer-Tags zurück", async () => {
    const h = harness();
    await h.handle(`whatsapp:${OWNER}`, "Was weißt du über mich?");
    expect(h.ownerCalls).toEqual([[OWNER, "Was weißt du über mich?"]]);
    expect(h.guestCalls).toEqual([]);
    expect(h.guestSaved).toEqual([]);
    expect(h.sent).toEqual([[`whatsapp:${OWNER}`, "Antwort mit Gedächtnis"]]);
  });

  test("Besitzer: nur Steuer-Tags ergeben keine leere Nachricht", async () => {
    const h = harness({ ownerReply: "[REMEMBER: still]" });
    await h.handle(OWNER, "merk dir was");
    expect(h.sent).toEqual([]);
  });

  test("Gast: Gäste-Assistent mit eigenem Verlauf, nie der Chat-Kern", async () => {
    const h = harness({ ownerReply: new Error("Besitzer-Kern darf nicht laufen") });
    const outsider = "+4915100000099";
    await h.handle(`whatsapp:${outsider}`, "Hallo, wer bist du?");
    expect(h.ownerCalls).toEqual([]);
    expect(h.guestCalls).toEqual([[`wa:${outsider}`, "Hallo, wer bist du?"]]);
    expect(h.guestSaved).toEqual([
      [`wa:${outsider}`, "user", "Hallo, wer bist du?"],
      [`wa:${outsider}`, "assistant", "Gast-Antwort"],
    ]);
    expect(h.queued).toEqual([`dm:wa:${outsider}`]);
    expect(h.sent).toEqual([[`whatsapp:${outsider}`, "Gast-Antwort"]]);
  });

  test("Gast-Antwort behält ihren Text (keine Tag-Verarbeitung, nichts entfernt)", async () => {
    const h = harness({ guestReply: "Text [REMEMBER: Gast will etwas]" });
    await h.handle("+4915100000099", "x");
    expect(h.sent[0][1]).toBe("Text [REMEMBER: Gast will etwas]");
    expect(h.ownerCalls).toEqual([]);
  });

  test("Fehler im Besitzer-Turn: Hinweis an den Absender", async () => {
    const h = harness({ ownerReply: new Error("kaputt") });
    await h.handle(OWNER, "x");
    expect(h.sentOne).toEqual([[OWNER, WHATSAPP_TEXT.directFailed]]);
  });

  test("Fehler bei einem Gast: dieselbe Antwort wie vor der Umstellung", async () => {
    const h = harness({ guestReply: new Error("weg") });
    const outsider = "+4915100000099";
    await h.handle(outsider, "x");
    expect(h.sentOne).toEqual([[outsider, "Sorry, something went wrong processing your message. Please try again."]]);
  });

  test("Abbruch beim Beenden: Meldung fürs Beenden; sonst die Abbruch-Meldung", async () => {
    const stopping = harness({ ownerReply: ABORT_REPLY, shuttingDown: true });
    await stopping.handle(OWNER, "x");
    expect(stopping.sentOne).toEqual([[OWNER, SHUTDOWN_ABORT_REPLY]]);
    const running = harness({ ownerReply: ABORT_REPLY });
    await running.handle(OWNER, "x");
    expect(running.sentOne).toEqual([[OWNER, ABORT_REPLY]]);
  });
});

describe("Gruppen", () => {
  test("Besitzer in der Gruppe: Weiterleitung, Bot-Frage an den Gäste-Assistenten, nie an den Kern", async () => {
    const h = harness({ ownerReply: new Error("Besitzer-Kern darf nicht laufen"), ownerInGroup: true });
    await h.handle(`whatsapp:${OWNER}`, "@tybo was steht heute an?");
    expect(h.ownerCalls).toEqual([]);
    expect(h.sentOne).toEqual([
      [GUEST, "[Alex]: @tybo was steht heute an?"],
      [THIRD, "[Alex]: @tybo was steht heute an?"],
    ]);
    expect(h.guestCalls).toEqual([["wa:group:fam", "was steht heute an?"]]);
    expect(h.guestSaved).toEqual([
      ["wa:group:fam", "user", "[Alex]: @tybo was steht heute an?"],
      ["wa:group:fam", "assistant", "Gast-Antwort"],
    ]);
    expect(h.sent).toEqual([
      [OWNER, "[tybo]: Gast-Antwort"],
      [GUEST, "[tybo]: Gast-Antwort"],
      [THIRD, "[tybo]: Gast-Antwort"],
    ]);
  });

  test("Gast in der Gruppe ohne Bot-Frage: nur Weiterleitung", async () => {
    const h = harness();
    await h.handle(GUEST, "Bin gleich da");
    expect(h.sentOne).toEqual([
      [OWNER, "[Mia]: Bin gleich da"],
      [THIRD, "[Mia]: Bin gleich da"],
    ]);
    expect(h.guestCalls).toEqual([]);
    expect(h.ownerCalls).toEqual([]);
  });

  test("Fehler bei der Bot-Frage: Hinweis nur an den Absender", async () => {
    const h = harness({ guestReply: new Error("weg") });
    await h.handle(GUEST, "/ask Wetter?");
    expect(h.sentOne.at(-1)).toEqual([GUEST, WHATSAPP_TEXT.groupFailed]);
    // Wörtlich wie vor der Umstellung
    expect(WHATSAPP_TEXT.groupFailed).toBe("Sorry, I couldn't process that. Try again.");
  });

  test("/dm des Besitzers aus einer Gruppe: Chat-Kern, keine Weiterleitung", async () => {
    const h = harness({ ownerInGroup: true });
    await h.handle(OWNER, "/dm Was weißt du über mich?");
    expect(h.ownerCalls).toEqual([[OWNER, "Was weißt du über mich?"]]);
    expect(h.sentOne).toEqual([]);
    expect(h.sent).toEqual([[OWNER, "Antwort mit Gedächtnis"]]);
  });

  test("/dm eines Gastes aus einer Gruppe: Gäste-Assistent, nie der Kern", async () => {
    const h = harness({ ownerReply: new Error("Besitzer-Kern darf nicht laufen") });
    await h.handle(GUEST, "/dm nur für mich");
    expect(h.ownerCalls).toEqual([]);
    expect(h.guestCalls).toEqual([[`wa:${GUEST}`, "nur für mich"]]);
    expect(h.sentOne).toEqual([]);
  });

  test("/group geht an die Gruppenbefehle, auch /groups wie bisher", async () => {
    const h = harness();
    await h.handle(`whatsapp:${GUEST}`, "/group help");
    await h.handle(GUEST, "/GROUPS");
    expect(h.sent).toEqual([
      [`whatsapp:${GUEST}`, `befehl ${GUEST} /group help`],
      [GUEST, `befehl ${GUEST} /GROUPS`],
    ]);
    expect(h.guestCalls).toEqual([]);
    expect(h.ownerCalls).toEqual([]);
  });
});

test("Gruppenbefehle bleiben dem Besitzer vorbehalten (unverändert)", () => {
  const before = process.env.WHATSAPP_OWNER_NUMBER;
  process.env.WHATSAPP_OWNER_NUMBER = OWNER;
  try {
    expect(handleGroupCommand(GUEST, "/group create Test")).toContain("Nur der Owner");
  } finally {
    if (before === undefined) delete process.env.WHATSAPP_OWNER_NUMBER;
    else process.env.WHATSAPP_OWNER_NUMBER = before;
  }
});
