/** Jobs-Oberfläche mit DOM-, Netz- und Timerattrappen. Keine echten Jobs. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const source = await readFile(join(import.meta.dir, "../src/web/public/jobs.js"), "utf8");
type El = { [key: string]: any };
function setup() {
  let document: any;
  function node(tag = "div"): El {
    const n: El = { tag, children: [], attrs: {}, events: {}, hidden: false, disabled: false, className: "", _text: "", innerHTML: "",
      get textContent() { return this._text + this.children.map((c: El) => c.textContent).join(" "); },
      set textContent(v) { this._text = v; this.children = []; },
      appendChild(c: El) { this.children.push(c); return c; },
      setAttribute(k: string, v: string) { this.attrs[k] = v; }, getAttribute(k: string) { return this.attrs[k] ?? null; }, removeAttribute(k: string) { delete this.attrs[k]; },
      addEventListener(k: string, f: () => void) { this.events[k] = f; }, focus() { document.activeElement = this; },
      click() { if (!this.disabled) return this.events.click?.(); },
      querySelectorAll(selector: string): El[] {
        return this.children.flatMap((c: El) => [...((selector === "button" ? c.tag === "button" : c.attrs[selector.slice(1, -1)] !== undefined) ? [c] : []), ...c.querySelectorAll(selector)]);
      },
    };
    return n;
  }
  const elements: Record<string, El> = Object.fromEntries(["jobs-view", "jobs-body", "jobs-title", "jobs-status", "jobs-count", "open-jobs"].map(id => [id, node()]));
  document = { getElementById: (id: string) => elements[id], createElement: node, visibilityState: "visible", activeElement: null };
  const window: any = {};
  const timers = new Map<number, () => void>(); let timer = 0;
  new Function("window", "document", "setTimeout", "clearTimeout", source)(window, document, (fn: () => void) => { timers.set(++timer, fn); return timer; }, (id: number) => timers.delete(id));
  const jobs: any[] = [{ id: "20261118-120000-000626", title: "Recherche", phase: "waiting", status: "wartet auf dich", duration: "2 Min", run: 1, conversation: { id: "topic-31", name: "Strategie" }, actions: ["stop", "log", "report"],
    question: { number: 1, text: "<script>Frage</script>", context: "Kontext", answers: ["Ja"], conversationId: "topic-443", choice: { id: "JobFrage0001", state: "open", options: [{ key: "a1", label: "Ja" }] } } }];
  const calls: any[] = [];
  let request = 0;
  let response: ((method: string, path: string, body?: any) => any) | null = null;
  const deps: any = {
    api: async (method: string, path: string, body: any) => {
      calls.push({ method, path, body });
      if (response) return response(method, path, body);
      if (method === "POST") return { ok: true, data: { status: "done", text: "Erledigt" } };
      if (path.includes("/log?")) return { ok: true, data: { run: 1, text: "<script>Log</script>" } };
      if (path.includes("/report?")) return { ok: true, data: { run: 1, text: "Bericht", html: "<h2>Bericht</h2>" } };
      return { ok: true, data: { jobs: structuredClone(jobs), waiting: jobs.filter(j => j.phase === "waiting").length, running: jobs.filter(j => j.phase === "running").length } };
    },
    requestId: () => "request-test-" + String(++request).padStart(8, "0"), choicePending: new Set(), choiceErrors: new Map(), choiceNotices: new Map(), settledChoice: (c: any) => c,
    choiceElement: (c: any, ui: any) => { const box = node(); for (const o of c.options) { const b = node("button"); b.textContent = o.label; b.setAttribute("data-key", o.key); b.disabled = ui.pending.has(c.id); b.addEventListener("click", () => ui.pick(c.id, o.key)); box.appendChild(b); } return box; },
    openConversation: (id: string) => calls.push({ open: id }),
  };
  const view = window.TyboJobs.create(deps);
  const buttons = () => elements["jobs-body"].querySelectorAll("button");
  const click = (suffix: string) => { const b = buttons().find(b => (b.attrs["data-job-action"] || "").endsWith(suffix)); expect(b).toBeDefined(); b!.click(); };
  return { view, elements, calls, jobs, document, timers, buttons, click, respond: (fn: typeof response) => { response = fn; }, deps };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test("wartende Pille, nur gelieferte Aktionen, Frage als Text und Zielgespräch der Auswahl", async () => {
  const a = setup(); a.view.show(); await settle();
  expect(a.elements["jobs-count"].textContent).toBe("1");
  expect(a.elements["jobs-count"].attrs["data-waiting"]).toBe("true");
  expect(a.elements["jobs-body"].textContent).toContain("<script>Frage</script>");
  expect(a.buttons().some(b => b.textContent === "Fortsetzen")).toBe(false);
  a.buttons().find(b => b.attrs["data-key"] === "a1")!.click(); await settle();
  expect(a.calls.find(c => c.method === "POST")).toMatchObject({ path: "/api/conversations/topic-443/choices/JobFrage0001", body: { option: "a1" } });
  a.jobs[0].phase = "running"; a.jobs[0].question = null; await a.view.load();
  expect(a.elements["jobs-count"].attrs["data-waiting"]).toBe("false");
  a.jobs[0].phase = "ended"; await a.view.load(); expect(a.elements["jobs-count"].hidden).toBe(true);
});

test("Stoppen erst nach Bestätigung, Fokus auf Abbrechen, Kennung und Laufnummer, Doppelklick gesperrt", async () => {
  const a = setup(); a.view.show(); await settle();
  a.click(":stop"); expect(a.calls.some(c => c.method === "POST")).toBe(false);
  expect(a.document.activeElement.attrs["data-job-focus"]).toEndWith(":cancel");
  a.click(":cancel"); expect(a.calls.some(c => c.method === "POST")).toBe(false);
  a.click(":stop"); a.click(":confirm"); a.click(":confirm"); await settle();
  const posts = a.calls.filter(c => c.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({ confirm: true, expectedRun: 1, request: "request-test-00000001" });
});

test.each(["failed", "blocked"])("Fortsetzen nach Serverantwort %s verwendet bei gleichem Lauf eine neue Kennung", async status => {
  const a = setup();
  Object.assign(a.jobs[0], { phase: "ended", status: "abgebrochen", question: null, actions: ["resume"] });
  a.respond(method => method === "POST"
    ? { ok: false, data: { status, text: "Fortsetzen nicht möglich." } }
    : { ok: true, data: { jobs: structuredClone(a.jobs), waiting: 0, running: 0 } });
  a.view.show(); await settle();
  a.click(":resume"); await settle();
  expect(a.elements["jobs-status"].textContent).toBe("Fortsetzen nicht möglich.");
  a.click(":resume"); await settle();
  const posts = a.calls.filter(c => c.method === "POST");
  expect(posts.map(c => c.body)).toEqual([
    { expectedRun: 1, request: "request-test-00000001" },
    { expectedRun: 1, request: "request-test-00000002" },
  ]);
});

test("Fortsetzen nach Netzfehler verwendet bei gleichem Lauf dieselbe Kennung", async () => {
  const a = setup();
  Object.assign(a.jobs[0], { phase: "ended", status: "abgebrochen", question: null, actions: ["resume"] });
  a.respond(method => {
    if (method === "POST") throw new Error("Verbindung unterbrochen");
    return { ok: true, data: { jobs: structuredClone(a.jobs), waiting: 0, running: 0 } };
  });
  a.view.show(); await settle();
  a.click(":resume"); await settle();
  expect(a.elements["jobs-status"].textContent).toContain("Der Ausgang ist noch unbekannt");
  a.respond(null);
  a.click(":resume"); await settle();
  const posts = a.calls.filter(c => c.method === "POST");
  expect(posts.map(c => c.body)).toEqual([
    { expectedRun: 1, request: "request-test-00000001" },
    { expectedRun: 1, request: "request-test-00000001" },
  ]);
});

test("Log als Text, Bericht mit Server-Markdown; Laufwechsel entfernt geöffnete Datei und Bestätigung", async () => {
  const a = setup(); a.view.show(); await settle(); a.click(":log"); await settle();
  expect(a.calls.some(c => c.path.endsWith("/log?run=1"))).toBe(true);
  expect(a.elements["jobs-body"].textContent).toContain("<script>Log</script>");
  a.click(":report"); await settle();
  const all = (n: El): El[] => [n, ...n.children.flatMap(all)];
  expect(all(a.elements["jobs-body"]).some(n => n.innerHTML === "<h2>Bericht</h2>")).toBe(true);
  a.click(":stop"); a.jobs[0].run = 2; await a.view.load();
  expect(a.buttons().some(b => (b.attrs["data-job-action"] || "").endsWith(":file-close"))).toBe(false);
  expect(a.buttons().some(b => (b.attrs["data-job-action"] || "").endsWith(":confirm"))).toBe(false);
});

test("Nachfragen nur offen und sichtbar; Fehler zeigt letzten Stand mit Wiederholung, Erholung zeichnet neu", async () => {
  const a = setup(); await a.view.load(); expect(a.timers.size).toBe(0);
  a.view.show(); await settle(); expect(a.timers.size).toBe(1);
  a.document.visibilityState = "hidden"; a.view.visibility(); expect(a.timers.size).toBe(0);
  a.document.visibilityState = "visible"; a.view.visibility(); await settle(); expect(a.timers.size).toBe(1);
  a.respond(() => { throw new Error("Offline"); }); await a.view.load();
  expect(a.elements["jobs-body"].textContent).toContain("letzte bekannte Stand");
  expect(a.buttons().find(b => b.textContent === "Stoppen")!.disabled).toBe(true);
  a.respond(null); await a.view.load();
  expect(a.elements["jobs-body"].textContent).not.toContain("Offline");
  expect(a.buttons().find(b => b.textContent === "Stoppen")!.disabled).toBe(false);
  a.view.hide(); expect(a.timers.size).toBe(0);
});

test("verspätete Antwort überschreibt keine neuere Liste; leer und fehlende Frageknöpfe", async () => {
  const a = setup(); let resolve!: (v: unknown) => void;
  a.respond(() => new Promise(r => { resolve = r; })); a.view.show();
  a.respond(null); a.jobs[0].question.choice = null; await a.view.load();
  expect(a.elements["jobs-body"].textContent).toContain("Knöpfe sind hier noch nicht verfügbar");
  a.jobs.splice(0); await a.view.load();
  resolve({ ok: true, data: { jobs: [{ title: "Alter Stand" }], waiting: 1 } }); await settle();
  expect(a.elements["jobs-body"].textContent).toContain("Keine Hintergrund-Jobs");
  expect(a.elements["jobs-body"].textContent).not.toContain("Alter Stand");
});
