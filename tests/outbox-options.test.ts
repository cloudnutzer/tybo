/**
 * Issue #46: sendAndRecord mit format, buttons und linkPreview sowie die
 * CLI-Schalter --plain und --no-preview. Telegram und Speicher sind Attrappen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import type { Message } from "../src/lib/supabase";
import { parseNotifyArgs } from "../scripts/notify";

/** Präzisierung zu #52: keine versteckte Adresse (Link oder ganzes Bild), sichtbarer Text ist erlaubt */
const hidesSecret = (s: string) => /href=\\?"https:\/\/a\.b\/geheim|!\[[^\]]*\]\(https:\/\/a\.b\/geheim[^)]*\)/.test(s);

const USER = "4711";
const GROUP = "-1001234567890";

interface Sent {
  url: string;
  json?: Record<string, any>;
  form?: FormData;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-options-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(status: (index: number) => number = () => 200) {
  const sent: Sent[] = [];
  const recorded: Message[] = [];
  const deps: OutboxDeps = {
    botToken: "123:t",
    userId: USER,
    groupId: GROUP,
    outboxDir: join(dir, "outbox"),
    fetch: async (url, init) => {
      const entry: Sent = { url };
      if (init.body instanceof FormData) entry.form = init.body;
      else entry.json = JSON.parse(String(init.body));
      sent.push(entry);
      return new Response("{}", { status: status(sent.length - 1) });
    },
    record: async m => {
      recorded.push(m);
      return true;
    },
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  return { deps, sent, recorded };
}

const BUTTONS = [
  [
    { text: "Snooze", callback_data: "snooze" },
    { text: "Got it", callback_data: "dismiss" },
  ],
];

const LONG = Array.from({ length: 30 }, (_, i) => `Absatz ${i} ` + "x".repeat(300)).join("\n\n");

describe("buttons", () => {
  test("hängen am einzigen Stück, festgehalten wird nur der Text", async () => {
    const { deps, sent, recorded } = fakeDeps();
    const result = await sendAndRecord({ text: "**Hallo**", source: "checkin", buttons: BUTTONS }, deps);
    expect(result).toEqual({ sent: true, recorded: true });
    expect(sent[0].json).toEqual({
      chat_id: USER,
      text: "<b>Hallo</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: BUTTONS },
    });
    expect(recorded).toEqual([
      { chat_id: USER, role: "assistant", content: "**Hallo**", metadata: { display_only: true, source: "checkin" } },
    ]);
  });

  test("nur am letzten von mehreren Stücken", async () => {
    const { deps, sent } = fakeDeps();
    await sendAndRecord({ text: LONG, source: "checkin", buttons: BUTTONS }, deps);
    expect(sent.length).toBeGreaterThan(1);
    for (const s of sent.slice(0, -1)) expect(s.json?.reply_markup).toBeUndefined();
    expect(sent.at(-1)?.json?.reply_markup).toEqual({ inline_keyboard: BUTTONS });
  });

  test("auch beim Klartext-Rückfall nach 400", async () => {
    const { deps, sent } = fakeDeps(i => (i === 0 ? 400 : 200));
    const result = await sendAndRecord({ text: "a < b **fett**", source: "checkin", buttons: BUTTONS }, deps);
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].json).toEqual({
      chat_id: USER,
      text: "a < b fett",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: BUTTONS },
    });
  });

  test("ohne Text abgelehnt, auch mit Datei; ungültige Form abgelehnt", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    const { deps, sent } = fakeDeps();
    for (const input of [
      { file, source: "datei", buttons: BUTTONS },
      { text: "x", source: "checkin", buttons: [] },
      { text: "x", source: "checkin", buttons: [[]] },
      { text: "x", source: "checkin", buttons: [[{ text: "a" }]] },
      { text: "x", source: "checkin", buttons: [[{ text: "", callback_data: "a" }]] },
    ]) {
      const result = await sendAndRecord(input as any, deps);
      expect(result.error?.kind).toBe("invalid");
    }
    expect(sent).toHaveLength(0);
  });
});

describe("format plain", () => {
  test("ohne parse_mode und ohne Umwandlung", async () => {
    const { deps, sent, recorded } = fakeDeps();
    const text = "📞 Anruf wegen <name> & **nicht fett**\n---";
    const result = await sendAndRecord({ text, source: "checkin", format: "plain", buttons: BUTTONS }, deps);
    expect(result).toEqual({ sent: true, recorded: true });
    expect(sent[0].json).toEqual({
      chat_id: USER,
      text,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: BUTTONS },
    });
    expect(recorded[0].content).toBe(text);
  });

  test("400 führt nicht zu einem veränderten zweiten Versuch", async () => {
    const { deps, sent, recorded } = fakeDeps(() => 400);
    const result = await sendAndRecord({ text: "a &amp; <b>", source: "pipeline", format: "plain" }, deps);
    expect(result.sent).toBe(false);
    expect(result.error?.kind).toBe("send");
    expect(sent).toHaveLength(1);
    expect(recorded).toHaveLength(0);
  });

  test("lange Texte in Stücken, zusammen wieder der Rohtext", async () => {
    const { deps, sent } = fakeDeps();
    await sendAndRecord({ text: LONG, source: "pipeline", format: "plain" }, deps);
    expect(sent.length).toBeGreaterThan(1);
    for (const s of sent) expect(s.json?.parse_mode).toBeUndefined();
    expect(sent.map(s => s.json?.text).join("\n\n")).toBe(LONG);
  });

  test("leer nach Formatierung gilt nur für Markdown: --- geht als Klartext", async () => {
    const { deps, sent } = fakeDeps();
    expect((await sendAndRecord({ text: "---", source: "p" }, deps)).error?.kind).toBe("invalid");
    expect((await sendAndRecord({ text: "---", source: "p", format: "plain" }, deps)).sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect((await sendAndRecord({ text: "   ", source: "p", format: "plain" }, deps)).error?.kind).toBe("invalid");
  });

  test("unbekanntes format abgelehnt", async () => {
    const { deps, sent } = fakeDeps();
    expect((await sendAndRecord({ text: "x", source: "p", format: "html" as any }, deps)).error?.kind).toBe("invalid");
    expect(sent).toHaveLength(0);
  });
});

describe("linkPreview", () => {
  test("false setzt link_preview_options an jedem Stück, auch im Rückfall", async () => {
    const { deps, sent } = fakeDeps(i => (i === 0 ? 400 : 200));
    await sendAndRecord({ text: LONG, source: "pipeline", linkPreview: false }, deps);
    expect(sent.length).toBeGreaterThan(2);
    for (const s of sent) expect(s.json?.link_preview_options).toEqual({ is_disabled: true });
  });

  test("ohne Angabe ist die Vorschau trotzdem aus (Issue #52), auch Klartext und Rückfall", async () => {
    for (const format of ["markdown", "plain"] as const) {
      // Rückfall gibt es nur bei Markdown
      const { deps, sent } = fakeDeps(i => (i === 0 && format === "markdown" ? 400 : 200));
      await sendAndRecord({ text: `${LONG}\nhttps://example.org`, source: "pipeline", format }, deps);
      expect(sent.length).toBeGreaterThan(1);
      for (const s of sent) expect(s.json?.link_preview_options).toEqual({ is_disabled: true });
    }
  });

  test("true ist kein erlaubter Wert", async () => {
    const { deps } = fakeDeps();
    expect((await sendAndRecord({ text: "x", source: "p", linkPreview: true as any }, deps)).error?.kind).toBe("invalid");
  });
});

describe("Bereinigung (Issue #52)", () => {
  const INJECTED = "Hier ![x](https://a.b/geheim) und [Doku](https://ok.example)​\u{E0061}";

  test("Markdown: Bild ohne Adresse, Link bleibt, festgehalten wird das Original", async () => {
    const { deps, sent, recorded } = fakeDeps();
    await sendAndRecord({ text: INJECTED, source: "pipeline" }, deps);
    expect(sent[0].json?.text).toBe('Hier x und <a href="https://ok.example">Doku</a>');
    expect(recorded[0].content).toBe(INJECTED);
  });

  test("Klartext und Klartext-Rückfall ohne Adresse", async () => {
    const { deps, sent } = fakeDeps();
    await sendAndRecord({ text: INJECTED, source: "pipeline", format: "plain" }, deps);
    expect(sent[0].json?.text).toBe("Hier x und [Doku](https://ok.example)");

    const fallback = fakeDeps(i => (i === 0 ? 400 : 200));
    await sendAndRecord({ text: INJECTED, source: "pipeline" }, fallback.deps);
    expect(fallback.sent[1].json?.text).toBe("Hier x und Doku");
    for (const s of fallback.sent) expect(JSON.stringify(s.json)).not.toContain("a.b/geheim");
  });

  test("caption einer Datei bereinigt, ohne link_preview_options", async () => {
    const { deps, sent } = fakeDeps();
    const path = join(dir, "bericht.txt");
    writeFileSync(path, "inhalt");
    await sendAndRecord({ file: path, caption: "![x](https://a.b/geheim)​", source: "datei" }, deps);
    expect(sent[0].form?.get("caption")).toBe("x");
    expect(sent[0].form?.has("link_preview_options")).toBe(false);
  });

  test("CRLF, Definition im Blockzitat, zwei Backslashes: Klartext und caption ohne versteckte Adresse", async () => {
    const path = join(dir, "bericht.txt");
    writeFileSync(path, "inhalt");
    for (const text of [
      "![x][r]\r\n\r\n[r]: https://a.b/geheim\r\n",
      "> ![x][r]\n>\n> [r]: https://a.b/geheim",
      "\\\\![x](https://a.b/geheim)",
    ]) {
      const { deps, sent, recorded } = fakeDeps();
      await sendAndRecord({ text, source: "pipeline", format: "plain" }, deps);
      await sendAndRecord({ file: path, caption: text, source: "datei" }, deps);
      expect(sent).toHaveLength(2);
      expect(hidesSecret(JSON.stringify(sent[0].json))).toBe(false);
      expect(hidesSecret(String(sent[1].form?.get("caption")))).toBe(false);
      expect(recorded.map(m => m.content)).toEqual([text, text]);
    }
  });

  test("Text nur aus unsichtbaren Zeichen wird abgelehnt, auch als Klartext", async () => {
    for (const format of ["markdown", "plain"] as const) {
      const { deps, sent } = fakeDeps();
      const result = await sendAndRecord({ text: "​\u{E0061}", source: "pipeline", format }, deps);
      expect(result.error?.kind).toBe("invalid");
      expect(sent).toHaveLength(0);
    }
  });
});

describe("notify --plain und --no-preview", () => {
  test("setzen format und linkPreview", () => {
    expect(parseNotifyArgs(["--source", "pipeline", "--plain", "--no-preview", "--text=x"])).toEqual({
      input: { source: "pipeline", text: "x", format: "plain", linkPreview: false },
    });
  });

  test("ohne Schalter bleibt die Eingabe wie bisher", () => {
    expect(parseNotifyArgs(["--source", "pipeline", "--text", "x"])).toEqual({ input: { source: "pipeline", text: "x" } });
  });

  test("Schalter mit Wert oder doppelt: Fehler", () => {
    expect(parseNotifyArgs(["--source", "p", "--text", "x", "--plain=1"])).toHaveProperty("error");
    expect(parseNotifyArgs(["--source", "p", "--text", "x", "--plain", "--plain"])).toHaveProperty("error");
    expect(parseNotifyArgs(["--source", "p", "--text", "x", "--no-preview=false"])).toHaveProperty("error");
  });

  test("Schalter schlucken kein folgendes Argument", () => {
    expect(parseNotifyArgs(["--plain", "--source", "p", "--text", "x"])).toEqual({
      input: { source: "p", text: "x", format: "plain" },
    });
  });
});

describe("Datei-Caption über dieselbe Nutzlastbereinigung (Runde 9)", () => {
  test("Klartext-Caption mit <img> und !<a> geht wörtlich durch den Guard, festgehalten wird das Original", async () => {
    const path = join(dir, "bild.txt");
    writeFileSync(path, "inhalt");
    for (const caption of ['<img src="https://a.b/geheim">', '!<a href="https://a.b/geheim">x</a>']) {
      const { deps, sent, recorded } = fakeDeps();
      await sendAndRecord({ file: path, caption, source: "datei" }, deps);
      // Klartext zeigt Telegram wörtlich, dort versteckt nichts eine Adresse (Präzisierung, Runde 14)
      expect(String(sent[0].form?.get("caption"))).toBe(caption);
      expect(recorded.map(m => m.content)).toEqual([caption]);
    }
  });
});
