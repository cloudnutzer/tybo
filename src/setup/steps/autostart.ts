/**
 * Schritt „autostart“: der Bot startet mit dem Rechner und nach Abstürzen.
 * macOS über launchd, sonst über PM2. Nutzt die Funktionen aus
 * setup/configure-launchd.ts und setup/configure-services.ts statt Kopien.
 *
 * Eingerichtet wird nur der Bot selbst (telegram-relay), kein pauschales
 * „all“: das würde Check-in, Briefing, Watchdog und auf macOS auch den
 * Cloudflare-Tunnel mit anlegen. Ist der Dienst schon aktiv (launchd: geladen,
 * PM2: in der Liste), bleibt er unberührt; ein Neuladen würde den laufenden
 * Bot beenden. Unter PM2 zählt der Dienst erst als eingerichtet, wenn er auch
 * in PM2s Sicherungsliste (dump.pm2, geschrieben von „pm2 save“) steht; läuft
 * er nur, holt apply() allein das Speichern nach, ohne ihn neu zu starten.
 * Liegt auf macOS nur die Plist da (etwa nach einem
 * gescheiterten Laden), gilt das nicht als eingerichtet, und apply() lädt sie
 * erneut. Lässt sich der Zustand nicht lesen, ändert apply() nichts. PM2 wird
 * ohne npx aufgerufen, damit nichts nachinstalliert wird.
 *
 * Dienste heißen ai.tybo.telegram-relay bzw. tybo-telegram-relay (Issue
 * #101). Dienste anderer Namen zählen nicht und werden nie angefasst (Issue
 * #142).
 *
 * Meldungen enthalten nie rohe Befehlsausgaben (stderr kann Geheimnisse aus
 * der Umgebung enthalten), nur feste Texte je Fehlerart.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureService, plistPathFor, type LaunchdDeps } from "../../../setup/configure-launchd";
import { configurePM2Service, type Pm2Deps } from "../../../setup/configure-services";
import { BRAND } from "../../brand";
import { BOT_SERVICE, labelInLaunchctlList, launchdLabel, pm2Name } from "../../lib/service-names";
import type { SetupContext } from "../context";
import type { ApplyResult, SetupStep, StatusItem } from "../model";

export const AUTOSTART_SERVICE = BOT_SERVICE;
export const PM2_INSTALL = "npm install -g pm2";

const ANSI = /\x1b\[[0-9;]*m/g;

function runOk(ctx: SetupContext) {
  return async (cmd: string[]) => {
    const r = await ctx.run(cmd, { cwd: ctx.root, timeoutMs: 30_000 });
    return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
  };
}

export function launchdDeps(ctx: SetupContext, log: string[]): LaunchdDeps {
  return {
    projectRoot: ctx.root,
    launchAgentsDir: ctx.launchAgentsDir,
    home: ctx.home,
    run: runOk(ctx),
    exists: existsSync,
    readFile: path => readFileSync(path, "utf-8"),
    writeFile: (path, content) => writeFileSync(path, content, { encoding: "utf-8", mode: 0o644 }),
    mkdir: path => mkdirSync(path, { recursive: true }),
    log: line => log.push(line.replace(ANSI, "").trim()),
  };
}

export function pm2Deps(ctx: SetupContext, log: string[]): Pm2Deps {
  return { projectRoot: ctx.root, pm2: ["pm2"], run: runOk(ctx), log: line => log.push(line.replace(ANSI, "").trim()) };
}

function plistPath(ctx: SetupContext): string {
  return plistPathFor(AUTOSTART_SERVICE, ctx.launchAgentsDir);
}

const LAUNCHD_LABEL = launchdLabel(AUTOSTART_SERVICE);
const PM2_NAME = pm2Name(AUTOSTART_SERVICE);

/**
 * Fehlerart aus dem Skript-Protokoll als fester Text. Die Protokollzeilen
 * selbst (mit stderr von launchctl oder PM2) gehen nie nach außen.
 */
function failureReason(log: string[]): string {
  const text = log.join("\n");
  if (/Template not found/.test(text)) return "Die launchd-Vorlage fehlt im Projektordner.";
  if (/Could not find bun/.test(text)) return "Bun wurde nicht im PATH gefunden.";
  if (/Existing unload failed/.test(text)) return `Der Dienst ${LAUNCHD_LABEL} ließ sich nicht entladen. Dienstdateien unverändert, kein weiterer Dienst geladen.`;
  if (/State unknown/.test(text)) return `Ob der Dienst ${LAUNCHD_LABEL} geladen ist, ließ sich nicht feststellen (launchctl list). Nichts geändert.`;
  if (/Existing delete failed/.test(text)) return `Der PM2-Prozess ${PM2_NAME} ließ sich nicht neu starten, weil er sich nicht entfernen ließ. Kein weiterer Prozess gestartet.`;
  if (/PM2 list unreadable/.test(text)) return "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist). Nichts geändert.";
  if (/Load failed/.test(text)) return "launchctl konnte den Dienst nicht laden. Die Dienstdatei liegt da; ein erneuter Versuch lädt sie noch einmal.";
  if (/Start failed/.test(text)) return `PM2 konnte den Bot nicht starten. Details mit: pm2 logs ${PM2_NAME}`;
  return "Unbekannter Fehler.";
}

/** Zustand unter launchd: keine Plist, geladen, nur Datei, nicht lesbar */
type LaunchdState = "missing" | "loaded" | "not-loaded" | "unknown";

async function launchdState(ctx: SetupContext): Promise<LaunchdState> {
  if (!existsSync(plistPath(ctx))) return "missing";
  const list = await ctx.run(["launchctl", "list"], { timeoutMs: 15_000 });
  if (list.code !== 0) return "unknown";
  return labelInLaunchctlList(list.stdout, LAUNCHD_LABEL) ? "loaded" : "not-loaded";
}

/**
 * Zustand unter PM2; „unknown“, wenn jlist scheitert oder unlesbar ist.
 * „running“: läuft, fehlt aber in dump.pm2 (pm2 save steht noch aus).
 */
type Pm2State = "not-installed" | "saved" | "running" | "absent" | "unknown";

/** Steht der Bot in dump.pm2? Nur die Namen werden gelesen, nie ausgegeben. */
function pm2Saved(ctx: SetupContext): boolean {
  try {
    const dump = JSON.parse(readFileSync(ctx.pm2DumpPath, "utf-8"));
    if (!Array.isArray(dump)) return false;
    const names = dump.map((p: any) => p?.name);
    return names.includes(PM2_NAME);
  } catch {
    return false;
  }
}

async function pm2State(ctx: SetupContext): Promise<Pm2State> {
  const version = await ctx.run(["pm2", "--version"], { timeoutMs: 15_000 });
  if (version.code !== 0) return "not-installed";
  const list = await ctx.run(["pm2", "jlist"], { timeoutMs: 15_000 });
  if (list.code !== 0) return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout);
  } catch {
    return "unknown";
  }
  if (!Array.isArray(parsed)) return "unknown";
  if (!parsed.some((p: any) => p?.name === PM2_NAME)) return "absent";
  return pm2Saved(ctx) ? "saved" : "running";
}

const ALREADY: ApplyResult = { ok: true, message: "Autostart ist schon eingerichtet, nichts geändert.", changed: [] };

async function applyLaunchd(ctx: SetupContext): Promise<ApplyResult> {
  const path = plistPath(ctx);
  const state = await launchdState(ctx);
  if (state === "loaded") return ALREADY;
  if (state === "unknown") {
    return { ok: false, message: "Ob der Dienst schon läuft, ließ sich nicht prüfen (launchctl list schlug fehl). Nichts geändert.", changed: [] };
  }
  if (state === "not-loaded") {
    // Plist liegt da, ist aber nicht geladen: nur erneut laden, Datei bleibt
    const load = await ctx.run(["launchctl", "load", path], { cwd: ctx.root, timeoutMs: 30_000 });
    if (load.code !== 0) {
      return { ok: false, message: "Autostart ließ sich nicht einrichten: launchctl konnte den Dienst nicht laden. Die Dienstdatei liegt unverändert da.", changed: [] };
    }
    return { ok: true, message: `Autostart eingerichtet: ${BRAND.name} läuft jetzt und startet mit dem Rechner.`, changed: [path] };
  }

  // „missing“: Plist schreiben und laden
  /** Geänderte Dateien: die neue Plist, falls da */
  const touched = () => (existsSync(path) ? [path] : []);
  const log: string[] = [];
  let ok: boolean;
  try {
    ok = await configureService(AUTOSTART_SERVICE, launchdDeps(ctx, log));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      message: `Autostart ließ sich nicht einrichten: die Dienstdatei konnte nicht geschrieben werden${code ? ` (${code})` : ""}.`,
      changed: touched(),
    };
  }
  if (!ok) return { ok: false, message: `Autostart ließ sich nicht einrichten: ${failureReason(log)}`, changed: touched() };
  return { ok: true, message: `Autostart eingerichtet: ${BRAND.name} läuft jetzt und startet mit dem Rechner.`, changed: touched() };
}

const PM2_SAVE_FAILED = `aber „pm2 save“ ist gescheitert: nach einem Neustart des Rechners fehlt der Dienst. Einmal „pm2 save“ ausführen, dann „pm2 startup“.`;
const PM2_STARTUP_HINT = "Damit PM2 nach einem Neustart des Rechners mitstartet, einmal „pm2 startup“ ausführen und die ausgegebene Zeile übernehmen.";

async function savePm2(ctx: SetupContext): Promise<boolean> {
  const save = await ctx.run(["pm2", "save"], { cwd: ctx.root, timeoutMs: 30_000 });
  return save.code === 0;
}

async function applyPm2(ctx: SetupContext): Promise<ApplyResult> {
  const state = await pm2State(ctx);
  if (state === "not-installed") return { ok: false, message: `PM2 fehlt. Erst installieren mit: ${PM2_INSTALL}`, changed: [] };
  if (state === "saved") return ALREADY;
  if (state === "unknown") {
    // Nie auf Verdacht löschen und neu starten: der Bot könnte laufen
    return { ok: false, message: "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist). Nichts geändert; mit „pm2 list“ prüfen.", changed: [] };
  }
  if (state === "running") {
    // Läuft schon, nur das Speichern fehlt: nicht neu starten, nur pm2 save wiederholen
    if (!(await savePm2(ctx))) return { ok: false, message: `${BRAND.name} läuft unter PM2, ${PM2_SAVE_FAILED}`, changed: [] };
    return { ok: true, message: `${BRAND.name} läuft unter PM2 und ist jetzt gespeichert. ${PM2_STARTUP_HINT}`, changed: [`pm2:${PM2_NAME}`] };
  }
  // „absent“: starten, danach speichern
  const log: string[] = [];
  const ok = await configurePM2Service(AUTOSTART_SERVICE, pm2Deps(ctx, log));
  if (!ok) return { ok: false, message: `Autostart ließ sich nicht einrichten: ${failureReason(log)}`, changed: [] };
  if (!(await savePm2(ctx))) {
    return { ok: false, message: `${BRAND.name} läuft jetzt unter PM2, ${PM2_SAVE_FAILED}`, changed: [`pm2:${PM2_NAME}`] };
  }
  return { ok: true, message: `${BRAND.name} läuft jetzt unter PM2. ${PM2_STARTUP_HINT}`, changed: [`pm2:${PM2_NAME}`] };
}

export const autostartStep: SetupStep = {
  id: "autostart",
  title: "Autostart",
  description: `${BRAND.name} startet mit dem Rechner und nach Abstürzen von selbst.`,
  optional: false,
  fields: [],

  async status(ctx) {
    if (ctx.platform === "darwin") {
      const state = await launchdState(ctx);
      if (state === "loaded") return { state: "erledigt", detail: "launchd-Dienst ist eingerichtet und geladen.", fields: [] };
      if (state === "missing") return { state: "fehlt", detail: "Noch kein Autostart über launchd.", fields: [] };
      return {
        state: "teilweise",
        detail:
          state === "not-loaded"
            ? "Die Dienstdatei liegt da, der Dienst ist aber nicht geladen. Einrichten lädt ihn erneut."
            : "Die Dienstdatei liegt da; ob der Dienst geladen ist, ließ sich nicht prüfen (launchctl list).",
        fields: [],
      };
    }
    const pm2 = await pm2State(ctx);
    if (pm2 === "not-installed") {
      return {
        state: "fehlt",
        detail: "PM2 ist nicht installiert.",
        fields: [],
        items: [{ label: "PM2", ok: false, detail: "PM2 nicht gefunden.", fix: PM2_INSTALL }],
      };
    }
    if (pm2 === "unknown") {
      return { state: "teilweise", detail: "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist).", fields: [] };
    }
    if (pm2 === "running") {
      return {
        state: "teilweise",
        detail: "Der PM2-Dienst läuft, ist aber nicht gespeichert (pm2 save). Einrichten speichert ihn, ohne ihn neu zu starten.",
        fields: [],
      };
    }
    return {
      state: pm2 === "saved" ? "erledigt" : "fehlt",
      detail: pm2 === "saved" ? "PM2-Dienst ist eingerichtet und gespeichert." : "Noch kein Autostart über PM2.",
      fields: [],
    };
  },

  /** Prüft, ob sich der Autostart einrichten lässt; ist er schon aktiv, genügt das */
  async test(_values, ctx) {
    if ((await autostartStep.status(ctx)).state === "erledigt") {
      return { ok: true, message: "Autostart ist eingerichtet." };
    }
    const items: StatusItem[] = [];
    if (ctx.platform === "darwin") {
      const state = await launchdState(ctx);
      if (state === "unknown") {
        items.push({ label: "launchd", ok: false, detail: "launchctl list schlug fehl, der Zustand des Diensts ist unbekannt." });
      } else if (state === "not-loaded") {
        items.push({ label: "Dienstdatei", ok: true, detail: "Dienstdatei vorhanden, wird beim Einrichten erneut geladen." });
      } else {
        const template = existsSync(join(ctx.root, "launchd", `${LAUNCHD_LABEL}.plist.template`));
        items.push({ label: "Vorlage", ok: template, detail: template ? "launchd-Vorlage vorhanden." : "launchd-Vorlage fehlt im Projektordner." });
        const bun = await ctx.run(["which", "bun"], { timeoutMs: 10_000 });
        items.push({ label: "Bun im PATH", ok: bun.code === 0, detail: bun.code === 0 ? "Bun gefunden." : "Bun nicht im PATH gefunden." });
      }
    } else {
      const pm2 = await pm2State(ctx);
      const installed = pm2 !== "not-installed";
      items.push({
        label: "PM2",
        ok: installed,
        detail: installed ? "PM2 gefunden." : "PM2 nicht gefunden.",
        fix: installed ? undefined : PM2_INSTALL,
      });
      if (pm2 === "running") {
        items.push({ label: "PM2-Speicherung", ok: true, detail: "Dienst läuft, „pm2 save“ fehlt noch und wird beim Einrichten nachgeholt." });
      }
      if (pm2 === "unknown") items.push({ label: "PM2-Dienste", ok: false, detail: "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist)." });
    }
    const failed = items.filter(i => !i.ok);
    return { ok: failed.length === 0, message: failed.length ? failed.map(i => i.detail).join(" ") : "Autostart kann eingerichtet werden.", items };
  },

  async apply(_values, ctx) {
    return ctx.platform === "darwin" ? applyLaunchd(ctx) : applyPm2(ctx);
  },
};
