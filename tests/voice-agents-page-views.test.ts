/**
 * Issue #495, Prüfung von PR #549: Antworten der Verwaltung, die erst nach
 * einem Wechsel der Ansicht ankommen, ändern die neue Ansicht nicht.
 * sprachagenten.js läuft mit einem kleinen DOM-Ersatz und einem Fetch, dessen
 * Antworten der Test einzeln freigibt. Dazu: mehrere Testläufe im Detail.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PUBLIC = resolve(import.meta.dir, "..", "src", "web", "public");
const SOURCE = await readFile(join(PUBLIC, "sprachagenten.js"), "utf8");

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  hidden = false;
  href = "";
  type = "";
  disabled = false;
  attributes: Record<string, string> = {};
  listeners: Record<string, (() => unknown)[]> = {};
  private text = "";
  constructor(
    readonly tag: string,
    readonly doc: FakeDocument,
  ) {}
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.children = [];
    this.text = String(value);
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.text = "";
    this.children = [...nodes];
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  addEventListener(name: string, fn: () => unknown) {
    (this.listeners[name] ??= []).push(fn);
  }
  focus() {
    this.doc.activeElement = this;
  }
  async click() {
    for (const fn of this.listeners.click ?? []) await fn();
  }
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelector(selector: string): FakeElement | null {
    const cls = selector.replace(/^\./, "");
    return this.all().find((e) => e.className.split(" ").includes(cls)) ?? null;
  }
}

class FakeDocument {
  title = "Sprachagenten · tybo";
  activeElement: FakeElement | null = null;
  mounted = false;
  ids: Record<string, FakeElement> = {};
  constructor() {
    for (const id of ["va-title", "va-back", "va-back-label", "va-intro", "va-status", "va-list", "va-broken", "va-broken-list", "va-detail"]) {
      this.ids[id] = new FakeElement("div", this);
    }
    this.ids["va-title"].textContent = "Sprachagenten";
    this.ids["va-back-label"].textContent = "Zurück zu tybo";
  }
  getElementById(id: string) {
    return this.mounted ? (this.ids[id] ?? null) : null;
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
}

interface Pending {
  url: string;
  method: string;
  release: () => void;
}

const run = (beendetAm: string, ergebnis = "bestanden") => ({
  gestartetAm: beendetAm,
  beendetAm,
  ergebnis,
  tests: [
    { name: "Begrüßung", status: "bestanden" },
    { name: "Drängeln", status: ergebnis === "bestanden" ? "bestanden" : "durchgefallen" },
  ],
});

function detail(kennung: string, name: string, version: number | null, extra: Record<string, unknown> = {}) {
  return {
    kennung,
    name,
    vorlage: "jarvis",
    web: true,
    telefon: false,
    angelegt: true,
    letzterTest: null,
    fruehereTests: [],
    laufenderTest: null,
    minutenMonat: 300,
    minutenWeb: { limit: 300, verbraucht: 1 },
    version,
    versionen: [
      { version: 2, aktuell: true, lesbar: true },
      { version: 1, aktuell: false, lesbar: true },
    ],
    rezept: [{ titel: "Allgemein", zeilen: [{ feld: "Zweck", wert: version === 1 ? `${name}, erste Fassung` : `${name}, aktuell` }] }],
    ...extra,
  };
}

/** Seite mit DOM-Ersatz; hold(url) hält die nächste Antwort auf diese Adresse an */
function mountPage() {
  const doc = new FakeDocument();
  const hashListeners: (() => void)[] = [];
  const win = {
    location: { hash: "", pathname: "/sprachagenten", href: "/sprachagenten" },
    history: { replaceState: (_s: unknown, _t: string, url: string) => void (win.location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : "") },
    addEventListener: (name: string, fn: () => void) => name === "hashchange" && hashListeners.push(fn),
  };
  const holds = new Map<string, boolean>();
  const pending: Pending[] = [];
  const calls: string[] = [];
  /** Agenten, deren Teststart schon beantwortet ist: ihr Detail zeigt den laufenden Test */
  const running = new Set<string>();
  const respond = (url: string, method: string): Response => {
    const m = /^\/api\/voice-agents\/([a-z0-9-]+)\/(rezept|test|link|loeschen)(?:\?version=(\d+))?$/.exec(url);
    if (url === "/api/voice-agents") return Response.json({ agents: [detail("jarvis", "Jarvis", null), detail("empfang", "Empfang", null)], kaputt: [] });
    if (!m) return new Response(null, { status: 404 });
    const name = m[1] === "jarvis" ? "Jarvis" : "Empfang";
    if (m[2] === "rezept") {
      const laufenderTest = running.has(m[1]) ? { gestartetAm: "2026-11-08T12:00:00Z", verfolgt: true } : null;
      return Response.json(detail(m[1], name, m[3] ? Number(m[3]) : null, { laufenderTest }));
    }
    if (m[2] === "test") {
      running.add(m[1]);
      return Response.json({ ok: true, text: "Testlauf gestartet." }, { status: 202 });
    }
    if (m[2] === "link") return Response.json({ url: `http://tybo.local/sa/${m[1]}` });
    return Response.json({ ok: true });
  };
  const doFetch = async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (holds.get(url)) {
      holds.delete(url);
      await new Promise<void>((release) => pending.push({ url, method, release }));
    }
    return respond(url, method);
  };
  const clipboard = { written: [] as string[], writeText: async (t: string) => void clipboard.written.push(t) };
  const start = new Function("window", "document", "fetch", "navigator", `${SOURCE}\nreturn startVoiceAgentsPage;`)(win, doc, doFetch, { clipboard });
  doc.mounted = true;
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    doc,
    win,
    calls,
    clipboard,
    pending,
    hold: (url: string) => holds.set(url, true),
    start: async () => {
      start();
      await settle();
    },
    settle,
    go: async (hash: string) => {
      win.location.hash = hash;
      for (const fn of hashListeners) fn();
      await settle();
    },
    title: () => doc.ids["va-title"].textContent,
    detailText: () => doc.ids["va-detail"].textContent,
    button: (label: string) => doc.ids["va-detail"].all().find((e) => e.tag === "button" && e.textContent === label && !e.hidden)!,
    release: async (url: string) => {
      const p = pending.find((x) => x.url === url)!;
      pending.splice(pending.indexOf(p), 1);
      p.release();
      await settle();
    },
  };
}

describe("verspätete Antworten der Verwaltung", () => {
  test("Testen bei Jarvis, dann zu Empfang: die Jarvis-Antwort lädt Jarvis nicht wieder", async () => {
    const p = mountPage();
    p.win.location.hash = "#jarvis";
    await p.start();
    expect(p.title()).toBe("Jarvis");
    p.hold("/api/voice-agents/jarvis/test");
    void p.button("Testen").click();
    await p.settle();
    await p.go("#empfang");
    expect(p.title()).toBe("Empfang");
    const before = p.calls.length;
    await p.release("/api/voice-agents/jarvis/test");
    expect(p.win.location.hash).toBe("#empfang");
    expect(p.title()).toBe("Empfang");
    expect(p.detailText()).toContain("Empfang, aktuell");
    expect(p.detailText()).not.toContain("Jarvis");
    expect(p.detailText()).not.toContain("Testlauf gestartet.");
    // Kein Nachladen des alten Agenten
    expect(p.calls.slice(before)).toEqual([]);
  });

  test("Testen bei Jarvis, dann Version 1: die gezeigte Version 1 lädt nach und zeigt den laufenden Test", async () => {
    const p = mountPage();
    p.win.location.hash = "#jarvis";
    await p.start();
    expect(p.detailText()).toContain("Noch kein Testlauf.");
    p.hold("/api/voice-agents/jarvis/test");
    void p.button("Testen").click();
    await p.settle();
    await p.button("Version 1").click();
    await p.settle();
    expect(p.detailText()).toContain("Du siehst Version 1.");
    expect(p.detailText()).toContain("Noch kein Testlauf.");
    const before = p.calls.length;
    await p.release("/api/voice-agents/jarvis/test");
    // Genau die gezeigte Version neu geladen, kein Sprung zur aktuellen Fassung oder zu einem anderen Agenten
    expect(p.calls.slice(before)).toEqual(["GET /api/voice-agents/jarvis/rezept?version=1"]);
    expect(p.win.location.hash).toBe("#jarvis");
    expect(p.title()).toBe("Jarvis");
    expect(p.detailText()).toContain("Du siehst Version 1.");
    expect(p.detailText()).toContain("erste Fassung");
    expect(p.detailText()).not.toContain("Noch kein Testlauf.");
    expect(p.detailText()).toContain("Testlauf läuft seit");
    expect(p.detailText()).toContain("Testlauf gestartet.");
    expect(p.button("Testen").disabled).toBe(true);
  });

  test("Detail von Jarvis kommt nach dem Detail von Empfang: Empfang bleibt", async () => {
    const p = mountPage();
    await p.start();
    p.hold("/api/voice-agents/jarvis/rezept");
    await p.go("#jarvis");
    await p.go("#empfang");
    expect(p.title()).toBe("Empfang");
    await p.release("/api/voice-agents/jarvis/rezept");
    expect(p.title()).toBe("Empfang");
    expect(p.detailText()).toContain("Empfang, aktuell");
  });

  test("Version 1 antwortet nach „Aktuelle Fassung“: die aktuelle Fassung bleibt", async () => {
    const p = mountPage();
    p.win.location.hash = "#jarvis";
    await p.start();
    p.hold("/api/voice-agents/jarvis/rezept?version=1");
    void p.button("Version 1").click();
    await p.settle();
    await p.button("Version 2 (aktuell)").click();
    await p.settle();
    expect(p.detailText()).toContain("Jarvis, aktuell");
    await p.release("/api/voice-agents/jarvis/rezept?version=1");
    expect(p.detailText()).toContain("Jarvis, aktuell");
    expect(p.detailText()).not.toContain("erste Fassung");
    expect(p.detailText()).not.toContain("Du siehst Version 1.");
  });

  test("Detail nach dem Wechsel zur Liste: die Liste bleibt", async () => {
    const p = mountPage();
    await p.start();
    p.hold("/api/voice-agents/jarvis/rezept");
    await p.go("#jarvis");
    await p.go("");
    expect(p.title()).toBe("Sprachagenten");
    await p.release("/api/voice-agents/jarvis/rezept");
    expect(p.title()).toBe("Sprachagenten");
    expect(p.doc.ids["va-detail"].hidden).toBe(true);
    expect(p.doc.ids["va-list"].hidden).toBe(false);
  });

  test("Link kopieren antwortet nach dem Wechsel: keine Meldung in der neuen Ansicht", async () => {
    const p = mountPage();
    p.win.location.hash = "#jarvis";
    await p.start();
    p.hold("/api/voice-agents/jarvis/link");
    void p.button("Link kopieren").click();
    await p.settle();
    await p.go("#empfang");
    await p.release("/api/voice-agents/jarvis/link");
    expect(p.title()).toBe("Empfang");
    expect(p.detailText()).not.toContain("Link kopiert.");
  });

  test("Löschen antwortet, nachdem die Liste steht: Liste neu geladen, keine Ansicht von Jarvis", async () => {
    const p = mountPage();
    p.win.location.hash = "#jarvis";
    await p.start();
    await p.button("Löschen").click();
    p.hold("/api/voice-agents/jarvis/loeschen");
    void p.doc.ids["va-detail"].all().find((e) => e.tag === "button" && e.textContent === "Löschen" && e.className.includes("settings-device-confirm"))!.click();
    await p.settle();
    await p.go("");
    const lists = p.calls.filter((c) => c === "GET /api/voice-agents").length;
    await p.release("/api/voice-agents/jarvis/loeschen");
    expect(p.title()).toBe("Sprachagenten");
    expect(p.calls.filter((c) => c === "GET /api/voice-agents").length).toBe(lists + 1);
  });
});

describe("mehrere Testläufe", () => {
  test("letzter Lauf mit Zeilen, die davor unter „Davor“, neueste zuerst", async () => {
    const page = new Function(`${SOURCE}\nreturn { voiceAgentsEarlierTests, VOICE_AGENTS_TEXT };`)() as any;
    const d = detail("jarvis", "Jarvis", null, {
      letzterTest: run("2026-11-08T12:00:00Z"),
      fruehereTests: [run("2026-11-08T11:00:00Z", "durchgefallen"), run("2026-11-07T10:00:00Z")],
    });
    expect(page.voiceAgentsEarlierTests(d)).toEqual([
      expect.stringMatching(/^Test durchgefallen, bestanden 1 von 2 \(8\.11\. \d\d:00\)$/),
      expect.stringMatching(/^Test bestanden, bestanden 2 von 2 \(7\.11\. \d\d:00\)$/),
    ]);
    expect(page.voiceAgentsEarlierTests({})).toEqual([]);
    expect(page.VOICE_AGENTS_TEXT.sectionTest).toBe("Letzte Testläufe");
  });
});
