/**
 * Rückfragen-Register (Issue #113), Schritt 3: Handler pro Art, Zuhörer,
 * callback_data "ch|<id>|<key>" mit 64-Byte-Grenze.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CALLBACK_DATA_MAX_BYTES,
  choiceCallbackData,
  createChoice,
  decideChoice,
  expireChoice,
  onChoiceChange,
  onChoiceDecided,
  parseChoiceCallbackData,
  setChoicesFileForTests,
  type Choice,
  type ChoiceChangeType,
  type CreateChoiceInput,
} from "../src/lib/choices";

const base = mkdtempSync(join(tmpdir(), "choices-handlers-"));
let file = "";
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
let cleanup: (() => void)[] = [];

beforeEach(() => {
  file = join(base, `choices-${++counter}.json`);
  setChoicesFileForTests(file);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  cleanup = [];
});
afterEach(() => {
  logSpy.mockRestore();
  for (const off of cleanup) off();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

const onDisk = () => JSON.parse(readFileSync(file, "utf-8"));
const logged = (part: string) => logSpy.mock.calls.some(args => String(args[0]).includes(part));
const input = (over: Partial<CreateChoiceInput> = {}): CreateChoiceInput => ({
  kind: "goal",
  conversation: { type: "web", conversationId: "gespraech-1" },
  text: "Weiter?",
  options: [{ key: "go", label: "Weiter" }, { key: "stop", label: "Stopp" }],
  ...over,
});

describe("Handler pro Art", () => {
  test("läuft nach der Entscheidung genau einmal mit dem gespeicherten Ergebnis", async () => {
    const calls: Choice[] = [];
    cleanup.push(onChoiceDecided("goal", c => {
      // Die Entscheidung ist schon gespeichert, wenn der Handler läuft
      expect(onDisk().choices[c.id].state).toBe("done");
      calls.push(c);
    }));
    const c = await createChoice(input());
    await decideChoice(c.id, "go", "terminal");
    await decideChoice(c.id, "stop", "web");
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toMatchObject({ key: "go", via: "terminal" });
  });

  test("nur der Handler der eigenen Art läuft", async () => {
    const seen: string[] = [];
    cleanup.push(onChoiceDecided("goal", () => { seen.push("goal"); }));
    cleanup.push(onChoiceDecided("tool", () => { seen.push("tool"); }));
    const c = await createChoice(input({ kind: "tool" }));
    await decideChoice(c.id, "go", "web");
    expect(seen).toEqual(["tool"]);
  });

  test("Handler läuft außerhalb der Sperre: er darf selbst ins Register schreiben", async () => {
    let inner: Choice | undefined;
    cleanup.push(onChoiceDecided("goal", async () => {
      inner = await createChoice(input({ text: "Noch eine Runde?" }));
    }));
    const c = await createChoice(input());
    const r = await decideChoice(c.id, "go", "web");
    expect(r.status).toBe("decided");
    expect(inner).toBeDefined();
    expect(onDisk().choices[inner!.id].state).toBe("open");
  });

  test("Handler wirft: Frage bleibt done, Fehler geloggt und gespeichert, kein zweiter Lauf", async () => {
    let runs = 0;
    cleanup.push(onChoiceDecided("goal", () => { runs++; throw new Error("Ziel nicht gefunden"); }));
    const c = await createChoice(input());
    const r = await decideChoice(c.id, "go", "telegram");
    expect(r.status).toBe("decided");
    if (r.status !== "decided") return;
    expect(r.choice.state).toBe("done");
    expect(r.choice.handlerError?.message).toBe("Ziel nicht gefunden");
    const stored = onDisk().choices[c.id];
    expect(stored.state).toBe("done");
    expect(stored.result).toMatchObject({ key: "go", via: "telegram" });
    expect(stored.handlerError.message).toBe("Ziel nicht gefunden");
    expect(logged("Ziel nicht gefunden")).toBe(true);

    const again = await decideChoice(c.id, "go", "web");
    expect(again.status).toBe("already");
    expect(runs).toBe(1);
    expect((await expireChoice(c.id)).status).toBe("already");
    expect(onDisk().choices[c.id].state).toBe("done");
  });

  test("kein Handler registriert: Entscheidung gilt, Vermerk und Log", async () => {
    const c = await createChoice(input({ kind: "topicmap" }));
    const r = await decideChoice(c.id, "go", "web");
    expect(r.status).toBe("decided");
    const stored = onDisk().choices[c.id];
    expect(stored.state).toBe("done");
    expect(stored.handlerError.message).toContain("kein Handler");
    expect(logged("kein Handler für topicmap")).toBe(true);
  });

  test("Abmelden: danach läuft der Handler nicht mehr", async () => {
    let runs = 0;
    const off = onChoiceDecided("review", () => { runs++; });
    off();
    const c = await createChoice(input({ kind: "review" }));
    await decideChoice(c.id, "go", "web");
    expect(runs).toBe(0);
  });
});

describe("Zuhörer", () => {
  test("hören created, decided, expired und handler-error", async () => {
    const events: [ChoiceChangeType, string, string][] = [];
    cleanup.push(onChoiceChange(({ type, choice }) => { events.push([type, choice.id, choice.state]); }));
    cleanup.push(onChoiceDecided("goal", () => { throw new Error("kaputt"); }));
    const a = await createChoice(input());
    const b = await createChoice(input());
    const late = await createChoice(input({ expiresAt: Date.now() - 1 }));
    await decideChoice(a.id, "go", "web");
    await expireChoice(b.id);
    await decideChoice(late.id, "go", "web");
    // Nichts geändert: keine Meldung
    await decideChoice(a.id, "go", "web");
    await decideChoice(a.id, "gibtsnicht", "web");
    await expireChoice(b.id);
    expect(events).toEqual([
      ["created", a.id, "open"],
      ["created", b.id, "open"],
      ["created", late.id, "open"],
      ["decided", a.id, "done"],
      ["handler-error", a.id, "done"],
      ["expired", b.id, "expired"],
      ["expired", late.id, "expired"],
    ]);
  });

  test("ein werfender Zuhörer stört weder andere Zuhörer noch die Entscheidung oder den Handler", async () => {
    const seen: string[] = [];
    let handlerRuns = 0;
    cleanup.push(onChoiceChange(() => { throw new Error("Zuhörer kaputt"); }));
    cleanup.push(onChoiceChange(({ type }) => { seen.push(type); }));
    cleanup.push(onChoiceDecided("goal", () => { handlerRuns++; }));
    const c = await createChoice(input());
    const r = await decideChoice(c.id, "go", "web");
    expect(r.status).toBe("decided");
    expect(handlerRuns).toBe(1);
    expect(seen).toEqual(["created", "decided"]);
    expect(onDisk().choices[c.id].handlerError).toBeUndefined();
    expect(logged("Zuhörer kaputt")).toBe(true);
  });

  test("Abmelden beendet die Meldungen", async () => {
    const seen: string[] = [];
    const off = onChoiceChange(({ type }) => { seen.push(type); });
    await createChoice(input());
    off();
    await createChoice(input());
    expect(seen).toEqual(["created"]);
  });
});

describe("callback_data", () => {
  test("für jede erzeugte ID und den längsten Schlüssel höchstens 64 Byte, Roundtrip", async () => {
    const longKey = "k".repeat(32);
    const options = [{ key: longKey, label: "Lang" }, { key: "a_b-9", label: "Kurz" }];
    for (let i = 0; i < 200; i++) {
      const c = await createChoice(input({ options }));
      for (const o of c.options) {
        const data = choiceCallbackData(c.id, o.key);
        expect(Buffer.byteLength(data, "utf-8")).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
        expect(data).toBe(`ch|${c.id}|${o.key}`);
        expect(parseChoiceCallbackData(data)).toEqual({ id: c.id, key: o.key });
      }
    }
  });

  test("längste zulässige Form (12 + 32 Zeichen) passt", () => {
    const data = choiceCallbackData("A".repeat(12), "z".repeat(32));
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });

  test("ungültige ID oder ungültiger Schlüssel wirft", () => {
    expect(() => choiceCallbackData("", "ok")).toThrow("ID");
    expect(() => choiceCallbackData("A".repeat(13), "ok")).toThrow("ID");
    expect(() => choiceCallbackData("ab|c", "ok")).toThrow("ID");
    expect(() => choiceCallbackData("abc", "")).toThrow("Optionsschlüssel");
    expect(() => choiceCallbackData("abc", "a|b")).toThrow("Optionsschlüssel");
    expect(() => choiceCallbackData("abc", "ü")).toThrow("Optionsschlüssel");
    expect(() => choiceCallbackData("abc", "x".repeat(33))).toThrow("Optionsschlüssel");
  });

  test("parse: alte Knöpfe, Überlänge und kaputte Eingaben ergeben null", () => {
    for (const bad of [
      "toolapproval:abc:yes", "rev|ok|abc", "goalkb|go", "topicmap:7:research",
      "ch|abc", "ch|abc|ok|x", "ch||ok", "ch|abc|", "CH|abc|ok", "ch|äbc|ok", "ch|abc|o k",
      "ch|" + "A".repeat(13) + "|ok", "ch|abc|" + "x".repeat(33), "ch|abc|" + "x".repeat(80),
      "", undefined, null, 42,
    ]) {
      expect(parseChoiceCallbackData(bad)).toBeNull();
    }
  });
});
