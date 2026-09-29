/**
 * Issue #207, Checkbox 2: systemd im Schritt autostart (tybo setup autostart,
 * Terminal und --web). systemctl, loginctl, which und PM2 sind Attrappen,
 * die Dienstdatei landet im Testordner; nichts startet echt.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SYSTEMD_UNIT } from "../setup/configure-systemd";
import type { SetupContext } from "../src/setup/context";
import { LOCAL_SUPABASE_URL } from "../src/setup/local-supabase";
import { autostartPlan, autostartStep, lingerFailed, lingerHint, SYSTEMD_UNREACHABLE } from "../src/setup/steps/autostart";
import { runSetupMode } from "../src/setup/web-mode";
import { cleanup, FAKE, FULL_ENV, leakedSecrets, makeCtx } from "./setup-fixture";
import { linuxCtx, started, systemdRun } from "./systemd-fixture";
import { runWith, scripted } from "./setup-terminal-fixture";
import { CODE, PROFILE } from "./setup-web-fixture";

afterAll(cleanup);


describe("Einrichten als systemd-Benutzerdienst", () => {
  test("Standard: Dienstdatei mit Restart=always und Claude-Pfad, dann systemctl --user enable --now", async () => {
    const ctx = await linuxCtx();
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.run.calls).toContain("systemctl --user enable --now tybo-telegram-relay");
    const unitPath = join(ctx.systemdUserDir, "tybo-telegram-relay.service");
    const unit = await readFile(unitPath, "utf8");
    expect(unit).toContain("\nRestart=always\n");
    expect(unit).toMatch(/\nEnvironment=PATH=[^\n]*:\/home\/alex\/\.local\/bin:/);
    expect(unit).toContain(`\nWorkingDirectory=${ctx.root}\n`);
    expect(unit).toContain(`\nStandardOutput=append:${ctx.root}/logs/telegram-relay.log\n`);
    expect(r.changed).toEqual([unitPath]);
    expect(r.message).toContain(`systemd-Benutzerdienst ${SYSTEMD_UNIT}`);
    // PM2 wird nur gefragt, ob dort schon ein Bot steht, nie gestartet
    expect(ctx.run.calls.some(c => c.startsWith("pm2 start") || c.startsWith("npx"))).toBe(false);
    expect(ctx.run.calls.some(c => c.includes("sudo"))).toBe(false);
  });

  test("ohne Linger und ohne Berechtigung: genau der Hinweis mit dem sudo-Befehl, Dienst läuft", async () => {
    const ctx = await linuxCtx({ linger: "no", lingerEnable: "denied" });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.running).toBe(true);
    expect(r.message).toContain(lingerHint("alex"));
    expect(r.message.split("sudo loginctl enable-linger alex")).toHaveLength(2);
    expect(ctx.run.calls).toContain("loginctl enable-linger alex");
    expect(ctx.run.calls.some(c => c.includes("sudo"))).toBe(false);
    expect(leakedSecrets(r)).toEqual([]);

    // Status nennt denselben Befehl; nach dem sudo-Befehl prüft ein zweiter Lauf nur noch
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("teilweise");
    expect(s.items?.[0].fix).toBe("sudo loginctl enable-linger alex");
    ctx.run.world.linger = "yes";
    ctx.run.calls.length = 0;
    const again = await autostartStep.apply!({}, ctx);
    expect(again).toEqual({ ok: true, message: "Autostart ist schon eingerichtet, nichts geändert.", changed: [] });
    expect(started(ctx.run)).toEqual([]);
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
  });

  test("Linger ohne sudo eingeschaltet (polkit): Erfolg, kein Hinweis", async () => {
    const ctx = await linuxCtx({ linger: "no", lingerEnable: "ok" });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Linger ist jetzt an");
    expect(r.message).not.toContain("sudo");
    expect(r.changed).toContain("linger:alex");
  });

  test("Linger: loginctl scheitert nicht an der Berechtigung: Prüfhinweis statt sudo", async () => {
    const ctx = await linuxCtx({ linger: "no", lingerEnable: "error" });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.running).toBe(true);
    expect(r.message).toContain(lingerFailed("alex"));
    expect(r.message).toContain("systemctl status systemd-logind");
    expect(r.message).not.toContain("sudo");
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("Status: Linger nicht lesbar: Prüfbefehl statt sudo", async () => {
    const ctx = await linuxCtx({ loaded: true, active: true, enabled: true, linger: "fail" }, { unit: true });
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("teilweise");
    expect(s.items?.[0].fix).toBe("loginctl show-user alex -p Linger");
  });

  test("Linger: lief durch, Nachprüfung scheitert: kein Erfolg, Prüfbefehl statt sudo", async () => {
    const ctx = await linuxCtx({ linger: "fail", lingerEnable: "noop" });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.running).toBe(true);
    expect(r.message).toContain("loginctl show-user alex -p Linger");
    expect(r.message).not.toContain("sudo");
  });

  test("laufender, aktivierter Dienst wird nicht neu gestartet", async () => {
    const ctx = await linuxCtx({ loaded: true, active: true, enabled: true }, { unit: true });
    const before = await readFile(join(ctx.systemdUserDir, "tybo-telegram-relay.service"), "utf8");
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
    const r = await autostartStep.apply!({}, ctx);
    expect(r).toEqual({ ok: true, message: "Autostart ist schon eingerichtet, nichts geändert.", changed: [] });
    expect(started(ctx.run)).toEqual([]);
    expect(await readFile(join(ctx.systemdUserDir, "tybo-telegram-relay.service"), "utf8")).toBe(before);
  });

  test("läuft, aber nicht aktiviert: nur enable ohne --now, kein Neustart", async () => {
    const ctx = await linuxCtx({ loaded: true, active: true, enabled: false }, { unit: true });
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("teilweise");
    expect(s.detail).toContain("nicht aktiviert");
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(started(ctx.run)).toEqual(["systemctl --user enable tybo-telegram-relay"]);
    expect(r.message).toContain("ohne Neustart");
  });

  test("Datei da, aber nicht geladen: daemon-reload und enable --now, Datei bleibt", async () => {
    const ctx = await linuxCtx({}, { unit: true });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(started(ctx.run)).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now tybo-telegram-relay"]);
    expect(await readFile(join(ctx.systemdUserDir, "tybo-telegram-relay.service"), "utf8")).toBe("[Service]\n");
  });

  test("enable scheitert: feste Meldung ohne Befehlsausgabe", async () => {
    const ctx = await linuxCtx();
    const inner = ctx.run;
    ctx.run = Object.assign(async (cmd: string[]) => (cmd.join(" ").startsWith("systemctl --user enable") ? { code: 1, stdout: "", stderr: `boom ${FAKE.token}` } : inner(cmd)), inner) as any;
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain(`systemctl --user status ${SYSTEMD_UNIT}`);
    expect(leakedSecrets(r)).toEqual([]);
  });
});

describe("Auswahl systemd oder PM2", () => {
  test("frischer Rechner: systemd vorgeschlagen, PM2 wählbar", async () => {
    const ctx = await linuxCtx();
    expect(await autostartPlan(ctx)).toEqual({ managers: ["systemd", "pm2"], default: "systemd" });
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("fehlt");
    expect(s.detail).toContain("Vorschlag: systemd-Benutzerdienst");
  });

  test("PM2 ausdrücklich gewählt: PM2 wie bisher, kein systemctl enable", async () => {
    const ctx = await linuxCtx({ pm2: "absent" });
    const r = await autostartStep.apply!({ manager: "pm2" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual(["pm2:tybo-telegram-relay"]);
    expect(ctx.run.calls.some(c => c.startsWith("systemctl --user enable"))).toBe(false);
  });

  test("Bot läuft schon unter PM2: bleibt dort, kein zweiter Dienst; Wechsel nur nach Entfernen", async () => {
    const ctx = await linuxCtx({ pm2: "bot" });
    await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
    await writeFile(ctx.pm2DumpPath, JSON.stringify([{ name: "tybo-telegram-relay" }]));
    expect(await autostartPlan(ctx)).toEqual({ managers: ["pm2"], default: "pm2", existing: "pm2" });
    expect((await autostartStep.apply!({}, ctx)).message).toBe("Autostart ist schon eingerichtet, nichts geändert.");
    const r = await autostartStep.apply!({ manager: "systemd" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("pm2 delete tybo-telegram-relay; pm2 save --force");
    expect(started(ctx.run)).toEqual([]);
  });

  test("Bot nur in dump.pm2, jlist leer: kein systemd-Start, PM2 stellte ihn beim Hochfahren wieder her", async () => {
    const ctx = await linuxCtx({ pm2: "absent" });
    await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
    await writeFile(ctx.pm2DumpPath, JSON.stringify([{ name: "tybo-telegram-relay", status: "stopped" }]));
    expect(await autostartPlan(ctx)).toEqual({ managers: ["pm2"], default: "pm2", existing: "pm2" });
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("teilweise");
    expect(s.detail).toContain("dump.pm2");
    expect(s.detail).not.toContain("Vorschlag: systemd");
    const r = await autostartStep.apply!({ manager: "systemd" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("pm2 save --force");
    expect(ctx.run.calls.some(c => c.startsWith("systemctl --user enable") || c === "systemctl --user daemon-reload")).toBe(false);
    expect(existsSync(join(ctx.systemdUserDir, "tybo-telegram-relay.service"))).toBe(false);
    // Ohne Auswahl bleibt es bei PM2, systemd wird nie eingerichtet
    const pm2 = await autostartStep.apply!({}, ctx);
    expect(pm2.ok).toBe(true);
    expect(ctx.run.calls.some(c => c.startsWith("pm2 start") && c.includes("tybo-telegram-relay"))).toBe(true);
    expect(ctx.run.calls.some(c => c.startsWith("systemctl --user enable") || c === "systemctl --user daemon-reload")).toBe(false);
    expect(existsSync(join(ctx.systemdUserDir, "tybo-telegram-relay.service"))).toBe(false);
  });

  test("Dienstdatei da und Bot nur in dump.pm2: in beiden, nichts gestartet", async () => {
    const ctx = await linuxCtx({ pm2: "absent" }, { unit: true });
    await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
    await writeFile(ctx.pm2DumpPath, JSON.stringify([{ name: "tybo-telegram-relay" }]));
    expect((await autostartPlan(ctx)).blocked).toContain("zwei Bots");
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(false);
    expect(started(ctx.run)).toEqual([]);
  });

  test("Bot schon als systemd-Dienst: PM2 abgelehnt, mit Befehl zum Entfernen", async () => {
    const ctx = await linuxCtx({ loaded: true, active: true, enabled: true, pm2: "absent" }, { unit: true });
    const r = await autostartStep.apply!({ manager: "pm2" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain(`systemctl --user disable --now ${SYSTEMD_UNIT}`);
    expect(started(ctx.run)).toEqual([]);
  });

  test("in beiden eingetragen: nichts gestartet", async () => {
    const ctx = await linuxCtx({ loaded: true, active: false, pm2: "bot" }, { unit: true });
    const plan = await autostartPlan(ctx);
    expect(plan.managers).toEqual([]);
    expect(plan.blocked).toContain("zwei Bots");
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(started(ctx.run)).toEqual([]);
    expect((await autostartStep.test!({}, ctx)).ok).toBe(false);
  });

  /** Keine Dienstdatei geschrieben, kein systemctl enable/start/daemon-reload */
  function noSystemd(ctx: SetupContext & { run: { calls: string[] } }) {
    expect(ctx.run.calls.filter(c => /^systemctl --user (enable|restart|start|daemon-reload)/.test(c))).toEqual([]);
    expect(existsSync(join(ctx.systemdUserDir, "tybo-telegram-relay.service"))).toBe(false);
  }

  for (const [pm2, what] of [["none", "fehlt im PATH"], ["broken", "scheitert"], ["timeout", "läuft in die Zeitüberschreitung"]] as const) {
    test(`PM2-CLI ${what}, Bot in dump.pm2: bleibt bei PM2, keine Unit, kein systemd-Start`, async () => {
      const ctx = await linuxCtx({ pm2 });
      await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
      await writeFile(ctx.pm2DumpPath, JSON.stringify([{ name: "tybo-telegram-relay" }]));
      expect(await autostartPlan(ctx)).toEqual({ managers: ["pm2"], default: "pm2", existing: "pm2" });
      const s = await autostartStep.status(ctx);
      expect(s.state).toBe("teilweise");
      expect(s.detail).toContain("dump.pm2");
      expect(s.detail).not.toContain("Vorschlag: systemd");
      const plain = await autostartStep.apply!({}, ctx);
      expect(plain.ok).toBe(false);
      const systemd = await autostartStep.apply!({ manager: "systemd" }, ctx);
      expect(systemd.ok).toBe(false);
      expect(systemd.message).toContain("pm2 save --force");
      noSystemd(ctx);
      expect(started(ctx.run)).toEqual([]);
      expect(leakedSecrets(plain)).toEqual([]);
    });
  }

  // Defekte oder hängende CLI: dort kann ein Bot laufen, der noch nicht in dump.pm2 steht
  const brokenCli = [
    ["broken", "scheitert"],
    ["timeout", "läuft in die Zeitüberschreitung"],
    ["noexec", "liegt da, ist aber nicht ausführbar"],
    ["nointerp", "findet ihren Interpreter nicht (127)"],
  ] as const;
  const noDump: [string, (path: string) => Promise<void>][] = [
    ["fehlt", async () => {}],
    ["ist leer", path => writeFile(path, "[]")],
  ];
  for (const [pm2, what] of brokenCli) {
    for (const [dumpWhat, write] of noDump) {
      test(`PM2-CLI ${what}, dump.pm2 ${dumpWhat}: unklar, keine Unit, kein systemd-Start`, async () => {
        const ctx = await linuxCtx({ pm2 });
        await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
        await write(ctx.pm2DumpPath);
        const plan = await autostartPlan(ctx);
        expect(plan.managers).toEqual([]);
        expect(plan.default).toBeNull();
        expect(plan.blocked).toContain("pm2 --version");
        for (const values of [{}, { manager: "systemd" }]) {
          const r = await autostartStep.apply!(values, ctx);
          expect(r.ok).toBe(false);
          expect(leakedSecrets(r)).toEqual([]);
        }
        noSystemd(ctx);
        expect(started(ctx.run)).toEqual([]);
      });
    }
  }

  const badDumps: [string, (path: string) => Promise<void>][] = [
    ["unlesbar", path => mkdir(path, { recursive: true })],
    ["ungültig", path => writeFile(path, "{kein json")],
    ["kein Array", path => writeFile(path, JSON.stringify({ name: "tybo-telegram-relay" }))],
  ];
  for (const [what, write] of badDumps) {
    test(`jlist leer, dump.pm2 ${what}: unklar, keine Unit, kein systemd-Start`, async () => {
      const ctx = await linuxCtx({ pm2: "absent" });
      await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
      await write(ctx.pm2DumpPath);
      const plan = await autostartPlan(ctx);
      expect(plan.managers).toEqual([]);
      expect(plan.blocked).toContain("dump.pm2");
      const s = await autostartStep.status(ctx);
      expect(s.state).toBe("teilweise");
      expect(s.detail).toContain("dump.pm2");
      expect((await autostartStep.apply!({}, ctx)).ok).toBe(false);
      expect((await autostartStep.apply!({ manager: "systemd" }, ctx)).ok).toBe(false);
      noSystemd(ctx);
      expect(started(ctx.run)).toEqual([]);
    });
  }

  test("dump.pm2 fehlt ganz: kein unklarer Zustand, systemd bleibt Vorschlag", async () => {
    const ctx = await linuxCtx({ pm2: "none" });
    expect(existsSync(ctx.pm2DumpPath)).toBe(false);
    expect(await autostartPlan(ctx)).toEqual({ managers: ["systemd", "pm2"], default: "systemd" });
  });

  test("PM2-Liste unlesbar: kein systemd-Start auf Verdacht", async () => {
    const ctx = await linuxCtx({ pm2: "unknown" });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("pm2 jlist");
    expect(started(ctx.run)).toEqual([]);
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("Benutzer-Manager nicht erreichbar: kein Standard, PM2 nur ausdrücklich", async () => {
    const ctx = await linuxCtx({ reachable: false, pm2: "absent" });
    const plan = await autostartPlan(ctx);
    expect(plan).toEqual({ managers: ["pm2"], default: null, note: `${SYSTEMD_UNREACHABLE} Sonst geht PM2.` });
    const s = await autostartStep.status(ctx);
    expect(s.detail).toContain("antwortet nicht");
    const refused = await autostartStep.apply!({}, ctx);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("nicht über sudo");
    expect(started(ctx.run)).toEqual([]);
    const systemd = await autostartStep.apply!({ manager: "systemd" }, ctx);
    expect(systemd.ok).toBe(false);
    const pm2 = await autostartStep.apply!({ manager: "pm2" }, ctx);
    expect(pm2.ok).toBe(true);
  });

  test("ohne systemd: systemd abgelehnt, PM2 wie bisher ohne zusätzliche Abfragen", async () => {
    const ctx = await makeCtx({ overrides: { platform: "linux" } });
    const run = systemdRun(ctx, { pm2: "absent" });
    ctx.run = run as any;
    expect(await autostartPlan(ctx)).toEqual({ managers: ["pm2"], default: "pm2" });
    const r = await autostartStep.apply!({ manager: "systemd" }, ctx);
    expect(r.message).toBe("Dieser Rechner läuft nicht mit systemd; Autostart geht hier über PM2.");
    expect(run.calls.some(c => c.startsWith("systemctl"))).toBe(false);
    expect((await autostartStep.apply!({ manager: "unsinn" }, ctx)).ok).toBe(false);
  });

  test("Supabase auf diesem Rechner: Bot über systemd, Supabase weiter über PM2", async () => {
    const env = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nSUPABASE_URL=${LOCAL_SUPABASE_URL}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;
    const ctx = await linuxCtx({ pm2: "absent" }, { env });
    const r = await autostartStep.apply!({}, ctx);
    expect(ctx.run.calls).toContain("systemctl --user enable --now tybo-telegram-relay");
    expect(ctx.run.calls.some(c => c.startsWith("pm2 start") && c.includes("tybo-supabase"))).toBe(true);
    expect(ctx.run.calls.some(c => c.startsWith("pm2 start") && c.includes("tybo-telegram-relay"))).toBe(false);
    expect(r.ok).toBe(true);
    expect(leakedSecrets(r)).toEqual([]);
  });
});

describe("Terminal: tybo setup autostart", () => {
  test("Auswahl mit systemd als Vorschlag, Enter nimmt ihn", async () => {
    const ctx = await linuxCtx();
    const prompter = scripted(["", "j"]);
    const r = await runWith({ mode: "step", step: "autostart" }, ctx, prompter);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("1) systemd-Benutzerdienst (Vorschlag)");
    expect(r.out).toContain("2) PM2");
    expect(r.out).toContain("Autostart einrichten (systemd-Benutzerdienst)");
    expect(ctx.run.calls).toContain("systemctl --user enable --now tybo-telegram-relay");
  });

  test("2 wählt PM2", async () => {
    const ctx = await linuxCtx({ pm2: "absent" });
    const r = await runWith({ mode: "step", step: "autostart" }, ctx, scripted(["2", "j"]));
    expect(r.out).toContain("Autostart einrichten (PM2)");
    expect(ctx.run.calls.some(c => c.startsWith("pm2 start"))).toBe(true);
    expect(ctx.run.calls.some(c => c.startsWith("systemctl --user enable"))).toBe(false);
  });

  test("ohne Linger: Hinweis mit sudo-Befehl, Nochmal prüft nach dem sudo-Befehl", async () => {
    const ctx = await linuxCtx({ linger: "no", lingerEnable: "denied" });
    const answers = ["", "j", () => {
      // Der Nutzer führt den sudo-Befehl in einem anderen Fenster aus
      ctx.run.world.linger = "yes";
      return "e";
    }, "j"];
    const r = await runWith({ mode: "step", step: "autostart" }, ctx, scripted(answers as any));
    expect(r.out).toContain("sudo loginctl enable-linger alex");
    expect(r.out).toContain("Autostart ist eingerichtet.");
    expect(ctx.run.calls.filter(c => c === "systemctl --user enable --now tybo-telegram-relay")).toHaveLength(1);
  });
});

describe("Browser: Auswahl bis „Fertig“", () => {
  async function launch(ctx: SetupContext, supervisor: () => Promise<"systemd" | null> = async () => null) {
    const logs: string[] = [];
    let readyResolve!: (info: { url: string; code: string }) => void;
    const ready = new Promise<{ url: string; code: string }>(r => (readyResolve = r));
    const done = runSetupMode({
      root: ctx.root,
      env: {},
      startMode: { mode: "setup", reason: "forced", missing: [] },
      supervisor,
      ctx,
      code: CODE,
      port: 0,
      graceMs: 20,
      log: line => logs.push(line),
      onInterrupt: () => () => {},
      onReady: readyResolve,
    });
    const { url } = await ready;
    const res = await fetch(`${url}/api/setup/code`, { method: "POST", headers: { Origin: url }, body: JSON.stringify({ code: CODE }) });
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    return { url, cookie, logs, done };
  }
  const finish = async (url: string, cookie: string, body: unknown) => {
    const res = await fetch(`${url}/api/setup/finish`, { method: "POST", headers: { Origin: url, Cookie: cookie }, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as any };
  };

  test("Übersicht nennt die Wege, „Fertig“ mit PM2 richtet erst nach dem Schließen PM2 ein", async () => {
    const ctx = await linuxCtx({ pm2: "absent" }, { env: FULL_ENV, profile: PROFILE });
    const mode = await launch(ctx);
    const overview = await (await fetch(`${mode.url}/api/setup/overview`, { headers: { Cookie: mode.cookie } })).json();
    expect(overview.autostartChoice).toEqual({
      choices: [
        { value: "systemd", label: "systemd-Benutzerdienst" },
        { value: "pm2", label: "PM2" },
      ],
      default: "systemd",
      note: null,
    });
    expect((await finish(mode.url, mode.cookie, { autostart: true, manager: "launchd?" })).status).toBe(400);
    expect(started(ctx.run)).toEqual([]);
    const r = await finish(mode.url, mode.cookie, { autostart: true, manager: "pm2" });
    expect(r.status).toBe(200);
    expect(r.data.plan).toBe("autostart");
    expect(r.data.message).toContain("(PM2)");
    expect(await mode.done).toBe(0);
    expect(ctx.run.calls.some(c => c.startsWith("pm2 start"))).toBe(true);
    expect(ctx.run.calls.some(c => c.startsWith("systemctl --user enable"))).toBe(false);
  });

  test("„Fertig“ ohne Auswahl: systemd; fehlt Linger, kein „Von Hand starten“", async () => {
    const ctx = await linuxCtx({ linger: "no", lingerEnable: "denied" }, { env: FULL_ENV, profile: PROFILE });
    const mode = await launch(ctx);
    const r = await finish(mode.url, mode.cookie, { autostart: true });
    expect(r.status).toBe(200);
    expect(await mode.done).toBe(1);
    expect(ctx.run.calls).toContain("systemctl --user enable --now tybo-telegram-relay");
    const text = mode.logs.join("\n");
    expect(text).toContain("sudo loginctl enable-linger alex");
    expect(text).not.toContain("Von Hand starten");
  });

  test("systemd startet den Bot, Supabase-Dienst scheitert: Bot bleibt im Ergebnis, kein „Von Hand starten“", async () => {
    const env = `${FULL_ENV.replace(/^CONVEX_.*\n/gm, "")}SUPABASE_URL=${LOCAL_SUPABASE_URL}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;
    const ctx = await linuxCtx({ pm2: "absent" }, { env, profile: PROFILE });
    const inner = ctx.run;
    ctx.run = Object.assign(async (cmd: string[]) => {
      const line = cmd.join(" ");
      return line.startsWith("pm2 start") && line.includes("tybo-supabase") ? { code: 1, stdout: "", stderr: `boom ${FAKE.token}` } : inner(cmd);
    }, inner) as any;
    // Direkt: Supabase scheitert, der Bot läuft trotzdem
    const direct = await autostartStep.apply!({}, ctx);
    expect(direct.ok).toBe(false);
    expect(direct.running).toBe(true);
    expect(direct.message).toContain("Supabase-Autostart ließ sich nicht einrichten");

    const fresh = await linuxCtx({ pm2: "absent" }, { env, profile: PROFILE });
    const freshInner = fresh.run;
    fresh.run = Object.assign(async (cmd: string[]) => {
      const line = cmd.join(" ");
      return line.startsWith("pm2 start") && line.includes("tybo-supabase") ? { code: 1, stdout: "", stderr: `boom ${FAKE.token}` } : freshInner(cmd);
    }, freshInner) as any;
    const mode = await launch(fresh);
    const r = await finish(mode.url, mode.cookie, { autostart: true });
    expect(r.status).toBe(200);
    expect(await mode.done).toBe(1);
    expect(fresh.run.calls).toContain("systemctl --user enable --now tybo-telegram-relay");
    const text = mode.logs.join("\n");
    expect(text).toContain(`systemd-Benutzerdienst ${SYSTEMD_UNIT}`);
    expect(text).toContain("Supabase-Autostart ließ sich nicht einrichten");
    expect(text).not.toContain("Von Hand starten");
    expect(text).not.toContain("bun run start");
    expect(text).not.toContain(FAKE.token);
  });

  test("Benutzer-Manager nicht erreichbar: Hinweis, „Fertig“ mit Autostart ohne Wahl abgelehnt", async () => {
    const ctx = await linuxCtx({ reachable: false, pm2: "absent" }, { env: FULL_ENV, profile: PROFILE });
    const mode = await launch(ctx);
    const overview = await (await fetch(`${mode.url}/api/setup/overview`, { headers: { Cookie: mode.cookie } })).json();
    expect(overview.autostartChoice.default).toBeNull();
    expect(overview.autostartChoice.note).toContain("nicht über sudo");
    const r = await finish(mode.url, mode.cookie, { autostart: true });
    expect(r.status).toBe(409);
    expect(started(ctx.run)).toEqual([]);
    const pm2 = await finish(mode.url, mode.cookie, { autostart: true, manager: "pm2" });
    expect(pm2.status).toBe(200);
    expect(await mode.done).toBe(0);
  });

  test("unter systemd gestartet: „Fertig“ beendet den Prozess, systemd startet neu, kein zweiter Dienst", async () => {
    const ctx = await linuxCtx({ loaded: true, active: true, enabled: true }, { env: FULL_ENV, profile: PROFILE, unit: true });
    const mode = await launch(ctx, async () => "systemd");
    const overview = await (await fetch(`${mode.url}/api/setup/overview`, { headers: { Cookie: mode.cookie } })).json();
    expect(overview.supervisor).toBe("systemd");
    expect(overview.autostartChoice).toBeNull();
    const r = await finish(mode.url, mode.cookie, { autostart: true });
    expect(r.data.plan).toBe("restart");
    expect(r.data.message).toContain("(systemd)");
    expect(await mode.done).toBe(0);
    expect(mode.logs.join("\n")).toContain("systemd startet tybo neu");
    expect(started(ctx.run)).toEqual([]);
  });
});
