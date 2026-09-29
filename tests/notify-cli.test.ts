/**
 * Issue #45: CLI bun run notify (scripts/notify.ts). Argumente und
 * Exit-Codes in-process mit Attrappen; zusätzlich als echter Prozess in
 * einem temporären Ordner mit eigener .env ohne Bot-Token, damit nie ein
 * echter Telegram-Aufruf entsteht.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { OutboxDeps } from "../src/lib/outbox";
import type { Message } from "../src/lib/supabase";
import { EXIT_OK, EXIT_SEND_FAILED, EXIT_USAGE, parseNotifyArgs, runNotify } from "../scripts/notify";

describe("parseNotifyArgs", () => {
  test("alle Optionen, auch in der Form --name=wert", () => {
    expect(parseNotifyArgs(["--source", "pipeline", "--text", "Hallo", "--topic", "443"])).toEqual({
      input: { source: "pipeline", text: "Hallo", topicId: 443 },
    });
    expect(parseNotifyArgs(["--source=datei", "--file=/tmp/a.pdf", "--caption=Bericht"])).toEqual({
      input: { source: "datei", file: "/tmp/a.pdf", caption: "Bericht" },
    });
    expect(parseNotifyArgs(["--source", "x", "--text=--- Trenner"])).toEqual({ input: { source: "x", text: "--- Trenner" } });
  });

  test("Fehler: fehlende source, nichts zu senden, unbekannt, doppelt, ohne Wert, schlechtes Topic", () => {
    const errors = [
      ["--text", "x"],
      ["--source", "pipeline"],
      ["--source", "p", "--text", "x", "--chat", "1"],
      ["--source", "p", "--text", "x", "--text", "y"],
      ["--source", "p", "--text"],
      ["--source", "--text", "x"],
      ["--source", "p", "--text", "x", "--topic", "abc"],
      ["--source", "p", "--text", "x", "--topic", "0"],
      ["--source", "p", "--text", "x", "--topic", "-5"],
      ["--source", "p", "frei"],
    ];
    for (const argv of errors) expect(parseNotifyArgs(argv)).toHaveProperty("error");
  });

  test("--help", () => {
    expect(parseNotifyArgs(["--help"])).toEqual({ help: true });
  });
});

describe("runNotify", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notify-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(status = 200, record: (m: Message) => Promise<boolean> = async () => true) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: string[] = [];
    const deps: OutboxDeps = {
      botToken: "123:t",
      userId: "4711",
      groupId: null,
      outboxDir: join(dir, "outbox"),
      fetch: async url => {
        calls.push(url);
        return new Response("{}", { status });
      },
      record,
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    return { deps: () => deps, io, out, err, calls };
  }

  test("gesendet und festgehalten: 0", async () => {
    const s = setup();
    expect(await runNotify(["--source", "pipeline", "--text", "Hallo"], s.deps, s.io, {})).toBe(EXIT_OK);
    expect(s.calls).toHaveLength(1);
    expect(s.out.join("\n")).toContain("festgehalten");
  });

  test("Telegram scheitert: 1", async () => {
    const s = setup(500);
    expect(await runNotify(["--source", "pipeline", "--text", "Hallo"], s.deps, s.io, {})).toBe(EXIT_SEND_FAILED);
    expect(s.err.join("\n")).toContain("Nicht gesendet");
  });

  test("nur das Festhalten scheitert: trotzdem 0", async () => {
    const s = setup(200, async () => false);
    expect(await runNotify(["--source", "pipeline", "--text", "Hallo"], s.deps, s.io, {})).toBe(EXIT_OK);
    expect(s.out.join("\n")).toContain("nicht festgehalten");
  });

  test("falsche Argumente und abgelehnte Eingaben: 2, nichts gesendet", async () => {
    const s = setup();
    expect(await runNotify(["--text", "Hallo"], s.deps, s.io, {})).toBe(EXIT_USAGE);
    // Topic ohne Forum-Gruppe
    expect(await runNotify(["--source", "p", "--text", "x", "--topic", "443"], s.deps, s.io, {})).toBe(EXIT_USAGE);
    // Datei fehlt
    expect(await runNotify(["--source", "datei", "--file", join(dir, "fehlt.pdf")], s.deps, s.io, {})).toBe(EXIT_USAGE);
    expect(s.calls).toHaveLength(0);
  });

  test("--text=---: nach der Formatierung leer, 2, nichts gesendet und nichts festgehalten", async () => {
    const recorded: Message[] = [];
    const s = setup(200, async m => {
      recorded.push(m);
      return true;
    });
    expect(await runNotify(["--source=pipeline", "--text=---"], s.deps, s.io, {})).toBe(EXIT_USAGE);
    expect(s.calls).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(s.out.join("\n")).not.toContain("Gesendet");
    expect(s.err.join("\n")).toContain("Nicht gesendet");
  });

  test("Datei: 0, Kopie in der Ablage", async () => {
    const s = setup();
    const file = join(dir, "bericht.txt");
    writeFileSync(file, "Inhalt");
    expect(await runNotify(["--source", "datei", "--file", file, "--caption", "Bericht"], s.deps, s.io, {})).toBe(EXIT_OK);
    expect(s.calls[0]).toEndWith("/sendDocument");
  });
});

describe("als Prozess", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "notify-proc-"));
    // Eigene .env ohne Bot-Token: loadEnv liest sie, Bun lädt sie aus dem cwd
    writeFileSync(join(root, ".env"), "TELEGRAM_USER_ID=4711\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const proc = Bun.spawnSync(["bun", "run", resolve(import.meta.dir, "../scripts/notify.ts"), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: root, GO_PROJECT_ROOT: root },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  test("ohne Argumente: 2 mit Hilfe", () => {
    const r = run([]);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toContain("--source fehlt");
    expect(r.stderr).toContain("Aufruf: bun run notify");
  });

  test("--help: 0", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain("--topic");
  });

  test("ohne Bot-Token und ohne Datenbank: 1, nicht festgehalten, nichts abgelegt (Issue #227)", () => {
    const r = run(["--source", "pipeline", "--text", "Hallo"]);
    expect(r.code).toBe(EXIT_SEND_FAILED);
    expect(r.stderr).toContain("Nicht festgehalten");
    expect(existsSync(join(root, "data"))).toBe(false);
  });
});
