/**
 * Issue #486, Schritt 3: Dienst-Versionen in tybo wartung, bun run updates
 * --apply und im Nachtcheck. Alles gegen Attrappen
 * (maintenance-services-fixture.ts, maintenance-fixture.ts); kein echter
 * Dienstbefehl, kein restart:request.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTybo } from "../scripts/tybo";
import { evaluateServiceVersions } from "../src/health-check";
import { runMaintenanceCommand, type MaintenanceState } from "../src/lib/maintenance/run";
import { checkServices, type ServiceCheckRun } from "../src/lib/maintenance/services";
import { notificationText, runUpdates, type Runner, type UpdateState } from "../src/software-update";
import { makeFixture, type Fixture } from "./maintenance-fixture";
import { cleanupServiceDirs, fake, TUNNEL, type Fake } from "./maintenance-services-fixture";

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()!.cleanup();
  cleanupServiceDirs();
});

const DIENSTE = [{ name: "Cloudflare-Tunnel", launchd: "ai.tybo.cloudflare-tunnel", versionBefehl: ["cloudflared", "--version"], metrik: { url: "http://127.0.0.1:20241/metrics" }, wartezeitSek: 10 }];

function setup(config: object | null): { f: Fixture; s: Fake } {
  const f = makeFixture("darwin");
  fixtures.push(f);
  if (config) writeFileSync(join(f.root, "config", "wartung.json"), JSON.stringify(config));
  const s = fake(f.root);
  f.deps.services = s.deps;
  return { f, s };
}

async function command(f: Fixture, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMaintenanceCommand(args, { deps: f.deps, out: l => out.push(l), err: l => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const state = (f: Fixture) => JSON.parse(readFileSync(join(f.root, "data", "wartung.json"), "utf8")) as MaintenanceState;

/** tybo wartung über den echten CLI-Weg; Dienstzugriffe aus der Attrappe, aber ohne env (kommt aus Umgebung und Projekt-.env) */
async function viaCli(f: Fixture, s: Fake, args: string[], platform: NodeJS.Platform) {
  const { env: _env, ...services } = s.deps;
  const out: string[] = [];
  const code = await runTybo({
    args: ["wartung", ...args],
    env: { TYBO_ROOT: f.root, HOME: f.home },
    platform,
    out: l => out.push(l),
    err: l => out.push(l),
    maintenance: { run: f.deps.run, notify: f.deps.notify, freeBytes: f.deps.freeBytes, now: f.deps.now, services },
  });
  return { code, out: out.join("\n") };
}

describe("tybo wartung", () => {
  test("veralteter Dienst: Neustart, Ergebnis in Meldung und Zustand", async () => {
    const { f, s } = setup({ dienste: DIENSTE });
    const r = await command(f, []);
    expect(r.code).toBe(0);
    expect(s.restarts).toEqual(["launchctl kickstart -k gui/501/ai.tybo.cloudflare-tunnel"]);
    expect(f.notified[0]).toContain("Dienst-Versionen:\n- Cloudflare-Tunnel: neu gestartet, 2026.10.0 → 2026.10.3");
    expect(state(f).lastRun.services?.services[0]).toMatchObject({ outcome: "neu-gestartet", previous: "2026.10.0", running: "2026.10.3" });
  });

  test("--dry-run: nur zeigen, was neu gestartet würde", async () => {
    const { f, s } = setup({ dienste: DIENSTE });
    const r = await command(f, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Cloudflare-Tunnel: läuft 2026.10.0, installiert 2026.10.3, würde neu gestartet");
    expect(r.out).toContain("nichts neu gestartet");
    expect(s.restarts).toEqual([]);
    expect(s.botRequests).toEqual([]);
    expect(f.notified).toEqual([]);
  });

  test("Neustart scheitert: Fehler in Meldung und Zustand, Exit 1", async () => {
    const { f, s } = setup({ dienste: DIENSTE });
    s.restartFails = true;
    const r = await command(f, []);
    expect(r.code).toBe(1);
    expect(f.notified[0]).toContain("mit Fehlern");
    expect(f.notified[0]).toContain("Neustart gescheitert");
    expect(state(f).lastRun.status).toBe("fehler");
  });

  test("ohne Dienste in config/wartung.json: kein Dienstbefehl, kein Abschnitt", async () => {
    const { f, s } = setup({});
    const r = await command(f, []);
    expect(r.code).toBe(0);
    expect(s.calls).toEqual([]);
    expect(f.notified[0]).not.toContain("Dienst-Versionen");
    expect(state(f).lastRun.services).toBeUndefined();
  });

  test("ungültige Dienstliste: Wartung bricht ab, nichts angefasst", async () => {
    const { f, s } = setup({ dienste: [{ launchd: "com.fremd", versionBefehl: ["x"], binaer: "/x" }] });
    const r = await command(f, []);
    expect(r.code).toBe(1);
    expect(s.calls).toEqual([]);
    expect(f.notified[0]).toContain("abgebrochen");
  });

  test("Wartung und Update gleichzeitig: nur einer startet neu", async () => {
    const { f, s } = setup({ dienste: DIENSTE });
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let reached!: () => void;
    const verifying = new Promise<void>(r => (reached = r));
    const sleep = s.deps.sleep;
    s.deps.sleep = async ms => {
      reached();
      await gate;
      await sleep(ms);
    };
    const maintenance = command(f, []);
    // Signal statt Pause: die Wartung hält die Dienstsperre und steht in der Nachprüfung
    await verifying;
    const other = fake(f.root);
    other.services = s.services;
    const update = await runUpdates("apply", { runner: emptyRunner, env: {}, smoke: async () => [], services: () => checkServices([TUNNEL], other.deps, "neustart") });
    release();
    await maintenance;
    expect(update.services?.error).toContain("läuft schon");
    expect(s.restarts.length + other.restarts.length).toBe(1);
    expect(notificationText(update, 3)).toContain("⚠️ Software-Update mit Problemen");
  });
});

describe("tybo wartung über runTybo: Bot-Schutz mit Namen nur aus der Projekt-.env", () => {
  for (const [platform, manager, target, envLine] of [
    ["darwin", "launchd", "ai.tybo.mein-bot", "TYBO_LAUNCHD_LABEL=ai.tybo.mein-bot"],
    ["linux", "systemd", "tybo-mein-bot.service", "TYBO_SYSTEMD_UNIT=tybo-mein-bot.service"],
  ] as const) {
    function botSetup() {
      const f = makeFixture(platform);
      fixtures.push(f);
      writeFileSync(join(f.root, "config", "wartung.json"), JSON.stringify({ dienste: [{ name: "Bot", [manager]: target, versionBefehl: ["cloudflared", "--version"], metrik: { url: "http://127.0.0.1:20241/metrics" } }] }));
      writeFileSync(join(f.root, ".env"), `${envLine}\n`);
      const s = fake(f.root);
      s.deps.platform = platform;
      s.services = { [target]: { state: "running", pid: 100, version: "2026.10.0" } };
      return { f, s };
    }

    test(`${manager} ${target}: nur Neustart-Anfrage, nie der Dienstmanager`, async () => {
      const { f, s } = botSetup();
      const r = await viaCli(f, s, [], platform);
      expect(r.code).toBe(0);
      expect(s.restarts).toEqual([]);
      expect(s.calls.some(c => c.includes("kickstart") || c.includes("systemctl --user restart"))).toBe(false);
      expect(s.botRequests.length).toBe(1);
      expect(f.notified[0]).toContain("Bot: Neustart angefordert");
    });

    test(`${manager} ${target}, Probelauf: auch keine Anfrage`, async () => {
      const { f, s } = botSetup();
      const r = await viaCli(f, s, ["--dry-run"], platform);
      expect(r.code).toBe(0);
      expect(r.out).toContain("würde neu gestartet");
      expect(s.restarts).toEqual([]);
      expect(s.botRequests).toEqual([]);
    });
  }
});

describe("Geheimnisse in Zustand, Terminal und Meldung", () => {
  const ARG_SECRET = "arg-geheim-7f3k9q";
  const ENV_SECRET = "env-geheim-2m8x4w";
  const SECRETS = [ARG_SECRET, ENV_SECRET, "url-geheim-9"];
  const WITH_ARGS = [{ ...DIENSTE[0], versionBefehl: ["cloudflared", `--token=${ARG_SECRET}`, "--version"] }];

  function failingVersion(s: Fake) {
    const run = s.deps.run;
    s.deps.run = async (cmd, timeout) => {
      if (cmd[0] !== "cloudflared") return run(cmd, timeout);
      return { code: 1, stdout: "", stderr: `abgelehnt: ${ARG_SECRET} ${ENV_SECRET} https://nutzer:url-geheim-9@example.invalid` };
    };
  }

  test("tybo wartung (CLI, Geheimnis aus der Projekt-.env): weder in data/wartung.json noch im Terminal noch in der Meldung", async () => {
    const f = makeFixture("darwin");
    fixtures.push(f);
    writeFileSync(join(f.root, "config", "wartung.json"), JSON.stringify({ dienste: WITH_ARGS }));
    writeFileSync(join(f.root, ".env"), `TYBO_TEST_TOKEN=${ENV_SECRET}\n`);
    const s = fake(f.root);
    failingVersion(s);
    const r = await viaCli(f, s, [], "darwin");
    const stored = readFileSync(join(f.root, "data", "wartung.json"), "utf8");
    expect(stored).toContain("[verborgen]");
    for (const text of [stored, r.out, ...f.notified]) for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(f.notified[0]).toContain("Version unbekannt");
  });

  test("tybo wartung --dry-run: Terminal ohne Geheimnisse", async () => {
    const f = makeFixture("darwin");
    fixtures.push(f);
    writeFileSync(join(f.root, "config", "wartung.json"), JSON.stringify({ dienste: WITH_ARGS }));
    writeFileSync(join(f.root, ".env"), `TYBO_TEST_TOKEN=${ENV_SECRET}\n`);
    const s = fake(f.root);
    failingVersion(s);
    const r = await viaCli(f, s, ["--dry-run"], "darwin");
    expect(r.out).toContain("cloudflared:");
    for (const secret of SECRETS) expect(r.out).not.toContain(secret);
  });

  test("bun run updates --apply: Zustand und Meldung ohne Geheimnisse", async () => {
    const s = fake();
    s.deps.env = { TYBO_TEST_TOKEN: ENV_SECRET };
    failingVersion(s);
    const svc = { ...TUNNEL, versionCommand: ["cloudflared", `--token=${ARG_SECRET}`, "--version"] };
    const st = await runUpdates("apply", { runner: emptyRunner, env: {}, smoke: async () => [], services: () => checkServices([svc], s.deps, "neustart") });
    const text = notificationText(st, 3)!;
    expect(text).toContain("Version unbekannt");
    for (const t of [JSON.stringify(st), text]) for (const secret of SECRETS) expect(t).not.toContain(secret);
  });
});

/** Attrappe für bun und brew: nichts installiert */
const emptyRunner: Runner = async () => ({ code: 127, stdout: "", stderr: "not found" });

describe("bun run updates", () => {
  test("--apply ohne neue Pakete prüft trotzdem die Dienste", async () => {
    let calls = 0;
    const st = await runUpdates("apply", { runner: emptyRunner, env: {}, smoke: async () => [], services: async () => (calls++, null) });
    expect(calls).toBe(1);
    expect(st.services).toBeUndefined();
  });

  test("--apply nach Teilupdate: Dienste geprüft, Meldung nennt den gescheiterten Schritt", async () => {
    const runner: Runner = async cmd => {
      const key = cmd.join(" ");
      if (key === "bun --version") return { code: 0, stdout: "1.4.4", stderr: "" };
      if (key === "bun upgrade") return { code: 1, stdout: "", stderr: "Netzwerkfehler" };
      return { code: 127, stdout: "", stderr: "not found" };
    };
    const s = fake();
    const st = await runUpdates("apply", { runner, env: {}, smoke: async () => [{ name: "Selbsttests", ok: true, detail: "ok" }], services: () => checkServices([TUNNEL], s.deps, "neustart") });
    expect(s.restarts.length).toBe(1);
    const text = notificationText(st, 3)!;
    expect(text.startsWith("⚠️ Software-Update mit Problemen")).toBe(true);
    expect(text).toContain("❌ Bun: FEHLER");
    expect(text).toContain("Cloudflare-Tunnel: neu gestartet, 2026.10.0 → 2026.10.3");
  });

  test("nachts: keine Dienstprüfung", async () => {
    let calls = 0;
    await runUpdates("nightly", { runner: emptyRunner, env: {}, latestBun: async () => null, smoke: async () => [], services: async () => (calls++, null) });
    expect(calls).toBe(0);
  });

  test("Dienst weiter alt: ⚠️ statt ✅", () => {
    const services: ServiceCheckRun = {
      mode: "neustart",
      startedAt: "",
      finishedAt: "",
      status: "fehler",
      services: [{ name: "Cloudflare-Tunnel", manager: "launchd", target: "ai.tybo.cloudflare-tunnel", outcome: "fehler", installed: "2026.10.3", running: "2026.10.0", detail: "neu gestartet, aber meldet danach 2026.10.0 (nach 60 s)" }],
    };
    const st: UpdateState = { version: 1, mode: "apply", startedAt: "", finishedAt: "", steps: [{ name: "brew", status: "updated", detail: "1 aktualisiert (cloudflared)" }], services };
    const text = notificationText(st, 3)!;
    expect(text.startsWith("⚠️ Software-Update mit Problemen")).toBe(true);
    expect(text).toContain("meldet danach 2026.10.0");
  });

  test("alles gut: weiter ✅", () => {
    const st: UpdateState = { version: 1, mode: "apply", startedAt: "", finishedAt: "", steps: [{ name: "brew", status: "current", detail: "alle Pakete aktuell" }] };
    expect(notificationText(st, 3)).toBe("✅ Software-Update eingespielt: nichts eingespielt");
  });
});

describe("Nachtcheck", () => {
  test("ohne Liste: –", () => {
    expect(evaluateServiceVersions(null).status).toBe("na");
  });

  test("veraltet: ⚠️ mit Hinweis, kein Neustart", async () => {
    const s = fake();
    const run = await checkServices([TUNNEL], s.deps, "pruefen");
    const r = evaluateServiceVersions(run);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("läuft 2026.10.0, installiert 2026.10.3");
    expect(r.hint).toContain("wartung");
    expect(s.restarts).toEqual([]);
    expect(s.botRequests).toEqual([]);
  });

  test("aktuell: ✅", async () => {
    const s = fake();
    s.services["ai.tybo.cloudflare-tunnel"].version = "2026.10.3";
    const r = evaluateServiceVersions(await checkServices([TUNNEL], s.deps, "pruefen"));
    expect(r).toMatchObject({ status: "ok", detail: "Cloudflare-Tunnel: aktuell (2026.10.3)" });
  });

  test("unbekannt oder ungültige Konfiguration: ⚠️", async () => {
    const s = fake();
    s.metricDown = true;
    expect(evaluateServiceVersions(await checkServices([TUNNEL], s.deps, "pruefen")).status).toBe("warn");
    expect(evaluateServiceVersions({ mode: "pruefen", startedAt: "", finishedAt: "", status: "fehler", services: [], error: "config/wartung.json ungültig: x" }).status).toBe("warn");
  });
});
