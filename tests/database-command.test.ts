/**
 * Issue #165, Checkbox 1: `tybo datenbank start|stop|status|sichern` gegen
 * Attrappen für docker, die Supabase-CLI (bunx) und tar. Die Uhr ist eine
 * Attrappe (sleep schiebt sie vor), nichts wartet echt, es läuft kein echtes
 * Docker. Geschrieben wird nur in Testordner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTybo } from "../scripts/tybo";
import type { RunOptions, SetupContext } from "../src/setup/context";
import {
  AUSGELASSEN,
  BACKUP_MANIFEST,
  BACKUP_PARTS,
  DB_CONTAINER,
  DOCKER_WAIT_MS,
  EDGE_CONTAINER,
  EXCLUDED_SERVICES,
  excludedFor,
  formatBytes,
  LOCAL_STUDIO_PORT,
  LOCAL_SUPABASE_URL,
  parseDatabaseArgs,
  parseDockerSize,
  runDatabaseCommand,
  STORAGE_CONTAINER,
  STUDIO_CONTAINER,
  tyboVolumes,
} from "../src/setup/local-supabase";
import { cleanup, makeCtx } from "./setup-fixture";
import { CLI_PREFIX, fakeLocal, LOCAL_SECRETS, OPEN_CONTAINERS, SAFE_CONTAINERS, shortName, type FakeLocal } from "./local-supabase-fixture";

afterAll(cleanup);

const LOCAL_ENV = { SUPABASE_URL: LOCAL_SUPABASE_URL };
/** Laufender Stack wie nach einem Start mit Edge Runtime und Storage */
const FULL = [...SAFE_CONTAINERS, `${EDGE_CONTAINER}\t`, `${STORAGE_CONTAINER}\t`];

interface Harness {
  ctx: SetupContext;
  f: FakeLocal;
  out: string[];
  err: string[];
  /** Uhr der Attrappe in ms seit Start */
  elapsed(): number;
  sleeps: number[];
  run(args: string[], env?: Record<string, string | undefined>, extra?: { signal?: AbortSignal; cwd?: string }): Promise<number>;
}

async function harness(f: FakeLocal = fakeLocal()): Promise<Harness> {
  const t0 = new Date("2026-09-27T08:05:00").getTime();
  let clock = t0;
  const sleeps: number[] = [];
  const ctx = await makeCtx({
    overrides: {
      run: f.run,
      localSupabase: f.deps,
      now: () => new Date(clock),
      sleep: async ms => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  });
  const h: Harness = {
    ctx,
    f,
    out: [],
    err: [],
    elapsed: () => clock - t0,
    sleeps,
    run: (args, env = LOCAL_ENV, extra = {}) =>
      runDatabaseCommand(args, { ctx, env, out: l => h.out.push(l), err: l => h.err.push(l), deps: f.deps as any, ...extra }),
  };
  // Uhr für Attrappen, die „hängen“
  (h as any).advance = (ms: number) => (clock += ms);
  return h;
}

const startCalls = (f: FakeLocal) => f.run.calls.filter(c => shortName(c.cmd) === "supabase start").map(c => c.cmd);

/** Nie --no-backup, nie --all, keine Shell */
function safeCommands(f: FakeLocal) {
  for (const { cmd } of f.run.calls) {
    expect(cmd).not.toContain("--no-backup");
    expect(cmd).not.toContain("--all");
    expect(["sh", "bash", "zsh", "/bin/sh"]).not.toContain(cmd[0]);
  }
}

function noSecrets(h: Harness) {
  const text = [...h.out, ...h.err].join("\n");
  for (const secret of LOCAL_SECRETS) expect(text.includes(secret)).toBe(false);
  expect(text).not.toContain("postgresql://");
  expect(text).not.toMatch(/sb_secret|sb_publishable|eyJ/);
}

describe("Argumente und Hilfe", () => {
  test("parseDatabaseArgs", () => {
    expect(parseDatabaseArgs(["start"])).toEqual({ command: "start", studio: false });
    expect(parseDatabaseArgs(["start", "--studio"])).toEqual({ command: "start", studio: true });
    expect(parseDatabaseArgs(["stop"])).toEqual({ command: "stop" });
    expect(parseDatabaseArgs(["status"])).toEqual({ command: "status" });
    expect(parseDatabaseArgs(["sichern"])).toEqual({ command: "sichern" });
    expect(parseDatabaseArgs(["sichern", "--ziel", "/x"])).toEqual({ command: "sichern", ziel: "/x" });
    expect(parseDatabaseArgs(["sichern", "--ziel=/x"])).toEqual({ command: "sichern", ziel: "/x" });
    expect(parseDatabaseArgs([])).toEqual({ command: "help" });
    for (const bad of [["stop", "--all"], ["stop", "--no-backup"], ["start", "--x"], ["sichern", "--ziel"], ["loeschen"]]) {
      expect(parseDatabaseArgs(bad)).toBeNull();
    }
  });

  test("tybo help nennt den Befehl, tybo datenbank help die Unterbefehle", async () => {
    const out: string[] = [];
    expect(await runTybo({ args: ["help"], env: {}, root: "/nirgends", out: l => out.push(l), err: () => {} })).toBe(0);
    expect(out.join("\n")).toContain("tybo datenbank <start|stop|status|sichern>");
    out.length = 0;
    expect(await runTybo({ args: ["datenbank", "help"], env: {}, root: "/nirgends", out: l => out.push(l), err: () => {} })).toBe(0);
    const help = out.join("\n");
    for (const word of ["start", "--studio", "stop", "status", "sichern", "--ziel"]) expect(help).toContain(word);
  });

  test("unbekannter Unterbefehl: Exit 2, nichts ausgeführt", async () => {
    const h = await harness();
    expect(await h.run(["stop", "--no-backup"])).toBe(2);
    expect(h.f.run.calls).toEqual([]);
  });
});

describe("nur für Supabase auf diesem Rechner", () => {
  for (const [label, url, text] of [
    ["Cloud", "https://abcdefgh.supabase.co", "Diese Installation nutzt Supabase in der Cloud"],
    ["eigener Server", "https://db.example.org", "Diese Installation nutzt Supabase in der Cloud"],
    ["fehlt", undefined, "nutzt kein Supabase auf diesem Rechner"],
    ["anderer lokaler Port", "http://127.0.0.1:54321", "anderes Supabase auf diesem Rechner"],
  ] as const) {
    test(`${label}: nur der Hinweis, Exit 1, kein Befehl`, async () => {
      for (const args of [["start"], ["start", "--studio"], ["stop"], ["status"], ["sichern"]]) {
        const h = await harness();
        expect(await h.run(args, { SUPABASE_URL: url })).toBe(1);
        expect(h.err.join(" ")).toContain(text);
        expect(h.out).toEqual([]);
        expect(h.f.run.calls).toEqual([]);
      }
    });
  }

  test("über runTybo: SUPABASE_URL aus der .env des Projekts zählt", async () => {
    const f = fakeLocal();
    const ctx = await makeCtx({ env: "SUPABASE_URL=https://abcdefgh.supabase.co\n", overrides: { run: f.run } });
    const err: string[] = [];
    const code = await runTybo({ args: ["datenbank", "start"], env: { SUPABASE_URL: LOCAL_SUPABASE_URL }, root: ctx.root, out: () => {}, err: l => err.push(l), setup: { ctx, onInterrupt: () => () => {} } });
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("Diese Installation nutzt Supabase in der Cloud");
    expect(f.run.calls).toEqual([]);
  });
});

describe("start", () => {
  test("wartet auf Docker (alle 5 s, Meldung einmal), dann supabase start mit --workdir und AUSGELASSEN", async () => {
    const f = fakeLocal();
    let infos = 0;
    f.answers["docker info"] = () => (++infos <= 3 ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : { stdout: "28.4.0" });
    const h = await harness(f);
    expect(await h.run(["start"])).toBe(0);
    expect(h.out.filter(l => l.startsWith("Warte auf Docker")).length).toBe(1);
    expect(h.sleeps).toEqual([5000, 5000, 5000]);
    expect(startCalls(f)).toEqual([[...CLI_PREFIX, "start", "--workdir", h.ctx.root, "-x", AUSGELASSEN]]);
    const start = f.run.calls.find(c => shortName(c.cmd) === "supabase start")!;
    expect(start.options.cwd).toBe(h.ctx.root);
    expect(Object.keys(start.options.env ?? {}).some(k => k.startsWith("SUPABASE_"))).toBe(false);
    expect(h.out.join("\n")).toContain(`Supabase läuft auf diesem Rechner: ${LOCAL_SUPABASE_URL}`);
    // Netz vor dem Start, Schutzprüfung danach
    const trail = f.trail();
    expect(trail.indexOf("docker network inspect")).toBeLessThan(trail.indexOf("supabase start"));
    expect(trail.lastIndexOf("docker ps")).toBeGreaterThan(trail.indexOf("supabase start"));
    safeCommands(f);
    noSecrets(h);
  });

  test("Docker kommt nicht: Abbruch nach 5 Minuten mit klarer Meldung, kein Start", async () => {
    const f = fakeLocal({ "docker info": { code: 1, stderr: "Cannot connect to the Docker daemon" } });
    const h = await harness(f);
    expect(await h.run(["start"])).toBe(1);
    expect(h.err.join(" ")).toContain("Docker läuft nach 5 Minuten noch nicht");
    expect(h.elapsed()).toBe(DOCKER_WAIT_MS);
    expect(f.trail()).not.toContain("supabase start");
    expect(f.trail()).not.toContain("docker network create");
  });

  test("hängendes docker info zählt zur Frist: nie länger als 5 Minuten", async () => {
    const f = fakeLocal();
    let h!: Harness;
    f.answers["docker info"] = (_cmd, options: RunOptions) => {
      // Hängt bis zum Zeitlimit des Aufrufs
      (h as any).advance(options.timeoutMs);
      return { code: -1, timedOut: true };
    };
    h = await harness(f);
    expect(await h.run(["start"])).toBe(1);
    expect(h.err.join(" ")).toContain("nach 5 Minuten");
    expect(h.elapsed()).toBeLessThanOrEqual(DOCKER_WAIT_MS + 1000);
    const timeouts = f.run.calls.filter(c => shortName(c.cmd) === "docker info").map(c => c.options.timeoutMs!);
    expect(timeouts.every(t => t <= 30_000)).toBe(true);
  });

  test("Docker fehlt ganz: sofort Hinweis, kein Warten", async () => {
    const h = await harness(fakeLocal({ "docker --version": { code: -1, stderr: "Befehl nicht gefunden" } }));
    expect(await h.run(["start"])).toBe(1);
    expect(h.err.join(" ")).toContain("Docker fehlt");
    expect(h.sleeps).toEqual([]);
  });

  test("--studio: studio und postgres-meta nicht ausgelassen, Adresse genannt, Studio-Port in der Schutzprüfung", async () => {
    const f = fakeLocal();
    const probed: number[][] = [];
    f.deps.lanReachable = async ports => {
      probed.push(ports);
      return [];
    };
    const h = await harness(f);
    expect(await h.run(["start", "--studio"])).toBe(0);
    const x = startCalls(f)[0].at(-1)!.split(",");
    expect(x).not.toContain("studio");
    expect(x).not.toContain("postgres-meta");
    expect(x.sort()).toEqual(EXCLUDED_SERVICES.filter(s => s !== "studio" && s !== "postgres-meta").sort());
    expect(excludedFor(false)).toBe(AUSGELASSEN);
    expect(h.out.join("\n")).toContain(`http://127.0.0.1:${LOCAL_STUDIO_PORT}`);
    expect(probed.flat()).toContain(LOCAL_STUDIO_PORT);
  });

  test("Studio aus dem Heimnetz erreichbar: angehalten, Exit 1", async () => {
    const f = fakeLocal();
    f.lan = [LOCAL_STUDIO_PORT];
    const h = await harness(f);
    expect(await h.run(["start", "--studio"])).toBe(1);
    expect(f.trail()).toContain("supabase stop");
    expect(h.err.join(" ")).toContain("nicht nur auf diesem Rechner erreichbar");
  });

  test("Studio zuschalten bei laufendem Minimal-Stack: erst anhalten (ohne --no-backup), dann mit Studio starten", async () => {
    const f = fakeLocal();
    f.containers = FULL;
    const h = await harness(f);
    expect(await h.run(["start", "--studio"])).toBe(0);
    const trail = f.trail();
    expect(trail.indexOf("supabase stop")).toBeLessThan(trail.indexOf("supabase start"));
    expect(h.out.join("\n")).toContain("läuft ohne Studio");
    safeCommands(f);
  });

  test("nach Neustart fehlt Edge Runtime (keine Neustart-Regel): anhalten und neu starten", async () => {
    const f = fakeLocal();
    f.containers = [...SAFE_CONTAINERS, `${STORAGE_CONTAINER}\t`];
    const h = await harness(f);
    expect(await h.run(["start"])).toBe(0);
    const trail = f.trail();
    expect(trail.filter(t => t === "supabase stop").length).toBe(1);
    expect(trail.indexOf("supabase stop")).toBeLessThan(trail.indexOf("supabase start"));
    expect(h.out.join("\n")).toContain("läuft ohne Edge Runtime");
  });

  describe("Anhalten für den Neustart scheitert: Schutzprüfung, kein Start", () => {
    /** Erster supabase stop (Neustart) scheitert, der zweite (Schutz-Stopp) nach Vorgabe */
    function failingRestartStop(guardStop: { code: number }) {
      let stops = 0;
      return fakeLocal({
        "supabase stop": () => (++stops === 1 ? { code: 1, stderr: "Error: failed to stop container" } : guardStop),
      });
    }

    test("Ports nur an 127.0.0.1: läuft weiter, kein Schutz-Stopp, Exit 1", async () => {
      const f = failingRestartStop({ code: 0 });
      f.containers = [...SAFE_CONTAINERS, `${STORAGE_CONTAINER}\t`];
      const h = await harness(f);
      expect(await h.run(["start"])).toBe(1);
      const trail = f.trail();
      expect(trail.filter(t => t === "supabase stop").length).toBe(1);
      expect(trail).not.toContain("supabase start");
      // Schutzprüfung nach dem gescheiterten Stopp: docker ps und Heimnetz
      expect(trail.lastIndexOf("docker ps")).toBeGreaterThan(trail.indexOf("supabase stop"));
      const text = h.err.join(" ");
      expect(text).toContain("ließ sich für den Neustart nicht anhalten");
      expect(text).toContain("nur auf diesem Rechner erreichbar");
      expect(text).toContain("tybo datenbank start");
      safeCommands(f);
    });

    test("offene Bindungen: Schutz-Stopp, Meldung dazu, Exit 1", async () => {
      const f = failingRestartStop({ code: 0 });
      f.containers = OPEN_CONTAINERS;
      const h = await harness(f);
      expect(await h.run(["start"])).toBe(1);
      const trail = f.trail();
      expect(trail.filter(t => t === "supabase stop").length).toBe(2);
      expect(trail).not.toContain("supabase start");
      expect(f.containers).toEqual([]);
      expect(h.err.join(" ")).toContain("wieder gestoppt (die Daten bleiben)");
      safeCommands(f);
    });

    test("aus dem Heimnetz erreichbar: Schutz-Stopp, Exit 1", async () => {
      const f = failingRestartStop({ code: 0 });
      f.containers = [...SAFE_CONTAINERS, `${STORAGE_CONTAINER}\t`];
      f.lan = [54422];
      const h = await harness(f);
      expect(await h.run(["start"])).toBe(1);
      expect(f.trail().filter(t => t === "supabase stop").length).toBe(2);
      expect(h.err.join(" ")).toContain("wieder gestoppt");
    });

    test("Bindungen unbekannt (docker ps scheitert) und Schutz-Stopp scheitert: eindeutige Warnung, Exit 1", async () => {
      const f = failingRestartStop({ code: 1 });
      f.containers = [...SAFE_CONTAINERS, `${STORAGE_CONTAINER}\t`];
      let ps = 0;
      f.answers["docker ps"] = () => (++ps === 1 ? { stdout: f.containers.map(c => `${c}\n`).join("") } : { code: 1, stderr: "Cannot connect to the Docker daemon" });
      const h = await harness(f);
      expect(await h.run(["start"])).toBe(1);
      expect(f.trail().filter(t => t === "supabase stop").length).toBe(2);
      expect(f.trail()).not.toContain("supabase start");
      const text = h.err.join(" ");
      expect(text).toContain("Achtung: Supabase-Dienste laufen womöglich noch");
      expect(text).toContain("docker stop <name>");
    });
  });

  test("läuft schon vollständig: kein Anhalten, Exit 0 (start ist wiederholbar)", async () => {
    const f = fakeLocal({ "supabase start": { stdout: "supabase start is already running." } });
    f.containers = FULL;
    f.afterStart = FULL;
    const h = await harness(f);
    expect(await h.run(["start"])).toBe(0);
    expect(f.trail()).not.toContain("supabase stop");
    expect(h.out.join("\n")).not.toContain("Studio läuft");
  });

  test("Studio läuft noch, start ohne --studio: Hinweis, nichts angehalten", async () => {
    const f = fakeLocal();
    f.containers = [...FULL, `${STUDIO_CONTAINER}\t127.0.0.1:54423->3000/tcp`];
    f.afterStart = f.containers;
    const h = await harness(f);
    expect(await h.run(["start"])).toBe(0);
    expect(f.trail()).not.toContain("supabase stop");
    expect(h.out.join("\n")).toContain("Studio läuft noch");
  });

  test("Netz ohne Bindung an 127.0.0.1: kein Start, laufende Container werden angehalten", async () => {
    const f = fakeLocal({ "docker network inspect": { stdout: "{}" } });
    f.containers = OPEN_CONTAINERS;
    const h = await harness(f);
    expect(await h.run(["start"])).toBe(1);
    expect(f.trail()).not.toContain("supabase start");
    expect(f.trail()).toContain("supabase stop");
    expect(h.err.join(" ")).toContain("ohne Bindung an 127.0.0.1");
  });

  test("Start scheitert: Schutzprüfung, Meldung nennt tybo datenbank start, keine CLI-Ausgabe", async () => {
    const f = fakeLocal({ "supabase start": { code: 1, stderr: "Error: port is already allocated\nsb_secret_lokalertestschluessel_geheim_1111" } });
    f.afterStart = OPEN_CONTAINERS;
    const h = await harness(f);
    expect(await h.run(["start"])).toBe(1);
    const text = h.err.join(" ");
    expect(text).toContain("Port im Bereich 54420 bis 54429");
    expect(text).toContain("tybo datenbank start");
    expect(f.trail().at(-2)).toBe("supabase stop");
    noSecrets(h);
  });

  test("nach dem Start offen: angehalten, Exit 1", async () => {
    const f = fakeLocal();
    f.afterStart = OPEN_CONTAINERS;
    const h = await harness(f);
    expect(await h.run(["start"])).toBe(1);
    expect(f.trail()).toContain("supabase stop");
    expect(h.err.join(" ")).toContain("nicht nur auf diesem Rechner erreichbar");
  });

  test("Strg+C beim Warten: Exit 130, kein Start", async () => {
    const f = fakeLocal({ "docker info": { code: 1 } });
    const h = await harness(f);
    const controller = new AbortController();
    h.ctx.sleep = async () => controller.abort();
    expect(await h.run(["start"], LOCAL_ENV, { signal: controller.signal })).toBe(130);
    expect(f.trail()).not.toContain("supabase start");
  });

  describe("Strg+C während supabase start", () => {
    /** supabase start wird mitten im Lauf abgebrochen; bis dahin gestartete Container nach Vorgabe */
    function abortingStart(controller: AbortController, partial: string[]) {
      const f = fakeLocal({
        "supabase start": () => {
          controller.abort();
          return { code: -1, stderr: "Abgebrochen", aborted: true };
        },
      });
      f.afterStart = partial;
      return f;
    }

    test("schon gestartete Teile nur an 127.0.0.1: Schutzprüfung, kein Stopp, Exit 130", async () => {
      const controller = new AbortController();
      const f = abortingStart(controller, SAFE_CONTAINERS);
      const h = await harness(f);
      expect(await h.run(["start"], LOCAL_ENV, { signal: controller.signal })).toBe(130);
      const trail = f.trail();
      expect(trail.lastIndexOf("docker ps")).toBeGreaterThan(trail.indexOf("supabase start"));
      expect(trail).not.toContain("supabase stop");
      const text = h.err.join(" ");
      expect(text).toContain("Abgebrochen.");
      expect(text).toContain("nur auf diesem Rechner erreichbar");
      noSecrets(h);
    });

    test("schon gestartete Teile offen: Schutz-Stopp ohne Signal, Exit 130", async () => {
      const controller = new AbortController();
      const f = abortingStart(controller, OPEN_CONTAINERS);
      const h = await harness(f);
      expect(await h.run(["start"], LOCAL_ENV, { signal: controller.signal })).toBe(130);
      const trail = f.trail();
      expect(trail.indexOf("supabase stop")).toBeGreaterThan(trail.indexOf("supabase start"));
      // Der Schutz-Stopp läuft trotz Abbruch zu Ende (ohne Signal)
      const stop = f.run.calls.find(c => shortName(c.cmd) === "supabase stop")!;
      expect(stop.options.signal).toBeUndefined();
      expect(f.containers).toEqual([]);
      expect(h.err.join(" ")).toContain("wieder gestoppt (die Daten bleiben)");
      safeCommands(f);
    });

    test("Schutz-Stopp scheitert: Warnung zum Anhalten von Hand, Exit 130", async () => {
      const controller = new AbortController();
      const f = abortingStart(controller, OPEN_CONTAINERS);
      f.stopKeeps = true;
      const h = await harness(f);
      expect(await h.run(["start"], LOCAL_ENV, { signal: controller.signal })).toBe(130);
      expect(h.err.join(" ")).toContain("Achtung: Supabase-Dienste laufen womöglich noch");
    });

    test("über runTybo: SIGINT-Handler bricht den Start ab, Exit 130, Handler wieder entfernt", async () => {
      let interrupt: (() => void) | null = null;
      let released = false;
      const f = fakeLocal({
        "supabase start": (_cmd, options) => {
          interrupt!();
          expect(options.signal?.aborted).toBe(true);
          return { code: -1, stderr: "", aborted: true };
        },
      });
      f.afterStart = OPEN_CONTAINERS;
      const ctx = await makeCtx({ env: `SUPABASE_URL=${LOCAL_SUPABASE_URL}\n`, overrides: { run: f.run, localSupabase: f.deps, sleep: async () => {} } });
      const err: string[] = [];
      const code = await runTybo({
        args: ["datenbank", "start"],
        env: {},
        root: ctx.root,
        out: () => {},
        err: l => err.push(l),
        setup: {
          ctx,
          onInterrupt: handler => {
            interrupt = handler;
            return () => (released = true);
          },
        },
      });
      expect(code).toBe(130);
      expect(released).toBe(true);
      expect(f.trail().indexOf("supabase stop")).toBeGreaterThan(f.trail().indexOf("supabase start"));
      expect(err.join(" ")).toContain("wieder gestoppt");
    });
  });

  test("Ausgabe von start (mit Schlüsseln) erscheint nie", async () => {
    const h = await harness();
    expect(await h.run(["start", "--studio"])).toBe(0);
    noSecrets(h);
    expect(h.out.join("\n")).not.toContain("Started supabase");
  });
});

describe("stop", () => {
  test("supabase stop --workdir, nie --no-backup oder --all", async () => {
    const f = fakeLocal();
    f.containers = FULL;
    const h = await harness(f);
    expect(await h.run(["stop"])).toBe(0);
    const stops = f.run.calls.filter(c => shortName(c.cmd) === "supabase stop").map(c => c.cmd);
    expect(stops).toEqual([[...CLI_PREFIX, "stop", "--workdir", h.ctx.root]]);
    expect(h.out.join(" ")).toContain("Die Daten bleiben");
    safeCommands(f);
  });

  test("Docker läuft nicht: nichts zu tun, Exit 0", async () => {
    const f = fakeLocal({ "docker info": { code: 1 } });
    const h = await harness(f);
    expect(await h.run(["stop"])).toBe(0);
    expect(f.trail()).not.toContain("supabase stop");
  });

  test("Anhalten scheitert: Exit 1 mit Befehl zum Anhalten von Hand", async () => {
    const f = fakeLocal();
    f.containers = FULL;
    f.stopKeeps = true;
    const h = await harness(f);
    expect(await h.run(["stop"])).toBe(1);
    expect(h.err.join(" ")).toContain("docker stop <name>");
  });
});

describe("status", () => {
  const DF = [
    "Images space usage:",
    "",
    "REPOSITORY   TAG   IMAGE ID   CREATED   SIZE   SHARED SIZE   UNIQUE SIZE   CONTAINERS",
    "public.ecr.aws/supabase/postgres   17.4   abc   2 weeks ago   2.9GB   0B   2.9GB   1",
    "",
    "Containers space usage:",
    "",
    "CONTAINER ID   IMAGE   COMMAND   LOCAL VOLUMES   SIZE   CREATED   STATUS   NAMES",
    "",
    "Local Volumes space usage:",
    "",
    "VOLUME NAME                   LINKS     SIZE",
    "supabase_db_tybo              1         120.5MB",
    "supabase_storage_tybo         1         3.2MB",
    "supabase_db_anderes           1         9GB",
    "",
    "Build cache usage: 0B",
  ].join("\n");

  test("läuft: Adresse, Dienste, Volumes gefiltert auf _tybo, keine Schlüssel, kein supabase status", async () => {
    const f = fakeLocal({ "docker system": { stdout: DF } });
    f.containers = FULL;
    const h = await harness(f);
    expect(await h.run(["status"])).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("Supabase auf diesem Rechner: läuft");
    expect(text).toContain(LOCAL_SUPABASE_URL);
    expect(text).toContain("supabase_db_tybo");
    expect(text).toContain("120.5MB");
    expect(text).not.toContain("supabase_db_anderes");
    expect(text).toContain("123,7 MB");
    expect(f.trail()).not.toContain("supabase status");
    expect(f.run.calls.find(c => c.cmd[1] === "system")!.cmd).toEqual(["docker", "system", "df", "-v"]);
    noSecrets(h);
  });

  test("läuft nicht: Exit 1 mit Startbefehl", async () => {
    const h = await harness(fakeLocal({ "docker system": { stdout: DF } }));
    expect(await h.run(["status"])).toBe(1);
    expect(h.out.join("\n")).toContain("läuft nicht");
    expect(h.out.join("\n")).toContain("tybo datenbank start");
  });

  test("Docker läuft nicht", async () => {
    const h = await harness(fakeLocal({ "docker info": { code: 1 } }));
    expect(await h.run(["status"])).toBe(1);
    expect(h.out.join("\n")).toContain("Docker läuft nicht");
  });

  test("Edge Runtime fehlt: Hinweis", async () => {
    const f = fakeLocal({ "docker system": { stdout: DF } });
    f.containers = [...SAFE_CONTAINERS, `${STORAGE_CONTAINER}\t`];
    const h = await harness(f);
    await h.run(["status"]);
    expect(h.out.join("\n")).toContain("Edge Runtime fehlt");
  });

  test("Größen", () => {
    expect(parseDockerSize("120.5MB")).toBe(120_500_000);
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("12kB")).toBe(12_000);
    expect(parseDockerSize("N/A")).toBeNull();
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_234_567)).toBe("1,2 MB");
    expect(tyboVolumes(DF).map(v => v.name)).toEqual(["supabase_db_tybo", "supabase_storage_tybo"]);
  });
});

describe("sichern", () => {
  /** Attrappe schreibt Platzhalter wie die echten Befehle */
  function backupFake(options: { failOn?: string; hang?: AbortController } = {}) {
    const f = fakeLocal();
    f.containers = FULL;
    f.answers["supabase db"] = async cmd => {
      const target = cmd[cmd.indexOf("-f") + 1];
      const kind = cmd.includes("storage") ? "storage" : cmd.includes("public") ? "daten" : "schema";
      if (options.failOn === kind) return { code: 1, stderr: `pg_dump: error: ${LOCAL_SECRETS[5]}` };
      if (options.hang && kind === "daten") {
        options.hang.abort();
        return { code: -1, aborted: true };
      }
      await writeFile(target, `-- Platzhalter ${kind}\n`);
      return {};
    };
    f.answers["docker cp"] = async cmd => {
      if (options.failOn === "bilder") return { code: 1 };
      await mkdir(join(cmd[3], "stub", "tybo-assets"), { recursive: true });
      await writeFile(join(cmd[3], "stub", "tybo-assets", "bild.jpg"), "jpg");
      return {};
    };
    f.answers.tar = async cmd => {
      await writeFile(cmd[2], "tar.gz-Platzhalter");
      return {};
    };
    return f;
  }

  test("vier Teile im Zielordner (0700), Dumps mit --local und --workdir, Reihenfolge Schema, Daten, Storage, Bilder", async () => {
    const f = backupFake();
    const h = await harness(f);
    expect(await h.run(["sichern"])).toBe(0);
    const dir = join(h.ctx.root, "data", "backups", "supabase-20260927-0805");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readdir(dir)).sort()).toEqual([...BACKUP_PARTS, BACKUP_MANIFEST].sort());
    for (const part of BACKUP_PARTS) expect((await stat(join(dir, part))).mode & 0o777).toBe(0o600);

    const dumps = f.run.calls.filter(c => shortName(c.cmd) === "supabase db").map(c => c.cmd.slice(CLI_PREFIX.length));
    expect(dumps).toEqual([
      ["db", "dump", "--local", "--workdir", h.ctx.root, "-f", join(dir, "schema.sql")],
      ["db", "dump", "--local", "--workdir", h.ctx.root, "--data-only", "-s", "public", "-f", join(dir, "daten.sql")],
      ["db", "dump", "--local", "--workdir", h.ctx.root, "--data-only", "-s", "storage", "-f", join(dir, "storage.sql")],
    ]);
    const cp = f.run.calls.find(c => c.cmd[0] === "docker" && c.cmd[1] === "cp")!;
    expect(cp.cmd).toEqual(["docker", "cp", `${STORAGE_CONTAINER}:/mnt/.`, join(dir, ".bilder")]);
    const tar = f.run.calls.find(c => c.cmd[0] === "tar")!;
    expect(tar.cmd).toEqual(["tar", "-czf", join(dir, "bilder.tar.gz"), "-C", join(dir, ".bilder"), "."]);
    expect(tar.options.env?.COPYFILE_DISABLE).toBe("1");
    const trail = f.trail();
    expect(trail.lastIndexOf("supabase db")).toBeLessThan(trail.indexOf("docker cp"));

    const manifest = await readFile(join(dir, BACKUP_MANIFEST), "utf8");
    expect(manifest).toContain("Reihenfolge: schema.sql, daten.sql, storage.sql, bilder.tar.gz");
    expect(h.out.at(-2)).toMatch(new RegExp(`^Sicherung fertig: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d`));
    safeCommands(f);
    noSecrets(h);
  });

  test("zwei Sicherungen in derselben Minute: zweiter Ordner, erste unberührt", async () => {
    const h = await harness(backupFake());
    expect(await h.run(["sichern"])).toBe(0);
    const first = join(h.ctx.root, "data", "backups", "supabase-20260927-0805");
    const before = await readFile(join(first, "schema.sql"), "utf8");
    await writeFile(join(first, "schema.sql"), `${before}-- markiert\n`);
    expect(await h.run(["sichern"])).toBe(0);
    expect((await readdir(join(h.ctx.root, "data", "backups"))).sort()).toEqual(["supabase-20260927-0805", "supabase-20260927-0805-2"]);
    expect(await readFile(join(first, "schema.sql"), "utf8")).toContain("-- markiert");
  });

  for (const part of ["schema", "daten", "storage", "bilder"]) {
    test(`Fehler bei ${part}: unvollständige Sicherung gelöscht, ältere bleibt, Exit 1, keine Rohausgabe`, async () => {
      const ok = await harness(backupFake());
      expect(await ok.run(["sichern", "--ziel", join(ok.ctx.root, "ziel")])).toBe(0);
      const f = backupFake({ failOn: part });
      f.containers = FULL;
      const h = await harness(f);
      // gleicher Zielordner, schon eine Sicherung darin
      h.ctx.now = () => new Date("2026-09-27T09:00:00");
      expect(await h.run(["sichern", "--ziel", join(ok.ctx.root, "ziel")])).toBe(1);
      expect(await readdir(join(ok.ctx.root, "ziel"))).toEqual(["supabase-20260927-0805"]);
      expect(h.err.join(" ")).toContain("unvollständige Sicherung ist gelöscht");
      noSecrets(h);
    });
  }

  test("Strg+C: Exit 130, nichts bleibt liegen", async () => {
    const controller = new AbortController();
    const h = await harness(backupFake({ hang: controller }));
    expect(await h.run(["sichern"], LOCAL_ENV, { signal: controller.signal })).toBe(130);
    expect(await readdir(join(h.ctx.root, "data", "backups"))).toEqual([]);
  });

  test("relatives --ziel gilt ab dem aktuellen Ordner", async () => {
    const h = await harness(backupFake());
    expect(await h.run(["sichern", "--ziel", "sicherungen"], LOCAL_ENV, { cwd: h.ctx.root })).toBe(0);
    expect(await readdir(join(h.ctx.root, "sicherungen"))).toEqual(["supabase-20260927-0805"]);
  });

  test("Ziel belegt (eine Datei): Exit 1, nichts gesichert", async () => {
    const f = backupFake();
    const h = await harness(f);
    await writeFile(join(h.ctx.root, "belegt"), "x");
    expect(await h.run(["sichern", "--ziel", join(h.ctx.root, "belegt")])).toBe(1);
    expect(h.err.join(" ")).toContain("ließ sich in");
    expect(f.trail()).not.toContain("supabase db");
  });

  test("Supabase läuft nicht: Exit 1, kein Dump", async () => {
    const f = backupFake();
    f.containers = [];
    const h = await harness(f);
    expect(await h.run(["sichern"])).toBe(1);
    expect(h.err.join(" ")).toContain("Supabase läuft nicht");
    expect(f.trail()).not.toContain("supabase db");
  });

  test("Docker läuft nicht: Exit 1", async () => {
    const f = backupFake();
    f.answers["docker info"] = { code: 1 };
    const h = await harness(f);
    expect(await h.run(["sichern"])).toBe(1);
    expect(h.err.join(" ")).toContain("Docker läuft nicht");
  });
});

test("Container-Namen passen zum project_id tybo", () => {
  expect(DB_CONTAINER).toBe("supabase_db_tybo");
  expect(SAFE_CONTAINERS.some(c => c.startsWith(`${DB_CONTAINER}\t`))).toBe(true);
});

describe("über den Einstieg tybo (wie unter launchd, Ausgabe = logs/supabase.log)", () => {
  test("datenbank start und status: Schlüssel aus der CLI-Ausgabe erscheinen weder auf stdout noch stderr; nie launchctl, pm2 oder supabase status", async () => {
    const f = fakeLocal({
      "supabase start": { stdout: `API URL: ${LOCAL_SUPABASE_URL}\nsecret key: ${LOCAL_SECRETS[0]}\nDB URL: ${LOCAL_SECRETS[5]}`, stderr: `anon key: ${LOCAL_SECRETS[1]}` },
      "docker system": { stdout: "Local Volumes space usage:\n\nVOLUME NAME LINKS SIZE\nsupabase_db_tybo 1 1GB\n" },
    });
    const ctx = await makeCtx({ env: `SUPABASE_URL=${LOCAL_SUPABASE_URL}\n`, overrides: { run: f.run, localSupabase: f.deps } });
    const lines: string[] = [];
    const io = { root: ctx.root, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), setup: { ctx, onInterrupt: () => () => {} } };
    expect(await runTybo({ args: ["datenbank", "start"], env: {}, ...io })).toBe(0);
    expect(await runTybo({ args: ["datenbank", "status"], env: {}, ...io })).toBe(0);
    const text = lines.join("\n");
    for (const secret of LOCAL_SECRETS) expect(text.includes(secret)).toBe(false);
    expect(text).toContain("Supabase läuft auf diesem Rechner");
    expect(f.run.calls.some(c => ["launchctl", "pm2", "npx"].includes(c.cmd[0]))).toBe(false);
    expect(f.trail()).not.toContain("supabase status");
  });
});

describe("Doku (docs/einrichtung.md, docs/troubleshooting.md)", () => {
  const docs = join(import.meta.dir, "..", "docs");
  test("Supabase lokal im Alltag: Befehle, Autostart, Wiederherstellung, Updates, Ressourcen, Grenzen", async () => {
    const doc = await readFile(join(docs, "einrichtung.md"), "utf8");
    const section = doc.slice(doc.indexOf("#### Supabase lokal im Alltag"), doc.indexOf("#### Zugangsdaten selbst eintragen"));
    for (const text of [
      "tybo datenbank start --studio",
      "tybo datenbank stop",
      "tybo datenbank status",
      "tybo datenbank sichern --ziel",
      "ai.tybo.supabase",
      "tybo-supabase",
      "logs/supabase.log",
      "Time Machine",
      "psql -U postgres -v ON_ERROR_STOP=1",
      "docker cp /tmp/tybo-bilder/. supabase_storage_tybo:/mnt/",
      "SUPABASE_CLI_VERSION",
      "**Nie** `supabase stop --no-backup`",
      "**Ressourcen.**",
      "**Grenzen.**",
    ]) {
      expect(section).toContain(text);
    }
    // Reihenfolge der Wiederherstellung
    expect(section.indexOf("< schema.sql")).toBeLessThan(section.indexOf("< daten.sql"));
    expect(section.indexOf("< daten.sql")).toBeLessThan(section.indexOf("< storage.sql"));
    expect(section).not.toContain("brew upgrade supabase");
    expect(section).not.toContain("—");
  });

  test("troubleshooting: Nach Neustart kein Gedächtnis", async () => {
    const doc = await readFile(join(docs, "troubleshooting.md"), "utf8");
    expect(doc).toContain("### Nach Neustart kein Gedächtnis");
    expect(doc).toContain("tybo datenbank status");
  });
});
