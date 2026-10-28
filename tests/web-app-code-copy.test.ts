// Kopieren-Knopf an Codeblöcken in Antworten und Meldungen. Ohne Browser:
// DOM, Zwischenablage und Timer sind Attrappen; app.js wird als klassisches
// Skript ausgewertet wie in web-app-reply-footer.test.ts.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const source = await readFile(resolve(publicDir, "app.js"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");

interface FakeNode {
  tagName: string;
  children: FakeNode[];
  parentNode: FakeNode | null;
  attributes: Record<string, string>;
  textContent: string;
  listeners: Record<string, ((e?: unknown) => unknown)[]>;
  [key: string]: any;
}

function fakeNode(tagName: string): FakeNode {
  const n: FakeNode = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    textContent: "",
    listeners: {},
    className: "",
    appendChild(child: FakeNode) {
      if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child: FakeNode, ref: FakeNode) {
      child.parentNode = this;
      this.children.splice(this.children.indexOf(ref), 0, child);
      return child;
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = String(value);
    },
    getAttribute(name: string) {
      return this.attributes[name];
    },
    removeAttribute(name: string) {
      delete this.attributes[name];
    },
    addEventListener(type: string, fn: (e?: unknown) => unknown) {
      (this.listeners[type] ??= []).push(fn);
    },
    focus() {},
  };
  return n;
}

/** Inhalt einer Antwort: innerHTML legt die angegebenen <pre> als Kinder an */
function contentRoot(blocks: string[]) {
  const root = fakeNode("div");
  Object.defineProperty(root, "innerHTML", {
    set() {
      for (const text of blocks) {
        const pre = fakeNode("pre");
        pre.textContent = text;
        root.appendChild(pre);
      }
    },
  });
  root.querySelectorAll = (selector: string) => {
    const found: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.children) {
        if (c.tagName === selector.toUpperCase()) found.push(c);
        walk(c);
      }
    };
    walk(root);
    return found;
  };
  return root;
}

function load(writeText: (text: string) => Promise<void>) {
  const document = {
    getElementById: () => null,
    body: fakeNode("body"),
    createElement: (tag: string) => fakeNode(tag),
    createElementNS: (_ns: string, tag: string) => fakeNode(tag),
  };
  const window = { TYBO_BRAND, navigator: { clipboard: { writeText } } };
  const timers = new Map<number, () => void>();
  let next = 1;
  const setTimeout = (fn: () => void) => {
    const id = next++;
    timers.set(id, fn);
    return id;
  };
  const clearTimeout = (id: number) => void timers.delete(id);
  const app = new Function(
    "document",
    "window",
    "setTimeout",
    "clearTimeout",
    `${source}\nreturn { setServerHtml };`
  )(document, window, setTimeout, clearTimeout) as { setServerHtml(body: FakeNode, m: object): void };
  const runTimers = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  return { app, runTimers };
}

async function click(button: FakeNode) {
  await Promise.all(button.listeners.click!.map(fn => fn()));
}

describe("Kopieren an Codeblöcken", () => {
  test("jeder Codeblock steht in einem Rahmen mit eigenem Knopf", () => {
    const { app } = load(async () => {});
    const root = contentRoot(["echo eins", "echo zwei"]);
    app.setServerHtml(root, { html: "<pre>…</pre>" });
    expect(root.children.map(c => c.className)).toEqual(["code-block", "code-block"]);
    for (const frame of root.children) {
      expect(frame.children.map(c => c.tagName)).toEqual(["PRE", "BUTTON"]);
      const button = frame.children[1]!;
      expect(button.className).toBe("code-copy");
      expect(button.attributes["aria-label"]).toBe("Code kopieren");
    }
  });

  test("kopiert genau den Text des Blocks und meldet „Kopiert“", async () => {
    const copied: string[] = [];
    const { app, runTimers } = load(async text => void copied.push(text));
    const code = "cd ~/tybo && \\\n  sed -i '' 's|a|b|' datei.json";
    const root = contentRoot([code]);
    app.setServerHtml(root, { html: "<pre>…</pre>" });
    const button = root.children[0]!.children[1]!;
    await click(button);
    expect(copied).toEqual([code]);
    const status = button.children.find(c => c.className === "code-copy-status")!;
    expect(status.textContent).toBe("Kopiert");
    expect(button.attributes["data-copy"]).toBe("ok");
    runTimers();
    expect(status.textContent).toBe("");
    expect(button.attributes["data-copy"]).toBeUndefined();
  });

  test("ohne Zwischenablage eine Fehlermeldung statt „Kopiert“", async () => {
    const { app } = load(async () => {
      throw new Error("abgelehnt");
    });
    const root = contentRoot(["ls"]);
    app.setServerHtml(root, { html: "<pre>…</pre>" });
    const button = root.children[0]!.children[1]!;
    await click(button);
    expect(button.children.find(c => c.className === "code-copy-status")!.textContent).toBe("Kopieren nicht möglich");
    expect(button.attributes["data-copy"]).toBe("failed");
  });

  test("ohne Codeblock und ohne html bleibt der Inhalt unverändert", () => {
    const { app } = load(async () => {});
    const root = contentRoot([]);
    app.setServerHtml(root, { html: "<p>Text</p>" });
    expect(root.children).toEqual([]);
    const plain = contentRoot(["nicht gerendert"]);
    app.setServerHtml(plain, { text: "nur Text" });
    expect(plain.textContent).toBe("nur Text");
    expect(plain.children).toEqual([]);
  });

  test("CSS: Knopf oben rechts, immer sichtbar, scrollt nicht mit dem Block", () => {
    expect(css).toMatch(/\.content \.code-block \{[^}]*position: relative/);
    expect(css).toMatch(/\.code-copy \{[^}]*position: absolute/);
    expect(css).not.toMatch(/\.code-copy \{[^}]*(opacity: 0|display: none)/);
  });
});
