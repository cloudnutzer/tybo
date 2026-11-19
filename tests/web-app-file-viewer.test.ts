// Dateien in der installierten App auf dem iPhone und der Betrachter für
// Bilder und HTML-Dateien (Issue #708). Ohne Browser: DOM, fetch und
// navigator.share als Attrappen. call.js läuft mit, weil app.js die
// Erkennung „installierte App auf iPhone oder iPad" von dort nimmt
// (callIosApp), wie im Browser, wo beide Skripte nacheinander laden.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const appSource = await readFile(resolve(publicDir, "app.js"), "utf8");
const callSource = await readFile(resolve(publicDir, "call.js"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");

interface Node {
  tagName: string;
  children: Node[];
  attributes: Record<string, string>;
  listeners: Record<string, ((e: any) => void)[]>;
  [key: string]: any;
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";

const FILE_ID = "3f2b8c1e-7d4a-4b6e-9c21-5a0d8e7f6b13";
const NOTICE = { id: "n1", role: "assistant", kind: "notice", source: "datei", text: "Datei", createdAt: "2026-11-17T22:44:00.000Z" };
const IMAGE = { id: FILE_ID, name: "from-patch-to-exploit-variante-2.png", size: 2_411_724, mime: "image/png" };
const REPORT = { id: FILE_ID, name: "Bericht März.html", size: 2048, mime: "text/html" };
const WEB = "33333333-3333-4333-8333-333333333333";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";

type FetchReply = Response | "offline";

interface Options {
  userAgent?: string;
  /** navigator.standalone (nur iOS kennt die Eigenschaft) */
  standalone?: boolean;
  /** (display-mode: standalone), etwa die installierte App unter Android */
  displayMode?: boolean;
  /** false: navigator.share und canShare fehlen; "refuses": canShare lehnt Dateien ab */
  share?: boolean | "refuses";
}

function setup(options: Options = {}) {
  const state = {
    dialogs: [] as Node[],
    fetches: [] as { path: string; init: any }[],
    /** Antworten auf die nächsten Abrufe; ohne: die Datei */
    replies: [] as FetchReply[],
    /** Solange gesetzt, wartet jeder Abruf darauf */
    gate: null as null | Promise<void>,
    shares: [] as { files: File[] }[],
    /** Ausgang der nächsten Aufrufe von share; ohne: gelingt */
    shareErrors: [] as (string | null)[],
  };
  const document: Record<string, any> = {
    activeElement: null as Node | null,
    getElementById: () => null,
    createElement(tag: string) {
      const n = node(tag);
      if (tag === "dialog") {
        n.open = false;
        n.showModal = () => { n.open = true; };
        n.close = () => {
          if (!n.open) return;
          n.open = false;
          n.dispatch("close");
        };
        state.dialogs.push(n);
      }
      return n;
    },
    createElementNS: (_ns: string, tag: string) => node(tag),
  };
  function node(tag: string): Node {
    const n: Node = {
      tagName: tag.toUpperCase(),
      children: [],
      attributes: {},
      listeners: {},
      className: "",
      textContent: "",
      hidden: false,
      isConnected: true,
      appendChild(child: Node) { this.children.push(child); return child; },
      replaceChildren(...list: Node[]) { this.children = list; },
      setAttribute(name: string, value: string) { this.attributes[name] = String(value); },
      getAttribute(name: string) { return this.attributes[name]; },
      removeAttribute(name: string) { delete this.attributes[name]; },
      addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
      dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
      focus() { document.activeElement = this; },
    };
    return n;
  }
  document.body = node("body");

  const navigator: Record<string, any> = { userAgent: options.userAgent ?? IPHONE, maxTouchPoints: 5 };
  if (options.standalone !== undefined) navigator.standalone = options.standalone;
  if (options.share !== false) {
    navigator.canShare = (data: { files?: File[] }) => options.share !== "refuses" && Array.isArray(data.files) && data.files.length === 1;
    navigator.share = async (data: { files: File[] }) => {
      state.shares.push(data);
      const error = state.shareErrors.shift();
      if (error) throw new DOMException("nein", error);
    };
  }
  const window = {
    navigator,
    matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" && !!options.displayMode }),
  };
  const fetch = async (path: string, init?: any) => {
    state.fetches.push({ path, init });
    if (state.gate) await state.gate;
    const reply = state.replies.shift();
    if (reply === "offline") throw new TypeError("Load failed");
    // Wie der Server: immer als Anhang mit neutralem Typ
    return reply ?? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), { headers: { "Content-Type": "application/octet-stream" } });
  };
  const app = new Function(
    "document",
    "window",
    "fetch",
    `${callSource}\n${appSource}\nreturn { messageElement, attachmentCard, FILE_SAVE_TEXT };`
  )(document, window, fetch) as {
    messageElement(m: object, agent?: string): Node;
    attachmentCard(a: object): Node | null;
    FILE_SAVE_TEXT: Record<string, string>;
  };
  return { app, state, document };
}

function all(n: Node): Node[] {
  return [n, ...n.children.flatMap(all)];
}
const find = (n: Node, cls: string) => all(n).find(x => String(x.className).split(" ").includes(cls));
/** Wartet, bis angestoßene Promises durch sind */
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** Dateikarte einer Meldung samt ihren Teilen */
function card(ctx: ReturnType<typeof setup>, file: object) {
  const message = ctx.app.messageElement({ ...NOTICE, file });
  const wrap = find(message, "file")!;
  return { wrap, download: find(wrap, "file-download")!, note: find(wrap, "file-note"), open: find(wrap, "file-open"), zoom: find(wrap, "file-zoom") };
}

describe("nicht in der installierten App auf dem iPhone: Links wie bisher", () => {
  const cases: [string, Options][] = [
    ["Safari auf dem iPhone", { userAgent: IPHONE, standalone: false }],
    ["Browser am Rechner", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0.0.0 Safari/537.36" }],
    ["installierte App unter Android", { userAgent: ANDROID, displayMode: true }],
  ];
  for (const [name, options] of cases) {
    test(name, () => {
      const ctx = setup(options);
      const image = card(ctx, IMAGE);
      expect(image.download.tagName).toBe("A");
      expect(image.download.attributes.href).toBe(`/api/files/${FILE_ID}`);
      expect(image.download.attributes.download).toBe(IMAGE.name);
      expect(image.download.textContent).toBe("Herunterladen");
      expect(image.download.listeners.click).toBeUndefined();
      expect(image.note).toBeUndefined();
      const report = card(ctx, REPORT);
      expect(report.open!.tagName).toBe("A");
      expect(report.open!.attributes.href).toBe(`/api/files/${FILE_ID}?inline=1`);
      expect(report.open!.attributes.target).toBe("_blank");
      expect(report.open!.attributes.rel).toBe("noopener");
      expect(report.download.attributes.href).toBe(`/api/files/${FILE_ID}`);
      expect(ctx.state.fetches).toEqual([]);
    });
  }
});

describe("installierte App auf dem iPhone: Herunterladen sichert über den Teilen-Dialog", () => {
  const ios: Options = { userAgent: IPHONE, standalone: true };

  test("kein Link mehr an der Karte: weder Herunterladen noch Öffnen verlassen die Ansicht", () => {
    const ctx = setup(ios);
    for (const file of [IMAGE, REPORT, { ...IMAGE, name: "a.mp3", mime: "audio/mpeg" }, { ...IMAGE, name: "b.pdf", mime: "application/pdf" }]) {
      const { wrap, download } = card(ctx, file);
      expect(download.tagName).toBe("BUTTON");
      expect(download.attributes.type).toBe("button");
      for (const n of all(wrap)) {
        expect(n.tagName).not.toBe("A");
        expect(n.attributes.href).toBeUndefined();
        expect(n.attributes.download).toBeUndefined();
      }
    }
  });

  test("auch iPad mit Rechner-Kennung und display-mode statt navigator.standalone", () => {
    const ctx = setup({ userAgent: "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X)", displayMode: true });
    expect(card(ctx, IMAGE).download.tagName).toBe("BUTTON");
  });

  test("lädt die Datei und gibt sie mit Name und Typ an den Dialog, ohne Seitenwechsel", async () => {
    const ctx = setup(ios);
    const { download, note } = card(ctx, IMAGE);
    expect(download.textContent).toBe("Herunterladen");
    expect(download.attributes["aria-label"]).toBe(IMAGE.name + " herunterladen");
    expect(note!.hidden).toBe(true);
    expect(note!.attributes.role).toBe("status");
    download.dispatch("click");
    await settle();
    expect(ctx.state.fetches).toEqual([{ path: `/api/files/${FILE_ID}`, init: { credentials: "same-origin" } }]);
    expect(ctx.state.shares.length).toBe(1);
    const [shared] = ctx.state.shares[0].files;
    expect(shared).toBeInstanceOf(File);
    expect(shared.name).toBe(IMAGE.name);
    // Der festgehaltene Typ, nicht application/octet-stream aus dem Download
    expect(shared.type).toBe("image/png");
    expect(shared.size).toBe(7);
    expect(download.textContent).toBe("Herunterladen");
    expect(download.attributes["aria-busy"]).toBeUndefined();
    expect(note!.hidden).toBe(true);
  });

  test("beim Laden sichtbar beschäftigt, ein zweiter Tipp löst nichts aus", async () => {
    const ctx = setup(ios);
    let open!: () => void;
    ctx.state.gate = new Promise<void>(r => { open = r; });
    const { download } = card(ctx, IMAGE);
    download.dispatch("click");
    await settle();
    expect(download.textContent).toBe("Lädt …");
    expect(download.attributes["aria-busy"]).toBe("true");
    expect(download.attributes["aria-disabled"]).toBe("true");
    expect(download.attributes["aria-label"]).toBe(IMAGE.name + " wird geladen");
    download.dispatch("click");
    download.dispatch("click");
    await settle();
    expect(ctx.state.fetches.length).toBe(1);
    open();
    await settle();
    expect(ctx.state.shares.length).toBe(1);
    expect(download.textContent).toBe("Herunterladen");
    expect(download.attributes["aria-busy"]).toBeUndefined();
    expect(download.attributes["aria-disabled"]).toBeUndefined();
  });

  test("Geste beim Laden verfallen: Datei bleibt geladen, der zweite Tipp öffnet den Dialog", async () => {
    const ctx = setup(ios);
    ctx.state.shareErrors.push("NotAllowedError");
    const { download, note } = card(ctx, IMAGE);
    download.dispatch("click");
    await settle();
    expect(download.textContent).toBe("Sichern oder teilen");
    expect(download.attributes["aria-label"]).toBe(IMAGE.name + " sichern oder teilen");
    expect(note!.hidden).toBe(false);
    expect(note!.textContent).toBe(ctx.app.FILE_SAVE_TEXT.readyNote);
    expect(note!.className).toBe("file-note");
    download.dispatch("click");
    await settle();
    // Nicht noch einmal geladen, dieselbe Datei
    expect(ctx.state.fetches.length).toBe(1);
    expect(ctx.state.shares.length).toBe(2);
    expect(ctx.state.shares[1].files[0]).toBe(ctx.state.shares[0].files[0]);
    expect(download.textContent).toBe("Herunterladen");
    expect(note!.hidden).toBe(true);
  });

  test("lehnt der Dialog auch den direkten Tipp ab, steht ein Fehler da statt einer Schleife", async () => {
    const ctx = setup(ios);
    ctx.state.shareErrors.push("NotAllowedError", "NotAllowedError");
    const { download, note } = card(ctx, IMAGE);
    download.dispatch("click");
    await settle();
    download.dispatch("click");
    await settle();
    expect(download.textContent).toBe("Herunterladen");
    expect(note!.textContent).toBe(ctx.app.FILE_SAVE_TEXT.shareFailed);
    expect(note!.className).toBe("file-note file-note-error");
  });

  test("Abbruch im Dialog: keine Meldung, der nächste Tipp öffnet ihn wieder", async () => {
    const ctx = setup(ios);
    ctx.state.shareErrors.push("AbortError");
    const { download, note } = card(ctx, IMAGE);
    download.dispatch("click");
    await settle();
    expect(note!.hidden).toBe(true);
    expect(note!.textContent).toBe("");
    expect(download.textContent).toBe("Herunterladen");
    download.dispatch("click");
    await settle();
    expect(ctx.state.fetches.length).toBe(1);
    expect(ctx.state.shares.length).toBe(2);
  });

  test("Ladefehler: kurze Meldung an der Karte, nichts geteilt, der Knopf bleibt bedienbar", async () => {
    const cases: [FetchReply, string][] = [
      ["offline", "offline"],
      [Response.json({ error: "Nicht angemeldet" }, { status: 401 }), "session"],
      [Response.json({ error: "Datei nicht gefunden" }, { status: 404 }), "missing"],
      [Response.json({ error: "Datei gerade nicht abrufbar" }, { status: 503 }), "failed"],
    ];
    for (const [reply, key] of cases) {
      const ctx = setup(ios);
      ctx.state.replies.push(reply);
      const { download, note } = card(ctx, IMAGE);
      download.dispatch("click");
      await settle();
      expect(note!.hidden).toBe(false);
      expect(note!.textContent).toBe(ctx.app.FILE_SAVE_TEXT[key]);
      expect(note!.className).toBe("file-note file-note-error");
      expect(ctx.state.shares).toEqual([]);
      expect(download.textContent).toBe("Herunterladen");
      expect(download.attributes["aria-busy"]).toBeUndefined();
      // Noch einmal: jetzt klappt es, die Meldung ist weg
      download.dispatch("click");
      await settle();
      expect(ctx.state.fetches.length).toBe(2);
      expect(ctx.state.shares.length).toBe(1);
      expect(note!.hidden).toBe(true);
    }
  });

  test("ohne Teilen für Dateien: ehrlicher Hinweis, kein Abruf, kein Link", async () => {
    for (const share of [false, "refuses"] as const) {
      const ctx = setup({ ...ios, share });
      const { download, note } = card(ctx, { ...IMAGE, name: "archiv.zip", mime: "application/zip" });
      expect(download.tagName).toBe("BUTTON");
      download.dispatch("click");
      await settle();
      expect(note!.textContent).toBe(ctx.app.FILE_SAVE_TEXT.noShare);
      expect(note!.textContent).toContain("Safari");
      expect(ctx.state.fetches).toEqual([]);
    }
  });

  test("Typ ohne Form eines MIME-Typs wird neutral geteilt", async () => {
    const ctx = setup(ios);
    const { download } = card(ctx, { ...IMAGE, name: "daten.bin", mime: "<script>" });
    download.dispatch("click");
    await settle();
    expect(ctx.state.shares[0].files[0].type).toBe("application/octet-stream");
  });

  test("Anhang im Web-Chat: dieselbe Karte, Abruf über die Route des Gesprächs", async () => {
    const ctx = setup(ios);
    const url = `/api/conversations/${WEB}/attachments/${ATTACHMENT_ID}`;
    const wrap = ctx.app.attachmentCard({ id: ATTACHMENT_ID, name: "vertrag.pdf", size: 10, mime: "application/pdf", kind: "document", url })!;
    const download = find(wrap, "file-download")!;
    expect(download.tagName).toBe("BUTTON");
    expect(all(wrap).some(n => n.tagName === "A")).toBe(false);
    download.dispatch("click");
    await settle();
    expect(ctx.state.fetches.map(f => f.path)).toEqual([url]);
    expect(ctx.state.shares[0].files[0].name).toBe("vertrag.pdf");
    expect(ctx.state.shares[0].files[0].type).toBe("application/pdf");
  });
});

describe("Betrachter", () => {
  /** Öffnet den Betrachter über die Vorschau und gibt seine Teile zurück */
  function viewer(ctx: ReturnType<typeof setup>) {
    const dialog = ctx.state.dialogs[0];
    return { dialog, title: find(dialog, "viewer-title")!, close: find(dialog, "viewer-close")!, stage: find(dialog, "viewer-stage")! };
  }

  test("Vorschau ist ein Knopf mit Beschriftung, in jedem Browser", () => {
    for (const options of [{ userAgent: IPHONE, standalone: true }, { userAgent: ANDROID }]) {
      const ctx = setup(options);
      const { wrap, zoom } = card(ctx, IMAGE);
      expect(zoom!.tagName).toBe("BUTTON");
      expect(zoom!.attributes.type).toBe("button");
      expect(zoom!.attributes["aria-label"]).toBe(IMAGE.name + " groß ansehen");
      expect(wrap.children[0]).toBe(zoom!);
      const img = find(zoom!, "file-preview")!;
      expect(img.tagName).toBe("IMG");
      expect(img.attributes.src).toBe(`/api/files/${FILE_ID}?inline=1`);
      // Erst beim Antippen entsteht ein Dialog
      expect(ctx.state.dialogs).toEqual([]);
    }
  });

  test("Tipp auf die Vorschau zeigt das Bild als Dialog, Schließen bringt den Fokus zurück", () => {
    const ctx = setup({ userAgent: ANDROID });
    const { zoom } = card(ctx, IMAGE);
    zoom!.dispatch("click");
    const { dialog, title, close, stage } = viewer(ctx);
    expect(ctx.document.body.children).toEqual([dialog]);
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.open).toBe(true);
    expect(dialog.attributes["aria-label"]).toBe(IMAGE.name);
    expect(title.textContent).toBe(IMAGE.name);
    expect(close.tagName).toBe("BUTTON");
    expect(close.attributes["aria-label"]).toBe("Schließen");
    // Schließen steht vor dem Inhalt und bekommt so den Fokus des Dialogs
    expect(all(dialog).indexOf(close)).toBeLessThan(all(dialog).indexOf(stage));
    const [img] = stage.children;
    expect(img.tagName).toBe("IMG");
    expect(img.className).toBe("viewer-image");
    // Adresse der Seite, kein blob: (die CSP erlaubt für Bilder nur 'self' und data:)
    expect(img.attributes.src).toBe(`/api/files/${FILE_ID}?inline=1`);
    expect(img.attributes.alt).toBe(IMAGE.name);
    close.dispatch("click");
    expect(dialog.open).toBe(false);
    expect(stage.children).toEqual([]);
    expect(ctx.document.activeElement).toBe(zoom!);
  });

  test("Tipp neben das Bild schließt, Tipp auf das Bild nicht; Escape schließt über das close-Ereignis", () => {
    const ctx = setup({ userAgent: ANDROID });
    const { zoom } = card(ctx, IMAGE);
    zoom!.dispatch("click");
    const { dialog, stage } = viewer(ctx);
    dialog.dispatch("click", { target: stage.children[0] });
    expect(dialog.open).toBe(true);
    dialog.dispatch("click", { target: stage });
    expect(dialog.open).toBe(false);
    zoom!.dispatch("click");
    dialog.dispatch("click", { target: dialog });
    expect(dialog.open).toBe(false);
    // Escape: Der Browser schließt das <dialog> selbst und meldet close
    zoom!.dispatch("click");
    ctx.document.activeElement = null;
    dialog.close();
    expect(stage.children).toEqual([]);
    expect(ctx.document.activeElement).toBe(zoom!);
    // Ein Dialog für die ganze Seite
    expect(ctx.state.dialogs.length).toBe(1);
  });

  test("verspätetes close nach Escape leert einen schon wieder geöffneten Betrachter nicht", () => {
    const ctx = setup({ userAgent: ANDROID });
    const { zoom } = card(ctx, IMAGE);
    zoom!.dispatch("click");
    const { dialog, stage } = viewer(ctx);
    // Wie der Browser nach Escape: erst zu, das Ereignis folgt in einer eigenen Aufgabe
    dialog.open = false;
    zoom!.dispatch("click");
    expect(dialog.open).toBe(true);
    dialog.dispatch("close");
    expect(stage.children.length).toBe(1);
    expect(stage.children[0].className).toBe("viewer-image");
  });

  test("feindlicher Dateiname steht nur als Text und Attribut im Betrachter", () => {
    const ctx = setup({ userAgent: ANDROID });
    const evil = '"><img src=x onerror=alert(1)>.png';
    const { zoom } = card(ctx, { ...IMAGE, name: evil });
    zoom!.dispatch("click");
    const { dialog, title } = viewer(ctx);
    expect(title.textContent).toBe(evil);
    for (const n of all(dialog)) expect(n.innerHTML).toBeUndefined();
  });

  test("Vorschau eines Anhangs öffnet die Adresse des Gesprächs", () => {
    const ctx = setup({ userAgent: ANDROID });
    const url = `/api/conversations/${WEB}/attachments/${ATTACHMENT_ID}`;
    const wrap = ctx.app.attachmentCard({ id: ATTACHMENT_ID, name: "bild.png", size: 10, mime: "image/png", kind: "image", url, previewUrl: url + "?inline=1" })!;
    find(wrap, "file-zoom")!.dispatch("click");
    expect(viewer(ctx).stage.children[0].attributes.src).toBe(url + "?inline=1");
  });

  test("HTML in der installierten App auf dem iPhone: Öffnen zeigt die Datei im Betrachter", () => {
    const ctx = setup({ userAgent: IPHONE, standalone: true });
    const { open } = card(ctx, REPORT);
    expect(open!.tagName).toBe("BUTTON");
    expect(open!.textContent).toBe("Öffnen");
    expect(open!.attributes["aria-label"]).toBe(REPORT.name + " öffnen");
    open!.dispatch("click");
    const { dialog, title, close, stage } = viewer(ctx);
    expect(dialog.open).toBe(true);
    expect(title.textContent).toBe(REPORT.name);
    const [frame] = stage.children;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.className).toBe("viewer-page");
    expect(frame.attributes.src).toBe(`/api/files/${FILE_ID}?inline=1`);
    expect(frame.attributes.title).toBe(REPORT.name);
    // Sandbox ohne Ursprung, ohne Wechsel der äußeren Seite und ohne Downloads
    const sandbox = frame.attributes.sandbox.split(" ");
    expect(sandbox).toEqual(["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"]);
    close.dispatch("click");
    expect(stage.children).toEqual([]);
    expect(ctx.document.activeElement).toBe(open!);
  });

  test("ohne showModal (alter Browser) passiert nichts, statt die Seite zu sperren", () => {
    const ctx = setup({ userAgent: ANDROID });
    const { zoom } = card(ctx, IMAGE);
    const create = ctx.document.createElement;
    ctx.document.createElement = (tag: string) => {
      const n = create(tag);
      if (tag === "dialog") delete n.showModal;
      return n;
    };
    zoom!.dispatch("click");
    expect(ctx.state.dialogs[0].open).toBe(false);
  });
});

describe("style.css", () => {
  function rule(selector: string): string {
    const i = css.indexOf(`${selector} {`);
    expect(i).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf("}", i));
  }

  test("Schließen mit 44 px Tippfläche, Betrachter achtet auf die sicheren Ränder", () => {
    const close = rule(".viewer-close");
    expect(close).toContain("width: 2.75rem");
    expect(close).toContain("height: 2.75rem");
    const viewer = rule(".viewer");
    for (const side of ["top", "right", "bottom", "left"]) expect(viewer).toContain(`env(safe-area-inset-${side})`);
    expect(viewer).not.toContain("shadow");
  });

  test("ein geschlossener Betrachter bleibt unsichtbar: display nur am geöffneten Dialog", () => {
    expect(rule(".viewer")).not.toContain("display");
    expect(rule(".viewer[open]")).toContain("display: flex");
  });

  test("Bild passt sich ein, HTML-Datei auf weißem Blatt", () => {
    const image = rule(".viewer-image");
    expect(image).toContain("max-width: 100%");
    expect(image).toContain("max-height: 100%");
    expect(rule(".viewer-page")).toContain("color-scheme: light");
  });
});
