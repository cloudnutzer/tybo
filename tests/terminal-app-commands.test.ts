/**
 * Issue #61: Slash-Befehle in der Terminal-Anwendung (src/terminal/app.ts) mit
 * nachgebildetem TTY gegen den Test-Server. /stop während einer Antwort,
 * /quit räumt das Terminal auf, /wechsel schließt die alte Live-Verbindung
 * und merkt die Auswahl. Seit Issue #74 gehen Befehle des Bots (/new, /stop,
 * /agent) und unbekannte (/goal, /foo) an den Server; der Befehls-Port ist
 * hier eine Attrappe mit dem echten Register.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ConversationSummary } from "../src/terminal/api";
import { runChatApp, terminalModes } from "../src/terminal/app";
import { FakeStdin, FakeStdout, startTyboServer, waitFor, type TerminalTestServer } from "./terminal-fixture";

let servers: TerminalTestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function start(id: string, options: { pipe?: boolean; env?: Record<string, string> } = {}) {
  const s = await startTyboServer({ manage: true, commands: true });
  servers.push(s);
  const conversation = (await s.client().listConversations()).find(c => c.id === id)!;
  const stdin = new FakeStdin();
  if (options.pipe) stdin.isTTY = false;
  const stdout = new FakeStdout();
  const saved: string[] = [];
  const exit = runChatApp({
    client: s.client(),
    conversation,
    stdin,
    stdout,
    env: options.env ?? {},
    onSignal: () => () => {},
    live: { retryMinMs: 100, retryMaxMs: 200 },
    tickMs: 50,
    onSwitch: (c: ConversationSummary) => {
      saved.push(c.id);
    },
  });
  await waitFor(() => s.server.eventStreamCount() >= 1, 3000, "Live-Verbindung");
  return { s, stdin, stdout, exit, saved };
}

describe("Befehle im Vollmodus", () => {
  test("/stop während einer Antwort stoppt sofort, statt zu warten", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443");
    stdin.type("Lange Frage\r");
    await s.telegramChat.turn("topic-443");
    await waitFor(() => stdout.text.includes("Denkt nach"), 3000, "Statuszeile");
    stdin.type("/stop\r");
    await waitFor(() => s.telegramChat.stops.includes("topic-443"), 3000, "Stopp");
    expect(stdout.text).not.toContain("Es läuft noch eine Antwort");
    // Der Server hat /stop als Befehl ausgeführt, nicht als Nachricht an Claude
    expect(s.commandRuns.map(r => [r.text, r.source])).toEqual([["/stop", "terminal"]]);
    await waitFor(() => stdout.text.includes("gestoppt"), 3000, "Meldung");
    expect(s.telegramChat.calls).toHaveLength(1);
    stdin.type("\u0004");
    expect(await exit).toBe(0);
  });

  test("/goal pause und alle Stopp-Aliase gehen während einer Antwort sofort raus (Issue #76)", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443");
    stdin.type("Lange Frage\r");
    await s.telegramChat.turn("topic-443");
    await waitFor(() => stdout.text.includes("Denkt nach"), 3000, "Statuszeile");
    const urgent = ["/goal pause", "/goal stop", "/goal cancel", "/goal done", "/goal abbrechen", "/abbruch"];
    for (const text of urgent) {
      stdin.type(`${text}\r`);
      await waitFor(() => s.commandRuns.some(r => r.text === text), 3000, text);
    }
    expect(stdout.text).not.toContain("Es läuft noch eine Antwort");
    expect(s.commandRuns.map(r => r.text)).toEqual(urgent);
    expect(s.telegramChat.calls).toHaveLength(1);
    stdin.type("\u0004");
    await exit;
  });

  test("Nachricht während einer Antwort bleibt gesperrt, Befehle nicht", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443");
    stdin.type("Erste\r");
    await s.telegramChat.turn("topic-443");
    await waitFor(() => stdout.text.includes("Denkt nach"), 3000, "Statuszeile");
    stdin.type("Zweite\r");
    await waitFor(() => stdout.text.includes("Es läuft noch eine Antwort"), 3000, "Sperre");
    stdin.type("\u0015/gespraeche\r");
    await waitFor(() => stdout.text.includes("Gespräche\n"), 3000, "Liste");
    expect(s.telegramChat.calls).toHaveLength(1);
    s.telegramChat.finish("topic-443", "ok");
    stdin.type("\u0004");
    await exit;
  });

  test("/quit beendet und räumt das Terminal auf", async () => {
    const { stdin, stdout, exit } = await start("dm");
    expect(terminalModes.rawMode).toBe(true);
    stdin.type("/quit\r");
    expect(await exit).toBe(0);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdout.all).toContain("\u001b[?2004l");
    expect(terminalModes).toEqual({ rawMode: false, bracketedPaste: false });
  });

  test("unbekannter Befehl geht als Text an den Bot (Issue #74)", async () => {
    const { s, stdin, exit } = await start("topic-443");
    // /goal ist seit Issue #76 ein Befehl; /memory gibt es nur in Telegram
    stdin.type("/memory Umsatz verdoppeln\r");
    const turn = await s.telegramChat.turn("topic-443");
    expect(turn.opts.text).toBe("/memory Umsatz verdoppeln");
    expect(s.commandRuns).toHaveLength(0);
    s.telegramChat.finish("topic-443", "ok");
    stdin.type("\u0004");
    await exit;
  });

  test("// schickt eine Nachricht mit Schrägstrich", async () => {
    const { s, stdin, exit } = await start("dm");
    stdin.type("//etc/hosts zeigen\r");
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.text).toBe("/etc/hosts zeigen");
    s.telegramChat.finish("dm", "ok");
    stdin.type("\u0004");
    await exit;
  });

  test("/wechsel: neues Gespräch, alte Live-Verbindung zu, verspätete Nachrichten fallen weg, Auswahl gemerkt", async () => {
    const { s, stdin, stdout, exit, saved } = await start("topic-443");
    stdin.type("/wechsel Finanzen\r");
    await waitFor(() => stdout.text.includes("tybo · Finanzen · Agent Finance"), 3000, "Kopfzeile");
    await waitFor(() => saved.length === 1, 3000, "gemerkt");
    expect(saved).toEqual(["topic-12"]);
    await waitFor(() => s.server.eventStreamCount() === 1, 3000, "nur noch eine Live-Verbindung");
    // Nachricht im alten Topic erscheint nicht mehr, im neuen schon
    s.receiveFromTelegram("topic-443", "user", "Altes Topic spricht");
    s.receiveFromTelegram("topic-12", "user", "Neues Topic spricht");
    await waitFor(() => stdout.text.includes("Neues Topic spricht"), 3000, "Live im neuen Topic");
    expect(stdout.text).not.toContain("Altes Topic spricht");
    // Nachrichten gehen jetzt ins neue Gespräch
    stdin.type("Frage an Finanzen\r");
    const turn = await s.telegramChat.turn("topic-12");
    expect(turn.opts.text).toBe("Frage an Finanzen");
    s.telegramChat.finish("topic-12", "ok");
    stdin.type("\u0004");
    await exit;
  });

  test("/wechsel bei doppelten Namen: Fehler, kein Wechsel", async () => {
    const { s, stdin, stdout, exit, saved } = await start("topic-443");
    s.telegram.upsertTopic(13, { title: "Finanzen", agent: "general" });
    stdin.type("/wechsel Finanzen\r");
    await waitFor(() => stdout.text.includes("Mehrere Gespräche heißen"), 3000, "Fehler");
    expect(saved).toEqual([]);
    stdin.type("\u0015\u0004");
    await exit;
  });

  test("/neu legt ein Topic an und wechselt hinein", async () => {
    const { s, stdin, stdout, exit, saved } = await start("dm");
    stdin.type("/neu research Marktstudie\r");
    await waitFor(() => stdout.text.includes("tybo · Marktstudie · Agent Research"), 3000, "Kopfzeile");
    expect(stdout.text).toContain("Neues Gespräch mit Research, auch als Topic in Telegram.");
    await waitFor(() => saved.length === 1, 3000, "gemerkt");
    expect(saved[0]).toMatch(/^topic-\d+$/);
    expect((await s.client().listConversations()).find(c => c.id === saved[0])).toMatchObject({ title: "Marktstudie", agent: "research" });
    stdin.type("\u0004");
    await exit;
  });

  test("/new führt der Server aus, die Antwort erscheint als Meldung; Verlauf bleibt", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443");
    const before = (await s.client().messages("topic-443")).messages.length;
    stdin.type("/new\r");
    await waitFor(() => stdout.text.includes("new ausgeführt"), 10_000, "Meldung");
    expect(stdout.text).toContain("Meldung von befehl");
    expect(s.commandRuns.map(r => [r.conversationId, r.text, r.source])).toEqual([["topic-443", "/new", "terminal"]]);
    expect(s.telegramChat.calls).toHaveLength(0);
    // Nichts läuft danach weiter: die nächste Nachricht geht sofort raus
    stdin.type("Weiter\r");
    await s.telegramChat.turn("topic-443");
    s.telegramChat.finish("topic-443", "ok");
    // Die Attrappe des Telegram-Verlaufs speichert nichts: der Verlauf ist unverändert
    expect((await s.client().messages("topic-443")).messages.length).toBe(before);
    stdin.type("\u0004");
    await exit;
  }, 30_000); // echter Kindprozess, unter Last über 5 s

  test("/agent geht an den Server (Bedeutung wie in Telegram), /zuordnen ändert den Agenten", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443");
    stdin.type("/agent research: kürzer\r");
    await waitFor(() => stdout.text.includes("agent ausgeführt"), 3000, "Meldung");
    expect(s.commandRuns.map(r => r.text)).toEqual(["/agent research: kürzer"]);
    stdin.type("/zuordnen finance\r");
    await waitFor(() => stdout.text.includes("ist jetzt Finance"), 3000, "Hinweis");
    expect((await s.client().listConversations()).find(c => c.id === "topic-443")!.agent).toBe("finance");
    stdin.type("\u0004");
    await exit;
  });

  test("/tasten zeigt Tasten und Befehle lokal, ohne den Server", async () => {
    const { s, stdin, stdout, exit } = await start("dm");
    stdin.type("/tasten\r");
    await waitFor(() => stdout.text.includes("/wechsel <Nr. oder Name>"), 3000, "Hilfe");
    expect(stdout.text).toContain("Tab                Befehl");
    expect(s.commandRuns).toEqual([]);
    stdin.type("\u0004");
    await exit;
  });

  test("/help führt der Server aus wie in Telegram (Issue #74)", async () => {
    const { s, stdin, stdout, exit } = await start("dm");
    stdin.type("/help\r");
    await waitFor(() => stdout.text.includes("help ausgeführt"), 3000, "Meldung");
    expect(s.commandRuns.map(r => [r.conversationId, r.text, r.source])).toEqual([["dm", "/help", "terminal"]]);
    expect(stdout.text).not.toContain("Tasten im Chat:");
    stdin.type("\u0004");
    await exit;
  });
});

describe("Tab im Vollmodus", () => {
  test("ergänzt Befehl und Gesprächsnamen, Enter wechselt", async () => {
    const { s, stdin, stdout, exit, saved } = await start("dm");
    // Namen werden beim Start im Hintergrund geladen
    await new Promise(r => setTimeout(r, 100));
    stdin.type("/wec");
    stdin.type("\t");
    await waitFor(() => stdout.text.endsWith("› /wechsel "), 3000, "Befehl ergänzt");
    stdin.type("Rech");
    stdin.type("\t");
    await waitFor(() => stdout.text.endsWith("› /wechsel Recherche"), 3000, "Name ergänzt");
    stdin.type("\r");
    await waitFor(() => saved.length === 1, 3000, "gewechselt");
    expect(saved).toEqual(["topic-443"]);
    expect(s.telegramChat.calls).toHaveLength(0);
    stdin.type("\u0004");
    await exit;
  });

  test("Befehl des Bots aus GET /api/commands: Tab ergänzt, Enter schickt ihn als Nachricht an den Server (Issue #77)", async () => {
    const { s, stdin, stdout, exit } = await start("dm");
    await new Promise(r => setTimeout(r, 100));
    stdin.type("/hel");
    stdin.type("\t");
    await waitFor(() => stdout.text.endsWith("› /help "), 3000, "Befehl des Bots ergänzt");
    stdin.type("\r");
    await waitFor(() => stdout.text.includes("help ausgeführt"), 3000, "Meldung");
    expect(s.commandRuns.map(r => [r.conversationId, r.text.trim(), r.source])).toEqual([["dm", "/help", "terminal"]]);
    // Kein lokaler Spickzettel: /help bleibt Befehl des Servers
    expect(stdout.text).not.toContain("Tasten im Chat:");
    expect(s.telegramChat.calls).toHaveLength(0);
    stdin.type("\u0004");
    await exit;
  });

  test("mehrere Treffer werden gezeigt", async () => {
    const { stdin, stdout, exit } = await start("dm");
    await new Promise(r => setTimeout(r, 100));
    stdin.type("/ne");
    stdin.type("\t");
    await waitFor(() => stdout.text.includes("neu   new"), 3000, "Auswahl");
    stdin.type("\u0015\u0004");
    await exit;
  });

  test("eingefügter Tab (Bracketed Paste) löst keine Ergänzung aus und geht als Text mit", async () => {
    const { s, stdin, stdout, exit } = await start("dm");
    stdin.type("\u001b[200~Spalte1\tSpalte2\u001b[201~\r");
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.text).toBe("Spalte1\tSpalte2");
    s.telegramChat.finish("dm", "ok");
    stdin.type("\u001b[200~/wec\t\u001b[201~");
    // Tab als Text (angezeigt als Leerzeichen), nicht zu /wechsel ergänzt
    await waitFor(() => stdout.text.endsWith("› /wec    "), 3000, "Einfügung");
    expect(stdout.text).not.toContain("/wechsel");
    stdin.type("\u0015\u0004");
    await exit;
  });
});

describe("Befehle aus einer Pipe", () => {
  test("Reihenfolge bleibt: /wechsel, dann Nachricht ins neue Gespräch", async () => {
    const { s, stdin, stdout, exit } = await start("dm", { pipe: true });
    stdin.emit("data", Buffer.from("/wechsel Strategie\nFrage zur Strategie\n"));
    stdin.emit("end");
    const turn = await s.telegramChat.turn("topic-31");
    expect(turn.opts.text).toBe("Frage zur Strategie");
    s.telegramChat.finish("topic-31", "Antwort");
    expect(await exit).toBe(0);
    expect(stdout.all).not.toContain("\u001b");
    expect(s.telegramChat.calls.map(c => c.conversationId)).toEqual(["topic-31"]);
  });

  test("unbekannter Befehl aus einer Pipe geht als Text an den Bot", async () => {
    const { s, stdin, exit } = await start("dm", { pipe: true });
    stdin.emit("data", Buffer.from("/gibtsnicht\n"));
    stdin.emit("end");
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.text).toBe("/gibtsnicht");
    s.telegramChat.finish("dm", "ok");
    expect(await exit).toBe(0);
  });

  test("/new aus einer Pipe: Befehl, danach endet tybo", async () => {
    const { s, stdin, stdout, exit } = await start("dm", { pipe: true });
    stdin.emit("data", Buffer.from("/new\n"));
    stdin.emit("end");
    expect(await exit).toBe(0);
    expect(s.commandRuns.map(r => r.text)).toEqual(["/new"]);
    expect(stdout.text).toContain("new ausgeführt");
  });
});
