/**
 * Issue #288, Checkbox 2: Art "routine" im Rückfragen-Register und
 * src/lib/routine-choices.ts. Echtes Register mit eigener Datei, launchd nur
 * als Attrappe (tests/routine-actions-fixture.ts); kein echtes launchctl.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideChoice,
  getChoice,
  listChoices,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
  type ChoiceConversation,
} from "../src/lib/choices";
import { createRoutineChoices, menuAlertSender, ROUTINE_CHOICE_TEXT, routineConversation, type RoutineChoices } from "../src/lib/routine-choices";
import { ACTION_TEXT } from "../src/lib/routines/actions";
import { createChoicePort } from "../src/web/choices";
import { register } from "./choices-fixture";
import { standardLaunchd, type FakeLaunchd } from "./routine-actions-fixture";

const HC = "ai.tybo.health-check";
const DM: ChoiceConversation = { type: "telegram", chatId: "123456" };

const base = mkdtempSync(join(tmpdir(), "routine-choices-"));
let file = "";
let counter = 0;
let cleanup: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  file = join(base, `choices-${++counter}.json`);
  setChoicesFileForTests(file);
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

interface Harness {
  rc: RoutineChoices;
  launchd: FakeLaunchd;
  sent: Choice[];
  notes: { conversation: ChoiceConversation; text: string }[];
  logs: string[];
}

function harness(launchd: FakeLaunchd = standardLaunchd(), options: { sendFails?: boolean } = {}): Harness {
  const sent: Choice[] = [];
  const notes: Harness["notes"] = [];
  const logs: string[] = [];
  const rc = createRoutineChoices({
    routines: launchd.deps,
    sendChoice: async c => {
      if (options.sendFails) return { sent: false };
      sent.push(c);
      return { sent: true };
    },
    notify: async (conversation, text) => {
      notes.push({ conversation, text });
    },
    format: () => ({ now: Date.parse("2026-10-15T08:00:00Z"), timeZone: "Europe/Berlin" }),
    log: line => logs.push(line),
  });
  cleanup.push(onChoiceDecided("routine", rc.handler));
  return { rc, launchd, sent, notes, logs };
}

/** Neue Auftragskennung wie aus dem Browser (routineRequestId in settings.js) */
let requestCounter = 0;
const req = () => `auftrag-${String(++requestCounter).padStart(12, "0")}`;

const labels = (c: Choice) => c.options.map(o => `${o.key}:${o.label}`);
const lastSent = (h: Harness) => h.sent[h.sent.length - 1];

async function menu(h: Harness, conversation: ChoiceConversation = DM): Promise<Choice> {
  const outcome = await h.rc.offerMenu(conversation, HC);
  if (outcome.status !== "sent") throw new Error(`Menü nicht gesendet: ${outcome.status}`);
  return outcome.choice;
}

describe("Register", () => {
  test("Art routine, ref ist die Routinen-ID, die Stufe steht dauerhaft in action", async () => {
    const h = harness();
    const m = await menu(h);
    const disk = JSON.parse(readFileSync(file, "utf-8")).choices[m.id];
    expect(disk).toMatchObject({ kind: "routine", ref: HC, action: "menu", state: "open" });
  });
});

describe("Menü je Zustand", () => {
  test("aktiv: Jetzt testen und Pausieren", async () => {
    const m = await menu(harness());
    expect(labels(m)).toEqual(["run:▶️ Jetzt testen", "pause:⏸️ Pausieren"]);
    expect(m.text).toBe("health-check (aktiv): Was soll passieren?");
  });

  test("pausiert: Fortsetzen", async () => {
    const m = await menu(harness(standardLaunchd({ health: { disabled: true, loaded: false } })));
    expect(labels(m)).toEqual(["resume:▶️ Fortsetzen"]);
  });

  test("Bot-Dienst, Dauerdienst und unbekannte Routine: kein Menü", async () => {
    const h = harness();
    for (const id of ["ai.tybo.telegram-relay", "ai.tybo.web-proxy", "ai.tybo.gibts-nicht", "com.other.app"]) {
      expect((await h.rc.offerMenu(DM, id)).status).toBe("none");
    }
    expect(h.sent).toEqual([]);
    expect(await listChoices()).toEqual([]);
  });

  test("zweites Menü derselben Routine im selben Gespräch: das erste läuft ab, nur eins bleibt offen", async () => {
    const h = harness();
    const first = await menu(h);
    const second = await menu(h);
    expect((await getChoice(first.id))?.state).toBe("expired");
    const open = (await listChoices()).filter(c => c.state === "open");
    expect(open.map(c => c.id)).toEqual([second.id]);
  });

  test("zwei Menüs gleichzeitig (etwa Wrapper und Bot): nur eins bleibt offen", async () => {
    const h = harness();
    // Zweite Instanz wie ein zweiter Prozess, dasselbe Register
    const other = harness();
    const outcomes = await Promise.all([h.rc.offerMenu(DM, HC), other.rc.offerMenu(DM, HC), h.rc.offerMenu(DM, HC), other.rc.offerMenu(DM, HC)]);
    expect(outcomes.every(o => o.status === "sent")).toBe(true);
    const open = (await listChoices()).filter(c => c.state === "open" && c.ref === HC && c.action === "menu");
    expect(open).toHaveLength(1);
  });

  test("Menü nirgends zustellbar: läuft gleich wieder ab", async () => {
    const h = harness(standardLaunchd(), { sendFails: true });
    expect((await h.rc.offerMenu(DM, HC)).status).toBe("failed");
    expect((await listChoices()).every(c => c.state === "expired")).toBe(true);
  });
});

describe("Rückfrage vor Pausieren", () => {
  test("Pausieren fragt erst nach, erst yes handelt; Meldung nennt den neu gelesenen Zustand", async () => {
    const h = harness();
    const m = await menu(h);
    await decideChoice(m.id, "pause", "telegram");
    expect(h.launchd.mutations()).toEqual([]);
    const confirm = lastSent(h);
    expect(confirm.text).toBe("health-check wirklich pausieren? Sie läuft dann nicht mehr, bis du fortsetzt.");
    expect(labels(confirm)).toEqual(["yes:Ja, pausieren", "no:Abbrechen"]);
    expect(confirm).toMatchObject({ kind: "routine", ref: HC, action: "pause", conversation: DM });

    await decideChoice(confirm.id, "yes", "telegram");
    expect(h.launchd.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`]);
    expect(h.notes.at(-1)).toEqual({ conversation: DM, text: "⏸️ health-check ist pausiert. Nächster Lauf: keiner, bis du fortsetzt." });
  });

  test("no ändert nichts", async () => {
    const h = harness();
    await decideChoice((await menu(h)).id, "pause", "telegram");
    await decideChoice(lastSent(h).id, "no", "telegram");
    expect(h.launchd.mutations()).toEqual([]);
    expect(h.notes.at(-1)?.text).toBe(ROUTINE_CHOICE_TEXT.cancelled("health-check"));
    expect(h.launchd.services.get(HC)).toMatchObject({ disabled: false, loaded: true });
  });

  test("Fortsetzen ohne Bestätigung handelt nicht", async () => {
    const h = harness(standardLaunchd({ health: { disabled: true, loaded: false } }));
    await decideChoice((await menu(h)).id, "resume", "telegram");
    expect(h.launchd.mutations()).toEqual([]);
    const confirm = lastSent(h);
    expect(confirm.action).toBe("resume");
    expect(labels(confirm)).toEqual(["yes:Ja, fortsetzen", "no:Abbrechen"]);
    await decideChoice(confirm.id, "yes", "telegram");
    expect(h.launchd.mutations()).toEqual([`enable gui/501/${HC}`, `bootstrap gui/501 /Users/alex/Library/LaunchAgents/${HC}.plist`]);
    expect(h.notes.at(-1)?.text).toBe("▶️ health-check ist wieder aktiv. Nächster Lauf: morgen 03:30.");
  });

  test("Jetzt testen fragt nicht nach", async () => {
    const h = harness();
    await decideChoice((await menu(h)).id, "run", "telegram");
    expect(h.launchd.mutations()).toEqual([`kickstart gui/501/${HC}`]);
    expect(h.notes.at(-1)?.text).toContain("health-check gestartet");
    expect(h.sent).toHaveLength(1);
  });
});

describe("genau einmal", () => {
  test("doppelter Klick wirkt einmal", async () => {
    const h = harness();
    await decideChoice((await menu(h)).id, "pause", "telegram");
    const confirm = lastSent(h);
    const [a, b] = await Promise.all([decideChoice(confirm.id, "yes", "telegram"), decideChoice(confirm.id, "yes", "web")]);
    expect([a.status, b.status].sort()).toEqual(["already", "decided"]);
    expect(h.launchd.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`]);
  });

  test("alter Knopf einer inzwischen pausierten Routine meldet „ist schon pausiert“ ohne launchctl", async () => {
    const h = harness();
    const old = await menu(h);
    // Inzwischen pausiert (etwa im Terminal oder in einem anderen Gespräch)
    Object.assign(h.launchd.services.get(HC)!, { disabled: true, loaded: false });
    await decideChoice(old.id, "pause", "telegram");
    expect(h.notes.at(-1)?.text).toBe("health-check ist schon pausiert.");
    expect(h.launchd.mutations()).toEqual([]);
  });

  test("alte Rückfrage nach inzwischen erfolgter Pause: yes meldet „ist schon pausiert“", async () => {
    const h = harness();
    await decideChoice((await menu(h)).id, "pause", "telegram");
    const confirm = lastSent(h);
    Object.assign(h.launchd.services.get(HC)!, { disabled: true, loaded: false });
    await decideChoice(confirm.id, "yes", "telegram");
    expect(h.notes.at(-1)?.text).toBe("health-check ist schon pausiert.");
    expect(h.launchd.mutations()).toEqual([]);
  });

  test("nach einem Neustart steht fest, was yes bestätigt (pause und resume)", async () => {
    for (const [health, step, expected] of [
      [{}, "pause", ["disable", "bootout"]],
      [{ disabled: true, loaded: false }, "resume", ["enable", "bootstrap"]],
    ] as const) {
      const launchd = standardLaunchd({ health });
      const before = harness(launchd);
      await decideChoice((await menu(before)).id, step, "telegram");
      const confirm = lastSent(before);
      // Neustart: alter Handler weg, neuer Prozess mit frischem Speicher
      cleanup.pop()!();
      const after = harness(launchd);
      await decideChoice(confirm.id, "yes", "telegram");
      expect(launchd.mutations().map(m => m.split(" ")[0])).toEqual([...expected]);
      expect(after.notes).toHaveLength(1);
    }
  });

  test("nach der Pause laufen andere offene Fragen der Routine ab (etwa ein Menü in einem Topic)", async () => {
    const h = harness();
    const topicMenu = await menu(h, { type: "telegram", chatId: "-100200", topicId: 7 });
    await decideChoice((await menu(h)).id, "pause", "telegram");
    await decideChoice(lastSent(h).id, "yes", "telegram");
    expect((await getChoice(topicMenu.id))?.state).toBe("expired");
  });
});

describe("Reiter „Routinen“ und Register", () => {
  test("pause und resume ohne confirm ändern nichts", async () => {
    const h = harness();
    expect(await h.rc.fromSettings(HC, "pause", false, req())).toEqual({ status: "confirm-required" });
    expect(await h.rc.fromSettings(HC, "resume", false, req())).toEqual({ status: "confirm-required" });
    expect(h.launchd.mutations()).toEqual([]);
  });

  test("offene Rückfrage derselben Aktion wird im Register entschieden (Telegram zeigt sie als erledigt)", async () => {
    const h = harness(standardLaunchd({ health: { disabled: true, loaded: false } }));
    await decideChoice((await menu(h)).id, "resume", "telegram");
    const confirm = lastSent(h);
    const outcome = await h.rc.fromSettings(HC, "resume", true, req());
    expect(outcome).toMatchObject({ status: "acted", result: { status: "done", state: "active" } });
    expect(await getChoice(confirm.id)).toMatchObject({ state: "done", result: { key: "yes", via: "web" } });
    expect(h.launchd.mutations().map(m => m.split(" ")[0])).toEqual(["enable", "bootstrap"]);
  });

  test("Browser und Telegram gleichzeitig, dazu eine HTTP-Wiederholung: nur eine Pause", async () => {
    const h = harness();
    await decideChoice((await menu(h)).id, "pause", "telegram");
    const confirm = lastSent(h);
    const key = req();
    const results = await Promise.all([
      h.rc.fromSettings(HC, "pause", true, key),
      decideChoice(confirm.id, "yes", "telegram"),
      h.rc.fromSettings(HC, "pause", true, key),
    ]);
    await h.rc.settled();
    expect(h.launchd.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`]);
    const texts = [results[0], results[2]].map(r => (r as any).result.text);
    expect(texts.filter(t => t.startsWith("⏸️")).length + h.notes.filter(n => n.text.startsWith("⏸️")).length).toBe(1);
  });

  test("Sperren gelten auch hier: Bot-Dienst und Dauerdienste", async () => {
    const h = harness();
    for (const id of ["ai.tybo.telegram-relay", "ai.tybo.web-proxy"]) {
      for (const action of ["pause", "resume", "run"] as const) {
        const outcome = await h.rc.fromSettings(id, action, true, req());
        expect(outcome).toMatchObject({ status: "acted", result: { status: "blocked" } });
      }
    }
    expect(h.launchd.mutations()).toEqual([]);
  });

  test("unbekannte Routine: nichts aufgerufen", async () => {
    const h = harness();
    const outcome = await h.rc.fromSettings("com.other.app", "run", false, req());
    expect(outcome).toMatchObject({ status: "acted", result: { status: "unknown" } });
    expect(h.launchd.mutations()).toEqual([]);
  });
});

describe("Auftragskennung: dieselbe HTTP-Aktion handelt nur einmal", () => {
  test("run wiederholt, nachdem der erste kurze Lauf schon fertig ist: kein zweiter Start", async () => {
    const h = harness();
    const key = req();
    const first = await h.rc.fromSettings(HC, "run", false, key);
    expect(first).toMatchObject({ status: "acted", result: { status: "done" } });
    // Der kurze Lauf ist vorbei: ohne Kennung würde ein zweiter kickstart starten
    h.launchd.services.get(HC)!.pid = null;
    const again = await h.rc.fromSettings(HC, "run", false, key);
    expect(again).toMatchObject({ status: "acted", result: { status: "already", text: ROUTINE_CHOICE_TEXT.duplicate("health-check"), state: "active" } });
    expect(h.launchd.mutations()).toEqual([`kickstart gui/501/${HC}`]);
    // Ein neuer Klick (neue Kennung) startet wieder
    await h.rc.fromSettings(HC, "run", false, req());
    expect(h.launchd.mutations()).toEqual([`kickstart gui/501/${HC}`, `kickstart gui/501/${HC}`]);
  });

  test("alter pause-POST nach zwischenzeitlichem Fortsetzen: pausiert nicht wieder", async () => {
    const h = harness();
    const pause = req();
    expect(await h.rc.fromSettings(HC, "pause", true, pause)).toMatchObject({ result: { status: "done", state: "paused" } });
    expect(await h.rc.fromSettings(HC, "resume", true, req())).toMatchObject({ result: { status: "done", state: "active" } });
    const late = await h.rc.fromSettings(HC, "pause", true, pause);
    expect(late).toMatchObject({ result: { status: "already", state: "active" } });
    expect(h.launchd.mutations().map(m => m.split(" ")[0])).toEqual(["disable", "bootout", "enable", "bootstrap"]);
  });

  test("alter resume-POST nach zwischenzeitlichem Pausieren: setzt nicht wieder fort", async () => {
    const h = harness(standardLaunchd({ health: { disabled: true, loaded: false } }));
    const resume = req();
    await h.rc.fromSettings(HC, "resume", true, resume);
    await h.rc.fromSettings(HC, "pause", true, req());
    expect(await h.rc.fromSettings(HC, "resume", true, resume)).toMatchObject({ result: { status: "already", state: "paused" } });
    expect(h.launchd.mutations().map(m => m.split(" ")[0])).toEqual(["enable", "bootstrap", "disable", "bootout"]);
  });

  test("nach einem Neustart (neue Instanz, dasselbe Register): alte Kennungen handeln nicht mehr", async () => {
    const launchd = standardLaunchd();
    const before = harness(launchd);
    const pause = req();
    const run = req();
    await before.rc.fromSettings(HC, "run", false, run);
    launchd.services.get(HC)!.pid = null;
    await before.rc.fromSettings(HC, "pause", true, pause);
    await before.rc.fromSettings(HC, "resume", true, req());
    for (const off of cleanup.splice(0)) off();
    // Neustart: Kennungen stehen in der Datei, nicht im Speicher
    expect(Object.keys(JSON.parse(readFileSync(file, "utf-8")).requests)).toContain(pause);
    const after = harness(launchd);
    expect(await after.rc.fromSettings(HC, "pause", true, pause)).toMatchObject({ result: { status: "already", state: "active" } });
    expect(await after.rc.fromSettings(HC, "run", false, run)).toMatchObject({ result: { status: "already" } });
    expect(launchd.mutations().map(m => m.split(" ")[0])).toEqual(["kickstart", "disable", "bootout", "enable", "bootstrap"]);
  });

  test("Register nicht beschreibbar: nichts ausgeführt", async () => {
    const launchd = standardLaunchd();
    const rc = createRoutineChoices({
      routines: launchd.deps,
      sendChoice: async () => ({ sent: true }),
      notify: async () => {},
      claimRequest: async () => {
        throw new Error("kaputt");
      },
      log: () => {},
    });
    expect(await rc.fromSettings(HC, "run", false, req())).toMatchObject({ result: { status: "failed", text: ROUTINE_CHOICE_TEXT.requestFailed("health-check") } });
    expect(launchd.mutations()).toEqual([]);
  });
});

describe("Pausieren nur zum Teil geklappt (disable ja, bootout nein)", () => {
  test("erneut über die API: vervollständigt, nicht „schon pausiert“", async () => {
    const h = harness();
    h.launchd.fail.add("bootout");
    expect(await h.rc.fromSettings(HC, "pause", true, req())).toMatchObject({ result: { status: "partial" } });
    h.launchd.fail.delete("bootout");
    const again = await h.rc.fromSettings(HC, "pause", true, req());
    expect(again).toMatchObject({ result: { status: "done", text: ACTION_TEXT.pauseCompleted("health-check") } });
    expect(h.launchd.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`, `bootout gui/501/${HC}`]);
  });

  test("erneut über das Register: altes Menü fragt nach statt „schon pausiert“, „Ja“ vervollständigt", async () => {
    const h = harness();
    const old = await menu(h);
    h.launchd.fail.add("bootout");
    await h.rc.fromSettings(HC, "pause", true, req());
    h.launchd.fail.delete("bootout");
    // Das alte Menü lief mit der Änderung ab; ein neues bietet Pausieren weiter an
    expect((await getChoice(old.id))?.state).toBe("expired");
    const fresh = await menu(h);
    expect(labels(fresh)).toEqual(["resume:▶️ Fortsetzen", "pause:⏸️ Pausieren"]);
    await decideChoice(fresh.id, "pause", "telegram");
    expect(h.notes.map(n => n.text)).not.toContain(ACTION_TEXT.alreadyPaused("health-check"));
    const confirm = lastSent(h);
    expect(confirm.action).toBe("pause");
    await decideChoice(confirm.id, "yes", "telegram");
    expect(h.notes.at(-1)?.text).toBe(ACTION_TEXT.pauseCompleted("health-check"));
    expect(h.launchd.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`, `bootout gui/501/${HC}`]);
  });

  test("bootout scheitert wieder: der Teilzustand wird ausdrücklich gemeldet", async () => {
    const h = harness();
    h.launchd.fail.add("bootout");
    await h.rc.fromSettings(HC, "pause", true, req());
    await decideChoice((await menu(h)).id, "pause", "telegram");
    await decideChoice(lastSent(h).id, "yes", "telegram");
    expect(h.notes.at(-1)?.text).toBe(ACTION_TEXT.pausePartial("health-check"));
  });
});

describe("Kanäle", () => {
  function port(userId: string) {
    return createChoicePort({ register, userId, groupId: () => "-100200", every: () => () => {}, log: () => {} });
  }

  test("Browser: nur aus dem eigenen Gespräch entscheidbar, fremdes Gespräch ändert nichts", async () => {
    const h = harness();
    const m = await menu(h);
    const p = port("123456");
    expect(await p.decide("topic-5", m.id, "pause", "web")).toEqual({ status: "not_found" });
    expect((await getChoice(m.id))?.state).toBe("open");
    expect((await p.decide("dm", m.id, "pause", "web")).status).toBe("decided");
    expect(lastSent(h).action).toBe("pause");
    expect(h.launchd.mutations()).toEqual([]);
  });

  test("Terminal-Auswahl wie im Browser", async () => {
    const h = harness();
    const p = port("123456");
    await p.decide("dm", (await menu(h)).id, "pause", "terminal");
    expect((await p.decide("dm", lastSent(h).id, "yes", "terminal")).status).toBe("decided");
    expect(h.launchd.mutations().map(m => m.split(" ")[0])).toEqual(["disable", "bootout"]);
  });

  test("ohne Telegram: Direktchat web, Menü und Rückfrage über die WebUI", async () => {
    const h = harness();
    const web = routineConversation("web")!;
    expect(web).toEqual({ type: "telegram", chatId: "web" });
    const p = port("web");
    await p.decide("dm", (await menu(h, web)).id, "pause", "web");
    await p.decide("dm", lastSent(h).id, "yes", "web");
    expect(h.notes.at(-1)).toEqual({ conversation: web, text: "⏸️ health-check ist pausiert. Nächster Lauf: keiner, bis du fortsetzt." });
  });

  test("reines Web-Gespräch: Gespräch aus web:<uuid>", () => {
    const id = "0b5e4c8a-1d2f-4a3b-9c8d-7e6f5a4b3c2d";
    expect(routineConversation(`web:${id}`)).toEqual({ type: "web", conversationId: id });
    expect(routineConversation("-100200", 7)).toEqual({ type: "telegram", chatId: "-100200", topicId: 7 });
    expect(routineConversation("irgendwas")).toBeNull();
  });
});

describe("Log", () => {
  test("nur Routinen-ID, Aktion und Kanal: keine Frage-IDs, Auswahlen, Ergebnisse oder Texte", async () => {
    const h = harness();
    const m = await menu(h);
    await decideChoice(m.id, "pause", "telegram");
    const confirm = lastSent(h);
    await decideChoice(confirm.id, "yes", "web");
    await h.rc.fromSettings(HC, "resume", true, req());
    await h.rc.fromSettings(HC, "run", false, req());
    const allowed = /^\[routinen\] ai\.tybo\.health-check (run|pause|resume) \((telegram|web|terminal)\)$/;
    for (const line of h.logs) {
      expect(line).toMatch(allowed);
      for (const forbidden of [m.id, confirm.id, "yes", "menu", "done", "partial", "failed", "wirklich", "Nächster Lauf"]) expect(line).not.toContain(forbidden);
    }
    expect(h.logs).toEqual([
      `[routinen] ${HC} pause (telegram)`,
      `[routinen] ${HC} pause (web)`,
      `[routinen] ${HC} pause (web)`,
      `[routinen] ${HC} resume (web)`,
      `[routinen] ${HC} run (web)`,
    ]);
  });

  /** Jede Zeile genau Routinen-ID, Aktion und Kanal, auch auf Fehlerwegen */
  const strict = /^\[routinen\] ai\.tybo\.health-check (run|pause|resume|menu) \((telegram|web|terminal)\)$/;
  const FORBIDDEN = ["TypeError", "SyntaxError", "RangeError", "EvalError", "Netz", "kaputt", "voll", "weg", "nicht", "gescheitert", ":", "yes", "done", "failed"];
  function expectStrict(logs: string[], extra: string[] = []) {
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).toMatch(strict);
      for (const forbidden of [...FORBIDDEN, ...extra]) expect(line.slice("[routinen] ".length + HC.length)).not.toContain(forbidden);
    }
  }

  test("Fehlerwege (Versand, Register, Auftrag, Meldung ohne Knöpfe): genau Routinen-ID, Aktion und Kanal", async () => {
    const logs: string[] = [];
    const launchd = standardLaunchd();
    const rc = createRoutineChoices({
      routines: launchd.deps,
      sendChoice: async () => {
        throw new TypeError("Netz weg");
      },
      notify: async () => {},
      listChoices: async () => {
        throw new SyntaxError("kaputt");
      },
      log: line => logs.push(line),
    });
    await rc.offerMenu(DM, HC);
    expect(logs).toEqual([`[routinen] ${HC} menu (telegram)`]);
    logs.length = 0;
    await rc.fromSettings(HC, "pause", true, req());
    // Register nicht lesbar (Suche nach offener Rückfrage), Aktion, Register nicht lesbar (Ablauf danach)
    expect(logs).toEqual([`[routinen] ${HC} pause (web)`, `[routinen] ${HC} pause (web)`, `[routinen] ${HC} pause (web)`]);
    logs.length = 0;
    await menuAlertSender(async () => ({ sent: true }), async () => {
      throw new RangeError("x");
    }, line => logs.push(line), () => "web")("Text", { id: HC, kind: "failed" });
    await menuAlertSender(async () => ({ sent: true }), async () => ({ status: "unknown" }), line => logs.push(line))("Text", { id: HC, kind: "missed" });
    expect(logs).toEqual([`[routinen] ${HC} menu (web)`, `[routinen] ${HC} menu (telegram)`]);
    expectStrict(logs);
  });

  test("Auftrag nicht festhaltbar, Meldung scheitert, Ablauf scheitert, Web-Gespräch nicht erreichbar: dieselbe strenge Form", async () => {
    const logs: string[] = [];
    const web: ChoiceConversation = { type: "web", conversationId: "0b5e4c8a-1d2f-4a3b-9c8d-7e6f5a4b3c2d" };
    const launchd = standardLaunchd();
    const sent: Choice[] = [];
    const rc = createRoutineChoices({
      routines: launchd.deps,
      sendChoice: async c => (sent.push(c), { sent: true }),
      postWeb: async () => {
        throw new EvalError("weg");
      },
      notify: async () => {
        throw new TypeError("Netz weg");
      },
      expireChoice: async () => {
        throw new RangeError("voll");
      },
      claimRequest: async () => {
        throw new SyntaxError("kaputt");
      },
      log: line => logs.push(line),
    });
    cleanup.push(onChoiceDecided("routine", rc.handler));
    // Auftrag ließ sich nicht festhalten
    await rc.fromSettings(HC, "run", false, req());
    expect(logs).toEqual([`[routinen] ${HC} run (web)`]);
    logs.length = 0;
    // Web-Gespräch wirft, Kopie geht über sendChoice
    const m = await rc.offerMenu(web, HC);
    expect(m.status).toBe("sent");
    expect(logs).toEqual([`[routinen] ${HC} menu (web)`]);
    logs.length = 0;
    // Rückfrage: Web wirft wieder; Ja: Aktion, Ablauf offener Fragen scheitert, Meldung scheitert
    await decideChoice(sent[0].id, "pause", "telegram");
    await decideChoice(sent[1].id, "yes", "telegram");
    await rc.settled();
    expect(launchd.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`]);
    expect(new Set(logs)).toEqual(new Set([`[routinen] ${HC} pause (telegram)`, `[routinen] ${HC} pause (web)`]));
    expectStrict(logs, [sent[0].id, sent[1].id]);
  });
});
