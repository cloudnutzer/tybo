/**
 * Issue #66: Lebenszyklus des Einrichtungsmodus (src/setup/web-mode.ts) und
 * `tybo setup --web`. Ohne Token startet der Assistent statt eines Exits und
 * läuft, bis „Fertig“ oder Strg+C kommt. Supervisor und Befehle sind
 * Attrappen: kein launchctl, kein PM2, kein Bot-Start, kein Neustart-Marker.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTybo } from "../scripts/tybo";
import { PROJECT_ROOT } from "../src/setup/context";
import { chooseStartMode } from "../src/setup/start-mode";
import { runSetupMode, setupPort, startCommandFor, type SetupModeOptions } from "../src/setup/web-mode";
import { formatSetupCode } from "../src/setup/web-server";
import { cleanup, FULL_ENV, fakeRun, makeCtx, root as tmpRoot } from "./setup-fixture";
import { CODE, PROFILE, type TestCtx } from "./setup-web-fixture";

afterAll(cleanup);

/** Startet runSetupMode im Hintergrund; ready liefert Adresse und Code */
function launch(ctx: TestCtx, options: Partial<SetupModeOptions> = {}) {
  const logs: string[] = [];
  let interrupt: () => void = () => {};
  let readyResolve!: (info: { url: string; code: string }) => void;
  const ready = new Promise<{ url: string; code: string }>(r => (readyResolve = r));
  const done = runSetupMode({
    root: ctx.root,
    env: {},
    startMode: { mode: "setup", reason: "missing", missing: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"], message: "Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends." },
    supervisor: async () => null,
    ctx,
    code: CODE,
    port: 0,
    graceMs: 20,
    log: line => logs.push(line),
    onInterrupt: handler => {
      interrupt = handler;
      return () => {};
    },
    onReady: readyResolve,
    ...options,
  });
  return { logs, ready, done, interrupt: () => interrupt() };
}

async function session(url: string): Promise<string> {
  const res = await fetch(`${url}/api/setup/code`, { method: "POST", headers: { Origin: url }, body: JSON.stringify({ code: CODE }) });
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function finish(url: string, cookie: string, body: unknown = {}) {
  const res = await fetch(`${url}/api/setup/finish`, { method: "POST", headers: { Origin: url, Cookie: cookie }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as any };
}

describe("Start ohne Token", () => {
  test("Einrichtungsmodus statt Exit: Server läuft, Adresse und Code im Log, bis Strg+C", async () => {
    const ctx = await makeCtx({ env: "# leer\n" });
    const startMode = chooseStartMode({});
    expect(startMode.mode).toBe("setup");
    const run = launch(ctx, { startMode: startMode as any });
    const { url } = await run.ready;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${url}/code`)).status).toBe(200);
    const text = run.logs.join("\n");
    expect(text).toContain("Einrichtungsmodus: Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends.");
    expect(text).toContain(`Im Browser auf diesem Rechner öffnen: ${url}`);
    expect(text).toContain(`Einmal-Code: ${formatSetupCode(CODE)}`);
    // Läuft weiter, bis jemand abbricht
    expect(await Promise.race([run.done, Bun.sleep(50).then(() => "läuft")])).toBe("läuft");
    run.interrupt();
    expect(await run.done).toBe(130);
    await expect(fetch(`${url}/code`)).rejects.toThrow();
    // Kein Telegram, kein Claude: keine Anbieter-Aufrufe ohne Anfrage aus dem Browser
    expect(ctx.providers.calls).toEqual([]);
  });

  test("Issue #228: halbes Telegram und ungültige WebUI zeigen den echten Grund im Log", async () => {
    for (const [env, expected] of [
      [{ TELEGRAM_BOT_TOKEN: "123:abc" }, "Einrichtungsmodus: Telegram halb eingerichtet: TELEGRAM_BOT_TOKEN ist gesetzt, TELEGRAM_USER_ID fehlt."],
      [{ WEB_ENABLED: "true", WEB_PASSWORD: "kurz" }, "WebUI falsch eingerichtet: WEB_PASSWORD ist kürzer als 12 Zeichen."],
    ] as const) {
      const ctx = await makeCtx({ env: "# leer\n" });
      const startMode = chooseStartMode(env);
      expect(startMode.mode).toBe("setup");
      const run = launch(ctx, { startMode: startMode as any });
      await run.ready;
      expect(run.logs.join("\n")).toContain(expected);
      run.interrupt();
      expect(await run.done).toBe(130);
    }
  });

  test("WEB_HOST=0.0.0.0 ändert nichts: nur 127.0.0.1; WEB_PORT wird genutzt, ungültig heißt 3100", () => {
    expect(setupPort({ WEB_PORT: "3456", WEB_HOST: "0.0.0.0" })).toEqual({ port: 3456 });
    expect(setupPort({})).toEqual({ port: 3100 });
    expect(setupPort({ WEB_PORT: "abc" }).port).toBe(3100);
    expect(setupPort({ WEB_PORT: "70000" }).note).toContain("kein gültiger Port");
  });

  test("Startbefehl quotiert den Projektpfad: Leerzeichen, Apostroph, Shell-Zeichen (Start-Attrappe)", async () => {
    // Attrappe statt bun: schreibt nur Ordner und Argumente in eine Datei
    const bin = join(tmpRoot, "fake-bin");
    const out = join(tmpRoot, "start-attrappe.txt");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "bun"), `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd -P)" "$*" > '${out}'\n`);
    await chmod(join(bin, "bun"), 0o755);
    const shells = ["/bin/sh", "/bin/zsh", "/bin/bash"].filter(sh => Bun.file(sh).size > 0);
    const names = ["Meine Projekte/tybo", "Alex' Ordner/tybo", "a'b'c", "x $(touch gefahr) `touch gefahr2`; & * | \"q\" $HOME"];
    for (const name of names) {
      const dir = join(tmpRoot, "pfade", name);
      await mkdir(dir, { recursive: true });
      const command = startCommandFor(dir);
      expect(command.endsWith(" && bun run start")).toBe(true);
      for (const sh of shells) {
        const proc = Bun.spawnSync([sh, "-c", command], { cwd: tmpRoot, env: { PATH: `${bin}:/usr/bin:/bin` } });
        expect(proc.exitCode).toBe(0);
        expect(await readFile(out, "utf8")).toBe(`${await realpath(dir)}|run start\n`);
      }
    }
    for (const where of [tmpRoot, join(tmpRoot, "pfade")]) {
      expect(await readdir(where)).not.toContain("gefahr");
      expect(await readdir(where)).not.toContain("gefahr2");
    }
    expect(startCommandFor("/Users/a b/tybo")).toBe("cd '/Users/a b/tybo' && bun run start");
    expect(startCommandFor("/Users/o'neil/tybo")).toBe("cd '/Users/o'\\''neil/tybo' && bun run start");
  });

  test("Port belegt: Exit 1 mit verständlicher Meldung", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    try {
      const ctx = await makeCtx({ env: "" });
      const run = launch(ctx, { port: blocker.port });
      expect(await run.done).toBe(1);
      expect(run.logs.join("\n")).toContain(`Einrichtungsmodus startet nicht auf 127.0.0.1:${blocker.port}`);
    } finally {
      blocker.stop(true);
    }
  });
});

describe("„Fertig“", () => {
  test("Pflichtschritte fehlen: 409 mit Liste, Code bleibt gültig", async () => {
    const ctx = await makeCtx({ env: "" });
    const run = launch(ctx);
    const { url } = await run.ready;
    const cookie = await session(url);
    const r = await finish(url, cookie);
    expect(r.status).toBe(409);
    // Telegram ist seit Issue #228 optional; dafür gilt die Kanalregel
    expect(r.data.missing).toEqual(["Datenbank", "Profil"]);
    expect(r.data.error).toBe("Vor „Fertig“ fehlt noch: Datenbank, Profil. Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends.");
    expect((await fetch(`${url}/api/setup/overview`, { headers: { Cookie: cookie } })).status).toBe(200);
    run.interrupt();
    expect(await run.done).toBe(130);
  });

  test("unter launchd: Neustart über den Supervisor, Exit 0, kein Autostart, kein Neustart-Marker", async () => {
    const ctx = await makeCtx({ env: FULL_ENV, profile: PROFILE });
    const run = launch(ctx, { supervisor: async () => "launchd" });
    const { url } = await run.ready;
    const r = await finish(url, await session(url), { autostart: true });
    expect(r.status).toBe(200);
    expect(r.data.plan).toBe("restart");
    expect(r.data.message).toContain("startet jetzt neu (launchd)");
    expect(await run.done).toBe(0);
    expect(run.logs.join("\n")).toContain("launchd startet tybo neu");
    expect(ctx.run.calls.filter(c => c[0] === "launchctl" && c[1] === "load")).toEqual([]);
    expect(await readdir(ctx.root)).not.toContain("data");
  });

  test("unter PM2 ebenso", async () => {
    const ctx = await makeCtx({ env: FULL_ENV, profile: PROFILE });
    const run = launch(ctx, { supervisor: async () => "pm2" });
    const { url } = await run.ready;
    const r = await finish(url, await session(url));
    expect(r.data.plan).toBe("restart");
    expect(await run.done).toBe(0);
  });

  test("ohne Supervisor, ohne Autostart: Startbefehl in Antwort und Log, Exit 0", async () => {
    const ctx = await makeCtx({ env: FULL_ENV, profile: PROFILE });
    const run = launch(ctx);
    const { url } = await run.ready;
    const r = await finish(url, await session(url), { autostart: false });
    expect(r.data).toEqual({
      ok: true,
      plan: "manual",
      message: "Alles gespeichert. tybo jetzt im Terminal starten:",
      command: startCommandFor(ctx.root),
    });
    expect(await run.done).toBe(0);
    expect(run.logs.join("\n")).toContain(`Starten mit: ${startCommandFor(ctx.root)}`);
    // Server ist zu, der Port frei für den Bot
    await expect(fetch(`${url}/code`)).rejects.toThrow();
  });

  test("ohne Supervisor, mit Autostart: erst nach dem Schließen des Servers eingerichtet (launchd-Attrappe)", async () => {
    const inner = fakeRun({
      "git --version": { stdout: "git version 2.50.0" },
      "which bun": { stdout: "/opt/bun/bin/bun" },
      "which claude": { stdout: "/Users/test/.local/bin/claude" },
      "launchctl list": { stdout: "" },
      "launchctl load": {},
    });
    // Beim Laden des Diensts: ist der Einrichtungs-Server noch erreichbar?
    let serverUrl = "";
    const serverUpAtLoad: boolean[] = [];
    const run = (async (cmd: string[], options?: any) => {
      if (cmd[0] === "launchctl" && cmd[1] === "load") {
        serverUpAtLoad.push(await fetch(`${serverUrl}/code`, { headers: { Connection: "close" } }).then(() => true, () => false));
      }
      return inner(cmd, options);
    }) as typeof inner;
    run.calls = inner.calls;
    const ctx = await makeCtx({ env: FULL_ENV, profile: PROFILE, overrides: { run } });
    await copyFile(join(PROJECT_ROOT, "launchd", "ai.tybo.telegram-relay.plist.template"), join(ctx.root, "launchd", "ai.tybo.telegram-relay.plist.template"));
    const mode = launch(ctx);
    const { url } = await mode.ready;
    serverUrl = url;
    const cookie = await session(url);
    // Speichern im Schritt Autostart schreibt nie, das passiert erst bei „Fertig“
    const early = await fetch(`${url}/api/setup/steps/autostart/apply`, { method: "POST", headers: { Origin: url, Cookie: cookie }, body: "{}" });
    expect(early.status).toBe(409);
    expect(run.calls.some(c => c[0] === "launchctl" && c[1] === "load")).toBe(false);

    const r = await finish(url, cookie, { autostart: true });
    expect(r.data.plan).toBe("autostart");
    expect(await mode.done).toBe(0);
    // Geladen erst, als der Server schon zu war (Port frei für den Bot)
    expect(serverUpAtLoad).toEqual([false]);
    const plist = join(ctx.launchAgentsDir, "ai.tybo.telegram-relay.plist");
    expect(run.calls.filter(c => c[0] === "launchctl" && c[1] === "load")).toEqual([["launchctl", "load", plist]]);
    expect(mode.logs.join("\n")).toContain("Autostart eingerichtet");
  });

  test("Autostart gewünscht, aber nicht einrichtbar: 409, nichts abgeschlossen", async () => {
    const ctx = await makeCtx({ env: FULL_ENV, profile: PROFILE, overrides: { run: fakeRun({ "git --version": { stdout: "git version 2.50.0" }, "launchctl list": { stdout: "" } }) } });
    const run = launch(ctx);
    const { url } = await run.ready;
    const cookie = await session(url);
    const r = await finish(url, cookie, { autostart: true });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("Autostart lässt sich nicht einrichten");
    expect((await fetch(`${url}/api/setup/overview`, { headers: { Cookie: cookie } })).status).toBe(200);
    run.interrupt();
    expect(await run.done).toBe(130);
  });

  test("zweites „Fertig“ gleichzeitig: nur eines gilt", async () => {
    const ctx = await makeCtx({ env: FULL_ENV, profile: PROFILE });
    const run = launch(ctx, { graceMs: 100 });
    const { url } = await run.ready;
    const cookie = await session(url);
    const results = await Promise.all([finish(url, cookie), finish(url, cookie)]);
    const ok = results.filter(r => r.status === 200);
    expect(ok).toHaveLength(1);
    // Die zweite Anfrage sieht je nach Reihenfolge noch die Sitzung (409 aus der
    // Warteschlange) oder schon die abgeschlossene Einrichtung (401, finished)
    const other = results.find(r => r !== ok[0])!;
    if (other.status === 401) expect(other.data.finished).toBe(true);
    else expect(other.status).toBe(409);
    expect(run.logs.filter(l => l.includes("Einrichtung abgeschlossen"))).toHaveLength(1);
    expect(await run.done).toBe(0);
  });
});

describe("tybo setup --web", () => {
  test("startet den Einrichtungsmodus aus tybo, auch bei vollständiger .env; Code im Terminal", async () => {
    const ctx = await makeCtx({ env: FULL_ENV, profile: PROFILE });
    const out: string[] = [];
    let interrupt: () => void = () => {};
    let ready!: (info: { url: string }) => void;
    const started = new Promise<{ url: string }>(r => (ready = r));
    const code = runTybo({
      args: ["setup", "--web"],
      env: {},
      root: ctx.root,
      out: line => out.push(line),
      err: line => out.push(line),
      setup: {
        ctx,
        web: { code: CODE, port: 0, graceMs: 20, onReady: ready, onInterrupt: h => ((interrupt = h), () => {}) },
      },
    });
    const { url } = await started;
    expect(out.join("\n")).toContain("tybo setup --web: Einrichtung im Browser.");
    expect(out.join("\n")).toContain(`Einmal-Code: ${formatSetupCode(CODE)}`);
    const r = await finish(url, await session(url));
    // tybo läuft nie unter launchd oder PM2
    expect(r.data.plan).toBe("manual");
    expect(await code).toBe(0);
    void interrupt;
  });

  test("läuft schon ein Bot (bot.lock), startet nichts", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    await Bun.write(join(ctx.root, "bot.lock"), String(process.pid));
    const err: string[] = [];
    const code = await runTybo({ args: ["setup", "--web"], env: {}, root: ctx.root, out: () => {}, err: line => err.push(line), setup: { ctx, web: { port: 0 } } });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("tybo läuft schon. Einrichtung im Terminal mit: tybo setup");
  });
});
