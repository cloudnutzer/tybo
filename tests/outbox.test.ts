/**
 * Issue #45: sendAndRecord in src/lib/outbox.ts. Telegram und Speicher sind
 * Attrappen, Dateien liegen in einem temporären Ordner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import {
  MAX_FILE_BYTES,
  sendAndRecord,
  type OutboxDeps,
} from "../src/lib/outbox";
import type { Message } from "../src/lib/supabase";

const USER = "4711";
const GROUP = "-1001234567890";
const TOKEN = "123:test-token";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Sent {
  url: string;
  json?: Record<string, unknown>;
  form?: FormData;
}

let dir: string;
let outboxDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-test-"));
  outboxDir = join(dir, "data", "outbox");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(options: {
  status?: (sent: Sent, index: number) => number | Error;
  record?: (m: Message) => Promise<boolean>;
  groupId?: string | null;
} = {}) {
  const sent: Sent[] = [];
  const recorded: Message[] = [];
  const logs: string[] = [];
  const deps: OutboxDeps = {
    botToken: TOKEN,
    userId: USER,
    groupId: options.groupId === undefined ? GROUP : options.groupId,
    outboxDir,
    fetch: async (url, init) => {
      const entry: Sent = { url };
      if (init.body instanceof FormData) entry.form = init.body;
      else entry.json = JSON.parse(String(init.body));
      sent.push(entry);
      const status = options.status ? options.status(entry, sent.length - 1) : 200;
      if (status instanceof Error) throw status;
      return new Response("{}", { status });
    },
    record: options.record ?? (async m => {
      recorded.push(m);
      return true;
    }),
    log: line => logs.push(line),
    newId: () => crypto.randomUUID(),
  };
  return { deps, sent, recorded, logs };
}

function writeFile(name: string, content: string | Uint8Array = "Hallo Datei"): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("Text", () => {
  test("geht als HTML an den Direktchat und wird als Nur-Anzeige festgehalten", async () => {
    const { deps, sent, recorded } = fakeDeps();
    const result = await sendAndRecord({ text: "**Pipeline** fertig", source: "pipeline" }, deps);
    expect(result).toEqual({ sent: true, recorded: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(sent[0].json).toEqual({
      chat_id: USER,
      text: "<b>Pipeline</b> fertig",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(recorded).toEqual([
      { chat_id: USER, role: "assistant", content: "**Pipeline** fertig", metadata: { display_only: true, source: "pipeline" } },
    ]);
  });

  test("bei 400 einmal als reiner Text", async () => {
    const { deps, sent, recorded } = fakeDeps({ status: (_s, i) => (i === 0 ? 400 : 200) });
    const result = await sendAndRecord({ text: "a < b", source: "watchdog" }, deps);
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].json?.parse_mode).toBeUndefined();
    expect(recorded).toHaveLength(1);
  });

  test("langer Text in Stücken; scheitert ein späteres Stück, wird nichts festgehalten", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `Absatz ${i} ` + "x".repeat(300)).join("\n\n");
    const ok = fakeDeps();
    expect((await sendAndRecord({ text: long, source: "briefing" }, ok.deps)).sent).toBe(true);
    expect(ok.sent.length).toBeGreaterThan(1);
    expect(ok.recorded).toHaveLength(1);
    expect(ok.recorded[0].content).toBe(long);

    const partial = fakeDeps({ status: (_s, i) => (i === 1 ? 500 : 200) });
    const result = await sendAndRecord({ text: long, source: "briefing" }, partial.deps);
    expect(result.sent).toBe(false);
    expect(result.recorded).toBe(false);
    expect(result.error?.kind).toBe("send");
    // Abbruch nach dem gescheiterten Stück, keine Lücken im Verlauf
    expect(partial.sent).toHaveLength(2);
    expect(partial.recorded).toHaveLength(0);
    expect(partial.logs.join("\n")).toContain("HTTP 500");
  });
});

describe("Topic", () => {
  test("--topic wählt die Forum-Gruppe mit message_thread_id, topicId numerisch", async () => {
    const { deps, sent, recorded } = fakeDeps();
    await sendAndRecord({ text: "Stand", topicId: 443, source: "pipeline" }, deps);
    expect(sent[0].json).toMatchObject({ chat_id: GROUP, message_thread_id: 443 });
    expect(recorded[0].chat_id).toBe(GROUP);
    expect(recorded[0].metadata).toEqual({ display_only: true, source: "pipeline", topicId: 443 });
  });

  test("General (1) geht ohne Thread-ID an die Gruppe und ohne topicId (group:<id>)", async () => {
    const { deps, sent, recorded } = fakeDeps();
    await sendAndRecord({ text: "Allgemein", topicId: 1, source: "checkin" }, deps);
    expect(sent[0].json?.chat_id).toBe(GROUP);
    expect(sent[0].json).not.toHaveProperty("message_thread_id");
    expect(recorded[0].chat_id).toBe(GROUP);
    expect(recorded[0].metadata).not.toHaveProperty("topicId");
  });

  test("ohne Forum-Gruppe wird abgelehnt, nie an den Direktchat umgeleitet", async () => {
    const { deps, sent, recorded } = fakeDeps({ groupId: null });
    const result = await sendAndRecord({ text: "Stand", topicId: 443, source: "pipeline" }, deps);
    expect(result.error?.kind).toBe("invalid");
    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  test("ungültige Topic-ID und fremde Chat-ID werden abgelehnt", async () => {
    const { deps, sent } = fakeDeps();
    for (const topicId of [0, -3, 1.5, Number.NaN]) {
      expect((await sendAndRecord({ text: "x", topicId, source: "pipeline" }, deps)).error?.kind).toBe("invalid");
    }
    expect((await sendAndRecord({ text: "x", chatId: "999", source: "pipeline" }, deps)).error?.kind).toBe("invalid");
    expect((await sendAndRecord({ text: "x", chatId: USER, topicId: 5, source: "pipeline" }, deps)).error?.kind).toBe("invalid");
    expect(sent).toHaveLength(0);
  });

  test("chatId der Gruppe ohne Topic landet im General", async () => {
    const { deps, sent, recorded } = fakeDeps();
    await sendAndRecord({ text: "x", chatId: GROUP, source: "pipeline" }, deps);
    expect(sent[0].json?.chat_id).toBe(GROUP);
    expect(recorded[0].metadata).not.toHaveProperty("topicId");
  });
});

describe("Eingabevertrag", () => {
  test("leer, caption ohne Datei, fehlende oder ungültige source, zu lange caption", async () => {
    const { deps, sent } = fakeDeps();
    const file = writeFile("a.txt");
    const cases = [
      { source: "pipeline" },
      { text: "   ", source: "pipeline" },
      { text: "x", caption: "c", source: "pipeline" },
      { text: "x" } as { text: string; source: string },
      { text: "x", source: "" },
      { text: "x", source: "Pipeline Run!" },
      { file, caption: "c".repeat(1025), source: "datei" },
    ];
    for (const input of cases) {
      const result = await sendAndRecord(input, deps);
      expect(result.sent).toBe(false);
      expect(result.error?.kind).toBe("invalid");
    }
    expect(sent).toHaveLength(0);
  });

  test("Text, der nach der Formatierung leer ist (---), wird abgelehnt: kein Versand, kein Eintrag", async () => {
    const { deps, sent, recorded } = fakeDeps();
    const file = writeFile("a.txt");
    for (const input of [{ text: "---", source: "pipeline" }, { text: "---", file, source: "pipeline" }]) {
      const result = await sendAndRecord(input, deps);
      expect(result.sent).toBe(false);
      expect(result.recorded).toBe(false);
      expect(result.error?.kind).toBe("invalid");
    }
    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  test("ohne Bot-Token wird nichts gesendet", async () => {
    const { deps, sent } = fakeDeps();
    const result = await sendAndRecord({ text: "x", source: "pipeline" }, { ...deps, botToken: "" });
    expect(result.error?.kind).toBe("invalid");
    expect(sent).toHaveLength(0);
  });
});

describe("Datei", () => {
  test("wird nach data/outbox/<id>/ kopiert, die Kopie gesendet und mit file festgehalten", async () => {
    const { deps, sent, recorded } = fakeDeps();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3, 255]);
    const path = writeFile("Bericht Q3.pdf", bytes);
    const result = await sendAndRecord({ file: path, caption: "Quartalsbericht", topicId: 443, source: "datei" }, deps);
    expect(result.sent).toBe(true);
    expect(result.recorded).toBe(true);

    const stored = result.file!;
    expect(stored.id).toMatch(UUID);
    expect(stored.name).toBe("Bericht Q3.pdf");
    expect(stored.size).toBe(bytes.length);
    expect(stored.mime).toBe("application/pdf");
    expect(stored.path).toBe(join(resolve(outboxDir), stored.id, "Bericht Q3.pdf"));
    expect(new Uint8Array(readFileSync(stored.path))).toEqual(bytes);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendDocument`);
    const form = sent[0].form!;
    expect(form.get("chat_id")).toBe(GROUP);
    expect(form.get("message_thread_id")).toBe("443");
    expect(form.get("caption")).toBe("Quartalsbericht");
    const upload = form.get("document") as File;
    // Auf der Leitung steht nur der bereinigte Name, kein lokaler Pfad
    const wire = await new Request("http://localhost/", { method: "POST", body: form }).text();
    expect(wire).toContain('filename="Bericht Q3.pdf"');
    expect(wire).not.toContain(dir);
    // Hochgeladen werden dieselben Bytes wie in der Ablage
    expect(new Uint8Array(await upload.arrayBuffer())).toEqual(bytes);

    expect(recorded).toEqual([
      {
        chat_id: GROUP,
        role: "assistant",
        content: "Quartalsbericht",
        metadata: {
          display_only: true,
          source: "datei",
          file: { id: stored.id, name: "Bericht Q3.pdf", size: bytes.length, mime: "application/pdf" },
          topicId: 443,
        },
      },
    ]);
  });

  test("ohne caption ist content der Dateiname", async () => {
    const { deps, sent, recorded } = fakeDeps();
    const path = writeFile("report.html", "<h1>x</h1>");
    await sendAndRecord({ file: path, source: "datei" }, deps);
    expect(sent[0].form!.get("caption")).toBeNull();
    expect(recorded[0].content).toBe("report.html");
    expect((recorded[0].metadata!.file as { mime: string }).mime).toBe("text/html");
  });

  test("Text und Datei: zwei Nachrichten, zwei Einträge, Text zuerst", async () => {
    const { deps, sent, recorded } = fakeDeps();
    const path = writeFile("a.csv", "a,b\n1,2\n");
    const result = await sendAndRecord({ text: "Hier die Daten", file: path, caption: "Tabelle", source: "pipeline" }, deps);
    expect(result.sent).toBe(true);
    expect(sent.map(s => s.url.split("/").pop())).toEqual(["sendMessage", "sendDocument"]);
    expect(recorded.map(r => r.content)).toEqual(["Hier die Daten", "Tabelle"]);
    expect(recorded[0].metadata).not.toHaveProperty("file");
    expect(recorded[1].metadata).toHaveProperty("file");
  });

  test("Größenlimit: genau 50 MB geht, ein Byte mehr wird abgelehnt", async () => {
    expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
    const atLimit = writeFile("gross.bin", "");
    truncateSync(atLimit, MAX_FILE_BYTES);
    const ok = fakeDeps();
    const result = await sendAndRecord({ file: atLimit, source: "datei" }, ok.deps);
    expect(result.sent).toBe(true);
    expect(result.file?.size).toBe(MAX_FILE_BYTES);

    const over = writeFile("zu-gross.bin", "");
    truncateSync(over, MAX_FILE_BYTES + 1);
    const tooBig = fakeDeps();
    const rejected = await sendAndRecord({ file: over, source: "datei" }, tooBig.deps);
    expect(rejected.error?.kind).toBe("invalid");
    expect(tooBig.sent).toHaveLength(0);
    expect(tooBig.recorded).toHaveLength(0);
    // Nichts in die Ablage kopiert
    expect(readdirSync(outboxDir)).toHaveLength(1);
  });

  test("Datei wächst während des Textversands über 50 MB: kein sendDocument", async () => {
    const path = writeFile("waechst.bin", "klein");
    // Der simulierte Textversand vergrößert die Quelle, danach Kopie und Prüfung
    const { deps, sent, recorded, logs } = fakeDeps({
      status: s => {
        if (s.url.endsWith("/sendMessage")) truncateSync(path, MAX_FILE_BYTES + 1);
        return 200;
      },
    });
    const result = await sendAndRecord({ text: "Hier kommt die Datei", file: path, source: "pipeline" }, deps);
    expect(result.sent).toBe(false);
    expect(result.error?.kind).toBe("invalid");
    expect(sent.map(x => x.url.split("/").pop())).toEqual(["sendMessage"]);
    expect(recorded.map(r => r.content)).toEqual(["Hier kommt die Datei"]);
    // Keine übergroße Kopie in der Ablage, kein Ablagefehler-Fallback
    expect(readdirSync(outboxDir)).toHaveLength(0);
    expect(logs.join("\n")).not.toContain("Ablage fehlgeschlagen");
  });

  test("Kopieren scheitert und Datei wächst über 50 MB: das Original geht nicht ungeprüft hoch", async () => {
    writeFileSync(join(dir, "data"), "kein Ordner");
    const path = writeFile("waechst.bin", "klein");
    const { deps, sent } = fakeDeps({
      status: s => {
        if (s.url.endsWith("/sendMessage")) truncateSync(path, MAX_FILE_BYTES + 1);
        return 200;
      },
    });
    const result = await sendAndRecord({ text: "Hier kommt die Datei", file: path, source: "pipeline" }, deps);
    expect(result.sent).toBe(false);
    expect(result.error?.kind).toBe("invalid");
    expect(sent.map(x => x.url.split("/").pop())).toEqual(["sendMessage"]);
  });

  test("leere, fehlende und Ordner-Pfade werden abgelehnt", async () => {
    const { deps, sent } = fakeDeps();
    for (const file of [writeFile("leer.txt", ""), join(dir, "gibt-es-nicht.txt"), dir]) {
      expect((await sendAndRecord({ file, source: "datei" }, deps)).error?.kind).toBe("invalid");
    }
    expect(sent).toHaveLength(0);
    expect(existsSync(outboxDir)).toBe(false);
  });

  test("Senden scheitert: nichts festgehalten, Kopie wieder entfernt", async () => {
    const { deps, recorded, logs } = fakeDeps({ status: () => 413 });
    const result = await sendAndRecord({ file: writeFile("a.txt"), source: "datei" }, deps);
    expect(result).toMatchObject({ sent: false, recorded: false, error: { kind: "send" } });
    expect(recorded).toHaveLength(0);
    expect(readdirSync(outboxDir)).toHaveLength(0);
    expect(logs.join("\n")).toContain("HTTP 413");
  });

  test("Telegram wirft: wie Senden scheitert, Log ohne Token", async () => {
    const { deps, recorded, logs } = fakeDeps({ status: () => new TypeError(`fetch failed ${TOKEN}`) });
    const result = await sendAndRecord({ text: "x", source: "pipeline" }, deps);
    expect(result.error?.kind).toBe("send");
    expect(recorded).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  test("Kopieren scheitert: Original wird trotzdem gesendet, nichts festgehalten", async () => {
    // Ablage-Wurzel ist eine Datei, mkdir darunter scheitert
    writeFileSync(join(dir, "data"), "kein Ordner");
    const { deps, sent, recorded, logs } = fakeDeps();
    const path = writeFile("a.txt", "Inhalt");
    const result = await sendAndRecord({ file: path, source: "datei" }, deps);
    expect(result.sent).toBe(true);
    expect(result.recorded).toBe(false);
    expect(result.file).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(await (sent[0].form!.get("document") as File).text()).toBe("Inhalt");
    expect(recorded).toHaveLength(0);
    expect(logs.join("\n")).toContain("Ablage fehlgeschlagen");
  });
});

describe("Festhalten scheitert", () => {
  test("false: trotzdem gesendet, Log ohne Inhalt", async () => {
    const { deps, sent, logs } = fakeDeps({ record: async () => false });
    const result = await sendAndRecord({ text: "Geheimer Inhalt 42", source: "pipeline" }, deps);
    expect(result).toEqual({ sent: true, recorded: false });
    expect(sent).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("Geheimer Inhalt 42");
  });

  test("Exception: trotzdem gesendet, Log ohne Inhalt", async () => {
    const { deps, sent, logs } = fakeDeps({
      record: async () => {
        throw new Error("DB kaputt: Geheimer Inhalt 42");
      },
    });
    const path = writeFile("a.txt");
    const result = await sendAndRecord({ file: path, caption: "Geheimer Inhalt 42", source: "datei" }, deps);
    expect(result.sent).toBe(true);
    expect(result.recorded).toBe(false);
    expect(sent).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("Geheimer Inhalt 42");
    // Die Datei bleibt in der Ablage, sie wurde ja gesendet
    expect(existsSync(result.file!.path)).toBe(true);
    expect(result.file!.path.startsWith(resolve(outboxDir) + sep)).toBe(true);
  });
});
