/**
 * Issue #64, Checkbox 4: Schritte voraussetzungen, autostart und pruefung.
 * Befehle sind Attrappen: kein launchctl, kein PM2, kein Claude-Aufruf.
 * Dienstdateien landen nur in temporären Ordnern.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../src/setup/context";
import { createProviders } from "../src/setup/providers";
import { checkStep } from "../src/setup/steps";
import { autostartStep, PM2_INSTALL } from "../src/setup/steps/autostart";
import { CLAUDE_INSTALL, MIN_BUN_VERSION, prerequisitesStep, versionAtLeast } from "../src/setup/steps/prerequisites";
import { backupsOf, cleanup, FAKE, FULL_ENV, fakeRun, leakedSecrets, makeCtx, root } from "./setup-fixture";

afterAll(cleanup);

// ---------------------------------------------------------------------------
// Importsicherheit der alten Skripte
// ---------------------------------------------------------------------------

describe("setup/configure-*.ts sind importsicher", () => {
  test("Import startet nichts und beendet den Prozess nicht", async () => {
    const launchd = await import("../setup/configure-launchd");
    const services = await import("../setup/configure-services");
    expect(typeof launchd.configureService).toBe("function");
    expect(typeof services.configurePM2Service).toBe("function");
    expect(launchd.SERVICES).toContain("cloudflare-tunnel");
  });
});

// ---------------------------------------------------------------------------
// Voraussetzungen
// ---------------------------------------------------------------------------

describe("Schritt voraussetzungen", () => {
  test("Mindestversion wie package.json", async () => {
    const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
    expect(versionAtLeast("1.3.10", "1.3.10")).toBe(true);
    expect(versionAtLeast("1.4.0", "1.3.10")).toBe(true);
    expect(versionAtLeast("1.3.9", "1.3.10")).toBe(false);
    expect(versionAtLeast("1.2.99", "1.3.10")).toBe(false);
  });

  test("alles da: erledigt", async () => {
    const s = await prerequisitesStep.status(await makeCtx());
    expect(s.state).toBe("erledigt");
    expect(s.items?.map(i => i.label)).toEqual(["Bun", "Claude CLI", "Git"]);
  });

  test("leere Maschine: Anleitung statt Installation", async () => {
    const ctx = await makeCtx({ overrides: { bunVersion: "1.2.0", platform: "linux", run: fakeRun() } });
    ctx.providers.results.claudeVersion = { ok: false, message: "Claude CLI nicht gefunden." };
    const s = await prerequisitesStep.status(ctx);
    expect(s.state).toBe("fehlt");
    expect(s.detail).toBe("Fehlt oder zu alt: Bun, Claude CLI, Git.");
    expect(s.items?.map(i => i.fix)).toEqual(["bun upgrade", CLAUDE_INSTALL, "sudo apt install git"]);
    // Nur Prüfbefehle, keine Installation
    expect(ctx.run.calls).toEqual([["git", "--version"]]);
  });

  test("Git-Anleitung je Plattform", async () => {
    for (const [platform, fix] of [
      ["darwin", "xcode-select --install"],
      ["win32", "winget install Git.Git"],
    ] as const) {
      const ctx = await makeCtx({ overrides: { platform, run: fakeRun() } });
      const s = await prerequisitesStep.status(ctx);
      expect(s.state).toBe("teilweise");
      expect(s.items?.find(i => i.label === "Git")?.fix).toBe(fix);
    }
  });

  test("CLAUDE_PATH aus .env wird genutzt", async () => {
    const ctx = await makeCtx({ env: "CLAUDE_PATH=/opt/claude/bin/claude\n" });
    await prerequisitesStep.test!({}, ctx);
    expect(ctx.providers.calls.map(c => [c.method, c.args[0]])).toEqual([
      ["claudeVersion", "/opt/claude/bin/claude"],
      ["claudeProbe", "/opt/claude/bin/claude"],
    ]);
  });

  test("Test Erfolg: angemeldet", async () => {
    const r = await prerequisitesStep.test!({}, await makeCtx());
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Alles da, Claude CLI ist angemeldet.");
  });

  test("Test Fehler: nicht angemeldet, mit Anleitung", async () => {
    const ctx = await makeCtx();
    ctx.providers.results.claudeProbe = { ok: false, message: "Claude CLI ist nicht angemeldet. Im Terminal „claude“ starten und /login ausführen." };
    const r = await prerequisitesStep.test!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("/login");
  });

  test("ohne Claude CLI kein Probeaufruf", async () => {
    const ctx = await makeCtx();
    ctx.providers.results.claudeVersion = { ok: false, message: "Claude CLI nicht gefunden." };
    const r = await prerequisitesStep.test!({}, ctx);
    expect(r.ok).toBe(false);
    expect(ctx.providers.calls.map(c => c.method)).toEqual(["claudeVersion"]);
  });

  test("Versionsausgaben mit Geheimnissen: nur die Versionsnummer kommt durch", async () => {
    const ctx = await makeCtx({
      overrides: { run: fakeRun({ "git --version": { stdout: `git version 2.50.0 token=${FAKE.token} ${FAKE.openrouterKey}` } }) },
    });
    const s = await prerequisitesStep.status(ctx);
    expect(s.items?.find(i => i.label === "Git")?.detail).toBe("Git 2.50.0");
    expect(leakedSecrets(s)).toEqual([]);
    const noVersion = await makeCtx({ overrides: { run: fakeRun({ "git --version": { stdout: `wrapper ${FAKE.webPassword}` } }) } });
    const s2 = await prerequisitesStep.status(noVersion);
    expect(s2.items?.find(i => i.label === "Git")?.detail).toBe("Git gefunden.");
    expect(leakedSecrets(s2)).toEqual([]);
  });

  test("schreibt nichts", async () => {
    const ctx = await makeCtx();
    await prerequisitesStep.status(ctx);
    await prerequisitesStep.test!({}, ctx);
    expect(prerequisitesStep.apply).toBeUndefined();
    expect(await Bun.file(ctx.envPath).exists()).toBe(false);
  });
});

describe("Claude-Port", () => {
  const probe = (answer: Record<string, unknown>) => {
    const run = fakeRun({ "claude -p": answer });
    const envs: unknown[] = [];
    const wrapped = (async (cmd: string[], options?: { env?: Record<string, string> }) => {
      envs.push(options?.env);
      return run(cmd);
    }) as typeof run;
    const providers = createProviders({
      fetch: async () => new Response(""),
      run: wrapped,
      subprocessEnv: () => ({ PATH: "/usr/bin", TYBO_SUBPROCESS: "1" }),
    });
    return { providers, run, envs };
  };

  test("Erfolg mit Zeitlimit und gefilterter Umgebung", async () => {
    const { providers, run, envs } = probe({ stdout: JSON.stringify({ is_error: false, result: "OK" }) });
    expect(await providers.claudeProbe("claude")).toEqual({ ok: true, message: "Claude CLI ist angemeldet und antwortet." });
    expect(run.calls[0].slice(0, 3)).toEqual(["claude", "-p", "Antworte nur mit OK"]);
    expect(envs[0]).toEqual({ PATH: "/usr/bin", TYBO_SUBPROCESS: "1" });
  });

  test("nicht angemeldet, Zeitlimit, Limit erreicht", async () => {
    const notLoggedIn = probe({ code: 1, stdout: JSON.stringify({ is_error: true, result: "Invalid API key · Please run /login" }) });
    expect((await notLoggedIn.providers.claudeProbe("claude")).message).toContain("nicht angemeldet");
    const slow = probe({ code: -1, timedOut: true });
    expect((await slow.providers.claudeProbe("claude")).message).toContain("Zeitlimit");
    const limit = probe({ code: 1, stdout: JSON.stringify({ is_error: true, result: "Usage limit reached" }) });
    expect((await limit.providers.claudeProbe("claude")).message).toContain("Nutzungslimit");
  });

  test("rohe Ausgaben landen nicht in der Meldung", async () => {
    const leaky = probe({ code: 1, stderr: `boom ${FAKE.openrouterKey}` });
    const r = await leaky.providers.claudeProbe("claude");
    expect(r.ok).toBe(false);
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("Version", async () => {
    const found = createProviders({ fetch: async () => new Response(""), run: fakeRun({ "claude --version": { stdout: "2.1.300 (Claude Code)" } }) });
    expect(await found.claudeVersion("claude")).toEqual({ ok: true, message: "Claude CLI 2.1.300" });
    const missing = createProviders({ fetch: async () => new Response(""), run: fakeRun() });
    expect((await missing.claudeVersion("claude")).ok).toBe(false);
  });

  test("Version: Geheimnisse in der Ausgabe werden vollständig unterdrückt", async () => {
    const leaky = createProviders({
      fetch: async () => new Response(""),
      run: fakeRun({ "claude --version": { stdout: `2.1.300 (Claude Code) ANTHROPIC_API_KEY=${FAKE.openrouterKey} ${FAKE.token}` } }),
    });
    const r = await leaky.claudeVersion("claude");
    expect(r).toEqual({ ok: true, message: "Claude CLI 2.1.300" });
    expect(leakedSecrets(r)).toEqual([]);
    const noVersion = createProviders({ fetch: async () => new Response(""), run: fakeRun({ "claude --version": { stdout: `Fehler ${FAKE.convexToken}` } }) });
    const r2 = await noVersion.claudeVersion("claude");
    expect(r2).toEqual({ ok: true, message: "Claude CLI gefunden." });
    expect(leakedSecrets(r2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Autostart
// ---------------------------------------------------------------------------

async function withTemplate(ctx: { root: string }) {
  await copyFile(join(PROJECT_ROOT, "launchd", "ai.tybo.telegram-relay.plist.template"), join(ctx.root, "launchd", "ai.tybo.telegram-relay.plist.template"));
}

const LOADED = { stdout: "123\t0\tai.tybo.telegram-relay" };

const MAC_COMMANDS = {
  "which bun": { stdout: "/opt/bun/bin/bun" },
  "which claude": { stdout: "/Users/test/.local/bin/claude" },
  "launchctl load": {},
  "launchctl list": LOADED,
};

async function writePlist(ctx: { launchAgentsDir: string }, content = "<plist/>") {
  await mkdir(ctx.launchAgentsDir, { recursive: true });
  const plist = join(ctx.launchAgentsDir, "ai.tybo.telegram-relay.plist");
  await writeFile(plist, content);
  return plist;
}

describe("Schritt autostart (macOS)", () => {
  test("Status: leer, geladen, nur Datei, Zustand unbekannt", async () => {
    const ctx = await makeCtx({ overrides: { run: fakeRun({ "launchctl list": LOADED }) } });
    expect((await autostartStep.status(ctx)).state).toBe("fehlt");
    expect(ctx.run.calls).toEqual([]);
    await writePlist(ctx);
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
    expect(ctx.run.calls).toEqual([["launchctl", "list"]]);

    const fileOnly = await makeCtx({ overrides: { run: fakeRun({ "launchctl list": { stdout: "1\t0\tai.tybo.telegram-relay-alt\n2\t0\tcom.apple.x" } }) } });
    await writePlist(fileOnly);
    const s = await autostartStep.status(fileOnly);
    expect(s.state).toBe("teilweise");
    expect(s.detail).toContain("nicht geladen");

    const unknown = await makeCtx({ overrides: { run: fakeRun({ "launchctl list": { code: 1 } }) } });
    await writePlist(unknown);
    expect((await autostartStep.status(unknown)).state).toBe("teilweise");
  });

  test("Einrichten: nur der Bot, Plist im temporären LaunchAgents-Ordner", async () => {
    const ctx = await makeCtx({ overrides: { run: fakeRun(MAC_COMMANDS) } });
    await withTemplate(ctx);
    const r = await autostartStep.apply!({}, ctx);
    const plist = join(ctx.launchAgentsDir, "ai.tybo.telegram-relay.plist");
    expect(r).toEqual({ ok: true, message: "Autostart eingerichtet: tybo läuft jetzt und startet mit dem Rechner.", changed: [plist] });
    expect(await readdir(ctx.launchAgentsDir)).toEqual(["ai.tybo.telegram-relay.plist"]);
    const content = await readFile(plist, "utf8");
    expect(content).toContain(`<string>${ctx.root}</string>`);
    expect(content).toContain("/opt/bun/bin/bun");
    expect(content).toContain("/Users/test/.local/bin");
    expect(content).not.toContain("{{");
    const launchctl = ctx.run.calls.filter(c => c[0] === "launchctl");
    expect(launchctl).toEqual([["launchctl", "load", plist], ["launchctl", "list"]]);
    expect(ctx.run.calls.flat().join(" ")).not.toMatch(/cloudflare|smart-checkin|morning-briefing|watchdog|whatsapp/);
  });

  test("schon geladen: nichts entladen, nichts überschreiben", async () => {
    const ctx = await makeCtx({ overrides: { run: fakeRun(MAC_COMMANDS) } });
    await withTemplate(ctx);
    const plist = await writePlist(ctx, "<plist>eigene Fassung</plist>");
    const r = await autostartStep.apply!({}, ctx);
    expect(r).toEqual({ ok: true, message: "Autostart ist schon eingerichtet, nichts geändert.", changed: [] });
    expect(await readFile(plist, "utf8")).toBe("<plist>eigene Fassung</plist>");
    expect(ctx.run.calls).toEqual([["launchctl", "list"]]);
  });

  test("Laden scheitert: feste Meldung ohne stderr, danach erneuter Ladeversuch", async () => {
    const answers: Parameters<typeof fakeRun>[0] = {
      ...MAC_COMMANDS,
      "launchctl list": { stdout: "" },
      "launchctl load": { code: 1, stderr: `Load failed: 5: Input/output error TELEGRAM_BOT_TOKEN=${FAKE.token} ${FAKE.webPassword}` },
    };
    const ctx = await makeCtx({ overrides: { run: fakeRun(answers) } });
    await withTemplate(ctx);
    const plist = join(ctx.launchAgentsDir, "ai.tybo.telegram-relay.plist");

    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(
      "Autostart ließ sich nicht einrichten: launchctl konnte den Dienst nicht laden. Die Dienstdatei liegt da; ein erneuter Versuch lädt sie noch einmal.",
    );
    expect(leakedSecrets(r)).toEqual([]);
    expect(r.message).not.toContain("Input/output");
    const written = await readFile(plist, "utf8");

    // Liegengebliebene Plist gilt nicht als eingerichtet
    expect((await autostartStep.status(ctx)).state).toBe("teilweise");
    expect((await autostartStep.test!({}, ctx)).message).not.toBe("Autostart ist eingerichtet.");

    // Wiederholung mit weiter scheiterndem Laden: ehrlich, ohne Geheimnisse
    const again = await autostartStep.apply!({}, ctx);
    expect(again.ok).toBe(false);
    expect(leakedSecrets(again)).toEqual([]);

    // Wiederholung, jetzt klappt das Laden: nur laden, Datei bleibt
    answers["launchctl load"] = {};
    ctx.run.calls.length = 0;
    const ok = await autostartStep.apply!({}, ctx);
    expect(ok).toEqual({ ok: true, message: "Autostart eingerichtet: tybo läuft jetzt und startet mit dem Rechner.", changed: [plist] });
    expect(ctx.run.calls).toEqual([["launchctl", "list"], ["launchctl", "load", plist]]);
    expect(await readFile(plist, "utf8")).toBe(written);
    answers["launchctl list"] = LOADED;
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
  });

  test("Zustand unbekannt: nichts laden, nichts schreiben", async () => {
    const ctx = await makeCtx({ overrides: { run: fakeRun({ ...MAC_COMMANDS, "launchctl list": { code: 1, stderr: FAKE.token } }) } });
    await withTemplate(ctx);
    const plist = await writePlist(ctx, "<plist>eigene Fassung</plist>");
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([]);
    expect(leakedSecrets(r)).toEqual([]);
    expect(ctx.run.calls).toEqual([["launchctl", "list"]]);
    expect(await readFile(plist, "utf8")).toBe("<plist>eigene Fassung</plist>");
    expect((await autostartStep.test!({}, ctx)).ok).toBe(false);
  });

  test("Schreibfehler: verständliche Meldung, Wiederholung klappt danach", async () => {
    const ctx = await makeCtx({ overrides: { run: fakeRun({ ...MAC_COMMANDS, "launchctl list": { stdout: "" } }) } });
    await withTemplate(ctx);
    await mkdir(ctx.launchAgentsDir, { recursive: true });
    await chmod(ctx.launchAgentsDir, 0o500);
    try {
      const r = await autostartStep.apply!({}, ctx);
      expect(r).toEqual({ ok: false, message: "Autostart ließ sich nicht einrichten: die Dienstdatei konnte nicht geschrieben werden (EACCES).", changed: [] });
      expect(ctx.run.calls.some(c => c[0] === "launchctl")).toBe(false);
      expect((await autostartStep.status(ctx)).state).toBe("fehlt");
    } finally {
      await chmod(ctx.launchAgentsDir, 0o700);
    }
    const ok = await autostartStep.apply!({}, ctx);
    expect(ok.ok).toBe(true);
    expect(await readdir(ctx.launchAgentsDir)).toEqual(["ai.tybo.telegram-relay.plist"]);
  });

  test("Fehler: Vorlage fehlt", async () => {
    const ctx = await makeCtx({ overrides: { run: fakeRun(MAC_COMMANDS) } });
    const t = await autostartStep.test!({}, ctx);
    expect(t.ok).toBe(false);
    expect(t.message).toContain("launchd-Vorlage fehlt");
    const r = await autostartStep.apply!({}, ctx);
    expect(r).toEqual({ ok: false, message: "Autostart ließ sich nicht einrichten: Die launchd-Vorlage fehlt im Projektordner.", changed: [] });
    expect(ctx.run.calls.some(c => c[0] === "launchctl")).toBe(false);
  });

  test("Test Erfolg mit Vorlage und Bun", async () => {
    const ctx = await makeCtx({ overrides: { run: fakeRun(MAC_COMMANDS) } });
    await withTemplate(ctx);
    expect((await autostartStep.test!({}, ctx)).ok).toBe(true);
  });
});

describe("Schritt autostart (Linux, PM2)", () => {
  const linux = (answers: Parameters<typeof fakeRun>[0]) => makeCtx({ overrides: { platform: "linux", run: fakeRun(answers) } });
  const pm2Ok = { "pm2 --version": { stdout: "6.0.0" }, "pm2 jlist": { stdout: "[]" }, "pm2 delete": { code: 1 }, "pm2 start": {}, "pm2 save": {} };
  const RUNNING = { stdout: JSON.stringify([{ name: "tybo-telegram-relay" }]) };
  /** Was ein erfolgreiches „pm2 save“ hinterlässt: der Bot in dump.pm2 */
  async function writeDump(ctx: { pm2DumpPath: string }) {
    await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
    await writeFile(ctx.pm2DumpPath, JSON.stringify([{ name: "tybo-telegram-relay", env: { SECRET: FAKE.token } }]));
  }

  test("PM2 fehlt: Anleitung, keine Installation, kein npx", async () => {
    const ctx = await linux({});
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("fehlt");
    expect(s.items?.[0].fix).toBe(PM2_INSTALL);
    const r = await autostartStep.apply!({}, ctx);
    expect(r).toEqual({ ok: false, message: `PM2 fehlt. Erst installieren mit: ${PM2_INSTALL}`, changed: [] });
    expect(ctx.run.calls.flat()).not.toContain("npx");
    expect(ctx.run.calls.flat()).not.toContain("npm");
  });

  test("Einrichten: nur tybo-telegram-relay, pm2 direkt, danach pm2 save", async () => {
    const ctx = await linux(pm2Ok);
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("pm2 startup");
    expect(r.changed).toEqual(["pm2:tybo-telegram-relay"]);
    const pm2 = ctx.run.calls.filter(c => c[0] === "pm2").map(c => c.slice(0, 4).join(" "));
    expect(pm2).toEqual(["pm2 --version", "pm2 jlist", "pm2 jlist", "pm2 start bun --name", "pm2 save"]);
    const start = ctx.run.calls.find(c => c[1] === "start")!;
    expect(start).toContain(join(ctx.root, "src/bot.ts"));
    expect(ctx.run.calls.flat()).not.toContain("npx");
  });

  test("Status erledigt und kein zweites Einrichten", async () => {
    const ctx = await linux({ "pm2 --version": { stdout: "6.0.0" }, "pm2 jlist": RUNNING });
    await writeDump(ctx);
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("erledigt");
    expect(leakedSecrets(s)).toEqual([]);
    const r = await autostartStep.apply!({}, ctx);
    expect(r.message).toBe("Autostart ist schon eingerichtet, nichts geändert.");
    expect(ctx.run.calls.some(c => c[1] === "start" || c[1] === "delete")).toBe(false);
  });

  for (const [name, jlist] of [
    ["jlist scheitert", { code: 1, stderr: `connect EACCES ${FAKE.token}` }],
    ["jlist unlesbar", { stdout: `[PM2] Spawning daemon ${FAKE.openrouterKey}\n[{"name":"tybo-telegram-relay"` }],
    ["jlist kein Array", { stdout: "{}" }],
  ] as const) {
    test(`Zustand unbekannt (${name}): nichts löschen, nichts starten`, async () => {
      const ctx = await linux({ ...pm2Ok, "pm2 jlist": jlist });
      const s = await autostartStep.status(ctx);
      expect(s.state).toBe("teilweise");
      const r = await autostartStep.apply!({}, ctx);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("pm2 jlist");
      expect(r.changed).toEqual([]);
      expect(ctx.run.calls.some(c => c[1] === "delete" || c[1] === "start" || c[1] === "save")).toBe(false);
      expect((await autostartStep.test!({}, ctx)).ok).toBe(false);
      expect(leakedSecrets([s, r])).toEqual([]);
    });
  }

  test("pm2 save scheitert: ehrliche Meldung, kein Erfolg", async () => {
    const ctx = await linux({ ...pm2Ok, "pm2 save": { code: 1, stderr: `EACCES ${FAKE.token}` } });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("„pm2 save“ ist gescheitert");
    expect(r.changed).toEqual(["pm2:tybo-telegram-relay"]);
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("pm2 save scheitert: Status und Test ehrlich, Wiederholung speichert nur, ohne Neustart", async () => {
    const answers: Parameters<typeof fakeRun>[0] = { ...pm2Ok, "pm2 save": { code: 1 } };
    const ctx = await linux(answers);
    const first = await autostartStep.apply!({}, ctx);
    expect(first.ok).toBe(false);
    expect(first.message).toContain("„pm2 save“ ist gescheitert");

    // Der Bot läuft jetzt unter PM2, steht aber nicht in dump.pm2
    answers["pm2 jlist"] = RUNNING;
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("teilweise");
    expect(s.detail).toContain("pm2 save");
    const t = await autostartStep.test!({}, ctx);
    expect(t.message).not.toBe("Autostart ist eingerichtet.");
    expect(t.items?.some(i => i.label === "PM2-Speicherung")).toBe(true);

    const calls = () => ctx.run.calls.splice(0).filter(c => c[0] === "pm2").map(c => c[1]);
    ctx.run.calls.splice(0);
    const second = await autostartStep.apply!({}, ctx);
    expect(second.ok).toBe(false);
    expect(second.message).toContain("„pm2 save“ ist gescheitert");
    expect(second.message).not.toBe("Autostart ist schon eingerichtet, nichts geändert.");
    expect(calls()).toEqual(["--version", "jlist", "save"]);

    answers["pm2 save"] = {};
    const third = await autostartStep.apply!({}, ctx);
    expect(third.ok).toBe(true);
    expect(third.changed).toEqual(["pm2:tybo-telegram-relay"]);
    expect(calls()).toEqual(["--version", "jlist", "save"]);

    await writeDump(ctx);
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
    expect((await autostartStep.apply!({}, ctx)).message).toBe("Autostart ist schon eingerichtet, nichts geändert.");
    expect(calls()).toEqual(["--version", "jlist", "--version", "jlist"]);
  });

  test("Abweichendes PM2_HOME: nur das Testziel zählt, externe Sicherung nie", async () => {
    const before = process.env.PM2_HOME;
    const external = join(root, "externes-pm2-home");
    await mkdir(external, { recursive: true });
    process.env.PM2_HOME = external;
    try {
      // Externe Sicherung enthält den Bot, das Testziel noch nicht: nicht gespeichert
      await writeFile(join(external, "dump.pm2"), JSON.stringify([{ name: "tybo-telegram-relay" }]));
      const ctx = await linux({ "pm2 --version": { stdout: "6.0.0" }, "pm2 jlist": RUNNING, "pm2 save": {} });
      expect(ctx.pm2DumpPath.startsWith(ctx.root)).toBe(true);
      expect((await autostartStep.status(ctx)).state).toBe("teilweise");
      expect((await autostartStep.apply!({}, ctx)).message).not.toBe("Autostart ist schon eingerichtet, nichts geändert.");

      // Externe Sicherung ohne Bot, Testziel mit Bot: gespeichert
      await writeFile(join(external, "dump.pm2"), "[]");
      await writeDump(ctx);
      expect((await autostartStep.status(ctx)).state).toBe("erledigt");
      expect((await autostartStep.apply!({}, ctx)).message).toBe("Autostart ist schon eingerichtet, nichts geändert.");
    } finally {
      if (before === undefined) delete process.env.PM2_HOME;
      else process.env.PM2_HOME = before;
    }
  });

  test("Start scheitert: feste Meldung ohne stderr, Wiederholung klappt danach", async () => {
    const answers: Parameters<typeof fakeRun>[0] = { ...pm2Ok, "pm2 start": { code: 1, stderr: `bun not found OPENROUTER_API_KEY=${FAKE.openrouterKey}` } };
    const ctx = await linux(answers);
    const r = await autostartStep.apply!({}, ctx);
    expect(r).toEqual({ ok: false, message: "Autostart ließ sich nicht einrichten: PM2 konnte den Bot nicht starten. Details mit: pm2 logs tybo-telegram-relay", changed: [] });
    expect(leakedSecrets(r)).toEqual([]);
    answers["pm2 start"] = {};
    const ok = await autostartStep.apply!({}, ctx);
    expect(ok.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gesamtprüfung
// ---------------------------------------------------------------------------

describe("Schritt pruefung", () => {
  async function fullCtx() {
    const run = fakeRun({ "git --version": { stdout: "git version 2.50.0" }, "launchctl list": LOADED });
    const ctx = await makeCtx({ env: FULL_ENV, profile: "# Testperson\n", overrides: { run } });
    await writePlist(ctx);
    return ctx;
  }

  test("leer: Test meldet fehlende Schritte, ohne Anbieter zu fragen", async () => {
    const ctx = await makeCtx();
    const r = await checkStep.test!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Es fehlt noch: Telegram, Datenbank, Profil, Autostart.");
    expect(ctx.providers.calls.map(c => c.method)).toEqual(["claudeVersion", "claudeVersion", "claudeProbe"]);
  });

  test("fertig: testet eingerichtete Schritte mit gespeicherten Werten, schreibt nichts", async () => {
    const ctx = await fullCtx();
    const r = await checkStep.test!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Alles eingerichtet und erreichbar.");
    const methods = ctx.providers.calls.map(c => c.method);
    expect(methods).toContain("telegramGetMe");
    expect(methods).toContain("telegramCheckGroup");
    expect(methods).toContain("convexQuery");
    expect(methods).toContain("openrouterKey");
    expect(ctx.providers.calls.find(c => c.method === "convexQuery")?.args).toEqual([FAKE.convexUrl, FAKE.convexToken]);
    expect(await readFile(ctx.envPath, "utf8")).toBe(FULL_ENV);
    expect(await backupsOf(ctx)).toEqual([]);
    expect(leakedSecrets(r)).toEqual([]);
    expect(checkStep.apply).toBeUndefined();
  });

  test("Fehler eines Anbieters wird benannt", async () => {
    const ctx = await fullCtx();
    ctx.providers.results.telegramGetMe = { ok: false, message: "Telegram lehnt das Token ab." };
    const r = await checkStep.test!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Fehlgeschlagen: Telegram.");
    expect(r.items?.find(i => i.label === "Telegram")?.detail).toBe("Telegram lehnt das Token ab.");
  });
});
