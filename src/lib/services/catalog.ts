/**
 * Katalog aller Hintergrunddienste von tybo unter launchd (Issue #368).
 *
 * Ein Eintrag beschreibt einen Dienst `ai.tybo.<name>` vollständig: Art,
 * Befehl, ob er über den Routinen-Wrapper läuft (src/routine-run.ts, A1,
 * Issue #285), Zeitplan, Protokolldateien und Umgebung. Aus dem Eintrag
 * erzeugt src/lib/services/plist.ts die Plist; Vorlagen unter launchd/ gibt
 * es nicht mehr.
 *
 * Arten:
 * - daemon: läuft dauernd, launchd startet ihn beim Laden und nach jedem Ende
 *   neu (der Bot).
 * - routine: startet nur zu festen Terminen, immer über den Wrapper; kein
 *   Start beim Laden, kein Neustart nach Fehlern.
 * - once: läuft einmal beim Laden bzw. Anmelden und endet (Supabase auf
 *   diesem Rechner, Issue #165).
 * - external: tybo kennt den Namen (Nachtcheck, Routinen-Übersicht), richtet
 *   den Dienst aber nicht ein; seine Plist stammt nicht aus tybo.
 *
 * Zeitpläne: Check-in und Briefing kommen aus den Einstellungen
 * (setupSchedule in src/lib/proactive/setup-schedule.ts, Vorrang
 * schedule.json, dann settings.json, dann Standards), Nachtcheck und
 * Software-Updates haben feste Zeiten.
 *
 * Unter Linux (Issue #370) laufen Bot und Supabase unter PM2
 * (src/setup/services/pm2.ts), Check-in und Briefing als systemd-Timer
 * (src/lib/services/systemd.ts, src/setup/services/linux.ts).
 *
 * Eigene Routinen der Nutzer stehen nicht hier; die Routinen-Übersicht
 * erkennt sie weiter an ihren Plists (src/lib/routines/).
 */

import { compactForLaunchd, type SetupInterval, type SetupSchedule } from "../proactive/setup-schedule";

export type ServiceKind = "daemon" | "routine" | "once" | "external";

/**
 * Welche Ordner vor dem PATH stehen. Die Reihenfolge ist Teil der erzeugten
 * Plist und damit des Vergleichs, ob sich etwas geändert hat.
 * - short: Bun, Claude CLI, Homebrew, System
 * - long: dazu ~/.local/bin, ~/.bun/bin und die sbin-Ordner (Nachtcheck und
 *   Updates rufen gh, brew, codex usw.)
 * - docker: Orte von Docker Desktop, OrbStack und Homebrew für
 *   `tybo datenbank start`
 */
export type PathProfile = "short" | "long" | "docker";

/** Zeitplan eines Diensts: keiner, ein Termin (dict) oder eine Liste (array) */
export type CalendarPlan = { form: "single"; slot: SetupInterval } | { form: "list"; slots: SetupInterval[] };

/** Alle Dienste, in der Reihenfolge, in der `--service all` sie einrichtet */
export const SERVICE_NAMES = [
  "telegram-relay",
  "smart-checkin",
  "morning-briefing",
  "whatsapp-gateway",
  "cloudflare-tunnel",
  "health-check",
  "software-update",
  "supabase",
] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export interface ServiceDefinition {
  name: ServiceName;
  kind: ServiceKind;
  /** Kurzbeschreibung für Ausgaben der Einrichtung */
  summary: string;
  /**
   * Argumente nach dem Pfad zu Bun. `{root}` steht für den Projektordner.
   * Bei Routinen der eigentliche Befehl, den der Wrapper startet.
   */
  args: string[];
  /** true: Start über src/routine-run.ts mit --id <label> (A1) */
  wrapped: boolean;
  /** Termine aus dem Zeitplan der Einrichtung; null ohne Termine */
  calendar: ((schedule: SetupSchedule) => CalendarPlan) | null;
  path: PathProfile;
  /** GO_PROJECT_ROOT in der Umgebung (Routinen und Bot lesen ihn) */
  projectRootEnv: boolean;
  /** Protokolldateien relativ zum Projektordner */
  logs: { out: string; err: string };
  /**
   * ExitTimeOut setzen: launchd lässt dem Dienst beim Entladen so viele
   * Sekunden für ein geordnetes Ende (Wert kommt beim Erzeugen herein,
   * LAUNCHD_EXIT_TIMEOUT_S)
   */
  exitTimeout?: boolean;
  /** Bei --service all nie dabei, nur einzeln */
  onlyExplicit?: boolean;
  /**
   * Unter Linux (Issue #370): pm2 für Dauerdienste, timer für Routinen
   * (systemd-Timer, ohne systemd cron). Fehlt das Feld, gibt es den Dienst
   * nur unter macOS.
   */
  linux?: "pm2" | "timer";
}

const logsOf = (name: string) => ({ out: `logs/${name}.log`, err: `logs/${name}.error.log` });

/** Ein Eintrag je Name aus SERVICE_NAMES, gleiche Reihenfolge (Test) */
export const SERVICE_CATALOG: readonly ServiceDefinition[] = [
  {
    name: "telegram-relay",
    kind: "daemon",
    summary: "der Bot",
    args: ["run", "src/bot.ts"],
    wrapped: false,
    calendar: null,
    path: "short",
    projectRootEnv: true,
    linux: "pm2",
    logs: logsOf("telegram-relay"),
  },
  {
    name: "smart-checkin",
    kind: "routine",
    summary: "Check-in zu den eingerichteten Terminen",
    args: ["run", "src/routines/checkin.ts"],
    wrapped: true,
    // Ein Termin je Check-in; eine leere Liste bleibt leer (keine Check-ins)
    calendar: schedule => ({ form: "list", slots: compactForLaunchd(schedule.check_in_intervals) }),
    path: "short",
    projectRootEnv: true,
    linux: "timer",
    logs: logsOf("smart-checkin"),
  },
  {
    name: "morning-briefing",
    kind: "routine",
    summary: "Morgenbriefing einmal am Tag",
    args: ["run", "src/routines/briefing.ts"],
    wrapped: true,
    calendar: schedule => ({ form: "single", slot: { hour: schedule.morning_briefing.hour, minute: schedule.morning_briefing.minute } }),
    path: "short",
    projectRootEnv: true,
    linux: "timer",
    logs: logsOf("morning-briefing"),
  },
  {
    name: "whatsapp-gateway",
    kind: "external",
    summary: "WhatsApp-Anbindung, von tybo nicht eingerichtet",
    args: [],
    wrapped: false,
    calendar: null,
    path: "short",
    projectRootEnv: false,
    logs: logsOf("whatsapp-gateway"),
  },
  {
    name: "cloudflare-tunnel",
    kind: "external",
    summary: "Cloudflare-Tunnel, von tybo nicht eingerichtet",
    args: [],
    wrapped: false,
    calendar: null,
    path: "short",
    projectRootEnv: false,
    logs: logsOf("cloudflare-tunnel"),
  },
  {
    name: "health-check",
    kind: "routine",
    summary: "Nachtcheck täglich 03:30",
    args: ["run", "src/health-check.ts"],
    wrapped: true,
    calendar: () => ({ form: "single", slot: { hour: 3, minute: 30 } }),
    path: "long",
    projectRootEnv: true,
    logs: logsOf("health-check"),
  },
  {
    name: "software-update",
    kind: "routine",
    summary: "Software-Updates täglich 03:00, vor dem Nachtcheck",
    args: ["run", "src/software-update.ts"],
    wrapped: true,
    calendar: () => ({ form: "single", slot: { hour: 3, minute: 0 } }),
    path: "long",
    projectRootEnv: true,
    logs: logsOf("software-update"),
    onlyExplicit: true,
  },
  {
    name: "supabase",
    kind: "once",
    summary: "Supabase auf diesem Rechner beim Anmelden starten",
    args: ["--no-env-file", "{root}/scripts/tybo.ts", "datenbank", "start"],
    wrapped: false,
    calendar: null,
    path: "docker",
    projectRootEnv: false,
    // Ausgabe und Fehler in dieselbe Datei
    linux: "pm2",
    logs: { out: "logs/supabase.log", err: "logs/supabase.log" },
    exitTimeout: true,
  },
];

export function isServiceName(name: string): name is ServiceName {
  return (SERVICE_NAMES as readonly string[]).includes(name);
}

/** Eintrag zu einem Namen aus SERVICE_NAMES */
export function serviceDefinition(name: ServiceName): ServiceDefinition {
  const found = SERVICE_CATALOG.find(s => s.name === name);
  if (!found) throw new Error(`Dienst fehlt im Katalog: ${name}`);
  return found;
}
