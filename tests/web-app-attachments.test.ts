// Anhänge in der Oberfläche (app.js, Issue #73): Büroklammer, Ziehen,
// Einfügen aus der Zwischenablage, /b64, Chips, Hochladen und Anhänge im
// Verlauf. Ohne Browser: Attrappen für DOM, fetch, EventSource und Timer wie
// in web-app-commands.test.ts; Dateien sind echte File-Objekte aus Bun.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const source = await readFile(resolve(publicDir, "app.js"), "utf8");
const html = await readFile(resolve(publicDir, "index.html"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");

const MB = 1_048_576;
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const GIF_HEAD = [...Buffer.from("GIF89a")];
const WEBP_HEAD = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")];

interface Node {
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

function node(): Node {
  const n: Node = {
    children: [],
    attributes: {},
    style: {},
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    selectionStart: 0,
    selectionEnd: 0,
    innerHTMLWrites: [] as string[],
    set innerHTML(v: string) { this.innerHTMLWrites.push(v); },
    appendChild(child: Node) { this.children.push(child); return child; },
    replaceChildren(...list: Node[]) {
      this.children = list.flatMap(c => (c.fragment ? c.children : [c]));
    },
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); },
    getAttribute(name: string) { return this.attributes[name]; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    clicks: 0,
    click() { this.clicks++; },
    focus() {},
    scrollIntoView() {},
  };
  return n;
}

class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  close() { this.closed = true; }
  emit(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
}

interface Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; data: unknown };

interface Options {
  stored?: string;
  history?: Record<string, any[]>;
  running?: boolean;
}

const TOPICS = [
  { id: "topic-8", title: "Recherche", agent: "research", lastActivity: new Date().toISOString() },
  { id: "topic-9", title: "Strategie", agent: "strategy", lastActivity: new Date().toISOString() },
  { id: "topic-5", title: "Alt", agent: "general", lastActivity: new Date().toISOString(), closed: true },
];

/** Reines Web-Gespräch mit UUID wie aus dem ConversationStore (Issue #112) */
const WEB = "33333333-3333-4333-8333-333333333333";

let uuidCounter = 0;
function uuid(): string {
  uuidCounter++;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function setup(options: Options = {}) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const document = {
    activeElement: null as Node | null,
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement(tag: string) {
      const n = node();
      n.tagName = tag;
      if (tag === "canvas") {
        // Attrappe für die verkleinerte Vorschau großer Bilder
        n.drawn = [] as unknown[][];
        n.getContext = (kind: string) => (kind === "2d" ? { drawImage: (...args: unknown[]) => n.drawn.push(args) } : null);
        n.toDataURL = (type: string) => `data:${type};base64,${Buffer.from(`klein ${n.width}x${n.height}`).toString("base64")}`;
        canvases.push(n);
      }
      return n;
    },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const canvases: Node[] = [];
  /** Dateien, die createImageBitmap dekodiert hat; das Bild ist 4000 x 3000 Pixel groß */
  const decoded: unknown[] = [];
  /** Blobs, aus denen Objekt-URLs entstanden sind (Wiedergabe im Verlauf) */
  const objectUrls: Blob[] = [];
  /** Wieder freigegebene Objekt-URLs */
  const revokedUrls: string[] = [];
  const store: Record<string, string> = { "tybo-last-conversation": options.stored ?? "topic-8" };
  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener(type: string, fn: (e: any) => void) { (windowListeners[type] ??= []).push(fn); },
    location: { href: "/" },
    URL: {
      createObjectURL: (b: Blob) => { objectUrls.push(b); return `blob:https://app.tybo.ai/${objectUrls.length}`; },
      revokeObjectURL: (url: string) => { revokedUrls.push(url); },
    },
    createImageBitmap: async (file: unknown) => {
      decoded.push(file);
      return { width: 4000, height: 3000, close() {} };
    },
  };
  const setTimeout = () => 0;
  const clearTimeout = () => {};

  const server = {
    requests: [] as Request[],
    /** Antwort auf den nächsten Upload; ohne: 201 mit neuer ID */
    uploadReplies: [] as (Reply | "offline")[],
    /** Solange gesetzt, wartet jeder Upload auf dieses Promise */
    uploadGate: null as null | Promise<void>,
    postReply: null as null | Reply,
    /** Solange gesetzt, wartet jeder POST an …/messages auf dieses Promise */
    postGate: null as null | Promise<void>,
    /** Solange gesetzt, wartet jeder Download eines Anhangs auf dieses Promise */
    downloadGate: null as null | Promise<void>,
    uploads: () => server.requests.filter(r => r.method === "POST" && r.path.endsWith("/attachments")),
    posts: () => server.requests.filter(r => r.method === "POST" && r.path.endsWith("/messages")),
  };
  let counter = 0;
  const fetch = async (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    const method = init?.method ?? "GET";
    server.requests.push({ method, path, headers: init?.headers ?? {}, body: init?.body });
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({ conversations: [{ id: WEB, agent: "general", title: "Betrieb" }], telegram: { dm: null, topics: TOPICS } });
    }
    if (path === "/api/me") return Response.json({ authenticated: true });
    if (path === "/api/commands") return Response.json({ commands: [{ name: "help", aliases: [], description: "Hilfe", args: "none" }] });
    if (path.endsWith("/goal")) return Response.json({ card: null });
    const up = path.match(/^\/api\/conversations\/([^/]+)\/attachments$/);
    if (up && method === "POST") {
      if (server.uploadGate) await server.uploadGate;
      const reply = server.uploadReplies.shift();
      if (reply === "offline") throw new TypeError("Failed to fetch");
      if (reply) return Response.json(reply.data, { status: reply.status });
      const blob = init!.body as Blob;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = decodeURIComponent(init!.headers!["X-File-Name"]);
      const mime = bytes[0] === 0x25 ? "application/pdf" : "image/png";
      return Response.json({ id: uuid(), name, size: bytes.length, mime, kind: mime === "application/pdf" ? "document" : "image" }, { status: 201 });
    }
    if (method === "GET" && /^\/api\/conversations\/[^/]+\/attachments\/[0-9a-f-]{36}$/.test(path)) {
      if (server.downloadGate) await server.downloadGate;
      // Wie der Server: immer als Anhang, nie mit dem Typ der Datei
      return new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]), { headers: { "Content-Type": "application/octet-stream" } });
    }
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages$/);
    if (m && method === "POST") {
      if (server.postGate) await server.postGate;
      const body = JSON.parse(init!.body as string);
      if (server.postReply) return Response.json(server.postReply.data, { status: server.postReply.status });
      const attachments = (body.attachments ?? []).map((id: string) => ({
        id,
        name: "bild.png",
        size: 10,
        mime: "image/png",
        kind: "image",
        url: `/api/conversations/${m[1]}/attachments/${id}`,
        previewUrl: `/api/conversations/${m[1]}/attachments/${id}?inline=1`,
      }));
      const message = { id: `u${++counter}`, role: "user", text: body.text, createdAt: new Date().toISOString(), ...(attachments.length ? { attachments } : {}) };
      return Response.json({ message }, { status: 202 });
    }
    if (m) return Response.json({ messages: options.history?.[m[1]] ?? [], hasMore: false, running: !!options.running });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  elements["attachments"] = node();
  elements["attachments"].hidden = true;
  elements["attach-note"] = node();
  elements["attach-note"].hidden = true;
  elements["attach"] = node();
  elements["attach"].hidden = true;
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const input = elements["input"];
  const main = elements["main"];
  /** Tippen: Wert setzen und input auslösen */
  const type = (value: string) => {
    document.activeElement = input;
    input.value = value;
    input.selectionStart = input.selectionEnd = value.length;
    input.dispatch("input");
  };
  const enter = () => {
    const event = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    input.dispatch("keydown", event);
  };
  /** Senden-Knopf (Formular abschicken), unabhängig von einer offenen Befehlsliste */
  const submit = () => elements["composer"].dispatch("submit", { preventDefault() {} });
  /** Antwort fertig (status-Ereignis), damit die nächste Nachricht raus darf */
  const idle = () => conversationSource().emit("status", { data: JSON.stringify({ running: false }) });
  /** Dateiauswahl der Büroklammer: Dateien wählen und change auslösen */
  const choose = (...files: unknown[]) => {
    elements["file-input"].files = files;
    elements["file-input"].dispatch("change");
  };
  const dataTransfer = (files: unknown[], types = ["Files"]) => ({ types, files, dropEffect: "none" });
  const drag = (type: string, files: unknown[] = [], types?: string[]) => {
    const event = { dataTransfer: dataTransfer(files, types), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    main.dispatch(type, event);
    return event;
  };
  /**
   * Einfügen wie im Browser: paste-Ereignis mit clipboardData; ruft niemand
   * preventDefault, fügt der Browser den Text an der Markierung ein.
   */
  const paste = (content: { text?: string; files?: unknown[] }) => {
    document.activeElement = input;
    const files = content.files ?? [];
    const items = [
      ...(content.text !== undefined ? [{ kind: "string", type: "text/plain", getAsFile: () => null }] : []),
      ...files.map(f => ({ kind: "file", type: (f as File).type, getAsFile: () => f })),
    ];
    const event = {
      clipboardData: {
        types: [...(content.text !== undefined ? ["text/plain"] : []), ...(files.length ? ["Files"] : [])],
        files,
        items,
        getData: (t: string) => (t === "text/plain" || t === "text" ? content.text ?? "" : ""),
      },
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    input.dispatch("paste", event);
    if (!event.defaultPrevented && content.text !== undefined) {
      const v = String(input.value);
      input.value = v.slice(0, input.selectionStart) + content.text + v.slice(input.selectionEnd);
      input.selectionStart = input.selectionEnd = input.selectionStart + content.text.length;
      input.dispatch("input");
    }
    return event;
  };
  const chips = () => elements["attachments"].children;
  const chipNames = () => chips().map(c => find(c, "attachment-name")!.textContent);
  const note = () => (elements["attach-note"].hidden ? "" : elements["attach-note"].textContent);
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = (elements[listId]?.children ?? []).find(l => l.children[0]?.attributes["data-id"] === id);
      if (li) return li.children[0];
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  const shown = () => elements["messages"].children;
  const conversationSource = () => FakeEventSource.all.filter(s => s.url.endsWith("/events") && !s.url.startsWith("/api/telegram")).at(-1)!;
  return { server, elements, input, main, type, enter, submit, idle, choose, drag, paste, chips, chipNames, note, entry, shown, conversationSource, windowListeners, canvases, decoded, objectUrls, revokedUrls };
}

async function settle() {
  for (let i = 0; i < 30; i++) await Bun.sleep(0);
}

function all(n: Node): Node[] {
  return [n, ...n.children.flatMap(all)];
}
function find(n: Node, cls: string): Node | undefined {
  return all(n).find(c => String(c.className).split(" ").includes(cls));
}

function png(name = "screenshot.png", extra = 32): File {
  return new File([new Uint8Array([...PNG_HEAD, ...new Array(extra).fill(7)])], name, { type: "image/png" });
}
function pdf(name = "rechnung.pdf"): File {
  return new File([Buffer.from("%PDF-1.7\n%...")], name, { type: "application/pdf" });
}
/** Große Datei ohne echten Inhalt: Art und Größe reichen für die Prüfung vor dem Hochladen */
function bigFile(name: string, type: string, size: number) {
  return { name, type, size, arrayBuffer: async () => new ArrayBuffer(0) };
}

describe("Büroklammer (Issue #73, Schritt 1)", () => {
  test("Knopf in Telegram- und (Issue #112) reinen Web-Gesprächen; öffnet die Dateiauswahl", async () => {
    const app = setup();
    await settle();
    expect(app.elements["attach"].hidden).toBe(false);
    expect(app.elements["attach"].disabled).toBe(false);
    app.elements["attach"].dispatch("click");
    expect(app.elements["file-input"].clicks).toBe(1);
    const web = setup({ stored: WEB });
    await settle();
    expect(web.elements["attach"].hidden).toBe(false);
    expect(web.elements["attach"].disabled).toBe(false);
    web.elements["attach"].dispatch("click");
    expect(web.elements["file-input"].clicks).toBe(1);
    // Leerer Verlauf erklärt die Wege auch hier
    expect(web.elements["empty-text"].textContent).toContain("Büroklammer");
    expect(web.elements["empty-text"].textContent).toContain("/b64");
  });

  test("gewählte Dateien werden Chips mit Name, Größe und Entfernen; Senden wird ohne Text möglich", async () => {
    const app = setup();
    await settle();
    expect(app.elements["send"].disabled).toBe(true);
    app.choose(png("a.png"), pdf());
    expect(app.chipNames()).toEqual(["a.png", "rechnung.pdf"]);
    expect(app.elements["attachments"].hidden).toBe(false);
    const [image, doc] = app.chips();
    expect(find(image, "attachment-meta")!.textContent).toBe("40 Bytes");
    expect(doc.attributes["data-status"]).toBe("ready");
    const remove = find(doc, "attachment-remove")!;
    expect(remove.attributes["aria-label"]).toBe("rechnung.pdf entfernen");
    expect(app.elements["send"].disabled).toBe(false);
    // Auswahl zurückgesetzt, damit dieselbe Datei noch einmal geht
    expect(app.elements["file-input"].value).toBe("");
  });

  test("falscher Typ, leere und zu große Dateien und mehr als fünf: klarer Hinweis, nichts angehängt", async () => {
    const app = setup();
    await settle();
    app.choose(new File(["x"], "notiz.txt", { type: "text/plain" }));
    expect(app.chips()).toEqual([]);
    expect(app.note()).toBe("Nur Bilder (PNG, JPEG, WebP, GIF), PDFs und Sprachdateien.");
    app.choose(new File([], "leer.png", { type: "image/png" }));
    expect(app.note()).toBe("Die Datei ist leer.");
    app.choose(bigFile("riesig.png", "image/png", 20 * MB + 1));
    expect(app.note()).toBe("Bild ist zu groß (höchstens 20 MB).");
    app.choose(bigFile("lang.m4a", "audio/mp4", 25 * MB));
    expect(app.chipNames()).toEqual(["lang.m4a"]);
    expect(app.note()).toBe("");
    app.choose(png("1.png"), png("2.png"), png("3.png"), png("4.png"), png("5.png"));
    expect(app.chipNames()).toEqual(["lang.m4a", "1.png", "2.png", "3.png", "4.png"]);
    expect(app.note()).toBe("Höchstens 5 Anhänge je Nachricht.");
    // Ein Video ist kein Anhang (nicht im Umfang)
    const clean = setup();
    await settle();
    clean.choose(new File(["x"], "film.mp4", { type: "video/mp4" }));
    expect(clean.chips()).toEqual([]);
  });

  test("Bilder zeigen eine kleine Vorschau aus den Bytes (data:-URL), andere ein Symbol", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"), pdf(), new File([new Uint8Array([1, 2, 3])], "falsch.png", { type: "image/png" }));
    await settle();
    const [image, doc, fake] = app.chips();
    const thumb = find(image, "attachment-thumb")!;
    expect(thumb.tagName).toBe("img");
    expect(thumb.attributes.src).toStartWith("data:image/png;base64,iVBORw0KGgo");
    expect(thumb.attributes.alt).toBe("");
    expect(find(doc, "attachment-symbol")).toBeDefined();
    // Endung und Typ sagen Bild, die Bytes nicht: keine Vorschau
    expect(find(fake, "attachment-symbol")).toBeDefined();
  });

  test("Bilder über 8 MB bis 20 MB: verkleinerte Vorschau aus einem canvas, nicht die Bytes selbst", async () => {
    const app = setup();
    await settle();
    const big = new File([imageBytes(PNG_HEAD, 12 * MB)], "gross.png", { type: "image/png" });
    const max = new File([imageBytes(JPEG_HEAD, 20 * MB)], "maximal.jpg", { type: "image/jpeg" });
    const fake = new File([new Uint8Array(9 * MB)], "falsch.png", { type: "image/png" });
    app.choose(big, max, fake);
    await settle();
    const [image, jpeg, other] = app.chips();
    for (const chip of [image, jpeg]) {
      const thumb = find(chip, "attachment-thumb")!;
      expect(thumb.tagName).toBe("img");
      // 4000 x 3000 Pixel, längste Seite auf 160 verkleinert
      expect(thumb.attributes.src).toBe("data:image/png;base64," + Buffer.from("klein 160x120").toString("base64"));
    }
    expect(app.decoded).toEqual([big, max]);
    expect(app.canvases.map(c => c.drawn.length)).toEqual([1, 1]);
    // Keine Bild-Bytes am Anfang: Symbol, nichts dekodiert
    expect(find(other, "attachment-symbol")).toBeDefined();
    // Auch per /b64: über 8 MB die verkleinerte Vorschau
    app.chips().forEach(c => find(c, "attachment-remove")!.dispatch("click"));
    app.type("/b64 ");
    app.paste({ text: b64(imageBytes(PNG_HEAD, 9 * MB)) });
    await settle();
    expect(app.chipNames()).toEqual(["bild.png"]);
    expect(find(app.chips()[0], "attachment-thumb")!.attributes.src).toBe("data:image/png;base64," + Buffer.from("klein 160x120").toString("base64"));
    expect(app.decoded).toHaveLength(3);
  });

  test("Entfernen eines Chips entfernt den Anhang", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"), pdf());
    find(app.chips()[0], "attachment-remove")!.dispatch("click");
    expect(app.chipNames()).toEqual(["rechnung.pdf"]);
    find(app.chips()[0], "attachment-remove")!.dispatch("click");
    expect(app.chips()).toEqual([]);
    expect(app.elements["attachments"].hidden).toBe(true);
    expect(app.elements["send"].disabled).toBe(true);
  });

  test("feindliche Dateinamen bleiben Text", async () => {
    const app = setup();
    await settle();
    const evil = '<img src=x onerror="alert(1)">.png';
    app.choose(png(evil));
    expect(app.chipNames()).toEqual([evil]);
    for (const n of all(app.elements["attachments"])) expect(n.innerHTMLWrites).toEqual([]);
  });

  test("geschlossenes Topic: Büroklammer gesperrt, Dateien werden abgelehnt", async () => {
    const app = setup({ stored: "topic-5" });
    await settle();
    expect(app.elements["attach"].disabled).toBe(true);
    app.choose(png());
    expect(app.chips()).toEqual([]);
    expect(app.note()).toBe("Dieses Topic ist geschlossen, Anhänge gehen erst nach „Wieder öffnen“.");
  });

  test("Anhänge gehören zu ihrem Gespräch: beim Wechsel ausgeblendet, beim Zurückkehren wieder da", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"));
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.chips()).toEqual([]);
    app.entry("topic-8").dispatch("click");
    await settle();
    expect(app.chipNames()).toEqual(["a.png"]);
  });
});

describe("Ziehen auf den Chat (Issue #73, Schritt 1)", () => {
  test("Dateien darüber markieren die Fläche ruhig; Loslassen hängt an, Verlassen nimmt die Markierung weg", async () => {
    const app = setup();
    await settle();
    const enter = app.drag("dragenter");
    expect(enter.defaultPrevented).toBe(true);
    expect(app.main.attributes["data-drop"]).toBe("true");
    // Wechsel über Kindelemente: erst das letzte dragleave nimmt die Markierung weg
    app.drag("dragenter");
    app.drag("dragleave");
    expect(app.main.attributes["data-drop"]).toBe("true");
    app.drag("dragleave");
    expect(app.main.attributes["data-drop"]).toBeUndefined();
    app.drag("dragenter");
    const over = app.drag("dragover");
    expect(over.defaultPrevented).toBe(true);
    expect((over.dataTransfer as any).dropEffect).toBe("copy");
    const drop = app.drag("drop", [png("gezogen.png"), pdf()]);
    expect(drop.defaultPrevented).toBe(true);
    expect(app.main.attributes["data-drop"]).toBeUndefined();
    expect(app.chipNames()).toEqual(["gezogen.png", "rechnung.pdf"]);
  });

  test("markierter Text statt Dateien: nichts passiert", async () => {
    const app = setup();
    await settle();
    const event = app.drag("dragenter", [], ["text/plain"]);
    expect(event.defaultPrevented).toBe(false);
    expect(app.main.attributes["data-drop"]).toBeUndefined();
    app.drag("drop", [], ["text/plain"]);
    expect(app.chips()).toEqual([]);
  });

  test("reines Web-Gespräch (Issue #112): Markierung beim Ziehen, beim Loslassen ein Chip", async () => {
    const app = setup({ stored: WEB });
    await settle();
    const enter = app.drag("dragenter", [png()]);
    expect(enter.defaultPrevented).toBe(true);
    expect(app.main.attributes["data-drop"]).toBe("true");
    app.drag("drop", [png("gezogen.png")]);
    expect(app.chipNames()).toEqual(["gezogen.png"]);
    expect(app.note()).toBe("");
  });

  test("daneben fallen gelassen: das Fenster öffnet die Datei nicht", async () => {
    const app = setup();
    await settle();
    const event = { dataTransfer: { types: ["Files"], files: [png()] }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of app.windowListeners.drop ?? []) fn(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("Einfügen aus der Zwischenablage (Issue #73, Schritt 2)", () => {
  test("eingefügtes Bild wird Anhang; das Feld bleibt unverändert", async () => {
    const app = setup();
    await settle();
    app.type("Schau mal");
    const event = app.paste({ files: [png("image.png")] });
    expect(event.defaultPrevented).toBe(true);
    expect(app.chipNames()).toEqual(["image.png"]);
    expect(app.input.value).toBe("Schau mal");
    await settle();
    expect(find(app.chips()[0], "attachment-thumb")!.attributes.src).toStartWith("data:image/png;base64,");
  });

  test("mehrere Bilder auf einmal und nacheinander", async () => {
    const app = setup();
    await settle();
    app.paste({ files: [png("eins.png"), new File([new Uint8Array(JPEG_HEAD)], "zwei.jpg", { type: "image/jpeg" })] });
    app.paste({ files: [png("drei.png")] });
    expect(app.chipNames()).toEqual(["eins.png", "zwei.jpg", "drei.png"]);
  });

  test("ohne files: Datei-Einträge aus items (ältere Browser)", async () => {
    const app = setup();
    await settle();
    const file = png("item.png");
    const event = { clipboardData: { files: [], items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.input.dispatch("paste", event);
    expect(app.chipNames()).toEqual(["item.png"]);
  });

  test("Text wird normal eingefügt, an der Markierung, ohne Anhang", async () => {
    const app = setup();
    await settle();
    app.type("Hallo Welt");
    app.input.selectionStart = app.input.selectionEnd = 6;
    const event = app.paste({ text: "schöne " });
    expect(event.defaultPrevented).toBe(false);
    expect(app.input.value).toBe("Hallo schöne Welt");
    expect(app.chips()).toEqual([]);
    expect(app.elements["attachments"].hidden).toBe(true);
  });

  test("gemischt (Text und Bild): Bild wird Anhang, der Text bleibt erhalten", async () => {
    const app = setup();
    await settle();
    const event = app.paste({ text: "Tabelle aus Word", files: [png("image1.png")] });
    expect(event.defaultPrevented).toBe(false);
    expect(app.input.value).toBe("Tabelle aus Word");
    expect(app.chipNames()).toEqual(["image1.png"]);
  });

  test("kopierte Datei aus dem Finder: der mitkopierte Dateiname landet nicht im Feld", async () => {
    const app = setup();
    await settle();
    const event = app.paste({ text: "rechnung.pdf", files: [pdf()] });
    expect(event.defaultPrevented).toBe(true);
    expect(app.input.value).toBe("");
    expect(app.chipNames()).toEqual(["rechnung.pdf"]);
  });

  test("Bild im reinen Web-Gespräch (Issue #112): wird Chip; Text geht dort weiter normal", async () => {
    const app = setup({ stored: WEB });
    await settle();
    const event = app.paste({ files: [png()] });
    expect(event.defaultPrevented).toBe(true);
    expect(app.chipNames()).toEqual(["screenshot.png"]);
    expect(app.note()).toBe("");
    app.paste({ text: "nur Text" });
    expect(app.input.value).toBe("nur Text");
  });
});

/** Gültige Bilddaten der gewünschten Größe: echter Kopf, danach Füllbytes */
function imageBytes(head: number[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 255;
  bytes.set(head);
  return bytes;
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
/** Zeilenumbrüche wie aus einem Konverter oder einer Mail (76 Zeichen) */
const wrapped = (code: string) => code.match(/.{1,76}/g)!.join("\r\n");

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Echtes PNG (RGB, 8 Bit, ohne Filter) mit Pixeln, die sich kaum komprimieren
 * lassen: IHDR, IDAT, IEND mit gültigen Prüfsummen
 */
function realPng(width: number, height: number): { png: Uint8Array; pixels: Uint8Array } {
  const pixels = new Uint8Array(width * height * 3);
  let seed = 0x2f6b4a1d;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from(PNG_HEAD), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))]);
  return { png: new Uint8Array(png), pixels };
}

/** Dekodiert ein PNG wie oben (RGB, 8 Bit, Filter 0); wirft bei Kopf-, Prüfsummen- oder Datenfehlern */
function decodePng(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(Buffer.from(PNG_HEAD))) throw new Error("kein PNG-Kopf");
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  let ended = false;
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if ((crc32(buf.subarray(pos + 4, pos + 8 + length)) >>> 0) !== buf.readUInt32BE(pos + 8 + length)) throw new Error("Prüfsumme " + type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("Format nicht unterstützt");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") ended = true;
    pos += 12 + length;
  }
  if (!width || !height || !ended) throw new Error("IHDR oder IEND fehlt");
  const raw = inflateSync(Buffer.concat(idat));
  const row = 1 + width * 3;
  if (raw.length !== height * row) throw new Error("Bilddaten passen nicht zur Größe");
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    if (raw[y * row] !== 0) throw new Error("Filter nicht unterstützt");
    pixels.set(raw.subarray(y * row + 1, (y + 1) * row), y * width * 3);
  }
  return { width, height, pixels };
}

/** Kein Request-Text (JSON-Body) enthält ein Stück des Codes */
function expectCodeNeverSent(app: ReturnType<typeof setup>, code: string) {
  const piece = code.replace(/\s+/g, "").slice(40, 120);
  for (const r of app.server.requests) {
    if (typeof r.body === "string") expect(r.body).not.toContain(piece);
    expect(r.path).not.toContain(piece);
    for (const v of Object.values(r.headers)) expect(v).not.toContain(piece);
  }
}

describe("/b64 (Issue #73, Schritt 3)", () => {
  test("/b64 eintippen, Code ohne data-Anfang mit Zeilenumbrüchen einfügen: sofort Bild-Anhang, Feld leer", async () => {
    const app = setup();
    await settle();
    const code = b64(imageBytes(PNG_HEAD, 3000));
    app.type("/b64 ");
    const event = app.paste({ text: wrapped(code) });
    expect(event.defaultPrevented).toBe(true);
    expect(app.input.value).toBe("");
    expect(app.chipNames()).toEqual(["bild.png"]);
    expect(app.note()).toBe("");
    const thumb = find(app.chips()[0], "attachment-thumb")!;
    expect(thumb.attributes.src).toBe("data:image/png;base64," + code);
    expect(find(app.chips()[0], "attachment-meta")!.textContent).toBe("2,9 KB");
  });

  test("ganze Zeile „/b64 data:image/jpeg;base64,…“ eingefügt: JPEG nach den ersten Bytes, nicht nach der Angabe", async () => {
    const app = setup();
    await settle();
    // Angabe sagt png, die Bytes sagen JPEG: es zählen die Bytes
    app.paste({ text: "/b64 data:image/png;base64," + b64(imageBytes(JPEG_HEAD, 500)) });
    expect(app.chipNames()).toEqual(["bild.jpg"]);
    expect(find(app.chips()[0], "attachment-thumb")!.attributes.src).toStartWith("data:image/jpeg;base64,/9j/");
    expect(app.input.value).toBe("");
  });

  test("eingefügter Text, der mit data:image/ beginnt: Bild-Anhang, der übrige Text bleibt", async () => {
    const app = setup();
    await settle();
    app.type("Hier der Fehler: ");
    app.paste({ text: "data:image/webp;base64,\n" + wrapped(b64(imageBytes(WEBP_HEAD, 400))) });
    expect(app.chipNames()).toEqual(["bild.webp"]);
    expect(app.input.value).toBe("Hier der Fehler: ");
  });

  test("getippt statt eingefügt, auch groß geschrieben: beim Senden umgewandelt, hochgeladen, Nachricht nur mit ID", async () => {
    const app = setup();
    await settle();
    const bytes = imageBytes(GIF_HEAD, 900);
    const code = b64(bytes).replace(/=+$/, "");
    app.type("/B64\n" + wrapped(code));
    app.enter();
    await settle();
    const [upload] = app.server.uploads();
    expect(upload.path).toBe("/api/conversations/topic-8/attachments");
    expect(upload.headers["X-File-Name"]).toBe("bild.gif");
    expect(upload.body).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (upload.body as Blob).arrayBuffer())).toEqual(bytes);
    const [post] = app.server.posts();
    const sent = JSON.parse(post.body as string);
    expect(sent).toEqual({ text: "", attachments: [expect.stringMatching(/^[0-9a-f-]{36}$/)] });
    expectCodeNeverSent(app, code);
    expect(app.input.value).toBe("");
    expect(app.chips()).toEqual([]);
  });

  test("2 MB Code: gültiges PNG wird Anhang, der POST an …/messages enthält keinen Base64-Text", async () => {
    const app = setup();
    await settle();
    const { png: bytes, pixels } = realPng(720, 720);
    // Nachweis, dass die Testdaten ein dekodierbares Bild sind
    expect(decodePng(bytes)).toEqual({ width: 720, height: 720, pixels });
    const code = b64(bytes);
    expect(code.length).toBeGreaterThan(2_000_000);
    app.type("/b64 ");
    app.paste({ text: wrapped(code) });
    expect(app.chipNames()).toEqual(["bild.png"]);
    expect(app.input.value).toBe("");
    app.type("Das ist der Screenshot");
    app.enter();
    await settle();
    expect(app.server.uploads()).toHaveLength(1);
    // Hochgeladen werden genau die Bytes des Bildes, und sie lassen sich dekodieren
    const uploaded = new Uint8Array(await (app.server.uploads()[0].body as Blob).arrayBuffer());
    expect(uploaded).toEqual(bytes);
    expect(decodePng(uploaded).pixels).toEqual(pixels);
    const [post] = app.server.posts();
    expect(post.path).toBe("/api/conversations/topic-8/messages");
    const sent = JSON.parse(post.body as string);
    expect(sent.text).toBe("Das ist der Screenshot");
    expect(sent.attachments).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect((post.body as string).length).toBeLessThan(200);
    expect(post.body as string).not.toMatch(/[A-Za-z0-9+/]{200}/);
    expectCodeNeverSent(app, code);
  });

  test("ungültiger Code: klare Meldung, nichts wird gesendet, nichts angehängt", async () => {
    const cases: [string, string][] = [
      ["/b64 das ist kein Code!", "Das ist kein gültiger Base64-Code. Nichts gesendet."],
      ["/b64 " + b64(new TextEncoder().encode("Hallo Welt, kein Bild")), "Der Code ergibt kein Bild (PNG, JPEG, WebP oder GIF). Nichts gesendet."],
      ["/b64", "Nach /b64 fehlt der Base64-Code. Nichts gesendet."],
      ["/b64 data:image/png;base64,", "Nach /b64 fehlt der Base64-Code. Nichts gesendet."],
      ["data:image/svg+xml,<svg onload=alert(1)>", "Das ist kein gültiger Base64-Code. Nichts gesendet."],
      ["/b64 iVBORw0KGgoA=A", "Das ist kein gültiger Base64-Code. Nichts gesendet."],
      ["/b64 A", "Das ist kein gültiger Base64-Code. Nichts gesendet."],
    ];
    for (const [value, message] of cases) {
      const app = setup();
      await settle();
      app.type(value);
      app.submit();
      await settle();
      expect(app.note()).toBe(message);
      expect(app.server.uploads()).toEqual([]);
      expect(app.server.posts()).toEqual([]);
      expect(app.chips()).toEqual([]);
      // Das Feld bleibt, wie es war, zum Korrigieren
      expect(app.input.value).toBe(value);
    }
  });

  test("zu groß (über 20 MB Bild): Meldung vor dem Dekodieren, nichts gesendet", async () => {
    const app = setup();
    await settle();
    app.type("/b64 " + "iVBORw0KGgo" + "A".repeat(28_000_000));
    app.enter();
    await settle();
    expect(app.note()).toBe("Bild ist zu groß (höchstens 20 MB). Nichts gesendet.");
    expect(app.server.posts()).toEqual([]);
  });

  test("ungültigen Code eingefügt: nichts landet im Feld, Meldung", async () => {
    const app = setup();
    await settle();
    app.type("/b64 ");
    const event = app.paste({ text: "%%% kaputt %%%" });
    expect(event.defaultPrevented).toBe(true);
    expect(app.input.value).toBe("/b64 ");
    expect(app.note()).toBe("Das ist kein gültiger Base64-Code. Nichts gesendet.");
    const data = app.paste({ text: "data:image/png;base64,SGFsbG8=" });
    expect(data.defaultPrevented).toBe(true);
    expect(app.input.value).toBe("/b64 ");
    expect(app.note()).toBe("Der Code ergibt kein Bild (PNG, JPEG, WebP oder GIF). Nichts gesendet.");
    app.enter();
    await settle();
    expect(app.server.posts()).toEqual([]);
  });

  test("gemischte Zwischenablage mit gültigem data:image/-Code neben einer Datei: beide Anhänge, der Code fehlt im Request-Text", async () => {
    const app = setup();
    await settle();
    app.type("Hier der Fehler: ");
    const code = b64(imageBytes(PNG_HEAD, 3000));
    const event = app.paste({ text: "data:image/png;base64," + code, files: [pdf()] });
    expect(event.defaultPrevented).toBe(true);
    expect(app.input.value).toBe("Hier der Fehler: ");
    expect(app.chipNames()).toEqual(["bild.png", "rechnung.pdf"]);
    expect(app.note()).toBe("");
    app.enter();
    await settle();
    expect(app.server.uploads()).toHaveLength(2);
    const sent = bodyOf(app.server.posts()[0]);
    expect(sent.text).toBe("Hier der Fehler: ");
    expect(sent.attachments).toHaveLength(2);
    expectCodeNeverSent(app, code);
  });

  test("gemischte Zwischenablage mit gültigem Code nach getipptem /b64 neben einem Bild: Code wird Anhang, nicht Text", async () => {
    const app = setup();
    await settle();
    app.type("/b64 ");
    const code = b64(imageBytes(JPEG_HEAD, 2000));
    const event = app.paste({ text: code, files: [png("image.png")] });
    expect(event.defaultPrevented).toBe(true);
    expect(app.input.value).toBe("");
    expect(app.chipNames()).toEqual(["bild.jpg", "image.png"]);
    app.type("Zwei Bilder");
    app.enter();
    await settle();
    expect(bodyOf(app.server.posts()[0])).toEqual({ text: "Zwei Bilder", attachments: [expect.any(String), expect.any(String)] });
    expectCodeNeverSent(app, code);
  });

  test("gemischte Zwischenablage mit ungültigem Code neben einer Datei: Meldung, nichts angehängt, der Code geht nie raus", async () => {
    // Vorhandener Text plus data:image/-Text, der kein Bild ist
    const app = setup();
    await settle();
    app.type("Hier der Fehler: ");
    const bad = "data:image/png;base64," + b64(new TextEncoder().encode("kein Bild, nur Text ".repeat(20)));
    const event = app.paste({ text: bad, files: [png("image.png")] });
    expect(event.defaultPrevented).toBe(true);
    expect(app.input.value).toBe("Hier der Fehler: ");
    expect(app.chips()).toEqual([]);
    expect(app.note()).toBe("Der Code ergibt kein Bild (PNG, JPEG, WebP oder GIF). Nichts gesendet.");
    expect(app.server.requests.filter(r => r.method === "POST")).toEqual([]);
    app.enter();
    await settle();
    expect(app.server.uploads()).toEqual([]);
    expect(app.server.posts().map(bodyOf)).toEqual([{ text: "Hier der Fehler: " }]);
    expectCodeNeverSent(app, bad);

    // Nach getipptem /b64: ungültiger Code verhindert das Senden ganz
    const b = setup();
    await settle();
    b.type("/b64 ");
    const pasted = b.paste({ text: "%%% kaputt %%%", files: [png("image.png")] });
    expect(pasted.defaultPrevented).toBe(true);
    expect(b.input.value).toBe("/b64 ");
    expect(b.chips()).toEqual([]);
    expect(b.note()).toBe("Das ist kein gültiger Base64-Code. Nichts gesendet.");
    b.enter();
    await settle();
    expect(b.server.uploads()).toEqual([]);
    expect(b.server.posts()).toEqual([]);
  });

  test("normaler Text mit „/b64“ mittendrin oder „/b64x“ bleibt Text", async () => {
    const app = setup();
    await settle();
    app.paste({ text: "Was macht /b64 genau?" });
    expect(app.input.value).toBe("Was macht /b64 genau?");
    app.enter();
    await settle();
    app.idle();
    app.type("/b64x");
    app.enter();
    await settle();
    expect(app.server.posts().map(p => JSON.parse(p.body as string))).toEqual([{ text: "Was macht /b64 genau?" }, { text: "/b64x" }]);
    expect(app.chips()).toEqual([]);
  });

  test("reines Web-Gespräch (Issue #112): /b64 wird Bild, Upload und Nachricht gehen an dieses Gespräch, der Code nie", async () => {
    const app = setup({ stored: WEB });
    await settle();
    const code = b64(imageBytes(PNG_HEAD, 300));
    app.type("/b64 " + code);
    app.enter();
    await settle();
    expect(app.note()).toBe("");
    expect(app.server.uploads().map(u => u.path)).toEqual([`/api/conversations/${WEB}/attachments`]);
    expect(app.server.posts().map(p => p.path)).toEqual([`/api/conversations/${WEB}/messages`]);
    expect(JSON.parse(app.server.posts()[0].body as string)).toEqual({ text: "", attachments: [expect.any(String)] });
    expectCodeNeverSent(app, code);
  });

  test("geschlossenes Topic: /b64 bleibt gesperrt, Hinweis, nichts gesendet", async () => {
    const app = setup({ stored: "topic-5" });
    await settle();
    const code = b64(imageBytes(PNG_HEAD, 300));
    app.paste({ text: "data:image/png;base64," + code });
    expect(app.chips()).toEqual([]);
    expect(app.server.requests.filter(r => r.method === "POST")).toEqual([]);
  });

  test("/b64 steht in der Befehlsliste, auch im reinen Web-Gespräch (Issue #112)", async () => {
    const app = setup();
    await settle();
    app.type("/b");
    await settle();
    const names = app.elements["command-list"].children.filter(c => c.className === "command-option").map(o => o.attributes["data-name"]);
    expect(names).toContain("b64");
    const web = setup({ stored: WEB });
    await settle();
    web.type("/b");
    await settle();
    const webNames = web.elements["command-list"].children.filter(c => c.className === "command-option").map(o => o.attributes["data-name"]);
    expect(webNames).toContain("b64");
  });
});

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-9222-222222222222";
const apiAttachment = (conversation: string, id: string, name: string, mime = "image/png") => ({
  id,
  name,
  size: 2048,
  mime,
  kind: mime === "application/pdf" ? "document" : mime.startsWith("audio/") ? "audio" : "image",
  url: `/api/conversations/${conversation}/attachments/${id}`,
  ...(mime.startsWith("image/") ? { previewUrl: `/api/conversations/${conversation}/attachments/${id}?inline=1` } : {}),
});
const bodyOf = (r: Request) => JSON.parse(r.body as string);

describe("Chips, Hochladen und Fehler (Issue #73, Schritt 4)", () => {
  test("Senden lädt erst hoch (Rohdaten, Name kodiert), dann die Nachricht mit den IDs; Fortschritt am Chip", async () => {
    const app = setup();
    await settle();
    app.choose(png("Bildschirmfoto 1.png"), pdf("Über uns.pdf"));
    app.type("Bitte ansehen");
    let release!: () => void;
    app.server.uploadGate = new Promise<void>(r => { release = r; });
    app.enter();
    await settle();
    const [first, second] = app.chips();
    expect(first.attributes["data-status"]).toBe("uploading");
    expect(find(first, "attachment-meta")!.textContent).toBe("Lädt hoch …");
    expect(second.attributes["data-status"]).toBe("ready");
    expect(find(first, "attachment-remove")!.disabled).toBe(true);
    expect(app.elements["attach"].disabled).toBe(true);
    expect(app.elements["send"].disabled).toBe(true);
    expect(app.server.posts()).toEqual([]);
    app.server.uploadGate = null;
    release();
    await settle();
    const uploads = app.server.uploads();
    expect(uploads.map(u => u.headers["X-File-Name"])).toEqual(["Bildschirmfoto%201.png", "%C3%9Cber%20uns.pdf"]);
    expect(uploads.every(u => u.body instanceof Blob)).toBe(true);
    // Reihenfolge: beide Uploads, dann genau ein POST an …/messages
    const order = app.server.requests.filter(r => r.method === "POST").map(r => r.path.split("/").at(-1));
    expect(order).toEqual(["attachments", "attachments", "messages"]);
    const sent = bodyOf(app.server.posts()[0]);
    expect(sent.text).toBe("Bitte ansehen");
    expect(sent.attachments).toHaveLength(2);
    expect(app.chips()).toEqual([]);
    expect(app.elements["attachments"].hidden).toBe(true);
    expect(app.input.value).toBe("");
  });

  test("anhangreine Nachricht (ohne Text) geht raus; anhanglose Nachricht wie bisher ohne Feld attachments", async () => {
    const app = setup();
    await settle();
    app.type("Nur Text");
    app.enter();
    await settle();
    expect(bodyOf(app.server.posts()[0])).toEqual({ text: "Nur Text" });
    app.idle();
    app.choose(png());
    app.submit();
    await settle();
    expect(bodyOf(app.server.posts()[1])).toEqual({ text: "", attachments: [expect.any(String)] });
    expect(app.server.uploads()).toHaveLength(1);
  });

  test("Uploadfehler: Meldung am Chip, keine Nachricht; Wiederholen lädt nur den fehlgeschlagenen, die ID des anderen bleibt", async () => {
    const app = setup();
    await settle();
    app.choose(png("ok.png"), png("kaputt.png"));
    app.type("Zwei Bilder");
    app.server.uploadReplies = [
      { status: 201, data: { id: ID_A, name: "ok.png", size: 40, mime: "image/png", kind: "image" } },
      { status: 415, data: { error: "Dateityp nicht erlaubt." } },
    ];
    app.enter();
    await settle();
    expect(app.server.posts()).toEqual([]);
    const [ok, bad] = app.chips();
    expect(ok.attributes["data-status"]).toBe("done");
    expect(find(ok, "attachment-meta")!.textContent).toBe("40 Bytes · hochgeladen");
    expect(bad.attributes["data-status"]).toBe("error");
    expect(find(bad, "attachment-meta")!.textContent).toBe("Dateityp nicht erlaubt.");
    expect(app.note()).toBe("Nicht alle Anhänge sind hochgeladen. Senden versucht es noch einmal, oder den Anhang entfernen.");
    expect(app.input.value).toBe("Zwei Bilder");
    expect(find(bad, "attachment-remove")!.disabled).toBe(false);
    // Wiederholen
    app.server.uploadReplies = [{ status: 201, data: { id: ID_B, name: "kaputt.png", size: 40, mime: "image/png", kind: "image" } }];
    app.enter();
    await settle();
    expect(app.server.uploads()).toHaveLength(3);
    expect(bodyOf(app.server.posts()[0])).toEqual({ text: "Zwei Bilder", attachments: [ID_A, ID_B] });
    expect(app.chips()).toEqual([]);
    expect(app.note()).toBe("");
  });

  test("Server nicht erreichbar beim Hochladen: Meldung am Chip, keine Nachricht; fehlerhaften Chip entfernen und senden", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"), png("b.png"));
    app.server.uploadReplies = [{ status: 201, data: { id: ID_A } }, "offline"];
    app.submit();
    await settle();
    expect(find(app.chips()[1], "attachment-meta")!.textContent).toBe("Server nicht erreichbar.");
    expect(app.server.posts()).toEqual([]);
    find(app.chips()[1], "attachment-remove")!.dispatch("click");
    app.submit();
    await settle();
    expect(app.server.uploads()).toHaveLength(2);
    expect(bodyOf(app.server.posts()[0]).attachments).toEqual([ID_A]);
  });

  test("Gesprächswechsel während des Uploads: keine Nachricht ins falsche Gespräch; zurück bleibt die ID, Senden lädt nicht erneut", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"));
    app.type("Mit Bild");
    let release!: () => void;
    app.server.uploadGate = new Promise<void>(r => { release = r; });
    app.server.uploadReplies = [{ status: 201, data: { id: ID_A } }];
    app.enter();
    await settle();
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.chips()).toEqual([]);
    app.server.uploadGate = null;
    release();
    await settle();
    expect(app.server.posts()).toEqual([]);
    expect(app.server.uploads()[0].path).toBe("/api/conversations/topic-8/attachments");
    app.entry("topic-8").dispatch("click");
    await settle();
    expect(app.chips()[0].attributes["data-status"]).toBe("done");
    expect(app.input.value).toBe("Mit Bild");
    app.enter();
    await settle();
    expect(app.server.uploads()).toHaveLength(1);
    const [post] = app.server.posts();
    expect(post.path).toBe("/api/conversations/topic-8/messages");
    expect(bodyOf(post)).toEqual({ text: "Mit Bild", attachments: [ID_A] });
  });

  test("Nachricht abgelehnt: Chips bleiben; bei abgelaufenen Uploads lädt das nächste Senden neu", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"));
    app.type("/help");
    app.server.uploadReplies = [{ status: 201, data: { id: ID_A } }];
    app.server.postReply = { status: 400, data: { error: "Befehle nehmen keine Anhänge. Bitte den Befehl ohne Anhang schicken." } };
    app.submit();
    await settle();
    expect(app.chips()[0].attributes["data-status"]).toBe("done");
    expect(app.shown().at(-1)!.children[0].textContent).toBe("Befehle nehmen keine Anhänge. Bitte den Befehl ohne Anhang schicken.");
    app.type("Jetzt mit Text");
    app.server.postReply = { status: 400, data: { error: "Anhang unbekannt, schon abgeschickt oder aus einem anderen Gespräch." } };
    app.submit();
    await settle();
    expect(app.server.uploads()).toHaveLength(1);
    expect(app.chips()[0].attributes["data-status"]).toBe("ready");
    app.server.postReply = null;
    app.submit();
    await settle();
    expect(app.server.uploads()).toHaveLength(2);
    expect(app.chips()).toEqual([]);
  });

  test("Einfügen und Ziehen während eines verzögerten Uploads: sichtbar abgelehnt, gesendet wird nur der hochgeladene Anhang", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"));
    app.type("Mit Bild");
    let release!: () => void;
    app.server.uploadGate = new Promise<void>(r => { release = r; });
    app.enter();
    await settle();
    expect(app.chips()[0].attributes["data-status"]).toBe("uploading");
    const pasted = app.paste({ files: [png("spaet.png")] });
    expect(pasted.defaultPrevented).toBe(true);
    expect(app.note()).toBe("Die Nachricht wird gerade gesendet. Weitere Anhänge bitte danach hinzufügen.");
    app.drag("dragenter", [png("gezogen.png")]);
    app.drag("drop", [png("gezogen.png")]);
    const code = b64(imageBytes(PNG_HEAD, 400));
    const b64Paste = app.paste({ text: "data:image/png;base64," + code });
    expect(b64Paste.defaultPrevented).toBe(true);
    expect(app.chipNames()).toEqual(["a.png"]);
    app.server.uploadGate = null;
    release();
    await settle();
    expect(app.server.uploads()).toHaveLength(1);
    const [post] = app.server.posts();
    expect(bodyOf(post)).toEqual({ text: "Mit Bild", attachments: [expect.stringMatching(/^[0-9a-f-]{36}$/)] });
    expect(app.chips()).toEqual([]);
    // Kein stiller Verlust: der Hinweis bleibt nach dem Senden stehen
    expect(app.note()).toBe("Die Nachricht wird gerade gesendet. Weitere Anhänge bitte danach hinzufügen.");
    expect(app.input.value).toBe("");
    expectCodeNeverSent(app, code);
    // Danach geht es wieder
    app.idle();
    app.paste({ files: [png("spaet.png")] });
    expect(app.chipNames()).toEqual(["spaet.png"]);
    expect(app.note()).toBe("");
  });

  test("Einfügen und Ziehen während eines verzögerten Nachrichten-POSTs: sichtbar abgelehnt, keine null-IDs, nichts verschwindet still", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"), pdf());
    app.type("Zwei Anhänge");
    let release!: () => void;
    app.server.postGate = new Promise<void>(r => { release = r; });
    app.enter();
    await settle();
    expect(app.server.uploads()).toHaveLength(2);
    expect(app.chips().map(c => c.attributes["data-status"])).toEqual(["done", "done"]);
    app.paste({ files: [png("spaet.png")] });
    expect(app.note()).toBe("Die Nachricht wird gerade gesendet. Weitere Anhänge bitte danach hinzufügen.");
    app.drag("drop", [png("gezogen.png")]);
    app.choose(png("gewaehlt.png"));
    app.type("Noch was");
    expect(app.chipNames()).toEqual(["a.png", "rechnung.pdf"]);
    app.server.postGate = null;
    release();
    await settle();
    const posts = app.server.posts();
    expect(posts).toHaveLength(1);
    const sent = bodyOf(posts[0]);
    expect(sent.text).toBe("Zwei Anhänge");
    expect(sent.attachments).toHaveLength(2);
    for (const id of sent.attachments) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(app.server.uploads()).toHaveLength(2);
    expect(app.chips()).toEqual([]);
    expect(app.note()).toBe("Die Nachricht wird gerade gesendet. Weitere Anhänge bitte danach hinzufügen.");
    // Während des POSTs Getipptes bleibt stehen
    expect(app.input.value).toBe("Noch was");
  });

  test("Gesprächswechsel während des Nachrichten-POSTs: gesendete Anhänge und Text sind beim Zurückkehren weg, ein neuer Entwurf bleibt", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"), pdf());
    app.type("Zwei Anhänge");
    let release!: () => void;
    app.server.postGate = new Promise<void>(r => { release = r; });
    app.enter();
    await settle();
    expect(app.server.uploads()).toHaveLength(2);
    app.entry("topic-9").dispatch("click");
    await settle();
    app.type("Entwurf in Strategie");
    app.server.postGate = null;
    release();
    await settle();
    expect(app.server.posts()).toHaveLength(1);
    app.entry("topic-8").dispatch("click");
    await settle();
    // Nichts wird ein zweites Mal angeboten, der gesendete Text steht nicht mehr im Feld
    expect(app.chips()).toEqual([]);
    expect(app.elements["attachments"].hidden).toBe(true);
    expect(app.input.value).toBe("");
    expect(app.elements["send"].disabled).toBe(true);
    app.enter();
    await settle();
    expect(app.server.posts()).toHaveLength(1);
    expect(app.server.uploads()).toHaveLength(2);
    // Der Entwurf im anderen Gespräch bleibt
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.input.value).toBe("Entwurf in Strategie");
  });

  test("Gesprächswechsel während des Nachrichten-POSTs, danach neu Getipptes im Ausgangsgespräch bleibt stehen", async () => {
    const app = setup();
    await settle();
    app.choose(png("a.png"));
    app.type("Mit Bild");
    let release!: () => void;
    app.server.postGate = new Promise<void>(r => { release = r; });
    app.enter();
    await settle();
    app.entry("topic-9").dispatch("click");
    await settle();
    app.entry("topic-8").dispatch("click");
    await settle();
    app.type("Neuer Entwurf");
    app.server.postGate = null;
    release();
    await settle();
    expect(app.chips()).toEqual([]);
    expect(app.input.value).toBe("Neuer Entwurf");
    app.entry("topic-9").dispatch("click");
    await settle();
    app.entry("topic-8").dispatch("click");
    await settle();
    expect(app.chips()).toEqual([]);
    expect(app.input.value).toBe("Neuer Entwurf");
  });

  test("Antwort auf eine Rückfrage nimmt keine Anhänge: Hinweis, nichts gesendet", async () => {
    const app = setup();
    await settle();
    app.conversationSource().emit("message", { data: JSON.stringify({ id: "q", role: "assistant", text: "Freigeben?", approvalId: "ap1", createdAt: new Date().toISOString() }) });
    app.conversationSource().emit("status", { data: JSON.stringify({ running: true, awaiting: true, approvalId: "ap1" }) });
    app.choose(png());
    app.type("ja");
    app.submit();
    await settle();
    expect(app.note()).toBe("Eine Antwort auf eine Rückfrage nimmt keine Anhänge. Erst antworten, dann die Anhänge schicken.");
    expect(app.server.uploads()).toEqual([]);
    expect(app.server.posts()).toEqual([]);
  });

  test("/stop während einer Antwort geht ohne Anhänge raus, die Chips bleiben", async () => {
    const app = setup();
    await settle();
    app.conversationSource().emit("status", { data: JSON.stringify({ running: true }) });
    app.choose(png());
    app.type("/stop");
    app.submit();
    await settle();
    expect(app.server.uploads()).toEqual([]);
    expect(bodyOf(app.server.posts()[0])).toEqual({ text: "/stop" });
    expect(app.chips()).toHaveLength(1);
  });
});

describe("Anhänge im Verlauf (Issue #73, Schritt 4)", () => {
  const cards = (message: Node) => all(message).filter(n => n.className === "file");

  test("POST-Antwort: eigene Nachricht zeigt Bildvorschau und Dateikarte über dem Text; ohne Text keine leere Blase", async () => {
    const app = setup();
    await settle();
    app.choose(png());
    app.submit();
    await settle();
    const message = app.shown().at(-1)!;
    expect(message.className).toBe("msg msg-user msg-with-attachments");
    const [card] = cards(message);
    const preview = find(card, "file-preview")!;
    expect(preview.attributes.src).toMatch(/^\/api\/conversations\/topic-8\/attachments\/[0-9a-f-]{36}\?inline=1$/);
    expect(find(card, "file-download")!.attributes.href).toMatch(/^\/api\/conversations\/topic-8\/attachments\/[0-9a-f-]{36}$/);
    expect(find(message, "bubble")).toBeUndefined();
  });

  test("nach dem Neuladen (Verlauf) und live (SSE): Karten mit Namen als Text, PDF ohne Vorschau", async () => {
    const evil = "<img src=x onerror=alert(1)>.png";
    const history = {
      "topic-8": [
        { id: "m1", role: "user", text: "Zwei Dateien", createdAt: "2026-09-25T08:00:00.000Z", attachments: [apiAttachment("topic-8", ID_A, evil), apiAttachment("topic-8", ID_B, "vertrag.pdf", "application/pdf")] },
      ],
    };
    const app = setup({ history });
    await settle();
    const message = app.shown()[0];
    const [image, doc] = cards(message);
    expect(find(image, "file-name")!.textContent).toBe(evil);
    expect(find(image, "file-preview")!.attributes.alt).toBe(evil);
    expect(find(doc, "file-preview")).toBeUndefined();
    expect(find(doc, "file-download")!.attributes.download).toBe("vertrag.pdf");
    expect(find(message, "bubble")!.textContent).toBe("Zwei Dateien");
    for (const n of all(message)) expect(n.innerHTMLWrites).toEqual([]);
    app.conversationSource().emit("message", { data: JSON.stringify({ id: "m2", role: "user", text: "", createdAt: "2026-09-25T08:01:00.000Z", attachments: [apiAttachment("topic-8", ID_A, "live.png")] }) });
    expect(find(cards(app.shown()[1])[0], "file-name")!.textContent).toBe("live.png");
  });

  test("fremde oder kaputte Adressen werden nicht angezeigt; Vorschau nur zur eigenen Adresse", async () => {
    const good = apiAttachment("topic-8", ID_A, "gut.png");
    const history = {
      "topic-8": [
        {
          id: "m1",
          role: "user",
          text: "x",
          createdAt: "2026-09-25T08:00:00.000Z",
          attachments: [
            { ...good, url: "https://evil.example/x.png" },
            { ...good, url: "/api/files/" + ID_A },
            { ...good, url: "javascript:alert(1)" },
            { ...good, previewUrl: "https://evil.example/p.png" },
            null,
          ],
        },
        { id: "m2", role: "assistant", text: "Antwort", createdAt: "2026-09-25T08:00:01.000Z", attachments: [good] },
      ],
    };
    const app = setup({ history });
    await settle();
    const [only] = cards(app.shown()[0]);
    expect(cards(app.shown()[0])).toHaveLength(1);
    expect(find(only, "file-preview")).toBeUndefined();
    expect(find(only, "file-download")!.attributes.href).toBe(good.url);
    // Anhänge nur an eigenen Nachrichten
    expect(cards(app.shown()[1])).toEqual([]);
  });
});

describe("Anhänge im reinen Web-Gespräch (Issue #112)", () => {
  const cards = (message: Node) => all(message).filter(n => n.className === "file");

  test("Büroklammer, Senden: Upload und Nachricht an dieses Gespräch, Karte mit Vorschau über dem Text", async () => {
    const app = setup({ stored: WEB });
    await settle();
    app.choose(png("Bildschirmfoto.png"));
    app.type("Was siehst du?");
    app.enter();
    await settle();
    expect(app.server.uploads().map(u => u.path)).toEqual([`/api/conversations/${WEB}/attachments`]);
    const post = app.server.posts()[0];
    expect(post.path).toBe(`/api/conversations/${WEB}/messages`);
    expect(bodyOf(post)).toEqual({ text: "Was siehst du?", attachments: [expect.any(String)] });
    const message = app.shown().at(-1)!;
    expect(message.className).toBe("msg msg-user msg-with-attachments");
    const [card] = cards(message);
    expect(find(card, "file-preview")!.attributes.src).toBe(`/api/conversations/${WEB}/attachments/${bodyOf(post).attachments[0]}?inline=1`);
    expect(find(message, "bubble")!.textContent).toBe("Was siehst du?");
  });

  test("Verlauf nach dem Neuladen: Karten mit Adressen des Web-Gesprächs; fremde Gesprächs-IDs in der Adresse fallen weg", async () => {
    const history = {
      [WEB]: [
        {
          id: "m1",
          role: "user",
          text: "",
          createdAt: "2026-09-25T08:00:00.000Z",
          attachments: [
            apiAttachment(WEB, ID_A, "foto.png"),
            apiAttachment(WEB, ID_B, "vertrag.pdf", "application/pdf"),
            { ...apiAttachment(WEB, ID_A, "x.png"), url: `/api/conversations/../attachments/${ID_A}` },
            { ...apiAttachment(WEB, ID_A, "y.png"), url: `/api/conversations/c1/attachments/${ID_A}` },
          ],
        },
      ],
    };
    const app = setup({ stored: WEB, history });
    await settle();
    const list = cards(app.shown()[0]);
    expect(list.map(c => find(c, "file-name")!.textContent)).toEqual(["foto.png", "vertrag.pdf"]);
    expect(find(list[0], "file-preview")!.attributes.src).toBe(`/api/conversations/${WEB}/attachments/${ID_A}?inline=1`);
    expect(find(list[1], "file-download")!.attributes.href).toBe(`/api/conversations/${WEB}/attachments/${ID_B}`);
    expect(find(app.shown()[0], "bubble")).toBeUndefined();
  });

  test("Verlauf nach dem Neuladen: Sprachdatei lässt sich abspielen, geladen über die Route des Gesprächs", async () => {
    const voice = apiAttachment(WEB, ID_B, "notiz.webm", "audio/webm");
    const app = setup({ stored: WEB, history: { [WEB]: [{ id: "m1", role: "user", text: "", createdAt: "2026-09-25T08:00:00.000Z", attachments: [voice] }] } });
    await settle();
    const [card] = cards(app.shown()[0]);
    const play = find(card, "attachment-play")!;
    expect(play.attributes["aria-label"]).toBe("notiz.webm abspielen");
    expect(find(card, "file-download")!.attributes.href).toBe(voice.url);
    const player = all(card).find(n => n.attributes.preload === "none")!;
    let played = 0;
    player.play = () => { played++; return Promise.resolve(); };
    // Nichts wird geladen, bevor jemand abspielt
    expect(app.server.requests.some(r => r.path === voice.url)).toBe(false);
    expect(player.attributes.src).toBeUndefined();
    play.dispatch("click");
    await settle();
    expect(app.server.requests.filter(r => r.method === "GET" && r.path === voice.url)).toHaveLength(1);
    expect(app.objectUrls).toHaveLength(1);
    expect(app.objectUrls[0].type).toBe("audio/webm");
    expect(player.attributes.src).toBe("blob:https://app.tybo.ai/1");
    expect(played).toBe(1);
    // Zweites Abspielen lädt nicht neu
    play.dispatch("click");
    await settle();
    expect(app.server.requests.filter(r => r.path === voice.url)).toHaveLength(1);
    expect(played).toBe(2);
  });

  /** Audio-Attrappe wie im Browser: play/pause setzen paused und lösen die Ereignisse aus */
  const fakeAudio = (player: Node) => {
    player.paused = true;
    player.ended = false;
    let played = 0;
    player.play = () => { played++; player.paused = false; player.dispatch("play"); return Promise.resolve(); };
    player.pause = () => { player.paused = true; player.dispatch("pause"); };
    return { played: () => played };
  };
  const voiceHistory = () => ({
    [WEB]: [{ id: "m1", role: "user", text: "", createdAt: "2026-09-25T08:00:00.000Z", attachments: [apiAttachment(WEB, ID_B, "notiz.webm", "audio/webm")] }],
  });

  test("Download dauert, dann Gesprächswechsel: keine Wiedergabe, keine Objekt-URL, alter Player gestoppt", async () => {
    const app = setup({ stored: WEB, history: voiceHistory() });
    await settle();
    const [card] = cards(app.shown()[0]);
    const player = all(card).find(n => n.attributes.preload === "none")!;
    const audio = fakeAudio(player);
    let release!: () => void;
    app.server.downloadGate = new Promise<void>(r => { release = r; });
    find(card, "attachment-play")!.dispatch("click");
    await settle();
    // Wechsel zu einem Topic, während die Datei noch lädt
    app.entry("topic-8").dispatch("click");
    await settle();
    release();
    await settle();
    expect(audio.played()).toBe(0);
    expect(app.objectUrls).toHaveLength(0);
    expect(player.attributes.src).toBeUndefined();
  });

  test("Gesprächswechsel während der Wiedergabe: Player gestoppt, Objekt-URL freigegeben", async () => {
    const app = setup({ stored: WEB, history: voiceHistory() });
    await settle();
    const [card] = cards(app.shown()[0]);
    const player = all(card).find(n => n.attributes.preload === "none")!;
    fakeAudio(player);
    find(card, "attachment-play")!.dispatch("click");
    await settle();
    expect(player.paused).toBe(false);
    app.entry("topic-8").dispatch("click");
    await settle();
    expect(player.paused).toBe(true);
    expect(player.attributes.src).toBeUndefined();
    expect(app.revokedUrls).toEqual(["blob:https://app.tybo.ai/1"]);
  });

  test("Neue Nachricht während der Wiedergabe: derselbe Player läuft weiter, Pauseknopf im Verlauf", async () => {
    const app = setup({ stored: WEB, history: voiceHistory() });
    await settle();
    const [card] = cards(app.shown()[0]);
    const player = all(card).find(n => n.attributes.preload === "none")!;
    fakeAudio(player);
    find(card, "attachment-play")!.dispatch("click");
    await settle();
    expect(player.paused).toBe(false);
    app.conversationSource().emit("message", { data: JSON.stringify({ id: "m2", role: "assistant", text: "Hallo", createdAt: "2026-09-25T08:01:00.000Z" }) });
    await settle();
    expect(app.shown()).toHaveLength(2);
    const [rebuilt] = cards(app.shown()[0]);
    expect(all(rebuilt)).toContain(player);
    const pause = find(rebuilt, "attachment-play")!;
    expect(pause.attributes["aria-label"]).toBe("Pause");
    expect(player.paused).toBe(false);
    expect(app.revokedUrls).toEqual([]);
    pause.dispatch("click");
    expect(player.paused).toBe(true);
    expect(pause.attributes["aria-label"]).toBe("notiz.webm abspielen");
  });

  test("Telegram-Gespräch: Sprachdatei im Verlauf bleibt Karte mit Download, ohne Abspielen", async () => {
    const voice = apiAttachment("topic-8", ID_B, "notiz.webm", "audio/webm");
    const app = setup({ history: { "topic-8": [{ id: "m1", role: "user", text: "", createdAt: "2026-09-25T08:00:00.000Z", attachments: [voice] }] } });
    await settle();
    const [card] = cards(app.shown()[0]);
    expect(find(card, "file-download")!.attributes.href).toBe(voice.url);
    expect(find(card, "attachment-play")).toBeUndefined();
  });
});

describe("Leerzustand (Issue #73)", () => {
  test("Telegram-Gespräch ohne Verlauf erwähnt Büroklammer, Einfügen und /b64", async () => {
    const app = setup();
    await settle();
    const text = app.elements["empty-text"].textContent;
    expect(text).toContain("Strg/Cmd+V");
    expect(text).toContain("/b64");
    expect(text).toContain("Büroklammer");
  });
});

describe("Oberfläche statisch (Issue #73)", () => {
  test("index.html: Büroklammer links in der Box, Dateiauswahl für Bilder, PDF und Audio, Chips über der Eingabe", () => {
    const box = html.slice(html.indexOf('<div class="composer-box">'));
    expect(box.indexOf('id="attach"')).toBeLessThan(box.indexOf("<textarea"));
    expect(html).toContain('accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,audio/*"');
    expect(html.indexOf('id="attachments"')).toBeLessThan(html.indexOf('<div class="composer-box">'));
    // Sprachaufnahme nur im sicheren Kontext (Nachtrag zu Entscheidung 0012, Issue #109): Knopf startet versteckt
    expect(html).toMatch(/<button[^>]*id="record"[^>]*hidden>/);
    expect(source).toContain("win.isSecureContext === true");
  });

  test("style.css: Markierung der Ablagefläche und Chips nur mit vorhandenen Variablen, ohne Animation", () => {
    const start = css.indexOf("Anhänge vor dem Senden (Issue #73)");
    const block = css.slice(start, css.indexOf(".composer textarea", start));
    expect(start).toBeGreaterThan(0);
    expect(block).toContain('.main[data-drop="true"] .chat-log');
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/#[0-9a-f]{3,6}\b|animation|transition/i);
  });
});
