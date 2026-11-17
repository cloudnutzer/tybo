/**
 * Issue #368: Dienstkatalog (src/lib/services/catalog.ts) und
 * Plist-Generator (src/lib/services/plist.ts). Snapshot je Dienst, gültiges
 * XML auch bei Sonderzeichen in Pfaden (dekodiert wieder genau der Pfad),
 * Wrapper aus A1 mit genauen Argumenten, Bot und Supabase ohne Wrapper,
 * gleiche Eingaben ergeben dieselbe Datei. setUpService läuft nur gegen
 * Attrappen; kein echtes launchctl, kein plutil.
 */

import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { plistFile, selectServices, setUpService, type LaunchdDeps } from "../src/setup/services/launchd";
import type { SetupSchedule } from "../src/lib/proactive/setup-schedule";
import { SERVICE_CATALOG, SERVICE_NAMES, serviceDefinition, type ServiceName } from "../src/lib/services/catalog";
import { escapeXml, PlistError, programArguments, servicePlist, writePlist, type MachinePaths } from "../src/lib/services/plist";
import { launchdLabel } from "../src/lib/service-names";
import { decodeXml, plistProblem, plistStrings } from "./plist-structure";

const MACHINE: MachinePaths = {
  bun: "/opt/bun/bin/bun",
  claudeDir: "/home/test/.local/bin",
  home: "/home/test",
  projectRoot: "/home/test/tybo",
  exitTimeoutS: 330,
};

const SCHEDULE: SetupSchedule = {
  morning_briefing: { hour: 9, minute: 0, enabled: true },
  check_in_intervals: [
    { hour: 10, minute: 30 },
    { hour: 14, minute: 30 },
  ],
};

const MANAGED = SERVICE_CATALOG.filter(s => s.kind !== "external").map(s => s.name);
const WRAPPED: ServiceName[] = ["smart-checkin", "morning-briefing", "health-check", "software-update", "wartung"];

const plistOf = (name: ServiceName, machine = MACHINE, schedule = SCHEDULE) => servicePlist(serviceDefinition(name), machine, schedule);

describe("Katalog", () => {
  test("ein Eintrag je Dienstname, gleiche Reihenfolge; tybo dienste nimmt jeden Namen an", async () => {
    expect(SERVICE_CATALOG.map(s => s.name)).toEqual([...SERVICE_NAMES]);
    for (const name of SERVICE_NAMES) expect(await selectServices(name, "/gibt/es/nicht/.env")).toEqual([name]);
  });

  test("Arten: Bot dauernd, fünf Routinen über den Wrapper, Supabase einmal, zwei nur bekannt", () => {
    const kinds = Object.fromEntries(SERVICE_CATALOG.map(s => [s.name, s.kind]));
    expect(kinds).toEqual({
      "telegram-relay": "daemon",
      "smart-checkin": "routine",
      "morning-briefing": "routine",
      "whatsapp-gateway": "external",
      "cloudflare-tunnel": "external",
      "health-check": "routine",
      "software-update": "routine",
      supabase: "once",
      wartung: "routine",
    });
    expect(SERVICE_CATALOG.filter(s => s.wrapped).map(s => s.name).sort()).toEqual([...WRAPPED].sort());
    // Routine heißt immer Wrapper
    for (const s of SERVICE_CATALOG) expect([s.name, s.kind === "routine"]).toEqual([s.name, s.wrapped]);
    expect(SERVICE_CATALOG.filter(s => s.onlyExplicit).map(s => s.name)).toEqual(["software-update", "wartung"]);
  });

  test("Watchdog kommt nicht zurück", () => {
    expect(SERVICE_NAMES as readonly string[]).not.toContain("watchdog");
  });
});

describe("Snapshot je Dienst", () => {
  for (const name of MANAGED) {
    test(name, () => {
      const plist = plistOf(name);
      expect(plistProblem(plist)).toBeNull();
      expect(plist).toMatchSnapshot();
    });
  }

  test("dieselben Eingaben ergeben dieselbe Datei", () => {
    for (const name of MANAGED) expect(plistOf(name)).toBe(plistOf(name));
  });
});

describe("Wrapper aus A1", () => {
  test("Routinen: bun --no-env-file src/routine-run.ts --id <label> -- bun run <skript>", () => {
    const scripts: Record<string, string> = {
      "smart-checkin": "src/routines/checkin.ts",
      "morning-briefing": "src/routines/briefing.ts",
      "health-check": "src/health-check.ts",
      "software-update": "src/software-update.ts",
      wartung: "src/maintenance.ts",
    };
    for (const name of WRAPPED) {
      const expected = [MACHINE.bun, "--no-env-file", "src/routine-run.ts", "--id", launchdLabel(name), "--", MACHINE.bun, "run", scripts[name]];
      expect(programArguments(serviceDefinition(name), MACHINE)).toEqual(expected);
      expect(plistStrings(plistOf(name), "ProgramArguments")).toEqual(expected);
    }
  });

  test("Bot und Supabase ohne Wrapper", () => {
    expect(plistStrings(plistOf("telegram-relay"), "ProgramArguments")).toEqual([MACHINE.bun, "run", "src/bot.ts"]);
    expect(plistStrings(plistOf("supabase"), "ProgramArguments")).toEqual([MACHINE.bun, "--no-env-file", `${MACHINE.projectRoot}/scripts/tybo.ts`, "datenbank", "start"]);
    for (const name of ["telegram-relay", "supabase"] as const) expect(plistOf(name)).not.toContain("routine-run");
  });
});

describe("Startverhalten", () => {
  test("Bot: RunAtLoad, KeepAlive, ThrottleInterval 10", () => {
    const plist = plistOf("telegram-relay");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    expect(plist).not.toContain("StartCalendarInterval");
  });

  test("Routinen: nur Termine, kein KeepAlive, kein RunAtLoad", () => {
    for (const name of WRAPPED) {
      const plist = plistOf(name);
      expect(plist).toContain("<key>StartCalendarInterval</key>");
      expect(plist).not.toContain("KeepAlive");
      expect(plist).not.toContain("RunAtLoad");
    }
  });

  test("Supabase: einmal beim Laden, ExitTimeOut aus der Eingabe, kein KeepAlive, ein Protokoll", () => {
    const plist = plistOf("supabase");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>330<\/integer>/);
    expect(plist).not.toContain("KeepAlive");
    expect(plistStrings(plist, "StandardOutPath")).toEqual([`${MACHINE.projectRoot}/logs/supabase.log`]);
    expect(plistStrings(plist, "StandardErrorPath")).toEqual([`${MACHINE.projectRoot}/logs/supabase.log`]);
    expect(plist).not.toContain("GO_PROJECT_ROOT");
    expect(plistStrings(plist, "PATH")[0].split(":")).toContain(`${MACHINE.home}/.orbstack/bin`);
  });

  test("Protokolldateien und Umgebung je Dienst", () => {
    for (const name of MANAGED.filter(n => n !== "supabase")) {
      const plist = plistOf(name);
      expect(plistStrings(plist, "StandardOutPath")).toEqual([`${MACHINE.projectRoot}/logs/${name}.log`]);
      expect(plistStrings(plist, "StandardErrorPath")).toEqual([`${MACHINE.projectRoot}/logs/${name}.error.log`]);
      expect(plistStrings(plist, "GO_PROJECT_ROOT")).toEqual([MACHINE.projectRoot]);
      expect(plistStrings(plist, "HOME")).toEqual([MACHINE.home]);
      const path = plistStrings(plist, "PATH")[0].split(":");
      expect(path.slice(0, 2)).toEqual(["/opt/bun/bin", MACHINE.claudeDir]);
      expect(path).toContain("/opt/homebrew/bin");
    }
    for (const name of ["health-check", "software-update"] as const) {
      expect(plistStrings(plistOf(name), "PATH")[0].split(":")).toContain(`${MACHINE.home}/.local/bin`);
    }
  });
});

describe("Zeitplan", () => {
  const calendar = (plist: string) => /<key>StartCalendarInterval<\/key>\s*(<array\/>|<array>[\s\S]*?\n\t<\/array>|<dict>[\s\S]*?\n\t<\/dict>)/.exec(plist)?.[1];

  test("Check-in als Liste, Briefing als ein Termin aus dem Zeitplan", () => {
    expect(calendar(plistOf("smart-checkin"))).toBe(
      "<array>\n\t\t<dict>\n\t\t\t<key>Hour</key>\n\t\t\t<integer>10</integer>\n\t\t\t<key>Minute</key>\n\t\t\t<integer>30</integer>\n\t\t</dict>\n\t\t<dict>\n\t\t\t<key>Hour</key>\n\t\t\t<integer>14</integer>\n\t\t\t<key>Minute</key>\n\t\t\t<integer>30</integer>\n\t\t</dict>\n\t</array>",
    );
    const briefing = plistOf("morning-briefing", MACHINE, { ...SCHEDULE, morning_briefing: { hour: 7, minute: 45, enabled: true } });
    expect(calendar(briefing)).toBe("<dict>\n\t\t<key>Hour</key>\n\t\t<integer>7</integer>\n\t\t<key>Minute</key>\n\t\t<integer>45</integer>\n\t</dict>");
  });

  test("leere Check-in-Liste bleibt leer", () => {
    const plist = plistOf("smart-checkin", MACHINE, { ...SCHEDULE, check_in_intervals: [] });
    expect(calendar(plist)).toBe("<array/>");
    expect(plistProblem(plist)).toBeNull();
  });

  test("volle Stunde wird Platzhalter ohne Hour (launchd: jede Stunde)", () => {
    const everyHour = Array.from({ length: 24 }, (_, hour) => ({ hour, minute: 15 }));
    const plist = plistOf("smart-checkin", MACHINE, { ...SCHEDULE, check_in_intervals: everyHour });
    expect(calendar(plist)).toBe("<array>\n\t\t<dict>\n\t\t\t<key>Minute</key>\n\t\t\t<integer>15</integer>\n\t\t</dict>\n\t</array>");
  });

  test("Wartung sonntags 03:15 (Weekday 0), kein Start beim Laden", () => {
    const plist = plistOf("wartung");
    expect(calendar(plist)).toBe("<dict>\n\t\t<key>Hour</key>\n\t\t<integer>3</integer>\n\t\t<key>Minute</key>\n\t\t<integer>15</integer>\n\t\t<key>Weekday</key>\n\t\t<integer>0</integer>\n\t</dict>");
    expect(plist).not.toContain("RunAtLoad");
    expect(plist).not.toContain("KeepAlive");
  });

  test("Wartung nur einzeln, nie in „all“", async () => {
    expect(await selectServices("all", "/gibt/es/nicht/.env")).not.toContain("wartung");
    expect(await selectServices("wartung", "/gibt/es/nicht/.env")).toEqual(["wartung"]);
  });

  test("Nachtcheck 03:30, Updates 03:00, unabhängig vom Zeitplan", () => {
    expect(calendar(plistOf("health-check"))).toContain("<integer>3</integer>\n\t\t<key>Minute</key>\n\t\t<integer>30</integer>");
    expect(calendar(plistOf("software-update"))).toContain("<integer>3</integer>\n\t\t<key>Minute</key>\n\t\t<integer>0</integer>");
  });
});

describe("XML-Maskierung", () => {
  const ODD: MachinePaths = { ...MACHINE, home: `/Users/Tom & "Jerry"`, projectRoot: `/Users/Tom & "Jerry"/<tybo> 'neu'`, bun: "/opt/a&b/bun" };

  test("Pfad mit & ergibt gültiges XML, dekodiert genau der Pfad", () => {
    for (const name of MANAGED) {
      const plist = plistOf(name, ODD);
      expect([name, plistProblem(plist)]).toEqual([name, null]);
      expect(plist).not.toMatch(/&(?!amp;|lt;|gt;)/);
      expect(plistStrings(plist, "WorkingDirectory")).toEqual([ODD.projectRoot]);
      expect(plistStrings(plist, "HOME")).toEqual([ODD.home]);
      expect(plistStrings(plist, "ProgramArguments")).toEqual(programArguments(serviceDefinition(name), ODD));
      expect(plistStrings(plist, "ProgramArguments")[0]).toBe("/opt/a&b/bun");
      expect(plistStrings(plist, "PATH")[0].split(":")).toContain("/opt/a&b");
    }
    expect(plistStrings(plistOf("supabase", ODD), "StandardOutPath")).toEqual([`${ODD.projectRoot}/logs/supabase.log`]);
  });

  // Erwartung von Hand, nicht über programArguments: $& und $$ sind Muster von String.replace
  const DOLLAR_ROOTS = ["/Users/a$&b/tybo", "/Users/a$$b/tybo", "/Users/$'x$`/tybo"];

  test("Projektpfad mit $& oder $$: Supabase-Skriptpfad wörtlich", () => {
    for (const root of DOLLAR_ROOTS) {
      const machine = { ...MACHINE, projectRoot: root };
      const expected = [MACHINE.bun, "--no-env-file", root + "/scripts/tybo.ts", "datenbank", "start"];
      expect(programArguments(serviceDefinition("supabase"), machine)).toEqual(expected);
      const plist = plistOf("supabase", machine);
      expect(plistProblem(plist)).toBeNull();
      expect(plistStrings(plist, "ProgramArguments")).toEqual(expected);
      expect(plistStrings(plist, "ProgramArguments")[2]).toBe(root + "/scripts/tybo.ts");
    }
  });

  test("escapeXml und decodeXml sind zueinander passend", () => {
    for (const text of ["a & b", "<x>", "&amp;", `"'`, "ä ö ü ß €", ""]) expect(decodeXml(escapeXml(text))).toBe(text);
  });

  test("Steuerzeichen lassen sich nicht darstellen: Fehler statt kaputter Datei", () => {
    expect(() => plistOf("telegram-relay", { ...MACHINE, projectRoot: "/tmp/a\u0001b" })).toThrow(PlistError);
    expect(() => writePlist({ Label: "x\u001b" })).toThrow(PlistError);
    // Tab und Zeilenumbruch sind erlaubt
    expect(plistProblem(writePlist({ Label: "a\tb" }))).toBeNull();
  });

  test("keine ganzen Zahlen werden abgelehnt", () => {
    expect(() => writePlist({ ThrottleInterval: 1.5 })).toThrow(PlistError);
  });

  test("Dienste der Art external haben keine Plist", () => {
    for (const name of ["whatsapp-gateway", "cloudflare-tunnel"] as const) expect(() => plistOf(name)).toThrow(PlistError);
  });
});

// ---------------------------------------------------------------------------
// setUpService gegen Attrappen
// ---------------------------------------------------------------------------

function fakeMac(root: string, listOk = true) {
  const agents = "/home/test/Library/LaunchAgents";
  const files = new Map<string, string>();
  const loaded = new Set<string>();
  const calls: string[] = [];
  const log: string[] = [];
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const deps: LaunchdDeps = {
    projectRoot: root,
    launchAgentsDir: agents,
    home: "/home/test",
    async run(cmd) {
      if (cmd[0] === "which") return ok(cmd[1] === "bun" ? MACHINE.bun : `/home/test/.local/bin/${cmd[1]}`);
      if (cmd[0] !== "launchctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      calls.push(cmd.slice(0, 2).join(" "));
      if (cmd[1] === "list") return listOk ? ok([...loaded].map(l => `1\t0\t${l}`).join("\n")) : { ok: false, stdout: "", stderr: "x" };
      const label = basename(cmd[2], ".plist");
      if (cmd[1] === "load") loaded.add(label);
      if (cmd[1] === "unload") loaded.delete(label);
      return ok();
    },
    exists: path => files.has(path) || path === agents,
    readFile: path => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    writeFile: (path, content) => void files.set(path, content),
    mkdir: () => {},
    log: line => void log.push(line),
  };
  return { deps, files, loaded, calls, log, agents };
}

describe("setUpService mit dem Generator", () => {
  test("schreibt die erzeugte Plist; zweiter Lauf unverändert und geladen: kein Neustart", async () => {
    const mac = fakeMac("/home/test/tybo");
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    const path = plistFile("telegram-relay", mac.agents);
    expect(mac.files.get(path)).toBe(plistOf("telegram-relay"));
    expect(mac.calls).toEqual(["launchctl load", "launchctl list"]);
    mac.calls.length = 0;
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect(mac.calls).toEqual(["launchctl list"]);
  });

  test("Projektordner mit & landet maskiert in der Datei und dekodiert unverändert", async () => {
    const root = "/Users/Tom & Jerry/tybo";
    const mac = fakeMac(root);
    expect((await setUpService("health-check", mac.deps)).ok).toBe(true);
    const plist = mac.files.get(plistFile("health-check", mac.agents))!;
    expect(plistProblem(plist)).toBeNull();
    expect(plist).toContain("Tom &amp; Jerry");
    expect(plistStrings(plist, "WorkingDirectory")).toEqual([root]);
    expect(plistStrings(plist, "StandardErrorPath")).toEqual([`${root}/logs/health-check.error.log`]);
  });

  test("Projektordner mit $& oder $$: Supabase-Plist mit wörtlichem Skriptpfad", async () => {
    for (const root of ["/Users/a$&b/tybo", "/Users/a$$b/tybo"]) {
      const mac = fakeMac(root);
      expect((await setUpService("supabase", mac.deps)).ok).toBe(true);
      const plist = mac.files.get(plistFile("supabase", mac.agents))!;
      expect(plistProblem(plist)).toBeNull();
      expect(plistStrings(plist, "ProgramArguments")).toEqual([MACHINE.bun, "--no-env-file", root + "/scripts/tybo.ts", "datenbank", "start"]);
      expect(plistStrings(plist, "WorkingDirectory")).toEqual([root]);
    }
  });

  test("Steuerzeichen im Projektordner: Abbruch ohne Datei und ohne launchctl", async () => {
    const mac = fakeMac("/tmp/a\u0001b");
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(false);
    expect(mac.files.size).toBe(0);
    expect(mac.calls).toEqual([]);
    expect(mac.log.join("\n")).toContain("Steuerzeichen");
  });

  test("Zustand unbekannt bei gleicher Plist: nichts entladen, nichts laden", async () => {
    const mac = fakeMac("/home/test/tybo", false);
    mac.files.set(plistFile("telegram-relay", mac.agents), plistOf("telegram-relay"));
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(false);
    expect(mac.calls).toEqual(["launchctl list"]);
  });

  test("whatsapp-gateway und cloudflare-tunnel: keine Datei, kein launchctl, klare Meldung", async () => {
    for (const name of ["whatsapp-gateway", "cloudflare-tunnel"] as const) {
      const mac = fakeMac("/home/test/tybo");
      expect((await setUpService(name, mac.deps)).ok).toBe(false);
      expect(mac.files.size).toBe(0);
      expect(mac.calls).toEqual([]);
      expect(mac.log.join("\n")).toContain("nicht von tybo eingerichtet");
    }
  });
});
