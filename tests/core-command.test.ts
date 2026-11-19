/**
 * Issue #522: /kern in Telegram, Browser und Terminal, Entwurf und Freigabe über
 * das echte Rückfragen-Register. Das Modell ist eine Attrappe, alle Daten sind
 * erfunden. Die Wege gegen echtes PostgreSQL: tests/core-pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChoice, decideChoice, expireChoice, getChoice, listChoices, listOpenChoices, onChoiceDecided, setChoicesFileForTests, type Choice, type ChoiceConversation } from "../src/lib/choices";
import { BUILTIN_COMMANDS, commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { CORE_COMMAND_TEXT } from "../src/lib/commands/core";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { abortExecutions, runExecution } from "../src/lib/execution-context";
import { CORE_MAX_CHARS, coreBackupFile, coreDraftFile, coreFile, coreForPrompt, setCore } from "../src/lib/memory/core";
import { buildCoreDraftPrompt, CORE_ADOPT, CORE_CHOICE_TEXT, CORE_DISCARD, CORE_DRAFT_FACT_CHARS, CORE_STEP_DRAFT, createCoreChoices, retireCoreDrafts, type CoreChoicesDeps } from "../src/lib/memory/core-choices";
import { SECRET_MASK, secretRefusedText } from "../src/lib/memory/secrets";
import type { MemoryItem } from "../src/lib/store/types";
import { createBotCommands } from "../src/web/bot-commands";

const USER = "4711";
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";
const DM: ChoiceConversation = { type: "telegram", chatId: USER };
const DRAFT = "## Wer ich bin\n- Alex, Imkerin in Görlitz";
const fact = (content: string, created_at = "2026-03-15T12:00:00Z"): MemoryItem => ({ type: "fact", content, created_at });

async function telegram(text: string, services: Partial<CommandServices> = {}, where: { chatId: string; topicId?: number } = { chatId: USER }): Promise<string[]> {
  const sent: string[] = [];
  await runTelegramCommand({
    chat: { reply: async t => void sent.push(t) },
    chatId: where.chatId,
    ...(where.topicId !== undefined ? { topicId: where.topicId } : {}),
    sessionKey: `dm:${where.chatId}`,
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

async function webOrTerminal(source: "web" | "terminal", text: string, services: Partial<CommandServices> = {}): Promise<string[]> {
  const unused = () => {
    throw new Error("nicht erwartet");
  };
  const commands = createBotCommands({
    registry: commandRegistry,
    services: services as CommandServices,
    userId: "web",
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
    conversationId: WEB_ID,
    agent: "general",
    text,
    source,
    messageId: "m1",
    receivedAt: new Date().toISOString(),
    signal: new AbortController().signal,
    sink: {} as never,
    notice: async t => void notices.push(t),
    answer: async () => {},
    ask: async () => {},
    endAsk: () => {},
    commit: () => {},
  });
  return notices;
}

describe("/kern", () => {
  const cwd = process.cwd();
  let root = "";
  let silent: ReturnType<typeof spyOn>;
  let notified: string[];
  let sentChoices: Choice[];
  let prompts: string[];
  let stopHandler: () => void;

  const deps = (over: Partial<CoreChoicesDeps> = {}): CoreChoicesDeps => ({
    facts: async () => [fact("Alex ist Imkerin")],
    sendChoice: async choice => (sentChoices.push(choice), { sent: true }),
    notify: async (_conversation, text) => void notified.push(text),
    callAux: async (_purpose, prompt) => (prompts.push(prompt), { text: DRAFT, isError: false }),
    ...over,
  });
  /** Wie im Bot: Handler angemeldet, Entwürfe als Befehls-Dienst */
  const wire = (over: Partial<CoreChoicesDeps> = {}): Partial<CommandServices> => {
    const core = createCoreChoices(deps(over));
    stopHandler = onChoiceDecided("core", core.handler);
    return { core };
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tybo-kern-befehl-")));
    process.chdir(root);
    setChoicesFileForTests(join(root, "data", "choices.json"));
    silent = spyOn(console, "log").mockImplementation(() => {});
    notified = [];
    sentChoices = [];
    prompts = [];
    stopHandler = () => {};
  });

  afterEach(() => {
    stopHandler();
    silent.mockRestore();
    setChoicesFileForTests(null);
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  describe("Geheimnisse (Issue #524)", () => {
    const PASSWORD = "Waldgeheim42";

    test("/kern setzen lehnt ab, nennt die .env und schreibt nichts", async () => {
      expect(await telegram(`/kern setzen Alex, Passwort: ${PASSWORD}`)).toEqual([secretRefusedText()]);
      expect(existsSync(coreFile())).toBe(false);
    });

    test("ein bestehender Kern bleibt, wenn der neue Text abgelehnt wird", async () => {
      await setCore("Alex ist Imkerin");
      await telegram(`/kern setzen Passwort: ${PASSWORD}`);
      expect(readFileSync(coreFile(), "utf8")).toBe("Alex ist Imkerin\n");
    });

    test("Datei von Hand: /kern und Prompt maskieren, die Datei bleibt", async () => {
      mkdirSync(join(root, "config"), { recursive: true });
      const text = `Alex\nPasswort: ${PASSWORD}\n`;
      writeFileSync(coreFile(), text);
      const shown = (await telegram("/kern")).join("\n");
      expect(shown).toContain(`Passwort: ${SECRET_MASK}`);
      expect(shown).not.toContain(PASSWORD);
      expect(await coreForPrompt()).toBe(`Alex\nPasswort: ${SECRET_MASK}`);
      expect(readFileSync(coreFile(), "utf8")).toBe(text);
    });

    test("nennt das Modell trotz Verbot einen Wert: Vorlage und Übernahme tragen nur die Maske", async () => {
      await telegram("/kern entwurf", wire({ callAux: async () => ({ text: `## Wer ich bin\n- Passwort: ${PASSWORD}`, isError: false }) }));
      expect(sentChoices).toHaveLength(1);
      expect(sentChoices[0].text).not.toContain(PASSWORD);
      await decideChoice(sentChoices[0].id, CORE_ADOPT, "web");
      expect(readFileSync(coreFile(), "utf8")).toBe(`## Wer ich bin\n- Passwort: ${SECRET_MASK}\n`);
    });
  });

  test("steht in der Hilfe und in allen Kanälen, Alias /core", () => {
    expect(HELP_TEXT).toContain("/kern");
    const command = BUILTIN_COMMANDS.find(c => c.name === "kern")!;
    expect(command.channels).toEqual(["telegram", "web", "terminal"]);
    expect(commandRegistry.match("/core", "web")?.command.name).toBe("kern");
    expect(commandRegistry.match("/kern setzen Alex", "terminal")?.args).toBe("setzen Alex");
  });

  test("ohne Kern: alle Kanäle sagen es gleich, es entsteht keine Datei", async () => {
    expect(await telegram("/kern")).toEqual([CORE_COMMAND_TEXT.none]);
    expect(await webOrTerminal("web", "/kern")).toEqual([CORE_COMMAND_TEXT.none]);
    expect(await webOrTerminal("terminal", "/kern")).toEqual([CORE_COMMAND_TEXT.none]);
    expect(existsSync(coreFile())).toBe(false);
  });

  test("setzen wirkt in allen Kanälen und überall sichtbar, mehrzeilig", async () => {
    expect(await telegram("/kern setzen Alex\n- Imkerin")).toEqual([CORE_COMMAND_TEXT.saved(14)]);
    expect(await coreForPrompt()).toBe("Alex\n- Imkerin");
    expect((await webOrTerminal("web", "/kern"))[0]).toContain("Alex\n- Imkerin");
    expect(await webOrTerminal("web", "/kern setzen Mia")).toEqual([CORE_COMMAND_TEXT.saved(3)]);
    expect(await webOrTerminal("terminal", "/kern aendern Sam")).toEqual([CORE_COMMAND_TEXT.saved(3)]);
    expect((await telegram("/kern"))[0]).toContain("Sam");
    expect(await telegram("/kern setzen Sam")).toEqual([CORE_COMMAND_TEXT.unchanged]);
  });

  test("zu langer Text wird abgelehnt, nicht gekürzt; der alte Kern bleibt", async () => {
    await telegram("/kern setzen Alex");
    expect(await telegram(`/kern setzen ${"x".repeat(CORE_MAX_CHARS + 1)}`)).toEqual([CORE_COMMAND_TEXT.tooLong(CORE_MAX_CHARS + 1)]);
    expect(await coreForPrompt()).toBe("Alex");
  });

  test("ungültige Aufrufe ändern nichts", async () => {
    await telegram("/kern setzen Alex");
    for (const text of ["/kern setzen", "/kern quatsch", "/kern entwurf jetzt", "/kern loeschen sofort"]) {
      expect(await telegram(text)).toEqual([CORE_COMMAND_TEXT.usage]);
    }
    expect(await coreForPrompt()).toBe("Alex");
  });

  test("löschen: danach wie ohne Kern, letzte Fassung gesichert; auch mit Umlaut", async () => {
    expect(await telegram("/kern loeschen")).toEqual([CORE_COMMAND_TEXT.noneToDelete]);
    await telegram("/kern setzen Alex");
    expect(await telegram("/kern löschen")).toEqual([CORE_COMMAND_TEXT.deleted]);
    expect(await coreForPrompt()).toBe("");
    expect(readFileSync(coreBackupFile(), "utf-8")).toBe("Alex\n");
  });

  test("nicht lesbare Datei: Anzeige und Änderung melden es, nichts wird überschrieben", async () => {
    mkdirSync(coreFile(), { recursive: true });
    const services = wire();
    expect(await telegram("/kern")).toEqual([CORE_COMMAND_TEXT.unreadable]);
    expect(await telegram("/kern setzen Alex")).toEqual([CORE_COMMAND_TEXT.unreadable]);
    expect(await telegram("/kern loeschen")).toEqual([CORE_COMMAND_TEXT.unreadable]);
    expect(await telegram("/kern entwurf", services)).toEqual([CORE_COMMAND_TEXT.working, CORE_COMMAND_TEXT.draft.core_unreadable]);
    expect(prompts).toEqual([]);
  });

  test("Stopp vor dem Schreiben im Browser: nichts geändert", async () => {
    const commands = createBotCommands({
      registry: commandRegistry,
      services: {} as CommandServices,
      userId: "web",
      groupId: () => null,
      agentForTopic: () => undefined,
      sendPlain: async () => undefined as never,
      sendAndRecord: async () => undefined as never,
      saveMessage: async () => true,
      resetConversation: async () => undefined as never,
      runStreamingTurn: async () => undefined as never,
      processIntents: async () => undefined as never,
      sendAsAgent: async () => undefined as never,
      log: () => {},
    });
    const stopped = new AbortController();
    stopped.abort();
    const run = commands.run({
      conversationId: WEB_ID,
      agent: "general",
      text: "/kern setzen Alex",
      source: "web",
      messageId: "m1",
      receivedAt: new Date().toISOString(),
      signal: stopped.signal,
      sink: {} as never,
      notice: async () => {},
      answer: async () => {},
      ask: async () => {},
      endAsk: () => {},
      commit: () => {},
    });
    await run.catch(() => {});
    expect(existsSync(coreFile())).toBe(false);
  });

  describe("Entwurf", () => {
    test("ohne Rückfragen-Dienst gibt es keinen Entwurf", async () => {
      expect(await telegram("/kern entwurf")).toEqual([CORE_COMMAND_TEXT.draftUnavailable]);
    });

    test("wird vorgelegt, ist vor der Zustimmung unwirksam und steht wörtlich in der Frage", async () => {
      const replies = await telegram("/kern entwurf", wire());
      expect(replies).toEqual([CORE_COMMAND_TEXT.working, CORE_COMMAND_TEXT.draft.offered]);
      expect(await coreForPrompt()).toBe("");
      expect(existsSync(coreFile())).toBe(false);
      const [choice] = sentChoices;
      expect(choice.kind).toBe("core");
      expect(choice.action).toBe(CORE_STEP_DRAFT);
      expect(choice.conversation).toEqual(DM);
      expect(choice.text).toContain(DRAFT);
      expect(choice.options.map(o => o.key)).toEqual([CORE_ADOPT, CORE_DISCARD]);
      expect((await listOpenChoices(DM)).map(c => c.id)).toEqual([choice.id]);
    });

    test("Übernehmen: genau der vorgelegte Text ist der Kern, die Antwort kommt im Gespräch", async () => {
      await telegram("/kern entwurf", wire());
      const outcome = await decideChoice(sentChoices[0].id, CORE_ADOPT, "telegram");
      expect(outcome.status).toBe("decided");
      expect(await coreForPrompt()).toBe(DRAFT);
      expect(notified).toEqual([CORE_CHOICE_TEXT.adopted(DRAFT.length)]);
      expect(existsSync(coreDraftFile())).toBe(false);
    });

    test("Ablehnen: Kern bleibt, Entwurf weg", async () => {
      await telegram("/kern setzen Alex");
      await telegram("/kern entwurf", wire());
      await decideChoice(sentChoices[0].id, CORE_DISCARD, "web");
      expect(await coreForPrompt()).toBe("Alex");
      expect(notified).toEqual([CORE_CHOICE_TEXT.discarded]);
      expect(existsSync(coreDraftFile())).toBe(false);
    });

    test("Doppelklick, auch aus zwei Kanälen: wirkt einmal, die erste Entscheidung gilt", async () => {
      await telegram("/kern entwurf", wire());
      const id = sentChoices[0].id;
      const [first, second] = await Promise.all([decideChoice(id, CORE_ADOPT, "telegram"), decideChoice(id, CORE_DISCARD, "web")]);
      const outcomes = [first.status, second.status].sort();
      expect(outcomes).toEqual(["already", "decided"]);
      expect(notified.length).toBe(1);
      const third = await decideChoice(id, CORE_ADOPT, "terminal");
      expect(third.status).toBe("already");
      expect(notified.length).toBe(1);
    });

    test("ein neuer Entwurf lässt den älteren ablaufen: dessen Knopf ändert nichts", async () => {
      let n = 0;
      const services = wire({ callAux: async () => ({ text: `Entwurf ${++n}`, isError: false }) });
      await telegram("/kern entwurf", services);
      await telegram("/kern entwurf", services);
      const [old, fresh] = sentChoices;
      expect((await getChoice(old.id))?.state).toBe("expired");
      expect((await decideChoice(old.id, CORE_ADOPT, "web")).status).toBe("expired");
      expect(await coreForPrompt()).toBe("");
      expect(notified).toEqual([]);
      await decideChoice(fresh.id, CORE_ADOPT, "web");
      expect(await coreForPrompt()).toBe("Entwurf 2");
    });

    test("setzen und löschen ziehen offene Entwürfe zurück", async () => {
      const services = wire();
      await telegram("/kern entwurf", services);
      await telegram("/kern setzen Alex");
      expect((await getChoice(sentChoices[0].id))?.state).toBe("expired");
      expect((await decideChoice(sentChoices[0].id, CORE_ADOPT, "web")).status).toBe("expired");
      expect(await coreForPrompt()).toBe("Alex");
      expect(existsSync(coreDraftFile())).toBe(false);

      await telegram("/kern entwurf", services);
      await telegram("/kern loeschen");
      expect((await getChoice(sentChoices[1].id))?.state).toBe("expired");
      expect(await coreForPrompt()).toBe("");
    });

    test("überholt durch eine Änderung von Hand: nichts übernommen, die Antwort sagt es", async () => {
      await telegram("/kern setzen Stand A");
      await telegram("/kern entwurf", wire());
      writeFileSync(coreFile(), "Von Hand\n");
      await decideChoice(sentChoices[0].id, CORE_ADOPT, "telegram");
      expect(await coreForPrompt()).toBe("Von Hand");
      expect(notified).toEqual([CORE_CHOICE_TEXT.stale]);
    });

    test("Änderung während das Modell schreibt: der Entwurf beruht auf dem alten Stand", async () => {
      await telegram("/kern setzen Stand A");
      const services = wire({
        callAux: async () => {
          writeFileSync(coreFile(), "Stand B\n");
          return { text: DRAFT, isError: false };
        },
      });
      await telegram("/kern entwurf", services);
      await decideChoice(sentChoices[0].id, CORE_ADOPT, "web");
      expect(await coreForPrompt()).toBe("Stand B");
      expect(notified).toEqual([CORE_CHOICE_TEXT.stale]);
    });

    test("verlorene Ablage: der Knopf meldet überholt, statt etwas anderes zu übernehmen", async () => {
      await telegram("/kern setzen Alex");
      await telegram("/kern entwurf", wire());
      rmSync(coreDraftFile());
      await decideChoice(sentChoices[0].id, CORE_ADOPT, "web");
      expect(await coreForPrompt()).toBe("Alex");
      expect(notified).toEqual([CORE_CHOICE_TEXT.overtaken]);
    });

    test("Lesefehler bei den Fakten ist kein leerer Ersatzkern", async () => {
      await telegram("/kern setzen Alex");
      const replies = await telegram("/kern entwurf", wire({ facts: async () => { throw new Error("Datenbank weg"); } }));
      expect(replies.at(-1)).toBe(CORE_COMMAND_TEXT.draft.facts_unreadable);
      expect(prompts).toEqual([]);
      expect(sentChoices).toEqual([]);
      expect(await coreForPrompt()).toBe("Alex");
      expect(existsSync(coreDraftFile())).toBe(false);
    });

    test("keine Fakten, nur Ziele oder leere Einträge: kein Modellaufruf, keine Frage", async () => {
      const replies = await telegram("/kern entwurf", wire({ facts: async () => [{ type: "goal", content: "Mehr lesen" }, fact("   ")] }));
      expect(replies.at(-1)).toBe(CORE_COMMAND_TEXT.draft.no_facts);
      expect(prompts).toEqual([]);
      expect(await listChoices()).toEqual([]);
    });

    test("Modell scheitert oder liefert nichts: keine Frage", async () => {
      for (const result of [{ text: "kaputt", isError: true }, { text: "   ", isError: false }]) {
        stopHandler();
        const replies = await telegram("/kern entwurf", wire({ callAux: async () => result }));
        expect(replies.at(-1)).toBe(CORE_COMMAND_TEXT.draft.model_failed);
      }
      expect(await listChoices()).toEqual([]);
      expect(existsSync(coreDraftFile())).toBe(false);
    });

    test.each(["telegram", "web", "terminal"] as const)("Modell gesperrt: %s nennt Profilzeit, kein Entwurf oder Neuversuch", async channel => {
      const previousZone = process.env.USER_TIMEZONE;
      process.env.USER_TIMEZONE = "Asia/Tokyo";
      let calls = 0;
      const services = wire({ callAux: async () => {
        calls++;
        return { text: "", isError: true, disabled: true, blockedUntil: "2099-01-02T23:15:00Z" };
      } });
      try {
        const replies = channel === "telegram" ? await telegram("/kern entwurf", services)
          : await webOrTerminal(channel, "/kern entwurf", services);
        expect(replies.at(-1)).toBe(CORE_COMMAND_TEXT.blocked("Sa, 03.01., 08:15"));
        expect(calls).toBe(1);
        expect(sentChoices).toEqual([]);
        expect(await listChoices()).toEqual([]);
        expect(existsSync(coreDraftFile())).toBe(false);
      } finally {
        if (previousZone === undefined) delete process.env.USER_TIMEZONE;
        else process.env.USER_TIMEZONE = previousZone;
      }
    });

    test("zu lange Modellantwort wird an einer Zeilengrenze begrenzt, die Frage zeigt das Ergebnis", async () => {
      const line = `- ${"y".repeat(98)}`;
      const long = Array.from({ length: 40 }, () => line).join("\n");
      await telegram("/kern entwurf", wire({ callAux: async () => ({ text: long, isError: false }) }));
      await decideChoice(sentChoices[0].id, CORE_ADOPT, "web");
      const core = await coreForPrompt();
      expect(core.length).toBeLessThanOrEqual(CORE_MAX_CHARS);
      expect(sentChoices[0].text.endsWith(core)).toBe(true);
    });

    test("nirgends zugestellt: Frage abgelaufen, Entwurf weg, ehrliche Antwort", async () => {
      const replies = await telegram("/kern entwurf", wire({ sendChoice: async () => ({ sent: false }) }));
      expect(replies.at(-1)).toBe(CORE_COMMAND_TEXT.draft.not_delivered);
      expect(await listOpenChoices(DM)).toEqual([]);
      expect(existsSync(coreDraftFile())).toBe(false);
    });

    test("reines Web-Gespräch: Frage im Gespräch selbst, Kopie über sendChoice scheitert unschädlich", async () => {
      const posted: unknown[] = [];
      const core = createCoreChoices(deps({
        postWeb: async (id, post) => (posted.push({ id, source: post.source, choiceId: post.choiceId }), true),
        sendChoice: async () => { throw new Error("kein Telegram"); },
      }));
      expect(await core.offerDraft({ type: "web", conversationId: WEB_ID })).toBe("offered");
      const [choice] = await listChoices();
      expect(posted).toEqual([{ id: WEB_ID, source: "gedaechtnis", choiceId: choice.id }]);
    });

    test("Stopp während das Modell schreibt: nichts vorgelegt", async () => {
      const core = createCoreChoices(deps({
        callAux: async () => {
          abortExecutions("kern-stopp");
          return { text: DRAFT, isError: false };
        },
      }));
      await expect(runExecution("kern-stopp", "general", () => core.offerDraft(DM))).rejects.toThrow("abgebrochen");
      expect(await listChoices()).toEqual([]);
      expect(existsSync(coreDraftFile())).toBe(false);
    });

    test("Ablage scheitert unerwartet: Fehlertext statt Absturz, Kern unverändert", async () => {
      await telegram("/kern setzen Alex");
      const replies = await telegram("/kern entwurf", wire({ createChoice: async () => { throw new TypeError("Register weg"); } }));
      expect(replies.at(-1)).toBe(CORE_COMMAND_TEXT.failed);
      expect(await coreForPrompt()).toBe("Alex");
    });

    test("Texte von Kern und Entwurf kommen nicht ins Log", async () => {
      await telegram("/kern entwurf", wire({ sendChoice: async () => { throw new Error("Versand weg"); } }));
      expect(silent.mock.calls.flat().join("\n")).not.toContain("Imkerin");
    });

    test("retireCoreDrafts übersteht ein nicht lesbares Register und meldet nur die Fehlerklasse", async () => {
      const lines: string[] = [];
      await retireCoreDrafts({ listChoices: async () => { throw new TypeError("privat"); }, log: line => void lines.push(line) });
      expect(lines).toEqual(["[kern] Offene Entwürfe nicht abgeräumt (TypeError)"]);
    });
  });

  describe("Aufräumen, während ein anderes Gespräch einen Entwurf anlegt", () => {
    const OTHER: ChoiceConversation = { type: "telegram", chatId: "-1001234567890", topicId: 7 };

    /** Offene alte Frage, danach ein geänderter Kern: Das Aufräumen steht an, der neue Entwurf beruht schon auf dem neuen Stand */
    async function oldQuestion(over: Partial<CoreChoicesDeps> = {}) {
      let n = 0;
      const services = wire({ callAux: async () => ({ text: `Entwurf ${++n}`, isError: false }), ...over });
      await telegram("/kern entwurf", services);
      expect(await setCore("Alex")).toBe("saved");
      return services.core!;
    }

    /** Die alte Frage ist weg, die neue offen, und ihr Knopf übernimmt genau ihren Text */
    async function freshQuestionWorks() {
      const [old, fresh] = sentChoices;
      expect(fresh.conversation).toEqual(OTHER);
      expect((await getChoice(old.id))?.state).toBe("expired");
      expect((await getChoice(fresh.id))?.state).toBe("open");
      expect((await decideChoice(fresh.id, CORE_ADOPT, "telegram")).status).toBe("decided");
      expect(notified).toEqual([CORE_CHOICE_TEXT.adopted("Entwurf 2".length)]);
      expect(await coreForPrompt()).toBe("Entwurf 2");
    }

    test("neuer Entwurf zwischen dem Lesen der Fragen und dem Ablauf bleibt gültig", async () => {
      const core = await oldQuestion();
      await retireCoreDrafts({
        listChoices: async () => {
          const listed = await listChoices();
          expect(await core.offerDraft(OTHER)).toBe("offered");
          return listed;
        },
      });
      await freshQuestionWorks();
    });

    test("neuer Entwurf zwischen dem Ablauf und dem Entfernen der Ablage bleibt gültig", async () => {
      const core = await oldQuestion();
      await retireCoreDrafts({
        expireChoice: async id => {
          const outcome = await expireChoice(id);
          expect(await core.offerDraft(OTHER)).toBe("offered");
          return outcome;
        },
      });
      await freshQuestionWorks();
    });

    test("Aufräumen zwischen dem Ablegen des neuen Entwurfs und seiner Frage lässt ihn stehen", async () => {
      let interleave = false;
      const core = await oldQuestion({
        createChoice: async (input, options) => {
          if (interleave) await retireCoreDrafts();
          return createChoice(input, options);
        },
      });
      interleave = true;
      expect(await core.offerDraft(OTHER)).toBe("offered");
      await freshQuestionWorks();
    });

    test("ohne neuen Entwurf entfernt das Aufräumen die Ablage der abgelaufenen Frage", async () => {
      await oldQuestion();
      await retireCoreDrafts();
      expect((await getChoice(sentChoices[0].id))?.state).toBe("expired");
      expect(existsSync(coreDraftFile())).toBe(false);
    });
  });

  describe("Zwei Gespräche legen gleichzeitig einen Entwurf an", () => {
    const OTHER: ChoiceConversation = { type: "telegram", chatId: "-1001234567890", topicId: 7 };
    const draftOnFile = () => JSON.parse(readFileSync(coreDraftFile(), "utf-8")).text as string;

    /**
     * A hat seinen Entwurf abgelegt und hält vor seiner Frage an. B läuft erst los,
     * wenn A dort steht, und kommt bis hinter sein Modell. Ohne gemeinsame Sperre
     * legte B jetzt Entwurf und Frage an, und As Frage ließe beide unbrauchbar zurück.
     */
    function raceFromBeforeQuestion() {
      const asked: ChoiceConversation[] = [];
      let n = 0;
      let release = () => {};
      let reachedQuestion = () => {};
      let modelDone = () => {};
      const held = new Promise<void>(resolve => (release = resolve));
      const aAtQuestion = new Promise<void>(resolve => (reachedQuestion = resolve));
      const bPastModel = new Promise<void>(resolve => (modelDone = resolve));
      const services = wire({
        callAux: async () => {
          const text = `Entwurf ${++n}`;
          if (n === 2) modelDone();
          return { text, isError: false };
        },
        createChoice: async (input, options) => {
          asked.push(input.conversation);
          if (input.conversation === DM) {
            reachedQuestion();
            await held;
          }
          return createChoice(input, options);
        },
      });
      return { core: services.core!, asked, release, aAtQuestion, bPastModel };
    }

    test("A hält vor seiner Frage: B wartet, danach ist Bs Vorschlag übernehmbar", async () => {
      const { core, asked, release, aAtQuestion, bPastModel } = raceFromBeforeQuestion();
      const a = core.offerDraft(DM);
      await aAtQuestion;
      const b = core.offerDraft(OTHER);
      await bPastModel;
      await Bun.sleep(150);
      const whileHeld = { asked: [...asked], draft: draftOnFile() };
      release();
      expect(await Promise.all([a, b])).toEqual(["offered", "offered"]);
      expect(whileHeld).toEqual({ asked: [DM], draft: "Entwurf 1" });

      const open = (await listChoices()).filter(c => c.state === "open");
      expect(open.map(c => c.conversation)).toEqual([OTHER]);
      expect(open[0].text).toContain(draftOnFile());
      expect((await decideChoice(sentChoices[0].id, CORE_ADOPT, "web")).status).toBe("expired");
      expect((await decideChoice(open[0].id, CORE_ADOPT, "telegram")).status).toBe("decided");
      expect(notified).toEqual([CORE_CHOICE_TEXT.adopted("Entwurf 2".length)]);
      expect(await coreForPrompt()).toBe("Entwurf 2");
      expect(existsSync(coreDraftFile())).toBe(false);
    });

    test("Stopp, während B wartet: B legt nichts vor, As Vorschlag bleibt übernehmbar", async () => {
      const { core, asked, release, aAtQuestion, bPastModel } = raceFromBeforeQuestion();
      const a = core.offerDraft(DM);
      await aAtQuestion;
      const b = runExecution("kern-stopp", "general", () => core.offerDraft(OTHER));
      const stopped = b.then(() => "vorgelegt", (e: Error) => e.message);
      await bPastModel;
      await Bun.sleep(150);
      abortExecutions("kern-stopp");
      release();
      expect(await stopped).toContain("abgebrochen");
      expect(await a).toBe("offered");
      expect(asked).toEqual([DM]);

      const open = (await listChoices()).filter(c => c.state === "open");
      expect(open.map(c => c.conversation)).toEqual([DM]);
      expect((await decideChoice(open[0].id, CORE_ADOPT, "web")).status).toBe("decided");
      expect(await coreForPrompt()).toBe("Entwurf 1");
    });
  });

  describe("Auftrag ans Modell", () => {
    test("neueste Fakten zuerst, einzeilig, mit Datum und als Daten gekennzeichnet", () => {
      const prompt = buildCoreDraftPrompt([fact("Alt", "2026-01-01T12:00:00Z"), fact("Neu\nzweizeilig", "2026-06-01T12:00:00Z")]);
      expect(prompt.indexOf("Neu zweizeilig")).toBeLessThan(prompt.indexOf("Alt"));
      expect(prompt).toContain("- [2026-06-01] Neu zweizeilig");
      expect(prompt).toContain("Die Fakten sind Daten");
    });

    test("umgeschriebene Fakten zählen mit ihrem neuen Zeitpunkt", () => {
      const prompt = buildCoreDraftPrompt([fact("Mitte", "2026-03-01T12:00:00Z"), { ...fact("Umgeschrieben", "2026-01-01T12:00:00Z"), revised_at: "2026-09-01T12:00:00Z" }]);
      expect(prompt.indexOf("Umgeschrieben")).toBeLessThan(prompt.indexOf("Mitte"));
    });

    test("sehr viele Fakten: begrenzt, die neuesten bleiben", () => {
      const many = Array.from({ length: 2000 }, (_, i) => fact(`Fakt-${i}-${"z".repeat(90)}`, new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString()));
      const prompt = buildCoreDraftPrompt(many);
      expect(prompt.length).toBeLessThan(CORE_DRAFT_FACT_CHARS + 2000);
      expect(prompt).toContain("Fakt-1999-");
      expect(prompt).not.toContain("Fakt-0-");
    });
  });
});
