// Anzeige von Meldungen und Dateien (Issue #47, Schritt 4): ohne Browser,
// DOM als Attrappe; app.js wird als klassisches Skript ausgewertet wie in
// web-app-reply-footer.test.ts. Absender, Dateiname und Größe kommen nur über
// textContent in die Seite, innerHTML nur für das Server-HTML der Meldung.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const source = await readFile(resolve(publicDir, "app.js"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");

interface FakeNode {
  tagName: string;
  children: FakeNode[];
  attributes: Record<string, string>;
  textContent: string;
  innerHTMLWrites: string[];
  className: string;
  [key: string]: any;
}

function fakeNode(tagName: string): FakeNode {
  const n: FakeNode = {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: {},
    textContent: "",
    innerHTMLWrites: [],
    className: "",
    appendChild(child: FakeNode) {
      this.children.push(child);
      return child;
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = String(value);
    },
    getAttribute(name: string) {
      return this.attributes[name];
    },
    addEventListener() {},
  };
  Object.defineProperty(n, "innerHTML", {
    set(v: string) {
      n.innerHTMLWrites.push(v);
    },
  });
  return n;
}

function load() {
  const document = {
    getElementById: () => null,
    createElement: (tag: string) => fakeNode(tag),
    createElementNS: (_ns: string, tag: string) => fakeNode(tag),
  };
  return new Function(
    "document",
    "window",
    `${source}\nreturn { messageElement, noticeSourceLabel, formatFileSize, clockTime };`
  )(document, { navigator: {} }) as {
    messageElement(m: object, agent?: string): FakeNode;
    noticeSourceLabel(s: unknown): string;
    formatFileSize(n: unknown): string;
    clockTime(v: unknown): string;
  };
}

const app = load();

function all(node: FakeNode): FakeNode[] {
  return [node, ...node.children.flatMap(all)];
}
const byClass = (node: FakeNode, cls: string) => all(node).find(n => String(n.className).split(" ").includes(cls));

const FILE_ID = "3f2b8c1e-7d4a-4b6e-9c21-5a0d8e7f6b13";
const NOTICE = {
  id: "n1",
  role: "assistant",
  kind: "notice",
  source: "pipeline",
  text: "**Issue #47** fertig",
  html: "<p><strong>Issue #47</strong> fertig</p>",
  createdAt: "2026-09-24T08:05:00.000Z",
};

describe("Meldung", () => {
  test("ohne Blase und ohne Agentenkopf, oben Absender und Uhrzeit, Text als Server-HTML", () => {
    const node = app.messageElement(NOTICE, "general");
    expect(node.tagName).toBe("ARTICLE");
    expect(node.className).toBe("msg msg-notice");
    expect(node.attributes["data-id"]).toBe("n1");
    // Keine Blase, kein Kopf mit Agentenpunkt, keine Fußzeile mit Kopieren
    for (const cls of ["bubble", "msg-head", "msg-foot", "agent-dot"]) expect(byClass(node, cls)).toBeUndefined();
    const head = byClass(node, "notice-head")!;
    expect(node.children[0]).toBe(head);
    expect(byClass(head, "notice-source")!.textContent).toBe("Pipeline");
    const time = byClass(head, "notice-time")!;
    expect(time.textContent).toBe(app.clockTime(NOTICE.createdAt));
    expect(time.textContent).toMatch(/^\d{2}:\d{2}$/);
    const body = byClass(node, "notice-body")!;
    expect(body.className).toContain("content");
    expect(body.innerHTMLWrites).toEqual([NOTICE.html]);
    for (const n of all(head)) expect(n.innerHTMLWrites).toEqual([]);
  });

  test("Absender: bekannte deutsch, unbekannte roh, ohne Angabe „Meldung“", () => {
    expect(["pipeline", "briefing", "checkin", "watchdog", "watcher", "datei"].map(app.noticeSourceLabel)).toEqual([
      "Pipeline",
      "Briefing",
      "Check-in",
      "Watchdog",
      "Watcher",
      "Datei",
    ]);
    expect(app.noticeSourceLabel("neuer-dienst")).toBe("neuer-dienst");
    expect(app.noticeSourceLabel(undefined)).toBe("Meldung");
    expect(app.noticeSourceLabel("constructor")).toBe("constructor");
  });

  test("feindlicher Absender landet nur als Text im DOM", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const node = app.messageElement({ ...NOTICE, source: evil });
    const label = byClass(node, "notice-source")!;
    expect(label.textContent).toBe(evil);
    expect(label.innerHTMLWrites).toEqual([]);
  });

  test("ohne HTML vom Server: Text nur als textContent", () => {
    const node = app.messageElement({ ...NOTICE, html: undefined, text: "<b>roh</b>" });
    const body = byClass(node, "notice-body")!;
    expect(body.textContent).toBe("<b>roh</b>");
    expect(body.innerHTMLWrites).toEqual([]);
  });
});

describe("Dateikarte", () => {
  const file = { id: FILE_ID, name: "Bericht März.html", size: 2048, mime: "text/html" };

  test("Name, Größe und Herunterladen; HTML ohne Vorschau", () => {
    const node = app.messageElement({ ...NOTICE, source: "datei", text: "Bericht März.html", html: "<p>Bericht März.html</p>", file });
    // Text gleich Dateiname: kein doppelter Absatz
    expect(byClass(node, "notice-body")).toBeUndefined();
    const card = byClass(node, "file-card")!;
    expect(byClass(card, "file-name")!.textContent).toBe("Bericht März.html");
    expect(byClass(card, "file-size")!.textContent).toBe("2 KB");
    const link = byClass(card, "file-download")!;
    expect(link.tagName).toBe("A");
    expect(link.textContent).toBe("Herunterladen");
    expect(link.attributes.href).toBe(`/api/files/${FILE_ID}`);
    expect(link.attributes.download).toBe("Bericht März.html");
    expect(byClass(node, "file-preview")).toBeUndefined();
    for (const n of all(card)) expect(n.innerHTMLWrites).toEqual([]);
  });

  test("Beschriftung steht über der Karte", () => {
    const node = app.messageElement({ ...NOTICE, text: "Neuer Report", html: "<p>Neuer Report</p>", file });
    expect(byClass(node, "notice-body")!.innerHTMLWrites).toEqual(["<p>Neuer Report</p>"]);
    expect(node.children.map(c => c.className)).toEqual(["notice-head", "notice-body content", "file"]);
  });

  test("feindlicher Dateiname nur als Text", () => {
    const evil = "<script>alert(1)</script>.txt";
    const node = app.messageElement({ ...NOTICE, file: { ...file, name: evil, mime: "text/plain" } });
    expect(byClass(node, "file-name")!.textContent).toBe(evil);
    for (const n of all(byClass(node, "file")!)) expect(n.innerHTMLWrites).toEqual([]);
  });

  test("Vorschau nur für PNG, JPEG, WebP und GIF mit passendem Typ", () => {
    const cases: [string, string, boolean][] = [
      ["a.png", "image/png", true],
      ["b.JPG", "image/jpeg", true],
      ["c.jpeg", "image/jpeg", true],
      ["d.webp", "image/webp", true],
      ["e.gif", "image/gif", true],
      ["f.svg", "image/svg+xml", false],
      ["g.html", "text/html", false],
      ["h.pdf", "application/pdf", false],
      ["i.png", "text/html", false],
    ];
    for (const [name, mime, preview] of cases) {
      const node = app.messageElement({ ...NOTICE, file: { ...file, name, mime } });
      const img = byClass(node, "file-preview");
      if (preview) {
        expect(img!.tagName).toBe("IMG");
        expect(img!.attributes.src).toBe(`/api/files/${FILE_ID}?inline=1`);
        expect(img!.attributes.alt).toBe(name);
      } else {
        expect(img).toBeUndefined();
      }
    }
  });

  test("ungültige Datei-ID: keine Karte, kein Link", () => {
    const node = app.messageElement({ ...NOTICE, file: { ...file, id: "../../etc/passwd" } });
    expect(byClass(node, "file")).toBeUndefined();
    expect(all(node).some(n => n.tagName === "A")).toBe(false);
  });

  test("Größen auf Deutsch", () => {
    expect(app.formatFileSize(1)).toBe("1 Byte");
    expect(app.formatFileSize(850)).toBe("850 Bytes");
    expect(app.formatFileSize(12_595)).toBe("12,3 KB");
    expect(app.formatFileSize(4.2 * 1024 * 1024)).toBe("4,2 MB");
    expect(app.formatFileSize(150 * 1024)).toBe("150 KB");
    expect(app.formatFileSize(-1)).toBe("");
  });
});

describe("übrige Nachrichten unverändert", () => {
  test("Nutzertext nie per innerHTML, auch mit html-Feld", () => {
    const node = app.messageElement({ id: "u", role: "user", text: "<img src=x>", html: "<img src=x>", createdAt: NOTICE.createdAt });
    for (const n of all(node)) expect(n.innerHTMLWrites).toEqual([]);
    expect(node.className).toBe("msg msg-user");
  });

  test("kind ohne notice ergibt eine gewöhnliche Antwort mit Kopf", () => {
    const node = app.messageElement({ ...NOTICE, kind: "anders" }, "general");
    expect(node.className).toBe("msg msg-assistant");
    expect(byClass(node, "msg-head")).toBeDefined();
  });
});

describe("style.css", () => {
  function rule(selector: string): string {
    const i = css.indexOf(`${selector} {`);
    expect(i).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf("}", i));
  }

  test("Meldung ohne Fläche, Text in muted an einer Haarlinie", () => {
    expect(rule(".notice-body")).toContain("color: var(--muted)");
    expect(rule(".notice-body")).toContain("border-left: 1px solid var(--line)");
    expect(rule(".notice-body")).not.toContain("background");
    expect(rule(".msg-notice")).not.toContain("background");
  });

  test("Karte mit Linie statt Schatten, nur vorhandene Farb-Variablen", () => {
    const card = rule(".file-card");
    expect(card).toContain("border: 1px solid var(--line)");
    expect(card).not.toContain("shadow");
    const block = css.slice(css.indexOf(".msg-notice {"), css.indexOf(".msg-error .bubble {"));
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    expect(block).not.toMatch(/animation|transition/);
  });

  test("Herunterladen am Handy mit 44 px Tippfläche", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 55.99rem)"));
    expect(mobile).toContain(".file-download { min-height: 2.75rem; }");
  });
});
