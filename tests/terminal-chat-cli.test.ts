/**
 * Issue #60: `tybo` als eigener Prozess gegen einen echten Web-Server nur
 * im Test (Pipe statt Terminal, also schlichte Ausgabe): Gesprächswahl mit
 * --topic, Wiederherstellen aus ~/.config/tybo/state.json, Senden aus einer
 * Pipe mit Quelle terminal, Fortschritt als Zeile, keine Escape-Sequenzen,
 * --dev gegen den Schlüssel von web:dev. src/bot.ts wird nie gestartet.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startTyboServer, TEST_PASSWORD, waitFor, type TerminalTestServer } from "./terminal-fixture";

const SCRIPT = join(resolve(import.meta.dir, ".."), "scripts", "tybo.ts");
const base = await mkdtemp(join(tmpdir(), "tybo-chat-"));
afterAll(() => rm(base, { recursive: true, force: true }));
let counter = 0;
let servers: TerminalTestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function server(): Promise<TerminalTestServer> {
  const s = await startTyboServer();
  servers.push(s);
  await writeFile(join(s.dir, ".env"), `WEB_ENABLED=true\nWEB_PASSWORD=${TEST_PASSWORD}\nWEB_PORT=${new URL(s.base).port}\n`);
  return s;
}

async function newHome(): Promise<string> {
  const home = join(base, `home-${++counter}`);
  await mkdir(home, { recursive: true });
  return home;
}

function spawn(args: string[], root: string, home: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "--no-env-file", SCRIPT, ...args], {
    cwd: base,
    env: { PATH: process.env.PATH ?? "", HOME: home, TYBO_ROOT: root, TZ: "Europe/Berlin", ...extraEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({
    stdout,
    stderr,
    code,
  }));
  return { proc, output };
}

async function run(args: string[], root: string, home: string, input = "", extraEnv: Record<string, string> = {}) {
  const { proc, output } = spawn(args, root, home, extraEnv);
  if (input) proc.stdin.write(input);
  proc.stdin.end();
  return output;
}

describe("Gesprächswahl beim Start", () => {
  test("--topic mit Name: Kopfzeile mit Gespräch und Agent, letzte Nachrichten darunter", async () => {
    const s = await server();
    const r = await run(["--topic", "Recherche"], s.dir, await newHome());
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("tybo · Recherche · Agent Research");
    expect(r.stdout).toContain("Was kostet ein kleiner VPS bei Hetzner?");
    // Markdown der Antwort formatiert, ohne Sternchen
    expect(r.stdout).toContain("Ab etwa 4 Euro im Monat");
  });

  test("ohne Argumente: zuletzt genutztes Gespräch aus state.json", async () => {
    const s = await server();
    const home = await newHome();
    await run(["--topic=topic-12"], s.dir, home);
    expect(await Bun.file(join(home, ".config", "tybo", "state.json")).json()).toEqual({ conversationId: "topic-12" });
    const r = await run([], s.dir, home);
    expect(r.stdout.split("\n")[0]).toBe("tybo · Finanzen · Agent Finance");
  });

  test("gespeichertes Gespräch gelöscht: Direktchat mit Hinweis", async () => {
    const s = await server();
    const home = await newHome();
    await mkdir(join(home, ".config", "tybo"), { recursive: true });
    await writeFile(join(home, ".config", "tybo", "state.json"), JSON.stringify({ conversationId: "topic-999" }));
    const r = await run([], s.dir, home);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("tybo · Direktchat · Agent General");
    expect(r.stdout).toContain("Das zuletzt genutzte Gespräch gibt es nicht mehr, weiter im Direktchat.");
  });

  test("doppelter Name: Exit 1 mit beiden IDs; unbekannt: Exit 1 mit der Liste", async () => {
    const s = await server();
    s.telegram.upsertTopic(50, { title: "Recherche", agent: "general" });
    const home = await newHome();
    const dup = await run(["--topic", "Recherche"], s.dir, home);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("topic-443");
    expect(dup.stderr).toContain("topic-50");
    const unknown = await run(["--topic", "Gibtsnicht"], s.dir, home);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Kein Gespräch „Gibtsnicht\" gefunden");
    // Nichts gespeichert, wenn die Wahl scheitert
    expect(await Bun.file(join(home, ".config", "tybo", "state.json")).exists()).toBe(false);
  });

  test("--topic ohne Wert oder unbekannte Option: Exit 2 mit Hilfe", async () => {
    const s = await server();
    const r = await run(["--topic"], s.dir, await newHome());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("tybo --topic <Name>");
  });
});

describe("Senden aus einer Pipe (ohne TTY)", () => {
  test("Nachricht mit Quelle terminal, Fortschritt als Zeile, Antwort formatiert, keine Escape-Sequenzen", async () => {
    const s = await server();
    const { proc, output } = spawn(["--topic", "dm"], s.dir, await newHome());
    await waitFor(() => s.server.eventStreamCount() >= 1, 5000, "Live-Verbindung von tybo");
    proc.stdin.write("Frage aus der Pipe\n");
    proc.stdin.end();
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.source).toBe("terminal");
    expect(turn.opts.text).toBe("Frage aus der Pipe");
    await turn.opts.sink.progress({ kind: "tool", text: "WebSearch" });
    await new Promise(r => setTimeout(r, 100));
    s.telegramChat.finish("dm", "## Ergebnis\n\n**fett** und <b>kein HTML</b>\n\n- Punkt\u001b[2J");
    const r = await output;
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("… Durchsucht das Web …");
    expect(r.stdout).toContain("Ergebnis\n--------");
    expect(r.stdout).toContain("fett und <b>kein HTML</b>");
    expect(r.stdout).toContain("- Punkt");
    expect(r.stdout).not.toContain("\u001b");
  });

  test("Beenden nach EOF schließt die Live-Verbindung ohne AbortError: Exit 0, Antwort genau einmal (Issue #210)", async () => {
    const s = await server();
    const { proc, output } = spawn(["--topic", "dm"], s.dir, await newHome());
    await waitFor(() => s.server.eventStreamCount() >= 1, 5000, "Live-Verbindung von tybo");
    proc.stdin.write("Frage vor dem Ende\n");
    proc.stdin.end();
    await s.telegramChat.turn("dm");
    // EOF ist schon da, die Antwort kommt erst danach über die offene Live-Verbindung
    await new Promise(r => setTimeout(r, 200));
    s.telegramChat.finish("dm", "Antwort nach dem Ende der Eingabe");
    const r = await output;
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.split("Antwort nach dem Ende der Eingabe").length - 1).toBe(1);
    await waitFor(() => s.server.eventStreamCount() === 0, 3000, "Live-Verbindung am Server geschlossen");
  });

  test("mehrzeilig mit \\ am Zeilenende", async () => {
    const s = await server();
    const { proc, output } = spawn(["--topic", "dm"], s.dir, await newHome());
    proc.stdin.write("erste Zeile\\\nzweite Zeile\n");
    proc.stdin.end();
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.text).toBe("erste Zeile\nzweite Zeile");
    s.telegramChat.finish("dm", "ok");
    expect((await output).code).toBe(0);
  });
});

/** tybo an einem echten Pseudo-Terminal (TTY an Ein- und Ausgabe); output: alles, was im Terminal ankam */
function spawnTty(args: string[], root: string, home: string, extraEnv: Record<string, string>) {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const proc = Bun.spawn(["bun", "--no-env-file", SCRIPT, ...args], {
    cwd: base,
    env: { PATH: process.env.PATH ?? "", HOME: home, TYBO_ROOT: root, TZ: "Europe/Berlin", ...extraEnv },
    terminal: { cols: 100, rows: 30, data: (_t, data) => chunks.push(decoder.decode(data, { stream: true })) },
  });
  return { proc, output: () => chunks.join("") };
}

describe("an einem echten Terminal (TTY)", () => {
  for (const [name, env] of [
    ["NO_COLOR", { NO_COLOR: "1", TERM: "xterm-256color" }],
    ["TERM=dumb", { TERM: "dumb" }],
  ] as const) {
    test(`${name}: keine Escape-Sequenz von Start bis Exit, auch nicht beim Aufräumen`, async () => {
      const s = await server();
      const { proc, output } = spawnTty(["--topic", "dm"], s.dir, await newHome(), env);
      await waitFor(() => s.server.eventStreamCount() >= 1, 5000, "Live-Verbindung von tybo");
      proc.terminal!.write("Frage am Terminal\n");
      const turn = await s.telegramChat.turn("dm");
      expect(turn.opts.text).toBe("Frage am Terminal");
      s.telegramChat.finish("dm", "**Antwort** am Terminal");
      await waitFor(() => output().includes("Antwort am Terminal"), 5000, "Antwort");
      // Strg+D am Zeilenanfang: Ende der Eingabe
      proc.terminal!.write("\u0004");
      expect(await proc.exited).toBe(0);
      await new Promise(r => setTimeout(r, 50));
      proc.terminal!.close();
      expect(output().split("\r\n")[0]).toBe("tybo · Direktchat · Agent General");
      expect(output()).not.toContain("\u001b");
    });
  }

  test("Vollmodus: Bracketed Paste wird genau einmal wieder ausgeschaltet", async () => {
    const s = await server();
    const { proc, output } = spawnTty(["--topic", "dm"], s.dir, await newHome(), { TERM: "xterm-256color" });
    await waitFor(() => output().includes("\u001b[?2004h"), 5000, "Raw-Modus");
    proc.terminal!.write("\u0004");
    expect(await proc.exited).toBe(0);
    await new Promise(r => setTimeout(r, 50));
    proc.terminal!.close();
    expect(output().split("\u001b[?2004h")).toHaveLength(2);
    expect(output().split("\u001b[?2004l")).toHaveLength(2);
    expect(output()).not.toContain("\u001b[?25h");
  });
});

describe("--dev gegen web:dev", () => {
  test("nutzt data/web-dev/cli-token und TYBO_DEV_PORT, nie die .env oder data/cli-token", async () => {
    const s = await server();
    const root = join(base, `dev-root-${++counter}`);
    await mkdir(join(root, "data", "web-dev"), { recursive: true });
    // .env mit falschem Port und falschem Schlüssel des „Bots": dürfen keine Rolle spielen
    await writeFile(join(root, ".env"), "WEB_ENABLED=true\nWEB_PASSWORD=falsches-passwort-123\nWEB_PORT=1\n");
    await writeFile(join(root, "data", "cli-token"), "C".repeat(43));
    await writeFile(join(root, "data", "web-dev", "cli-token"), await Bun.file(s.tokenFile).text());
    const home = await newHome();
    const r = await run(["--dev", "--topic", "General"], root, home, "", { TYBO_DEV_PORT: new URL(s.base).port });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("tybo · General · Agent General");
    // Eigener Zustand für web:dev, der echte bleibt unberührt
    expect(await Bun.file(join(home, ".config", "tybo", "state-dev.json")).exists()).toBe(true);
    expect(await Bun.file(join(home, ".config", "tybo", "state.json")).exists()).toBe(false);
  });

  test("web:dev läuft nicht: Startbefehl für web:dev, nicht für den Bot", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = String(probe.port);
    probe.stop(true);
    const r = await run(["--dev"], join(base, "leer"), await newHome(), "", { TYBO_DEV_PORT: port });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`web:dev läuft nicht unter http://127.0.0.1:${port}`);
    expect(r.stderr).toContain("bun run web:dev");
  });
});
