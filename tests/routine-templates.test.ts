/**
 * Issue #285, Checkbox 2: Die zeitgesteuerten Dienste rufen den Wrapper
 * src/routine-run.ts, telegram-relay und supabase nicht. Seit Issue #368
 * erzeugt der Generator aus dem Dienstkatalog die Plists (keine Vorlagen
 * mehr); geprüft über setUpService aus src/setup/services/launchd.ts mit
 * Attrappen für Dateien und launchctl; es läuft nie ein echter launchctl-
 * oder plutil-Aufruf (Issue #286). Die Gültigkeit prüft der Strukturprüfer
 * aus tests/plist-structure.ts.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { plistFile, setUpService, type LaunchdDeps, type ServiceName } from "../src/setup/services/launchd";
import { launchdLabel } from "../src/lib/service-names";
import { plistProblem } from "./plist-structure";

const ROOT = "/projekt";
const AGENTS = "/home/test/Library/LaunchAgents";
const BUN = "/opt/bin/bun";

const WRAPPED: ServiceName[] = ["health-check", "morning-briefing", "smart-checkin", "software-update"];
const UNWRAPPED: ServiceName[] = ["telegram-relay", "supabase"];
/** Skripte, die nicht src/<dienst>.ts heißen; Briefing und Check-in sind seit Issue #363 bzw. #364 Routinen */
const SCRIPT: Partial<Record<ServiceName, string>> = {
  "morning-briefing": "src/routines/briefing.ts",
  "smart-checkin": "src/routines/checkin.ts",
};

interface FakeMac {
  deps: LaunchdDeps;
  files: Map<string, string>;
  loaded: Set<string>;
  calls: string[];
}

function fakeMac(): FakeMac {
  const files = new Map<string, string>();
  const loaded = new Set<string>();
  const calls: string[] = [];
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const deps: LaunchdDeps = {
    projectRoot: ROOT,
    launchAgentsDir: AGENTS,
    home: "/home/test",
    async run(cmd) {
      if (cmd[0] === "which") return ok(`/opt/bin/${cmd[1]}`);
      if (cmd[0] !== "launchctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      calls.push(cmd.slice(0, 2).join(" "));
      if (cmd[1] === "list") return ok([...loaded].map(l => `-\t0\t${l}`).join("\n"));
      const label = basename(cmd[2], ".plist");
      if (cmd[1] === "load") loaded.add(label);
      if (cmd[1] === "unload") loaded.delete(label);
      return ok();
    },
    exists: path => files.has(path) || path === AGENTS,
    readFile: path => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    writeFile: (path, content) => void files.set(path, content),
    mkdir: () => {},
    log: () => {},
  };
  return { deps, files, loaded, calls };
}

/** ProgramArguments eines erzeugten Plists, Platzhalter schon ersetzt */
function programArguments(plist: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!block) throw new Error("ProgramArguments fehlt");
  return [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
}

describe("erzeugte Plists und Wrapper", () => {
  test("alle vier zeitgesteuerten Dienste rufen den Wrapper mit ihrem Label und danach ihr Skript", async () => {
    const mac = fakeMac();
    for (const service of WRAPPED) {
      expect((await setUpService(service, mac.deps)).ok).toBe(true);
      const plist = mac.files.get(plistFile(service, AGENTS))!;
      expect(plist).not.toContain("{{");
      const args = programArguments(plist);
      expect(args).toEqual([BUN, "--no-env-file", "src/routine-run.ts", "--id", launchdLabel(service), "--", BUN, "run", SCRIPT[service] ?? `src/${service}.ts`]);
      expect(existsSync(join(import.meta.dir, "..", args.at(-1)!))).toBe(true);
      expect(args.join(" ")).toContain(`src/routine-run.ts --id ${launchdLabel(service)} -- `);
    }
    // Beispiel aus dem Issue wörtlich
    const health = programArguments(mac.files.get(plistFile("health-check", AGENTS))!).join(" ");
    expect(health).toMatch(/src\/routine-run\.ts --id ai\.tybo\.health-check -- .* src\/health-check\.ts$/);
  });

  test("Issue #364: Check-in ohne KeepAlive und ohne Start beim Laden, nur zu den Terminen, über den Wrapper", async () => {
    const mac = fakeMac();
    expect((await setUpService("smart-checkin", mac.deps)).ok).toBe(true);
    const plist = mac.files.get(plistFile("smart-checkin", AGENTS))!;
    // Fehler starten nicht sofort neu (früher KeepAlive/SuccessfulExit=false, Schleife bei jedem Fehler)
    expect(plist).not.toContain("<key>KeepAlive</key>");
    expect(plist).not.toContain("SuccessfulExit");
    expect(plist).not.toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(programArguments(plist).slice(2, 6)).toEqual(["src/routine-run.ts", "--id", "ai.tybo.smart-checkin", "--"]);
    expect(programArguments(plist).at(-1)).toBe("src/routines/checkin.ts");
  });

  test("telegram-relay und supabase bleiben ohne Wrapper", async () => {
    const mac = fakeMac();
    for (const service of UNWRAPPED) {
      expect((await setUpService(service, mac.deps)).ok).toBe(true);
      const plist = mac.files.get(plistFile(service, AGENTS))!;
      expect(plist).not.toContain("routine-run");
    }
    expect(programArguments(mac.files.get(plistFile("telegram-relay", AGENTS))!)).toEqual([BUN, "run", "src/bot.ts"]);
  });

  test("bestehender Plist ohne Wrapper wird als geändert erkannt und neu geladen, danach unverändert", async () => {
    const mac = fakeMac();
    const path = plistFile("health-check", AGENTS);
    // Stand vor Issue #285: Skript direkt; erzeugt und dann der Wrapper-Teil entfernt
    expect((await setUpService("health-check", mac.deps)).ok).toBe(true);
    const before = mac.files
      .get(path)!
      .replace(/\s*<string>[^<]*<\/string>\s*<string>--no-env-file<\/string>[\s\S]*?<string>--<\/string>/, "");
    expect(before).not.toContain("routine-run");
    expect(programArguments(before)).toEqual([BUN, "run", "src/health-check.ts"]);
    mac.files.set(path, before);
    mac.calls.length = 0;
    mac.loaded.add("ai.tybo.health-check");

    expect((await setUpService("health-check", mac.deps)).ok).toBe(true);
    expect(mac.calls).toEqual(["launchctl unload", "launchctl load", "launchctl list"]);
    expect(mac.files.get(path)).toContain("src/routine-run.ts");
    expect(mac.loaded.has("ai.tybo.health-check")).toBe(true);

    mac.calls.length = 0;
    expect((await setUpService("health-check", mac.deps)).ok).toBe(true);
    expect(mac.calls).toEqual(["launchctl list"]);
  });

  test("erzeugte Plists sind gültig (Strukturprüfung ohne plutil)", async () => {
    const mac = fakeMac();
    for (const service of [...WRAPPED, ...UNWRAPPED]) {
      await setUpService(service, mac.deps);
      expect([service, plistProblem(mac.files.get(plistFile(service, AGENTS))!)]).toEqual([service, null]);
    }
  });

  test("Strukturprüfung erkennt kaputte Plists", () => {
    const ok = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>x</string><key>A</key><array><string>a</string></array></dict></plist>`;
    expect(plistProblem(ok)).toBeNull();
    for (const bad of [
      ok.replace("</dict>", ""),
      ok.replace("<key>A</key>", ""),
      ok.replace("<string>x</string>", "<strin>x</strin>"),
      ok.replace("<key>Label</key><string>x</string>", "<key>Label</key><key>B</key>"),
      ok.replace("x</string>", "x & y</string>"),
      ok.replace("<plist version=\"1.0\">", "<plist>"),
      `${ok}<dict></dict>`,
      ok.replace("<dict>", "<dict><!-- a -- b -->"),
    ]) {
      expect(plistProblem(bad)).not.toBeNull();
    }
  });
});
