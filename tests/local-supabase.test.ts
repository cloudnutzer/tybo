/**
 * Issue #164: Ablauf „Supabase auf diesem Rechner“ gegen Attrappen für
 * docker, die Supabase-CLI (bunx) und Postgres (SqlRunner). Aufgezeichnet
 * werden alle Befehle samt Optionen und alle SQL-Aufrufe; geschrieben wird
 * nur in die .env des Testordners. Kein echtes Docker.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SetupContext } from "../src/setup/context";
import {
  AUSGELASSEN,
  bindingsOf,
  cliEnv,
  cliHint,
  compareVersions,
  EXCLUDED_SERVICES,
  LOCAL_NETWORK,
  LOCAL_SUPABASE_URL,
  MIN_SUPABASE_CLI,
  parseStatus,
  runSupabaseLocal,
  START_TIMEOUT_MS,
  startHint,
  stopHint,
  SUPABASE_CLI_VERSION,
} from "../src/setup/local-supabase";
import type { RunEvent, SetupValues } from "../src/setup/model";
import { RELOAD_SCHEMA_SQL, SCHEMA_FILES } from "../src/setup/supabase-schema";
import { backupsOf, cleanup, FAKE, makeCtx } from "./setup-fixture";
import { CLI_PREFIX, fakeLocal, LOCAL, LOCAL_SECRETS, OPEN_CONTAINERS, SAFE_CONTAINERS, shortName, statusJson, type FakeLocal } from "./local-supabase-fixture";

afterAll(cleanup);

const REPO = resolve(import.meta.dir, "..");
const BASE_ENV = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n`;

interface Setup {
  ctx: SetupContext & { providers: Awaited<ReturnType<typeof makeCtx>>["providers"] };
  f: FakeLocal;
  events: RunEvent[];
  controller: AbortController;
  run(values?: SetupValues): ReturnType<typeof runSupabaseLocal>;
}

async function setup(options: { env?: string; f?: FakeLocal; overrides?: Partial<SetupContext> } = {}): Promise<Setup> {
  const f = options.f ?? fakeLocal();
  const ctx = await makeCtx({ env: options.env ?? BASE_ENV, overrides: { run: f.run, localSupabase: f.deps, ...options.overrides } });
  await cp(join(REPO, "db"), join(ctx.root, "db"), { recursive: true });
  const events: RunEvent[] = [];
  const s: Setup = {
    ctx: ctx as Setup["ctx"],
    f,
    events,
    controller: new AbortController(),
    run: (values = {}) => runSupabaseLocal({ DB_BACKEND: "supabase-lokal", ...values }, ctx, e => events.push(e), s.controller.signal),
  };
  return s;
}

const envOf = (s: Setup) => readFile(s.ctx.envPath, "utf8").catch(() => "");

/** Kein Schlüssel, keine DB_URL, kein Passwort in Ergebnis und Fortschritt */
function noSecrets(s: Setup, result: unknown) {
  const text = JSON.stringify({ result, events: s.events });
  for (const secret of LOCAL_SECRETS) expect(text.includes(secret)).toBe(false);
  expect(text).not.toContain("postgresql://");
}

/** Nie --no-backup, nie --all, jeder Befehl als Liste ohne Shell */
function safeCommands(f: FakeLocal) {
  for (const { cmd } of f.run.calls) {
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd).not.toContain("--no-backup");
    expect(cmd).not.toContain("--all");
    expect(["sh", "bash", "zsh", "/bin/sh"]).not.toContain(cmd[0]);
    expect(cmd).not.toContain("-c");
  }
}

describe("Prüfungen: passende Erklärung, kein start, kein Schreiben", () => {
  test("docker fehlt (macOS): drei Wege, installiert nichts", async () => {
    const s = await setup({ f: fakeLocal({ "docker --version": { code: -1, stderr: "Befehl nicht gefunden" } }) });
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Docker fehlt");
    expect(r.message).toContain("https://orbstack.dev");
    expect(r.message).toContain("https://docs.docker.com/desktop/");
    expect(r.message).toContain("brew install colima docker");
    expect(r.message).toContain("colima start");
    expect(r.message).toContain("tybo installiert es nicht selbst");
    expect(s.f.trail()).toEqual(["docker --version"]);
    expect(await envOf(s)).toBe(BASE_ENV);
    expect(await backupsOf(s.ctx)).toEqual([]);
    expect(s.f.sessions).toEqual([]);
  });

  test("docker fehlt (Linux): Docker Engine", async () => {
    const s = await setup({ f: fakeLocal({ "docker --version": { code: -1 } }), overrides: { platform: "linux" } });
    const r = await s.run();
    expect(r.message).toContain("https://docs.docker.com/engine/install/");
    expect(r.message).not.toContain("orbstack");
  });

  test("Docker läuft nicht", async () => {
    const s = await setup({ f: fakeLocal({ "docker info": { code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" } }) });
    const r = await s.run();
    expect(r.message).toStartWith("Docker läuft nicht: Docker Desktop bzw. OrbStack öffnen oder colima start");
    expect(r.message).not.toContain("docker.sock");
    expect(s.f.trail()).toEqual(["docker --version", "docker info"]);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Docker ohne Berechtigung", async () => {
    const s = await setup({ f: fakeLocal({ "docker info": { code: 1, stderr: "permission denied while trying to connect to the Docker daemon socket" } }) });
    const r = await s.run();
    expect(r.message).toContain("keine Berechtigung");
    expect(s.f.trail()).not.toContain("supabase start");
  });

  test("CLI lässt sich nicht laden (Download): Erklärung zu bunx, kein start", async () => {
    const s = await setup({ f: fakeLocal({ "supabase --version": { code: 1, stderr: "error: GET https://registry.npmjs.org/supabase - 503" } }) });
    const r = await s.run();
    expect(r.message).toContain("Die Supabase-CLI ließ sich nicht laden");
    expect(r.message).toContain(`bunx --bun supabase@${SUPABASE_CLI_VERSION} --version`);
    expect(r.message).toContain("Internetverbindung");
    expect(r.message).not.toContain("registry.npmjs.org");
    expect(s.f.trail()).toEqual(["docker --version", "docker info", "supabase --version"]);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("CLI zu alt", async () => {
    const s = await setup({ f: fakeLocal({ "supabase --version": { stdout: "2.44.9" } }) });
    const r = await s.run();
    expect(r.message).toContain(`älter als ${MIN_SUPABASE_CLI}`);
    expect(s.f.trail()).not.toContain("supabase start");
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("weniger als 8 GB: Hinweis im Fortschritt, kein Abbruch", async () => {
    const f = fakeLocal();
    f.mem = 4 * 1024 ** 3;
    const s = await setup({ f });
    const r = await s.run();
    expect(r.ok).toBe(true);
    expect(s.events.some(e => e.at === 1 && e.detail?.includes("weniger als 8 GB"))).toBe(true);
  });

  test("CLI über bunx: bun x --bun supabase@<Version>, Zeitlimit für den Download, ohne Geheimnisse in der Umgebung", async () => {
    const s = await setup();
    await s.run();
    const version = s.f.run.calls.find(c => c.cmd.includes("--version") && c.cmd[0] !== "docker")!;
    expect(version.cmd).toEqual([...CLI_PREFIX, "--version"]);
    expect(CLI_PREFIX[0]).toBe(process.execPath);
    expect(version.options.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(version.options.signal).toBeDefined();
    const env = cliEnv({ PATH: "/usr/bin", TELEGRAM_BOT_TOKEN: FAKE.token, SUPABASE_URL: "https://x.supabase.co", DOCKER_HOST: "unix:///x.sock", HOME: "/h" });
    expect(env).toEqual({ PATH: "/usr/bin", DOCKER_HOST: "unix:///x.sock", HOME: "/h" });
  });
});

describe("Erfolg", () => {
  test("start mit --workdir und genau AUSGELASSEN, status, Schema in Reihenfolge an DB_URL, Bucket, .env, Verbindungstest", async () => {
    const s = await setup();
    const r = await s.run();
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Supabase läuft auf diesem Rechner und ist eingerichtet.");
    expect(s.f.trail()).toEqual(["docker --version", "docker info", "supabase --version", "docker network inspect", "docker network create", "supabase start", "docker ps", "supabase status"]);
    // Eigenes Netz, das alle Ports an 127.0.0.1 bindet (daemon.json "ip" gilt dort nicht)
    const create = s.f.run.calls.find(c => shortName(c.cmd) === "docker network create")!;
    expect(create.cmd).toEqual(["docker", "network", "create", "--driver", "bridge", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", LOCAL_NETWORK]);
    expect(LOCAL_NETWORK).toBe("supabase_network_tybo");
    const ps = s.f.run.calls.find(c => shortName(c.cmd) === "docker ps")!;
    expect(ps.cmd).toEqual(["docker", "ps", "--filter", "label=com.supabase.cli.project=tybo", "--format", "{{.Names}}\t{{.Ports}}"]);
    const start = s.f.run.calls.find(c => c.cmd.includes("start"))!;
    expect(start.cmd).toEqual([...CLI_PREFIX, "start", "--workdir", s.ctx.root, "-x", AUSGELASSEN]);
    expect(AUSGELASSEN).toBe("studio,imgproxy,logflare,vector,realtime,supavisor,mailpit,postgres-meta");
    expect(EXCLUDED_SERVICES).not.toContain("gotrue");
    expect(EXCLUDED_SERVICES).not.toContain("storage-api");
    expect(EXCLUDED_SERVICES).not.toContain("kong");
    expect(start.options.timeoutMs).toBe(START_TIMEOUT_MS);
    expect(START_TIMEOUT_MS).toBe(20 * 60 * 1000);
    expect(start.options.signal).toBe(s.controller.signal);
    const status = s.f.run.calls.find(c => c.cmd.includes("status"))!;
    expect(status.cmd).toEqual([...CLI_PREFIX, "status", "--workdir", s.ctx.root, "-o", "json"]);
    expect(status.options.signal).toBe(s.controller.signal);
    // Eine Sitzung an DB_URL, zuverlässig geschlossen, mit dem Abbruch-Signal
    expect(s.f.sessions).toHaveLength(1);
    const session = s.f.sessions[0];
    expect(session.dbUrl).toBe(LOCAL.dbUrl);
    expect(session.closed).toBe(true);
    expect(session.signal).toBe(s.controller.signal);
    expect(session.ops).toEqual([
      "query:select public from storage.buckets where id = 'tybo-assets';",
      ...SCHEMA_FILES.map(file => `file:${join(s.ctx.root, file)}`),
      `query:${RELOAD_SCHEMA_SQL}`,
      expect.stringContaining("insert into storage.buckets (id, name, public) values ('tybo-assets', 'tybo-assets', false)"),
    ]);
    // .env: lokale Adresse und die neuen Schlüssel
    const env = await envOf(s);
    expect(env).toContain(`SUPABASE_URL=${LOCAL_SUPABASE_URL}`);
    expect(LOCAL_SUPABASE_URL).toBe("http://127.0.0.1:54421");
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${LOCAL.secret}`);
    expect(env).toContain(`SUPABASE_ANON_KEY=${LOCAL.publishable}`);
    expect(env).not.toContain(LOCAL.legacyService);
    expect(env).not.toContain("postgresql://");
    expect(r.changed.sort()).toEqual(["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
    expect(s.ctx.providers.calls).toEqual([{ method: "supabaseQuery", args: [LOCAL_SUPABASE_URL, LOCAL.secret] }]);
    expect(s.events.map(e => e.at)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7]));
    expect(s.events.find(e => e.at === 2)!.label).toBe("Lade und starte Supabase (beim ersten Mal einige Minuten)");
    noSecrets(s, r);
    safeCommands(s.f);
  });

  test("ohne neue Schlüssel: service_role und anon", async () => {
    const f = fakeLocal({ "supabase status": { stdout: statusJson({ SECRET_KEY: undefined, PUBLISHABLE_KEY: undefined }) } });
    const s = await setup({ f });
    expect((await s.run()).ok).toBe(true);
    const env = await envOf(s);
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${LOCAL.legacyService}`);
    expect(env).toContain(`SUPABASE_ANON_KEY=${LOCAL.legacyAnon}`);
  });

  test("weder PUBLISHABLE_KEY noch ANON_KEY: Abbruch vor SQL und .env, auch mit vorhandenem Cloud-ANON_KEY", async () => {
    const cloud = `${BASE_ENV}SUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\nSUPABASE_ANON_KEY=${FAKE.anonKey}\n`;
    const f = fakeLocal({ "supabase status": { stdout: statusJson({ PUBLISHABLE_KEY: undefined, ANON_KEY: undefined }) } });
    const s = await setup({ env: cloud, f });
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("keinen öffentlichen Schlüssel");
    expect(r.changed).toEqual([]);
    expect(f.sessions).toEqual([]);
    expect(await envOf(s)).toBe(cloud);
    expect(await backupsOf(s.ctx)).toEqual([]);
    noSecrets(s, r);
  });

  test("zweiter Lauf: dieselben Befehle, .env unverändert, keine neue Sicherung", async () => {
    const f = fakeLocal();
    const s = await setup({ f });
    expect((await s.run()).ok).toBe(true);
    const env = await envOf(s);
    const backups = await backupsOf(s.ctx);
    const firstTrail = f.trail();
    const firstOps = f.sessions[0].ops;
    // Zweiter Lauf: Bilder-Ordner gibt es jetzt (privat)
    f.onQuery = text => (text.includes("storage.buckets") ? [{ public: false }] : []);
    f.run.calls.length = 0;
    const r2 = await s.run();
    expect(r2.ok).toBe(true);
    expect(r2.changed).toEqual([]);
    expect(r2.message).toContain("alles war schon eingerichtet");
    expect(f.trail()).toEqual(firstTrail);
    expect(f.sessions[1].ops).toEqual(firstOps);
    expect(await envOf(s)).toBe(env);
    expect(await backupsOf(s.ctx)).toEqual(backups);
  });

  test("REST-API kennt das Schema erst nach kurzem Warten: Test wird wiederholt", async () => {
    const s = await setup();
    let n = 0;
    s.ctx.providers.supabaseQuery = async () => (++n < 3 ? { ok: false, message: "PGRST205" } : { ok: true, message: "Supabase erreichbar." });
    const r = await s.run();
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });

  test("Wechsel von Convex: ohne Bestätigung nichts gestartet; mit Bestätigung CONVEX_URL entfernt", async () => {
    const env = `${BASE_ENV}CONVEX_URL=${FAKE.convexUrl}\nCONVEX_AUTH_TOKEN=${FAKE.convexToken}\n`;
    const s = await setup({ env });
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("nicht bestätigt");
    expect(s.f.run.calls).toEqual([]);
    expect(await envOf(s)).toBe(env);
    const r2 = await s.run({ DB_SWITCH_CONFIRM: "true" });
    expect(r2.ok).toBe(true);
    expect(r2.changed).toContain("CONVEX_URL");
    expect(await envOf(s)).not.toContain("CONVEX_URL=");
  });
});

describe("Fehlerbilder mit eigenem Satz", () => {
  const cases: Array<[string, Partial<import("../src/setup/context").CommandResult>, string]> = [
    ["Port belegt", { code: 1, stderr: `Bind for 0.0.0.0:54422 failed: port is already allocated ${LOCAL.dbUrl}` }, "ein Port im Bereich 54420 bis 54429 belegt"],
    ["Speicherplatz", { code: 1, stderr: "write /var/lib/docker/tmp: no space left on device" }, "Speicherplatz für die Docker-Images fehlt"],
    ["Zeitlimit", { code: -1, timedOut: true }, "nach 20 Minuten noch nicht gestartet"],
    ["sonst", { code: 1, stderr: `unbekannt ${LOCAL.secret}` }, "--debug"],
  ];
  for (const [name, result, text] of cases) {
    test(name, async () => {
      const s = await setup({ f: fakeLocal({ "supabase start": result }) });
      const r = await s.run();
      expect(r.ok).toBe(false);
      expect(r.message).toContain(text);
      // Nichts lief: nur nachgesehen, nichts gestoppt
      expect(s.f.trail().slice(-2)).toEqual(["supabase start", "docker ps"]);
      expect(s.f.sessions).toEqual([]);
      expect(await envOf(s)).toBe(BASE_ENV);
      noSecrets(s, r);
    });
  }

  test("Abbruch während start: Signal an den Befehl, Meldung, .env unverändert", async () => {
    let s!: Setup;
    const f = fakeLocal({
      "supabase start": (_cmd, options) => {
        s.controller.abort();
        expect(options.signal?.aborted).toBe(true);
        return { code: -1, aborted: true };
      },
    });
    s = await setup({ f });
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("Abgebrochen.");
    expect(f.trail()).not.toContain("supabase status");
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Abbruch vor dem Start: nichts gestartet", async () => {
    const s = await setup();
    s.controller.abort();
    const r = await s.run();
    expect(r.message).toBe("Abgebrochen. Es wurde nichts gestartet, die .env ist unverändert.");
    expect(s.f.run.calls).toEqual([]);
  });

  test("Abbruch beim Schema: Sitzung geschlossen, keine weiteren Dateien, .env unverändert", async () => {
    const s = await setup();
    let files = 0;
    s.f.onFile = () => {
      if (++files === 1) s.controller.abort();
    };
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Abgebrochen. Supabase läuft");
    expect(files).toBe(1);
    expect(s.f.sessions[0].closed).toBe(true);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Ports aus dem Heimnetz erreichbar: gestoppt (ohne --no-backup), Stopp nachgeprüft, Hinweis, .env unverändert", async () => {
    const f = fakeLocal();
    f.lan = [54422];
    const s = await setup({ f });
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("nicht nur auf diesem Rechner erreichbar");
    expect(r.message).toContain("wieder gestoppt");
    expect(f.trail().slice(3)).toEqual(["docker network inspect", "docker network create", "supabase start", "docker ps", "supabase stop", "docker ps"]);
    expect(f.run.calls.find(c => shortName(c.cmd) === "supabase stop")!.cmd).toEqual([...CLI_PREFIX, "stop", "--workdir", s.ctx.root]);
    expect(f.sessions).toEqual([]);
    expect(await envOf(s)).toBe(BASE_ENV);
    safeCommands(f);
  });

  test("Abhilfe: Netz-Option statt daemon.json \"ip\" (gilt nur für das Standard-Netz)", async () => {
    const f = fakeLocal();
    f.lan = [54421];
    const s = await setup({ f });
    const r = await s.run();
    expect(r.message).toContain(`docker network rm ${LOCAL_NETWORK}`);
    expect(r.message).toContain("com.docker.network.bridge.host_binding_ipv4");
    expect(r.message).toContain('"ip" gilt nur für das Standard-Netz');
    expect(r.message).not.toContain("daemon.json");
    expect(r.message).toContain(stopHint(s.ctx.root));
  });

  test("offene Bindung ohne Adresse im Heimnetz: erkannt über docker ps, gestoppt", async () => {
    const f = fakeLocal();
    f.afterStart = OPEN_CONTAINERS;
    let probed = false;
    f.deps.lanReachable = async () => ((probed = true), []); // keine Netzadresse: Probe findet nichts
    const s = await setup({ f });
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("nicht nur auf diesem Rechner erreichbar");
    expect(r.message).toContain("wieder gestoppt");
    expect(probed).toBe(false);
    expect(f.trail()).toContain("supabase stop");
    expect(f.containers).toEqual([]);
    expect(f.sessions).toEqual([]);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("docker ps scheitert nach dem Start: nicht prüfbar zählt als offen, gestoppt", async () => {
    const f = fakeLocal();
    let n = 0;
    f.answers["docker ps"] = () => (++n === 1 ? { code: 1, stderr: "Fehler" } : { stdout: f.containers.join("\n") });
    const s = await setup({ f });
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("wieder gestoppt");
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Schutz-Stopp scheitert: keine Meldung „wieder gestoppt“, sondern Warnung mit Befehl", async () => {
    for (const variant of ["code", "läuft-weiter", "zeitlimit"] as const) {
      const f = fakeLocal();
      f.lan = [54421];
      if (variant === "code") f.answers["supabase stop"] = { code: 1, stderr: "failed to stop" };
      if (variant === "läuft-weiter") f.stopKeeps = true;
      if (variant === "zeitlimit") f.answers["supabase stop"] = { code: -1, timedOut: true };
      const s = await setup({ f });
      const r = await s.run();
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain("wieder gestoppt");
      expect(r.message).toContain("das Anhalten ist fehlgeschlagen");
      expect(r.message).toContain(stopHint(s.ctx.root));
      expect(r.message).toContain("docker ps --filter label=com.supabase.cli.project=tybo");
      expect(await envOf(s)).toBe(BASE_ENV);
    }
  });

  test("Startfehler mit laufenden, offenen Containern: Schutz-Stopp, Erfolg nachgeprüft", async () => {
    const f = fakeLocal({ "supabase start": { code: 1, stderr: "failed to start docker container supabase_rest_tybo" } });
    f.afterStart = OPEN_CONTAINERS;
    const s = await setup({ f });
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Supabase ließ sich nicht starten");
    expect(r.message).toContain("wieder gestoppt");
    expect(f.trail().slice(-4)).toEqual(["supabase start", "docker ps", "supabase stop", "docker ps"]);
    expect(f.containers).toEqual([]);
    expect(await envOf(s)).toBe(BASE_ENV);
    safeCommands(f);
  });

  test("Startfehler mit laufenden Containern nur an 127.0.0.1: bleiben, Heimnetz geprüft, klar gemeldet", async () => {
    const f = fakeLocal({ "supabase start": { code: 1, stderr: "failed" } });
    f.afterStart = SAFE_CONTAINERS;
    const s = await setup({ f });
    const r = await s.run();
    expect(r.message).toContain("nur auf diesem Rechner erreichbar");
    expect(f.trail()).not.toContain("supabase stop");
    // Antworten die Ports doch aus dem Heimnetz: gestoppt
    const g = fakeLocal({ "supabase start": { code: 1, stderr: "failed" } });
    g.afterStart = SAFE_CONTAINERS;
    g.lan = [54422];
    const t = await setup({ f: g });
    const r2 = await t.run();
    expect(r2.message).toContain("wieder gestoppt");
  });

  test("Abbruch während start mit offenen Containern: Schutz-Stopp ohne das ausgelöste Signal", async () => {
    let s!: Setup;
    const f = fakeLocal({
      "supabase start": () => {
        s.controller.abort();
        return { code: -1, aborted: true };
      },
    });
    f.afterStart = OPEN_CONTAINERS;
    s = await setup({ f });
    const r = await s.run();
    expect(r.message).toStartWith("Abgebrochen.");
    expect(r.message).toContain("wieder gestoppt");
    const stop = f.run.calls.find(c => shortName(c.cmd) === "supabase stop")!;
    expect(stop.options.signal).toBeUndefined();
    expect(f.containers).toEqual([]);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Zeitlimit beim Start mit offenen Containern: Schutz-Stopp; scheitert er, Warnung", async () => {
    const f = fakeLocal({ "supabase start": { code: -1, timedOut: true } });
    f.afterStart = OPEN_CONTAINERS;
    const s = await setup({ f });
    const r = await s.run();
    expect(r.message).toContain("nach 20 Minuten");
    expect(r.message).toContain("wieder gestoppt");
    const g = fakeLocal({ "supabase start": { code: -1, timedOut: true } });
    g.afterStart = OPEN_CONTAINERS;
    g.stopKeeps = true;
    const t = await setup({ f: g });
    const r2 = await t.run();
    expect(r2.message).not.toContain("wieder gestoppt");
    expect(r2.message).toContain("das Anhalten ist fehlgeschlagen");
  });

  test("vorhandenes Netz ohne Bindung an 127.0.0.1: nichts gestartet, Abhilfe", async () => {
    for (const stdout of ["{}", '{"com.docker.network.bridge.host_binding_ipv4":"0.0.0.0"}', "kaputt"]) {
      const f = fakeLocal({ "docker network inspect": { stdout } });
      const s = await setup({ f });
      const r = await s.run();
      expect(r.ok).toBe(false);
      expect(r.message).toContain(`docker network rm ${LOCAL_NETWORK}`);
      expect(r.message).toContain("Der Assistent hat nichts gestartet");
      expect(f.trail()).not.toContain("supabase start");
      expect(f.trail()).not.toContain("docker network create");
      // Nichts lief: nur nachgesehen
      expect(f.trail()).not.toContain("supabase stop");
    }
    // Laufen im offenen Netz schon Container (von Hand gestartet): Schutz-Stopp, nachgeprüft
    const running = fakeLocal({ "docker network inspect": { stdout: "{}" } });
    running.containers = OPEN_CONTAINERS;
    const t = await setup({ f: running });
    const r2 = await t.run();
    expect(r2.message).toContain("wieder gestoppt");
    expect(running.trail().slice(-3)).toEqual(["docker ps", "supabase stop", "docker ps"]);
    expect(running.containers).toEqual([]);
    // Mit Option: wird genommen, nicht neu angelegt
    const ok = fakeLocal({ "docker network inspect": { stdout: '{"com.docker.network.bridge.host_binding_ipv4":"127.0.0.1"}' } });
    const s = await setup({ f: ok });
    expect((await s.run()).ok).toBe(true);
    expect(ok.trail()).not.toContain("docker network create");
  });

  test("Netz lässt sich nicht anlegen oder nicht abfragen: nichts gestartet", async () => {
    const a = await setup({ f: fakeLocal({ "docker network create": { code: 1, stderr: "Fehler" } }) });
    expect((await a.run()).message).toContain("ließ sich nicht anlegen");
    expect(a.f.trail()).not.toContain("supabase start");
    const b = await setup({ f: fakeLocal({ "docker network inspect": { code: 1, stderr: "Cannot connect" } }) });
    expect((await b.run()).message).toContain("nicht fragen");
    expect(b.f.trail()).not.toContain("supabase start");
  });

  test("status: ungültiges JSON, fehlende Schlüssel, fremde Adresse, Fehler", async () => {
    const variants: Array<[Partial<import("../src/setup/context").CommandResult>, string]> = [
      [{ stdout: "kein json" }, "keine lesbare Antwort"],
      [{ stdout: statusJson({ SECRET_KEY: undefined, SERVICE_ROLE_KEY: undefined }) }, "keinen Schlüssel"],
      [{ stdout: statusJson({ DB_URL: undefined }) }, "keinen Schlüssel"],
      [{ stdout: statusJson({ API_URL: "http://192.168.1.20:54421" }) }, "nicht auf diesem Rechner"],
      [{ stdout: statusJson({ DB_URL: `postgresql://postgres:${LOCAL.dbPassword}@10.0.0.5:54422/postgres` }) }, "nicht auf diesem Rechner"],
      [{ stdout: statusJson({ API_URL: "http://127.0.0.1:54321" }) }, "nicht auf diesem Rechner"],
      [{ code: 1, stderr: `failed ${LOCAL.dbUrl}` }, "antwortet nicht"],
    ];
    for (const [answer, text] of variants) {
      const s = await setup({ f: fakeLocal({ "supabase status": answer }) });
      const r = await s.run();
      expect(r.ok).toBe(false);
      expect(r.message).toContain(text);
      expect(s.f.sessions).toEqual([]);
      expect(await envOf(s)).toBe(BASE_ENV);
      noSecrets(s, r);
    }
  });

  test("Schema-Fehler: fester Satz ohne Postgres-Text, Sitzung geschlossen, .env unverändert", async () => {
    const s = await setup();
    s.f.onFile = () => {
      throw new Error(`connection to ${LOCAL.dbUrl} failed: syntax error`);
    };
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Die Tabellen ließen sich nicht einspielen.");
    expect(r.message).not.toContain("syntax error");
    expect(s.f.sessions[0].closed).toBe(true);
    expect(await envOf(s)).toBe(BASE_ENV);
    noSecrets(s, r);
  });

  test("öffentlicher Bilder-Ordner: Abbruch vor dem Schema (das ihn sonst still umstellen würde)", async () => {
    const s = await setup();
    s.f.onQuery = text => (text.startsWith("select public from storage.buckets") ? [{ public: true }] : []);
    const r = await s.run();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("öffentlich");
    expect(s.f.sessions[0].ops).toEqual(["query:select public from storage.buckets where id = 'tybo-assets';"]);
    expect(s.f.sessions[0].closed).toBe(true);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Bilder-Ordner-Fehler: fester Satz", async () => {
    const s = await setup();
    s.f.onQuery = text => {
      if (text.includes("insert into storage.buckets")) throw new Error(`relation storage.buckets does not exist ${LOCAL.dbUrl}`);
      return [];
    };
    const r = await s.run();
    expect(r.message).toContain("Der Bilder-Ordner ließ sich nicht prüfen oder anlegen");
    noSecrets(s, r);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("eigener Name für den Bilder-Ordner; ungültiger Name: nichts gestartet", async () => {
    const own = await setup({ env: `${BASE_ENV}SUPABASE_ASSETS_BUCKET=meine-bilder\n` });
    expect((await own.run()).ok).toBe(true);
    expect(own.f.sessions[0].ops[0]).toBe("query:select public from storage.buckets where id = 'meine-bilder';");
    const bad = await setup({ env: `${BASE_ENV}SUPABASE_ASSETS_BUCKET=X'; drop table x;--\n` });
    const r = await bad.run();
    expect(r.ok).toBe(false);
    expect(bad.f.run.calls).toEqual([]);
  });
});

describe("Hilfen", () => {
  test("compareVersions", () => {
    expect(compareVersions("2.118.0", MIN_SUPABASE_CLI)).toBe(1);
    expect(compareVersions("2.45.0", "2.45.0")).toBe(0);
    expect(compareVersions("2.44.9", "2.45.0")).toBe(-1);
    expect(compareVersions(SUPABASE_CLI_VERSION, MIN_SUPABASE_CLI)).toBeGreaterThanOrEqual(0);
  });

  test("Anleitungen: bunx --bun und dieselbe Dienstauswahl wie der Assistent", () => {
    expect(cliHint("--version")).toBe(`bunx --bun supabase@${SUPABASE_CLI_VERSION} --version`);
    expect(startHint("/p")).toBe(`bunx --bun supabase@${SUPABASE_CLI_VERSION} start --workdir /p -x ${AUSGELASSEN}`);
    expect(stopHint("/p")).toBe(`bunx --bun supabase@${SUPABASE_CLI_VERSION} stop --workdir /p`);
  });

  test("bindingsOf: nur 127.0.0.1 bzw. ::1 gilt als sicher", () => {
    expect(bindingsOf("127.0.0.1:54421->8000/tcp, 8443/tcp")).toBe("sicher");
    expect(bindingsOf("[::1]:54421->8000/tcp")).toBe("sicher");
    expect(bindingsOf("")).toBe("sicher");
    expect(bindingsOf("0.0.0.0:54421->8000/tcp")).toBe("offen");
    expect(bindingsOf("127.0.0.1:54421->8000/tcp, [::]:54421->8000/tcp")).toBe("offen");
    expect(bindingsOf(":::54422->5432/tcp")).toBe("offen");
    expect(bindingsOf("192.168.1.20:54421->8000/tcp")).toBe("offen");
    expect(bindingsOf("0.0.0.0:54420-54421->8000-8001/tcp")).toBe("offen");
  });

  test("parseStatus liest JSON auch nach Hinweiszeilen, localhost zählt als lokal", () => {
    const parsed = parseStatus(`Hinweis\n${statusJson({ API_URL: "http://localhost:54421" })}`);
    expect("problem" in parsed).toBe(false);
  });
});

describe("echte Ports ohne Docker", () => {
  test("bunSqlRunner: Fehler ohne Datenbank wird geworfen, close wirft nie, Abbruch schließt", async () => {
    const { bunSqlRunner } = await import("../src/setup/local-supabase");
    const controller = new AbortController();
    const session = bunSqlRunner("postgresql://postgres:x@127.0.0.1:1/postgres", controller.signal);
    await expect(session.query("select 1")).rejects.toBeDefined();
    controller.abort();
    await session.close();
    await session.close();
  });

  test("defaultLanReachable: nur auf 127.0.0.1 lauschend ist nicht erreichbar, auf allen Schnittstellen schon", async () => {
    const { defaultLanReachable } = await import("../src/setup/local-supabase");
    const { networkInterfaces } = await import("node:os");
    const local = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const all = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
    try {
      expect(await defaultLanReachable([local.port])).toEqual([]);
      const hasLan = Object.values(networkInterfaces()).flat().some(a => a && !a.internal && a.family === "IPv4");
      if (hasLan) expect(await defaultLanReachable([all.port])).toEqual([all.port]);
    } finally {
      local.stop(true);
      all.stop(true);
    }
  });
});
