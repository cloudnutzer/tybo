/**
 * Rückfrage-Port der WebUI (Issue #115) mit dem echten Register in einer
 * Test-Datei: Zuordnung zum Gespräch, Sicht aus einem anderen Gespräch,
 * Entscheiden nur aus dem eigenen Gespräch, Änderungen dieses Prozesses
 * sofort und Änderungen anderer Prozesse bzw. Fristen per Abgleich.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, expireChoice, getChoice, getChoiceChecked, listOpenChoices, setChoicesFileForTests } from "../src/lib/choices";
import { CHOICE_SYNC_MS, choiceViewFor, toApiChoice, type ChoiceChange } from "../src/web/choices";
import { testChoices, type TestChoices } from "./choices-fixture";

const USER = "4711";
const GROUP = "-1001234567890";
const WEB = "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b";
const root = await mkdtemp(join(tmpdir(), "tybo-choices-port-"));
let counter = 0;
let t: TestChoices;

beforeEach(() => {
  t = testChoices(join(root, `choices-${++counter}.json`), { userId: USER, groupId: GROUP });
});
afterAll(async () => {
  setChoicesFileForTests(null);
  await rm(root, { recursive: true, force: true });
});

describe("Sicht auf eine Frage", () => {
  test("offene Frage im eigenen Topic: Knöpfe, Zustand open, kein Ergebnis", async () => {
    const c = await t.create({ conversation: { type: "telegram", chatId: GROUP, topicId: 443 } });
    expect(await t.port.view(c.id, "topic-443")).toEqual({
      id: c.id,
      options: [
        { key: "ok", label: "Erlauben" },
        { key: "no", label: "Ablehnen" },
      ],
      state: "open",
    });
  });

  test("Zuordnung: Direktchat ohne Topic, General ohne Topic und mit Topic 1, Web-Gespräch", async () => {
    const dm = await t.create({ conversation: { type: "telegram", chatId: USER } });
    const general = await t.create({ conversation: { type: "telegram", chatId: GROUP } });
    const one = await t.create({ conversation: { type: "telegram", chatId: GROUP, topicId: 1 } });
    const web = await t.create({ conversation: { type: "web", conversationId: WEB } });
    expect((await t.port.view(dm.id, "dm")).options).toHaveLength(2);
    expect((await t.port.view(general.id, "topic-1")).options).toHaveLength(2);
    expect((await t.port.view(one.id, "topic-1")).options).toHaveLength(2);
    expect((await t.port.view(web.id, WEB)).options).toHaveLength(2);
  });

  test("aus einem anderen Gespräch: keine Knöpfe, Verweis auf das eigene; fremder Chat ohne Verweis", async () => {
    const web = await t.create({ conversation: { type: "web", conversationId: WEB } });
    expect(await t.port.view(web.id, "dm")).toEqual({ id: web.id, options: [], state: "open", elsewhere: WEB });
    const foreign = await t.create({ conversation: { type: "telegram", chatId: "999" } });
    expect(await t.port.view(foreign.id, "dm")).toEqual({ id: foreign.id, options: [], state: "open" });
  });

  test("unbekannt oder ungültige Kennung: abgelaufen; entschieden: Ergebnis mit Kanal und ISO-Zeit, keine Knöpfe", async () => {
    expect(await t.port.view("Unbekannt123", "dm")).toEqual({ id: "Unbekannt123", options: [], state: "expired" });
    expect((await t.port.view("../x", "dm")).state).toBe("expired");
    const c = await t.create({ conversation: { type: "telegram", chatId: USER } });
    await decideChoice(c.id, "ok", "telegram");
    const view = await t.port.view(c.id, "dm");
    expect(view.options).toEqual([]);
    expect(view.state).toBe("done");
    expect(view.result).toMatchObject({ key: "ok", label: "Erlauben", via: "telegram" });
    expect(Number.isFinite(Date.parse(view.result!.at))).toBe(true);
  });

  test("Frist überschritten: expired, ohne dass jemand den Ablauf gespeichert hat", async () => {
    const c = await t.create({ conversation: { type: "telegram", chatId: USER }, expiresAt: Date.now() - 1 });
    expect((await t.port.view(c.id, "dm")).state).toBe("expired");
  });

  test("choiceViewFor lässt die eigene Sicht unverändert", () => {
    const own = toApiChoice({ id: "a1", conversation: { type: "web", conversationId: WEB }, options: [{ key: "k", label: "L" }], state: "open" });
    expect(choiceViewFor(own, WEB, WEB)).toBe(own);
    expect(choiceViewFor(own, null, "dm")).toEqual({ id: "a1", options: [], state: "open" });
  });
});

describe("Entscheiden", () => {
  test("nur aus dem eigenen Gespräch; Kopie im Direktchat und anderes Topic: not_found, Frage bleibt offen", async () => {
    const web = await t.create({ conversation: { type: "web", conversationId: WEB } });
    expect(await t.port.decide("dm", web.id, "ok", "web")).toEqual({ status: "not_found" });
    const topic = await t.create({ conversation: { type: "telegram", chatId: GROUP, topicId: 443 } });
    expect(await t.port.decide("topic-8", topic.id, "ok", "web")).toEqual({ status: "not_found" });
    expect((await t.port.view(web.id, WEB)).state).toBe("open");
    expect((await t.port.view(topic.id, "topic-443")).state).toBe("open");
  });

  test("erster gewinnt, zweiter bekommt already mit dem ersten Ergebnis; unbekannte Option lässt offen", async () => {
    const c = await t.create({ conversation: { type: "telegram", chatId: GROUP, topicId: 443 } });
    expect(await t.port.decide("topic-443", c.id, "vielleicht", "web")).toEqual({ status: "invalid_option" });
    expect(await t.port.decide("topic-443", c.id, "a b", "web")).toEqual({ status: "invalid_option" });
    const first = await t.port.decide("topic-443", c.id, "no", "web");
    expect(first.status).toBe("decided");
    const second = await t.port.decide("topic-443", c.id, "ok", "terminal");
    expect(second.status).toBe("already");
    expect(second.status === "already" && second.choice.result).toMatchObject({ key: "no", label: "Ablehnen", via: "web" });
  });

  test("abgelaufen: expired mit abgelaufener Sicht; unbekannt: not_found", async () => {
    const c = await t.create({ conversation: { type: "telegram", chatId: USER }, expiresAt: Date.now() - 1 });
    expect(await t.port.decide("dm", c.id, "ok", "web")).toEqual({ status: "expired", choice: { id: c.id, options: [], state: "expired" } });
    expect(await t.port.decide("dm", "Gibtsnicht1", "ok", "web")).toEqual({ status: "not_found" });
  });
});

describe("Änderungen", () => {
  function listen() {
    const changes: ChoiceChange[] = [];
    const stop = t.port.subscribe(c => changes.push(c));
    return { changes, stop };
  }

  test("Entscheidung in diesem Prozess (Telegram-Knopf): sofort, mit Gespräch und Kanal", async () => {
    const c = await t.create({ conversation: { type: "telegram", chatId: GROUP, topicId: 443 } });
    const { changes, stop } = listen();
    await t.tick();
    await decideChoice(c.id, "ok", "telegram");
    expect(changes).toHaveLength(1);
    expect(changes[0].conversationId).toBe("topic-443");
    expect(changes[0].copyInDm).toBe(false);
    expect(changes[0].choice.result).toMatchObject({ via: "telegram", label: "Erlauben" });
    // Der Abgleich meldet sie nicht noch einmal
    await t.tick();
    expect(changes).toHaveLength(1);
    stop();
  });

  test("Web-Frage: copyInDm; abgelaufen gespeichert: sofort als expired", async () => {
    const c = await t.create({ conversation: { type: "web", conversationId: WEB } });
    const { changes, stop } = listen();
    await expireChoice(c.id);
    expect(changes.map(x => [x.conversationId, x.copyInDm, x.choice.state])).toEqual([[WEB, true, "expired"]]);
    stop();
  });

  test("anderer Prozess entscheidet: der nächste Abgleich (alle 15 Sekunden) meldet es; Startstand bleibt still", async () => {
    const open = await t.create({ conversation: { type: "telegram", chatId: USER } });
    const { changes, stop } = listen();
    expect(t.intervals).toEqual([CHOICE_SYNC_MS]);
    expect(CHOICE_SYNC_MS).toBe(15_000);
    await t.tick();
    expect(changes).toEqual([]);
    await t.editFile(choices => {
      choices[open.id].state = "done";
      choices[open.id].result = { key: "no", label: "Ablehnen", via: "telegram", at: Date.now() };
    });
    await t.tick();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ conversationId: "dm", choice: { id: open.id, state: "done", result: { via: "telegram" } } });
    await t.tick();
    expect(changes).toHaveLength(1);
    stop();
  });

  test("Frist läuft ab oder Eintrag verschwindet: Abgleich meldet expired; neue offene Frage nur als neu (Issue #226)", async () => {
    const soon = await t.create({ conversation: { type: "telegram", chatId: USER }, expiresAt: Date.now() + 40 });
    const gone = await t.create({ conversation: { type: "telegram", chatId: GROUP, topicId: 8 } });
    const { changes, stop } = listen();
    await t.tick();
    await Bun.sleep(60);
    await t.editFile(choices => {
      delete choices[gone.id];
    });
    const fresh = await t.create({ conversation: { type: "telegram", chatId: USER } });
    await t.tick();
    expect(changes.filter(c => !c.created).map(c => [c.conversationId, c.choice.id, c.choice.state]).sort()).toEqual(
      [
        ["dm", soon.id, "expired"],
        ["topic-8", gone.id, "expired"],
      ].sort()
    );
    expect(changes.filter(c => c.created).map(c => [c.conversationId, c.choice.id, c.choice.state])).toEqual([["dm", fresh.id, "open"]]);
    stop();
  });

  test("neue Frage (Issue #226): dieser Prozess sofort genau einmal mit Art, anderer Prozess per Abgleich genau einmal; Startstand nicht", async () => {
    const before = await t.create({ conversation: { type: "telegram", chatId: USER } });
    const { changes, stop } = listen();
    await t.tick();
    expect(changes).toEqual([]);
    const own = await t.create({ conversation: { type: "web", conversationId: WEB } });
    await t.tick();
    await t.tick();
    const created = () => changes.filter(c => c.created);
    expect(created()).toEqual([{ conversationId: WEB, choice: toApiChoice(own), copyInDm: true, created: true, kind: "tool" }]);
    // Ein anderer Prozess legt eine Frage an (Datei direkt geschrieben, kein Zuhörer hier)
    await t.editFile(choices => {
      choices.Fremd1 = { ...choices[before.id], id: "Fremd1", kind: "goal", conversation: { type: "telegram", chatId: GROUP, topicId: 9 } };
    });
    await t.tick();
    await t.tick();
    expect(created().map(c => [c.conversationId, c.choice.id, c.kind])).toEqual([
      [WEB, own.id, "tool"],
      ["topic-9", "Fremd1", "goal"],
    ]);
    expect(created().some(c => c.choice.id === before.id)).toBe(false);
    stop();
  });

  test("Register nicht lesbar: kein expired, letzter Stand bleibt; nach der Erholung meldet der Abgleich die Entscheidung", async () => {
    const c = await t.create({ conversation: { type: "telegram", chatId: GROUP, topicId: 443 } });
    const { changes, stop } = listen();
    await t.tick();
    const good = await readFile(t.file, "utf8");
    await writeFile(t.file, "{kaputt");
    await t.tick();
    await t.tick();
    expect(changes).toEqual([]);
    // Sicht und Entscheiden werfen, statt die Frage als abgelaufen zu melden
    await expect(t.port.view(c.id, "topic-443")).rejects.toThrow();
    await expect(t.port.decide("topic-443", c.id, "ok", "web")).rejects.toThrow();
    // Die Datei ist nicht ersetzt worden
    expect(await readFile(t.file, "utf8")).toBe("{kaputt");
    // Während der Störung entscheidet ein anderer Prozess
    const data = JSON.parse(good);
    data.choices[c.id].state = "done";
    data.choices[c.id].result = { key: "no", label: "Ablehnen", via: "telegram", at: Date.now() };
    await writeFile(t.file, JSON.stringify(data));
    await t.tick();
    expect(changes.map(x => [x.conversationId, x.choice.id, x.choice.state, x.choice.result?.via])).toEqual([
      ["topic-443", c.id, "done", "telegram"],
    ]);
    expect((await t.port.view(c.id, "topic-443")).state).toBe("done");
    stop();
  });

  test("Register nicht lesbar und wieder da, ohne dass etwas passiert ist: nichts gemeldet, offene Frage bleibt offen", async () => {
    const c = await t.create({ conversation: { type: "telegram", chatId: USER } });
    const { changes, stop } = listen();
    await t.tick();
    const good = await readFile(t.file, "utf8");
    await writeFile(t.file, "[]");
    await t.tick();
    await writeFile(t.file, good);
    await t.tick();
    expect(changes).toEqual([]);
    expect((await t.port.view(c.id, "dm")).state).toBe("open");
    stop();
  });

  test("schon beim Start nicht lesbar: nach der Erholung kommen die Endzustände, offene bleiben still", async () => {
    const decided = await t.create({ conversation: { type: "telegram", chatId: USER } });
    const open = await t.create({ conversation: { type: "telegram", chatId: GROUP, topicId: 8 } });
    await decideChoice(decided.id, "ok", "telegram");
    const good = await readFile(t.file, "utf8");
    await writeFile(t.file, "{kaputt");
    const { changes, stop } = listen();
    await t.tick();
    expect(changes).toEqual([]);
    await writeFile(t.file, good);
    await t.tick();
    expect(changes.map(x => [x.conversationId, x.choice.id, x.choice.state])).toEqual([["dm", decided.id, "done"]]);
    expect(changes.some(x => x.choice.id === open.id)).toBe(false);
    // Danach wieder normal: nichts doppelt
    await t.tick();
    expect(changes).toHaveLength(1);
    stop();
  });

  test("Telegram-Weg unverändert: getChoice und listOpenChoices lesen eine kaputte Datei als leer, getChoiceChecked wirft", async () => {
    const c = await t.create({ conversation: { type: "telegram", chatId: USER } });
    await writeFile(t.file, "{kaputt");
    expect(await getChoice(c.id)).toBeUndefined();
    expect(await listOpenChoices({ type: "telegram", chatId: USER })).toEqual([]);
    await expect(getChoiceChecked(c.id)).rejects.toThrow();
  });

  test("ohne Zuhörer kein Zeitgeber; Abmelden hält ihn an", async () => {
    const { stop } = listen();
    expect(t.intervals).toHaveLength(1);
    stop();
    const again = listen();
    expect(t.intervals).toHaveLength(2);
    again.stop();
  });
});
