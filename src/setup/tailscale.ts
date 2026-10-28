/**
 * Tailscale für den Schritt „zugang“ (Issue #231): prüfen, `tailscale serve`
 * einrichten, Adresse lesen, über HTTPS testen. Installiert nichts, meldet
 * sich nirgends an und ändert keine Einstellung im Tailnet; fehlt etwas,
 * gibt es eine Anleitung in festen Sätzen (nie Text von tailscale selbst).
 *
 * Befehle (https://tailscale.com/docs/reference/tailscale-cli/serve):
 * - `tailscale status --json`: angemeldet (BackendState "Running"),
 *   Gerätename (Self.DNSName), MagicDNS (CurrentTailnet.MagicDNSEnabled),
 *   HTTPS-Zertifikate (CertDomains)
 * - `tailscale serve status --json`: vorhandene Serve-Einstellung; Port 443
 *   darf nur frei sein oder schon genau auf die WebUI zeigen
 * - `tailscale serve --bg --https=443 http://127.0.0.1:<WEB_PORT>`
 *
 * Alle Befehle laufen über ctx.run (Tests: Attrappen), mit Zeitlimit.
 */

import { BRAND } from "../brand";
import { MANIFEST_PATH } from "../web/manifest";
import { isTailscaleOrigin, parsePublicOrigin } from "../web/config";
import type { CommandResult, SetupContext } from "./context";

/** CLI der App aus dem Mac App Store bzw. von tailscale.com, wenn `tailscale` nicht im PATH liegt */
export const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
export const TAILSCALE_ADMIN_DNS = "https://login.tailscale.com/admin/dns";
export const TAILSCALE_SERVE_DOCS = "https://tailscale.com/docs/features/tailscale-serve";

export const STATUS_TIMEOUT_MS = 10_000;
/** Beim ersten Mal holt Tailscale das Zertifikat; das kann dauern */
export const SERVE_TIMEOUT_MS = 30_000;

const AGAIN = `„${BRAND.cli} setup zugang“ erneut`;

/** Anleitungen in festen Sätzen */
export const TAILSCALE_TEXT = {
  install: `Tailscale ist auf diesem Rechner nicht installiert. Installieren: macOS aus dem Mac App Store oder von tailscale.com/download, Linux mit „curl -fsSL https://tailscale.com/install.sh | sh“. Dann anmelden und die Tailscale-App auch auf dem Handy installieren und mit demselben Konto anmelden. Danach ${AGAIN}.`,
  notStarting: `Der Befehl tailscale ließ sich nicht starten. Tailscale neu installieren (tailscale.com/download), dann ${AGAIN}.`,
  daemon: `Tailscale ist installiert, läuft aber nicht. macOS: die Tailscale-App öffnen. Linux: „sudo systemctl enable --now tailscaled“. Danach ${AGAIN}.`,
  login: `Tailscale ist nicht angemeldet. macOS: in der Tailscale-App anmelden. Linux: „sudo tailscale up“ und dem Link folgen. Die Tailscale-App auf dem Handy mit demselben Konto anmelden. Danach ${AGAIN}.`,
  timeout: `Tailscale antwortet nicht (Zeitüberschreitung). Tailscale neu starten, dann ${AGAIN}.`,
  invalid: `Tailscale hat unerwartete Statusdaten geliefert. Tailscale aktualisieren (tailscale.com/download), dann ${AGAIN}.`,
  magicDns: `MagicDNS ist im Tailnet aus. In der Admin-Konsole unter DNS (${TAILSCALE_ADMIN_DNS}) „Enable MagicDNS“ einschalten, dann ${AGAIN}.`,
  https: `HTTPS-Zertifikate sind im Tailnet aus. In der Admin-Konsole unter DNS (${TAILSCALE_ADMIN_DNS}) bei „HTTPS Certificates“ auf „Enable HTTPS“ klicken, dann ${AGAIN}.`,
  noName: `Tailscale nennt für diesen Rechner keinen Namen im Tailnet (…ts.net). MagicDNS und HTTPS-Zertifikate in der Admin-Konsole (${TAILSCALE_ADMIN_DNS}) prüfen, dann ${AGAIN}.`,
  permission: `Tailscale erlaubt diesem Benutzer keine Änderung an Serve. Linux: einmal „sudo tailscale set --operator=$USER“ ausführen, dann ${AGAIN}. Nichts wurde geändert.`,
  consent: `Tailscale verlangt eine Freigabe für Serve oder HTTPS im Tailnet. In der Admin-Konsole unter DNS (${TAILSCALE_ADMIN_DNS}) HTTPS-Zertifikate einschalten oder „tailscale serve“ einmal im Terminal ausführen und dem Link folgen, dann ${AGAIN}.`,
  serveFailed: "Tailscale hat die Weiterleitung nicht eingerichtet. „tailscale serve status“ im Terminal zeigt den Stand. Nichts wurde in der .env geändert.",
  busy: `Port 443 dieses Rechners ist in Tailscale schon für etwas anderes eingerichtet. Der Assistent überschreibt das nicht. Ansehen mit „tailscale serve status“; frei machen mit „tailscale serve --https=443 off“, dann ${AGAIN}. Nichts wurde geändert.`,
  funnel: `Für diese Adresse ist Tailscale Funnel an: die WebUI wäre damit aus dem ganzen Internet erreichbar. Der Assistent richtet das nicht ein. Abschalten mit „tailscale funnel --https=443 off“, dann ${AGAIN}. Nichts wurde geändert.`,
} as const;

export type TailscaleProblem = keyof typeof TAILSCALE_TEXT;

export type TailscaleStatus =
  | { ok: true; bin: string; origin: string; host: string }
  | { ok: false; problem: TailscaleProblem };

/** Ergebnis eines Befehls einordnen: nicht vorhanden, keine Rechte, Zeit, sonst Fehler */
function commandProblem(r: CommandResult): TailscaleProblem | null {
  if (r.spawnError === "ENOENT") return "install";
  if (r.spawnError) return "notStarting";
  if (r.timedOut) return "timeout";
  if (r.code === 0) return null;
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
  if (/access denied|permission denied|operation not permitted|must be root|--operator/.test(text)) return "permission";
  if (/failed to connect|tailscaled|is tailscale running|connection refused|no such file/.test(text)) return "daemon";
  if (/logged out|needslogin|not logged in|log in/.test(text)) return "login";
  return "serveFailed";
}

/** tailscale im PATH, sonst die CLI der Mac-App; null: nicht installiert */
export async function findTailscale(ctx: SetupContext, signal?: AbortSignal): Promise<{ bin: string } | { problem: TailscaleProblem }> {
  const candidates = ctx.platform === "darwin" ? ["tailscale", MAC_APP_CLI] : ["tailscale"];
  let last: TailscaleProblem = "install";
  for (const bin of candidates) {
    const r = await ctx.run([bin, "version"], { timeoutMs: STATUS_TIMEOUT_MS, signal });
    const problem = commandProblem(r);
    // version geht auch ohne laufenden Dienst; jeder andere Fehler heißt: vorhanden
    if (problem === null || (problem !== "install" && problem !== "notStarting")) return { bin };
    last = problem;
  }
  return { problem: last };
}

interface StatusJson {
  BackendState?: unknown;
  Self?: { DNSName?: unknown };
  CurrentTailnet?: { MagicDNSEnabled?: unknown } | null;
  CertDomains?: unknown;
}

/**
 * Adresse aus `tailscale status --json`: https:// plus Self.DNSName ohne den
 * abschließenden Punkt, klein geschrieben; nur eine gültige ts.net-Adresse.
 */
export function originFromStatus(json: unknown): string | null {
  const name = (json as StatusJson | null)?.Self?.DNSName;
  if (typeof name !== "string") return null;
  const host = name.trim().replace(/\.$/, "").toLowerCase();
  if (!host) return null;
  const origin = parsePublicOrigin(`https://${host}`);
  return origin && isTailscaleOrigin(origin) ? origin : null;
}

/** Prüft Installation, Anmeldung, MagicDNS und HTTPS-Zertifikate; ändert nichts */
export async function readTailscaleStatus(ctx: SetupContext, signal?: AbortSignal): Promise<TailscaleStatus> {
  const found = await findTailscale(ctx, signal);
  if ("problem" in found) return { ok: false, problem: found.problem };
  const r = await ctx.run([found.bin, "status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS, signal });
  // Abgemeldet liefert status --json je nach Version Code 0 oder 1, aber mit JSON
  let json: StatusJson | null = null;
  try {
    json = JSON.parse(r.stdout) as StatusJson;
  } catch {
    json = null;
  }
  if (!json || typeof json !== "object") {
    const problem = commandProblem(r);
    return { ok: false, problem: problem && problem !== "serveFailed" ? problem : "invalid" };
  }
  if (typeof json.BackendState !== "string") return { ok: false, problem: "invalid" };
  if (json.BackendState !== "Running") return { ok: false, problem: json.BackendState === "Stopped" || json.BackendState === "NoState" ? "daemon" : "login" };
  if (json.CurrentTailnet && json.CurrentTailnet.MagicDNSEnabled === false) return { ok: false, problem: "magicDns" };
  const origin = originFromStatus(json);
  if (!origin) return { ok: false, problem: "noName" };
  const host = new URL(origin).host;
  const certs = Array.isArray(json.CertDomains) ? json.CertDomains.filter((d): d is string => typeof d === "string") : [];
  if (!certs.some(d => d.toLowerCase().replace(/\.$/, "") === host)) return { ok: false, problem: "https" };
  return { ok: true, bin: found.bin, origin, host };
}

/** Ziel der Weiterleitung, wie der Assistent es einrichtet */
export function serveTarget(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Stand von Port 443 in der Serve-Einstellung */
export type ServeState = "frei" | "webui" | "belegt" | "funnel";

/** Zeigt ein Proxy-Ziel auf genau diesen Port des Rechners? */
function pointsToPort(proxy: unknown, port: number): boolean {
  if (typeof proxy !== "string") return false;
  const p = proxy.trim().replace(/\/$/, "");
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, String(port)].includes(p);
}

interface ServeConfigJson {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
  AllowFunnel?: Record<string, unknown>;
  Foreground?: Record<string, ServeConfigJson> | null;
}

function isObject(value: unknown): value is ServeConfigJson {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Wertet `tailscale serve status --json` für Port 443 dieser Adresse aus.
 * Frei: nichts auf 443. webui: genau eine Weiterleitung „/“ auf die WebUI.
 * funnel: öffentlich freigegeben (nie einrichten). Alles andere: belegt.
 * null: keine gültigen Daten.
 *
 * Foreground enthält die Einstellungen laufender `tailscale serve` bzw.
 * `tailscale funnel` ohne --bg (je Sitzung eine eigene Einstellung, siehe
 * ipn.ServeConfig). Belegen sie Port 443 oder geben Funnel frei, gilt das
 * wie in der Hintergrund-Einstellung, nur nie als WebUI: sie enden mit dem
 * Terminal, und ein serve --bg daneben würde mit ihnen kollidieren.
 */
export function serveStateFromJson(json: unknown, host: string, port: number): ServeState | null {
  if (!isObject(json)) return null;
  const cfg = json as ServeConfigJson;
  const key = `${host}:443`;
  if (cfg.Foreground !== undefined && cfg.Foreground !== null && !isObject(cfg.Foreground)) return null;
  const foreground = Object.values(cfg.Foreground ?? {});
  if (!foreground.every(isObject)) return null;
  if ([cfg, ...foreground].some(c => c.AllowFunnel && c.AllowFunnel[key])) return "funnel";
  if (foreground.some(c => c.TCP?.["443"] || Object.keys(c.Web ?? {}).some(k => k.endsWith(":443")))) return "belegt";
  const tcp = cfg.TCP?.["443"];
  const web = cfg.Web?.[key];
  const otherWeb = Object.keys(cfg.Web ?? {}).some(k => k.endsWith(":443") && k !== key);
  if (!tcp && !web && !otherWeb) return "frei";
  const handlers = web?.Handlers ?? {};
  const paths = Object.keys(handlers);
  if (!otherWeb && paths.length === 1 && paths[0] === "/" && pointsToPort(handlers["/"]?.Proxy, port)) return "webui";
  return "belegt";
}

/** Liest den Stand von Port 443; problem bei Fehlern des Befehls oder ungültigen Daten */
export async function readServeState(
  ctx: SetupContext,
  bin: string,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<{ state: ServeState } | { problem: TailscaleProblem }> {
  const r = await ctx.run([bin, "serve", "status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS, signal });
  const problem = commandProblem(r);
  if (problem) return { problem: problem === "serveFailed" ? "invalid" : problem };
  let json: unknown;
  try {
    // Ohne Einstellung antworten manche Versionen mit leerer Ausgabe statt {}
    json = r.stdout.trim() ? JSON.parse(r.stdout) : {};
  } catch {
    return { problem: "invalid" };
  }
  const state = serveStateFromJson(json, host, port);
  return state ? { state } : { problem: "invalid" };
}

/** Richtet die Weiterleitung im Hintergrund ein (bleibt nach Neustarts) */
export async function enableServe(ctx: SetupContext, bin: string, port: number, signal?: AbortSignal): Promise<TailscaleProblem | null> {
  const r = await ctx.run([bin, "serve", "--bg", "--https=443", serveTarget(port)], { timeoutMs: SERVE_TIMEOUT_MS, signal });
  if (r.code === 0) return null;
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
  // Ohne HTTPS-Freigabe wartet tailscale auf einen Klick im Browser (Zeitüberschreitung) oder nennt den Link
  if (r.timedOut || /login\.tailscale\.com|to enable|enable https|consent/.test(text)) return "consent";
  return commandProblem(r) ?? "serveFailed";
}

/** Befehl für den späteren Test von Hand (steht in Meldung und Doku) */
export function manualCheckCommand(origin: string): string {
  return `curl -s ${origin}${MANIFEST_PATH}`;
}

export type HttpsProbe =
  | { state: "ok" }
  /** Noch nicht nachweisbar: tybo läuft nicht oder kennt die Adresse noch nicht (Neustart) */
  | { state: "ausstehend"; reason: string }
  | { state: "fehler"; reason: string };

/**
 * Test über HTTPS: das Manifest der WebUI (ohne Anmeldung, ohne Inhalt über
 * den Nutzer) muss als tybo antworten. Bloße Erreichbarkeit reicht nicht.
 */
export async function probeHttps(ctx: SetupContext, origin: string, signal?: AbortSignal): Promise<HttpsProbe> {
  let res: Response;
  try {
    res = await ctx.fetch(`${origin}${MANIFEST_PATH}`, { timeoutMs: STATUS_TIMEOUT_MS, signal, redirect: "manual" });
  } catch {
    return {
      state: "ausstehend",
      reason: "Die HTTPS-Adresse antwortet noch nicht. Beim ersten Mal holt Tailscale ein Zertifikat, das kann eine Minute dauern.",
    };
  }
  if (res.status === 421) {
    return { state: "ausstehend", reason: `Tailscale leitet weiter, ${BRAND.name} kennt die Adresse aber erst nach einem Neustart.` };
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return { state: "ausstehend", reason: `Tailscale leitet weiter, aber die WebUI läuft gerade nicht (${BRAND.name} ist nicht gestartet).` };
  }
  if (res.status !== 200) return { state: "fehler", reason: `Die Adresse antwortet mit Status ${res.status} statt mit der WebUI.` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { state: "fehler", reason: "Die Adresse antwortet, aber nicht mit der WebUI." };
  }
  const manifest = body as { name?: unknown; display?: unknown } | null;
  if (manifest?.name !== BRAND.name || manifest?.display !== "standalone") return { state: "fehler", reason: "Die Adresse antwortet, aber nicht mit der WebUI." };
  return { state: "ok" };
}
