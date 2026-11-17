/**
 * Issue #524: tybo gedaechtnis geheimnisse auf der Datei, mit echtem Rückfragen-Register,
 * echtem Handler und echter Telegram-Kette für den fremden Klick. Ersetzt ist nur der
 * Versand. Dasselbe gegen PostgreSQL: memory-secrets-pg.test.ts. Alle Werte sind erfunden.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Composer, Context } from "grammy";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTybo } from "../scripts/tybo";
import { createChoice, decideChoice, expireChoice, getChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { updateJsonState } from "../src/lib/json-state";
import { getMemoryContext } from "../src/lib/memory";
import {
  createSecretChoices,
  factStamp,
  offerSecretFacts,
  readSecretDecisions,
  SECRET_KEYS,
  SECRET_QUESTIONS_MAX,
  SECRET_TEXT,
  secretDecisionsFile,
  secretQuestion,
} from "../src/lib/memory/secret-review";
import { SECRET_MASK } from "../src/lib/memory/secrets";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import { getStore, resetStore } from "../src/lib/store";
import { createTelegramChoices } from "../src/lib/telegram-choices";

const FILE = process.env.MEMORY_FILE_PATH!;
const OWNER = "4711";
const STRANGER = "666";
const PASSWORD = "Waldgeheim42";
const SECRET_FACT = `Seite imker.example, Passwort: ${PASSWORD}`;
const DM = { type: "telegram" as const, chatId: OWNER };


let root = "";
let out: string[];
let errs: string[];
let sends: SendAndRecordInput[];
let notices: string[];
let logs: string[];
let stopHandler: () => void;
const restores: (() => void)[] = [];

interface StoredFact {
  id: string;
  text: string;
  createdAt?: string;
}
const emptyMemory = () => ({ facts: [] as StoredFact[], goals: [], completedGoals: [] });

/** Altbestand direkt in die Ablage: der Speicher selbst nimmt keine Geheimnisse mehr an */
const seed = (id: string, text: string) => updateJsonState(FILE, emptyMemory, memory => void memory.facts.push({ id, text, createdAt: "2026-03-15T12:00:00Z" }));
const setText = (id: string, text: string) => updateJsonState(FILE, emptyMemory, memory => void (memory.facts.find(fact => fact.id === id)!.text = text));

const memory = () => getStore().memory;
const secretChoices = async () => (await listChoices()).filter(choice => choice.kind === "secret");
const openChoices = async () => (await secretChoices()).filter(choice => choice.state === "open");

const tybo = (...args: string[]) =>
  runTybo({
    args: ["gedaechtnis", ...args],
    env: { ...process.env, TELEGRAM_BOT_TOKEN: "1:token", TELEGRAM_USER_ID: OWNER },
    root,
    out: line => void out.push(line),
    err: line => void errs.push(line),
    secretReview: {
      createApi: () => ({ editMessageText: async () => true, editMessageReplyMarkup: async () => true }) as never,
      send: async input => (sends.push(input), { sent: true, recorded: true, messageIds: [100 + sends.length] }) as unknown as SendAndRecordResult,
    },
  });

/** Alles, was der Befehl nach außen gegeben hat, dazu das Register */
const everythingVisible = () => JSON.stringify([out, errs, sends, notices, logs, readFileSync(join(root, "data", "choices.json"), "utf8")]);

beforeEach(() => {
  rmSync(`${FILE}.sqlite`, { force: true });
  rmSync(FILE, { force: true });
  resetStore();
  root = realpathSync(mkdtempSync(join(tmpdir(), "tybo-geheimnisse-")));
  setChoicesFileForTests(join(root, "data", "choices.json"));
  out = [];
  errs = [];
  sends = [];
  notices = [];
  logs = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
  restores.push(() => log.mockRestore());
  stopHandler = onChoiceDecided(
    "secret",
    createSecretChoices({
      file: secretDecisionsFile(root),
      memory,
      notify: async (_conversation, text) => void notices.push(text),
      log: line => void logs.push(line),
    }).handler,
  );
});

afterEach(() => {
  stopHandler();
  while (restores.length) restores.pop()!();
  setChoicesFileForTests(null);
  resetStore();
  rmSync(root, { recursive: true, force: true });
});

describe("Vorlegen", () => {
  test("nur Fakten mit Geheimnis, einzeln, im Direktchat, Kennung und Maske statt Wert", async () => {
    seed("f1", SECRET_FACT);
    seed("f2", "Alex trinkt morgens Tee");
    seed("f3", "Commit 0123456789abcdef0123456789abcdef01234567 in /Users/alex/projekt");
    expect(await tybo("geheimnisse")).toBe(0);

    const choices = await secretChoices();
    expect(choices).toHaveLength(1);
    expect(choices[0].conversation).toEqual(DM);
    expect(choices[0].text).toContain("Fakt f1");
    expect(choices[0].text).toContain(`Passwort: ${SECRET_MASK}`);
    expect(choices[0].options.map(option => option.key)).toEqual([SECRET_KEYS.keep, SECRET_KEYS.archive]);
    expect(sends.map(send => send.chatId)).toEqual([OWNER]);
    expect(out.join("\n")).toContain(`f1  Seite imker.example, Passwort: ${SECRET_MASK}`);
    expect(out.join("\n")).toContain("Fakten mit Geheimnis: 1");
    expect(out.join("\n")).not.toContain("Alex trinkt");
    expect(everythingVisible()).not.toContain(PASSWORD);
  });

  test("ohne Fund nur ein Satz, keine Frage", async () => {
    seed("f2", "Alex trinkt morgens Tee");
    expect(await tybo("geheimnisse")).toBe(0);
    expect(out).toEqual(["Kein gespeicherter Fakt sieht nach einem Geheimnis aus."]);
    expect(await listChoices().catch(() => [])).toEqual([]);
  });

  test("ohne Telegram landet die Frage im Web-Direktchat, nie in einem anderen Gespräch", async () => {
    seed("f1", SECRET_FACT);
    const env = { ...process.env };
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_USER_ID;
    const code = await runTybo({
      args: ["gedaechtnis", "geheimnisse"],
      env,
      root,
      out: line => void out.push(line),
      err: line => void errs.push(line),
      secretReview: { send: async input => (sends.push(input), { sent: true, recorded: true }) as unknown as SendAndRecordResult },
    });
    expect(code).toBe(0);
    expect((await secretChoices())[0].conversation).toEqual({ type: "telegram", chatId: "web" });
  });

  test("ein zweiter Aufruf fragt nichts doppelt", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    await tybo("geheimnisse");
    expect(await secretChoices()).toHaveLength(1);
    expect(out.join("\n")).toContain("Frage schon offen: 1");
  });

  test("höchstens so viele offene Fragen wie erlaubt, den Rest legt ein späterer Aufruf vor", async () => {
    for (let i = 0; i < SECRET_QUESTIONS_MAX + 3; i++) seed(`f${i}`, `Konto ${i}, Passwort: Waldmeister${i}x`);
    await tybo("geheimnisse");
    expect(await openChoices()).toHaveLength(SECRET_QUESTIONS_MAX);
    expect(out.join("\n")).toContain("für den nächsten Aufruf: 3");
    await tybo("geheimnisse");
    expect(await openChoices()).toHaveLength(SECRET_QUESTIONS_MAX);
    const [first] = await openChoices();
    await decideChoice(first.id, SECRET_KEYS.keep, "web");
    await tybo("geheimnisse");
    expect(await openChoices()).toHaveLength(SECRET_QUESTIONS_MAX);
  });

  test("kommt eine Frage nicht an, läuft sie ab und nichts ändert sich", async () => {
    seed("f1", SECRET_FACT);
    const report = await offerSecretFacts(DM, { file: secretDecisionsFile(root), memory, sendChoice: async () => ({ sent: false }) });
    expect(report).toMatchObject({ found: 1, offered: 0, notDelivered: 1 });
    expect(await openChoices()).toEqual([]);
    expect((await memory().facts()).map(fact => fact.content)).toEqual([SECRET_FACT]);
  });

  test("unlesbarer Vermerk: nichts vorgelegt und nicht überschrieben", async () => {
    seed("f1", SECRET_FACT);
    const path = secretDecisionsFile(root);
    await Bun.write(path, "kein json");
    expect(await tybo("geheimnisse")).toBe(1);
    expect(errs.join()).toContain("nichts vorgelegt");
    expect(readFileSync(path, "utf8")).toBe("kein json");
  });

  test("falscher Aufruf", async () => {
    expect(await tybo("geheimnisse", "--unsinn")).toBe(2);
  });

  test("tybo gedaechtnis help nennt den Befehl", async () => {
    expect(await tybo("help")).toBe(0);
    expect(out.join("\n")).toContain("gedaechtnis geheimnisse");
  });
});

describe("Behalten", () => {
  test("bleibt gespeichert, im Prompt weiter maskiert, wird nicht wieder gefragt", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    const [choice] = await secretChoices();
    expect((await decideChoice(choice.id, SECRET_KEYS.keep, "web")).status).toBe("decided");

    expect(notices).toEqual([SECRET_TEXT.kept("f1")]);
    expect((await memory().facts()).map(fact => fact.content)).toEqual([SECRET_FACT]);
    const context = await getMemoryContext();
    expect(context).toContain(`Passwort: ${SECRET_MASK}`);
    expect(context).not.toContain(PASSWORD);
    expect((await readSecretDecisions(secretDecisionsFile(root))).kept.f1.stamp).toBe(factStamp(SECRET_FACT));
    expect(readFileSync(secretDecisionsFile(root), "utf8")).not.toContain(PASSWORD);

    out.length = 0;
    await tybo("geheimnisse");
    expect(await openChoices()).toEqual([]);
    expect(out.join("\n")).toContain("schon behalten: 1");
    expect(out.join("\n")).not.toContain("f1  ");
  });

  test("ändert sich der Text, gilt die Entscheidung nicht mehr; ein neuer Stand wird neu gefragt", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    await decideChoice((await secretChoices())[0].id, SECRET_KEYS.keep, "web");
    setText("f1", "Seite imker.example, Passwort: Sommerwiese77");
    resetStore();
    await tybo("geheimnisse");
    expect(await openChoices()).toHaveLength(1);
  });

  test("--alle fragt auch Behaltene noch einmal", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    await decideChoice((await secretChoices())[0].id, SECRET_KEYS.keep, "web");
    await tybo("geheimnisse", "--alle");
    expect(await openChoices()).toHaveLength(1);
  });
});

describe("Archivieren", () => {
  test("verschwindet aus Fakten und Prompt, das Archiv zeigt nur die Maske, zurückholen geht", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    await decideChoice((await secretChoices())[0].id, SECRET_KEYS.archive, "web");

    expect(notices).toEqual([SECRET_TEXT.archived("f1")]);
    expect(await memory().facts()).toEqual([]);
    expect(await getMemoryContext()).not.toContain(PASSWORD);

    out.length = 0;
    expect(await tybo("archiv")).toBe(0);
    expect(out.join("\n")).toContain(`Passwort: ${SECRET_MASK}`);
    expect(out.join("\n")).not.toContain(PASSWORD);

    expect(await tybo("zurueckholen", "f1")).toBe(0);
    expect((await memory().facts()).map(fact => fact.content)).toEqual([SECRET_FACT]);
  });
});

describe("Klicks", () => {
  test("doppelter Klick wirkt einmal, auch mit dem anderen Knopf", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    const [choice] = await secretChoices();
    await decideChoice(choice.id, SECRET_KEYS.keep, "web");
    expect((await decideChoice(choice.id, SECRET_KEYS.archive, "telegram")).status).toBe("already");
    expect(notices).toHaveLength(1);
    expect(await memory().facts()).toHaveLength(1);
  });

  test("veraltete Frage: Text inzwischen geändert, nichts archiviert, nichts behalten", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    const [first] = await secretChoices();
    setText("f1", "Seite imker.example, Passwort: Sommerwiese77");
    resetStore();
    await decideChoice(first.id, SECRET_KEYS.archive, "web");
    expect(notices).toEqual([SECRET_TEXT.changed("f1")]);
    expect(await memory().facts()).toHaveLength(1);

    await tybo("geheimnisse");
    const second = (await openChoices())[0];
    setText("f1", "Seite imker.example, Passwort: Herbstlaub99");
    resetStore();
    await decideChoice(second.id, SECRET_KEYS.keep, "web");
    expect(notices.at(-1)).toBe(SECRET_TEXT.changed("f1"));
    expect((await readSecretDecisions(secretDecisionsFile(root))).kept).toEqual({});
  });

  test("Fakt inzwischen weg", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    const [choice] = await secretChoices();
    await memory().deleteFactById("f1");
    await decideChoice(choice.id, SECRET_KEYS.archive, "web");
    expect(notices).toEqual([SECRET_TEXT.gone("f1")]);
  });

  test("abgelaufene Frage entscheidet nichts, ein neuer Aufruf fragt erneut", async () => {
    seed("f1", SECRET_FACT);
    await tybo("geheimnisse");
    const [choice] = await secretChoices();
    await expireChoice(choice.id);
    expect((await decideChoice(choice.id, SECRET_KEYS.archive, "web")).status).toBe("expired");
    expect(notices).toEqual([]);
    expect(await memory().facts()).toHaveLength(1);
    await tybo("geheimnisse");
    expect(await openChoices()).toHaveLength(1);
  });

  test("fremder Absender in Telegram: nicht entschieden, nichts geändert", async () => {
    seed("f1", SECRET_FACT);
    const [fact] = await memory().facts();
    const choice: Choice = await createChoice(secretQuestion(fact, DM, Date.now()));
    const api = { answerCallbackQuery: async () => true, editMessageText: async () => true, editMessageReplyMarkup: async () => true };
    const composer = new Composer<Context>();
    composer.on("callback_query:data", createTelegramChoices({ api: api as never, owner: OWNER, log: () => {} }).middleware);
    const update = {
      update_id: 1,
      callback_query: {
        id: "q1",
        from: { id: Number(STRANGER), is_bot: false, first_name: "X" },
        chat_instance: "ci",
        data: `ch|${choice.id}|${SECRET_KEYS.archive}`,
        message: { message_id: 100, date: 0, chat: { id: Number(OWNER), type: "private", first_name: "E" } },
      },
    };
    await composer.middleware()(new Context(update as never, api as never, {} as never), async () => {});
    expect((await getChoice(choice.id))?.state).toBe("open");
    expect(notices).toEqual([]);
    expect(await memory().facts()).toHaveLength(1);
  });

  test("Speicher nicht lesbar: Meldung ohne Wert, nichts geändert", async () => {
    const said: string[] = [];
    const logged: string[] = [];
    const { handler } = createSecretChoices({
      file: secretDecisionsFile(root),
      memory: () => ({ facts: async () => { throw new Error(PASSWORD); }, archiveFact: async () => "changed" as const }),
      notify: async (_conversation, text) => void said.push(text),
      log: line => void logged.push(line),
    });
    seed("f1", SECRET_FACT);
    const [fact] = await memory().facts();
    const choice = await createChoice(secretQuestion(fact, DM, Date.now()));
    await handler({ ...choice, state: "done", result: { key: SECRET_KEYS.archive, label: "Archivieren", via: "web", at: 0 } });
    expect(said).toEqual([SECRET_TEXT.failed("f1")]);
    expect(logged.join()).not.toContain(PASSWORD);
  });
});

