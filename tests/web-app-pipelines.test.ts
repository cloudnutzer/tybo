/** Oberfläche mit DOM und kontrollierter Uhr; kein echter Statusdienst. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDemoPipelines } from "../src/web/demo";
import { createPipelinesApi, PIPELINES_EMPTY } from "../src/web/pipelines";
const source = await readFile(join(import.meta.dir, "../src/web/public/pipelines.js"), "utf8");
type El = { [key: string]: any };

async function setup() {
  let document: any;
  function node(tag = "div"): El {
    return { tag, children: [], attrs: {}, events: {}, hidden: false, open: false, className: "", _text: "", scrollTop: 0,
      get textContent() { return this._text + this.children.map((c: El) => c.textContent).join(" "); },
      set textContent(value) { this._text = value; this.children = []; },
      set innerHTML(_value) { throw new Error("Freitext darf nie HTML werden"); },
      appendChild(c: El) { this.children.push(c); return c; },
      setAttribute(k: string, v: string) { this.attrs[k] = v; }, getAttribute(k: string) { return this.attrs[k] ?? null; }, removeAttribute(k: string) { delete this.attrs[k]; },
      addEventListener(k: string, f: () => void) { this.events[k] = f; }, focus() { document.activeElement = this; },
      click() { this.events.click?.(); },
      querySelectorAll(selector: string): El[] {
        return this.children.flatMap((c: El) => {
          const match = selector.startsWith("[") ? c.attrs[selector.slice(1, -1)] !== undefined : selector.startsWith(".") ? c.className.split(" ").includes(selector.slice(1)) : c.tag === selector;
          return [...(match ? [c] : []), ...c.querySelectorAll(selector)];
        });
      },
      querySelector(selector: string): El | null { return this.querySelectorAll(selector)[0] ?? null; },
    };
  }
  const elements: Record<string, El> = Object.fromEntries(["pipelines-view", "pipelines-body", "pipelines-title", "pipelines-status", "pipelines-count", "open-pipelines"].map(id => [id, node()]));
  const scroll = node(); scroll.className = "settings-scroll"; elements["pipelines-view"].appendChild(scroll);
  document = { getElementById: (id: string) => elements[id], createElement: node, visibilityState: "visible", activeElement: null };
  const window: any = {};
  let now = Date.now(), timer = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>();
  new Function("window", "document", "setTimeout", "clearTimeout", source)(window, document,
    (fn: () => void, delay: number) => { timers.set(++timer, { fn, delay }); return timer; }, (id: number) => timers.delete(id));
  const demo = createDemoPipelines(now);
  const data: any = (await createPipelinesApi(demo, async () => "Pipeline").get()).body;
  data.generatedAt = new Date(now).toISOString();
  const calls: any[] = [];
  let response: (() => any) | null = null;
  const view = window.TyboPipelines.create({ now: () => now,
    api: async (method: string, path: string) => { calls.push({ method, path }); return response ? response() : { ok: true, data: structuredClone(data) }; },
    openConversation: (id: string) => calls.push({ open: id }),
  });
  const body = elements["pipelines-body"];
  const find = (key: string) => body.querySelectorAll("[data-pipeline-focus]").find(n => n.attrs["data-pipeline-focus"] === key)!;
  const details = (key: string) => body.querySelectorAll("details").find(n => n.children[0].attrs["data-pipeline-focus"] === key)!;
  return { view, elements, body, data, calls, document, timers, find, details, scroll,
    respond(fn: typeof response) { response = fn; }, advance(ms: number) { now += ms; },
    tick() { const t = [...timers.values()].find(t => t.delay === 1000); expect(t).toBeDefined(); t!.fn(); }, age: window.TyboPipelines.age };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test("vier Zustände, Wartezähler, Wächterstopp, Ruhe eingeklappt, nur Gespräch als Aktion", async () => {
  const a = await setup(); a.view.show(); await settle();
  expect(a.elements["open-pipelines"].hidden).toBe(false);
  expect(a.elements["pipelines-count"].textContent).toBe("1");
  expect(a.elements["pipelines-count"].attrs["data-waiting"]).toBe("true");
  expect(a.body.querySelectorAll(".pipeline-item").map(n => n.attrs["data-state"])).toEqual(["waiting", "halted", "running", "resting"]);
  expect(a.body.textContent).toContain("Pipelines gestoppt: Die Wächter sind aus");
  expect(a.body.textContent).toContain("wartet seit 1 Tag 3 Std");
  expect(a.body.textContent).toContain("zuletzt: wartet auf dich");
  expect(a.details("resting").open).toBe(false);
  expect(a.body.querySelectorAll("button").every(n => n.textContent === "Zum Gespräch")).toBe(true);
  a.find("demo-waiting:open").click(); expect(a.calls.at(-1)).toEqual({ open: "topic-60" });
  expect(a.find("demo-resting:open")).toBeUndefined();
  expect(a.calls.some(c => c.method && c.method !== "GET")).toBe(false);
});

test("Frage als Klartext, Vorschau begrenzt; Abgleich bewahrt Frage, Ereignisse, Ruhe, Fokus und Scrollposition", async () => {
  const a = await setup(); a.data.pipelines[0].question.text = "<script>alert(1)</script> " + "Frage ".repeat(50);
  a.view.show(); await settle();
  expect(a.body.textContent).toContain("<script>alert(1)</script>");
  expect(a.body.querySelectorAll(".pipeline-preview")[0].textContent.length).toBeLessThanOrEqual(150);
  for (const key of ["demo-waiting:question", "demo-waiting:events", "resting"]) { const d = a.details(key); d.open = true; d.events.toggle(); }
  a.find("demo-waiting:question").focus(); a.scroll.scrollTop = 234;
  a.data.generatedAt = new Date(Date.now() + 100).toISOString(); await a.view.load();
  expect(a.details("demo-waiting:question").open).toBe(true);
  expect(a.details("demo-waiting:events").open).toBe(true);
  expect(a.details("resting").open).toBe(true);
  expect(a.document.activeElement.attrs["data-pipeline-focus"]).toBe("demo-waiting:question");
  expect(a.scroll.scrollTop).toBe(234);
});

test("fehlende Datei blendet den Eintrag aus, laufende zählen nur ohne Wartende", async () => {
  const a = await setup(); await a.view.load();
  a.data.waiting = 0; await a.view.load();
  expect(a.elements["pipelines-count"].textContent).toBe("1");
  expect(a.elements["pipelines-count"].attrs["data-waiting"]).toBe("false");
  a.respond(() => ({ ok: true, data: PIPELINES_EMPTY })); a.view.show(); await settle();
  expect(a.elements["open-pipelines"].hidden).toBe(true);
  expect(a.elements["pipelines-count"].hidden).toBe(true);
  expect(a.body.textContent).toContain("Keine Pipelines vorhanden.");
});

test("altert während eines hängenden Abrufs selbst, auch der Zähler verliert die Hervorhebung", async () => {
  const a = await setup(); a.view.show(); await settle();
  a.respond(() => new Promise(() => {})); void a.view.load();
  a.advance(5 * 60_000 + 1); a.tick();
  expect(a.elements["pipelines-status"].textContent).toContain("der Statusdienst läuft nicht");
  expect(a.elements["pipelines-status"].attrs["data-stale"]).toBe("true");
  expect(a.elements["pipelines-count"].attrs["data-waiting"]).toBe("false");
  expect(a.elements["open-pipelines"].hidden).toBe(false);
  expect(a.body.textContent).toContain("Letzter bekannter Stand: Pipelines gestoppt");
  expect(a.body.textContent).toContain("wartet seit 1 Tag 3 Std");
  a.view.stop(); expect(a.timers.size).toBe(0);
});

test("Fehler behält den letzten Stand, neutralisiert den Zähler und bietet erneutes Laden", async () => {
  const a = await setup(); a.view.show(); await settle();
  a.respond(() => ({ ok: false, data: { error: "Status nicht lesbar" } })); await a.view.load();
  expect(a.body.textContent).toContain("Der letzte bekannte Stand bleibt sichtbar.");
  expect(a.body.textContent).toContain("Lesegarten");
  expect(a.elements["pipelines-count"].attrs["data-waiting"]).toBe("false");
  a.respond(null); a.find("retry").click(); await settle();
  expect(a.body.textContent).not.toContain("Status nicht lesbar");
  expect(a.elements["pipelines-count"].attrs["data-waiting"]).toBe("true");
});

test("Frage verschwindet auch ohne neue Antwort nach 14 Tagen", async () => {
  const a = await setup();
  a.data.pipelines[0].question.at = new Date(Date.parse(a.data.generatedAt) - 14 * 24 * 3_600_000 + 1000).toISOString();
  a.view.show(); await settle();
  expect(a.details("demo-waiting:question")).toBeDefined();
  a.respond(() => new Promise(() => {})); void a.view.load();
  a.advance(1001); a.tick();
  expect(a.details("demo-waiting:question")).toBeUndefined();
  a.view.stop();
});

test("ältere Netzantwort überschreibt nie neuere, Timer pausieren im Hintergrund und beim Verlassen", async () => {
  const a = await setup(); let release!: (value: unknown) => void;
  a.respond(() => new Promise(resolve => { release = resolve; })); const old = a.view.load();
  a.respond(() => ({ ok: true, data: PIPELINES_EMPTY })); await a.view.load();
  release({ ok: true, data: a.data }); await old;
  expect(a.elements["open-pipelines"].hidden).toBe(true);
  a.document.visibilityState = "hidden"; a.view.visibility(); expect(a.timers.size).toBe(0);
  a.document.visibilityState = "visible"; a.view.visibility(); await settle();
  expect([...a.timers.values()].some(t => t.delay === 30_000)).toBe(true);
  a.view.show(); await settle(); expect([...a.timers.values()].some(t => t.delay === 10_000)).toBe(true);
  a.view.stop(); expect(a.timers.size).toBe(0);
});

test("Dauer kennt Tage und ungültige Zeitstempel", async () => {
  const a = await setup(), now = Date.now();
  expect(a.age("kaputt", now)).toBe("");
  expect(a.age(new Date(now - 50_000).toISOString(), now)).toBe("weniger als 1 Min");
  expect(a.age(new Date(now - 51 * 3_600_000).toISOString(), now)).toBe("2 Tagen 3 Std");
});
