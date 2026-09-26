/**
 * Rückfragen-Register (Issue #113), Schritt 2: decideChoice genau einmal,
 * gleichzeitig im Prozess und aus einem echten Kindprozess auf derselben Datei.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CHOICE_KINDS,
  CHOICE_MAX_AGE_MS,
  createChoice,
  decideChoice,
  expireChoice,
  getChoice,
  onChoiceChange,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
  type CreateChoiceInput,
} from "../src/lib/choices";

const base = mkdtempSync(join(tmpdir(), "choices-decide-"));
let file = "";
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
let handled: Choice[] = [];
let unregister: (() => void)[] = [];

beforeEach(() => {
  file = join(base, `choices-${++counter}.json`);
  setChoicesFileForTests(file);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  handled = [];
  unregister = CHOICE_KINDS.map(kind => onChoiceDecided(kind, c => { handled.push(c); }));
});
afterEach(() => {
  logSpy.mockRestore();
  for (const off of unregister) off();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

const onDisk = () => JSON.parse(readFileSync(file, "utf-8"));
const input = (over: Partial<CreateChoiceInput> = {}): CreateChoiceInput => ({
  kind: "review",
  conversation: { type: "telegram", chatId: "4242", topicId: 3 },
  text: "Merken: Alex trinkt Tee",
  options: [{ key: "ok", label: "Übernehmen" }, { key: "no", label: "Verwerfen" }],
  ...over,
});

describe("decideChoice im Prozess", () => {
  test("entscheidet mit Ergebnis, Kanal und Zeit", async () => {
    const c = await createChoice(input());
    const before = Date.now();
    const r = await decideChoice(c.id, "ok", "web");
    expect(r.status).toBe("decided");
    if (r.status !== "decided") return;
    expect(r.choice.state).toBe("done");
    expect(r.choice.result).toMatchObject({ key: "ok", label: "Übernehmen", via: "web" });
    expect(r.choice.result!.at).toBeGreaterThanOrEqual(before);
    expect(onDisk().choices[c.id].result).toEqual(r.choice.result);
    expect((await getChoice(c.id))?.state).toBe("done");
  });

  test("zwei gleichzeitige Aufrufe: genau ein decided und ein already, Handler genau einmal", async () => {
    const c = await createChoice(input());
    const results = await Promise.all([decideChoice(c.id, "ok", "telegram"), decideChoice(c.id, "no", "web")]);
    const statuses = results.map(r => r.status).sort();
    expect(statuses).toEqual(["already", "decided"]);
    const winner = results.find(r => r.status === "decided")!;
    const loser = results.find(r => r.status === "already")!;
    if (winner.status !== "decided" || loser.status !== "already") throw new Error("unerwartet");
    // Der Verlierer sieht das Ergebnis des Gewinners, nicht sein eigenes
    expect(loser.choice.result).toEqual(winner.choice.result);
    expect(handled.map(h => h.id)).toEqual([c.id]);
  });

  test("zehn gleichzeitige Aufrufe: einer gewinnt", async () => {
    const c = await createChoice(input());
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => decideChoice(c.id, i % 2 ? "ok" : "no", "terminal")));
    expect(results.filter(r => r.status === "decided")).toHaveLength(1);
    expect(results.filter(r => r.status === "already")).toHaveLength(9);
    expect(handled).toHaveLength(1);
  });

  test("wiederholte Entscheidung ändert das Ergebnis nicht", async () => {
    const c = await createChoice(input());
    await decideChoice(c.id, "ok", "telegram");
    const again = await decideChoice(c.id, "no", "web");
    expect(again.status).toBe("already");
    expect(onDisk().choices[c.id].result).toMatchObject({ key: "ok", via: "telegram" });
    expect(handled).toHaveLength(1);
  });

  test("unbekannter Schlüssel wird abgelehnt, Frage bleibt offen und ist danach entscheidbar", async () => {
    const c = await createChoice(input());
    const r = await decideChoice(c.id, "vielleicht", "web");
    expect(r.status).toBe("invalid_key");
    expect(onDisk().choices[c.id].state).toBe("open");
    expect(handled).toHaveLength(0);
    expect((await decideChoice(c.id, "ok", "web")).status).toBe("decided");
  });

  test("unbekannte ID: unknown, kein Handler", async () => {
    expect((await decideChoice("gibtsnicht", "ok", "web")).status).toBe("unknown");
    expect(handled).toHaveLength(0);
  });

  test("unbekannter Kanal wird abgelehnt", async () => {
    const c = await createChoice(input());
    await expect(decideChoice(c.id, "ok", "email" as any)).rejects.toThrow("Kanal");
    expect(onDisk().choices[c.id].state).toBe("open");
  });
});

describe("Ablauf gegen Entscheidung", () => {
  test("abgelaufene Frage (expiresAt vorbei) lässt sich nicht mehr entscheiden und wird als expired gespeichert", async () => {
    const c = await createChoice(input({ expiresAt: Date.now() - 1 }));
    expect((await decideChoice(c.id, "ok", "telegram")).status).toBe("expired");
    expect(onDisk().choices[c.id].state).toBe("expired");
    expect(onDisk().choices[c.id].result).toBeUndefined();
    expect((await decideChoice(c.id, "ok", "telegram")).status).toBe("expired");
    expect(handled).toHaveLength(0);
  });

  test("per expireChoice abgelaufene Frage lässt sich nicht mehr entscheiden", async () => {
    const c = await createChoice(input());
    await expireChoice(c.id);
    expect((await decideChoice(c.id, "ok", "web")).status).toBe("expired");
    expect(handled).toHaveLength(0);
  });

  test("entschiedene Frage wird durch Ablauf nicht expired", async () => {
    const c = await createChoice(input({ expiresAt: Date.now() + 30 }));
    await decideChoice(c.id, "ok", "web");
    await Bun.sleep(40);
    expect((await getChoice(c.id))?.state).toBe("done");
    const r = await expireChoice(c.id);
    expect(r.status).toBe("already");
    expect(onDisk().choices[c.id].state).toBe("done");
    expect(onDisk().choices[c.id].result.key).toBe("ok");
  });

  test("offene Frage älter als 7 Tage: zwei gleichzeitige Entscheidungen melden unknown, kein Handler, nichts gespeichert", async () => {
    const stale: Choice = {
      id: "altoffen", kind: "review", conversation: { type: "telegram", chatId: "4242", topicId: 3 },
      text: "alt", options: [{ key: "ok", label: "Ja" }], state: "open",
      createdAt: Date.now() - CHOICE_MAX_AGE_MS - 1_000,
    };
    writeFileSync(file, JSON.stringify({ version: 1, choices: { altoffen: stale } }));
    const decided: Choice[] = [];
    const off = onChoiceChange(ch => { if (ch.type === "decided") decided.push(ch.choice); });
    try {
      const results = await Promise.all([decideChoice("altoffen", "ok", "telegram"), decideChoice("altoffen", "ok", "web")]);
      expect(results.map(r => r.status)).toEqual(["unknown", "unknown"]);
    } finally {
      off();
    }
    expect(handled).toHaveLength(0);
    expect(decided).toHaveLength(0);
    expect(onDisk().choices).toEqual({});
    expect(await getChoice("altoffen")).toBeUndefined();
  });

  test("Rennen decide gegen expire: genau eins gewinnt, der Zustand passt dazu", async () => {
    for (let round = 0; round < 10; round++) {
      handled = [];
      const c = await createChoice(input());
      const [d, e] = await Promise.all([decideChoice(c.id, "ok", "web"), expireChoice(c.id)]);
      const stored = onDisk().choices[c.id];
      if (d.status === "decided") {
        expect(e.status).toBe("already");
        expect(stored.state).toBe("done");
        expect(handled).toHaveLength(1);
      } else {
        expect(d.status).toBe("expired");
        expect(e.status).toBe("expired");
        expect(stored.state).toBe("expired");
        expect(stored.result).toBeUndefined();
        expect(handled).toHaveLength(0);
      }
    }
  });
});

describe("zwei Prozesse auf derselben Datei", () => {
  test("Eltern- und Kindprozess entscheiden gleichzeitig: pro Frage genau ein decided, ein already, ein Handler-Aufruf", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await createChoice(input())).id);
    // Um diese Frage greifen beide Prozesse im selben Moment
    const shared = (await createChoice(input())).id;

    const script = join(base, "child.ts");
    const modulePath = JSON.stringify(join(import.meta.dir, "..", "src", "lib", "choices.ts"));
    writeFileSync(
      script,
      `import { CHOICE_KINDS, decideChoice, onChoiceDecided, setChoicesFileForTests } from ${modulePath};
console.log = () => {};
const [file, startAt, idList, shared] = process.argv.slice(2);
setChoicesFileForTests(file);
const handledIds: string[] = [];
for (const kind of CHOICE_KINDS) onChoiceDecided(kind, c => { handledIds.push(c.id); });
// Umgekehrte Reihenfolge mit kleinen Pausen: Eltern und Kind treffen sich in
// der Mitte und greifen dort um dieselben Fragen, beide gewinnen einige
const ids = idList.split(",").reverse();
while (Date.now() < Number(startAt)) await Bun.sleep(1);
const sharedResult = await decideChoice(shared, "no", "terminal");
const results = [];
for (const id of ids) { results.push(await decideChoice(id, "no", "terminal")); await Bun.sleep(15); }
process.stdout.write(JSON.stringify({ shared: sharedResult.status, statuses: results.map(r => r.status).reverse(), handledIds }));
`
    );
    // Beide Seiten starten zum selben Zeitpunkt, damit sie wirklich konkurrieren
    const startAt = Date.now() + 700;
    const child = Bun.spawn(["bun", script, file, String(startAt), ids.join(","), shared], { stdout: "pipe", stderr: "pipe" });
    while (Date.now() < startAt) await Bun.sleep(1);
    const parentShared = await decideChoice(shared, "ok", "web");
    const parentResults = [];
    for (const id of ids) { parentResults.push(await decideChoice(id, "ok", "web")); await Bun.sleep(15); }
    expect(await child.exited).toBe(0);
    const childOut = JSON.parse(await new Response(child.stdout).text()) as { shared: string; statuses: string[]; handledIds: string[] };

    expect([parentShared.status, childOut.shared].sort()).toEqual(["already", "decided"]);
    expect(handled.filter(h => h.id === shared).length + childOut.handledIds.filter(h => h === shared).length).toBe(1);

    // Beide Prozesse haben wirklich Fragen gewonnen
    expect(parentResults.some(r => r.status === "decided")).toBe(true);
    expect(childOut.statuses).toContain("decided");
    ids.forEach((id, i) => {
      expect([parentResults[i].status, childOut.statuses[i]].sort()).toEqual(["already", "decided"]);
      const handlerCalls = handled.filter(h => h.id === id).length + childOut.handledIds.filter(h => h === id).length;
      expect(handlerCalls).toBe(1);
      // Gespeichert ist das Ergebnis des Gewinners
      const stored = onDisk().choices[id];
      const parentWon = parentResults[i].status === "decided";
      expect(stored.result).toMatchObject(parentWon ? { key: "ok", via: "web" } : { key: "no", via: "terminal" });
    });
  }, 20_000);
});
