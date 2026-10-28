/**
 * Issue #288, Checkbox 4: POST /api/routines/<id>/<aktion> über den Server.
 * Quelle ist dieselbe Entscheidung wie in Telegram (createRoutineChoices mit
 * echtem Register in eigener Datei) über launchd als Attrappe; nie launchctl.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, getChoice, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { createRoutineChoices, ROUTINE_CHOICE_TEXT } from "../src/lib/routine-choices";
import { menuActions } from "../src/lib/routines/actions";
import { listRoutines, routineHistory } from "../src/lib/routines/catalog";
import type { Routine } from "../src/lib/routines/types";
import { createDemoRoutines } from "../src/web/demo";
import { createRoutinesApi, ROUTINE_API_FIELDS, ROUTINES_API_TEXT, type RoutinesPort } from "../src/web/routines";
import type { WebServer } from "../src/web/server";
import { standardLaunchd, type FakeLaunchd } from "./routine-actions-fixture";
import { topicServer } from "./topic-fixture";

const HC = "ai.tybo.health-check";
const root = await mkdtemp(join(tmpdir(), "routine-actions-api-"));
afterAll(async () => {
  setChoicesFileForTests(null);
  await rm(root, { recursive: true, force: true });
});
const servers: WebServer[] = [];
let cleanup: (() => void)[] = [];
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  setChoicesFileForTests(join(root, `choices-${++counter}.json`));
  cleanup = [];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  for (const off of cleanup) off();
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  logSpy.mockRestore();
});

/** Wie createBotRoutines in src/web/bot-routines.ts, mit der Attrappe statt echter Befehle */
function botLikePort(launchd: FakeLaunchd) {
  const sent: Choice[] = [];
  const rc = createRoutineChoices({ routines: launchd.deps, sendChoice: async c => (sent.push(c), { sent: true }), notify: async () => {}, log: () => {} });
  cleanup.push(onChoiceDecided("routine", rc.handler));
  const withActions = (r: Routine) => ({ ...r, actions: menuActions(r) });
  const port: RoutinesPort = {
    home: launchd.deps.home,
    list: async () => {
      const l = await listRoutines(launchd.deps);
      return { ...l, routines: l.routines.map(withActions) };
    },
    runs: async id => {
      const h = await routineHistory(launchd.deps, id, "id");
      return h ? { ...h, routine: withActions(h.routine) } : null;
    },
    act: async (id, action, confirm, request) => {
      const o = await rc.fromSettings(id, action, confirm, request);
      if (o.status === "confirm-required") return o;
      return { status: o.result.status, text: o.result.text, routine: o.result.routine ? withActions(o.result.routine) : null };
    },
  };
  return { port, rc, sent };
}

/** Neue Auftragskennung wie aus dem Browser */
let requestCounter = 0;
const req = () => `api-auftrag-${String(++requestCounter).padStart(10, "0")}`;

describe("POST /api/routines/<id>/<aktion>", () => {
  test("ohne Anmeldung 401, nichts aufgerufen", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    const res = await fetch(`${ctx.origin}/api/routines/${HC}/pause`, { method: "POST", headers: { origin: ctx.origin }, body: JSON.stringify({ confirm: true, request: req() }) });
    expect(res.status).toBe(401);
    expect(l.calls).toEqual([]);
  });

  test("fremde Origin 403, nichts aufgerufen", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    const res = await ctx.api(`/api/routines/${HC}/pause`, "POST", { confirm: true, request: req() }, { origin: "https://boese.example" });
    expect(res.status).toBe(403);
    expect(l.calls).toEqual([]);
  });

  test("pause und resume ohne confirm werden abgelehnt", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    for (const action of ["pause", "resume"]) {
      for (const body of [undefined, {}, { confirm: "true" }, { confirm: 1 }, "kaputt{"]) {
        const res = await ctx.api(`/api/routines/${HC}/${action}`, "POST", body);
        expect(res.status).toBe(400);
      }
    }
    expect(l.mutations()).toEqual([]);
    const res = await ctx.api(`/api/routines/${HC}/pause`, "POST", {});
    expect((await res.json()).error).toBe(ROUTINES_API_TEXT.confirmRequired);
  });

  test("pause mit confirm: neu gelesener Zustand in der Antwort, nur erlaubte Felder", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    const res = await ctx.api(`/api/routines/${HC}/pause`, "POST", { confirm: true, request: req() });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("/Users/");
    const body = JSON.parse(raw);
    expect(body).toMatchObject({ status: "done", text: "⏸️ health-check ist pausiert. Nächster Lauf: keiner, bis du fortsetzt." });
    expect(Object.keys(body.routine).sort()).toEqual([...ROUTINE_API_FIELDS].sort());
    expect(body.routine).toMatchObject({ state: "paused", nextRun: null, actions: ["resume"] });
    expect(l.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`]);
  });

  test("HTTP-Wiederholung (zwei gleiche POSTs gleichzeitig): nur eine Pause, die zweite handelt nicht", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    const body = { confirm: true, request: req() };
    const [a, b] = await Promise.all([1, 2].map(() => ctx.api(`/api/routines/${HC}/pause`, "POST", body).then(r => r.json())));
    expect([a.text, b.text].sort()).toEqual([ROUTINE_CHOICE_TEXT.duplicate("health-check"), "⏸️ health-check ist pausiert. Nächster Lauf: keiner, bis du fortsetzt."].sort());
    expect(l.mutations()).toEqual([`disable gui/501/${HC}`, `bootout gui/501/${HC}`]);
  });

  test("Wiederholung von run nach Laufende: kein zweiter Start", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    const body = { request: req() };
    expect((await (await ctx.api(`/api/routines/${HC}/run`, "POST", body)).json()).status).toBe("done");
    l.services.get(HC)!.pid = null;
    const again = await (await ctx.api(`/api/routines/${HC}/run`, "POST", body)).json();
    expect(again).toMatchObject({ status: "already", text: ROUTINE_CHOICE_TEXT.duplicate("health-check"), routine: { state: "active" } });
    expect(l.mutations()).toEqual([`kickstart gui/501/${HC}`]);
  });

  test("alter pause-POST nach zwischenzeitlichem Fortsetzen und Neustart: pausiert nicht wieder", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    const pause = { confirm: true, request: req() };
    await ctx.api(`/api/routines/${HC}/pause`, "POST", pause);
    await ctx.api(`/api/routines/${HC}/resume`, "POST", { confirm: true, request: req() });
    // Neustart: neuer Server, neue Entscheidung, dasselbe Register
    for (const off of cleanup.splice(0)) off();
    for (const srv of servers.splice(0)) await srv.stop({ graceMs: 50 });
    const restarted = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    const late = await (await restarted.api(`/api/routines/${HC}/pause`, "POST", pause)).json();
    expect(late).toMatchObject({ status: "already", routine: { state: "active" } });
    expect(l.mutations().map(m => m.split(" ")[0])).toEqual(["disable", "bootout", "enable", "bootstrap"]);
  });

  test("ohne gültige Kennung: 400, nichts aufgerufen", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    for (const request of [undefined, "", "kurz", 42, "x".repeat(65), "mit leerzeichen 12345"]) {
      const res = await ctx.api(`/api/routines/${HC}/run`, "POST", { request });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(ROUTINES_API_TEXT.invalidRequest);
    }
    expect((await ctx.api(`/api/routines/${HC}/pause`, "POST", { confirm: true })).status).toBe(400);
    expect(l.calls).toEqual([]);
  });

  test("offene Rückfrage in Telegram: der Browser entscheidet sie, Telegram zeigt sie als erledigt", async () => {
    const l = standardLaunchd({ health: { disabled: true, loaded: false } });
    const { port, rc, sent } = botLikePort(l);
    const ctx = await topicServer(root, servers, null, { routines: port });
    const menu = await rc.offerMenu({ type: "telegram", chatId: "123456" }, HC);
    if (menu.status !== "sent") throw new Error("kein Menü");
    await decideChoice(menu.choice.id, "resume", "telegram");
    const confirm = sent.at(-1)!;
    const res = await ctx.api(`/api/routines/${HC}/resume`, "POST", { confirm: true, request: req() });
    expect((await res.json()).routine).toMatchObject({ state: "active", actions: ["run", "pause"] });
    expect(await getChoice(confirm.id)).toMatchObject({ state: "done", result: { key: "yes", via: "web" } });
    expect(l.mutations().map(m => m.split(" ")[0])).toEqual(["enable", "bootstrap"]);
  });

  test("run ohne confirm startet; läuft er schon: „läuft gerade“", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    expect((await (await ctx.api(`/api/routines/${HC}/run`, "POST", { request: req() })).json()).text).toContain("health-check gestartet");
    expect((await (await ctx.api(`/api/routines/${HC}/run`, "POST", { request: req() })).json()).text).toBe("health-check läuft gerade. Nichts neu gestartet.");
    expect(l.mutations()).toEqual([`kickstart gui/501/${HC}`]);
  });

  test("Bot-Dienst und Dauerdienste: 403 auf jedem Weg, unbekannt 404", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    for (const id of ["ai.tybo.telegram-relay", "ai.tybo.web-proxy"]) {
      for (const action of ["pause", "resume", "run"]) {
        expect((await ctx.api(`/api/routines/${id}/${action}`, "POST", { confirm: true, request: req() })).status).toBe(403);
      }
    }
    expect((await ctx.api(`/api/routines/com.other.app/run`, "POST", { request: req() })).status).toBe(404);
    expect(l.mutations()).toEqual([]);
  });

  test("ungültige Aktion, ungültige ID, GET: abgelehnt", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    expect((await ctx.api(`/api/routines/${HC}/stop`, "POST", { confirm: true, request: req() })).status).toBe(404);
    expect((await ctx.api(`/api/routines/..%2Fx/run`, "POST", { request: req() })).status).toBe(400);
    expect((await ctx.api(`/api/routines/${HC}/run`, "GET")).status).toBe(405);
    expect(l.mutations()).toEqual([]);
  });

  test("Liste nennt die Knöpfe je Routine", async () => {
    const l = standardLaunchd();
    const ctx = await topicServer(root, servers, null, { routines: botLikePort(l).port });
    const body = await (await ctx.api("/api/routines")).json();
    const actions = Object.fromEntries(body.routines.map((r: any) => [r.id, r.actions]));
    expect(actions).toEqual({ [HC]: ["run", "pause"], "ai.tybo.telegram-relay": [], "ai.tybo.web-proxy": [] });
  });

  test("ohne act in der Quelle: 503", async () => {
    const ctx = await topicServer(root, servers, null, { routines: { home: "/Users/alex", list: async () => ({ available: false, source: null, routines: [], notes: [] }) } });
    expect((await ctx.api(`/api/routines/${HC}/run`, "POST", { request: req() })).status).toBe(503);
  });
});

describe("Demo-Attrappe (web:dev)", () => {
  test("Aktionen ändern nur den Speicher", async () => {
    const demo = createDemoRoutines();
    expect(await demo.act!("ai.tybo.health-check", "pause", false)).toEqual({ status: "confirm-required" });
    expect(await demo.act!("ai.tybo.health-check", "pause", true)).toMatchObject({ status: "done", routine: { state: "paused", actions: ["resume"] } });
    expect((await demo.list()).routines.find(r => r.id === "ai.tybo.health-check")?.state).toBe("paused");
    expect(await demo.act!("ai.tybo.telegram-relay", "run", false)).toMatchObject({ status: "blocked" });
  });
});

describe("Log auf dem Fehlerweg der API", () => {
  test("Quelle wirft: 500 und genau eine Zeile mit Routinen-ID, Aktion und Kanal, ohne Fehlername oder -text", async () => {
    const logs: string[] = [];
    const port: RoutinesPort = {
      home: "/Users/test",
      list: async () => ({ source: "launchd", routines: [] }) as never,
      runs: async () => null,
      act: async () => {
        throw new TypeError("Netz weg");
      },
    };
    const api = createRoutinesApi(port, line => logs.push(line));
    for (const action of ["pause", "resume", "run"]) {
      const res = await api.act(HC, action, { confirm: true, request: req() });
      expect(res.status).toBe(500);
    }
    expect(logs).toEqual([`[routinen] ${HC} pause (web)`, `[routinen] ${HC} resume (web)`, `[routinen] ${HC} run (web)`]);
    for (const line of logs) expect(line).toMatch(/^\[routinen\] ai\.tybo\.health-check (run|pause|resume) \(web\)$/);
  });
});
