/**
 * Prüfung von PR #558 (Issue #515): Oberfläche des Wizards
 * (sprachagent-wizard.js) mit einem kleinen DOM-Ersatz gegen die Attrappe aus
 * web:dev (demo-voice-agent-wizard.ts). Uhr und Netz steuert der Test: Timer
 * laufen erst auf Zuruf, einzelne Anfragen hält er fest und gibt sie später frei.
 *
 * - Speicheraufträge gehören zu ihrem Entwurf: Wer schließt oder einen anderen
 *   Entwurf öffnet, während ein PUT oder ein Upload läuft, schreibt nie die
 *   Felder des neuen Entwurfs in den alten, und das Offene des alten kommt an.
 *   Wird derselbe Entwurf wieder geöffnet, solange er noch speichert, gibt es
 *   weiter nur eine Speicherfolge: Ein alter PUT überschreibt keine neuere Eingabe.
 * - Sofortiges Verlassen speichert, was getippt ist.
 * - Autosave schon in Schritt 1: der Entwurf entsteht mit der ersten gültigen
 *   Kennung, nur der Satz bleibt im Browser; Satz und Kennung werden auch nach
 *   dem ersten Speichern gespeichert.
 * - Unfertige Eingaben (halber Link, Telefon ohne Nummer) bleiben nach dem
 *   Neuladen, und „Gespeichert.“ stimmt.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDemoVoiceAgentWizard } from "../src/web/demo-voice-agent-wizard";
import { matchWizardPath, type VoiceWizardPort } from "../src/web/voice-agent-wizard";

const PUBLIC = resolve(import.meta.dir, "..", "src", "web", "public");
const STATE = await readFile(join(PUBLIC, "sprachagent-wizard-state.js"), "utf8");
const UI = await readFile(join(PUBLIC, "sprachagent-wizard.js"), "utf8");

// --- DOM-Ersatz ----------------------------------------------------------------

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  id = "";
  className = "";
  hidden = false;
  disabled = false;
  type = "";
  value = "";
  checked = false;
  name = "";
  href = "";
  htmlFor = "";
  placeholder = "";
  maxLength = -1;
  tabIndex = 0;
  files: unknown[] | null = null;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, ((e?: unknown) => unknown)[]> = {};
  private text = "";
  constructor(
    readonly tagName: string,
    readonly doc: FakeDocument,
  ) {
    if (tagName === "input" || tagName === "textarea") this.selectionStart = this.selectionEnd = 0;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.setChildren([]);
    this.text = String(value);
  }
  private setChildren(nodes: FakeElement[]) {
    for (const c of this.children) c.parent = null;
    this.children = nodes;
    for (const c of nodes) c.parent = this;
  }
  append(...nodes: FakeElement[]) {
    for (const n of nodes) n.parent = this;
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.text = "";
    this.setChildren([...nodes]);
  }
  replaceChild(next: FakeElement, old: FakeElement) {
    const i = this.children.indexOf(old);
    if (i >= 0) {
      this.children[i] = next;
      next.parent = this;
      old.parent = null;
    }
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name: string, fn: (e?: unknown) => unknown) {
    (this.listeners[name] ??= []).push(fn);
  }
  focus() {
    this.doc.activeElement = this;
  }
  setSelectionRange(a: number, b: number) {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  scrollIntoView() {}
  contains(node: FakeElement | null): boolean {
    for (let at = node; at; at = at.parent) if (at === this) return true;
    return false;
  }
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  /** Ereignis auslösen und warten, bis die Behandlung fertig ist */
  async fire(name: string) {
    for (const fn of this.listeners[name] ?? []) await fn({ target: this });
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly root = new FakeElement("section", this);
  readonly drafts = new FakeElement("div", this);
  readonly newButton = new FakeElement("a", this);
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  getElementById(id: string): FakeElement | null {
    return [this.root, this.drafts].flatMap((r) => r.all()).find((e) => e.id === id) ?? null;
  }
}

// --- Uhr, Netz, Seite ------------------------------------------------------------

/** Timer laufen nur, wenn der Test es sagt */
class Timers {
  private next = 1;
  pending = new Map<number, () => void>();
  set = (fn: () => void) => {
    const id = this.next++;
    this.pending.set(id, fn);
    return id;
  };
  clear = (id: number) => void this.pending.delete(id);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await tick();
}

interface Sent {
  method: string;
  path: string;
  body: any;
}

function fakeResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => new Blob([]) };
}

/** Wizard mit der Attrappe als Server; hold(method, path) hält Anfragen fest, bis release() */
async function setup(options: { storage?: Map<string, string>; port?: VoiceWizardPort } = {}) {
  const port = options.port ?? createDemoVoiceAgentWizard();
  const doc = new FakeDocument();
  const timers = new Timers();
  const sent: Sent[] = [];
  const holds: { method: string; path: string; release: () => void; gate: Promise<void> }[] = [];
  const storage = options.storage ?? new Map<string, string>();
  const history: string[] = [];
  let left: string | null = null;

  async function route(method: string, path: string, init: any): Promise<{ status: number; body: any }> {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    if (path === "/api/voice-agents/wizard/vorschlag") return port.propose(body);
    if (path === "/api/voice-agents/wizard/entwuerfe") return port.list();
    if (path === "/api/voice-agents/wizard/stimmen") return port.voices();
    const m = matchWizardPath(path);
    if (!m) return { status: 404, body: {} };
    const k = decodeURIComponent(m.segment);
    if (m.action === "") {
      if (method === "GET") return port.get(k);
      if (method === "PUT") return port.put(k, body);
      if (method === "DELETE") return port.remove(k);
    }
    if (m.action === "umbenennen") return port.rename(k, body);
    if (m.action === "bauen") return port.build(k, body);
    if (m.action === "fortschritt") return port.progress(k);
    if (m.action === "anhaenge" && method === "POST") return port.addAttachment(k, decodeURIComponent(init.headers["x-file-name"]), body);
    if (m.action === "anhaenge" && method === "DELETE") return port.removeAttachment(k, m.datei!);
    return { status: 405, body: {} };
  }

  async function api(path: string, init: any = {}) {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body instanceof Uint8Array ? "(Datei)" : undefined;
    sent.push({ method, path, body });
    const hold = holds.find((h) => h.method === method && h.path === path);
    if (hold) {
      holds.splice(holds.indexOf(hold), 1);
      await hold.gate;
    }
    const res = await route(method, path, init);
    return fakeResponse(res.status, res.body);
  }

  const win = {
    history: { replaceState: (_s: unknown, _t: string, url: string) => void history.push(url) },
    URL: { createObjectURL: () => "blob:probe", revokeObjectURL: () => {} },
    addEventListener: () => {},
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  };
  const start = new Function("window", "setTimeout", "clearTimeout", `${STATE}\n${UI}\nreturn startVoiceAgentWizard;`)(win, timers.set, timers.clear);
  const wizard = start({
    doc,
    api,
    root: doc.root,
    drafts: doc.drafts,
    newButton: doc.newButton,
    setTitle: () => {},
    leaveToList: (message: string) => {
      left = message;
      wizard.close();
    },
  });

  const el = (id: string) => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`kein Element ${id}`);
    return node;
  };
  return {
    port,
    doc,
    wizard,
    sent,
    storage,
    history,
    left: () => left,
    el,
    /** Tippen wie im Browser: Wert setzen, input auslösen */
    async type(id: string, value: string) {
      const node = el(id);
      node.focus();
      node.value = value;
      await node.fire("input");
    },
    async check(id: string, on: boolean) {
      const node = el(id);
      node.checked = on;
      await node.fire("change");
    },
    async click(id: string) {
      await el(id).fire("click");
      await settle();
    },
    /** Alle fälligen Timer (Entprellen) laufen lassen, bis keiner mehr wartet */
    async runTimers() {
      for (let i = 0; i < 20 && timers.pending.size; i++) {
        const [id, fn] = timers.pending.entries().next().value!;
        timers.pending.delete(id);
        fn();
        await settle();
      }
      await settle();
    },
    timers,
    hold(method: string, path: string) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      holds.push({ method, path, release, gate });
      return () => release();
    },
    puts: (path: string) => sent.filter((x) => x.method === "PUT" && x.path === path).map((x) => x.body),
  };
}

const PATH = (k: string) => `/api/voice-agents/wizard/${k}`;

/** Entwurf direkt bei der Attrappe anlegen, wie ein früheres „Weiter“ */
async function seed(port: VoiceWizardPort, kennung: string, felder: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await port.put(kennung, { felder, ...extra });
  expect(res.status).toBe(201);
  return res.body as any;
}

const jarvis = (name: string, zweck: string) => ({ vorlage: "jarvis", name, zweck });
const expert = (name: string) => ({ vorlage: "experte", name, zweck: "Üben", training: { kriterien: ["eins", "zwei", "drei"] } });

describe("Speicheraufträge gehören zu ihrem Entwurf", () => {
  test("PUT läuft noch, Schließen und anderen Entwurf öffnen: dessen Felder gehen nie an den alten, das Offene des alten kommt an", async () => {
    const w = await setup();
    await seed(w.port, "alt", jarvis("Alter Agent", "Alt"));
    await seed(w.port, "neu", jarvis("Neuer Agent", "Neu"));
    await w.wizard.open({ kennung: "alt" });
    await settle();
    expect(w.el("vw-zweck").value).toBe("Alt");
    // Erstes Speichern hängt beim Server
    const release = w.hold("PUT", PATH("alt"));
    await w.type("vw-zweck", "Alt eins");
    await w.runTimers();
    expect(w.puts(PATH("alt")).map((b) => b.felder.zweck)).toEqual(["Alt eins"]);
    // Weiter getippt, dann sofort geschlossen und den anderen Entwurf geöffnet
    await w.type("vw-zweck", "Alt zwei");
    w.wizard.close();
    await w.wizard.open({ kennung: "neu" });
    await settle();
    expect(w.el("vw-name").value).toBe("Neuer Agent");
    await w.type("vw-zweck", "Neu eins");
    release();
    await settle();
    await w.runTimers();
    // An /wizard/alt ging nur, was im alten Entwurf stand
    const alt = w.puts(PATH("alt"));
    expect(alt.map((b) => b.felder.zweck)).toEqual(["Alt eins", "Alt zwei"]);
    expect(alt.every((b) => b.felder.name === "Alter Agent")).toBe(true);
    expect(w.puts(PATH("neu")).map((b) => b.felder.zweck)).toEqual(["Neu eins"]);
    expect(((await w.port.get("alt")).body as any).felder).toMatchObject({ name: "Alter Agent", zweck: "Alt zwei" });
    expect(((await w.port.get("neu")).body as any).felder).toMatchObject({ name: "Neuer Agent", zweck: "Neu eins" });
  });

  test("Upload läuft noch, Wechsel zu einem anderen Entwurf: der Anhang und die Eingaben bleiben beim alten", async () => {
    const w = await setup();
    await seed(w.port, "alt", expert("Alter Trainer"), { schritt: 3 });
    await seed(w.port, "neu", expert("Neuer Trainer"), { schritt: 3 });
    await w.wizard.open({ kennung: "alt" });
    await settle();
    expect(w.el("vw-thema")).toBeTruthy();
    const release = w.hold("POST", `${PATH("alt")}/anhaenge`);
    const input = w.el("vw-file-input");
    input.files = [{ name: "notizen.md", arrayBuffer: async () => new TextEncoder().encode("# Wind").buffer }];
    const uploading = input.fire("change");
    await settle();
    await w.type("vw-thema", "Segeln bei Wind");
    w.wizard.close();
    await w.wizard.open({ kennung: "neu" });
    await settle();
    await w.type("vw-thema", "Rudern");
    release();
    await uploading;
    await settle();
    await w.runTimers();
    const alt = (await w.port.get("alt")).body as any;
    const neu = (await w.port.get("neu")).body as any;
    expect(alt.anhaenge.map((a: any) => a.name)).toEqual(["notizen.md"]);
    expect(alt.felder).toMatchObject({ name: "Alter Trainer", thema: "Segeln bei Wind" });
    expect(neu.anhaenge).toEqual([]);
    expect(neu.felder).toMatchObject({ name: "Neuer Trainer", thema: "Rudern" });
    expect(w.puts(PATH("alt")).every((b) => b.felder.name === "Alter Trainer")).toBe(true);
  });

  test("PUT läuft noch, Schließen und denselben Entwurf öffnen: nur eine Speicherfolge, die neuere Eingabe gewinnt", async () => {
    const w = await setup();
    await seed(w.port, "alt", expert("Alter Trainer"), { schritt: 3 });
    await w.wizard.open({ kennung: "alt" });
    await settle();
    // Thema A speichern, der PUT hängt beim Server
    const release = w.hold("PUT", PATH("alt"));
    await w.type("vw-thema", "Thema A");
    await w.runTimers();
    expect(w.puts(PATH("alt")).map((b) => b.felder.thema)).toEqual(["Thema A"]);
    // Schließen und denselben Entwurf gleich wieder öffnen, Thema B speichern
    w.wizard.close();
    await w.wizard.open({ kennung: "alt" });
    await settle();
    await w.type("vw-thema", "Thema B");
    await w.runTimers();
    // Jetzt erst kommt der alte PUT an
    release();
    await settle();
    await w.runTimers();
    const server = (await w.port.get("alt")).body as any;
    expect(server.felder.thema).toBe("Thema B");
    expect(w.el("vw-thema").value).toBe("Thema B");
    expect(w.doc.root.textContent).toContain("Gespeichert.");
    // Kein Auftrag mit Thema A nach dem mit Thema B, kein Konflikt mit Neuladen
    const themen = w.puts(PATH("alt")).map((b) => b.felder.thema);
    expect(themen.lastIndexOf("Thema A")).toBeLessThan(themen.indexOf("Thema B"));
    expect(w.sent.filter((x) => x.method === "GET" && x.path === PATH("alt"))).toHaveLength(1);
  });

  test("Anlegen läuft noch, Schließen und denselben Entwurf öffnen: geladen wird erst danach, mit allen Eingaben", async () => {
    const w = await setup();
    await w.wizard.open({ neu: true });
    const release = w.hold("PUT", PATH("kochhilfe"));
    await w.type("vw-name", "Kochhilfe");
    w.wizard.close();
    await settle();
    expect(w.puts(PATH("kochhilfe"))).toHaveLength(1);
    void w.wizard.open({ kennung: "kochhilfe" });
    await settle();
    // Kein GET vor dem Anlegen: sonst hieße es „gibt es nicht mehr“
    expect(w.doc.getElementById("vw-loading")).toBeTruthy();
    expect(w.sent.some((x) => x.method === "GET" && x.path === PATH("kochhilfe"))).toBe(false);
    release();
    await settle();
    expect(w.doc.getElementById("vw-gone")).toBeNull();
    expect(w.el("vw-name").value).toBe("Kochhilfe");
    await w.type("vw-zweck", "Liest Rezepte vor.");
    await w.runTimers();
    expect(((await w.port.get("kochhilfe")).body as any).felder).toMatchObject({ name: "Kochhilfe", zweck: "Liest Rezepte vor." });
    expect(w.el("vw-save").textContent).toBe("Gespeichert.");
  });

  test("sofort verlassen, bevor das Entprellen abläuft: die Eingabe kommt trotzdem an", async () => {
    const w = await setup();
    await seed(w.port, "alt", jarvis("Alter Agent", "Alt"));
    await w.wizard.open({ kennung: "alt" });
    await settle();
    await w.type("vw-zweck", "Gleich weg");
    w.wizard.close();
    await settle();
    expect(((await w.port.get("alt")).body as any).felder.zweck).toBe("Gleich weg");
  });
});

describe("Autosave ab Schritt 1", () => {
  test("Satz und Name vor dem ersten „Weiter“, dann sofort geschlossen: Entwurf steht in der Liste und öffnet mit allen Eingaben", async () => {
    const w = await setup();
    await w.wizard.open({ neu: true });
    await w.type("vw-satz", "Ein Trainer für Preisgespräche");
    await w.type("vw-name", "Preistrainer");
    expect(w.el("vw-kennung").value).toBe("preistrainer");
    w.wizard.close();
    await settle();
    const created = w.puts(PATH("preistrainer"));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ satz: "Ein Trainer für Preisgespräche", schritt: 1, felder: { name: "Preistrainer" } });
    const list = (await w.port.list()).body as any;
    expect(list.entwuerfe.map((e: any) => e.kennung)).toEqual(["preistrainer"]);
    // Wieder geöffnet: Schritt 1 mit Satz und Name
    await w.wizard.open({ kennung: "preistrainer" });
    await settle();
    expect(w.el("vw-heading").textContent).toContain("Schritt 1 von 5");
    expect(w.el("vw-satz").value).toBe("Ein Trainer für Preisgespräche");
    expect(w.el("vw-name").value).toBe("Preistrainer");
    // Die Kopie im Browser ist nach dem Anlegen weg
    expect(w.storage.size).toBe(0);
  });

  test("ohne Schließen: der Entwurf entsteht entprellt, sobald eine gültige Kennung dasteht", async () => {
    const w = await setup();
    await w.wizard.open({ neu: true });
    await w.type("vw-name", "Kochhilfe");
    expect(w.puts(PATH("kochhilfe"))).toHaveLength(0);
    await w.runTimers();
    // Genau ein Anlegen (PUT ohne revision); danach speichert der Saver
    const creates = () => w.puts(PATH("kochhilfe")).filter((b) => b.revision === undefined);
    expect(creates()).toHaveLength(1);
    expect(w.history.at(-1)).toBe("#/entwurf/kochhilfe");
    expect(w.el("vw-save").textContent).toBe("Gespeichert.");
    // Weiter tippen speichert ohne zweites Anlegen
    await w.type("vw-zweck", "Liest Rezepte vor.");
    await w.runTimers();
    expect(creates()).toHaveLength(1);
    expect(((await w.port.get("kochhilfe")).body as any).felder.zweck).toBe("Liest Rezepte vor.");
  });

  test("nur der Satz, noch keine Kennung: bleibt im Browser und ist beim nächsten „Neu“ wieder da", async () => {
    const storage = new Map<string, string>();
    const w = await setup({ storage });
    await w.wizard.open({ neu: true });
    await w.type("vw-satz", "Ein Assistent für zuhause");
    w.wizard.close();
    await settle();
    expect(w.sent.filter((x) => x.method === "PUT")).toEqual([]);
    // Auch nach dem Neuladen der Seite (neuer Wizard, derselbe Speicher)
    const again = await setup({ storage, port: w.port });
    await again.wizard.open({ neu: true });
    expect(again.el("vw-satz").value).toBe("Ein Assistent für zuhause");
    // Verwerfen leert die Kopie
    await again.click("vw-discard");
    await again.click("vw-discard-yes");
    expect(again.left()).toContain("verworfen");
    expect(storage.size).toBe(0);
  });

  test("nach dem ersten Speichern: Satz ändern und leeren wird gespeichert, „Gespeichert.“ erst danach", async () => {
    const w = await setup();
    await seed(w.port, "alt", jarvis("Alter Agent", "Alt"), { satz: "Erster Satz" });
    await w.wizard.open({ kennung: "alt" });
    await settle();
    expect(w.el("vw-satz").value).toBe("Erster Satz");
    await w.type("vw-satz", "Zweiter Satz");
    await w.runTimers();
    expect(w.puts(PATH("alt")).at(-1).satz).toBe("Zweiter Satz");
    expect(((await w.port.get("alt")).body as any).satz).toBe("Zweiter Satz");
    await w.type("vw-satz", "");
    await w.runTimers();
    expect(w.puts(PATH("alt")).at(-1).satz).toBe("");
    expect(((await w.port.get("alt")).body as any).satz).toBeUndefined();
    expect(w.el("vw-save").textContent).toBe("Gespeichert.");
    // Neu geöffnet: leer
    w.wizard.close();
    await w.wizard.open({ kennung: "alt" });
    await settle();
    expect(w.el("vw-satz").value).toBe("");
  });

  test("nach dem ersten Speichern: Kennung ändern zieht den Entwurf entprellt um, ohne „Weiter“", async () => {
    const w = await setup();
    await seed(w.port, "alt", jarvis("Alter Agent", "Alt"));
    await w.wizard.open({ kennung: "alt" });
    await settle();
    await w.type("vw-kennung", "alt-zwei");
    await w.runTimers();
    expect(w.sent.some((x) => x.method === "POST" && x.path === `${PATH("alt")}/umbenennen` && x.body.kennung === "alt-zwei")).toBe(true);
    expect((await w.port.get("alt")).status).toBe(404);
    expect(((await w.port.get("alt-zwei")).body as any).felder.name).toBe("Alter Agent");
    expect(w.history.at(-1)).toBe("#/entwurf/alt-zwei");
    // Danach geht jedes Speichern an die neue Kennung
    await w.type("vw-zweck", "Nach dem Umzug");
    await w.runTimers();
    expect(((await w.port.get("alt-zwei")).body as any).felder.zweck).toBe("Nach dem Umzug");
  });

  test("Kennung geändert und sofort geschlossen: der Umzug und die Eingaben kommen trotzdem an", async () => {
    const w = await setup();
    await seed(w.port, "alt", jarvis("Alter Agent", "Alt"));
    await w.wizard.open({ kennung: "alt" });
    await settle();
    await w.type("vw-kennung", "alt-drei");
    await w.type("vw-zweck", "Kurz vor dem Schließen");
    w.wizard.close();
    await settle();
    expect((await w.port.get("alt")).status).toBe(404);
    expect(((await w.port.get("alt-drei")).body as any).felder.zweck).toBe("Kurz vor dem Schließen");
  });
});

describe("Unfertige Eingaben bleiben", () => {
  test("halber Link: gespeichert, „Gespeichert.“ stimmt, nach dem Neuladen wieder da", async () => {
    const w = await setup();
    await seed(w.port, "trainer", expert("Trainer"), { schritt: 3 });
    await w.wizard.open({ kennung: "trainer" });
    await settle();
    await w.click("vw-link-add");
    await w.type("vw-link-1", "https://");
    await w.runTimers();
    expect(w.puts(PATH("trainer")).at(-1).offen).toEqual({ links: ["https://"] });
    expect(w.el("vw-save").textContent).toBe("Gespeichert.");
    w.wizard.close();
    await w.wizard.open({ kennung: "trainer" });
    await settle();
    expect(w.el("vw-link-1").value).toBe("https://");
  });

  test("Telefon ohne fertige Nummer: gespeichert und nach dem Neuladen wieder angehakt; Bauen bleibt gesperrt", async () => {
    const w = await setup();
    await seed(w.port, "kochhilfe", jarvis("Kochhilfe", "Kocht."), { schritt: 4 });
    await w.wizard.open({ kennung: "kochhilfe" });
    await settle();
    await w.check("vw-telefon", true);
    await w.type("vw-nummer", "ph n");
    await w.runTimers();
    expect(w.puts(PATH("kochhilfe")).at(-1).offen).toEqual({ telefon: { nummer: "ph n", anrufer: "freigegeben", pin: false } });
    expect(w.el("vw-save").textContent).toBe("Gespeichert.");
    w.wizard.close();
    await w.wizard.open({ kennung: "kochhilfe" });
    await settle();
    expect(w.el("vw-telefon").checked).toBe(true);
    expect(w.el("vw-nummer").value).toBe("ph n");
    // Der Server baut nicht, solange die Nummer offen ist
    const draft = (await w.port.get("kochhilfe")).body as any;
    const res = await w.port.build("kochhilfe", { revision: draft.revision });
    expect(res.status).toBe(422);
  });

  test("Schalter, die aus zeigen, gehen als false mit", async () => {
    const w = await setup();
    await seed(w.port, "kochhilfe", jarvis("Kochhilfe", "Kocht."), { schritt: 3 });
    await w.wizard.open({ kennung: "kochhilfe" });
    await settle();
    expect(w.el("vw-denkauftrag").checked).toBe(false);
    await w.type("vw-rolle-text", "Köchin");
    await w.runTimers();
    expect(w.puts(PATH("kochhilfe")).at(-1).felder).toMatchObject({ zugang: { web: false }, gehirn: { denkauftrag: false } });
  });
});
