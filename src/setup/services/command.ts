/**
 * `tybo dienste` (Issue #369, Linux seit #370): tybo-Dienste einrichten,
 * unter macOS mit launchd, unter Linux Bot und Supabase mit PM2 und
 * Check-in und Briefing als systemd-Timer (ohne systemd cron).
 * `bun run setup:launchd` ist derselbe Befehl, damit bleibt
 * `bun run setup:launchd -- --service <name>` gültig.
 *
 *   tybo dienste                      wie `all`
 *   tybo dienste all | <dienst>       auch als --service all | --service <dienst>
 *   tybo dienste help
 *
 * „all“ lässt software-update weg und nimmt supabase nur bei lokaler
 * SUPABASE_URL mit (selectServices). Unveränderte, geladene Dienste bleiben
 * unberührt. Projektordner und .env kommen vom Aufrufer (Installationsordner
 * bzw. TYBO_ROOT), nie aus dem Arbeitsverzeichnis. `bun run setup:services`
 * ist seit #370 derselbe Befehl.
 *
 * Linux: „all“ nimmt nur Dienste mit Linux-Weg im Katalog (telegram-relay,
 * smart-checkin, morning-briefing, bei lokaler Datenbank supabase). PM2-
 * Dienste starten nur, wenn das installierte pm2 antwortet; danach einmal
 * `pm2 save`. Ist der Bot schon als systemd-Benutzerdienst eingerichtet
 * (tybo setup autostart; Unit-Datei oder geladener Dienst), startet PM2
 * keinen zweiten und muss dafür nicht installiert sein; antwortet
 * systemctl --user nicht, startet ebenfalls keiner (Fehler). Windows: keine
 * Dienste (Entscheidung E12).
 *
 * Exit-Codes: 0 alle gewählten Dienste eingerichtet (bei „all“ zählen
 * übersprungene Dienste nicht als Fehler), 1 mindestens einer gescheitert,
 * pm2 save gescheitert oder kein macOS bzw. Linux, 2 unbekannter Aufruf oder
 * Dienst.
 */

import { join } from "node:path";
import { BRAND } from "../../brand";
import { SERVICE_NAMES, serviceDefinition, type ServiceName } from "../../lib/services/catalog";
import { BOT_SERVICE, systemdUnitFile } from "../../lib/service-names";
import { systemdBooted, systemdUnitPath, systemdUnitState } from "../../../setup/configure-systemd";
import { selectServices, setUpService, type LaunchdDeps, type LaunchdOutcome } from "./launchd";
import { LINUX_SERVICES_HINT, setUpTimer, type LinuxDeps } from "./linux";
import { configurePM2Service, pm2Installed, savePm2, type Pm2Deps, type Pm2Service } from "./pm2";

export interface ServicesCommandOptions {
  root: string;
  platform: NodeJS.Platform;
  deps: LaunchdDeps;
  /** Zugriffe unter Linux: Timer bzw. cron und PM2 */
  linux: { timers: LinuxDeps; pm2: Pm2Deps };
  out(line: string): void;
  err(line: string): void;
}

export function servicesUsage(): string {
  return [
    `${BRAND.cli} dienste                 alle Dienste einrichten (wie ${BRAND.cli} dienste all)`,
    `${BRAND.cli} dienste <Dienst>        nur diesen Dienst; auch --service <Dienst>`,
    "",
    `Dienste: ${SERVICE_NAMES.join(", ")}, all`,
    "all lässt software-update weg und nimmt supabase nur mit, wenn SUPABASE_URL auf dieses Gerät zeigt.",
    "Unveränderte, schon geladene Dienste werden nicht neu geladen.",
    "macOS: launchd. Linux: Bot und Supabase unter PM2, Check-in und Briefing als systemd-Timer (ohne systemd: cron).",
  ].join("\n");
}

/**
 * Gewünschter Dienst aus den Argumenten; null bei einem unbekannten Aufruf.
 * Ein führendes „--“ (aus `bun run setup:launchd -- --service all`, je nach
 * Bun-Version durchgereicht) zählt nicht mit.
 */
export function parseServicesArgs(args: string[]): string | null {
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 0) return "all";
  if (args.length === 1 && !args[0].startsWith("-")) return args[0];
  if (args.length === 2 && args[0] === "--service" && args[1] !== "") return args[1];
  return null;
}

const countWord = (n: number) => `${n} ${n === 1 ? "Dienst" : "Dienste"}`;

export async function runServicesCommand(args: string[], options: ServicesCommandOptions): Promise<number> {
  const { out, err } = options;
  if (args[0] === "--") args = args.slice(1);
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    out(servicesUsage());
    return 0;
  }
  const request = parseServicesArgs(args);
  if (request === null) {
    err(`Unbekannter Aufruf: ${BRAND.cli} dienste ${args.join(" ")}`);
    err(servicesUsage());
    return 2;
  }
  if (options.platform !== "darwin" && options.platform !== "linux") {
    err(`${BRAND.cli} dienste gibt es unter macOS (launchd) und Linux (PM2, systemd-Timer). Unter Windows richtet ${BRAND.name} keine Dienste ein.`);
    return 1;
  }
  const chosen = await selectServices(request, join(options.root, ".env"));
  if (chosen === null) {
    err(`Unbekannter Dienst: ${request}`);
    err(`Möglich: ${[...SERVICE_NAMES, "all"].join(", ")}`);
    return 2;
  }
  if (options.platform === "linux") return runLinux(request, chosen, options);

  out(`Richte ${countWord(chosen.length)} ein: ${chosen.join(", ")}`);
  out(`Projektordner: ${options.root}`);
  const results: LaunchdOutcome[] = [];
  for (const service of chosen) results.push(await setUpService(service, options.deps));

  // Bei „all“ sind abgelehnte external-Dienste (eigene Dienste wie der
  // Cloudflare-Tunnel) kein Fehler, einzeln verlangt schon
  const skipped = request === "all" ? results.filter(r => !r.ok && r.failure === "external") : [];
  const good = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok && !skipped.includes(r));
  const unchanged = good.filter(r => r.ok && r.action === "unchanged").length;
  out("");
  out(`Eingerichtet: ${countWord(good.length)}, davon unverändert: ${unchanged}`);
  if (skipped.length > 0) out(`Übersprungen (nicht von ${BRAND.name} eingerichtet): ${skipped.map(r => r.service).join(", ")}`);
  if (bad.length > 0) err(`Nicht eingerichtet: ${bad.map(r => r.service).join(", ")}`);
  out(`Zustand: launchctl list | grep ai.tybo, Übersicht: /routinen bzw. ${BRAND.cli} routinen`);
  return bad.length > 0 ? 1 : 0;
}

/** Ein Dienst unter Linux: Zeitplan, PM2, oder es gibt ihn dort nicht */
type LinuxResult = "ok" | "failed" | "skipped";

/**
 * Bot unter systemd: present, wenn die Unit-Datei da ist oder der Dienst
 * geladen bzw. aktiv ist (auch ohne Datei, etwa gelöscht ohne Stoppen);
 * unknown, wenn der Benutzer-Manager nicht antwortet. Ohne systemd zählt
 * nur die Datei.
 */
async function systemdBotState(timers: LinuxDeps): Promise<"none" | "present" | "unknown"> {
  if (!systemdBooted(timers)) return timers.exists(systemdUnitPath(timers.unitDir)) ? "present" : "none";
  const unit = await systemdUnitState(timers);
  if (unit.fileExists || (unit.reachable && (unit.loaded || unit.active))) return "present";
  return unit.reachable ? "none" : "unknown";
}

/** `tybo dienste` unter Linux (Issue #370) */
async function runLinux(request: string, selected: ServiceName[], options: ServicesCommandOptions): Promise<number> {
  const { out, err } = options;
  const { timers, pm2 } = options.linux;
  const all = request === "all";
  const chosen = all ? selected.filter(service => serviceDefinition(service).linux) : selected;
  out(`Richte ${countWord(chosen.length)} ein: ${chosen.join(", ")}`);
  out(`Projektordner: ${options.root}`);

  // Vor der PM2-Prüfung: ein Bot unter systemd braucht kein PM2
  const botSystemd = chosen.includes(BOT_SERVICE) ? await systemdBotState(timers) : "none";
  const viaPm2 = (service: ServiceName) => serviceDefinition(service).linux === "pm2" && !(service === BOT_SERVICE && botSystemd !== "none");
  const needsPm2 = chosen.some(viaPm2);
  const pm2Ready = needsPm2 && (await pm2Installed(pm2));
  if (needsPm2 && !pm2Ready) err("PM2 fehlt oder antwortet nicht. Installieren mit: npm install -g pm2");

  const results = new Map<ServiceName, LinuxResult>();
  let pm2Changed = false;
  for (const service of chosen) {
    const def = serviceDefinition(service);
    if (!def.linux) {
      err(def.kind === "external" ? `${service} richtet ${BRAND.name} nicht ein.` : `${service} gibt es nur unter macOS.`);
      results.set(service, "failed");
    } else if (def.linux === "timer") {
      results.set(service, (await setUpTimer(service, timers)).ok ? "ok" : "failed");
    } else if (service === BOT_SERVICE && botSystemd === "unknown") {
      err(`Ob der Bot schon als systemd-Benutzerdienst läuft, ist unklar: systemctl --user antwortet nicht. PM2 startet keinen zweiten. Als normaler Benutzer in einer Anmeldesitzung erneut ausführen.`);
      results.set(service, "failed");
    } else if (service === BOT_SERVICE && botSystemd === "present") {
      // Nie zwei Bots mit demselben Token
      const text = `Der Bot ist schon als systemd-Benutzerdienst eingerichtet (${systemdUnitFile(BOT_SERVICE)}); PM2 startet keinen zweiten.`;
      if (all) out(`\n  ${service}: ${text}`);
      else err(text);
      results.set(service, all ? "skipped" : "failed");
    } else if (!pm2Ready) {
      results.set(service, "failed");
    } else {
      const outcome = await configurePM2Service(service as Pm2Service, pm2);
      pm2Changed ||= outcome.ok;
      results.set(service, outcome.ok ? "ok" : "failed");
    }
  }

  const saved = !pm2Changed || (await savePm2(pm2));
  const named = (want: LinuxResult) => chosen.filter(service => results.get(service) === want);
  out("");
  out(`Eingerichtet: ${countWord(named("ok").length)}`);
  if (named("skipped").length > 0) out(`Übersprungen: ${named("skipped").join(", ")}`);
  if (named("failed").length > 0) err(`Nicht eingerichtet: ${named("failed").join(", ")}`);
  if (pm2Changed && saved) out("PM2-Liste gesichert. Damit PM2 beim Hochfahren startet, einmal „pm2 startup“ ausführen und die ausgegebene Zeile übernehmen.");
  out(LINUX_SERVICES_HINT);
  return named("failed").length > 0 || !saved ? 1 : 0;
}
