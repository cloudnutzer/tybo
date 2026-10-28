/**
 * Attrappe für tybo routinen einbinden/ausbinden (Issue #286): Plists als
 * Objekte im Speicher, plutil und launchctl nachgebildet, jeder Schritt in
 * events. Kein echter Befehl, keine echte Datei. Wie launchd hält die
 * Attrappe die geladene Konfiguration getrennt von der Datei auf der Platte
 * (loadedConfig), und bootstrap scheitert für einen schon geladenen Dienst.
 */

import { dirname } from "node:path";
import type { WrapCommandDeps } from "../src/lib/routines/einbinden";
import { AGENTS, fakeRoutinesDeps, launchctlListOutput, printDisabledOutput, ROOT } from "./routines-fixture";

export const BUN = "/Users/alex/.bun/bin/bun";
export const LABEL = "com.example.watch";
export const PATH = `${AGENTS}/${LABEL}.plist`;
export const CONFIG = JSON.stringify({ labels: [], prefixes: ["com.example."] });

export function watchPlist(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Label: LABEL,
    ProgramArguments: ["/usr/bin/python3", "/Users/alex/Mein Ordner/run.py", "--quiet"],
    WorkingDirectory: "/Users/alex/Mein Ordner",
    EnvironmentVariables: { PATH: "/usr/bin:/bin", HOME: "/Users/alex" },
    StartCalendarInterval: [{ Hour: 9, Minute: 0 }, { Hour: 18, Minute: 30 }],
    StandardOutPath: "/Users/alex/Mein Ordner/log.txt",
    StandardErrorPath: "/Users/alex/Mein Ordner/err.txt",
    ...extra,
  };
}

export interface FakeOptions {
  plists?: Record<string, Record<string, unknown>>;
  config?: string;
  platform?: NodeJS.Platform;
  /** Label → PID (null: geladen, läuft nicht); fehlt ein Label, ist es nicht geladen */
  loaded?: Record<string, number | null>;
  disabled?: string[];
  symlinks?: string[];
  answers?: Array<string | null>;
  /** Läuft während der Rückfrage, etwa um einen Lauf beginnen zu lassen oder den Dienst zu pausieren */
  duringAsk?: (state: { loaded: Map<string, number | null>; disabled: Set<string> }) => void;
  bunPath?: string | null;
  fail?: {
    backupCopy?: boolean;
    tmpCopy?: boolean;
    replace?: boolean;
    lint?: boolean;
    /** bootout scheitert; mit unloads: der Dienst ist trotzdem entladen */
    bootout?: boolean;
    bootoutUnloads?: boolean;
    rename?: boolean;
    /** bootstrap scheitert für die geänderte Plist bzw. immer */
    bootstrap?: "changed" | "all";
    /** bootstrap meldet Erfolg, aber die geänderte Plist ist danach nicht geladen */
    vanishChanged?: boolean;
    /** bootstrap der geänderten Plist lädt sie, meldet aber trotzdem einen Fehler */
    bootstrapChangedLoadsButFails?: boolean;
    /** Wiederherstellen der Sicherung scheitert (Kopie zurück) */
    restoreCopy?: boolean;
    /** Beim Wiederherstellen scheitern bootout und bootstrap */
    restoreLaunchctl?: boolean;
  };
}

export interface Fake {
  deps: WrapCommandDeps;
  files: Map<string, Record<string, unknown>>;
  loaded: Map<string, number | null>;
  /** Label → geladene Konfiguration (Stand der Plist beim bootstrap) */
  loadedConfig: Map<string, Record<string, unknown>>;
  disabled: Set<string>;
  events: string[];
  out: string[];
  err: string[];
  asked: string[];
  original: Record<string, unknown> | undefined;
}

const clone = <T>(v: T): T => structuredClone(v);

export function fake(options: FakeOptions = {}): Fake {
  const files = new Map<string, Record<string, unknown>>();
  for (const [name, plist] of Object.entries(options.plists ?? { [`${LABEL}.plist`]: watchPlist() })) files.set(`${AGENTS}/${name}`, clone(plist));
  const original = files.has(PATH) ? clone(files.get(PATH)!) : undefined;
  const loaded = new Map<string, number | null>(Object.entries(options.loaded ?? { [LABEL]: null }));
  const loadedConfig = new Map<string, Record<string, unknown>>();
  for (const plist of files.values()) {
    if (loaded.has(plist.Label as string)) loadedConfig.set(plist.Label as string, clone(plist));
  }
  const disabled = new Set(options.disabled ?? []);
  const symlinks = new Set(options.symlinks ?? []);
  const answers = [...(options.answers ?? [])];
  const f = options.fail ?? {};
  const events: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const bad = { ok: false, stdout: "", stderr: "Fehler" };
  const changed = (path: string) => original !== undefined && !Bun.deepEquals(files.get(path), original);

  const base = fakeRoutinesDeps({ platform: options.platform, config: options.config ?? CONFIG });
  const deps: WrapCommandDeps = {
    ...base,
    async run(cmd) {
      events.push(cmd.slice(0, 2).join(" "));
      if (cmd[0] === "plutil" && cmd[1] === "-convert") {
        const plist = files.get(cmd[cmd.length - 1]);
        return plist ? ok(JSON.stringify(plist)) : bad;
      }
      if (cmd[0] === "plutil" && cmd[1] === "-replace") {
        const [, , key, flag, json, path] = cmd;
        if (f.replace || key !== "ProgramArguments" || flag !== "-json" || !files.has(path)) return bad;
        files.get(path)!.ProgramArguments = JSON.parse(json);
        return ok();
      }
      if (cmd[0] === "plutil" && cmd[1] === "-lint") return f.lint ? bad : ok();
      if (cmd[0] === "launchctl" && cmd[1] === "list") {
        return ok(launchctlListOutput([...loaded].map(([l, pid]) => [pid === null ? "-" : String(pid), "0", l])));
      }
      if (cmd[0] === "launchctl" && cmd[1] === "print-disabled") {
        return ok(printDisabledOutput(Object.fromEntries([...disabled].map(l => [l, true]))));
      }
      if (cmd[0] === "launchctl" && cmd[1] === "bootout") {
        const label = cmd[2].split("/").pop()!;
        if (f.restoreLaunchctl && restoring()) return bad;
        if (f.bootout && !restoring()) {
          if (f.bootoutUnloads) unload(label);
          return bad;
        }
        if (!loaded.has(label)) return bad;
        unload(label);
        return ok();
      }
      if (cmd[0] === "launchctl" && cmd[1] === "bootstrap") {
        const path = cmd[3];
        const plist = files.get(path);
        if (!plist) return bad;
        if (f.restoreLaunchctl && restoring()) return bad;
        if (f.bootstrap === "all" || (f.bootstrap === "changed" && changed(path))) return bad;
        // launchd: ein schon geladener Dienst lässt sich nicht noch einmal laden
        if (loaded.has(plist.Label as string)) return bad;
        if (f.vanishChanged && changed(path)) return ok();
        loaded.set(plist.Label as string, null);
        loadedConfig.set(plist.Label as string, clone(plist));
        return f.bootstrapChangedLoadsButFails && changed(path) ? bad : ok();
      }
      throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
    },
    listDir(path) {
      if (path !== AGENTS) throw new Error("ENOENT");
      return [...files.keys()].filter(p => dirname(p) === AGENTS).map(p => p.slice(AGENTS.length + 1));
    },
    bunPath: options.bunPath === undefined ? BUN : options.bunPath,
    lstat: path => (files.has(path) ? { symlink: symlinks.has(path), file: true } : null),
    exists: path => files.has(path),
    copyFile(src, dst) {
      const toBackup = dst.startsWith(`${ROOT}/data/launchd-backup/`);
      const fromBackup = src.startsWith(`${ROOT}/data/launchd-backup/`);
      if (toBackup && f.backupCopy) throw new Error("Platte voll");
      if (!toBackup && !fromBackup && f.tmpCopy) throw new Error("Platte voll");
      if (fromBackup && f.restoreCopy) throw new Error("Platte voll");
      if (!files.has(src)) throw new Error(`ENOENT ${src}`);
      if (files.has(dst)) throw new Error(`EEXIST ${dst}`);
      events.push(`copy ${src} -> ${dst}`);
      files.set(dst, clone(files.get(src)!));
    },
    rename(src, dst) {
      if (f.rename && dst === PATH && !restoring()) throw new Error("EPERM");
      events.push(`rename ${src} -> ${dst}`);
      files.set(dst, files.get(src)!);
      files.delete(src);
    },
    remove(path) {
      events.push(`remove ${path}`);
      files.delete(path);
    },
    mkdir: path => void events.push(`mkdir ${path}`),
    async ask(question) {
      asked.push(question);
      options.duringAsk?.({ loaded, disabled });
      return answers.length ? answers.shift()! : null;
    },
    sleep: async () => {},
    out: line => void out.push(line),
    err: line => void err.push(line),
  };
  function unload(label: string) {
    loaded.delete(label);
    loadedConfig.delete(label);
  }
  // Beim Wiederherstellen (Kopie aus der Sicherung) darf rename klappen
  function restoring(): boolean {
    return events.some(e => e.startsWith(`copy ${ROOT}/data/launchd-backup/`));
  }
  return { deps, files, loaded, loadedConfig, disabled, events, out, err, asked, original };
}

