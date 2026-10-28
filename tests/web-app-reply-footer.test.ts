// Fußzeile unter Antworten (Issue #22): Agent, Modell, Dauer und Kopieren.
// Ohne Browser: DOM, Zwischenablage und Timer sind Attrappen; app.js wird
// als klassisches Skript ausgewertet wie in web-public.test.ts.
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
  attributes: Record<string, string>;
  textContent: string;
  innerHTMLWrites: string[];
  listeners: Record<string, ((e?: unknown) => unknown)[]>;
  [key: string]: any;
}

function fakeNode(tagName: string): FakeNode {
  const n: FakeNode = {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: {},
    textContent: "",
    innerHTMLWrites: [],
    listeners: {},
    className: "",
    value: "",
    focused: 0,
    removed: false,
    selected: false,
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
    removeAttribute(name: string) {
      delete this.attributes[name];
    },
    addEventListener(type: string, fn: (e?: unknown) => unknown) {
      (this.listeners[type] ??= []).push(fn);
    },
    focus() {
      this.focused++;
    },
    select() {
      this.selected = true;
    },
    setSelectionRange() {},
    remove() {
      this.removed = true;
    },
  };
  Object.defineProperty(n, "innerHTML", {
    set(v: string) {
      n.innerHTMLWrites.push(v);
    },
  });
  return n;
}

interface Env {
  /** undefined: keine Clipboard-API (HTTP an der LAN-IP) */
  clipboard?: { writeText(text: string): Promise<void> };
  /** Ergebnis von document.execCommand("copy"); undefined: gibt es nicht */
  execCommand?: (command: string) => boolean;
}

function load(env: Env = {}) {
  const body = fakeNode("body");
  const created: FakeNode[] = [];
  const execCalls: { command: string; value: string; selected: boolean }[] = [];
  const document: Record<string, any> = {
    getElementById: () => null,
    body,
    createElement: (tag: string) => {
      const n = fakeNode(tag);
      created.push(n);
      return n;
    },
    createElementNS: (_ns: string, tag: string) => fakeNode(tag),
  };
  if (env.execCommand) {
    document.execCommand = (command: string) => {
      const area = body.children.at(-1)!;
      execCalls.push({ command, value: area.value, selected: area.selected });
      return env.execCommand!(command);
    };
  }
  const window = { TYBO_BRAND, navigator: env.clipboard ? { clipboard: env.clipboard } : {} };
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
    `${source}\nreturn { messageElement, formatDuration, replyMetaText };`
  )(document, window, setTimeout, clearTimeout) as {
    messageElement(m: object, agent?: string): FakeNode;
    formatDuration(ms: unknown): string | null;
    replyMetaText(m: object): string;
  };
  const runTimers = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  return { app, body, created, execCalls, timers, runTimers };
}

const REPLY = {
  id: "a1",
  role: "assistant",
  text: "**Plan** steht.\n[REMEMBER: geheim]",
  html: "<p><strong>Plan</strong> steht.</p>",
  copyText: "**Plan** steht.",
  createdAt: "2026-09-23T10:00:00.000Z",
  agent: "general",
  model: "claude-opus-5-5",
  durationMs: 42_000,
};

/** Kinder der Fußzeile: Knopf, Metazeile, Status (fehlende fallen weg) */
function footer(node: FakeNode): FakeNode | undefined {
  return node.children.find(c => c.className === "msg-foot");
}
const part = (foot: FakeNode, cls: string) => foot.children.find(c => String(c.className).split(" ").includes(cls));

async function click(button: FakeNode) {
  await Promise.all(button.listeners.click!.map(fn => fn()));
}

describe("Anzeige", () => {
  test("leise Zeile „General · claude-opus-5-5 · 42 s“ unter der Antwort, hinter dem Kopf im DOM", () => {
    const { app } = load();
    const node = app.messageElement(REPLY, "general");
    expect(node.children.map(c => c.className)).toEqual(["bubble content", "msg-head", "msg-foot"]);
    const foot = footer(node)!;
    // Reihenfolge: Knopf, Uhrzeit (Issue #186), Metazeile, Status
    expect(foot.children.map(c => c.className)).toEqual(["icon-button copy-button", "msg-time", "msg-meta", "copy-status"]);
    expect(part(foot, "msg-meta")!.textContent).toBe("General · claude-opus-5-5 · 42 s");
    // Das HTML der Antwort wird wie bisher gesetzt; alles in der Fußzeile nur als Text
    expect(node.children[0]!.innerHTMLWrites).toEqual([REPLY.html]);
    for (const c of foot.children) expect(c.innerHTMLWrites).toEqual([]);
  });

  test("nennt den Motor der Antwort (Issues #125, #126), auch Claude Code", () => {
    const { app } = load();
    const codex = app.messageElement({ ...REPLY, engine: "codex", model: "gpt-5.6-sol" }, "general");
    expect(part(footer(codex)!, "msg-meta")!.textContent).toBe("General · Codex · gpt-5.6-sol · 42 s");
    const codexDefault = app.messageElement({ ...REPLY, engine: "codex", model: undefined }, "general");
    expect(part(footer(codexDefault)!, "msg-meta")!.textContent).toBe("General · Codex · 42 s");
    // Issue #129: OpenCode mit Modell <anbieter>/<modell>, ohne Modell nur der Motor
    const opencode = app.messageElement({ ...REPLY, engine: "opencode", model: "openai/gpt-5.5" }, "general");
    expect(part(footer(opencode)!, "msg-meta")!.textContent).toBe("General · OpenCode · openai/gpt-5.5 · 42 s");
    const opencodeDefault = app.messageElement({ ...REPLY, engine: "opencode", model: undefined }, "general");
    expect(part(footer(opencodeDefault)!, "msg-meta")!.textContent).toBe("General · OpenCode · 42 s");
    // Issue #126: auch Claude Code, etwa wenn es für einen nicht bereiten Codex einspringt
    const claude = app.messageElement({ ...REPLY, engine: "claude" }, "general");
    expect(part(footer(claude)!, "msg-meta")!.textContent).toBe("General · Claude Code · claude-opus-5-5 · 42 s");
    const unknown = app.messageElement({ ...REPLY, engine: "__proto__" }, "general");
    expect(part(footer(unknown)!, "msg-meta")!.textContent).toBe("General · claude-opus-5-5 · 42 s");
  });

  test("Fallback-Antworten und ältere Antworten ohne engine nennen keinen Motor (Issue #126)", () => {
    const { app } = load();
    // Fallback: Modell kommt von OpenRouter, TurnInfo hat keinen Motor
    const fallback = app.messageElement({ ...REPLY, model: "minimax/minimax-m2.7" }, "general");
    expect(part(footer(fallback)!, "msg-meta")!.textContent).toBe("General · minimax/minimax-m2.7 · 42 s");
    const old = app.messageElement({ ...REPLY, model: undefined, durationMs: undefined }, "general");
    expect(part(footer(old)!, "msg-meta")!.textContent).toBe("General");
  });

  test("HTML-artige Modellnamen und Agenten landen als Text", () => {
    const { app } = load();
    const hostile = '<img src=x onerror="alert(1)">';
    const node = app.messageElement({ ...REPLY, model: hostile, agent: "cto" });
    const meta = part(footer(node)!, "msg-meta")!;
    expect(meta.textContent).toBe(`CTO · ${hostile} · 42 s`);
    expect(meta.innerHTMLWrites).toEqual([]);
  });

  test("alte Nachrichten zeigen nur, was da ist; nichts vom Gesprächs-Agenten erfunden", () => {
    const { app } = load();
    const old = { id: "a0", role: "assistant", text: "alt", html: "<p>alt</p>", createdAt: REPLY.createdAt };
    // ohne Angaben, ohne copyText und ohne gültiges createdAt: keine Fußzeile, der Kopf bleibt
    const bare = app.messageElement({ ...old, createdAt: "kaputt" }, "research");
    expect(footer(bare)).toBeUndefined();
    expect(bare.children[1]!.className).toBe("msg-head");
    // nur ein gültiger Zeitpunkt (Issue #186): Fußzeile allein mit der Uhrzeit
    const timeOnly = footer(app.messageElement(old, "research"))!;
    expect(timeOnly.children.map(c => c.className)).toEqual(["msg-time"]);
    // nur copyText: Knopf ohne Zeile
    const copyOnly = footer(app.messageElement({ ...old, createdAt: undefined, copyText: "alt" }, "research"))!;
    expect(part(copyOnly, "copy-button")).toBeDefined();
    expect(part(copyOnly, "msg-meta")).toBeUndefined();
    expect(part(copyOnly, "msg-time")).toBeUndefined();
    // nur Agent und Dauer
    expect(app.replyMetaText({ agent: "research", durationMs: 1500 })).toBe("Research · 2 s");
    expect(app.replyMetaText({ model: "qwen3:8b" })).toBe("qwen3:8b");
    expect(app.replyMetaText({ durationMs: "42" })).toBe("");
  });

  test("Nutzer- und Fehlernachrichten haben keine Fußzeile", () => {
    const { app } = load();
    expect(footer(app.messageElement({ ...REPLY, role: "user" }))).toBeUndefined();
    expect(footer(app.messageElement({ ...REPLY, role: "error" }))).toBeUndefined();
  });

  test("Dauer kurz auf Deutsch", () => {
    const { app } = load();
    expect(app.formatDuration(42_000)).toBe("42 s");
    expect(app.formatDuration(400)).toBe("0,4 s");
    expect(app.formatDuration(10)).toBe("0,1 s");
    expect(app.formatDuration(185_000)).toBe("3 min 5 s");
    expect(app.formatDuration(120_000)).toBe("2 min");
    expect(app.formatDuration(3_720_000)).toBe("1 h 2 min");
    expect(app.formatDuration(-1)).toBeNull();
    expect(app.formatDuration(undefined)).toBeNull();
  });

  test("Knopf mit zugänglichem Namen; am Handy 44 px Tippfläche", () => {
    const { app } = load();
    const button = part(footer(app.messageElement(REPLY))!, "copy-button")!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.attributes["aria-label"]).toBe("Antwort kopieren");
    expect(button.className).toContain("icon-button");
    const mobile = css.slice(css.indexOf("@media (max-width: 55.99rem)"));
    expect(mobile.slice(0, mobile.indexOf("\n}\n"))).toContain(".copy-button { width: 2.75rem; height: 2.75rem; }");
    // Status wird Screenreadern angesagt
    expect(part(footer(app.messageElement(REPLY))!, "copy-status")!.attributes["role"]).toBe("status");
  });
});

describe("Kopieren", () => {
  test("Clipboard-API: Markdown ohne Steuer-Tags, „Kopiert“ nur bei Erfolg, danach zurückgesetzt", async () => {
    const written: string[] = [];
    const env = load({ clipboard: { writeText: async t => void written.push(t) } });
    const foot = footer(env.app.messageElement(REPLY))!;
    const status = part(foot, "copy-status")!;
    expect(status.textContent).toBe("");
    await click(part(foot, "copy-button")!);
    expect(written).toEqual(["**Plan** steht."]);
    expect(written[0]).not.toContain("REMEMBER");
    expect(status.textContent).toBe("Kopiert");
    expect(foot.attributes["data-copy"]).toBe("ok");
    expect(status.innerHTMLWrites).toEqual([]);
    env.runTimers();
    expect(status.textContent).toBe("");
    expect(foot.attributes["data-copy"]).toBeUndefined();
  });

  test("zweimal kurz hintereinander: nur ein Rücksetz-Timer läuft", async () => {
    const env = load({ clipboard: { writeText: async () => {} } });
    const foot = footer(env.app.messageElement(REPLY))!;
    const button = part(foot, "copy-button")!;
    await click(button);
    await click(button);
    expect(env.timers.size).toBe(1);
  });

  test("ohne Clipboard-API (HTTP an der LAN-IP): Ersatzweg über ein Textfeld", async () => {
    const env = load({ execCommand: () => true });
    const foot = footer(env.app.messageElement(REPLY))!;
    const button = part(foot, "copy-button")!;
    await click(button);
    expect(env.execCalls).toEqual([{ command: "copy", value: "**Plan** steht.", selected: true }]);
    const area = env.body.children[0]!;
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.className).toBe("copy-buffer");
    expect(area.removed).toBe(true);
    expect(part(foot, "copy-status")!.textContent).toBe("Kopiert");
    // Der Knopf bekommt den Fokus zurück
    expect(button.focused).toBe(1);
  });

  test("Clipboard-API lehnt ab: Ersatzweg; scheitert der auch, Fehlermeldung statt „Kopiert“", async () => {
    const rejected = load({
      clipboard: { writeText: async () => Promise.reject(new Error("NotAllowedError")) },
      execCommand: () => true,
    });
    const okFoot = footer(rejected.app.messageElement(REPLY))!;
    await click(part(okFoot, "copy-button")!);
    expect(rejected.execCalls).toHaveLength(1);
    expect(part(okFoot, "copy-status")!.textContent).toBe("Kopiert");

    const failing = load({
      clipboard: { writeText: async () => Promise.reject(new Error("NotAllowedError")) },
      execCommand: () => false,
    });
    const foot = footer(failing.app.messageElement(REPLY))!;
    await click(part(foot, "copy-button")!);
    expect(part(foot, "copy-status")!.textContent).toBe("Kopieren nicht möglich");
    expect(foot.attributes["data-copy"]).toBe("failed");
    failing.runTimers();
    expect(part(foot, "copy-status")!.textContent).toBe("");
  });

  test("weder Clipboard-API noch execCommand: Fehlermeldung", async () => {
    const env = load();
    const foot = footer(env.app.messageElement(REPLY))!;
    await click(part(foot, "copy-button")!);
    expect(part(foot, "copy-status")!.textContent).toBe("Kopieren nicht möglich");
  });

  test("execCommand wirft: Fehlermeldung, Textfeld trotzdem entfernt", async () => {
    const env = load({
      execCommand: () => {
        throw new Error("SecurityError");
      },
    });
    const foot = footer(env.app.messageElement(REPLY))!;
    await click(part(foot, "copy-button")!);
    expect(part(foot, "copy-status")!.textContent).toBe("Kopieren nicht möglich");
    expect(env.body.children[0]!.removed).toBe(true);
  });
});
